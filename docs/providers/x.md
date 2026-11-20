# X Stage-0 evidence (P0-10)

Status: **Signed off by the owner in chat on 2026-11-20 ("kamu lakukan semuanya"), recorded by the agent.** Read from the official pages below by the agent on 2026-11-19 to 2026-11-20. No real request was made and no proof test exists, so no operation is `VERIFIED`: every provider operation is `UNVERIFIED` unless a stricter verdict is stated, and the adapter stays disabled. The sign-off accepts this record and its unknowns, not the provider's capabilities. Rule from the baseline: anything not stated in a source is `UNVERIFIED`, never inferred from the UI or a third-party table.

## Sources read

| URL | Note |
|---|---|
| <https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code> | OAuth 2.0 authorization code |
| <https://docs.x.com/x-api/getting-started/pricing> | Pricing |

## What the sources state

- Authorize at `https://x.com/i/oauth2/authorize`; token at `https://api.x.com/2/oauth2/token` (shown in the refresh example).
- `code_challenge` and `code_challenge_method` are listed as parameters; the page does not say whether PKCE is mandatory for every app type.
- Access tokens last two hours by default; the `offline.access` scope makes a refresh token be issued (`grant_type=refresh_token`, `refresh_token`, `client_id`).
- The callback URL must match one defined in the app settings by exact match; localhost and 127.0.0.1 are not mentioned.
- Scopes: `users.read`, `users.email`, `follows.read`, `tweet.read`, `tweet.write` (posting and retweeting), `like.read`, `like.write`. No delete-specific scope is listed; the page links an endpoint-to-scope guide that was not read.
- Pricing is "pay-per-usage" with prepaid credits and no subscriptions: $0.015 per standard post, $0.200 per post with a URL, $0.010 per summoned post, $0.005 per post read, $0.001 per owned-read resource; a 3 million post-read cap per cycle; a post already paid for is not charged again within the same 24-hour UTC window.

## Not stated (must be resolved before any operation can be `VERIFIED`)

- Whether localhost redirects are accepted, whether PKCE is mandatory, a revoke endpoint, the identity endpoint, delete mapping, the automation policy and the developer agreement (the pricing page says nothing about them), app review.

## Impact on XN-Interact

- **Every write costs money.** The cost gate is mandatory: the per-call cost comes from operator configuration, not from prices hardcoded in the manifest, and the figures above are only dated evidence.
- The 24-hour de-duplication makes cost estimates inherently uncertain: `cost_uncertain` stays true.
- Read cost is per returned post, so listing must keep small bounded pages.

## Proof tests required before `VERIFIED`

1. Real OAuth round trip with the redirect mode above, recording identity and the granted scopes returned by the provider (P3-09).
2. One owner-approved write on a test account through plan, approval, execute and read-back (P5-06 or P8).
3. Provider error fixtures recorded from real 401, 403 and 429 responses.

## Owner sign-off checklist

- [x] Every statement above was checked against the live official page (2026-11-19 to 2026-11-20).
- [x] Unknowns are recorded and accepted as `UNVERIFIED`; they are not assumed.
- [ ] Developer app registered; approval state recorded without secrets (task P0-16, owner only).

## Login implementation (2026-11-20)

Built from the pages above: authorize `x.com/i/oauth2/authorize` with S256; `POST api.x.com/2/oauth2/token` (Basic auth for confidential apps, `client_id` in the body); refresh and revoke on the documented endpoints; identity `GET /2/users/me`.

Not confirmed by the pages read: The token response field names are not listed on the page (parsed defensively: `access_token`, `refresh_token`, `expires_in`, `scope`); whether refresh tokens rotate is not stated (a returned one is stored, otherwise the old one is kept); loopback callback acceptance.

Publishing and reading are not implemented and every operation stays `UNVERIFIED`; see [login.md](../login.md) to log in.
