# Web reader (read-only, LinkedIn)

This is the legacy CDP reader. Production use requires an explicitly configured loopback endpoint and `XN_INTERACT_LINKEDIN_WRITTEN_PERMISSION=1` set by an operator with documented LinkedIn permission. For registered websites and dataset collection, use the [headless Chrome broker](headless-architecture.md).

The web reader reads LinkedIn pages in **your own logged-in Chrome** and returns the result as JSON. It exists because LinkedIn's official API does not offer job or fellowship search. It is **not** an OAuth provider: it has no account, no vault entry and no token. It is reachable two ways, both through the same gates (`src/reader/service.ts`):

- the CLI: `xn-interact web-read ...`
- two read-only MCP tools: `social_web_jobs_search` (LinkedIn Jobs, the careers section) and `social_web_feed_read` (the For-you feed). XN-Bridge exposes them to `xn-career` as `career.linkedin_jobs` and `career.feed_leads` (and to the social domain as `social.linkedin.read`); `career.listings` keeps its own provider.

Both MCP tools are `READ`, need no approval and take no URL, host, account, selector or script; the OAuth tools and their approval rules are untouched. Threat T27 in [threat-model.md](threat-model.md) describes the limits.

LinkedIn's terms restrict automated access. A small, human-paced read like this is low risk, but your account could still be limited. The caps below reduce that risk; they do not remove it.

## What it does and does not do

- Opens **one new tab**, loads **one URL it builds itself**, scrolls the feed at most twice, reads the page text (every frame) and closes the tab.
- Reads only `https://www.linkedin.com` Jobs search and the For-you feed. Instagram is **not supported**: its page structure was never verified, so there is no parser.
- Never clicks, types, submits, signs in, reads cookies or storage, changes headers or applies to anything. `tests/security/web-reader.test.ts` scans the reader for those APIs and fails if one appears.
- Stops at any login, checkpoint or CAPTCHA page and reports `needs_owner` (exit code 3). It never tries to pass one.
- Treats page text as data: control characters removed, strings cut, emails and phone numbers replaced by `[email]` and `[phone]`.
- The audit log stores the target, the state and the item count. It never stores page content or your search words.

## One-time setup

1. Start a dedicated Chrome with a debug port on loopback (Chrome refuses a debug port on your everyday profile, so use a separate one):
   `google-chrome --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 --user-data-dir=$HOME/.xn-interact-reader-profile`
2. In that window, sign in to LinkedIn yourself (password, OTP and CAPTCHA are yours). Keep the window open.
3. The profile directory keeps your LinkedIn session on disk. Keep it inside your home directory and do not copy it.

To use another port: `XN_INTERACT_READER_CDP=http://127.0.0.1:9222`. Only plain `http` on loopback with an explicit port is accepted; a remote browser is refused.

## Commands

```
bun run src/cli.ts web-read linkedin-jobs --keywords "fellowship" --geo 102478259 [--days 30] [--max 25]
bun run src/cli.ts web-read linkedin-feed [--max 25] [--scrolls 2]
```

- `--geo` is a LinkedIn `geoId`. `location=Indonesia` alone is ignored by LinkedIn and returns another country; Indonesia is `102478259`.
- Caps: 25 items by default, 50 at most; `--days` at most 90; 20 runs per 24 hours (a run is counted once, however it ends); 60 seconds between runs; one read at a time. The CLI and the MCP tools share these counters, so they cannot be used to get around each other.
- Jobs output: `title`, `company`, `location`, `posted`, `easy_apply`, plus the `total` LinkedIn reports. There is no job link: the page text does not expose one reliably.
- Feed output: only posts that mention an opportunity word (fellowship, internship, magang, beasiswa, hiring and similar), with `source_company`, `age`, `promoted`, `keywords` and a short `excerpt`.
- Exit codes: `0` ok or empty, `2` refused or not ready, `3` needs you (login, checkpoint or CAPTCHA).
- MCP tools: the same results under `data`, with `untrusted_content: true`. Errors use the gateway catalog: `PROVIDER_UNAVAILABLE` (Chrome not reachable or page not rendered, retryable, with the launch instruction), `MANUAL_ONLY` (login, checkpoint or CAPTCHA: only you can continue), `RATE_LIMITED` (retryable), `VALIDATION_FAILED`.
- After this change an MCP host must reconnect the `xn-interact` server to list the two new tools (24 in total).

A result is a lead, not a match: eligibility, deadline and the official source still need to be checked before anything is applied for.

## Verification status

- Rules, guards and parsers are covered by `tests/security/web-reader.test.ts` with synthetic records in the accessibility snapshot format.
- The Chrome attach and the `playwright-core` snapshot format were checked once against a local test page in headless Chrome 157. Body snapshots stop at iframes, so the legacy reader reads frames on the same origin as the main page.
- A full run against LinkedIn itself has **not** been done by this code. Its first real run is the owner's.
