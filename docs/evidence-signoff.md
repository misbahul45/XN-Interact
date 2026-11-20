# Evidence signoff: after the first real post worked

Every provider operation starts `UNVERIFIED` and an [acceptance run](acceptance-runs.md) lets the owner try ONE real operation. The arming is spent by that one request, so the operation falls back to `UNVERIFIED`. An **evidence signoff** is the owner's terminal statement that the run really worked. It keeps that one operation usable on that one account, after the usual approval or a live [standing grant](standing-grants.md).

## What it changes, and what it does not

| Changes | Does not change |
|---|---|
| `content.publish.text` on the signed account goes from `UNVERIFIED` to `NEEDS_APPROVAL`. | Every publish still needs a terminal approval or a live standing grant. |
| It lasts at most 90 days, then the operation is `UNVERIFIED` again. | Other operations (images, video, updates, deletes, replies) and other accounts stay `UNVERIFIED`. |
| A revoked or expired signoff takes effect at once in every process. | The provider evidence freshness check (90 days) still applies first. |

## Rules in code

- It needs a **spent acceptance arming** and a **succeeded run** of that operation on that account that started after the arming.
- One active signoff per account and operation; signing again replaces the old one.
- Only an owner CLI command can sign or revoke, and it needs a real terminal. No MCP tool, argument or environment switch can (threat T25).
- Signing and revoking are audited (`evidence.signed`, `evidence.revoked`).

## Owner commands

```
bun run src/cli.ts evidence sign threads content.publish.text --account <account_id> [--days 90]
bun run src/cli.ts evidence list
bun run src/cli.ts evidence revoke <signoff_id>
```

`evidence sign` prints the basis (arming id, run id and the post URL), then asks you to type the operation name and the account name. `evidence list` works without a terminal.

## The whole path to a post the MCP can make on its own

1. `first-post` once (two typed confirmations). It is public and cannot be deleted through the gateway.
2. `evidence sign` once.
3. `grant create` for a capped, time-boxed grant.
4. The MCP plans and executes plain text posts within the grant's limits. Everything else still needs the owner.
