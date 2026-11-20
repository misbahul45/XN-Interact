import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accounts, approve, connect, logs, openApp, type TestCtx } from "../helpers.ts";

let ctx: TestCtx;
afterEach(() => ctx?.app.close());

describe("credential canary", () => {
  test("provider tokens never appear in tool output, logs, audit, results or the database files", async () => {
    ctx = await openApp();
    ctx.remote.tokenPrefix = "CANARY7F3A";
    ctx.remote.save();
    logs.length = 0;
    const outputs: string[] = [];
    const call = async (t: string, a: Record<string, unknown> = {}) => {
      const r = await ctx.call(t, a);
      outputs.push(JSON.stringify(r));
      return r;
    };
    await connect(ctx);
    const { member, page } = await accounts(ctx);
    await call("social_accounts_list", { profile: "detailed" });
    await call("social_capabilities_get", { account_id: member, profile: "detailed" });
    await call("social_auth_status", { account_id: member });
    await call("social_content_list", { account_id: member, profile: "detailed" });
    const draft = await call("social_content_create", { text: "canary run" });
    const plan = await call("social_content_publish", { mode: "plan", account_ids: [member, page], draft_id: draft.data.draft_id });
    approve(ctx, plan.data.approval.approval_id);
    const exec = await call("social_content_publish", { mode: "execute", plan_id: plan.data.plan_id, operation_id: "op-canary-0001" });
    await call("social_results_get", { ref: exec.meta.result_ref });
    await call("social_system_health", { profile: "detailed" });
    await call("social_workflows_execute", { mode: "plan", skill_id: "account.audit", input: {} });
    ctx.app.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const surfaces = [...outputs, ...logs, ctx.app.audit.exportScrubbed()];
    for (const f of readdirSync(ctx.home)) if (f.startsWith("xn-interact.sqlite")) surfaces.push(readFileSync(join(ctx.home, f)).toString("latin1"));
    expect(ctx.remote.tokens.size).toBeGreaterThan(0);
    for (const s of surfaces) expect(s.includes("CANARY7F3A")).toBe(false);
  });
});
