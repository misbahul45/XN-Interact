# Host registration and XN-Bridge activation

Date: 2026-11-19. Owner instruction in chat: "kamu aktifin langsung di xn bridge juga".

## What is registered

| Where | Entry | Effect |
|---|---|---|
| `~/code/XN-Interact/.mcp.json` | `xn-interact` (project scope) | Claude Code in this repo lists the server; it shows **Pending approval** until the owner approves it in `claude` |
| `~/code/XN-Bridge/.mcp.json` | `xn-interact` → `bun run ~/code/XN-Interact/src/main.ts`, `XN_INTERACT_HOME=~/code/XN-Interact/data` | Claude Code in the XN-Bridge workspace gets the 22 tools (after the owner approves the project server); XN-Bridge discovery sees the server |
| `~/code/XN-Bridge/.claude/skills/xn-social`, `~/code/XN-Bridge/.agents/skills/xn-social` | symlinks to `~/code/XN-Interact/host-skills/xn-social` | Claude Code and Codex in the XN-Bridge workspace load the `xn-social` host skill |

Not changed: `~/.claude.json` (user scope), `~/.codex/config.toml`, `~/.claude/CLAUDE.md`, Xninetzy. Registering at user scope is task PB-16 and needs a separate owner approval.

## Backups

Originals of every XN-Bridge file touched are in `~/code/XN-Interact/.cache/xn-bridge-backup/20261119T140210Z/` (`.mcp.json`, `AGENTS.md`, `defaults/capabilities.toml`, `defaults/policy.toml`, `routing.py`, `domains/__init__.py`, `hosts.py`, `server.py` snapshots).

## Rollback

Files that were clean in XN-Bridge git before this work: `src/xnbridge/routing.py`, `src/xnbridge/server.py`, `src/xnbridge/spec.py`, `src/xnbridge/domains/__init__.py`, `docs/capability-routing.md` — restore with `git -C ~/code/XN-Bridge checkout -- <file>`.

Files that already carried the owner's uncommitted edits: `.mcp.json`, `AGENTS.md`, `docs/mcp-integrations.md`, `src/xnbridge/defaults/capabilities.toml`, `src/xnbridge/defaults/policy.toml`, `src/xnbridge/hosts.py` — copy back from `~/code/XN-Interact/.cache/xn-bridge-backup/20261119T140210Z/` (`docs/mcp-integrations.md` only gained an appended `xn-interact` section; delete that section instead).

Then:
1. Delete `src/xnbridge/domains/social.py`, `src/xnbridge/capindex.py`, `src/xnbridge/defaults/intents.toml`, `tests/unit/test_social.py`, `tests/unit/test_dynamic_routing.py`.
2. `rm ~/code/XN-Bridge/.claude/skills/xn-social ~/code/XN-Bridge/.agents/skills/xn-social`
3. In XN-Interact: `claude mcp remove xn-interact -s project` or delete `.mcp.json`.
4. Run `xnbridge discover --host claude` so the catalog drops `xn-interact`.

## User scope in every host (PB-16, 2026-11-19)

Owner instruction in chat: "kamu lakukan langsung gpp" and "pastikan semua mcp di sistemku sudah mengenali xn bridge dan semua sistemku". `bun scripts/register-hosts.ts plan|apply` adds only missing entries in each host's own format and never overwrites one.

| Host | Config | Added |
|---|---|---|
| Claude Code (user scope) | `~/.claude.json` via `claude mcp add --scope user` | xn-interact |
| Codex | `~/.codex/config.toml` (appended tables) | xn-interact |
| Gemini CLI | `~/.gemini/settings.json` | xn-interact |
| Qwen Code | `~/.qwen/settings.json` | xn-bridge, xn-interact |
| Kiro | `~/.kiro/settings/mcp.json` | xn-interact |
| Cursor | `~/.cursor/mcp.json` | xn-interact |
| Pi | `~/.pi/agent/mcp.json` | xn-bridge, xn-interact |
| Copilot CLI | `~/.copilot/mcp-config.json` | xn-bridge, xn-interact |
| VS Code | `~/.config/Code/User/mcp.json` | xn-interact |
| Zed | `~/.config/zed/settings.json` | xn-interact |
| OpenCode | `~/.config/opencode/opencode.json` | xn-bridge, xn-interact |

Skills: `xn-social` linked in `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills` next to the existing `xn-bridge` and `xn-career` links.

Verified: `claude mcp get xn-interact` from `~` shows User config, Connected; `codex mcp list` shows xn-interact enabled; this Claude Code session lists all 22 `mcp__xn-interact__*` tools. XN-Bridge discovery over every host config: 27 servers, 24 OK, 3 remote HTTP servers (canva, context7, github) not probed without authentication.

Backups of every host file before the change: `~/code/XN-Interact/.cache/host-config-backup/2026-11-19T14-51-30-898Z/`. Rollback: copy each file back from that folder (for Claude Code prefer `claude mcp remove --scope user xn-interact`), then remove the three `xn-social` links.
