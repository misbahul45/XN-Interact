# Bun.secrets on the target Ubuntu (P0-06)

Date: 2026-11-19. Bun 1.4.0, Linux 6.8 (Ubuntu). Reproduce with `bun spikes/secrets/probe.ts`; the probe writes one entry under service `xn-interact-probe` and deletes it.

| Session | Environment | set / get / delete | Result |
|---|---|---|---|
| Desktop | `DBUS_SESSION_BUS_ADDRESS` and `DISPLAY` set | ok / ok / ok | works, 28 ms |
| No session-bus variables | bus address and display unset, `XDG_RUNTIME_DIR` kept | ok / ok / ok | works: libsecret finds the bus through `$XDG_RUNTIME_DIR/bus` |
| No bus at all (SSH-like) | bus address, display and `XDG_RUNTIME_DIR` unset | throws `Cannot autolaunch D-Bus without X11 $DISPLAY` | fails loudly, never silently |

Not yet measured: a locked keyring (prompt for the login password) and a systemd user service. P10-03 completes the matrix.

## Decision for the vault (P2-03, P2-04)

1. Master key stored with `Bun.secrets` under service `xn-interact`, name `vault-master-v<n>`.
2. Any `Bun.secrets` error makes the vault `LOCKED`: sensitive tools return `VAULT_LOCKED`; reads of non-secret local state keep working.
3. No passphrase fallback in release 1: hosts spawn the stdio server without a terminal, so it cannot prompt, and passing a passphrase through host configuration would expose it. A locked vault is the fallback (fail closed). The CLI can be extended with a passphrase mode later for terminal-only use.
4. Tests run with `XN_INTERACT_KEYRING=memory`, an in-process store that is refused when `NODE_ENV`/`XN_INTERACT_ENV` is not `test`.

## Final matrix (P10-03, 2026-11-20)

Measured with `bun run src/cli.ts vault status` against the real OS keyring (service `xn-interact`), Bun 1.4.0, Ubuntu desktop.

| Session | Result | State |
|---|---|---|
| Desktop session | key v1 read | `unlocked` |
| Session-bus variables unset, `XDG_RUNTIME_DIR` kept | key v1 read through `$XDG_RUNTIME_DIR/bus` | `unlocked` |
| No bus at all (SSH-like: bus, display and runtime dir unset) | `Cannot autolaunch D-Bus without X11 $DISPLAY` | `locked`, command exits 1, sensitive tools return `VAULT_LOCKED` |
| systemd user service (`xn-interact-worker`) | journal: `vault unlocked` | `unlocked` |
| Working keyring, no key yet (fresh service name) | `no vault key in the keyring` | `uninitialized` |

Every failure path ends in a state that refuses sensitive operations; none falls back to plaintext. A vault initialized after the server started is picked up on the next tool call (`reopenIfDue`, tested in `tests/unit/vault.test.ts`).

Not measurable here: a keyring that is locked and waits for the login password (needs an interactive prompt). Any error from `Bun.secrets` is treated as `locked`, so the expected behaviour is the same fail-closed state, but it was not observed.
