# Headless migration audit

Both worktrees already contained local changes. XN-Interact was on `feat/web-reader` and XN-Bridge was on `master`. The LinkedIn reader and its fixtures were untracked. The requested abbreviated path did not exist. Work uses the two existing repositories.

| Component | Baseline and migration decision |
| --- | --- |
| Runtime and transport | `src/main.ts` initializes Bun, the official MCP SDK and stdio. The live catalog defines 24 tools, including the two LinkedIn reader tools added to the original 22. Extend that catalog and preserve the existing server identity. |
| Authentication | `App` composes provider manifests, OAuth callback, app credentials, account registry, vault and token manager. Keep OAuth history and its explicit execution path. Browser operations use a separate Chrome-managed profile and source-specific identity metadata. |
| Browser | `src/reader/service.ts` shares SQLite audit counters with CLI and MCP but its busy flag is process-local. `web-reader.ts` attaches by CDP, creates a page, brings it forward and parses ARIA including child frames. The existing parser stays with the legacy reader. Normal headless collection uses a singleton persistent context without CDP or extension attachment. |
| Execution | Existing plan hashes, approvals, grants, leases and intent journal protect OAuth actions. Browser collection is a local-write operation with restartable source checkpoints. It reuses SQLite and the existing MCP workflow status and cancellation contracts. Browser writes require a verified provider adapter and a separate integration with the existing approval and intent boundary. |
| Storage | Six migrations cover OAuth, app and account metadata, approvals, workflows, grants and evidence. Add browser source registrations, collection runs, checkpoints and dataset records. Keep profiles out of database backups. |
| Scheduling | The existing systemd worker advances OAuth workflows. Use a separate optional user service for the browser broker and on-demand startup from stdio. |
| Routing | XN-Bridge discovers provider tools, resolves capability IDs dynamically and only coordinates calls. Preserve the existing LinkedIn and xn-career capability names. Register extraction and dataset capabilities through the same router. |
| Acceptance | LinkedIn parser fixtures and an earlier local CDP check do not establish live LinkedIn readiness. Live authentication and platform operation permission are independent gates. |

Dependency flow is MCP stdio → canonical gateway → collection request and local source policy → SQLite run → local broker → Playwright Core → installed Chrome → same-scope adapter → checkpoint and dataset → MCP result reference. XN-Bridge resolves the tool and receives summaries and evidence references.

The existing `deploy/xn-interact-worker.service`, OAuth provider adapters, standing grants, journal, result store and host installer remain in scope for regression testing. Deployment cutover requires provider policy review and owner-authenticated acceptance. The installed runtime reported Bun 1.4.0, Chrome 157.0.8103.38 and Linux 6.8. The lockfile pins Playwright Core 1.65.1.
