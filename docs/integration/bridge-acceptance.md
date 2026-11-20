# XN-Bridge discovery and contract acceptance (PB-06)

Date: 2026-11-19, live bridge home `~/code/XN-Bridge/data`.

1. `xnbridge discover --host claude --only xn-interact` → `xn-interact` OK, protocol `2025-11-25`, version `0.1.0`, 22 tools, 12,415 schema bytes, delta new=22.
2. `xnbridge catalog changed --server xn-interact` → 0 contracts to review: new contracts are accepted as observed; only changed contracts are quarantined.
3. Project-scope providers whose catalog had expired since 2026-11-17 were refreshed with the same audit-only discovery: `osm` (6 tools), `careers-crawl` (2), `gmaps` (1), `gmail-send` (2). Discovery runs initialize and tools/list only; no business tool was called.
4. Resolution through the same host fingerprint the MCP `capability_resolve` tool uses:

| Capability | Status | Selected provider |
|---|---|---|
| all 20 `social.*` | AVAILABLE | `xn-interact:social_*` (one per capability) |
| `places.search` | AVAILABLE | `osm:openstreetmap_query_bbox` |
| `web.crawl` | AVAILABLE | `careers-crawl:crawl_site` |
| `email.send` | AVAILABLE | `gmail-send:gmail_send` |

The other 19 user-scope servers stay `STALE` from the 2026-11-17 discovery; run `xnbridge discover --host claude` to refresh them.

## Bugs found and fixed in XN-Bridge on the way

- For the Claude host, `capability_resolve` computed the host fingerprint without the project `.mcp.json` while `discover` included it, so every project-scope provider (osm, careers-crawl, gmaps, gmail-send, xn-interact) resolved as `HOST_CONFIG_CHANGED`. `hosts.load_host_servers("claude")` now defaults to the bridge repo's `.mcp.json` for both paths.
- The Python MCP SDK parses a JSON-looking string argument into an object, so `evidence_register(content=<JSON text>)` was rejected. `content` now accepts an object or list and stores it as canonical JSON.
- `route_intent` provider lookups now use the same host fingerprint as `capability_resolve`, so both answer the same.
