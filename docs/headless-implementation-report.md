# XN-Interact V2 implementation report

## Delivered architecture

The baseline combined the provider OAuth gateway, a launcher-dependent LinkedIn CDP reader, Bun stdio and the XN-Bridge dynamic router. The new browser dataset path uses a dedicated Chrome profile, a Linux singleton broker, typed SQLite jobs and Playwright. One authorized browser context is active at a time. Public sources use a distinct profile. An MCP process can start the daemon and Chrome without a visible window or extension. The operator handles initial login and renewal in Chrome.

The existing provider OAuth adapters, vault, account history, plan hashes, owner terminal approvals, standing grants, intent journal, provider reconciliation and scheduled worker still govern provider API actions. The new browser data operations use the same database, risk model, MCP transport and workflow status and cancellation interfaces. Collection records and checkpoint state have separate tables. [Repository audit](headless-migration-audit.md) · [ADR-031](adr/ADR-031-headless-browser.md)

## Implementation inventory

| Area | Change |
| --- | --- |
| Runtime | `src/browser/{daemon,ipc,runtime}.ts` implement the shared socket, locks, leases, context lifecycle, source restrictions and interactive authentication. |
| Extraction | `src/extraction/{contracts,browser-adapter,engine,store}.ts` implement owner-registered scopes, schema validation, pagination, scroll, enrichment, durable checkpoints, provenance, cancellation and incremental comparisons. |
| Datasets | `src/extraction/{datasets,ingest,zip}.ts` implement local querying, exports and owner-authorized ingestion of structured account-export files. |
| Storage | Migrations `0007` to `0009` add registration, checkpoint, coverage and deadline data. `src/storage/migrations.ts` serializes concurrent upgrades and preserves consistent checksummed snapshots for existing databases. |
| Public contracts | Added `social_extract_start`, `social_extract_sources`, `social_datasets_query` and `social_datasets_export`. Workflow status and cancellation accept extraction run references. The registry has 28 tools. |
| Operator CLI | Added browser source registration and revocation, interactive authentication, broker controls, extraction resume, dataset import registration, ingestion and deletion. |
| XN-Bridge | Added the `data` domain, intent and risk mappings and headless runtime metadata. The existing LinkedIn capabilities and career integration keep their names. |
| Hosts | The registration plan found all 11 existing client entries. The `xn-interact` stdio identity and existing configuration were retained. |
| Packages | Existing pins remain in use, including Playwright Core 1.65.1. |
| Deployment | Added an opt-in `deploy/xn-interact-broker.service`. The existing scheduler continues serving the provider API backend. |

## Reproducible evidence

| Check | Evidence |
| --- | --- |
| Installed runtime | Bun 1.4.0, Playwright Core 1.65.1, Google Chrome 157.0.8103.38 on Linux 6.8. A standalone sandboxed headless launch took 1,007 ms. |
| Enumeration | The fixture collected exactly 1,000 unique records from 1,009 observations across 10 pages. The declared denominator was 1,000. A separate fixture with uncertain termination kept its denominator and coverage ratio unknown. |
| Multi-host | Two independently connected MCP clients requested the same idempotent ID and observed one broker and one run. Each paginated URL was visited once during the initial run. |
| Persistence | The same synthetic session survived a native Chrome restart and a broker restart. Xvfb verified the transition from headed Chrome to headless Chrome. |
| Interruption | A run stopped with two committed pages and resumed from page three. Cancellation preserved committed data. A temporary systemd user service replaced the broker after SIGKILL. |
| Security | Fixtures tested closed scope, changed identity, expired session, challenge detection, credential-shaped values, ZIP traversal, opaque local output and owner-only socket and exports. Static guards checked prohibited browser API calls. |
| XN-Bridge | Real fixture MCP discovery, dynamic routing, headless collection and coverage evidence all ran through their normal stdio interfaces. Existing fixture writes still required approvals and reconciled a crash without duplicating a submission. |
| Registry | The full 28-tool registry measured 6,226 tokens and 22,821 bytes using the pinned tokenizer. The retained 24-tool subset measured 4,606 tokens. |
| Fixture resources | The final cold collection took 3,663 ms for 1,000 records. The broker resident set measured 142,200 KiB at completion. The Xvfb variant took 3,278 ms for the same collection after headed fixture setup. Browser process memory was outside these measurements. |
| Test suites | XN-Interact passed 235 tests with one opt-in systemd test skipped by default. The systemd test passed when run explicitly. XN-Bridge passed 496 tests with six live-host/provider checks skipped. Its affected routing and policy suites passed again after the final metadata changes. Type checking, contract plan validation and unit verification passed. |

Use the [acceptance commands](testing/headless-acceptance.md) to reproduce these checks. The measured fixture workload does not establish public-platform throughput, CPU or browser peak memory. [Provider readiness](provider-capabilities.md)

## Operational state and remaining gates

Browser support is verified on synthetic registered websites and local structured uploads. The seven social providers have no live headless evidence. LinkedIn jobs and feed retain a permission-gated legacy reader. The browser backend has no social write adapters. Each live rollout requires platform permission, a verified adapter and an owner-authenticated acceptance run. Generic sites with unsupported UI, authenticated third-party downloads or strict egress requirements need a dedicated integration or an official export.

Early integration discovery used the configured local server and applied additive migration `0007` to its database. The integration harness now probes an isolated test database. Runtime startup also applied `0008` locally. Both recorded checksums match the shipped migration files. SQLite `quick_check` returned `ok` and the pre-`0008` snapshot passed integrity and checksum verification. The deadline change uses a new migration, `0009`, verified against fixtures and pending at the last local database inspection. Existing OAuth records remain in the database. Live profile binding is still pending. [Rollback and profile operations](headless-architecture.md)
