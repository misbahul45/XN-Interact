# Logging in to your social accounts

The OAuth login is built and tested for all seven providers against the official endpoints. What only you can do is register a developer app in each provider's console (it needs your login and acceptance of their developer terms) and give your own consent in the browser.

Run `bun run src/cli.ts providers` any time: it prints, per provider, whether login is ready, whether its app credentials are stored, the **exact redirect URI to register**, the scopes requested and any caveat.

## The same three steps for every provider

1. **Register an app** in the provider's console (table below). Add the redirect URI exactly as printed, add yourself as a tester or developer where the provider requires it, and copy the app id and app secret.
2. **Store the credentials** (hidden prompt, nothing goes through chat):
   `bun run src/cli.ts app set <provider>`
3. **Log in:** `bun run src/cli.ts connect <provider> --open`
   It prints the consent URL, opens it, waits for your approval, then prints the connected account (name, type, state) and never a token. Exit code 0 means connected.

From a Claude Code or Codex session you can say "hubungkan akun <provider> saya"; the CLI route needs no new session.

## Per provider

| Provider | Console | Redirect URI to register | Scopes requested | Notes |
|---|---|---|---|---|
| Threads | developers.facebook.com, Threads use case | `https://127.0.0.1:47820/oauth/callback/threads` | threads_basic, threads_content_publish | Add yourself as a Threads tester. Confirmed in the console: Meta refuses `http` redirects and accepts the HTTPS loopback |
| TikTok | developers.tiktok.com, Login Kit (desktop) | `http://127.0.0.1:47819/oauth/callback/tiktok` | user.info.basic, video.publish | Desktop apps must register a redirect with a port. Unaudited apps can only post privately |
| X | developer.x.com console | `http://127.0.0.1:47819/oauth/callback/x` | tweet.read, tweet.write, users.read, offline.access | Prepaid credits; every later write costs money. Callback acceptance for loopback is not stated in the docs read |
| LinkedIn | linkedin.com/developers | `https://127.0.0.1:47820/oauth/callback/linkedin` | openid, profile, w_member_social | Add the products "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect". HTTPS only: the local self-signed certificate is used and your browser warns once |
| Instagram | developers.facebook.com, use case "Manage messaging & content on Instagram" > API setup with Unified login | `https://127.0.0.1:47820/oauth/callback/instagram` | set by the login configuration: instagram_basic, instagram_manage_insights, instagram_content_publish, instagram_manage_comments | Needs a business portfolio, a login configuration (the app asks for its `config_id` together with the app id and secret: use the **Meta app** id and secret), the HTTPS redirect saved in the configuration, and the Instagram professional account invited and accepted as Instagram Tester. Reads of your own account work; image publishing is in [instagram-publishing.md](instagram-publishing.md) |
| Facebook | developers.facebook.com, Facebook Login | `http://127.0.0.1:47819/oauth/callback/facebook` | pages_show_list, pages_manage_posts, pages_read_engagement, pages_manage_engagement | Connects the Pages you manage, one account each; personal profiles are not offered. If Meta refuses `http` loopback use `--https` |
| Reddit | reddit.com/prefs/apps | `http://127.0.0.1:47819/oauth/callback/reddit` | identity, submit, read | Endpoints come from an archived wiki and Reddit's current API policy could not be read: it may require approval before an app works. Read the Responsible Builder Policy in a browser first |

Ports: `47819` for HTTP and `47820` for HTTPS, both bound to `127.0.0.1` only and open only while a login is waiting (closed after ten idle minutes). Change them with `XN_INTERACT_CALLBACK_PORT` and `XN_INTERACT_HTTPS_PORT`, then register the new URI. `XN_INTERACT_REDIRECT_MODE=https` forces the HTTPS redirect for every provider; `connect <provider> --https` or `--loopback` overrides one login.

## What login does and does not give you

- Tokens are stored encrypted in the vault and never printed. Long-lived tokens (Threads, Instagram, Facebook user token) are refreshed automatically before they expire; TikTok and X rotate their refresh tokens and the new one is stored each time; LinkedIn tokens last 60 days and cannot be refreshed unless LinkedIn enabled that for your app, so you log in again.
- Providers that document no revoke endpoint (Threads, LinkedIn, Instagram, Facebook): disconnecting erases the local grant and tells you to also remove the app in your account settings there. TikTok, X and Reddit are revoked at the provider.
- **Publishing and reading stay `UNVERIFIED` for every provider** until a real approved post and read-back pass for it (tasks P5 and P8). Logging in cannot post anything.
- Threads does not report which permissions you granted in its token response (nothing documented), so a denied permission would only show up on first use.

## If something fails

| Symptom | Meaning |
|---|---|
| `APP_APPROVAL_REQUIRED ... xn-interact app set <provider>` | step 2 was not done |
| The provider says the redirect URI is invalid | it differs from the printed one character for character (scheme, `127.0.0.1`, port, path), or the provider refuses that scheme: retry with `--https` or `--loopback` |
| Browser warns about the certificate | expected for the local HTTPS redirect: continue to 127.0.0.1 once |
| `exchange_failed:PROVIDER_ERROR` | the code was rejected: check the app secret, the redirect URI and that you are a tester or developer of the app |
| `failed` with `no_identity` or `PROVIDER_ERROR` on Facebook | no Page you can manage was returned: the account needs a role on a Page and the `pages_show_list` permission |
