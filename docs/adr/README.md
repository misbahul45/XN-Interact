# Architecture decision records

ADR-001 to ADR-018 come from the baseline specification (section 2) and stand as written. ADR-019 onward record the resolutions in [consistency-review.md](../plan/consistency-review.md). Status changes go through task P0-17.

| ADR | Decision | Status | Source |
|---|---|---|---|
| 001 | Bun + TypeScript runtime | Accepted | baseline |
| 002 | Official `@modelcontextprotocol/server` v2, pinned | Accepted | baseline |
| 003 | Modular monolith, one process | Accepted | baseline |
| 004 | stdio by default; stdout carries protocol frames only | Accepted | baseline |
| 005 | SQLite via `bun:sqlite`, WAL, one write coordinator | Accepted | baseline |
| 006 | `Bun.secrets` for the master key; fail closed or explicit passphrase, never plaintext | Accepted | baseline |
| 007 | Native `fetch` provider clients with allowlist and timeouts | Accepted | baseline |
| 008 | Zod at every input boundary | Accepted | baseline |
| 009 | 22 core tools as a benchmark hypothesis | Accepted, revisit in P9-05 | baseline |
| 010 | Static tools plus lazy capability resources | Accepted | baseline |
| 011 | Declarative skills, deterministic routing, no internal LLM | Accepted | baseline |
| 012 | Durable workflow state machine with journal before side effects | Accepted | baseline |
| 013 | Approval through a channel separate from tool arguments | Accepted | baseline |
| 014 | OAuth code + PKCE where supported | Accepted | baseline |
| 015 | Streamable HTTP stays disabled in release 1 ([ADR-015](ADR-015-http.md)) | Accepted | baseline |
| 016 | No browser execution fallback | Accepted | baseline |
| 017 | Scheduler promises only while a process is alive | Accepted | baseline |
| 018 | Client-independent benchmark first | Accepted | baseline |
| 019 | snake_case wire tool names; dotted names kept as `spec_name` | Accepted (P0-05 evidence) | CR-01 |
| 020 | Risk classes aligned with XN-Bridge (`READ`, `LOCAL_WRITE`, `EXTERNAL_WRITE`) plus side-effect class | Accepted | CR-06 |
| 021 | Two-phase plan → execute for every external write | Accepted | CR-07 |
| 022 | Provider writes only inside approved, journaled workflows; media upload and drafts are local in release 1 | Accepted | CR-09, CR-10 |
| 023 | Write-safety kernel (plan builder, approvals, intent journal) before the first real write | Accepted | CR-08 |
| 024 | SQLite leases for multi-process safety | Accepted | CR-11 |
| 025 | Host-mediated XN-Bridge integration; XN-Interact authoritative for social approvals; dual gate in release 1 | Accepted | CR-18, CR-19 |
| 026 | `plan/catalog.json` is the single source of the contract; implementation tested against it | Accepted | CR-15 |
| 027 | Canonical enums: lower-case states, upper-case error codes, operation-neutral target outcomes | Accepted | CR-02 |
| 028 | First vertical-slice provider: Threads, TikTok as the fallback ([ADR-028](ADR-028-first-provider.md)) | Accepted | P0-15 |
| 029 | Approval federation ([design](ADR-029-approval-federation.md)) | Proposed: one CLI screen signing both keys | INT-10 |
| 030 | One dynamic XN-Bridge router: declarative intents, capability index, live providers in every decision | Accepted | CR-29 |
| 031 | [Shared headless Chrome broker](ADR-031-headless-browser.md) | Accepted for registered sites | Browser collection |
