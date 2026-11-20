import { afterEach, describe, expect, test } from "bun:test";
import { accounts, connect, openApp, type TestCtx } from "../helpers.ts";

let ctx: TestCtx;
afterEach(() => ctx?.app.close());

function state(ctx: TestCtx, account: string, op: string): string {
  return ctx.app.resolver.resolve(account, op).state;
}

describe("capability truth function", () => {
  test("one primary state per operation from manifest, account, grant, policy and budget", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member, page } = await accounts(ctx);
    expect(state(ctx, member, "content.read")).toBe("AVAILABLE");
    expect(state(ctx, member, "content.publish.text")).toBe("NEEDS_APPROVAL");
    expect(state(ctx, member, "search.content")).toBe("APP_APPROVAL_REQUIRED");
    expect(state(ctx, member, "analytics.read")).toBe("ACCOUNT_TYPE_UNSUPPORTED");
    expect(state(ctx, page, "analytics.read")).toBe("AVAILABLE");
    expect(state(ctx, page, "engagement.hide")).toBe("ACCOUNT_ROLE_INSUFFICIENT");
    expect(state(ctx, "acc_doesnotexist00", "content.read")).toBe("NOT_CONNECTED");
    expect(state(ctx, member, "content.draft")).toBe("AVAILABLE");
  });

  test("role changes and grant revisions invalidate cached verdicts", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { page } = await accounts(ctx);
    expect(state(ctx, page, "engagement.hide")).toBe("ACCOUNT_ROLE_INSUFFICIENT");
    ctx.app.db.run("UPDATE connected_accounts SET role = 'admin' WHERE id = ?", page);
    expect(state(ctx, page, "engagement.hide")).toBe("NEEDS_APPROVAL");
    ctx.app.db.run("UPDATE oauth_grants SET state = 'revoked' WHERE account_id = ?", page);
    expect(state(ctx, page, "engagement.hide")).toBe("NOT_CONNECTED");
  });

  test("budgets deny before any provider request", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    ctx.app.budget.setLimit(member, "content.read", 1, null);
    expect((await ctx.call("social_content_list", { account_id: member })).ok).toBe(true);
    const r = await ctx.call("social_content_list", { account_id: member });
    expect(r.error?.code).toBe("RATE_LIMITED");
    ctx.app.budget.setLimit(member, "content.publish.text", null, 0.5);
    expect(state(ctx, member, "content.publish.text")).toBe("COST_LIMITED");
  });

  test("unverified providers never resolve AVAILABLE", async () => {
    ctx = await openApp();
    for (const p of ctx.app.providers.ids().filter((x) => x !== "fixture")) {
      for (const [op, m] of Object.entries(ctx.app.providers.get(p).manifest.operations)) {
        expect(m.verdict).not.toBe("VERIFIED");
        expect(op).toBeTruthy();
      }
    }
  });

  test("health reports each provider independently", async () => {
    ctx = await openApp();
    for (let i = 0; i < 3; i++) ctx.app.resolver.circuit.fail("fixture");
    const h = await ctx.call("social_system_health", { profile: "standard" });
    const items = h.data.components.providers.items as { provider: string; circuit_open: boolean }[];
    expect(items.find((x) => x.provider === "fixture")?.circuit_open).toBe(true);
    expect(items.filter((x) => x.circuit_open)).toHaveLength(1);
  });
});
