# pi-browser-search

[![test](https://github.com/sebaxzero/pi-browser-search/actions/workflows/test.yml/badge.svg)](https://github.com/sebaxzero/pi-browser-search/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/pi-browser-search)](https://www.npmjs.com/package/pi-browser-search)

A [pi](https://pi.dev) extension that adds `browser_search`, `browser_open`, `browser_act`, and `browser_read` tools backed by a real Playwright Chromium browser.

Static fetching can't handle JavaScript-rendered pages, SPAs, cookie walls, or lazy-loaded content. This extension drives an actual browser instead, while enforcing the same defense-in-depth as [pi-safe-search](https://github.com/sebaxzero/pi-safe-search): prompt-injection sanitization on every result, and SSRF protection enforced at the network layer on every request the browser makes — not just the ones the model asked for.

## Install

From npm:

```bash
pi install npm:pi-browser-search
```

Or from git:

```bash
pi install git:github.com/sebaxzero/pi-browser-search.git
```

Add `-l` to either form to install project-locally (adds to `.pi/settings.json` only).

No manual setup: the `playwright` npm dependency installs automatically with the package, and the Chromium binary (~150 MB) downloads once on the first browser launch. To pre-download it instead, run `npx playwright install chromium` in the install directory.

## How it works

### Sanitization pipeline (runs on every result)

Shared with pi-safe-search. Every piece of page content passes through this pipeline before reaching the LLM:

1. **Unicode normalization** — NFKC normalization plus a homoglyph map folds lookalike characters to ASCII
2. **Zero-width character removal** — strips invisible characters used to hide instructions
3. **Control character stripping** — removes everything below space except `\t`, `\n`, `\r`
4. **HTML entity decode → re-strip** — decodes `&lt;script&gt;` then strips the resulting tags
5. **URL decode** — catches percent-encoded payloads
6. **Base64 blob redaction** — replaces suspicious base64 blobs with `[BASE64_ENCODED_DATA]`
7. **Injection pattern redaction** — override directives, role hijacking, system prompt extraction, mode switching, and more
8. **Random-delimiter wrapping** — content is fenced with a random token so the LLM treats everything inside as data, never instructions

A second sanitization pass runs on every tool result via the `tool_result` hook, catching anything that slips through.

### SSRF protection at the network layer

Unlike a plain fetch-based tool, a rendered page can issue requests the model never asked for — redirects, iframes, XHR calls, subresources. A `context.route("**/*")` interceptor checks **every one** of them against:

- Non-http(s) schemes (`file://`, `ftp://`, etc.)
- Dangerous ports: 21, 22, 25, 53, 3306, 5432, 6379, and more
- RFC-1918, loopback, link-local, and reserved IP ranges (DNS-resolved, 60s cache)

`browser_open` additionally validates the URL up front with descriptive errors before navigation starts.

### Browsing model

The extension keeps one lazy-launched browser/context and one "current page." `browser_open` navigates and extracts text and links; `browser_act` clicks, types, presses keys, scrolls, or waits on that page; `browser_read` pages through the last extracted content by character offset without refetching. A click that opens a new tab switches to it, and dialogs are auto-dismissed.

`browser_search` deliberately uses DuckDuckGo's static HTML endpoint over plain fetch — DDG bot-walls headless Chromium — so the browser is spent only on what needs it: rendering and interacting with pages.

## Tools

**`browser_search`** — Searches DuckDuckGo and returns titles, URLs, and snippets.

Parameters:
- `query` (required) — search query
- `max_results` (optional) — number of results, default 5, max 10

**`browser_open`** — Navigates to a URL and returns rendered text plus a link list.

Parameters:
- `url` (required) — must be http or https

**`browser_act`** — Interacts with the currently open page: click, type, press, scroll, or wait_for.

**`browser_read`** — Pages through the last snapshot's extracted text by character offset, no refetch.

## Configuration

Persistent configuration lives in `extensions/browser-search.json` (auto-created on first load with defaults). You can ask the agent to edit it directly:

```json
{
  "MAX_RESULTS": 5,
  "MAX_CHARS": 8000,
  "MAX_LINKS": 25,
  "NAV_TIMEOUT_MS": 30000,
  "HEADLESS": true,
  "BLOCK_MEDIA": true
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `MAX_RESULTS` | `5` | Default number of search results returned by `browser_search` (1–10) |
| `MAX_CHARS` | `8000` | Page text returned per `browser_read` chunk |
| `MAX_LINKS` | `25` | Links listed per page |
| `NAV_TIMEOUT_MS` | `30000` | Navigation timeout in milliseconds |
| `HEADLESS` | `true` | Set `false` to watch the browser window |
| `BLOCK_MEDIA` | `true` | Skip loading images/media/fonts |

Changing `HEADLESS` or `BLOCK_MEDIA` or `NAV_TIMEOUT_MS` closes the current browser so the next call relaunches with the new options.

Changes to the JSON take effect on the next session. For live tuning within a session, use the command below.

## Command

```
/browser-search                 — show current status and config
/browser-search set KEY=VAL     — override config for the current session only
/browser-search save            — write the current config to browser-search.json
/browser-search reset           — close the browser
```

## Compatibility

Shares its sanitization and SSRF model with [pi-safe-search](https://github.com/sebaxzero/pi-safe-search) — install both if you want cheap static fetch for most pages and a real browser reserved for JS-heavy ones.

## Dependencies

`playwright` (^1.53.0) — installed automatically with the package, whether via `pi install npm:` or a git-based install. The Chromium binary is downloaded separately on first browser launch (see Install above).

## Tests

```bash
node --test test.mjs
```

17 tests covering IP range checks, URL validation, DuckDuckGo redirect
unwrapping, and a sanitization smoke test. Pure logic lives in `net.ts` and
`sanitize.ts` (no Playwright import), so the suite runs without a browser.
CI runs it on every push and pull request.

## Releasing

Bump `version` in `package.json`, commit, tag `vX.Y.Z`, and push the tag —
the publish workflow runs the tests and publishes to npm.

## License

MIT

---

Built with [Claude](https://claude.ai).
