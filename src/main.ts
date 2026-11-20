import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { App } from "./app.ts";
import { loadConfig } from "./bootstrap/config.ts";
import { onShutdown } from "./bootstrap/lifecycle.ts";
import { assertRuntime } from "./bootstrap/runtime.ts";
import { buildServer } from "./mcp/server.ts";
import { configureLogger, log } from "./observability/logger.ts";

console.log = (...args: unknown[]) => process.stderr.write(`${args.map(String).join(" ")}\n`);
console.info = console.log;

assertRuntime();
const config = loadConfig();
configureLogger(config.logLevel);
const app = await App.open(config);
const server = buildServer(app);
await server.connect(new StdioServerTransport());
app.startTicker();
log.info("xn-interact ready", { home: config.home, vault: app.vault.state, env: config.env });
onShutdown(async () => {
  await server.close();
  app.close();
});
