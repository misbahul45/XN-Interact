# Instagram Stage-0 evidence (P0-08)

Status: **Rewritten on 2026-11-20 for Unified Login, read from the official pages below by the agent. Not signed off by the owner yet.** No real request has been made against Instagram and no proof test exists, so no operation is `VERIFIED`. The earlier version of this file described Instagram Login; Meta's console now offers new apps only the Unified Login setup ("API setup with Instagram login is not available for newer apps"), so the adapter was rewritten.

## Sources read (2026-11-20)

| URL | Note |
|---|---|
| <https://developers.facebook.com/documentation/instagram-platform/overview> | Three API setups and which one new integrations use |
| <https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started> | Configuration, login URL, code exchange, account ids |
| <https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication> | Token type, host, request shape |
| <https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business> | Facebook Login for Business, configurations, token types |

## What the sources state

- **Unified Login is recommended for new integrations.** Users connect an Instagram professional account by logging in with Instagram or Facebook; a Facebook Page is **not** required. The app must be owned by a business portfolio, and an HTTPS redirect URL is required.
- Authorization is Facebook Login for Business. The login URL is `https://www.facebook.com/dialog/oauth?client_id=<META_APP_ID>&config_id=<CONFIG_ID>&redirect_uri=<HTTPS_REDIRECT>&response_type=code` (`prompt=login` shows both the Facebook and the Instagram login options). The Login URL that the App Dashboard itself generated on 2026-11-20 also carries `display=popup` and `override_default_response_type=true`; the adapter sends the latter. The configuration decides the permissions, so no `scope` is sent. The App Dashboard **accepted the redirect URL `https://127.0.0.1:47820/oauth/callback/instagram`** ("Redirect URL saved.").
- Code exchange: `GET https://graph.facebook.com/v27.0/oauth/access_token?client_id=<META_APP_ID>&client_secret=<META_APP_SECRET>&code=<CODE>`, with the **Meta app id and secret, not an Instagram app id and secret**. The Unified Login page omits `redirect_uri` here; Facebook's standard flow requires it, so the adapter sends the same `redirect_uri` as the dialog (a first real attempt on 2026-11-20 without it was refused by Meta with an unrecorded reason).
- The token is a **business integration system user access token**. It belongs to the client's business portfolio, covers every asset shared with the app, and its expiry depends on the configuration. It stops working if the client removes the app from the portfolio or moves the Instagram account.
- With this token `/me` is the system user, not the Instagram account. Account ids come from `GET /me/assigned_instagram_accounts?fields=id,username` (needs `instagram_basic`); the client business id from `GET /me?fields=client_business_id`. Every request names the Instagram professional account id in its path on `graph.facebook.com`.
- Default configuration requests an Instagram account, an optional ad account, and the permissions `instagram_basic` and `instagram_manage_messages` (required) plus `instagram_manage_comments`, `instagram_content_publish`, `ads_management`, `ads_read`. `instagram_manage_insights` can be added.
- In Development mode the Instagram professional account must be invited as an **Instagram Tester** and the invitation accepted on Instagram web (Settings > Website permissions > Apps and websites > Tester Invites). Test users are not supported. Standard Access is enough for accounts that have a role on the app.
- Content publishing and insights are supported by this setup. Publishing media must be reachable at a public URL (see the earlier finding: the sandbox never fetches or serves remote media).

## Not stated (must be resolved before any operation can be `VERIFIED`)

- Whether the login dialog itself accepts the loopback redirect at runtime (the App Dashboard accepted it when saving the configuration).
- The default token expiry of a configuration, and whether the code exchange needs `redirect_uri`.
- Current insight metric names and which need `metric_type=total_value`.
- Publishing limits for this setup, edit and delete, and comment endpoints.

## What the adapter does today

- **Login:** Facebook dialog with `config_id` (stored with the app credentials by `xn-interact app set instagram` / `login instagram`, which also asks for it), code exchange as above, one XN-Interact account per shared professional account, all sharing the one token. Tokens without an expiry are stored without one; there is no refresh, so a rejected token asks the owner to log in again.
- **Reads of the owner's own account** (`account.read`, `content.read`, `analytics.read`) are implemented and can each be armed for one acceptance run. Everything else stays `UNVERIFIED` and is refused.
- **Image publishing is implemented** (see [../instagram-publishing.md](../instagram-publishing.md)) but `UNVERIFIED`: container creation from an operator-hosted public JPEG URL, polling, `media_publish`, read-back by caption. It needs `XN_INTERACT_PUBLIC_MEDIA_BASE` and an owner-armed acceptance run covering `media.upload` and `content.publish.image`. Carousels, reels, stories, edits and deletes are not implemented.

## Proof tests required before `VERIFIED`

1. Real OAuth round trip with the HTTPS loopback redirect, recording the identity and accounts returned (P3-09).
2. One owner-armed read of each of `account.read`, `content.read`, `analytics.read` on the owner's own account (acceptance run), and one owner-approved image post through `first-post` (acceptance run over `media.upload` and `content.publish.image`).
3. Provider error fixtures recorded from real 400 (code 190), 403 and 429 responses.

## Owner sign-off checklist

- [x] Every statement above was checked against the live official page (2026-11-20).
- [x] Unknowns are recorded and accepted as `UNVERIFIED`; they are not assumed.
- [ ] Meta app configuration created and `config_id` stored (owner only; the app secret is typed by the owner, never given to an agent).
- [ ] Instagram professional account invited and accepted as Instagram Tester (owner only).

See [login.md](../login.md) to log in.
