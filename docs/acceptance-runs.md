# Acceptance runs: the first real operation on a provider

Every provider operation starts `UNVERIFIED`. It becomes `VERIFIED` only through signed evidence, and the evidence for publishing needs one real, approved post that is read back. An acceptance run is the controlled way to produce that first real result without weakening the write-safety rules.

## What it is

- The owner **arms** one operation on one account from a terminal: `bun run src/cli.ts accept <provider> <operation> --account <account_id>`. The command refuses to run without a terminal and asks the owner to type the operation name.
- While armed, that one operation resolves to `NEEDS_APPROVAL` instead of `UNVERIFIED`. Every other operation, account and provider stays `UNVERIFIED`.
- The normal flow is unchanged: a draft, a plan, the owner's separate approval of the exact plan hash (`bun run src/cli.ts approve <approval_id>`), then `mode=execute`. Arming sends nothing.
- The arming lasts at most 60 minutes and is **spent by the first request that is sent**: a success or an unknown outcome. A failure before any request (for example a container the provider could not prepare) leaves it armed until it expires.
- Only an operation whose adapter declares it prepared for an acceptance run (`acceptance: true` in its manifest) can be armed. No MCP tool can arm, list-and-arm or extend it (threat T23).

`bun run src/cli.ts accept list` shows every arming; `accept revoke <id>` cancels a live one.

## One command for the owner

`bun run src/cli.ts first-post threads --text-file <file>` runs everything in one terminal session: it shows the exact text, asks the owner to arm the run (type the operation name), builds the plan, shows it and asks the owner to approve it (type the first 8 characters of the plan hash), publishes once, and reads the post back. It refuses to run without a terminal, so an agent or a script cannot run it for the owner. The two typed confirmations are the owner's real arming and real approval; nothing else in the system can give them.

## Threads, first post (step by step)

1. Owner: `bun run src/cli.ts accept threads content.publish.text --account <account_id>`.
2. Agent: `bun run scripts/threads-first-post.ts plan --text-file <file>` creates the draft and the plan and prints the approval id.
3. Owner: `bun run src/cli.ts approve <approval_id>` (the terminal shows the exact text and the plan hash).
4. Agent: `bun run scripts/threads-first-post.ts execute --plan-id <plan_id>`.

What happens: the adapter creates a text container, polls its status until `FINISHED` (it gives up without publishing if that never happens), publishes it once, then reads the post back by listing the most recent posts and matching the identical text. It never retries a publish after an unknown outcome, and read-back never claims a post is absent because Threads has no client token that could prove it.

## Things to know before a real Threads post

- The post is public and appears under the connected Threads profile.
- The app has only `threads_basic` and `threads_content_publish`. There is **no delete permission**, so the gateway cannot remove the post afterwards: delete it in the Threads app if it was only a test.
- Text posts are limited to 500 characters and emoji count as their UTF-8 bytes. Threads allows 250 published posts per rolling 24 hours.
- After the run, the owner decides whether to sign the evidence row so that `content.publish.text` becomes `VERIFIED` for later runs (task P5-06).
