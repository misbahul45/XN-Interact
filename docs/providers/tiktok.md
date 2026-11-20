# TikTok Stage-0 evidence (P0-09)

Status: **Signed off by the owner in chat on 2026-11-20 ("kamu lakukan semuanya"), recorded by the agent.** Read from the official pages below by the agent on 2026-11-19 to 2026-11-20. No real request was made and no proof test exists, so no operation is `VERIFIED`: every provider operation is `UNVERIFIED` unless a stricter verdict is stated, and the adapter stays disabled. The sign-off accepts this record and its unknowns, not the provider's capabilities. Rule from the baseline: anything not stated in a source is `UNVERIFIED`, never inferred from the UI or a third-party table.

## Sources read

| URL | Note |
|---|---|
| <https://developers.tiktok.com/doc/content-posting-api-get-started> | Content Posting API |
| <https://developers.tiktok.com/doc/oauth-user-access-token-management> | User access token management |
| <https://developers.tiktok.com/doc/login-kit-desktop> | Login Kit for desktop |

## What the sources state

- Direct Post needs the `video.publish` scope: "Get approval and authorization of the `video.publish` scope." The Query Creator Info endpoint must be called first.
- Unaudited clients are limited to private viewing; "your API client must undergo an audit" to lift it.
- Publishing is asynchronous: processing continues after upload and status comes from the Get Post Status endpoint with the `publish_id`.
- Access token lifetime is 2 hours; refresh token lifetime is 180 days.
- Desktop Login Kit: authorize at `https://www.tiktok.com/v2/auth/authorize/`; "TikTok requires the Proof Key for Code Exchange (PKCE) protocol for desktop apps", S256 only, with the challenge as the **hex-encoded** SHA256 of the verifier.
- Desktop redirect URIs: "Only `localhost` or loopback IP `127.0.0.1` are allowed host names"; a port is required and a wildcard port is supported; URIs are static (no parameters or fragment); up to 10, each under 512 characters, registered in the Login Kit configuration.
- Scopes are comma-separated and assigned in the developer portal; `user.info.basic` appears in the example.

## Not stated (must be resolved before any operation can be `VERIFIED`)

- Token endpoint and revoke endpoint (linked pages not read), rate limits, any cap on users of an unaudited client, the full scope list, text and photo posting specifics, edit and delete, comments.

## Impact on XN-Interact

- **Loopback works** for the desktop app type, so the current callback listener fits TikTok.
- **The PKCE challenge is hex, not base64url.** The broker uses base64url, so the TikTok profile needs a `pkce_encoding` option.
- Only video is documented for Direct Post; unaudited posts stay private, which makes a real write test safe but needs a video file and approval of `video.publish`.
- Public posting is `APP_APPROVAL_REQUIRED` until an audit passes (recorded in the evidence row).

## Proof tests required before `VERIFIED`

1. Real OAuth round trip with the redirect mode above, recording identity and the granted scopes returned by the provider (P3-09).
2. One owner-approved write on a test account through plan, approval, execute and read-back (P5-06 or P8).
3. Provider error fixtures recorded from real 401, 403 and 429 responses.

## Owner sign-off checklist

- [x] Every statement above was checked against the live official page (2026-11-19 to 2026-11-20).
- [x] Unknowns are recorded and accepted as `UNVERIFIED`; they are not assumed.
- [ ] Developer app registered; approval state recorded without secrets (task P0-16, owner only).

## Login implementation (2026-11-20)

Built from the pages above: authorize with `client_key`, hex PKCE; `POST open.tiktokapis.com/v2/oauth/token/` (form, `client_key`, `client_secret`, `code_verifier`); refresh on the same endpoint with rotation; revoke `POST /v2/oauth/revoke/`; identity `GET /v2/user/info/` with a Bearer token.

Not confirmed by the pages read: The success payload of the token page was not shown (its example was an error body): field names come from the refresh and management pages. `display_name` is absent from the documented example, so the display name falls back to `open_id`.

Publishing and reading are not implemented and every operation stays `UNVERIFIED`; see [login.md](../login.md) to log in.
