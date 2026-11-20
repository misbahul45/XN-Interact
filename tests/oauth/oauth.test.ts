import { afterEach, describe, expect, test } from "bun:test";
import { fixtureConsent } from "../../src/providers/fixture/adapter.ts";
import { accounts, approve, connect, openApp, type TestCtx } from "../helpers.ts";

let ctx: TestCtx;
afterEach(() => ctx?.app.close());

async function hit(url: URL, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { headers });
}

describe("OAuth broker", () => {
  test("connect stores encrypted grants for every consented identity and returns no token", async () => {
    ctx = await openApp();
    const { attempt, status, callback } = await connect(ctx);
    expect(callback.status).toBe(200);
    expect(attempt.auth_url).toContain("code_challenge=");
    expect(attempt.auth_url).toContain("code_challenge_method=S256");
    expect(status.status).toBe("connected");
    expect(status.account_ids).toHaveLength(2);
    const raw = JSON.stringify(ctx.app.db.all("SELECT * FROM oauth_grants"));
    expect(raw).not.toContain("fxt-access");
    expect(JSON.stringify(status)).not.toContain("fxt-");
  });

  test("unknown state, replay, wrong host and wrong provider path are rejected", async () => {
    ctx = await openApp();
    const start = await ctx.call("social_auth_connect", { provider: "fixture" });
    const c = fixtureConsent(start.data.auth_url);
    const good = new URL(c.redirect_uri);
    good.searchParams.set("code", c.code!);
    good.searchParams.set("state", c.state);
    const forged = new URL(good);
    forged.searchParams.set("state", "forged-state-value");
    expect((await hit(forged)).status).toBe(400);
    const wrongHost = await hit(good, { host: "evil.example:80" });
    expect(wrongHost.status).toBe(403);
    const wrongPath = new URL(good);
    wrongPath.pathname = "/oauth/callback/linkedin";
    expect((await hit(wrongPath)).status).toBe(400);
    expect((await hit(good)).status).toBe(200);
    expect((await hit(good)).status).toBe(400);
  });

  test("expired attempt is refused", async () => {
    ctx = await openApp();
    const start = await ctx.call("social_auth_connect", { provider: "fixture" });
    ctx.app.db.run("UPDATE oauth_attempts SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), start.data.attempt_id);
    const c = fixtureConsent(start.data.auth_url);
    const u = new URL(c.redirect_uri);
    u.searchParams.set("code", c.code!);
    u.searchParams.set("state", c.state);
    expect((await hit(u)).status).toBe(400);
    expect((await ctx.call("social_auth_status", { attempt_id: start.data.attempt_id })).data.status).toBe("expired");
  });

  test("an injected code bound to another PKCE challenge fails the exchange", async () => {
    ctx = await openApp();
    const victim = await ctx.call("social_auth_connect", { provider: "fixture" });
    const attacker = await ctx.call("social_auth_connect", { provider: "fixture" });
    const attackerCode = fixtureConsent(attacker.data.auth_url).code!;
    const v = fixtureConsent(victim.data.auth_url);
    const u = new URL(v.redirect_uri);
    u.searchParams.set("code", attackerCode);
    u.searchParams.set("state", v.state);
    expect((await hit(u)).status).toBe(400);
    const s = await ctx.call("social_auth_status", { attempt_id: victim.data.attempt_id });
    expect(s.data.status).toBe("failed");
    expect(s.data.error).toContain("exchange_failed");
  });

  test("denied consent fails the attempt cleanly", async () => {
    ctx = await openApp();
    const { status } = await connect(ctx, { deny: true });
    expect(status.status).toBe("failed");
    expect(status.error).toBe("provider_error:access_denied");
  });

  test("partial consent reports missing scopes and capabilities say MISSING_SCOPES", async () => {
    ctx = await openApp();
    const { status } = await connect(ctx, { scopes: ["profile", "read"] });
    expect(status.missing_scopes).toEqual(["engage", "insights", "write"]);
    const { member } = await accounts(ctx);
    const caps = await ctx.call("social_capabilities_get", { account_id: member, domain: "content.publish", profile: "standard" });
    expect(caps.data.operations[0].state).toBe("MISSING_SCOPES");
    expect(caps.data.operations[0].missing_scopes).toEqual(["write"]);
    const up = await connect(ctx, { mode: "upgrade", account_id: member });
    expect(up.status.status).toBe("connected");
    const after = await ctx.call("social_capabilities_get", { account_id: member, domain: "content.publish.text" });
    expect(after.data.operations[0].state).toBe("NEEDS_APPROVAL");
  });

  test("twenty concurrent reads trigger one refresh per grant revision", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    const g = ctx.app.accounts.grant(member)!;
    const { tokens } = await ctx.app.accounts.tokens(member);
    await ctx.app.accounts.replaceTokens(member, g.revision, { ...tokens, expires_at: new Date(Date.now() - 1000).toISOString() });
    const results = await Promise.all(Array.from({ length: 20 }, () => ctx.call("social_content_list", { account_id: member })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(ctx.remote.refreshCount).toBe(1);
  });

  test("repeated bursts never mark a healthy account as needing reauth", async () => {
    for (let round = 0; round < 25; round++) {
      ctx = await openApp();
      await connect(ctx);
      const { member } = await accounts(ctx);
      const g = ctx.app.accounts.grant(member)!;
      const { tokens } = await ctx.app.accounts.tokens(member);
      await ctx.app.accounts.replaceTokens(member, g.revision, { ...tokens, expires_at: new Date(Date.now() - 1000).toISOString() });
      const results = await Promise.all(Array.from({ length: 20 }, () => ctx.call("social_content_list", { account_id: member })));
      expect(results.filter((r) => !r.ok).map((r) => r.error?.code)).toEqual([]);
      expect(ctx.remote.refreshCount).toBe(1);
      expect(ctx.app.accounts.get(member)!.state).toBe("connected");
      ctx.app.close();
    }
  }, 60000);

  test("two processes refreshing the same grant at once both succeed and the account stays connected", async () => {
    for (let round = 0; round < 15; round++) {
      const first = await openApp();
      await connect(first);
      const { member } = await accounts(first);
      const second = await openApp(first.home, first.keyring);
      const g = first.app.accounts.grant(member)!;
      const { tokens } = await first.app.accounts.tokens(member);
      await first.app.accounts.replaceTokens(member, g.revision, { ...tokens, expires_at: new Date(Date.now() - 1000).toISOString() });
      const calls = [...Array.from({ length: 8 }, () => first.call("social_content_list", { account_id: member })), ...Array.from({ length: 8 }, () => second.call("social_content_list", { account_id: member }))];
      const results = await Promise.all(calls);
      expect(results.filter((r) => !r.ok).map((r) => r.error?.code)).toEqual([]);
      expect(first.app.accounts.get(member)!.state).toBe("connected");
      expect(first.app.accounts.grant(member)!.state).toBe("active");
      first.app.close();
      second.app.close();
    }
  }, 120000);

  test("disconnect revokes at the provider and purges the local grant", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    const plan = await ctx.call("social_auth_disconnect", { mode: "plan", account_id: member });
    approve(ctx, plan.data.approval.approval_id);
    const exec = await ctx.call("social_auth_disconnect", { mode: "execute", plan_id: plan.data.plan_id, operation_id: "op-disconnect-1" });
    expect(exec.data.status).toBe("succeeded");
    expect(ctx.app.accounts.grant(member)).toBeNull();
    const after = await ctx.call("social_content_list", { account_id: member });
    expect(after.error?.code).toBe("NOT_CONNECTED");
  });

  test("every real provider can start consent only after its app is registered, and says how", async () => {
    ctx = await openApp();
    for (const p of ["linkedin", "instagram", "tiktok", "x", "threads", "reddit", "facebook"]) {
      const r = await ctx.call("social_auth_connect", { provider: p });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("APP_APPROVAL_REQUIRED");
      expect(r.error?.actionable_next_step).toContain(`xn-interact app set ${p}`);
    }
  });
});
