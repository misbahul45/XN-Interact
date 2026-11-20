import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = import.meta.dir;
const report: Record<string, unknown> = { bun: Bun.version };

const transport = new StdioClientTransport({ command: process.execPath, args: [`${here}/server.ts`], stderr: "pipe" });
const client = new Client({ name: "spike-probe", version: "0.0.1" });
await client.connect(transport);
report.protocolVersion = (client as unknown as { protocolVersion?: string }).protocolVersion ?? null;
report.serverVersion = client.getServerVersion();
report.serverCapabilities = client.getServerCapabilities();
const tools = await client.listTools();
report.tools = tools.tools.map((t) => t.name);
const t0 = performance.now();
let ok = 0;
for (let i = 0; i < 1000; i++) {
  const r = await client.callTool({ name: "social_spike_echo", arguments: { value: `v${i}` } });
  if ((r.structuredContent as { echoed?: string } | undefined)?.echoed === `v${i}`) ok++;
}
report.calls1000 = { ok, ms: Math.round(performance.now() - t0) };
const bad = await client.callTool({ name: "social_spike_echo", arguments: { value: 5 } });
report.invalidArgs = { isError: bad.isError ?? false };
await client.close();

const proc = Bun.spawn([process.execPath, `${here}/server.ts`], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "0" } } };
proc.stdin.write(`${JSON.stringify(init)}\n`);
proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "social_spike_echo", arguments: { value: "raw" } } })}\n`);
proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "raw", version: "0" } } })}\n`);
await Bun.sleep(800);
proc.stdin.end();
const out = await new Response(proc.stdout).text();
const err = await new Response(proc.stderr).text();
const lines = out.split("\n").filter(Boolean);
report.rawStdout = {
  lines: lines.length,
  allJsonRpc: lines.every((l) => { try { return JSON.parse(l).jsonrpc === "2.0"; } catch { return false; } }),
  negotiated: lines.map((l) => JSON.parse(l)).filter((m) => m.id === 1).map((m) => m.result?.protocolVersion),
  secondInitialize: lines.map((l) => JSON.parse(l)).filter((m) => m.id === 3).map((m) => m.result?.protocolVersion ?? m.error?.message),
  stderrHasLogs: err.includes("stderr log"),
};
console.log(JSON.stringify(report, null, 2));
