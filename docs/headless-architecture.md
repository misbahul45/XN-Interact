# Headless Chrome operations

XN-Interact accepts source IDs and typed dataset requests over MCP stdio. SQLite stores runs and checkpoints. An owner-only Unix socket wakes a shared daemon that serializes Playwright operations. Linux `flock` coordinates concurrent daemon starts and interactive authentication. Existing OAuth approvals, intents and workflow history remain in SQLite. Browser collection has no external write executor.

Chrome uses the dedicated `browser/profile` directory under `XN_INTERACT_HOME` or the default repository `data/` directory. Public collection uses an isolated `browser/public-profile`. One daemon owns both and opens only the required context. The normal mode uses sandboxed headless Chrome with no extension. The default browser idle timeout is 120 seconds. Set `XN_INTERACT_BROWSER_IDLE_MS` to change the warm interval. Set `XN_INTERACT_BROWSER_CONTINUOUS=1` for a persistent daemon with a still-lazy browser.

## Setup and session renewal

Run `bun run src/cli.ts browser register <manifest>` in your terminal. Protected sources require an exact visible public `account_marker` and an approved same-origin `login_url`. Run `bun run src/cli.ts auth setup <source-id>`. Sign in directly in Chrome and complete any verification there. Press Enter in the terminal so the CLI can check the visible identity, close the window and verify the same profile headlessly. Run `auth reauthenticate <source-id>` after expiration. [Source manifest](extraction-runtime.md)

Run `browser sources`, `browser status`, `auth status` or `doctor` to inspect readiness. `browser revoke <source-id>` invalidates runs and dataset access bound to the old registration. Chrome remains in charge of website login. Re-registering the same source creates a new authorization generation.

## Broker lifecycle

```bash
bun run src/cli.ts broker status
bun run src/cli.ts broker stop
bun run src/cli.ts broker start
bun run src/cli.ts broker restart
```

A valid collection request starts the broker automatically. Poll an interrupted queued or running job to wake the broker. After a recoverable session or browser failure, resolve the issue and use `extract resume <run-id>`. Completed pages survive restart. Scroll and load-more branches replay authorized UI steps and confirm their checkpoint fingerprint. The laptop and local worker must be awake to continue.

The optional [systemd user unit](../deploy/xn-interact-broker.service) uses the default Bun and repository paths. Install it in the user unit directory if you want a continuously available broker, then run `systemctl --user daemon-reload` and `systemctl --user start xn-interact-broker`. Operate it with `systemctl --user status xn-interact-broker`, `journalctl --user -u xn-interact-broker` and `systemctl --user stop xn-interact-broker`. Stop any on-demand daemon before starting the unit and stop the unit before interactive login.

## Rollback

Additive migrations `0007_browser_datasets`, `0008_dataset_coverage` and `0009_dataset_deadline` preserve the existing vault, account and workflow tables. A private, checksummed SQLite snapshot is created before upgrading an existing database. The application backup includes stored datasets and excludes Chrome profile files and standalone exports.

Stop the broker and return to the earlier program version to roll back execution. The extra tables can remain. For a database rollback, stop all MCP and worker processes, verify a pre-upgrade snapshot, preserve the current database separately and restore the snapshot. An older operator backup is preferable to any snapshot lacking a checksum sidecar. Follow the existing database restore procedure. [Operations](operations.md) · [ADR-031](adr/ADR-031-headless-browser.md)
