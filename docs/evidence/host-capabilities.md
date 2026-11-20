# Host capability detection (P7-09)

Date: 2026-11-20. The server records the client identity and capabilities negotiated at `initialize` into the audit log (`mcp.initialize`) and shows them under `social_system_health` → `components.host`.

| Host | Client identity (as sent) | Capabilities negotiated | How measured |
|---|---|---|---|
| Claude Code | `claude-code` 2.1.328 | `elicitation`, `roots` | Headless `claude -p` session with only this server (`--strict-mcp-config`), temporary home |
| Codex CLI | `codex-mcp-client` 0.169.0 | `elicitation`, `experimental` (`codex/auth-change`) | `codex app-server` probe with per-invocation overrides, temporary home (`spikes/host-names/codex-probe.ts`) |
| SDK test client | `contract-test` | none | `tests/contract/stdio.test.ts` |

Neither real host advertises `tasks` or `sampling`.

## Decisions

1. **Status polling stays the only mechanism for long work.** Tasks are not negotiated by either host, so `social_workflows_status` (with `since_version`) is the contract (CORE-07).
2. **Elicitation is not used for approval.** Both hosts advertise it, but a capability flag does not prove a human answers it: an agent-controlled host can auto-accept. Approval stays on the terminal path (`xn-interact approve`), which refuses a non-TTY. Elicitation may later be used only for non-authoritative nudges.
3. Detection is passive and never gates behaviour on a capability flag; it is recorded so a changed host is visible in the audit log.

## Limits

Capability flags are what each client declares, not proof of how it behaves. The identity strings are self-reported.
