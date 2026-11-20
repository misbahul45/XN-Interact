import { afterEach, describe, expect, test } from "bun:test";
import { accounts, approve, connect, openApp, publish, type TestCtx } from "../helpers.ts";

let ctx: TestCtx;
afterEach(() => ctx?.app.close());

describe("publish workflows", () => {
  test("single text publish: plan, trusted approval, execute, verified read-back", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    const { plan, exec } = await publish(ctx, [member], "Hello from XN-Interact");
    expect(plan.targets).toHaveLength(1);
    expect(exec.ok).toBe(true);
    expect(exec.data.status).toBe("succeeded");
    expect(exec.data.targets[0].state).toBe("succeeded");
    expect(exec.data.targets[0].url).toContain("https://fixture.invalid/p/");
    expect(exec.meta.bridge).toEqual({ outcome: "SUCCEEDED", error_class: "NONE" });
    expect(ctx.remote.writeCalls).toHaveLength(1);
    const listed = await ctx.call("social_content_list", { account_id: member });
    expect(listed.data.items[0].text).toBe("Hello from XN-Interact");
  });

  test("crosspost reports targets independently (partial success)", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member, page } = await accounts(ctx);
    const draft = await ctx.call("social_content_create", { text: "two targets" });
    const plan = await ctx.call("social_content_publish", { mode: "plan", account_ids: [member, page], draft_id: draft.data.draft_id });
    approve(ctx, plan.data.approval.approval_id);
    ctx.remote.faults = ["forbidden"];
    ctx.remote.save();
    const exec = await ctx.call("social_content_publish", { mode: "execute", plan_id: plan.data.plan_id, operation_id: "op-crosspost-1" });
    expect(exec.data.status).toBe("partially_succeeded");
    const states = exec.data.targets.map((t: { state: string }) => t.state).sort();
    expect(states).toEqual(["app_approval_required", "succeeded"]);
    expect(exec.meta.bridge).toEqual({ outcome: "SUCCEEDED", error_class: "NONE", partial: true });
  });

  test("lost response after the provider applied the write is reconciled, never re-sent", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    ctx.remote.faults = ["drop_response"];
    ctx.remote.save();
    const { exec } = await publish(ctx, [member], "drop me");
    expect(exec.data.status).toBe("succeeded");
    expect(ctx.remote.writeCalls).toHaveLength(1);
  });

  test("unprovable outcome stays unknown and is never retried", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    ctx.remote.faults = ["unprovable_drop"];
    ctx.remote.save();
    const { exec } = await publish(ctx, [member], "maybe");
    expect(exec.data.status).toBe("unknown_outcome");
    expect(exec.meta.bridge).toEqual({ outcome: "OUTCOME_UNKNOWN", error_class: "UNKNOWN_SIDE_EFFECT" });
    const again = await ctx.call("social_workflows_status", { run_id: exec.data.run_id });
    expect(again.data.status).toBe("unknown_outcome");
    expect(ctx.remote.writeCalls).toHaveLength(0);
  });

  test("provider rate limit waits and retries the refused request once allowed", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    ctx.remote.faults = ["rate_limit"];
    ctx.remote.save();
    const { exec } = await publish(ctx, [member], "after the limit");
    expect(exec.data.status).toBe("waiting_provider");
    await Bun.sleep(80);
    const later = await ctx.call("social_workflows_status", { run_id: exec.data.run_id });
    expect(later.data.status).toBe("succeeded");
    expect(ctx.remote.writeCalls).toHaveLength(1);
  });

  test("same operation_id replays the run without a second provider call", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    const draft = await ctx.call("social_content_create", { text: "once" });
    const plan = await ctx.call("social_content_publish", { mode: "plan", account_ids: [member], draft_id: draft.data.draft_id });
    approve(ctx, plan.data.approval.approval_id);
    const a = await ctx.call("social_content_publish", { mode: "execute", plan_id: plan.data.plan_id, operation_id: "op-replay-12345" });
    const b = await ctx.call("social_content_publish", { mode: "execute", plan_id: plan.data.plan_id, operation_id: "op-replay-12345" });
    expect(b.data.run_id).toBe(a.data.run_id);
    expect(b.meta.warnings?.[0]).toContain("already executed");
    expect(ctx.remote.writeCalls).toHaveLength(1);
  });

  test("update and delete are approved two-phase mutations", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    const { exec } = await publish(ctx, [member], "v1");
    const contentId = exec.data.targets[0].provider_ref;
    const up = await ctx.call("social_content_update", { mode: "plan", account_id: member, content_id: contentId, text: "v2" });
    approve(ctx, up.data.approval.approval_id);
    const upx = await ctx.call("social_content_update", { mode: "execute", plan_id: up.data.plan_id, operation_id: "op-update-1" });
    expect(upx.data.status).toBe("succeeded");
    expect((await ctx.call("social_content_get", { account_id: member, content_id: contentId })).data.text).toBe("v2");
    const del = await ctx.call("social_content_delete", { mode: "plan", account_id: member, content_id: contentId });
    approve(ctx, del.data.approval.approval_id);
    const delx = await ctx.call("social_content_delete", { mode: "execute", plan_id: del.data.plan_id, operation_id: "op-delete-1" });
    expect(delx.data.status).toBe("succeeded");
    expect((await ctx.call("social_content_list", { account_id: member })).data.items).toHaveLength(0);
  });

  test("media publish uploads to a container, polls, then publishes", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3]);
    await Bun.write(`${ctx.home}/inbox/pic.png`, png);
    const staged = await ctx.call("social_media_upload", { path: `${ctx.home}/inbox/pic.png`, alt_text: "a test image" });
    expect(staged.data.kind).toBe("image");
    ctx.remote.faults = ["slow_container"];
    ctx.remote.save();
    const { plan, exec } = await publish(ctx, [member], "with image", { draft: { media_ids: [staged.data.media_id] } });
    expect(plan.targets[0].operation).toBe("content.publish.image");
    let status = exec.data.status;
    for (let i = 0; i < 10 && status !== "succeeded"; i++) {
      await Bun.sleep(30);
      status = (await ctx.call("social_workflows_status", { run_id: exec.data.run_id })).data.status;
    }
    expect(status).toBe("succeeded");
    expect(ctx.remote.writeCalls.map((w) => w.operation)).toEqual(["media.upload", "content.publish.image"]);
  });

  test("scheduled publish waits for its due time and states the process-lifetime caveat", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member, page } = await accounts(ctx);
    const at = new Date(Date.now() + 120_000).toISOString();
    const { plan, exec } = await publish(ctx, [member, page], "later", { plan: { schedule_at: at } });
    expect(plan.schedule_at).toBe(at);
    expect(exec.data.status).toBe("queued");
    expect(exec.data.process_lifetime_caveat).toContain("alive");
    expect(ctx.remote.writeCalls).toHaveLength(0);
    ctx.app.db.run("UPDATE workflow_runs SET due_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), exec.data.run_id);
    const due = await ctx.call("social_workflows_status", { run_id: exec.data.run_id });
    expect(due.data.status).toBe("succeeded");
    expect(ctx.remote.writeCalls).toHaveLength(2);
  });

  test("cancel stops future steps and keeps already-sent targets truthful", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member, page } = await accounts(ctx);
    const at = new Date(Date.now() + 120_000).toISOString();
    const { exec } = await publish(ctx, [member, page], "never", { plan: { schedule_at: at } });
    const c = await ctx.call("social_workflows_cancel", { run_id: exec.data.run_id });
    expect(c.data.status).toBe("cancelled");
    expect(ctx.remote.writeCalls).toHaveLength(0);
  });

  test("engagement: role-gated hide is excluded at plan time; reply works", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member, page } = await accounts(ctx);
    const { exec } = await publish(ctx, [member], "post for comments");
    const contentId = exec.data.targets[0].provider_ref;
    const reply = await ctx.call("social_engagement_execute", { mode: "plan", account_id: member, action: "reply", target_id: contentId, text: "thanks" });
    approve(ctx, reply.data.approval.approval_id);
    const rx = await ctx.call("social_engagement_execute", { mode: "execute", plan_id: reply.data.plan_id, operation_id: "op-reply-1" });
    expect(rx.data.status).toBe("succeeded");
    const comments = await ctx.call("social_engagement_list", { account_id: member, content_id: contentId });
    expect(comments.data.items).toHaveLength(1);
    const hide = await ctx.call("social_engagement_execute", { mode: "plan", account_id: page, action: "hide", target_id: comments.data.items[0].id });
    expect(hide.ok).toBe(false);
    expect(hide.error?.code).toBe("ACCOUNT_ROLE_INSUFFICIENT");
  });

  test("text over the provider limit excludes the target with a reason", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    const draft = await ctx.call("social_content_create", { text: "x".repeat(501) });
    const plan = await ctx.call("social_content_publish", { mode: "plan", account_ids: [member], draft_id: draft.data.draft_id });
    expect(plan.ok).toBe(false);
    expect(JSON.stringify(plan.error)).toContain("allows 500");
  });

  test("workflows_execute runs read skills directly and write skills two-phase", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member, page } = await accounts(ctx);
    const audit = await ctx.call("social_workflows_execute", { mode: "plan", skill_id: "account.audit", input: {} });
    expect(audit.data.accounts).toHaveLength(2);
    const prep = await ctx.call("social_workflows_execute", { mode: "plan", skill_id: "content.prepare", input: { text: "via skill" } });
    const plan = await ctx.call("social_workflows_execute", { mode: "plan", skill_id: "content.publish.many", input: { account_ids: [member, page], draft_id: prep.data.draft_id } });
    expect(plan.data.approval.approval_id).toMatch(/^apr_/);
    approve(ctx, plan.data.approval.approval_id);
    const exec = await ctx.call("social_workflows_execute", { mode: "execute", skill_id: "content.publish.many", plan_id: plan.data.plan_id, operation_id: "op-skill-many-1" });
    expect(exec.data.status).toBe("succeeded");
    const wrong = await ctx.call("social_workflows_execute", { mode: "plan", skill_id: "content.publish.one", input: { account_ids: [member, page], draft_id: prep.data.draft_id } });
    expect(wrong.error?.code).toBe("VALIDATION_FAILED");
    const analytics = await ctx.call("social_workflows_execute", { mode: "plan", skill_id: "analytics.snapshot", input: { account_ids: [member, page] } });
    const byState = Object.fromEntries(analytics.data.accounts.map((a: { account_id: string; state: string }) => [a.account_id, a.state]));
    expect(byState[page]).toBe("succeeded");
    expect(byState[member]).toBe("failed");
  });
});
