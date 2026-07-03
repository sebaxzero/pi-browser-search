// Playwright session management. One browser, one context, one "current page"
// the model drives via browser_open / browser_act / browser_read.
// Playwright (the npm package) is installed by pi itself — pi runs
// `npm install --omit=dev` after cloning a git package. The Chromium binary
// is downloaded lazily on first launch (see installChromium below).
import { sanitize } from "./sanitize.ts";
import { BLOCKED_PORTS, hostAllowed, portOf, validateUrl } from "./net.ts";

export type Cfg = {
  MAX_RESULTS: number;
  MAX_CHARS: number;
  MAX_LINKS: number;
  NAV_TIMEOUT_MS: number;
  HEADLESS: boolean;
  BLOCK_MEDIA: boolean;
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const HEAVY_RESOURCES = new Set(["image", "media", "font"]);

let pw: any = null;
let browser: any = null;
let context: any = null;
let page: any = null;

// Snapshot of the current page, refreshed after every open/act.
let lastUrl = "";
let lastTitle = "";
let lastText = "";
let lastLinks: { text: string; href: string }[] = [];

// One-time Chromium download (~150 MB) via playwright's own CLI, triggered
// when launch reports a missing executable. Keeps the extension zero-setup.
async function installChromium(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`'playwright install chromium' exited with code ${code}`)),
    );
  });
}

