import { afterEach, describe, expect, test } from "bun:test";
import { accounts, connect, openApp, publish, type TestCtx } from "../helpers.ts";

let ctx: TestCtx;
afterEach(() => ctx?.app.close());

describe("output profiles and result refs", () => {
  test("compact is a strict subset of standard, which is a subset of detailed", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    const keys = async (p: string) => Object.keys((await ctx.call("social_accounts_list", { account_id: member, profile: p })).data.accounts[0]).sort();
    const [c, s, d] = [await keys("compact"), await keys("standard"), await keys("detailed")];
    expect(c).toEqual(["account_id", "account_type", "display_name", "provider", "state"]);
    expect(c.every((k) => s.includes(k)) && s.every((k) => d.includes(k))).toBe(true);
    expect(s.length).toBeGreaterThan(c.length);
    expect(d.length).toBeGreaterThan(s.length);
    const cap = await ctx.call("social_capabilities_get", { account_id: member });
    expect(Object.keys(cap.data.operations[0]).sort()).toEqual(["operation", "state"]);
  });

  test("long text is truncated in compact listings only", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    await publish(ctx, [member], "y".repeat(400));
    const c = await ctx.call("social_content_list", { account_id: member });
    const d = await ctx.call("social_content_list", { account_id: member, profile: "detailed" });
    expect(c.data.items[0].text.length).toBe(281);
    expect(d.data.items[0].text.length).toBe(400);
  });

  test("result refs are scoped, paged and expire", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member, page } = await accounts(ctx);
    const { exec } = await publish(ctx, [member, page], "refs");
    const first = await ctx.call("social_results_get", { ref: exec.meta.result_ref, limit: 1 });
    expect(first.data.targets).toHaveLength(1);
    expect(first.meta.next_cursor).toBe("1");
    expect((await ctx.call("social_results_get", { ref: "res_doesnotexist0001" })).error?.code).toBe("RESULT_REF_EXPIRED");
    ctx.app.db.run("UPDATE cached_results SET expires_at = ?", new Date(Date.now() - 1000).toISOString());
    expect((await ctx.call("social_results_get", { ref: exec.meta.result_ref })).error?.code).toBe("RESULT_REF_EXPIRED");
  });

  test("status since_version returns unchanged when nothing moved", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    const { exec } = await publish(ctx, [member], "versions");
    const s = await ctx.call("social_workflows_status", { run_id: exec.data.run_id, since_version: exec.data.version });
    expect(s.data.unchanged).toBe(true);
  });
});
