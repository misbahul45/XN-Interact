import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { App } from "../../src/app.ts";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { CATALOG } from "../../src/contracts/catalog.ts";
import { MemoryKeyring } from "../../src/identity/keyring.ts";
import { MAX_GRANT_TTL_MS } from "../../src/policy/grants.ts";
import { invoke, TOOL_SPECS } from "../../src/routing/gateway.ts";
import { accounts, connect, openApp, ROOT, tempHome, testEnv, type TestCtx } from "../helpers.ts";

const OWNER = { tty: true as const, user: "test-owner" };
let ctx: TestCtx | undefined;
let extra: App | undefined;
afterEach(() => {
  ctx?.app.close();
  ctx = undefined;
  extra?.close();
  extra = undefined;
});

async function setup() {
  ctx = await openApp();
  await connect(ctx);
  return accounts(ctx);
}

async function makePlan(accountIds: string[], text: string, more: Record<string, unknown> = {}) {
  const draft = await ctx!.call("social_content_create", { text });
  return ctx!.call("social_content_publish", { mode: "plan", account_ids: accountIds, draft_id: draft.data.draft_id, ...more });
}

const run = (planId: string, opId: string) => ctx!.call("social_content_publish", { mode: "execute", plan_id: planId, operation_id: opId });
const grantFor = (account: string, opts: Record<string, number> = {}) => ctx!.app.grants.create("fixture", account, "content.publish.text", opts, OWNER);

