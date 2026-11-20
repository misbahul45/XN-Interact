# ADR-028: First vertical-slice provider

Status: **Accepted: Threads first, TikTok as the fallback.** Decided on 2026-11-20 by the agent under the owner's chat delegation ("kamu lakukan semuanya", "login oauth nya sekarang"). Evidence: [first-provider-recommendation.md](../providers/first-provider-recommendation.md) and the signed rows in `docs/providers/`.

## Decision

Build the first end-to-end slice (OAuth, identity, one approved text post, read-back) on **Threads**.

## Why

- Free; a tester role on the owner's own account needs no App Review (official docs read 2026-11-19/20).
- Text posts are supported (`TEXT` container, then `threads_publish`), 500 characters, 250 posts per rolling day.
- Long-lived tokens last 60 days and refresh with the token itself, so no separate refresh secret.
- The documented login flow is plain authorization code with a client secret; no PKCE variant to get wrong.

## Known risk and the fallback rule

The official pages do not say whether an `http://127.0.0.1` redirect is accepted. The first attempt to save `http://127.0.0.1:47819/oauth/callback/threads` as a redirect URI in the Meta dashboard answers it. If it is rejected, switch to **TikTok** (desktop app type, loopback documented, hex PKCE already supported) or build the HTTPS callback (P8-08) first. Nothing else in the design depends on this choice.

## Consequences

- Threads publish and read stay `UNVERIFIED` until a real approved post and read-back pass (P5).
- The Threads adapter implements login only for now: authorization URL, code exchange plus long-lived exchange, refresh, identity. No revoke endpoint is documented, so disconnect erases the local grant and says so.
- Edit and delete are not documented for Threads; they stay `UNVERIFIED` (SC-02).

## Outcome of the redirect check (2026-11-20)

The owner's Meta app (use case Access the Threads API) refused `http://127.0.0.1:47819/oauth/callback/threads` with "HTTPS is required for all redirect URLs" and accepted `https://127.0.0.1:47820/oauth/callback/threads`. The decision stands: Threads stays the first provider, using the local HTTPS callback (profile `redirect: "https"`). The TikTok fallback is not needed. Uninstall and Delete callback URLs were not required to save.
