# Reddit Stage-0 evidence (P0-12)

Status: **Signed off by the owner in chat on 2026-11-20 ("kamu lakukan semuanya"), recorded by the agent.** Read from the official pages below by the agent on 2026-11-19 to 2026-11-20. No real request was made and no proof test exists, so no operation is `VERIFIED`: every provider operation is `UNVERIFIED` unless a stricter verdict is stated, and the adapter stays disabled. The sign-off accepts this record and its unknowns, not the provider's capabilities. Rule from the baseline: anything not stated in a source is `UNVERIFIED`, never inferred from the UI or a third-party table.

## Sources read

| URL | Note |
|---|---|
| <https://github.com/reddit-archive/reddit/wiki/OAuth2> | ARCHIVED OAuth2 wiki; may be outdated and is not Reddit's current policy |
| <https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy> | NOT READ: HTTP 403 from the fetcher |
| <https://redditinc.com/policies/developer-terms> | NOT READ: the fetcher refuses this domain |

## What the sources state

- Authorize `https://www.reddit.com/api/v1/authorize`; token `https://www.reddit.com/api/v1/access_token`; bearer calls go to `oauth.reddit.com`.
- App types: web app and script app keep a secret; an installed app has none.
- `duration=permanent` returns a refresh token; "All bearer tokens expire after 1 hour"; refresh with `grant_type=refresh_token` and HTTP Basic credentials; the refresh response had no new refresh token.
- The redirect URI must match the registered one exactly; localhost is not mentioned.
- Revoke: `POST https://www.reddit.com/api/v1/revoke_token` with HTTP Basic auth; revoking a refresh token also revokes its access tokens.
- Scopes named: `identity`, `submit`, `read`, `edit`, `vote`, `history`, `mysubreddits`.

## Not stated (must be resolved before any operation can be `VERIFIED`)

- **Everything about permission to use the API:** whether approval is required, what the Responsible Builder policy allows, rules on automated posting, voting and spam, commercial limits and rate limits. The current policy pages could not be read.
- PKCE, current token lifetime (the archived page contradicts itself), per-subreddit rules.

## Impact on XN-Interact

- Reddit stays fully `UNVERIFIED` and write-disabled: ordinary OAuth consent is not proof of access (SC-04), and the policy is the deciding document.
- Action for the owner: read the current Responsible Builder policy and developer terms in a browser and record the outcome here.

## Proof tests required before `VERIFIED`

1. Real OAuth round trip with the redirect mode above, recording identity and the granted scopes returned by the provider (P3-09).
2. One owner-approved write on a test account through plan, approval, execute and read-back (P5-06 or P8).
3. Provider error fixtures recorded from real 401, 403 and 429 responses.

## Owner sign-off checklist

- [x] Every statement above was checked against the live official page (2026-11-19 to 2026-11-20).
- [x] Unknowns are recorded and accepted as `UNVERIFIED`; they are not assumed.
- [ ] Developer app registered; approval state recorded without secrets (task P0-16, owner only).

## Login implementation (2026-11-20)

Built from the pages above: authorize `reddit.com/api/v1/authorize` with `duration=permanent`; `POST .../access_token` with Basic auth and a User-Agent; refresh; revoke `POST .../revoke_token`; identity `GET oauth.reddit.com/api/v1/me`.

Not confirmed by the pages read: Everything except the identity call comes from an archived wiki; the identity endpoint is not in the pages read; Reddit's current API access policy is unknown (see the Stage-0 unknowns above).

Publishing and reading are not implemented and every operation stays `UNVERIFIED`; see [login.md](../login.md) to log in.
