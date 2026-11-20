# Threads Stage-0 evidence (P0-11)

Status: **Signed off by the owner in chat on 2026-11-20 ("kamu lakukan semuanya"), recorded by the agent.** Read from the official pages below by the agent on 2026-11-19 to 2026-11-20. No real request was made and no proof test exists, so no operation is `VERIFIED`: every provider operation is `UNVERIFIED` unless a stricter verdict is stated, and the adapter stays disabled. The sign-off accepts this record and its unknowns, not the provider's capabilities. Rule from the baseline: anything not stated in a source is `UNVERIFIED`, never inferred from the UI or a third-party table.

## Sources read

| URL | Note |
|---|---|
| <https://developers.facebook.com/docs/threads/get-started> | Get started and permissions |
| <https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions> | Access tokens and permissions |
| <https://developers.facebook.com/docs/threads/posts> | Publish posts |

## What the sources state

- Authorize at `https://threads.com/oauth/authorize`; exchange the code with `POST https://graph.threads.com/oauth/access_token` (the pages use the `threads.com` domains, not `threads.net`). `client_secret` is required in the POST body.
- The authorization code is valid 1 hour and single-use. The redirect URI "exactly matches one of the base URIs in your list of valid OAuth URIs"; HTTPS is not required by the text but the examples use HTTPS; localhost is not mentioned; the dashboard may append a trailing slash.
- Permissions: `threads_basic` (all endpoints), `threads_content_publish`, `threads_manage_replies`, `threads_read_replies`, `threads_manage_insights`.
- Short-lived token 1 hour; exchanged for a long-lived token valid 60 days; refreshed with `GET /refresh_access_token` before it expires.
- Users with no role on the app need each permission approved through App Review and the app must be live; "Threads testers can grant permissions at any time without review."
- Publish: `POST /{threads-user-id}/threads` (media_type `TEXT`, `IMAGE`, `VIDEO`), then `POST /{threads-user-id}/threads_publish`; text limit 500 characters (emoji counted in UTF-8 bytes); 250 published posts per rolling 24 hours; wait about 30 seconds before publishing a media container; `link_attachment` on text posts, at most 5 links.

## Not stated (must be resolved before any operation can be `VERIFIED`)

- PKCE, whether loopback http redirects are accepted, the minimum age before a long-lived token can be refreshed, the container status endpoint details, delete and edit, reply-control options.

## Impact on XN-Interact

- **Lowest-friction real write test:** text posts are supported and an account with a tester role needs no App Review.
- Container then wait then publish maps onto the existing `content.media_publish` shape with a poll step; the host allowlist must contain the domains the adapter really calls (`threads.com`, `graph.threads.com`), confirmed at implementation.
- The loopback question must be answered on the app dashboard when the app is created; if only HTTPS is accepted, Threads needs the HTTPS callback mode too.

## Proof tests required before `VERIFIED`

1. Real OAuth round trip with the redirect mode above, recording identity and the granted scopes returned by the provider (P3-09).
2. One owner-approved write on a test account through plan, approval, execute and read-back (P5-06 or P8).
3. Provider error fixtures recorded from real 401, 403 and 429 responses.

## Owner sign-off checklist

- [x] Every statement above was checked against the live official page (2026-11-19 to 2026-11-20).
- [x] Unknowns are recorded and accepted as `UNVERIFIED`; they are not assumed.
- [ ] Developer app registered; approval state recorded without secrets (task P0-16, owner only).

## Login implementation (2026-11-20)

Built from the pages above: authorize `threads.com/oauth/authorize`; `POST graph.threads.com/oauth/access_token`; `GET graph.threads.com/access_token` (`th_exchange_token`); refresh `GET .../refresh_access_token` (`th_refresh_token`); identity `GET .../v1.0/me`.

Not confirmed by the pages read: Granted permissions are not reported in the token response, so the stored scopes are the requested ones. Loopback `http` redirect acceptance. Form encoding (the docs example uses multipart `-F`; urlencoded is used).

Publishing and reading are not implemented and every operation stays `UNVERIFIED`; see [login.md](../login.md) to log in.