async function ensureContext(cfg: Cfg) {
  if (context && browser?.isConnected()) return context;
  if (!pw) {
    try {
      pw = await import("playwright");
    } catch {
      throw new Error(
        "Playwright is not installed. In the pi-browser-search install directory run: npm install",
      );
    }
  }
  try {
    browser = await pw.chromium.launch({ headless: cfg.HEADLESS });
  } catch (err: any) {
    if (!/Executable doesn't exist/i.test(String(err?.message ?? err))) {
      throw new Error(`Could not launch Chromium: ${err?.message ?? err}`);
    }
    try {
      await installChromium(); // first use: download the browser, then retry
      browser = await pw.chromium.launch({ headless: cfg.HEADLESS });
    } catch (err2: any) {
      throw new Error(
        "Chromium download failed — run manually in the pi-browser-search install directory: " +
          `npx playwright install chromium (${err2?.message ?? err2})`,
      );
    }
  }
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    userAgent: USER_AGENT,
  });
  context.setDefaultTimeout(cfg.NAV_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(cfg.NAV_TIMEOUT_MS);

  // Network-level SSRF gate: every request (navigation, redirect hop, iframe,
  // XHR, subresource) is checked before it leaves the browser. A malicious
  // page cannot probe the internal network via <img src="http://10.0.0.1/...">.
  await context.route("**/*", async (route: any) => {
    const req = route.request();
    if (cfg.BLOCK_MEDIA && HEAVY_RESOURCES.has(req.resourceType())) return route.abort();
    let u: URL;
    try {
      u = new URL(req.url());
    } catch {
      return route.abort();
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return route.abort();
    if (BLOCKED_PORTS.has(portOf(u))) return route.abort();
    if (!(await hostAllowed(u.hostname))) return route.abort();
    return route.continue();
  });

  // Auto-dismiss alert/confirm/prompt so pages never block the session.
  context.on("page", (p: any) => {
    p.on("dialog", (d: any) => d.dismiss().catch(() => {}));
  });
  return context;
}

async function ensurePage(cfg: Cfg) {
  await ensureContext(cfg);
  if (!page || page.isClosed()) page = await context.newPage();
  return page;
}

export async function closeBrowser() {
  try {
    await browser?.close();
  } catch {
    /* already gone */
  }
  browser = context = page = null;
  lastUrl = lastTitle = lastText = "";
  lastLinks = [];
}

export function currentUrl(): string {
  return lastUrl;
}

async function snapshot(cfg: Cfg) {
  // A click may have opened a new tab — follow the newest open page.
  const open = context.pages().filter((p: any) => !p.isClosed());
  if (open.length) page = open[open.length - 1];

  const raw = await page.evaluate(() => {
    const links: { text: string; href: string }[] = [];
    const seen = new Set<string>();
    for (const a of Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
      const text = (a.innerText || "").trim().replace(/\s+/g, " ").slice(0, 100);
      if (!text || !/^https?:/.test(a.href) || seen.has(a.href)) continue;
      seen.add(a.href);
      links.push({ text, href: a.href });
      if (links.length >= 200) break;
    }
    return {
      title: document.title,
      text: document.body ? document.body.innerText : "",
      links,
    };
  });

  lastUrl = page.url();
  lastTitle = sanitize(raw.title).slice(0, 200);
  lastText = sanitize(raw.text);
  lastLinks = raw.links
    .slice(0, cfg.MAX_LINKS)
    .map((l: any) => ({ text: sanitize(l.text), href: l.href }));
}

export function formatCurrent(cfg: Cfg, offset = 0): string {
  if (!lastUrl) return "No page is open — use browser_open first.";
  const total = lastText.length;
  const start = Math.min(offset, total);
  const end = Math.min(start + cfg.MAX_CHARS, total);
  const more = end < total ? ` — call browser_read with offset=${end} for the rest` : "";
  const links =
    start === 0 && lastLinks.length
      ? "\n\n## Links on page\n" + lastLinks.map((l) => `- ${l.text} — ${l.href}`).join("\n")
      : "";
  return [
    `# ${lastTitle || "(untitled)"}`,
    `URL: ${lastUrl}`,
    `[chars ${start}–${end} of ${total}${more}]`,
    "",
    lastText.slice(start, end),
  ].join("\n") + links;
}

export async function openUrl(cfg: Cfg, rawUrl: string): Promise<string> {
  const u = await validateUrl(rawUrl);
  const p = await ensurePage(cfg);
  try {
    await p.goto(u.toString(), { waitUntil: "domcontentloaded" });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/Download is starting/i.test(msg)) {
      throw new Error("URL triggered a file download — binary content is not supported.");
    }
    if (/ERR_FAILED|ERR_ABORTED|ERR_BLOCKED/i.test(msg)) {
      throw new Error(
        "Navigation blocked (redirect to a private/internal address or blocked port) or aborted by the site.",
      );
    }
    if (err?.name === "TimeoutError") {
      // Slow page — fall through and return whatever rendered so far.
    } else {
      throw new Error(`Navigation failed: ${msg.split("\n")[0]}`);
    }
  }
  // Give SPAs a moment to render, but never hang on chatty pages.
  await p.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await snapshot(cfg);
  return formatCurrent(cfg, 0);
}

export async function act(
  cfg: Cfg,
  a: { action: string; target?: string; text?: string; key?: string },
): Promise<string> {
  if (!page || page.isClosed()) throw new Error("No page is open — call browser_open first.");
  const loc = a.target ? page.locator(a.target).first() : null;

  switch (a.action) {
    case "click":
      if (!loc) throw new Error("click requires target (CSS selector or text=Visible text)");
      await loc.click({ timeout: 10_000 });
      break;
    case "type":
      if (!loc || a.text == null) throw new Error("type requires target and text");
      await loc.fill(a.text, { timeout: 10_000 });
      break;
    case "press":
      await (loc ? loc.press(a.key ?? "Enter") : page.keyboard.press(a.key ?? "Enter"));
      break;
    case "scroll":
      await page.mouse.wheel(0, 1_500);
      await page.waitForTimeout(500);
      break;
    case "wait_for":
      if (loc) await loc.waitFor({ timeout: 10_000 });
      else await page.waitForTimeout(1_000);
      break;
    default:
      throw new Error(`Unknown action: ${a.action} (use click | type | press | scroll | wait_for)`);
  }

  await page.waitForLoadState("domcontentloaded", { timeout: cfg.NAV_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(300); // let click-triggered JS settle
  await snapshot(cfg);
  return formatCurrent(cfg, 0);
}
