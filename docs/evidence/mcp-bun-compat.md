# Bun + MCP SDK v2 stdio compatibility (P0-04)

Date: 2026-11-19. Reproduce with `bun spikes/mcp-stdio/probe.ts`.

## Pinned versions

| Package | Version | Note |
|---|---|---|
| bun | 1.4.0 | local runtime |
| @modelcontextprotocol/server | 2.4.0 | published 2026-10-23, latest dist-tag |
| @modelcontextprotocol/client | 2.4.0 | dev dependency, test client only |
| zod | 4.6.7 | imported as `zod/v4` |

## Results

| Check | Result |
|---|---|
| `McpServer` + `StdioServerTransport` start under Bun without Node-only workarounds | pass |
| SDK client initialize, `tools/list`, `tools/call` over stdio | pass |
| 1,000 successive `tools/call` round trips | 1,000/1,000 correct, 792 ms |
| Invalid arguments | returned as `isError: true`, handler not run |
| Raw stdout during initialize + call | 3 lines, all JSON-RPC 2.0; logs went to stderr |
| Negotiated protocol revision (raw initialize requesting `2025-11-25`) | `2025-11-25` |
| Raw initialize requesting `2026-07-28` | server answered `2025-11-25` |
| Server capabilities advertised | `tools.listChanged: true` |
| Dotted tool name `social.spike.dotted` | accepted by the SDK server and listed unchanged |

## Conclusions

- SC-09 resolved: SDK v2 stdio works under Bun.
- SC-08 partially resolved: over stdio initialize, SDK 2.4.0 negotiates `2025-11-25` (`LATEST_PROTOCOL_VERSION`; supported list `2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07`). The baseline's "2026-07-28 native support" is not what a stdio initialize negotiates. XN-Interact must not depend on 2026-only semantics (stateless sessions, `Mcp-Session-Id` changes) over stdio. Tasks and elicitation stay feature-detected (P7-09).
- The SDK accepts dotted names; whether hosts accept them is P0-05. snake_case stays the default (ADR-019).
