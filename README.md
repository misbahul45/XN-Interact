# XN-Interact

Bun-native stdio MCP gateway for authorized browser datasets and existing social provider APIs. Browser collection starts a shared local broker and sandboxed Google Chrome headlessly on demand. Chrome keeps authenticated state in a dedicated profile. XN-Bridge discovers the same `xn-interact` server across hosts.

## Browser collection

```bash
bun install --frozen-lockfile
bun run src/cli.ts setup
bun run src/cli.ts browser register /path/to/source-manifest.json
bun run src/cli.ts auth setup <source-id>
```

Run `auth setup` for sources with an approved login and a visible account marker. Hosts can call `social_extract_sources`, `social_extract_start` and `social_workflows_status` to collect data and query it by reference. [Headless setup and recovery](docs/headless-architecture.md) · [Extraction contract](docs/extraction-runtime.md) · [Provider readiness](docs/provider-capabilities.md)

## Legacy provider API backend

- The 22 original stdio tools grew to 24 with the LinkedIn reader and 28 with extraction and datasets. Existing OAuth accounts, the OS-keyring vault, terminal approvals, intent journaling, reconciliation and scheduling continue to support the provider API backend.
- Providers: OAuth **login is built and tested for all seven** (Threads, TikTok, X, LinkedIn, Instagram, Facebook, Reddit) against the official endpoints; see [docs/login.md](docs/login.md) and run `bun run src/cli.ts providers`. Publishing and reading stay **UNVERIFIED** for every provider until a real approved post and read-back pass. No real login or post has been made yet because that needs your developer apps. Signed Stage-0 evidence is in `docs/providers/`; Threads is the first slice (ADR-028).
- XN-Bridge: `xn-interact` and `xn-bridge` are registered in every host config on this machine; 20 `social.*` capabilities resolve to `xn-interact`; a `social` domain, social routing and one dynamic router exist.
- Operations: the `xn-interact-worker` systemd user service runs scheduled and pending workflows ([operations guide](docs/operations.md)).
- Tests and live acceptance procedure are in the [headless verification guide](docs/testing/headless-acceptance.md).

## OAuth operator commands

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
