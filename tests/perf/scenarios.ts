import { fixtureConsent } from "../../src/providers/fixture/adapter.ts";
import { Meter, type ScenarioResult } from "../../src/performance/benchmark.ts";
import { accounts, approve, connect, openApp, type TestCtx } from "../helpers.ts";

type Profile = "compact" | "standard" | "detailed";
export interface Scenario {
  id: string;
  title: string;
  run: (profile: Profile) => Promise<ScenarioResult>;
}

async function withCtx<T>(fn: (ctx: TestCtx, meter: Meter) => Promise<void>, id: string, title: string): Promise<ScenarioResult> {
  const ctx = await openApp();
  try {
    const meter = new Meter((t, a) => ctx.call(t, a));
    await fn(ctx, meter);
    return meter.result(id, title);
  } finally {
    ctx.app.close();
  }
}

async function twoPhasePublish(ctx: TestCtx, m: Meter, ids: string[], text: string, extra: Record<string, unknown> = {}) {
  const draft = await m.call("social_content_create", { text, ...extra });
  const plan = await m.call("social_content_publish", { mode: "plan", account_ids: ids, draft_id: draft.data.draft_id });
  approve(ctx, plan.data.approval.approval_id);
  return m.call("social_content_publish", { mode: "execute", plan_id: plan.data.plan_id, operation_id: `bench-${crypto.randomUUID().slice(0, 12)}` });
}

export const SCENARIOS: Scenario[] = [
  { id: "connect", title: "Connect an account", run: (p) => withCtx(async (ctx, m) => {
      const start = await m.call("social_auth_connect", { provider: "fixture" });
      const c = fixtureConsent(start.data.auth_url);
      const u = new URL(c.redirect_uri);
      u.searchParams.set("code", c.code!);
      u.searchParams.set("state", c.state);
      await fetch(u);
      await m.call("social_auth_status", { attempt_id: start.data.attempt_id });
    }, "connect", "Connect an account") },
  { id: "list_accounts", title: "List accounts", run: (p) => withCtx(async (ctx, m) => {
      await connect(ctx);
      await m.call("social_accounts_list", { profile: p });
    }, "list_accounts", "List accounts") },
  { id: "inspect_capability", title: "Inspect one account's publish capability", run: (p) => withCtx(async (ctx, m) => {
      await connect(ctx);
      const { member } = await accounts(ctx);
      await m.call("social_capabilities_get", { account_id: member, domain: "content.publish", profile: p });
    }, "inspect_capability", "Inspect one account's publish capability") },
  { id: "publish_single", title: "Publish one text post (plan, approve, execute)", run: (p) => withCtx(async (ctx, m) => {
      await connect(ctx);
      const { member } = await accounts(ctx);
      await twoPhasePublish(ctx, m, [member], "Benchmark post");
    }, "publish_single", "Publish one text post") },
  { id: "crosspost_two", title: "Crosspost to two accounts", run: (p) => withCtx(async (ctx, m) => {
      await connect(ctx);
      const { member, page } = await accounts(ctx);
      await twoPhasePublish(ctx, m, [member, page], "Benchmark crosspost");
    }, "crosspost_two", "Crosspost to two accounts") },
  { id: "upload_media", title: "Stage a local image", run: (p) => withCtx(async (ctx, m) => {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
      await Bun.write(`${ctx.home}/inbox/b.png`, png);
      await m.call("social_media_upload", { path: `${ctx.home}/inbox/b.png`, alt_text: "benchmark" });
    }, "upload_media", "Stage a local image") },
  { id: "read_paginated", title: "Read two pages of content", run: (p) => withCtx(async (ctx, m) => {
      await connect(ctx);
      const { member } = await accounts(ctx);
      for (let i = 0; i < 7; i++) {
        const d = await ctx.call("social_content_create", { text: `post ${i} ${"lorem ipsum ".repeat(30)}` });
        const pl = await ctx.call("social_content_publish", { mode: "plan", account_ids: [member], draft_id: d.data.draft_id });
        approve(ctx, pl.data.approval.approval_id);
        await ctx.call("social_content_publish", { mode: "execute", plan_id: pl.data.plan_id, operation_id: `seed-${i}-${crypto.randomUUID().slice(0, 8)}` });
      }
      const first = await m.call("social_content_list", { account_id: member, limit: 4, profile: p });
      await m.call("social_content_list", { account_id: member, limit: 4, cursor: first.meta.next_cursor, profile: p });
    }, "read_paginated", "Read two pages of content") },
  { id: "analytics", title: "Aggregate analytics for two accounts", run: (p) => withCtx(async (ctx, m) => {
      await connect(ctx);
      const { member, page } = await accounts(ctx);
      await m.call("social_analytics_get", { account_ids: [member, page] });
    }, "analytics", "Aggregate analytics for two accounts") },
  { id: "missing_scope", title: "Hit a missing scope", run: (p) => withCtx(async (ctx, m) => {
      await connect(ctx, { scopes: ["profile", "read"] });
      const { member } = await accounts(ctx);
      const d = await ctx.call("social_content_create", { text: "x" });
      await m.call("social_content_publish", { mode: "plan", account_ids: [member], draft_id: d.data.draft_id });
    }, "missing_scope", "Hit a missing scope") },
  { id: "reject_unsupported", title: "Reject an unsupported provider action", run: (p) => withCtx(async (ctx, m) => {
      await m.call("social_auth_connect", { provider: "linkedin" });
    }, "reject_unsupported", "Reject an unsupported provider action") },
  { id: "write_timeout", title: "Write whose outcome is unknown, then check status", run: (p) => withCtx(async (ctx, m) => {
      await connect(ctx);
      const { member } = await accounts(ctx);
      ctx.remote.faults = ["unprovable_drop"];
      ctx.remote.save();
      const r = await twoPhasePublish(ctx, m, [member], "timeout post");
      await m.call("social_workflows_status", { run_id: r.data.run_id, profile: p });
    }, "write_timeout", "Write whose outcome is unknown, then check status") },
  { id: "recover", title: "Recover an unknown outcome with skill ops.recover", run: (p) => withCtx(async (ctx, m) => {
      await connect(ctx);
      const { member } = await accounts(ctx);
      ctx.remote.faults = ["unprovable_drop"];
      ctx.remote.save();
      await twoPhasePublish(ctx, new Meter((t, a) => ctx.call(t, a)), [member], "to recover");
      await m.call("social_workflows_execute", { mode: "plan", skill_id: "ops.recover", input: {} });
    }, "recover", "Recover an unknown outcome") },
];
