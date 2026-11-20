# Host tool-name constraints (P0-05)

Date: 2026-11-19. Spike server: `spikes/mcp-stdio/server.ts` registers `social_spike_echo` and `social.spike.dotted`.

| Layer | Observation | Source |
|---|---|---|
| MCP SDK 2.4.0 server | Registers and lists both names unchanged | `bun spikes/mcp-stdio/probe.ts` |
| Codex CLI 0.169.0 app-server inventory (`mcpServerStatus/list`) | Server `connected`, no `toolsError`, lists both names unchanged | `bun spikes/host-names/codex-probe.ts` (per-invocation `-c` overrides, every configured server disabled, nothing persisted) |
| Claude (Messages API, used by Claude Code 2.1.328) | Tool `name` must match `^[a-zA-Z0-9_-]{1,128}$`; a dot is not allowed | platform.claude.com/docs/en/api/messages, Tool object, fetched 2026-11-19 |

Not observed: how Codex maps an inventory name to the model-facing function name, and whether Claude Code rewrites a dotted MCP tool name or drops it. Neither matters for snake_case names, which satisfy every constraint above. Claude Code listing of the real server is part of P1-10.

Decision: ADR-019 accepted. Wire names are snake_case and at most 64 characters (`^[a-z][a-z0-9_]{0,63}$`); with the `mcp__xn-interact__` prefix the longest name (`social_engagement_execute`) is 43 characters, inside the 128 limit.
