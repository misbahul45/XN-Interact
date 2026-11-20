import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { CATALOG } from "../../src/contracts/catalog.ts";
import { TOOL_SPECS } from "../../src/routing/gateway.ts";
import { ROOT, tempHome, testEnv } from "../helpers.ts";

describe("process lifecycle and trust boundaries", () => {
  test("SIGTERM shuts the server down cleanly and releases leases", async () => {
    const home = tempHome();
    const p = Bun.spawn([process.execPath, join(ROOT, "src/main.ts")], { env: { ...testEnv(home, { XN_INTERACT_KEYRING: "file", XN_INTERACT_TICK_MS: "50" }), PATH: process.env.PATH ?? "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(700);
    p.kill("SIGTERM");
    expect(await p.exited).toBe(0);
    const db = new Database(join(home, "xn-interact.sqlite"));
    expect(db.query("SELECT count(*) AS n FROM worker_leases").get()).toEqual({ n: 0 });
    db.close();
  });

  test("approval refuses a non-interactive terminal", async () => {
    const home = tempHome();
    const p = Bun.spawn([process.execPath, join(ROOT, "src/cli.ts"), "approve", "apr_anything000000"], { env: { ...testEnv(home), PATH: process.env.PATH ?? "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.end();
    expect(await p.exited).toBe(2);
    expect(await new Response(p.stderr).text()).toContain("interactive terminal");
  });

  test("no tool accepts credentials and the server never acts as an MCP client", async () => {
    for (const t of CATALOG.tools) {
      const keys = Object.keys(TOOL_SPECS[t.name]!.input.shape);
      expect(keys.filter((k) => /token|secret|password|cookie|api_key|client_id/i.test(k))).toEqual([]);
    }
    const glob = new Bun.Glob("src/**/*.ts");
    for await (const f of glob.scan(ROOT)) expect((await Bun.file(join(ROOT, f)).text()).includes("@modelcontextprotocol/client")).toBe(false);
  });
});
