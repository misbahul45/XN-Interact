import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { App } from "../../src/app.ts";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { CATALOG } from "../../src/contracts/catalog.ts";
import { MemoryKeyring } from "../../src/identity/keyring.ts";
import { invoke, TOOL_SPECS } from "../../src/routing/gateway.ts";
import { ROOT, tempHome, testEnv } from "../helpers.ts";

const OWNER = { tty: true as const, user: "test-owner" };
const OP = "content.publish.text";
let app: App | undefined;
afterEach(() => {
  app?.close();
  app = undefined;
});

interface Seen {
  method: string;
  path: string;
}

function makeFetch() {
  const seen: Seen[] = [];
  const posts: { id: string; text: string }[] = [];
  const containers = new Map<string, string>();
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const p = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    seen.push({ method, path: p });
    if (p === "/oauth/access_token") return Response.json({ access_token: "SHORTTOKEN-aaaaaaaaaaaa", user_id: 111 });
    if (p === "/access_token") return Response.json({ access_token: "LONGTOKEN-bbbbbbbbbbbb", expires_in: 5183944 });
    if (p === "/v1.0/me") return Response.json({ id: "111", username: "sample_user" });
    if (method === "POST" && p === "/v1.0/111/threads") {
      const id = `CONTAINER-${containers.size + 1}`;
      containers.set(id, new URLSearchParams(body).get("text") ?? "");
      return Response.json({ id });
    }
    if (/^\/v1\.0\/CONTAINER-\d+$/.test(p)) return Response.json({ status: "FINISHED" });
    if (method === "POST" && p === "/v1.0/111/threads_publish") {
      const id = `POST-${posts.length + 1}`;
      posts.push({ id, text: containers.get(new URLSearchParams(body).get("creation_id") ?? "") ?? "" });
      return Response.json({ id });
    }
    const one = p.match(/^\/v1\.0\/(POST-\d+)$/);
    if (one) return Response.json({ id: one[1], permalink: `https://www.threads.com/@sample/post/${one[1]}`, timestamp: new Date().toISOString() });
    if (p === "/v1.0/111/threads") return Response.json({ data: posts.map((x) => ({ id: x.id, text: x.text, permalink: `https://www.threads.com/@sample/post/${x.id}`, timestamp: new Date().toISOString() })) });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { seen, posts, impl };
}

async function open() {
  const m = makeFetch();
  app = await App.open(loadConfig(testEnv(tempHome())), { keyring: new MemoryKeyring(new Map()), fetchImpl: m.impl, testClients: { threads: { client_id: "THREADS-APP-ID", client_secret: "THREADS-APP-SECRET-xyz" } } });
  const start = await invoke(app, "social_auth_connect", { provider: "threads" });
  const auth = new URL((start.data as { auth_url: string }).auth_url);
  const cb = new URL(auth.searchParams.get("redirect_uri")!);
  cb.searchParams.set("code", "AUTHCODE-123");
  cb.searchParams.set("state", auth.searchParams.get("state")!);
  await fetch(cb, { tls: { rejectUnauthorized: false } } as RequestInit);
  return { ...m, id: app.accounts.list({ provider: "threads" })[0]!.id };
}

async function planOf(id: string, text: string) {
  const draft = await invoke(app!, "social_content_create", { text });
  return invoke(app!, "social_content_publish", { mode: "plan", account_ids: [id], draft_id: (draft.data as { draft_id: string }).draft_id });
}

const execOf = (plan: Awaited<ReturnType<typeof planOf>>, opId: string) => invoke(app!, "social_content_publish", { mode: "execute", plan_id: (plan.data as { plan_id: string }).plan_id, operation_id: opId });

function humanApprove(plan: Awaited<ReturnType<typeof planOf>>) {
  const a = app!.approvals.get((plan.data as { approval: { approval_id: string } }).approval.approval_id);
  app!.approvals.decideFromTrustedTerminal(a.id, "approved", { tty: true, user: "test-owner", confirmed_hash_prefix: a.plan_hash.slice(0, 8) });
}

/** The real first post: arm, plan, human approval, execute. */
async function acceptanceRun(id: string, text = "first post for acceptance") {
  app!.acceptance.arm("threads", id, OP);
  const plan = await planOf(id, text);
  expect(plan.ok, JSON.stringify(plan.error)).toBe(true);
  humanApprove(plan);
  const r = await execOf(plan, "op-acceptance-run");
  expect((r.data as { status: string }).status).toBe("succeeded");
}

const publishPosts = (seen: Seen[]) => seen.filter((s) => s.method === "POST" && s.path === "/v1.0/111/threads_publish");
const state = (id: string, op: string) => app!.resolver.resolve(id, op).state;

