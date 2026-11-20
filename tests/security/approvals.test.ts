import { afterEach, describe, expect, test } from "bun:test";
import { accounts, approve, connect, openApp, type TestCtx } from "../helpers.ts";

let ctx: TestCtx;
afterEach(() => ctx?.app.close());

async function planned(text = "secure") {
  await connect(ctx);
  const { member } = await accounts(ctx);
  const draft = await ctx.call("social_content_create", { text });
  const plan = await ctx.call("social_content_publish", { mode: "plan", account_ids: [member], draft_id: draft.data.draft_id });
  return { member, plan: plan.data, draft: draft.data };
}

describe("approval boundary", () => {
  test("execute without a human approval is refused and sends nothing", async () => {
    ctx = await openApp();
    const { plan } = await planned();
    const r = await ctx.call("social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: "op-noapproval" });
    expect(r.error?.code).toBe("APPROVAL_REQUIRED");
    expect(r.error?.bridge_error_class).toBe("USER_INTERVENTION");
    expect(ctx.remote.writeCalls).toHaveLength(0);
  });

  test("confirm or approved arguments cannot self-approve", async () => {
    ctx = await openApp();
    const { plan } = await planned();
    for (const extra of [{ confirm: true }, { approved: true }]) {
      const r = await ctx.call("social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: "op-self-approve", ...extra });
      expect(r.ok).toBe(false);
    }
    expect(ctx.remote.writeCalls).toHaveLength(0);
  });

  test("no MCP tool can change an approval", async () => {
    ctx = await openApp();
    const { plan } = await planned();
    const s = await ctx.call("social_approvals_status", { approval_id: plan.approval.approval_id });
    expect(s.data.decision).toBe("pending");
    expect(s.data.how_to_decide).toContain("xn-interact approve");
    expect(ctx.app.approvals.get(plan.approval.approval_id).decision).toBe("pending");
  });

  test("an approval is single-use: a new operation_id cannot reuse it", async () => {
    ctx = await openApp();
    const { plan } = await planned();
    approve(ctx, plan.approval.approval_id);
    const a = await ctx.call("social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: "op-first-use" });
    expect(a.data.status).toBe("succeeded");
    const b = await ctx.call("social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: "op-second-use" });
    expect(b.error?.code).toBe("APPROVAL_INVALID");
    expect(ctx.remote.writeCalls).toHaveLength(1);
  });

  test("content changed after approval is rejected", async () => {
    ctx = await openApp();
    const { plan } = await planned("original");
    approve(ctx, plan.approval.approval_id);
    const row = ctx.app.db.get<{ payload_json: string }>("SELECT payload_json FROM execution_plans WHERE id = ?", plan.plan_id)!;
    ctx.app.db.run("UPDATE execution_plans SET payload_json = ? WHERE id = ?", row.payload_json.replace("original", "tampered"), plan.plan_id);
    const r = await ctx.call("social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: "op-tampered" });
    expect(r.error?.code).toBe("PLAN_CHANGED");
    expect(ctx.remote.writeCalls).toHaveLength(0);
  });

  test("rejected and expired approvals cannot execute", async () => {
    ctx = await openApp();
    const { plan } = await planned();
    const a = ctx.app.approvals.get(plan.approval.approval_id);
    ctx.app.approvals.decideFromTrustedTerminal(a.id, "rejected", { tty: true, user: "owner", confirmed_hash_prefix: a.plan_hash.slice(0, 8) });
    const r = await ctx.call("social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: "op-rejected" });
    expect(r.error?.code).toBe("APPROVAL_INVALID");
    const second = await planned("again");
    approve(ctx, second.plan.approval.approval_id);
    ctx.app.db.run("UPDATE approvals SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), second.plan.approval.approval_id);
    const e = await ctx.call("social_content_publish", { mode: "execute", plan_id: second.plan.plan_id, operation_id: "op-expired" });
    expect(e.error?.code).toBe("APPROVAL_INVALID");
  });

  test("the terminal confirmation must match the plan hash", async () => {
    ctx = await openApp();
    const { plan } = await planned();
    expect(() => ctx.app.approvals.decideFromTrustedTerminal(plan.approval.approval_id, "approved", { tty: true, user: "owner", confirmed_hash_prefix: "00000000" })).toThrow();
  });

  test("an operation_id bound to another plan is an idempotency conflict", async () => {
    ctx = await openApp();
    const one = await planned("one");
    approve(ctx, one.plan.approval.approval_id);
    await ctx.call("social_content_publish", { mode: "execute", plan_id: one.plan.plan_id, operation_id: "op-shared-id" });
    const draft = await ctx.call("social_content_create", { text: "two" });
    const two = await ctx.call("social_content_publish", { mode: "plan", account_ids: [one.member], draft_id: draft.data.draft_id });
    approve(ctx, two.data.approval.approval_id);
    const r = await ctx.call("social_content_publish", { mode: "execute", plan_id: two.data.plan_id, operation_id: "op-shared-id" });
    expect(r.error?.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("identical inputs produce the same plan hash", async () => {
    ctx = await openApp();
    const { member, draft } = await planned("same");
    const a = await ctx.call("social_content_publish", { mode: "plan", account_ids: [member], draft_id: draft.draft_id });
    const b = await ctx.call("social_content_publish", { mode: "plan", account_ids: [member], draft_id: draft.draft_id });
    expect(a.data.plan_hash).toBe(b.data.plan_hash);
    expect(a.data.plan_id).not.toBe(b.data.plan_id);
  });
});
