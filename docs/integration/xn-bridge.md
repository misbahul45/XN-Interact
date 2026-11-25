# XN-Bridge and headless datasets

Keep the `xn-interact` stdio registration and share the same `XN_INTERACT_HOME` across hosts. The existing installation plan covers Claude Code, Codex, Gemini CLI, Qwen Code, Cursor, Kiro, Pi, Copilot CLI, VS Code, Zed and OpenCode. Hosts discover the same tool registry. Reconnect existing MCP processes after upgrading code. Re-discover and review the updated tool schemas in XN-Bridge.

The router resolves `data.source.read` to source discovery and `data.collect` to `social_extract_start`. It includes static runtime metadata for the on-demand headless Playwright backend. Call source discovery for actual readiness. Use the returned run ID to poll, and pass the dataset reference and coverage summary to the XN-Bridge evidence tool. Query or export through `data.dataset.query` and `data.dataset.export`. Source registration and browser identity validation are enforced inside XN-Interact.

`career.linkedin_jobs`, `career.feed_leads`, `social.linkedin.read` and existing OAuth workflow names remain registered. No host needs an unrestricted browser surface to call the extraction backend. [Host registration](host-registration.md) · [Acceptance](../testing/headless-acceptance.md)
