# Headless acceptance

Run from the XN-Interact checkout on Linux with installed Google Chrome, Bun and the locked dependencies.

```bash
bun run typecheck
bun run plan:check
bun test
xvfb-run -a env XN_INTERACT_FIXTURE_HEADED=1 bun test tests/integration/browser-extraction.test.ts
systemd-analyze --user verify deploy/xn-interact-broker.service
env XN_INTERACT_SYSTEMD_TEST=1 bun test tests/integration/browser-systemd.test.ts
```

The extraction fixture uses a dedicated temporary profile and synthetic session. Two stdio hosts request the same idempotent run. Playwright enumerates 10 pages containing 1,009 observations and asserts 1,000 unique rows. It verifies idle shutdown, native restart persistence, checkpoint recovery, cancellation, account mismatch, provider restriction, unknown coverage, detail enrichment, load-more, virtualization, incremental changes and local exports. The Xvfb variant initializes the session in headed Chrome before the same headless checks. The optional systemd test uses a temporary service and verifies broker process replacement after SIGKILL. Bridge integration discovers the fixture server and records observed coverage through both MCP servers.

For live acceptance, choose a documented permitted operation, register the source in your terminal, and use `auth setup` to sign in yourself. Stop the broker gracefully and run the operation from one fresh host, then a different host. Confirm the broker starts automatically, Chrome stays headless, identity matches and the result includes observed coverage. Record source and operation, evidence ID, timestamps and verification level without including authenticated URLs or credential material. Each platform needs its own evidence. [Readiness matrix](../provider-capabilities.md)
