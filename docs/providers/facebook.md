# Facebook Stage-0 evidence (P0-13)

Status: **Signed off by the owner in chat on 2026-11-20 ("kamu lakukan semuanya"), recorded by the agent.** Read from the official pages below by the agent on 2026-11-19 to 2026-11-20. No real request was made and no proof test exists, so no operation is `VERIFIED`: every provider operation is `UNVERIFIED` unless a stricter verdict is stated, and the adapter stays disabled. The sign-off accepts this record and its unknowns, not the provider's capabilities. Rule from the baseline: anything not stated in a source is `UNVERIFIED`, never inferred from the UI or a third-party table.

## Sources read

| URL | Note |
|---|---|
| <https://developers.facebook.com/docs/pages-api/posts> | Pages API: posts |

## What the sources state

- Permissions named: `pages_manage_engagement`, `pages_manage_posts`, `pages_read_engagement`, `pages_read_user_engagement`; `publish_video` for videos. The page does not map permissions to individual publish, update or delete calls.
- The app needs a Page access token obtained through Facebook Login, and the user must be able to perform the `CREATE_CONTENT`, `MANAGE` and `MODERATE` tasks on the Page.
- Posting is described only as the Page; posting to a personal profile is not covered.
- Text: `POST /{page_id}/feed` with `message`; link: add `link`; photo: `POST /{page_id}/photos` with `url`; video: separate Video API; scheduling: `published=false` and `scheduled_publish_time` between 10 minutes and 30 days ahead.
- App Review for publishing is not stated; Page Public Content Access is needed when the user does not own or manage the Page.

## Not stated (must be resolved before any operation can be `VERIFIED`)

- Authorization and token URLs, redirect rules, token lifetimes, App Review for each permission, delete and edit endpoints, rate limits.

## Impact on XN-Interact

- Only Pages are in scope: personal-profile posting is not offered, matching the baseline's "no unrestricted personal-profile posting".
- Account role must come from the Page tasks, so `ACCOUNT_ROLE_INSUFFICIENT` maps to those tasks.
- The four Meta token contexts stay separate (SC-07).

## Proof tests required before `VERIFIED`

1. Real OAuth round trip with the redirect mode above, recording identity and the granted scopes returned by the provider (P3-09).
2. One owner-approved write on a test account through plan, approval, execute and read-back (P5-06 or P8).
3. Provider error fixtures recorded from real 401, 403 and 429 responses.

## Owner sign-off checklist

- [x] Every statement above was checked against the live official page (2026-11-19 to 2026-11-20).
- [x] Unknowns are recorded and accepted as `UNVERIFIED`; they are not assumed.
- [ ] Developer app registered; approval state recorded without secrets (task P0-16, owner only).

## Login implementation (2026-11-20)

Built from the pages above: dialog `facebook.com/v27.0/dialog/oauth`; code exchange and `fb_exchange_token` on `graph.facebook.com/v27.0/oauth/access_token`; Pages from `GET /me/accounts` (first 100), each Page becomes one account with its own Page access token.

Not confirmed by the pages read: The login-flow page did not mention localhost or HTTPS rules; Page tokens from a long-lived user token are documented as non-expiring, so none is refreshed; no revoke call implemented; Pages beyond the first 100 are not listed.

Publishing and reading are not implemented and every operation stays `UNVERIFIED`; see [login.md](../login.md) to log in.
