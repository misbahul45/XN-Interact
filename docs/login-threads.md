# Logging in with Threads (first provider)

All seven providers have the same flow: see [login.md](login.md). This page is the Threads walkthrough.

Everything the code needs is built and tested against recorded Threads behaviour from the official docs. Only you can do steps 1 to 3: they need your Meta login and your acceptance of Meta's developer terms.

## 1. Create the Meta app

1. Open <https://developers.facebook.com/apps> and create an app with the Threads use case (the **Threads API** product).
2. Under the Threads product settings add the redirect callback URL **exactly**:

   `https://127.0.0.1:47820/oauth/callback/threads`

   Verified in the Meta console on 2026-11-20: `http://127.0.0.1` is refused ("HTTPS is required for all redirect URLs") and `https://127.0.0.1:47820/...` is accepted and saved. The Uninstall and Delete callback URLs can stay empty.
3. Add the permissions `threads_basic` and `threads_content_publish`.
4. Make your own Threads account a **Threads tester** of the app and accept the invitation in Threads (testers can grant permissions without App Review, per the official docs).
5. Copy the **Threads app ID** and the **Threads app secret** (the docs call it "your Threads app secret"; it may differ from the main Meta app secret).

## 2. Store the credentials (hidden prompt, nothing goes through chat)

```bash
cd ~/code/XN-Interact
bun run src/cli.ts app set threads
```

Paste the app ID, then the secret. Both go into the OS keyring.

## 3. Log in

```bash
bun run src/cli.ts connect threads --open
```

It prints the consent URL (and opens it with `--open`), waits for your approval in the browser, then prints the connected account (name, type, state) and never a token. Exit code 0 means connected.

Check afterwards:

```bash
bun run src/cli.ts doctor        # providers.items: threads shows accounts: 1
```

From a Claude Code or Codex session you can do the same with "hubungkan akun threads saya" (`social_auth_connect`); the CLI route needs no new session.

## What login does and does not give you

- The long-lived token (60 days) is stored encrypted and refreshed with itself before it expires; after 60 days without a refresh you must log in again.
- Threads documents no revoke endpoint: disconnecting erases the local grant and tells you to remove the app under your Threads account settings.
- Publishing and reading stay `UNVERIFIED` until a real approved post and read-back pass (task P5). Login alone cannot post.

## If something fails

| Symptom | Meaning |
|---|---|
| `APP_APPROVAL_REQUIRED ... xn-interact app set threads` | step 2 was not done |
| Meta says the redirect URI is invalid | the registered URI differs from `redirect_uri:` printed by `connect`, character for character (port and path included), or Meta refuses `http` loopback |
| `exchange_failed:PROVIDER_ERROR` | the code was rejected: check the app secret and that you are a tester |
| `failed` with `different_account_consented` | not applicable to a first login; appears only on `mode=upgrade` |
