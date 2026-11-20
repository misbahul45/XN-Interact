# XN-Interact threat model v0

Scope: local personal deployment (Bun stdio server spawned by Claude Code or Codex, SQLite home, OS keyring, operator-owned provider apps, owner approvals at a terminal). Remote multi-user deployment is out of scope.

Assets: provider access and refresh tokens, operator client secrets, vault master key, OAuth state and PKCE verifiers, the owner's public reputation on seven platforms, content drafts and media, workflow journal, approval decisions, provider quotas and paid budgets.

Trust boundaries: (1) host process ↔ XN-Interact over stdio; (2) XN-Interact ↔ provider APIs over HTTPS; (3) browser ↔ transient loopback callback; (4) owner terminal ↔ approval CLI; (5) XN-Interact ↔ XN-Bridge, only through the host.

| # | Threat (spec section 18) | Mitigations | Requirements | Tasks / tests |
|---|---|---|---|---|
| T01 | OAuth state theft or CSRF | 256-bit single-use state bound to attempt, expiry, exact match on callback | AUTH-03 | P3-02, P3-08 |
| T02 | Authorization code interception | PKCE S256 where supported, loopback on 127.0.0.1 only, listener closes after one callback | AUTH-03, AUTH-04 | P3-02, P3-03, P3-08 |
| T03 | Open redirect | Redirect URIs come from the signed provider profile, never from tool input | AUTH-04 | P3-01, P3-03 |
| T04 | Leaked credentials | Tokens never in tool inputs or outputs; AES-256-GCM at rest; redacting logger; canary scan of every surface | AUTH-09, SEC-01, SEC-06, OPS-02 | P2-03, P2-05 |
| T05 | Confused deputy (host acts beyond the owner's intent) | Explicit account IDs, two-phase plans, approval bound to plan hash at a TTY, no approval tool | CORE-09, FLOW-05, FLOW-06, FLOW-10 | P4-05…P4-09 |
| T06 | Account mix-up across providers or accounts | AAD binds provider, account, grant and revision; capability cache keyed by account and grant revision | SEC-02, AUTH-05, AUTH-11 | P2-03, P4-03, P10-01 |
| T07 | MCP client impersonation | stdio only by default; HTTP disabled until audited | CORE-08 | P10-07 |
| T08 | Prompt injection in provider content | Provider content is data in results; routing and approvals never read it; prompts are inert templates | SEC-03 | P10-02 |
| T09 | SSRF through media URLs | No remote fetch for media; provider HTTP restricted to per-provider host allowlist | ROUTE-08, SEC-04 | P2-06, P2-07 |
| T10 | Symlink or traversal in local files | Realpath inside the sandbox root, no symlinks, regular files only | SEC-04 | P2-07, P6-07 |
| T11 | Oversized files | Size limits per provider and global cap before reading | SEC-04 | P2-07 |
| T12 | Mass messaging or spam | No bulk engagement skill; every external write approved per plan; per-operation quotas | ROUTE-06, PERF-04, FLOW-05 | P4-04, P4-06 |
| T13 | Cost exhaustion | Budget admission before the request; X operations always cost-gated | ROUTE-06, PERF-04 | P4-04, P8-04 |
| T14 | Secrets in logs | stderr logger redacts token-like values and known secrets; audit stores redacted JSON | SEC-06, OPS-02 | P2-05 |
| T15 | Hostile callback requests | Host and path checks, state lookup before any work, bounded body, listener lifetime | AUTH-04 | P3-03, P3-08 |
| T16 | Duplicate writes | Intent journal with unique dedupe key; unknown outcome never retried; leases across processes | FLOW-01, FLOW-03, FLOW-11 | P4-08, P5-07, P7-05 |
| T17 | Approval replay | One-time nonce, consumption in the same transaction as the intent row, expiry | FLOW-05, FLOW-06 | P4-06, P4-09 |
| T18 | Policy drift at providers | Evidence rows with verified date; stale evidence demotes operations to UNVERIFIED | ROUTE-09, SEC-05 | P0-07…P0-13, P4-11, P10-04 |
| T19 | Counterfeit provider domain | TLS verification, fixed per-provider hosts, no user-supplied base URLs | ROUTE-08 | P2-06 |
| T20 | Dependency compromise | Exact pins in bun.lock, minimal dependency set, audit before release | — | P10-06 |
| T21 | Bridge autonomy treated as consent (new) | XN-Interact ignores bridge approvals and autonomy; bridge allowlist proposed | INT-03, INT-08 | PB-10, PB-11 |
| T22 | Agent marks its own approval in the tracker (new) | `plan set … APPROVED` needs `--actor owner` and an interactive TTY; checker rejects agent approvals | — | tests/plan |
| T23 | Agent arms an unverified operation itself, or reuses an arming (new) | Arming exists only as an owner CLI command that needs a terminal (no tool, no environment switch); one arming covers one account and one operation, lasts at most 60 minutes and is spent by the first request that is sent; the normal plan and its separate approval are still required; arming and consumption are audited | FLOW-05, ROUTE-09 | tests/oauth/threads-acceptance.test.ts |
| T24 | An agent, or content it read, uses a standing grant to publish more than the owner intended, or creates, extends or revokes one (new) | A grant exists only through an owner CLI command that needs a terminal (no tool, argument or environment switch); it covers one account and one operation (plain text publish), lasts at most 24 hours, at most 10 posts per rolling day and 50 in total; media, edits, deletes, scheduled and multi-target plans always need a human; it never overrides a rejected, used or expired approval and never bypasses the capability gate, so an UNVERIFIED operation stays refused; an unresolved outcome suspends it for good; creation, use, suspension and revocation are audited | FLOW-05, ROUTE-09 | tests/security/grants.test.ts |
| T25 | An agent, or injected content, signs evidence itself to turn an UNVERIFIED operation into a usable one, or signs without a real run (new) | Signing exists only through an owner CLI command that needs a terminal (no tool, argument or environment switch); it needs a spent acceptance arming and a succeeded run of that operation on that account; it covers one account and one operation (plain text publish) for at most 90 days; it grants no permission to write without an approval or a live standing grant; a revoked or expired signoff makes the operation UNVERIFIED again at once, including in other processes (the capability cache key carries a signoff epoch); signing and revoking are audited | FLOW-05, ROUTE-09 | tests/security/signoffs.test.ts |
| T26 | An agent publishes a different image than the owner approved, an image from an arbitrary URL, or an unsuitable file to Instagram (new) | The image URL is never tool input: it is the operator-configured HTTPS base plus the sha256 of the bytes the owner approved, so the plan's content digest names the exact file; only a JPEG is planned (a PNG is refused at plan time, before any approval); before anything is sent to Meta the adapter checks that the URL answers 200 with an image/jpeg content type, and a failure sends nothing; the one step that makes a file public (`media host`) exists only as an owner CLI command that needs a terminal, a typed sha256 prefix and a git checkout; a container creation is not visible on Instagram, and only the separate publish step is, behind the usual approval; limits: the adapter cannot verify the hosted bytes (the transport is text-only), so the host must be operator-owned | FLOW-05, ROUTE-09 | tests/oauth/instagram-publish.test.ts |

Residual risks accepted for release 1: a compromised host process can still call read tools and create plans (it cannot approve them); a compromised user account on the machine can read the keyring and the database.
