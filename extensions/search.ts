// Search uses DuckDuckGo's static HTML endpoint via plain fetch — it serves
// results to a fetch-shaped client but bot-walls headless Chromium, so the
// browser is reserved for what actually needs it (opening/reading pages).
import { sanitize } from "./sanitize.ts";
import { extractUrl } from "./net.ts";

export async function duckduckgoSearch(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ q: query, kl: "us-en" });
  const res = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml",
    },
    signal,
  });

  if (!res.ok) throw new Error(`DuckDuckGo search failed: HTTP ${res.status}`);

  const html = await res.text();
  const anchors = [...html.matchAll(/<a\b(?=[^>]*\bclass="[^"]*result__a\b)[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/<a\b[^>]*\bclass="[^"]*result__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)];

  return anchors.slice(0, maxResults).flatMap((m, i) => {
    const url = extractUrl(m[1]);
    if (!url) return [];
    return [{ title: sanitize(m[2]), url, snippet: sanitize(snippets[i]?.[1] ?? "") }];
  });
}
