import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import threats from "../../plan/threats.json" with { type: "json" };
import requirements from "../../plan/requirements.json" with { type: "json" };
import { CATALOG } from "../../src/contracts/catalog.ts";
import { TOOL_SPECS } from "../../src/routing/gateway.ts";
import { accounts, connect, openApp, ROOT, tempHome, testEnv, type TestCtx } from "../helpers.ts";

let ctx: TestCtx;
afterEach(() => ctx?.app.close());

function listeningSockets(pid: number): string[] {
  const inodes = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      if (target.startsWith("socket:[")) inodes.add(target.slice(8, -1));
    } catch {}
  }
  const found: string[] = [];
  for (const name of ["tcp", "tcp6"]) {
    for (const line of readFileSync(`/proc/net/${name}`, "utf8").split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length > 9 && cols[3] === "0A" && inodes.has(cols[9]!)) found.push(`${name}:${cols[1]}`);
    }
  }
  return found;
}

describe("threat matrix", () => {
  test("every threat in docs/threat-model.md is mapped to existing requirements and to tests that exist", () => {
    const doc = readFileSync(join(ROOT, "docs/threat-model.md"), "utf8");
    const documented = [...doc.matchAll(/^\| (T\d{2}) \|/gm)].map((m) => m[1]!);
    expect(threats.threats.map((t) => t.id)).toEqual(documented);
    const reqIds = new Set(requirements.requirements.map((r) => r.id));
    for (const t of threats.threats) {
      expect(t.tests.length, `${t.id} has no test`).toBeGreaterThan(0);
      for (const r of t.requirements) expect(reqIds.has(r), `${t.id}: unknown requirement ${r}`).toBe(true);
      for (const x of t.tests) {
        const path = join(ROOT, x.file);
        expect(existsSync(path), `${t.id}: ${x.file} is missing`).toBe(true);
        expect(readFileSync(path, "utf8").includes(x.name), `${t.id}: "${x.name}" not found in ${x.file}`).toBe(true);
      }
    }
  });

  test("no tool input can choose a redirect, callback or base URL", () => {
    for (const t of CATALOG.tools) {
      const keys = Object.keys(TOOL_SPECS[t.name]!.input.shape);
      expect(keys.filter((k) => /redirect|callback|base_?url|endpoint|host/i.test(k)), t.name).toEqual([]);
    }
  });

  test("a grant moved to another account cannot be decrypted or used", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member, page } = await accounts(ctx);
    ctx.app.db.run("UPDATE oauth_grants SET encrypted_tokens = (SELECT encrypted_tokens FROM oauth_grants WHERE account_id = ?) WHERE account_id = ?", member, page);
    const r = await ctx.call("social_content_list", { account_id: page });
    expect(r.ok).toBe(false);
    ctx.remote.load();
    expect(ctx.remote.writeCalls).toHaveLength(0);
    expect((await ctx.call("social_content_list", { account_id: member })).ok).toBe(true);
  });

  test("an idle server listens on no network port", async () => {
    const proc = Bun.spawn([process.execPath, join(ROOT, "src/main.ts")], { env: { ...testEnv(tempHome(), { XN_INTERACT_KEYRING: "file" }), PATH: process.env.PATH ?? "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      await Bun.sleep(800);
      expect(listeningSockets(proc.pid)).toEqual([]);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("there is no bulk skill and fan-out is capped", async () => {
    expect(CATALOG.skills.filter((s) => /bulk|mass|spam|blast/i.test(s.id))).toEqual([]);
    expect("account_ids" in TOOL_SPECS.social_engagement_execute!.input.shape).toBe(false);
    ctx = await openApp();
    const ids = Array.from({ length: 21 }, (_, i) => `acc_${String(i).padStart(12, "0")}`);
    const r = await ctx.call("social_content_publish", { mode: "plan", account_ids: ids, draft_id: "drf_doesnotexist0001" });
    expect(r.error?.code).toBe("VALIDATION_FAILED");
  });

  test("every dependency is pinned to an exact version and locked", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) expect(String(v), name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(join(ROOT, "bun.lock"))).toBe(true);
  });
});
