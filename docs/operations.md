# Operations

Everything here runs from `~/code/XN-Interact`. State lives in `XN_INTERACT_HOME` (default `data/`, mode 0700, ignored by git).

## Daily

| Task | Command |
|---|---|
| Readiness (vault, database, workflows, providers, host) | `bun run src/cli.ts doctor` |
| Pending approvals | `bun run src/cli.ts approvals` |
| Approve or reject a plan (needs a real terminal) | `bun run src/cli.ts approve <id>` / `reject <id>` |
| Budgets | `bun run src/cli.ts budget show` / `budget set <account> <operation\|*> --max-calls N --max-cost X` |
| Scrubbed audit log | `bun run src/cli.ts audit export` |

## Worker

`xn-interact-worker.service` (systemd user unit, installed from `deploy/`) runs due scheduled and pending workflows while no MCP session is open. Scheduled posts run only while this worker or an MCP server process is alive.

```bash
systemctl --user status xn-interact-worker
journalctl --user -u xn-interact-worker -n 20
systemctl --user disable --now xn-interact-worker && rm ~/.config/systemd/user/xn-interact-worker.service   # rollback
```

## Vault

The master key lives in the OS keyring (service `xn-interact`). `vault status` shows `unlocked`, `uninitialized` or `locked`; `locked` means the keyring was unreachable (for example an SSH session without a session bus) and sensitive tools return `VAULT_LOCKED`. Nothing falls back to plaintext. `vault rotate` adds a new key version; older ciphertext stays readable.

## Retention

`retention run` (also hourly inside a running server or worker) deletes: audit events older than 180 days, expired results, media, capability snapshots, leases and OAuth attempts, finished runs older than 90 days, and decided approvals and unused plans older than 30 days. It never deletes accounts, grants, pending approvals, runs that are not finished, or any run with a pending or `unknown_outcome` write. Flags: `--audit-days`, `--run-days`, `--plan-days`.

Deleting an old run also forgets its `operation_id`, so an identical id reused after 90 days is treated as new work.

## Backup and restore

```bash
bun run src/cli.ts backup ~/backups/xn-interact-$(date +%F).sqlite   # consistent copy, mode 0600, .sha256 next to it
bun run src/cli.ts backup verify ~/backups/xn-interact-2026-11-20.sqlite
```

The backup refuses to overwrite. Token and cache columns stay encrypted and the vault key is not part of the file, so the backup is useless without the keyring entry; keep that in mind before restoring on another machine (grants would need reconnecting).

Restore: stop the server and the worker, run `backup verify`, move the current `xn-interact.sqlite*` aside, copy the backup to `xn-interact.sqlite`, start again, run `doctor`.
