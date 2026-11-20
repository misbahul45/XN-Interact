import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "../../src/app.ts";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { MemoryKeyring } from "../../src/identity/keyring.ts";
import { invoke } from "../../src/routing/gateway.ts";
import { approve, tempHome, testEnv } from "../helpers.ts";

interface Seen {
  method: string;
  url: URL;
  body: string;
}

let app: App;
afterEach(() => app?.close());

function makeFetch(script: { me?: () => Response; refresh?: () => Response } = {}) {
  const seen: Seen[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    seen.push({ method: init?.method ?? "GET", url, body });
    if (url.pathname === "/oauth/access_token") return Response.json({ access_token: "SHORTTOKEN-aaaaaaaaaaaa", token_type: "bearer", user_id: 111 });
    if (url.pathname === "/access_token") return Response.json({ access_token: "LONGTOKEN-bbbbbbbbbbbb", token_type: "bearer", expires_in: 5183944 });
    if (url.pathname === "/refresh_access_token") return script.refresh?.() ?? Response.json({ access_token: "REFRESHED-cccccccccccc", token_type: "bearer", expires_in: 5183944 });
    if (url.pathname === "/v1.0/me") return script.me?.() ?? Response.json({ id: "111", username: "owner_threads", name: "Owner" });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { seen, impl };
}

async function open(fetchImpl: typeof fetch, withApp = true) {
  const home = tempHome();
  app = await App.open(loadConfig(testEnv(home)), {
    keyring: new MemoryKeyring(new Map()),
    fetchImpl,
    testClients: withApp ? { threads: { client_id: "THREADS-APP-ID", client_secret: "THREADS-APP-SECRET-xyz" } } : {},
  });
  return home;
}

async function connectThreads() {
  const start = await invoke(app, "social_auth_connect", { provider: "threads" });
  expect(start.ok).toBe(true);
  const auth = new URL((start.data as { auth_url: string }).auth_url);
  const cb = new URL(auth.searchParams.get("redirect_uri")!);
  cb.searchParams.set("code", "AUTHCODE-123#_".replace("#_", ""));
  cb.searchParams.set("state", auth.searchParams.get("state")!);
  const res = await fetch(cb, { tls: { rejectUnauthorized: false } } as RequestInit);
  return { auth, status: res.status, attempt: (start.data as { attempt_id: string }).attempt_id };
}

describe("Threads login", () => {
  test("the authorization URL follows the official parameters and carries no PKCE challenge", async () => {
    await open(makeFetch().impl);
    const start = await invoke(app, "social_auth_connect", { provider: "threads" });
    const u = new URL((start.data as { auth_url: string }).auth_url);
    expect(u.origin + u.pathname).toBe("https://threads.com/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("THREADS-APP-ID");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("threads_basic,threads_content_publish");
    expect(u.searchParams.get("redirect_uri")).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/threads$/);
    expect(u.searchParams.has("code_challenge")).toBe(false);
    expect(u.searchParams.get("state")!.length).toBeGreaterThan(30);
  });

  test("consent exchanges the code, upgrades to a long-lived token, reads the profile and stores an encrypted grant", async () => {
    const { seen, impl } = makeFetch();
    const home = await open(impl);
    const { status, attempt } = await connectThreads();
    expect(status).toBe(200);
    const st = await invoke(app, "social_auth_status", { attempt_id: attempt });
    expect((st.data as { status: string }).status).toBe("connected");
    expect(seen.map((s) => `${s.method} ${s.url.pathname}`)).toEqual(["POST /oauth/access_token", "GET /access_token", "GET /v1.0/me"]);
    expect(new URLSearchParams(seen[0]!.body).get("grant_type")).toBe("authorization_code");
    expect(new URLSearchParams(seen[0]!.body).get("client_secret")).toBe("THREADS-APP-SECRET-xyz");
    expect(seen[1]!.url.searchParams.get("grant_type")).toBe("th_exchange_token");
    expect(seen[1]!.url.searchParams.get("access_token")).toBe("SHORTTOKEN-aaaaaaaaaaaa");
    expect(seen[2]!.url.searchParams.get("access_token")).toBe("LONGTOKEN-bbbbbbbbbbbb");
    const list = await invoke(app, "social_accounts_list", { provider: "threads", profile: "standard" });
    const acc = (list.data as { accounts: Record<string, unknown>[] }).accounts[0]!;
    expect(acc.display_name).toBe("owner_threads");
    expect(acc.account_type).toBe("profile");
    expect(JSON.stringify(list)).not.toContain("LONGTOKEN");
    app.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const f of readdirSync(home)) if (f.startsWith("xn-interact.sqlite")) expect(readFileSync(join(home, f)).toString("latin1")).not.toContain("LONGTOKEN");
    const grant = app.accounts.grant(acc.account_id as string)!;
    expect(Date.parse(grant.expires_at!) - Date.now()).toBeGreaterThan(59 * 86_400_000);
  });

  test("operations stay UNVERIFIED after login: publishing cannot be planned", async () => {
    await open(makeFetch().impl);
    await connectThreads();
    const id = app.accounts.list({ provider: "threads" })[0]!.id;
    const caps = await invoke(app, "social_capabilities_get", { account_id: id, domain: "content.publish", profile: "standard" });
    expect((caps.data as { operations: { state: string }[] }).operations[0]!.state).toBe("UNVERIFIED");
    const draft = await invoke(app, "social_content_create", { text: "hello" });
    const plan = await invoke(app, "social_content_publish", { mode: "plan", account_ids: [id], draft_id: (draft.data as { draft_id: string }).draft_id });
    expect(plan.ok).toBe(false);
    expect(plan.error?.code).toBe("UNVERIFIED");
  });

  test("the long-lived token refreshes with the token itself; a rejected refresh marks the account for reconnection", async () => {
    let reject = false;
    const { seen, impl } = makeFetch({ refresh: () => (reject ? Response.json({ error: { message: "Invalid OAuth access token", code: 190 } }, { status: 400 }) : Response.json({ access_token: "REFRESHED-cccccccccccc", expires_in: 5183944 })) });
    await open(impl);
    await connectThreads();
    const id = app.accounts.list({ provider: "threads" })[0]!.id;
    const g = app.accounts.grant(id)!;
    const { tokens } = await app.accounts.tokens(id);
    await app.accounts.replaceTokens(id, g.revision, { ...tokens, expires_at: new Date(Date.now() - 1000).toISOString() });
    const fresh = await app.tokens.usable(id);
    expect(fresh.access_token).toBe("REFRESHED-cccccccccccc");
    const call = seen.find((s) => s.url.pathname === "/refresh_access_token")!;
    expect(call.url.searchParams.get("grant_type")).toBe("th_refresh_token");
    expect(call.url.searchParams.get("access_token")).toBe("LONGTOKEN-bbbbbbbbbbbb");
    reject = true;
    const g2 = app.accounts.grant(id)!;
    const t2 = (await app.accounts.tokens(id)).tokens;
    await app.accounts.replaceTokens(id, g2.revision, { ...t2, expires_at: new Date(Date.now() - 1000).toISOString() });
    await expect(app.tokens.usable(id)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(app.accounts.get(id)!.state).toBe("needs_reauth");
  });

  test("a failed profile lookup does not create an account, and an unregistered app explains what to do", async () => {
    await open(makeFetch({ me: () => new Response("{}", { status: 500 }) }).impl);
    const r = await connectThreads();
    expect((await invoke(app, "social_auth_status", { attempt_id: r.attempt })).data).toMatchObject({ status: "failed" });
    expect(app.accounts.list({ provider: "threads" })).toHaveLength(0);
    app.close();
    await open(makeFetch().impl, false);
    const none = await invoke(app, "social_auth_connect", { provider: "threads" });
    expect(none.error?.code).toBe("APP_APPROVAL_REQUIRED");
    expect(none.error?.actionable_next_step).toContain("xn-interact app set threads");
  });

  test("disconnecting erases the local grant and says that Threads documents no revoke endpoint", async () => {
    await open(makeFetch().impl);
    await connectThreads();
    const id = app.accounts.list({ provider: "threads" })[0]!.id;
    const plan = await invoke(app, "social_auth_disconnect", { mode: "plan", account_id: id });
    expect(plan.ok).toBe(true);
    const a = app.approvals.get((plan.data as { approval: { approval_id: string } }).approval.approval_id);
    app.approvals.decideFromTrustedTerminal(a.id, "approved", { tty: true, user: "test", confirmed_hash_prefix: a.plan_hash.slice(0, 8) });
    const exec = await invoke(app, "social_auth_disconnect", { mode: "execute", plan_id: (plan.data as { plan_id: string }).plan_id, operation_id: "op-threads-disconnect-1" });
    const view = exec.data as { status: string; targets: { warnings?: string[] }[] };
    expect(view.status).toBe("succeeded");
    expect(view.targets[0]!.warnings?.[0]).toContain("no revoke endpoint");
    expect(app.accounts.grant(id)).toBeNull();
  });
});
