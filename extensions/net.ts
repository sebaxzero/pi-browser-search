// Network-safety primitives shared by browser.ts and the test suite.
// Same ranges/ports as pi-safe-search, but exported so tests import them
// directly (Node ≥ 22.18 type stripping) instead of duplicating.
import { lookup } from "node:dns/promises";

export const BLOCKED_PORTS = new Set([
  21, 22, 23, 25, 53, 110, 143, 389, 445,
  3306, 5432, 5900, 6379, 8080, 8443, 9200, 27017,
]);

const MAX_URL_LENGTH = 2048;

// RFC-1918 + loopback + link-local + reserved ranges as [lo, hi] inclusive (uint32)
const PRIVATE_RANGES: [number, number][] = [
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8   loopback
  [0x0a000000, 0x0affffff], // 10.0.0.0/8    private
  [0xac100000, 0xac1fffff], // 172.16.0.0/12 private
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16 private
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 link-local
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24  IANA special-purpose
  [0xe0000000, 0xefffffff], // 224.0.0.0/4   multicast
  [0xf0000000, 0xffffffff], // 240.0.0.0/4   reserved
];

function ipv4ToUint32(ip: string): number {
  return ip.split(".").reduce((acc, o) => ((acc << 8) | parseInt(o, 10)) >>> 0, 0);
}

export function isBlockedIp(ip: string): boolean {
  // IPv6: block loopback and ULA
  if (ip.includes(":")) {
    return ip === "::1" || ip.toLowerCase().startsWith("fd") || ip.toLowerCase().startsWith("fe80");
  }
  const n = ipv4ToUint32(ip);
  return PRIVATE_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

export function portOf(u: URL): number {
  return u.port ? parseInt(u.port, 10) : (u.protocol === "https:" ? 443 : 80);
}

// DNS results cached briefly so the per-request route handler stays cheap.
const dnsCache = new Map<string, { ok: boolean; at: number }>();
const DNS_TTL_MS = 60_000;

export async function hostAllowed(hostname: string): Promise<boolean> {
  const hit = dnsCache.get(hostname);
  if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const { address } = await lookup(hostname);
    ok = !isBlockedIp(address);
  } catch {
    ok = false; // unresolvable — refuse
  }
  dnsCache.set(hostname, { ok, at: Date.now() });
  return ok;
}

// Pre-navigation gate: throws a descriptive error the model can act on.
// (In-flight requests — redirects, subresources — are silently aborted by the
// route handler in browser.ts using the same checks.)
export async function validateUrl(raw: string): Promise<URL> {
  if (raw.length > MAX_URL_LENGTH) throw new Error("URL exceeds maximum length");
  if (/[\x00-\x1f\x7f]/.test(raw)) throw new Error("URL contains control characters");

  const u = new URL(raw); // throws on malformed URL

  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`Blocked scheme: ${u.protocol}`);
  }
  if (BLOCKED_PORTS.has(portOf(u))) throw new Error(`Blocked port: ${portOf(u)}`);
  if (!(await hostAllowed(u.hostname))) {
    throw new Error("Blocked: resolves to private/internal address");
  }
  return u;
}

// DDG wraps result URLs in a redirect: /l/?uddg=<encoded-url>
export function extractUrl(href: string): string | null {
  try {
    const u = new URL(href, "https://html.duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return href.startsWith("http") ? href : null;
  } catch {
    return null;
  }
}
