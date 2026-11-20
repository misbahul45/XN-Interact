# Host smoke test (P1-10)

Date: 2026-11-19. Server: `bun run src/main.ts` (production configuration, OS keyring, empty home).

| Host | Registration used | Result |
|---|---|---|
| Codex CLI 0.169.0 | Per-invocation `-c mcp_servers.xn-interact.*` overrides on `codex app-server`, every configured server disabled, nothing persisted (`PROBE_SERVER=xn-interact PROBE_ENTRY=src/main.ts bun spikes/host-names/codex-probe.ts`) | `connected`, no `toolsError`, 22 tools listed with catalog names unchanged |
| Claude Code 2.1.328 | Project-scope `.mcp.json` in this repository | Listed as `xn-interact`, status `Pending approval (run claude to approve)`. Claude Code requires the owner to approve a project server interactively; not done by the agent |

Remaining owner step: open `claude` in `~/code/XN-Interact`, approve the `xn-interact` project server, then run `/mcp` to confirm 22 tools. After that P1-10 can be verified.
