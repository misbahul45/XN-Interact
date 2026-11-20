import { afterEach, describe, expect, test } from "bun:test";
import { accounts, approve, connect, openApp, type TestCtx } from "../helpers.ts";

const open: TestCtx[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.app.close();
});

async function approvedPlan(ctx: TestCtx, text: string) {
  const { member, page } = await accounts(ctx);
  const draft = await ctx.call("social_content_create", { text });
  const plan = await ctx.call("social_content_publish", { mode: "plan", account_ids: [member, page], draft_id: draft.data.draft_id });
  approve(ctx, plan.data.approval.approval_id);
  return plan.data as { plan_id: string };
}

describe("one approval, one execution", () => {
  test("ten concurrent executes with different operation ids: exactly one wins, no duplicate write", async () => {
    const ctx = await openApp();
    open.push(ctx);
    await connect(ctx);
    const plan = await approvedPlan(ctx, "race one");
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => ctx.call("social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: `op-race-distinct-${i}` })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => r.error?.code === "APPROVAL_INVALID")).toBe(true);
    ctx.remote.load();
    expect(ctx.remote.writeCalls).toHaveLength(2);
  });

  test("the same operation id fired ten times returns one run and sends once per target", async () => {
    const ctx = await openApp();
    open.push(ctx);
    await connect(ctx);
    const plan = await approvedPlan(ctx, "race same id");
    const results = await Promise.all(Array.from({ length: 10 }, () => ctx.call("social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: "op-race-same-0001" })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => r.data.run_id)).size).toBe(1);
    ctx.remote.load();
    expect(ctx.remote.writeCalls).toHaveLength(2);
  });

  test("two server processes racing the same plan: one wins cleanly, never an internal error", async () => {
    for (let round = 0; round < 10; round++) {
      const first = await openApp();
      open.push(first);
      await connect(first);
      const second = await openApp(first.home, first.keyring);
      open.push(second);
      const plan = await approvedPlan(first, `two procs ${round}`);
      const calls = [
        ...Array.from({ length: 4 }, (_, i) => first.call("social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: `op-a-${round}-${i}` })),
        ...Array.from({ length: 4 }, (_, i) => second.call("social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: `op-b-${round}-${i}` })),
      ];
      const results = await Promise.all(calls);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map((r) => r.error?.code).every((c) => c === "APPROVAL_INVALID")).toBe(true);
      first.remote.load();
      expect(first.remote.writeCalls.length % 2).toBe(0);
      first.remote.writeCalls.length = 0;
      first.remote.save();
    }
  }, 120000);

  test("two server processes using the same operation id replay one run instead of failing", async () => {
    const first = await openApp();
    open.push(first);
    await connect(first);
    const second = await openApp(first.home, first.keyring);
    open.push(second);
    const plan = await approvedPlan(first, "same id two procs");
    const [a, b] = await Promise.all([
      first.call("social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: "op-shared-two-procs" }),
      second.call("social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: "op-shared-two-procs" }),
    ]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(a.data.run_id).toBe(b.data.run_id);
    first.remote.load();
    expect(first.remote.writeCalls).toHaveLength(2);
  });

  test("with leases disabled in both processes, the atomic step claim alone prevents a duplicate provider write", async () => {
    const first = await openApp();
    open.push(first);
    await connect(first);
    const second = await openApp(first.home, first.keyring);
    open.push(second);
    const { member, page } = await accounts(first);
    const draft = await first.call("social_content_create", { text: "lease storm" });
    const plan = await first.call("social_content_publish", { mode: "plan", account_ids: [member, page], draft_id: draft.data.draft_id });
    approve(first, plan.data.approval.approval_id);
    const runId = "run_leasestorm0001";
    first.app.db.tx(() => {
      const stored = first.app.plans.get(plan.data.plan_id);
      const ap = first.app.approvals.consumeInTx(stored, runId);
      first.app.engine.createRunInTx(stored, "op-lease-storm-01", ap.id, runId);
    });
    first.remote.load();
    first.remote.writeDelayMs = 60;
    first.remote.save();
    first.app.leases.acquire = () => true;
    second.app.leases.acquire = () => true;
    await Promise.all([first.app.engine.advance(runId), second.app.engine.advance(runId)]);
    first.remote.load();
    first.remote.writeDelayMs = 0;
    first.remote.save();
    const final = await first.app.engine.advance(runId);
    expect(["succeeded", "unknown_outcome"]).toContain(final.status);
    first.remote.load();
    expect(first.remote.writeCalls).toHaveLength(2);
    expect(new Set(first.remote.writeCalls.map((w) => w.dedupe_key)).size).toBe(2);
  }, 60000);
});
