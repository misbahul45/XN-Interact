import { join } from "node:path";
import { App } from "../../src/app.ts";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { FileKeyring } from "../../src/identity/keyring.ts";
import { configureLogger } from "../../src/observability/logger.ts";
import { FixtureAdapter, FixtureRemote } from "../../src/providers/fixture/adapter.ts";
import { invoke } from "../../src/routing/gateway.ts";
import { testEnv } from "../helpers.ts";

configureLogger("error", () => {});
const [home, cmd, a, b] = Bun.argv.slice(2) as [string, string, string, string];
const app = await App.open(loadConfig(testEnv(home, { XN_INTERACT_KEYRING: "file" })), {
  keyring: new FileKeyring(join(home, "test-keyring.json")),
  testAdapters: [new FixtureAdapter(new FixtureRemote(join(home, "remote.json")))],
  testClients: { fixture: { client_id: "fixture-client" } },
});
if (cmd === "execute") {
  const r = await invoke(app, "social_content_publish", { mode: "execute", plan_id: a, operation_id: b });
  process.stdout.write(JSON.stringify(r));
} else if (cmd === "approve") {
  const ap = app.approvals.get(a);
  const r = app.approvals.decideFromTrustedTerminal(a, "approved", { tty: true, user: "test-owner", confirmed_hash_prefix: ap.plan_hash.slice(0, 8) });
  process.stdout.write(r.decision);
} else if (cmd === "advance") {
  await Bun.sleep(Number(b ?? 0));
  const v = await app.engine.advance(a);
  process.stdout.write(JSON.stringify(v));
}
app.close();
