import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const HOME = process.env.HOME!;
const ROOT = resolve(import.meta.dir, "..");
const BUN = process.execPath;

interface Base {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export const SERVERS: Record<string, Base> = {
  "xn-bridge": { command: `${HOME}/code/XN-Bridge/.venv/bin/python`, args: ["-m", "xnbridge.server"], env: { XN_BRIDGE_HOME: `${HOME}/code/XN-Bridge/data` } },
  "xn-interact": { command: BUN, args: ["run", `${ROOT}/src/main.ts`], env: { XN_INTERACT_HOME: `${ROOT}/data` } },
};

type Shape = (b: Base) => Record<string, unknown>;
const plain: Shape = (b) => ({ command: b.command, args: b.args, env: b.env });
const stdio: Shape = (b) => ({ type: "stdio", command: b.command, args: b.args, env: b.env });

export const JSON_HOSTS: Record<string, { rel: string; key: string; shape: Shape }> = {
  gemini: { rel: ".gemini/settings.json", key: "mcpServers", shape: plain },
  qwen: { rel: ".qwen/settings.json", key: "mcpServers", shape: (b) => ({ command: b.command, args: b.args, timeout: 120000, type: "stdio", env: b.env }) },
  kiro: { rel: ".kiro/settings/mcp.json", key: "mcpServers", shape: plain },
  cursor: { rel: ".cursor/mcp.json", key: "mcpServers", shape: plain },
  pi: { rel: ".pi/agent/mcp.json", key: "mcpServers", shape: stdio },
  copilot: { rel: ".copilot/mcp-config.json", key: "mcpServers", shape: (b) => ({ type: "local", command: b.command, args: b.args, env: b.env, tools: ["*"] }) },
  vscode: { rel: ".config/Code/User/mcp.json", key: "servers", shape: stdio },
  zed: { rel: ".config/zed/settings.json", key: "context_servers", shape: plain },
  opencode: { rel: ".config/opencode/opencode.json", key: "mcp", shape: (b) => ({ enabled: true, type: "local", command: [b.command, ...b.args], environment: b.env }) },
};

function codexBlock(name: string, b: Base): string {
  const q = (s: string) => JSON.stringify(s);
  const env = Object.entries(b.env).map(([k, v]) => `${k} = ${q(v)}`).join("\n");
  return `\n[mcp_servers.${name}]\ncommand = ${q(b.command)}\nargs = [${b.args.map(q).join(", ")}]\n\n[mcp_servers.${name}.env]\n${env}\n`;
}

function backup(stamp: string, file: string): string {
  const dest = join(ROOT, ".cache", "host-config-backup", stamp, file.replace(`${HOME}/`, ""));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(file, dest);
  return dest;
}

export function plan(): { host: string; file: string; add: string[] }[] {
  const out: { host: string; file: string; add: string[] }[] = [];
  for (const [host, h] of Object.entries(JSON_HOSTS)) {
    const file = join(HOME, h.rel);
    if (!existsSync(file)) continue;
    const j = JSON.parse(readFileSync(file, "utf8"));
    const sec = (j[h.key] ?? {}) as Record<string, unknown>;
    out.push({ host, file, add: Object.keys(SERVERS).filter((n) => !(n in sec)) });
  }
  const codex = join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "config.toml");
  if (existsSync(codex)) {
    const t = Bun.TOML.parse(readFileSync(codex, "utf8")) as { mcp_servers?: Record<string, unknown> };
    out.push({ host: "codex", file: codex, add: Object.keys(SERVERS).filter((n) => !(n in (t.mcp_servers ?? {}))) });
  }
  const claude = join(HOME, ".claude.json");
  if (existsSync(claude)) {
    const j = JSON.parse(readFileSync(claude, "utf8"));
    out.push({ host: "claude-user", file: claude, add: Object.keys(SERVERS).filter((n) => !(n in (j.mcpServers ?? {}))) });
  }
  return out;
}

export async function apply(stamp: string): Promise<string[]> {
  const log: string[] = [];
  for (const p of plan()) {
    if (!p.add.length) continue;
    const saved = backup(stamp, p.file);
    if (p.host === "claude-user") {
      for (const name of p.add) {
        const b = SERVERS[name]!;
        const args = ["mcp", "add", name, "--scope", "user", ...Object.entries(b.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "--", b.command, ...b.args];
        const r = Bun.spawnSync(["claude", ...args]);
        if (r.exitCode !== 0) throw new Error(`claude mcp add ${name} failed: ${r.stderr.toString()}`);
      }
    } else if (p.host === "codex") {
      const text = readFileSync(p.file, "utf8");
      const appended = text.replace(/\s*$/, "\n") + p.add.map((n) => codexBlock(n, SERVERS[n]!)).join("");
      Bun.TOML.parse(appended);
      writeFileSync(p.file, appended);
    } else {
      const h = JSON_HOSTS[p.host]!;
      const text = readFileSync(p.file, "utf8");
      const indent = (text.match(/\n( +)"/) ?? [, "  "])[1]!.length;
      const j = JSON.parse(text);
      j[h.key] = j[h.key] ?? {};
      for (const name of p.add) j[h.key][name] = h.shape(SERVERS[name]!);
      writeFileSync(p.file, `${JSON.stringify(j, null, indent)}\n`);
    }
    log.push(`${p.host}: added ${p.add.join(", ")} (backup ${saved})`);
  }
  return log;
}

if (import.meta.main) {
  const mode = Bun.argv[2] ?? "plan";
  if (mode === "plan") for (const p of plan()) console.log(`${p.host.padEnd(12)} add=[${p.add.join(", ")}] ${p.file}`);
  else if (mode === "apply") for (const l of await apply(new Date().toISOString().replace(/[:.]/g, "-"))) console.log(l);
}
