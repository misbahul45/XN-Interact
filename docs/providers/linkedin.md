# LinkedIn Stage-0 evidence (P0-07)

Status: **Signed off by the owner in chat on 2026-11-20 ("kamu lakukan semuanya"), recorded by the agent.** Read from the official pages below by the agent on 2026-11-19 to 2026-11-20. No real request was made and no proof test exists, so no operation is `VERIFIED`: every provider operation is `UNVERIFIED` unless a stricter verdict is stated, and the adapter stays disabled. The sign-off accepts this record and its unknowns, not the provider's capabilities. Rule from the baseline: anything not stated in a source is `UNVERIFIED`, never inferred from the UI or a third-party table.

## Sources read

| URL | Note |
|---|---|
| <https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow> | 3-legged OAuth; page metadata ms.date 2025-11-10, updated 2026-05-15 |
| <https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin> | Share on LinkedIn; page metadata ms.date 2021-02-05, updated 2023-12-14 (older; may describe a legacy API) |

## What the sources state

- Authorize: `GET https://www.linkedin.com/oauth/v2/authorization` (`response_type=code`, `client_id`, `redirect_uri`, `scope` space-delimited, `state` optional). Token: `POST https://www.linkedin.com/oauth/v2/accessToken`, form-encoded, `client_secret` required in the body.
- Redirect URLs are registered in the Developer Portal: "Add the redirect (callback) URL via `HTTPS` to your server"; absolute URL; parameters ignored; no `#`; must match a registered URL.
- Authorization code lives 30 minutes. If the requested scope differs from the previously granted scope, "all the previous access tokens are invalidated".
- Access tokens live 60 days. The response table lists `refresh_token`, but "Programmatic refresh tokens are available for a limited set of partners"; otherwise the authorization flow is repeated and skips the consent screen only while the member is logged in and the old token has not expired.
- `w_member_social` (create a post for the member) comes from adding the "Share on LinkedIn" product in the Developer Portal Products tab. The Person URN comes from Sign In with LinkedIn using OpenID Connect.
- Create post: `POST https://api.linkedin.com/v2/ugcPosts` with `X-Restli-Protocol-Version: 2.0.0`; `shareMediaCategory` NONE (text), ARTICLE, IMAGE or VIDEO; image and video need `POST /v2/assets?action=registerUpload` then a binary upload; success is `201` and the post id is in the `X-RestLi-Id` header; visibility PUBLIC or CONNECTIONS.
- Rate limits on that page: Member 150 requests per day, Application 100,000 requests per day (UTC).

## Not stated (must be resolved before any operation can be `VERIFIED`)

- PKCE support (only an error message mentions a "code verifier"), a revoke endpoint, the identity endpoint details, edit and delete of posts, reading posts or comments, account-class restrictions.
- Whether the Share page is current or superseded by a newer Posts API: it is dated 2021 and last updated 2023.

## Impact on XN-Interact

- **The loopback callback is not offered.** The documented redirect is HTTPS only, so LinkedIn needs the HTTPS callback mode (AUTH-12, P8-08) before it can connect.
- Without programmatic refresh the grant dies after 60 days and the owner must consent again; the token manager already turns a missing or failing refresh into `REAUTH_REQUIRED`.
- A scope upgrade invalidates earlier tokens; `mode=upgrade` must tell the owner.
- 150 requests per member per day becomes the default call budget.

## Proof tests required before `VERIFIED`

1. Real OAuth round trip with the redirect mode above, recording identity and the granted scopes returned by the provider (P3-09).
2. One owner-approved write on a test account through plan, approval, execute and read-back (P5-06 or P8).
3. Provider error fixtures recorded from real 401, 403 and 429 responses.

## Owner sign-off checklist

- [x] Every statement above was checked against the live official page (2026-11-19 to 2026-11-20).
- [x] Unknowns are recorded and accepted as `UNVERIFIED`; they are not assumed.
- [ ] Developer app registered; approval state recorded without secrets (task P0-16, owner only).

## Login implementation (2026-11-20)

Built from the pages above: authorize and `POST www.linkedin.com/oauth/v2/accessToken` (form with the client secret); identity `GET api.linkedin.com/v2/userinfo` (OIDC); HTTPS redirect through the local self-signed certificate.

Not confirmed by the pages read: Whether LinkedIn accepts a loopback `https://127.0.0.1` redirect; the programmatic-refresh page was not read, so refresh only runs if LinkedIn returned a refresh token; no revoke endpoint was read.

Publishing and reading are not implemented and every operation stays `UNVERIFIED`; see [login.md](../login.md) to log in.