describe("standing grants", () => {
  test("a live grant publishes without a terminal approval and the approval records the grant", async () => {
    const { member } = await setup();
    const g = grantFor(member);
    const p = await makePlan([member], "grant post one");
    expect(p.ok, JSON.stringify(p.error)).toBe(true);
    expect(p.data.standing_grant.grant_id).toBe(g.id);
    expect(p.data.standing_grant.remaining_total).toBe(10);
    expect(p.data.next_step).toContain("standing grant");
    const r = await run(p.data.plan_id, "op-grant-one");
    expect(r.data.status).toBe("succeeded");
    expect(ctx!.remote.writeCalls).toHaveLength(1);
    const s = await ctx!.call("social_approvals_status", { approval_id: p.data.approval.approval_id });
    expect(s.data.decision).toBe("approved");
    expect(s.data.consumed).toBe(true);
    expect(s.data.via_standing_grant).toBe(g.id);
    expect(ctx!.app.grants.get(g.id)!.used_total).toBe(1);
    const again = await run(p.data.plan_id, "op-grant-one");
    expect(again.ok).toBe(true);
    expect(ctx!.remote.writeCalls).toHaveLength(1);
    expect(ctx!.app.grants.get(g.id)!.used_total).toBe(1);
  });

  test("without a grant a plan still needs a human approval", async () => {
    const { member } = await setup();
    const p = await makePlan([member], "no grant here");
    expect(p.data.standing_grant).toBeUndefined();
    const r = await run(p.data.plan_id, "op-no-grant");
    expect(r.error?.code).toBe("APPROVAL_REQUIRED");
    expect(ctx!.remote.writeCalls).toHaveLength(0);
  });

  test("a grant never overrides a rejected approval", async () => {
    const { member } = await setup();
    const g = grantFor(member);
    const p = await makePlan([member], "owner said no");
    const a = ctx!.app.approvals.get(p.data.approval.approval_id);
    ctx!.app.approvals.decideFromTrustedTerminal(a.id, "rejected", { tty: true, user: "test-owner", confirmed_hash_prefix: a.plan_hash.slice(0, 8) });
    const r = await run(p.data.plan_id, "op-rejected");
    expect(r.error?.code).toBe("APPROVAL_INVALID");
    expect(ctx!.remote.writeCalls).toHaveLength(0);
    expect(ctx!.app.grants.get(g.id)!.used_total).toBe(0);
  });

  test("the daily limit and the total limit stop the grant", async () => {
    const { member } = await setup();
    const g = grantFor(member, { maxPerDay: 2, maxTotal: 5 });
    for (const n of [1, 2]) {
      const p = await makePlan([member], `daily ${n}`);
      expect((await run(p.data.plan_id, `op-daily-${n}`)).data.status).toBe("succeeded");
    }
    const third = await makePlan([member], "daily 3");
    expect(third.data.standing_grant).toBeUndefined();
    expect((await run(third.data.plan_id, "op-daily-3")).error?.code).toBe("APPROVAL_REQUIRED");
    expect(ctx!.remote.writeCalls).toHaveLength(2);
    expect(ctx!.app.grants.get(g.id)!.used_total).toBe(2);

    const limited = grantFor(member, { maxPerDay: 5, maxTotal: 1 });
    const one = await makePlan([member], "total 1");
    expect((await run(one.data.plan_id, "op-total-1")).data.status).toBe("succeeded");
    expect(ctx!.app.grants.get(limited.id)!.state).toBe("exhausted");
    const two = await makePlan([member], "total 2");
    expect((await run(two.data.plan_id, "op-total-2")).error?.code).toBe("APPROVAL_REQUIRED");
  });

  test("an expired or revoked grant stops immediately", async () => {
    const { member } = await setup();
    const expired = grantFor(member);
    ctx!.app.db.run("UPDATE standing_grants SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), expired.id);
    const a = await makePlan([member], "after expiry");
    expect(a.data.standing_grant).toBeUndefined();
    expect((await run(a.data.plan_id, "op-expired")).error?.code).toBe("APPROVAL_REQUIRED");

    const g = grantFor(member);
    const live = await makePlan([member], "still live");
    expect(live.data.standing_grant.grant_id).toBe(g.id);
    expect(ctx!.app.grants.revoke(g.id)).toBe(true);
    expect((await run(live.data.plan_id, "op-revoked")).error?.code).toBe("APPROVAL_REQUIRED");
    expect(ctx!.remote.writeCalls).toHaveLength(0);
  });

  test("a grant covers only its own account and a single target, never a scheduled plan", async () => {
    const { member, page } = await setup();
    grantFor(member);
    const other = await makePlan([page], "other account");
    expect(other.data.standing_grant).toBeUndefined();
    expect((await run(other.data.plan_id, "op-other")).error?.code).toBe("APPROVAL_REQUIRED");
    const both = await makePlan([member, page], "two targets");
    expect(both.data.standing_grant).toBeUndefined();
    expect((await run(both.data.plan_id, "op-both-targets")).error?.code).toBe("APPROVAL_REQUIRED");
    const later = await makePlan([member], "scheduled", { schedule_at: new Date(Date.now() + 2 * 3600_000).toISOString() });
    expect(later.ok, JSON.stringify(later.error)).toBe(true);
    expect(later.data.standing_grant).toBeUndefined();
    expect((await run(later.data.plan_id, "op-later")).error?.code).toBe("APPROVAL_REQUIRED");
    expect(ctx!.remote.writeCalls).toHaveLength(0);
  });

  test("an unresolved outcome suspends the grant and later plans need the owner again", async () => {
    const { member } = await setup();
    const g = grantFor(member, { maxPerDay: 5, maxTotal: 5 });
    ctx!.remote.faults = ["unprovable_drop"];
    ctx!.remote.save();
    const p = await makePlan([member], "maybe sent");
    const r = await run(p.data.plan_id, "op-unknown");
    expect(r.data.status).toBe("unknown_outcome");
    expect(ctx!.app.grants.get(g.id)!.state).toBe("suspended");
    expect(ctx!.app.grants.get(g.id)!.ended_reason).toBe("unresolved_outcome");
    const next = await makePlan([member], "after the unknown one");
    expect(next.data.standing_grant).toBeUndefined();
    expect((await run(next.data.plan_id, "op-after-unknown")).error?.code).toBe("APPROVAL_REQUIRED");
  });

  test("a grant does not bypass the capability gate: an UNVERIFIED operation cannot even be planned", async () => {
    const seen: string[] = [];
    const impl = (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/oauth/access_token") return Response.json({ access_token: "SHORTTOKEN-aaaaaaaaaaaa", user_id: 111 });
      if (url.pathname === "/access_token") return Response.json({ access_token: "LONGTOKEN-bbbbbbbbbbbb", expires_in: 5183944 });
      if (url.pathname === "/v1.0/me") return Response.json({ id: "111", username: "sample_user" });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    extra = await App.open(loadConfig(testEnv(tempHome())), { keyring: new MemoryKeyring(new Map()), fetchImpl: impl, testClients: { threads: { client_id: "THREADS-APP-ID", client_secret: "THREADS-APP-SECRET-xyz" } } });
    const start = await invoke(extra, "social_auth_connect", { provider: "threads" });
    const auth = new URL((start.data as { auth_url: string }).auth_url);
    const cb = new URL(auth.searchParams.get("redirect_uri")!);
    cb.searchParams.set("code", "AUTHCODE-123");
    cb.searchParams.set("state", auth.searchParams.get("state")!);
    await fetch(cb, { tls: { rejectUnauthorized: false } } as RequestInit);
    const id = extra.accounts.list({ provider: "threads" })[0]!.id;
    extra.grants.create("threads", id, "content.publish.text", {}, OWNER);
    const draft = await invoke(extra, "social_content_create", { text: "gate first" });
    const plan = await invoke(extra, "social_content_publish", { mode: "plan", account_ids: [id], draft_id: (draft.data as { draft_id: string }).draft_id });
    expect(plan.ok).toBe(false);
    expect(plan.error?.code).toBe("UNVERIFIED");
    expect(seen.filter((s) => s.startsWith("POST /v1.0/111"))).toHaveLength(0);
  });

  test("a grant can only be created or revoked by the owner CLI, never through an MCP tool or argument", async () => {
    const { member } = await setup();
    expect(CATALOG.tools.filter((t) => /grant/i.test(t.name))).toEqual([]);
    for (const t of CATALOG.tools) expect(Object.keys(TOOL_SPECS[t.name]!.input.shape).filter((k) => /grant|standing/i.test(k)), t.name).toEqual([]);
    const p = await makePlan([member], "argument tricks");
    for (const smuggled of [{ standing_grant: true }, { grant_id: "gnt_x" }, { grant: true }]) {
      const r = await ctx!.call("social_content_publish", { mode: "execute", plan_id: p.data.plan_id, operation_id: `op-smuggle-${Object.keys(smuggled)[0]}`, ...smuggled });
      expect(r.ok).toBe(false);
    }
    expect(ctx!.remote.writeCalls).toHaveLength(0);
    expect(ctx!.app.grants.list()).toEqual([]);

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts") && /grants\.(create|revoke)\(/.test(readFileSync(path, "utf8")) && relative(join(ROOT, "src"), path) !== "cli.ts") offenders.push(relative(ROOT, path));
      }
    };
    walk(join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });

  test("grant limits are enforced: lifetime, counts and the operations a grant may cover", async () => {
    const { member } = await setup();
    const make = (op: string, opts: Record<string, number> = {}) => () => ctx!.app.grants.create("fixture", member, op, opts, OWNER);
    expect(make("content.publish.text", { ttlMs: MAX_GRANT_TTL_MS + 1 })).toThrow("at most 24 hours");
    expect(make("content.publish.text", { maxPerDay: 11 })).toThrow("max per day");
    expect(make("content.publish.text", { maxTotal: 51 })).toThrow("max total");
    expect(make("content.publish.text", { maxPerDay: 0 })).toThrow("max per day");
    for (const op of ["content.publish.image", "content.publish.video", "content.update", "content.delete", "engagement.reply", "auth.revoke"]) expect(make(op), op).toThrow("can only cover");
    const first = ctx!.app.grants.create("fixture", member, "content.publish.text", {}, OWNER);
    const second = ctx!.app.grants.create("fixture", member, "content.publish.text", {}, OWNER);
    expect(ctx!.app.grants.get(first.id)!.state).toBe("revoked");
    expect(ctx!.app.grants.get(second.id)!.state).toBe("active");
    expect(ctx!.app.grants.live(member, "content.publish.text")!.id).toBe(second.id);
  });
});

describe("xn-interact grant (CLI)", () => {
  test("creating and revoking need a terminal; listing works without one", () => {
    const home = tempHome();
    const env = { ...testEnv(home, { XN_INTERACT_KEYRING: "file" }), PATH: process.env.PATH ?? "" };
    const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), ...args], { env });
    cli("vault", "init");
    const create = cli("grant", "create", "threads", "content.publish.text", "--account", "acc_x");
    expect(create.exitCode).not.toBe(0);
    expect(create.stderr.toString()).toContain("interactive terminal");
    const revoke = cli("grant", "revoke", "gnt_x");
    expect(revoke.exitCode).not.toBe(0);
    expect(revoke.stderr.toString()).toContain("interactive terminal");
    const list = cli("grant", "list");
    expect(list.exitCode).toBe(0);
    expect(list.stdout.toString()).toContain("no standing grants");
  });
});
