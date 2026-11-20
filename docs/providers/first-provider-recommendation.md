# First vertical-slice provider: recommendation for P0-15 / ADR-028

Status: **recommendation only. The owner decides.** Based on the unsigned Stage-0 drafts in this folder, read from official pages on 2026-11-19 to 2026-11-20. Nothing here was tested against a live account.

Criteria from task P0-15: self-serve app access, a redirect the broker can serve, a test account, and a write endpoint usable without a review.

| Provider | Self-serve app access | Loopback redirect | Real-write test path | Cost | Blockers found in the sources |
|---|---|---|---|---|---|
| Threads | Meta app; testers need no review | not stated (examples use HTTPS) | text post on a tester account | free | redirect rule unknown; no delete documented |
| TikTok | `video.publish` needs approval | **yes**, desktop app type, port required | unaudited clients post privately, so a real write is safe | free | video only; PKCE challenge is hex; scope approval |
| X | console plus prepaid credits | not stated | text post | $0.015 per post | costs money; delete scope unclear |
| LinkedIn | add the Share on LinkedIn product | **HTTPS only** | text post (`CONNECTIONS` visibility limits exposure) | free | needs the HTTPS callback (P8-08); no refresh; delete not documented |
| Instagram | professional account only | not stated | needs a public media URL | free | media hosting vs the no-remote-media sandbox; no text-only posts |
| Facebook | Page, roles and a Page token | not stated | Page post | free | review state for the permissions not stated |
| Reddit | **policy pages unreadable** | not stated | none | unknown | cannot confirm that API access is allowed at all |

## Recommendation

1. **Threads first, if its dashboard accepts a loopback redirect.** It is the only candidate with a text write that needs no review (tester role), free, with 60-day tokens that can be refreshed and a documented 250-posts-per-day limit.
2. **TikTok first otherwise.** Its docs state loopback support explicitly and unaudited posts are private, which makes the first real write low-risk. It needs a video, approval of `video.publish`, and the hex PKCE challenge, which the broker already supports through the `pkce_encoding` profile option.

Decision rule for the owner: when creating the Threads app, open the OAuth settings and try to save `http://127.0.0.1:47819/oauth/callback/threads` as a valid redirect URI. Accepted: choose Threads. Rejected: choose TikTok (or do the HTTPS callback first and keep Threads).

## What the agent cannot do for you

- Create the developer app: it needs your login and acceptance of the provider's developer terms in your name.
- Run the first consent: it happens in your browser.
- Delete the test post: none of the pages read document a delete endpoint for Threads or TikTok, so remove it by hand in the app. Use a dedicated test account.

## Steps after you choose

1. Record the choice in `docs/adr/ADR-028-first-provider.md` and approve P0-15 (`bun run plan set P0-15 APPROVED --actor owner`, typed at your terminal).
2. Register the app, then run `bun run src/cli.ts app set <provider>`. Credentials go through a hidden prompt into the OS keyring, never through chat or a file.
3. Sign the provider's evidence row (the checklist at the bottom of its page in this folder), which unlocks implementing its adapter (P5-01 onward).
