import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { App } from "../../src/app.ts";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { MemoryKeyring } from "../../src/identity/keyring.ts";
import { Acceptance } from "../../src/policy/acceptance.ts";
import type { AdapterContext } from "../../src/providers/contract.ts";
import { ThreadsAdapter, threadsTextLength } from "../../src/providers/threads/adapter.ts";
import { invoke } from "../../src/routing/gateway.ts";
import { ROOT, tempHome, testEnv } from "../helpers.ts";

const TEXT = "Acceptance suite sample text 🧪\n\nSecond line of the sample.";
const POST_ID = "900000000000001";

interface Seen {
  method: string;
  url: URL;
  body: string;
}

interface Script {
  list?: () => Response;
  container?: () => Response;
  status?: () => Response;
  publish?: () => Response;
}

let app: App;
afterEach(() => app?.close());

function makeFetch(script: Script = {}) {
  const seen: Seen[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    const method = init?.method ?? "GET";
    seen.push({ method, url, body });
    const p = url.pathname;
    if (p === "/oauth/access_token") return Response.json({ access_token: "SHORTTOKEN-aaaaaaaaaaaa", user_id: 111 });
    if (p === "/access_token") return Response.json({ access_token: "LONGTOKEN-bbbbbbbbbbbb", expires_in: 5183944 });
    if (p === "/v1.0/me") return Response.json({ id: "111", username: "sample_user" });
    if (method === "POST" && p === "/v1.0/111/threads") return script.container?.() ?? Response.json({ id: "CONTAINER-1" });
    if (p === "/v1.0/CONTAINER-1") return script.status?.() ?? Response.json({ status: "FINISHED" });
    if (method === "POST" && p === "/v1.0/111/threads_publish") return script.publish?.() ?? Response.json({ id: POST_ID });
    if (p === `/v1.0/${POST_ID}`) return Response.json({ id: POST_ID, permalink: "https://www.threads.com/@sample/post/ABC", timestamp: new Date().toISOString() });
    if (p === "/v1.0/111/threads") return script.list?.() ?? Response.json({ data: [{ id: POST_ID, text: TEXT, permalink: "https://www.threads.com/@sample/post/ABC", timestamp: new Date().toISOString() }] });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { seen, impl };
}

async function open(impl: typeof fetch) {
  const home = tempHome();
  app = await App.open(loadConfig(testEnv(home)), { keyring: new MemoryKeyring(new Map()), fetchImpl: impl, testClients: { threads: { client_id: "THREADS-APP-ID", client_secret: "THREADS-APP-SECRET-xyz" } } });
  const start = await invoke(app, "social_auth_connect", { provider: "threads" });
  const auth = new URL((start.data as { auth_url: string }).auth_url);
  const cb = new URL(auth.searchParams.get("redirect_uri")!);
  cb.searchParams.set("code", "AUTHCODE-123");
  cb.searchParams.set("state", auth.searchParams.get("state")!);
  await fetch(cb, { tls: { rejectUnauthorized: false } } as RequestInit);
  return app.accounts.list({ provider: "threads" })[0]!.id;
}

async function planPublish(id: string, text = TEXT) {
  const draft = await invoke(app, "social_content_create", { text });
  return invoke(app, "social_content_publish", { mode: "plan", account_ids: [id], draft_id: (draft.data as { draft_id: string }).draft_id });
}

async function approveAndExecute(plan: Awaited<ReturnType<typeof planPublish>>, opId: string) {
  const d = plan.data as { plan_id: string; approval: { approval_id: string } };
  const a = app.approvals.get(d.approval.approval_id);
  app.approvals.decideFromTrustedTerminal(a.id, "approved", { tty: true, user: "test-owner", confirmed_hash_prefix: a.plan_hash.slice(0, 8) });
  return invoke(app, "social_content_publish", { mode: "execute", plan_id: d.plan_id, operation_id: opId });
}

const posts = (seen: Seen[]) => seen.filter((s) => s.method === "POST" && s.url.pathname === "/v1.0/111/threads_publish");

describe("Threads acceptance run through the real gateway (mocked HTTP)", () => {
  test("not armed: publishing cannot even be planned, and nothing is sent", async () => {
    const { seen, impl } = makeFetch();
    const id = await open(impl);
    const plan = await planPublish(id);
    expect(plan.ok).toBe(false);
    expect(plan.error?.code).toBe("UNVERIFIED");
    expect(seen.filter((s) => s.method === "POST" && s.url.pathname.startsWith("/v1.0/111"))).toHaveLength(0);
  });

  test("armed: one approved plan publishes exactly once, is read back, and the arming is spent", async () => {
    const { seen, impl } = makeFetch();
    const id = await open(impl);
    app.acceptance.arm("threads", id, "content.publish.text");
    expect(app.resolver.resolve(id, "content.publish.text").state).toBe("NEEDS_APPROVAL");
    expect(app.resolver.resolve(id, "content.publish.image").state).toBe("UNVERIFIED");
    expect(app.resolver.resolve(id, "content.update").state).toBe("UNVERIFIED");

    const plan = await planPublish(id);
    expect(plan.ok, JSON.stringify(plan.error)).toBe(true);
    const exec = await approveAndExecute(plan, "op-threads-accept-1");
    expect(exec.ok, JSON.stringify(exec.error)).toBe(true);
    expect((exec.data as { status: string }).status).toBe("succeeded");

    const container = seen.find((s) => s.method === "POST" && s.url.pathname === "/v1.0/111/threads")!;
    const sent = new URLSearchParams(container.body);
    expect(sent.get("media_type")).toBe("TEXT");
    expect(sent.get("text")).toBe(TEXT);
    expect(sent.get("access_token")).toBe("LONGTOKEN-bbbbbbbbbbbb");
    expect(container.url.search).toBe("");
    expect(posts(seen)).toHaveLength(1);
    expect(new URLSearchParams(posts(seen)[0]!.body).get("creation_id")).toBe("CONTAINER-1");

    const verify = app.db.all<{ detail_json: string }>("SELECT detail_json FROM workflow_steps WHERE step_id = 'verify'");
    expect(verify.map((r) => JSON.parse(r.detail_json).verified)).toContain(true);

    const rows = app.acceptance.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("consumed");
    expect(rows[0]!.consumed_by_intent).toBeTruthy();
    expect(app.resolver.resolve(id, "content.publish.text").state).toBe("UNVERIFIED");
    const again = await planPublish(id);
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe("UNVERIFIED");
    expect(posts(seen)).toHaveLength(1);
  });

  test("a server error on the publish request is an unknown outcome: sent once, never retried, arming spent", async () => {
    const { seen, impl } = makeFetch({ publish: () => new Response("{}", { status: 502 }), list: () => Response.json({ data: [] }) });
    const id = await open(impl);
    app.acceptance.arm("threads", id, "content.publish.text");
    const plan = await planPublish(id);
    const exec = await approveAndExecute(plan, "op-threads-accept-2");
    expect((exec.data as { status?: string })?.status).not.toBe("succeeded");
    expect(posts(seen)).toHaveLength(1);
    expect(app.acceptance.list()[0]!.state).toBe("consumed");
    await invoke(app, "social_content_publish", { mode: "execute", plan_id: (plan.data as { plan_id: string }).plan_id, operation_id: "op-threads-accept-2" });
    expect(posts(seen)).toHaveLength(1);
  });

  test("a server error on publish where the post did land is reconciled by read-back: still exactly one publish request", async () => {
    const { seen, impl } = makeFetch({ publish: () => new Response("{}", { status: 502 }) });
    const id = await open(impl);
    app.acceptance.arm("threads", id, "content.publish.text");
    const exec = await approveAndExecute(await planPublish(id), "op-threads-accept-2b");
    expect((exec.data as { status?: string })?.status).toBe("succeeded");
    expect(posts(seen)).toHaveLength(1);
  });

  test("a container the provider cannot prepare publishes nothing and keeps the arming", async () => {
    const { seen, impl } = makeFetch({ status: () => Response.json({ status: "ERROR", error_message: "UNKNOWN" }) });
    const id = await open(impl);
    app.acceptance.arm("threads", id, "content.publish.text");
    const exec = await approveAndExecute(await planPublish(id), "op-threads-accept-3");
    expect((exec.data as { status?: string })?.status).not.toBe("succeeded");
    expect(posts(seen)).toHaveLength(0);
    expect(app.acceptance.list()[0]!.state).toBe("armed");
  });

  test("an expired arming is ignored even when the snapshot was cached while it was live", async () => {
    const { impl } = makeFetch();
    const id = await open(impl);
    app.acceptance.arm("threads", id, "content.publish.text", 150);
    expect(app.resolver.resolve(id, "content.publish.text").state).toBe("NEEDS_APPROVAL");
    await Bun.sleep(260);
    expect(app.resolver.resolve(id, "content.publish.text").state).toBe("UNVERIFIED");
  });
});

describe("Acceptance store", () => {
  test("one live arming per account and operation, single use, capped lifetime, scoped to its account", async () => {
    const { impl } = makeFetch();
    const id = await open(impl);
    const a = app.acceptance.arm("threads", id, "content.publish.text");
    const b = app.acceptance.arm("threads", id, "content.publish.text");
    expect(app.acceptance.get(a.id)!.state).toBe("revoked");
    expect(app.acceptance.armed(id, "content.publish.text")!.id).toBe(b.id);
    expect(app.acceptance.armed(id, "content.read")).toBeUndefined();
    expect(app.acceptance.armed("acc_other", "content.publish.text")).toBeUndefined();
    expect(() => app.acceptance.arm("threads", id, "content.publish.text", 2 * 3600_000)).toThrow();
    expect(app.acceptance.consume(id, "content.publish.text", "int_1")).toBe(true);
    expect(app.acceptance.consume(id, "content.publish.text", "int_2")).toBe(false);
  });

  test("a clock past the expiry spends nothing", async () => {
    const { impl } = makeFetch();
    const id = await open(impl);
    let now = Date.now();
    const store = new Acceptance(app.db, () => now);
    store.arm("threads", id, "content.publish.text", 1000);
    expect(store.armed(id, "content.publish.text")).toBeDefined();
    now += 2000;
    expect(store.armed(id, "content.publish.text")).toBeUndefined();
    expect(store.consume(id, "content.publish.text", "int")).toBe(false);
  });
});

function res(status: number, body: unknown) {
  return { status, headers: new Headers(), text: JSON.stringify(body), json: <T>() => body as T };
}

function direct(handler: (method: string, url: URL, body: string) => { status: number; body: unknown }) {
  const calls: { method: string; url: URL; body: string }[] = [];
  const http = {
    request: async (_p: string, req: { method: string; url: string; body?: unknown }) => {
      const url = new URL(req.url);
      const body = req.body instanceof URLSearchParams ? req.body.toString() : String(req.body ?? "");
      calls.push({ method: req.method, url, body });
      const r = handler(req.method, url, body);
      return res(r.status, r.body);
    },
  };
  const ctx = { account: { account_id: "acc_1", provider: "threads", provider_subject: "111", account_type: "profile", role: null }, tokens: { access_token: "TOK", expires_at: null, scopes: [], token_type: "bearer" }, http } as unknown as AdapterContext;
  return { calls, adapter: new ThreadsAdapter({ http: http as never }, { sleep: async () => {}, maxPolls: 3 }), ctx };
}

const REQ = (text: string) => ({ operation: "content.publish.text", params: { text }, intent_id: "int_1", dedupe_key: "dk_1" });

describe("Threads adapter operations", () => {
  test("it waits for IN_PROGRESS containers, then publishes; gives up without publishing when it never finishes", async () => {
    let polls = 0;
    const ok = direct((m, u) => {
      if (m === "POST" && u.pathname === "/v1.0/111/threads") return { status: 200, body: { id: "C1" } };
      if (u.pathname === "/v1.0/C1") return { status: 200, body: { status: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" } };
      if (m === "POST") return { status: 200, body: { id: POST_ID } };
      return { status: 200, body: { id: POST_ID, permalink: "https://www.threads.com/p/1" } };
    });
    const r = await ok.adapter.write(REQ("hello"), ok.ctx);
    expect(r).toMatchObject({ provider_ref: POST_ID, url: "https://www.threads.com/p/1" });
    expect(polls).toBe(3);

    const stuck = direct((m, u) => (u.pathname === "/v1.0/111/threads" ? { status: 200, body: { id: "C1" } } : { status: 200, body: { status: "IN_PROGRESS" } }));
    await expect(stuck.adapter.write(REQ("hello"), stuck.ctx)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(stuck.calls.some((c) => c.url.pathname.endsWith("threads_publish"))).toBe(false);
  });

  test("a rejected publish is a plain failure, a 5xx is an unknown outcome, and a missing post id is an unknown outcome", async () => {
    const base = (publish: { status: number; body: unknown }) => direct((m, u) => (u.pathname === "/v1.0/111/threads" ? { status: 200, body: { id: "C1" } } : u.pathname === "/v1.0/C1" ? { status: 200, body: { status: "FINISHED" } } : publish));
    await expect(base({ status: 400, body: { error: { message: "Invalid parameter" } } }).adapter.write(REQ("x"), base({ status: 400, body: {} }).ctx)).rejects.toMatchObject({ code: expect.stringMatching(/PROVIDER_ERROR|REAUTH_REQUIRED/) });
    const five = base({ status: 503, body: {} });
    await expect(five.adapter.write(REQ("x"), five.ctx)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    const noId = base({ status: 200, body: {} });
    await expect(noId.adapter.write(REQ("x"), noId.ctx)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(five.calls.filter((c) => c.url.pathname.endsWith("threads_publish"))).toHaveLength(1);
  });

  test("text is checked before anything is sent: empty, over 500, and emoji count as their UTF-8 bytes", async () => {
    expect(threadsTextLength("a".repeat(500))).toBe(500);
    expect(threadsTextLength("a".repeat(501))).toBe(501);
    expect(threadsTextLength("😀".repeat(125))).toBe(500);
    expect(threadsTextLength("😀".repeat(126))).toBe(504);
    const d = direct(() => ({ status: 200, body: { id: "C1" } }));
    await expect(d.adapter.write(REQ(""), d.ctx)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(d.adapter.write(REQ("😀".repeat(126)), d.ctx)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(d.adapter.write({ ...REQ("hi"), operation: "content.publish.image" }, d.ctx)).rejects.toMatchObject({ code: "UNVERIFIED" });
    expect(d.calls).toHaveLength(0);
  });

  test("read-back finds an identical recent post, and never claims a post is absent", async () => {
    const found = direct(() => ({ status: 200, body: { data: [{ id: "1", text: "other", timestamp: new Date().toISOString() }, { id: "2", text: "mine", permalink: "https://t/2", timestamp: new Date().toISOString() }] } }));
    expect(await found.adapter.inspectWriteOutcome(REQ("mine"), found.ctx)).toMatchObject({ found: true, provider_ref: "2", url: "https://t/2" });
    const old = direct(() => ({ status: 200, body: { data: [{ id: "2", text: "mine", timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString() }] } }));
    expect((await old.adapter.inspectWriteOutcome(REQ("mine"), old.ctx)).found).toBeNull();
    const none = direct(() => ({ status: 200, body: { data: [] } }));
    expect((await none.adapter.inspectWriteOutcome(REQ("mine"), none.ctx)).found).toBeNull();
    const down = direct(() => ({ status: 500, body: {} }));
    expect((await down.adapter.inspectWriteOutcome(REQ("mine"), down.ctx)).found).toBeNull();
  });

  test("account and content reads use bounded, validated requests; other operations stay unverified", async () => {
    const d = direct((m, u) => (u.pathname === "/v1.0/me" ? { status: 200, body: { id: "111", username: "sample_user" } } : u.pathname === "/v1.0/111/threads" ? { status: 200, body: { data: [{ id: "1" }, { id: "2" }], paging: { cursors: { after: "CUR" } } } } : { status: 200, body: { id: "123456" } }));
    expect((await d.adapter.read("account.read", d.ctx, {})).item).toMatchObject({ username: "sample_user" });
    const list = await d.adapter.read("content.read", d.ctx, { limit: 2 });
    expect(list.items).toHaveLength(2);
    expect(list.next_cursor).toBe("CUR");
    expect(d.calls.at(-1)!.url.searchParams.get("limit")).toBe("2");
    await expect(d.adapter.read("content.read", d.ctx, { content_id: "../me" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await d.adapter.read("content.read", d.ctx, { content_id: "123456" })).item).toMatchObject({ id: "123456" });
    await expect(d.adapter.read("analytics.read", d.ctx, {})).rejects.toMatchObject({ code: "UNVERIFIED" });
  });
});

describe("xn-interact accept (CLI)", () => {
  test("arming needs a terminal; listing works without one", () => {
    const home = tempHome();
    const env = { ...testEnv(home, { XN_INTERACT_KEYRING: "file" }), PATH: process.env.PATH ?? "" };
    Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "vault", "init"], { env });
    const arm = Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "accept", "threads", "content.publish.text", "--account", "acc_x"], { env });
    expect(arm.exitCode).not.toBe(0);
    expect(arm.stderr.toString()).toContain("interactive terminal");
    const list = Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "accept", "list"], { env });
    expect(list.exitCode).toBe(0);
    expect(list.stdout.toString()).toContain("no acceptance runs");
  });

  test("first-post needs a terminal too, and sends nothing without one", () => {
    const home = tempHome();
    const env = { ...testEnv(home, { XN_INTERACT_KEYRING: "file" }), PATH: process.env.PATH ?? "" };
    Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "vault", "init"], { env });
    const r = Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "first-post", "threads", "--text-file", "/dev/null"], { env });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("interactive terminal");
  });
});
