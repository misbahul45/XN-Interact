const root = `${import.meta.dir}/../..`;
const list = JSON.parse(await Bun.$`codex mcp list --json`.quiet().text()) as { name: string }[];
const args = ["app-server", "--stdio", "-c", "analytics.enabled=false"];
for (const s of list) args.push("-c", `mcp_servers.${s.name}.enabled=false`);
const server = process.env.PROBE_SERVER ?? "xn_spike";
const entry = process.env.PROBE_ENTRY ?? `${root}/spikes/mcp-stdio/server.ts`;
args.push("-c", `mcp_servers.${server}.enabled=true`);
args.push("-c", `mcp_servers.${server}.command=${JSON.stringify(process.execPath)}`);
args.push("-c", `mcp_servers.${server}.args=${JSON.stringify([entry])}`);
if (process.env.PROBE_HOME) args.push("-c", `mcp_servers.${server}.env.XN_INTERACT_HOME=${JSON.stringify(process.env.PROBE_HOME)}`);
const proc = Bun.spawn(["codex", ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: root });
const reader = proc.stdout.getReader();
let buf = "";
let seq = 0;
async function request(method: string, params: unknown, ms = 30000): Promise<any> {
  const id = ++seq;
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    let nl = buf.indexOf("\n");
    while (nl < 0) {
      const { value, done } = await reader.read();
      if (done) throw new Error("codex exited");
      buf += new TextDecoder().decode(value);
      nl = buf.indexOf("\n");
    }
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    const msg = JSON.parse(line);
    if (msg.id === id && !msg.method) {
      if (msg.error) throw new Error(JSON.stringify(msg.error));
      return msg.result;
    }
    if (msg.method && msg.id !== undefined) proc.stdin.write(`${JSON.stringify({ id: msg.id, error: { code: -32601, message: "probe grants nothing" } })}\n`);
  }
  throw new Error(`timeout ${method}`);
}
const out: Record<string, unknown> = {};
try {
  await request("initialize", { clientInfo: { name: "xn-interact-probe", version: "0.0.1" }, capabilities: { experimentalApi: true } });
  const thread = await request("thread/start", { cwd: root, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
  let rows: any[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await request("mcpServerStatus/list", { threadId: thread.thread.id, serverName: server, cursor: null, limit: 25 });
    rows = r.data ?? [];
    if (rows[0]?.runtimeStatus === "connected") break;
    await Bun.sleep(500);
  }
  const row = rows[0] ?? {};
  out.runtimeStatus = row.runtimeStatus;
  out.toolsError = row.toolsError ?? null;
  out.tools = Object.keys(row.tools ?? {}).length ? Object.keys(row.tools) : (row.tools ?? []).map?.((t: any) => t.name);
  out.rowKeys = Object.keys(row);
} catch (e) {
  out.error = e instanceof Error ? e.message : String(e);
}
proc.stdin.end();
proc.kill();
console.log(JSON.stringify(out, null, 2));
