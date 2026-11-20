# XN-Interact

Bun-native MCP server that operates the officially supported parts of the owner's social accounts (LinkedIn, Instagram, TikTok, X, Threads, Reddit, Facebook) through provider OAuth. No frontend, no internal model, no browser fallback. XN-Bridge coordinates it with the owner's other MCP servers.

## State on 2026-11-20

- Kernel complete and tested: 22 tools, 9 resources, 4 prompts over stdio; OAuth broker with state, PKCE (base64url or hex) and a loopback callback; AES-256-GCM vault keyed from the OS keyring (fails closed); capability truth function with an evidence-freshness gate; budgets; immutable plans; terminal-only approvals; intent journal; workflow engine with fan-out, reconciliation, restart recovery, single-flight runs, atomic step claims, per-run and per-grant leases, cancellation and scheduling; retention and verified backups.
- Providers: OAuth **login is built and tested for all seven** (Threads, TikTok, X, LinkedIn, Instagram, Facebook, Reddit) against the official endpoints; see [docs/login.md](docs/login.md) and run `bun run src/cli.ts providers`. Publishing and reading stay **UNVERIFIED** for every provider until a real approved post and read-back pass. No real login or post has been made yet because that needs your developer apps. Signed Stage-0 evidence is in `docs/providers/`; Threads is the first slice (ADR-028).
- XN-Bridge: `xn-interact` and `xn-bridge` are registered in every host config on this machine; 20 `social.*` capabilities resolve to `xn-interact`; a `social` domain, social routing and one dynamic router exist.
- Operations: the `xn-interact-worker` systemd user service runs scheduled and pending workflows ([operations guide](docs/operations.md)).
- Tests: `bun test` (154), run three times in a row after every change to concurrency-sensitive code.

## Run

```bash
bun install
bun run src/cli.ts vault init      # once: creates the vault key in the OS keyring
bun run src/cli.ts doctor          # readiness
bun run src/main.ts                # stdio MCP server (hosts spawn this)
```

Social writes are two-phase. The host calls a write tool with `mode=plan`; you review and approve **in your own terminal**:

```bash
bun run src/cli.ts approvals             # pending approvals
bun run src/cli.ts approve <approval_id> # shows every target and the text, asks for the plan hash prefix
```

Then the host calls the same tool with `mode=execute`, `plan_id` and a fresh `operation_id`. No tool can approve.

Operator app credentials go into the keyring through a hidden prompt: `bun run src/cli.ts app set <provider>`. Log in with `bun run src/cli.ts connect <provider> --open` (see [docs/login.md](docs/login.md)).

## Plan and tracking

The plan is machine-checked: `bun run plan` (board), `bun run plan next`, `bun run plan:check`. See [docs/plan/README.md](docs/plan/README.md), the generated [status](docs/plan/STATUS.md), the [consistency review](docs/plan/consistency-review.md) and the [XN-Bridge contract](docs/plan/xn-bridge-integration.md).
