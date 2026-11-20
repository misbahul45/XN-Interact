# Standing grants: publish plain text without a terminal approval per post

A standing grant is a permission the **owner signs once in a terminal**. While it is live, the MCP gateway can complete the *approval* step of a plain-text publish by itself. It does **not** make an operation verified, and it is not a way around anything else in the gateway.

## What it replaces, and what it does not

| Still enforced | Detail |
|---|---|
| Capability gate | An `UNVERIFIED` operation is refused when the plan is made, before any approval or grant is looked at. A grant on an unverified operation does nothing. |
| Plan, plan hash, content digest | The grant is spent for one exact plan; changed content is rejected like before. |
| `operation_id` | Single use. A replay sends nothing and spends nothing. |
| Human decisions | A rejected, used or expired approval is never overridden by a grant. |
| Audit | `grant.created`, `grant.used`, `grant.suspended`, `grant.revoked` are recorded. |

What a grant covers: **one account, one operation (`content.publish.text`), one immediate single-target plan.** Media, edits, deletes, replies, scheduled posts and multi-target plans always need the owner's approval.

## Limits (hard caps in code)

- Lifetime: at most 24 hours (default 24).
- At most 10 posts per rolling 24 hours (default 3) and 50 in total (default 10).
- One live grant per account and operation: creating a new one revokes the old one.
- An unresolved outcome (`unknown_outcome` or `reconciling`) under the grant **suspends it for good**; the owner reviews the run and creates a new grant.

## Owner commands (a real terminal is required, like `accept` and `approve`)

```
bun run src/cli.ts grant create threads content.publish.text --account <account_id> [--hours 24] [--per-day 3] [--max-total 10]
bun run src/cli.ts grant list
bun run src/cli.ts grant revoke <grant_id>
```

`grant create` prints the limits, then asks you to type the operation name and the account name. `grant list` works without a terminal and shows state, expiry and use counts.

## How the agent sees it

`social_content_publish` with `mode=plan` returns a `standing_grant` block (grant id, expiry, remaining counts) when a live grant covers the plan. Then `mode=execute` with a fresh `operation_id` runs without a terminal approval, and `social_approvals_status` shows `via_standing_grant`. No tool or argument can create, extend or change a grant (threat T24).

## Verification state comes first

For Threads, `content.publish.text` is `UNVERIFIED` until a real approved post has passed (see [acceptance-runs.md](acceptance-runs.md)) and the owner has signed it off (`evidence sign`, see [evidence-signoff.md](evidence-signoff.md)). Until then a grant has no effect: the plan is refused with `UNVERIFIED`.
