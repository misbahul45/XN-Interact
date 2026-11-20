import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FileKeyring } from "../../src/identity/keyring.ts";
import { accounts, approve, connect, openApp, ROOT, tempHome, type TestCtx } from "../helpers.ts";

let ctx: TestCtx;
afterEach(() => ctx?.app.close());

async function setup() {
  const home = tempHome();
  ctx = await openApp(home, new FileKeyring(join(home, "test-keyring.json")) as never);
  await connect(ctx);
  const { member, page } = await accounts(ctx);
  return { home, member, page };
}

function child(home: string, ...args: string[]) {
  return Bun.spawn([process.execPath, join(ROOT, "tests/fixtures/child.ts"), home, ...args], { stdout: "pipe", stderr: "pipe" });
}

describe("restart and multi-process safety", () => {
  test("a process killed after the provider applied the write is recovered without a duplicate", async () => {
    const { home, member } = await setup();
    const draft = await ctx.call("social_content_create", { text: "crash test" });
    const plan = await ctx.call("social_content_publish", { mode: "plan", account_ids: [member], draft_id: draft.data.draft_id });
    approve(ctx, plan.data.approval.approval_id);
    ctx.remote.load();
    ctx.remote.faults = ["crash_after_apply"];
    ctx.remote.save();
    const p = child(home, "execute", plan.data.plan_id, "op-crash-0001");
    await p.exited;
    expect(p.signalCode).toBe("SIGKILL");
    const run = ctx.app.engine.byOperation("op-crash-0001")!;
    expect(run.state).toBe("running");
    ctx.app.db.run("UPDATE worker_leases SET expires_at = ?", new Date(Date.now() - 1000).toISOString());
    const rec = ctx.app.engine.recover();
    expect(rec.interrupted).toBe(1);
    const view = await ctx.app.engine.advance(run.id);
    expect(view.status).toBe("succeeded");
    ctx.remote.load();
    expect(ctx.remote.writeCalls).toHaveLength(1);
  });

  test("two processes advancing the same run execute each write once", async () => {
    const { home, member, page } = await setup();
    const draft = await ctx.call("social_content_create", { text: "race" });
    const plan = await ctx.call("social_content_publish", { mode: "plan", account_ids: [member, page], draft_id: draft.data.draft_id });
    approve(ctx, plan.data.approval.approval_id);
    const runId = "run_race0000000001";
    ctx.app.db.tx(() => {
      const stored = ctx.app.plans.get(plan.data.plan_id);
      const ap = ctx.app.approvals.consumeInTx(stored, runId);
      ctx.app.engine.createRunInTx(stored, "op-race-00001", ap.id, runId);
    });
    ctx.remote.load();
    ctx.remote.writeDelayMs = 300;
    ctx.remote.save();
    const a = child(home, "advance", runId, "0");
    const b = child(home, "advance", runId, "50");
    await Promise.all([a.exited, b.exited]);
    ctx.remote.load();
    ctx.remote.writeDelayMs = 0;
    ctx.remote.save();
    const final = await ctx.app.engine.advance(runId);
    expect(final.status).toBe("succeeded");
    ctx.remote.load();
    expect(ctx.remote.writeCalls).toHaveLength(2);
    expect(new Set(ctx.remote.writeCalls.map((w) => w.dedupe_key)).size).toBe(2);
  });

  test("in-flight runs keep the workflow definition they started with", async () => {
    const { member } = await setup();
    const draft = await ctx.call("social_content_create", { text: "pinned" });
    const plan = await ctx.call("social_content_publish", { mode: "plan", account_ids: [member], draft_id: draft.data.draft_id, schedule_at: new Date(Date.now() + 120_000).toISOString() });
    approve(ctx, plan.data.approval.approval_id);
    const exec = await ctx.call("social_content_publish", { mode: "execute", plan_id: plan.data.plan_id, operation_id: "op-pinned-001" });
    const row = ctx.app.engine.run(exec.data.run_id);
    const pinned = JSON.parse(row.definition_json);
    expect(pinned.workflow.id).toBe("content.schedule@1");
    expect(Object.keys(pinned.children).sort()).toEqual(["content.media_publish@1", "content.publish@1"]);
  });
});