describe("evidence signoffs", () => {
  test("signing needs a real, successful acceptance run: without one it is refused and nothing changes", async () => {
    const { id } = await open();
    expect(() => app!.signoffs.sign("threads", id, OP, {}, OWNER)).toThrow("no successful acceptance run");
    app!.acceptance.arm("threads", id, OP);
    expect(() => app!.signoffs.sign("threads", id, OP, {}, OWNER)).toThrow("no successful acceptance run");
    expect(state(id, OP)).toBe("NEEDS_APPROVAL");
    app!.acceptance.revoke(app!.acceptance.list()[0]!.id);
    expect(state(id, OP)).toBe("UNVERIFIED");
    expect(app!.signoffs.list()).toEqual([]);
  });

  test("after a real approved acceptance run a signoff makes the operation usable after an approval, without a new arming", async () => {
    const { id, seen } = await open();
    await acceptanceRun(id);
    expect(state(id, OP)).toBe("UNVERIFIED");
    const signoff = app!.signoffs.sign("threads", id, OP, {}, OWNER);
    expect(signoff.basis_run_id).toMatch(/^run_/);
    expect(state(id, OP)).toBe("NEEDS_APPROVAL");
    expect(app!.resolver.resolve(id, OP).reason).toContain("owner-signed");
    for (const other of ["content.publish.image", "content.publish.video", "content.update", "content.delete", "engagement.reply"]) expect(state(id, other), other).toBe("UNVERIFIED");

    const second = await planOf(id, "second post after the signoff");
    expect(second.ok, JSON.stringify(second.error)).toBe(true);
    expect((second.data as { standing_grant?: unknown }).standing_grant).toBeUndefined();
    expect((await execOf(second, "op-second-no-approval")).error?.code).toBe("APPROVAL_REQUIRED");
    expect(publishPosts(seen)).toHaveLength(1);
    humanApprove(second);
    expect(((await execOf(second, "op-second-approved")).data as { status: string }).status).toBe("succeeded");
    expect(publishPosts(seen)).toHaveLength(2);
  });

  test("a signoff plus a standing grant lets the MCP publish on its own, within the grant's limits", async () => {
    const { id, seen } = await open();
    await acceptanceRun(id);
    app!.signoffs.sign("threads", id, OP, {}, OWNER);
    const g = app!.grants.create("threads", id, OP, { maxPerDay: 1, maxTotal: 5 }, OWNER);
    const auto = await planOf(id, "published by the gateway on its own");
    expect((auto.data as { standing_grant: { grant_id: string } }).standing_grant.grant_id).toBe(g.id);
    expect(((await execOf(auto, "op-auto-publish")).data as { status: string }).status).toBe("succeeded");
    expect(publishPosts(seen)).toHaveLength(2);
    const over = await planOf(id, "over the daily limit");
    expect((over.data as { standing_grant?: unknown }).standing_grant).toBeUndefined();
    expect((await execOf(over, "op-over-limit")).error?.code).toBe("APPROVAL_REQUIRED");
    expect(publishPosts(seen)).toHaveLength(2);
  });

  test("an expired or revoked signoff makes the operation UNVERIFIED again at once, even with a cached snapshot", async () => {
    const { id, seen } = await open();
    await acceptanceRun(id);
    const s1 = app!.signoffs.sign("threads", id, OP, {}, OWNER);
    expect(state(id, OP)).toBe("NEEDS_APPROVAL");
    expect(app!.signoffs.revoke(s1.id)).toBe(true);
    expect(state(id, OP)).toBe("UNVERIFIED");
    const refused = await planOf(id, "after revoke");
    expect(refused.error?.code).toBe("UNVERIFIED");

    const s2 = app!.signoffs.sign("threads", id, OP, {}, OWNER);
    expect(state(id, OP)).toBe("NEEDS_APPROVAL");
    app!.db.run("UPDATE evidence_signoffs SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), s2.id);
    expect(state(id, OP)).toBe("UNVERIFIED");
    expect(publishPosts(seen)).toHaveLength(1);
  });

  test("evidence can only be signed or revoked by the owner CLI, never through an MCP tool or argument", async () => {
    await open();
    expect(CATALOG.tools.filter((t) => /signoff|evidence/i.test(t.name))).toEqual([]);
    for (const t of CATALOG.tools) expect(Object.keys(TOOL_SPECS[t.name]!.input.shape).filter((k) => /signoff|evidence|signed/i.test(k)), t.name).toEqual([]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts") && /signoffs\.(sign|revoke)\(/.test(readFileSync(path, "utf8")) && relative(join(ROOT, "src"), path) !== "cli.ts") offenders.push(relative(ROOT, path));
      }
    };
    walk(join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });

  test("a signoff is scoped to its account and one operation, and its lifetime is bounded", async () => {
    const { id } = await open();
    await acceptanceRun(id);
    for (const op of ["content.publish.image", "content.publish.video", "content.update", "content.delete", "account.read", "auth.revoke"]) expect(() => app!.signoffs.sign("threads", id, op, {}, OWNER), op).toThrow("can only be signed");
    expect(() => app!.signoffs.sign("threads", id, OP, { days: 91 }, OWNER)).toThrow("at most 90 days");
    expect(() => app!.signoffs.sign("threads", id, OP, { days: 0 }, OWNER)).toThrow("at most 90 days");
    const s = app!.signoffs.sign("threads", id, OP, { days: 30 }, OWNER);
    expect(Date.parse(s.expires_at) - Date.parse(s.signed_at)).toBe(30 * 86_400_000);
    expect(app!.signoffs.active("acc_someone_else_000", OP)).toBeUndefined();
    const again = app!.signoffs.sign("threads", id, OP, {}, OWNER);
    expect(app!.signoffs.get(s.id)!.state).toBe("revoked");
    expect(app!.signoffs.active(id, OP)!.id).toBe(again.id);
  });
});

describe("xn-interact evidence (CLI)", () => {
  test("signing and revoking need a terminal; listing works without one", () => {
    const home = tempHome();
    const env = { ...testEnv(home, { XN_INTERACT_KEYRING: "file" }), PATH: process.env.PATH ?? "" };
    const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), ...args], { env });
    cli("vault", "init");
    const sign = cli("evidence", "sign", "threads", OP, "--account", "acc_x");
    expect(sign.exitCode).not.toBe(0);
    expect(sign.stderr.toString()).toContain("interactive terminal");
    const revoke = cli("evidence", "revoke", "evs_x");
    expect(revoke.exitCode).not.toBe(0);
    expect(revoke.stderr.toString()).toContain("interactive terminal");
    const list = cli("evidence", "list");
    expect(list.exitCode).toBe(0);
    expect(list.stdout.toString()).toContain("no evidence signoffs");
  });
});
