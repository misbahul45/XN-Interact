import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "../../src/app.ts";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { MemoryKeyring } from "../../src/identity/keyring.ts";
import { invoke } from "../../src/routing/gateway.ts";
import { tempHome, testEnv } from "../helpers.ts";

interface Seen {
  method: string;
  url: URL;
  body: URLSearchParams;
  headers: Headers;
}

type Route = (req: Seen) => Response | undefined;

const PROVIDERS = ["linkedin", "instagram", "tiktok", "x", "threads", "reddit", "facebook"];
let app: App;
afterEach(() => app?.close());

function mock(routes: Route[]) {
  const seen: Seen[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ""));
    const req: Seen = { method: init?.method ?? "GET", url, body, headers: new Headers(init?.headers) };
    seen.push(req);
    for (const r of routes) {
      const res = r(req);
      if (res) return res;
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { seen, impl };
}

async function open(impl: typeof fetch) {
  const clients = Object.fromEntries(PROVIDERS.map((p) => [p, { client_id: `${p.toUpperCase()}-ID`, client_secret: `${p.toUpperCase()}-SECRET-zz`, config_id: `${p.toUpperCase()}-CONFIG` }]));
  const home = tempHome();
  app = await App.open(loadConfig(testEnv(home)), { keyring: new MemoryKeyring(new Map()), fetchImpl: impl, testClients: clients });
  return home;
}

async function login(provider: string) {
  const start = await invoke(app, "social_auth_connect", { provider });
  expect(start.ok, JSON.stringify(start.error)).toBe(true);
  const d = start.data as { auth_url: string; attempt_id: string; redirect_uri: string };
  const auth = new URL(d.auth_url);
  const cb = new URL(d.redirect_uri);
  cb.searchParams.set("code", "CODE-123");
  cb.searchParams.set("state", auth.searchParams.get("state")!);
  const res = await fetch(cb, { tls: { rejectUnauthorized: false } } as RequestInit);
  const st = (await invoke(app, "social_auth_status", { attempt_id: d.attempt_id })).data as { status: string; error: string | null };
  return { auth, status: res.status, st, redirect: d.redirect_uri };
}

const accountsOf = (provider: string) => app.accounts.list({ provider });

describe("provider login flows (official endpoints, mocked responses)", () => {
  test("TikTok: client_key, hex PKCE, token with code_verifier, rotating refresh token", async () => {
    const { seen, impl } = mock([
      (r) => (r.url.pathname === "/v2/oauth/token/" && r.body.get("grant_type") === "authorization_code" ? Response.json({ access_token: "TTACCESS-1", expires_in: 86400, open_id: "ttopen1", refresh_token: "TTREFRESH-1", refresh_expires_in: 31536000, scope: "user.info.basic,video.publish", token_type: "Bearer" }) : undefined),
      (r) => (r.url.pathname === "/v2/oauth/token/" && r.body.get("grant_type") === "refresh_token" ? Response.json({ access_token: "TTACCESS-2", expires_in: 86400, open_id: "ttopen1", refresh_token: "TTREFRESH-2", scope: "user.info.basic,video.publish" }) : undefined),
      (r) => (r.url.pathname === "/v2/user/info/" ? Response.json({ data: { user: { open_id: "ttopen1", display_name: "Tik Owner" } }, error: { code: "ok" } }) : undefined),
    ]);
    await open(impl);
    const { auth, st, redirect } = await login("tiktok");
    expect(st.status).toBe("connected");
    expect(auth.origin + auth.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(auth.searchParams.get("client_key")).toBe("TIKTOK-ID");
    expect(auth.searchParams.get("code_challenge")).toMatch(/^[0-9a-f]{64}$/);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("scope")).toBe("user.info.basic,video.publish");
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    const ex = seen.find((s) => s.body.get("grant_type") === "authorization_code")!;
    expect(ex.body.get("client_key")).toBe("TIKTOK-ID");
    expect(ex.body.get("code_verifier")!.length).toBeGreaterThan(40);
    expect(accountsOf("tiktok")[0]!.display_name).toBe("Tik Owner");
    expect(accountsOf("tiktok")[0]!.account_type).toBe("creator");
    const id = accountsOf("tiktok")[0]!.id;
    const g = app.accounts.grant(id)!;
    const { tokens } = await app.accounts.tokens(id);
    await app.accounts.replaceTokens(id, g.revision, { ...tokens, expires_at: new Date(Date.now() - 1000).toISOString() });
    expect((await app.tokens.usable(id)).refresh_token).toBe("TTREFRESH-2");
    expect(seen.find((s) => s.body.get("grant_type") === "refresh_token")!.body.get("refresh_token")).toBe("TTREFRESH-1");
  });

  test("X: PKCE S256, %20 scopes, Basic authentication, users/me identity", async () => {
    const { seen, impl } = mock([
      (r) => (r.url.pathname === "/2/oauth2/token" ? Response.json({ access_token: "XACCESS-1", refresh_token: "XREFRESH-1", expires_in: 7200, scope: "tweet.read tweet.write users.read offline.access", token_type: "bearer" }) : undefined),
      (r) => (r.url.pathname === "/2/users/me" ? Response.json({ data: { id: "x1", name: "X Owner", username: "xowner" } }) : undefined),
    ]);
    await open(impl);
    const { auth, st } = await login("x");
    expect(st.status).toBe("connected");
    expect(auth.origin + auth.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(auth.href).toContain("scope=offline.access%20tweet.read%20tweet.write%20users.read");
    expect(auth.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ex = seen.find((s) => s.url.pathname === "/2/oauth2/token")!;
    expect(ex.headers.get("authorization")).toBe(`Basic ${Buffer.from("X-ID:X-SECRET-zz").toString("base64")}`);
    expect(ex.body.get("code_verifier")).toBeTruthy();
    expect(ex.body.get("client_id")).toBe("X-ID");
    expect(seen.find((s) => s.url.pathname === "/2/users/me")!.headers.get("authorization")).toBe("Bearer XACCESS-1");
    expect(accountsOf("x")[0]!.display_name).toBe("@xowner");
  });

  test("LinkedIn: HTTPS-only redirect through the local certificate, OIDC userinfo, no refresh token", async () => {
    const { seen, impl } = mock([
      (r) => (r.url.pathname === "/oauth/v2/accessToken" ? Response.json({ access_token: "LIACCESS-1", expires_in: 5184000, scope: "openid,profile,w_member_social" }) : undefined),
      (r) => (r.url.pathname === "/v2/userinfo" ? Response.json({ sub: "li123", name: "Li Owner" }) : undefined),
    ]);
    await open(impl);
    const { auth, st, redirect } = await login("linkedin");
    expect(st.status).toBe("connected");
    expect(redirect).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/linkedin$/);
    expect(auth.origin + auth.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(auth.href).toContain("scope=openid%20profile%20w_member_social");
    expect(auth.searchParams.has("code_challenge")).toBe(false);
    const ex = seen.find((s) => s.url.pathname === "/oauth/v2/accessToken")!;
    expect(ex.body.get("client_secret")).toBe("LINKEDIN-SECRET-zz");
    expect(accountsOf("linkedin")[0]!.display_name).toBe("Li Owner");
    const { tokens } = await app.accounts.tokens(accountsOf("linkedin")[0]!.id);
    expect(tokens.refresh_token ?? null).toBeNull();
  });

  test("Instagram (Unified Login): Facebook dialog with config_id, code exchange with the Meta app credentials, one account per shared professional account", async () => {
    const { seen, impl } = mock([
      (r) => (r.url.pathname === "/v27.0/oauth/access_token" ? Response.json({ access_token: "IGSUAT-1" }) : undefined),
      (r) => (r.url.pathname === "/v27.0/me/assigned_instagram_accounts" ? Response.json({ data: [{ id: "17841400000000001", username: "igowner" }, { id: "17841400000000002", username: "igsecond" }] }) : undefined),
    ]);
    await open(impl);
    const { auth, st, redirect } = await login("instagram");
    expect(st.status).toBe("connected");
    expect(auth.origin + auth.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(auth.searchParams.get("client_id")).toBe("INSTAGRAM-ID");
    expect(auth.searchParams.get("config_id")).toBe("INSTAGRAM-CONFIG");
    expect(auth.searchParams.get("response_type")).toBe("code");
    expect(auth.searchParams.get("scope")).toBeNull();
    expect(redirect.startsWith("https://127.0.0.1:")).toBe(true);
    const ex = seen.find((s) => s.url.pathname === "/v27.0/oauth/access_token")!;
    expect(ex.url.searchParams.get("client_id")).toBe("INSTAGRAM-ID");
    expect(ex.url.searchParams.get("client_secret")).toBe("INSTAGRAM-SECRET-zz");
    expect(ex.url.searchParams.get("code")).toBe("CODE-123");
    expect(ex.url.searchParams.get("redirect_uri")).toBe(redirect);
    expect(seen.find((s) => s.url.pathname === "/v27.0/me/assigned_instagram_accounts")!.url.searchParams.get("access_token")).toBe("IGSUAT-1");
    const rows = accountsOf("instagram");
    expect(rows.map((a) => a.display_name).sort()).toEqual(["igowner", "igsecond"]);
    expect(rows.every((a) => a.account_type === "professional")).toBe(true);
    expect((await app.accounts.tokens(rows[0]!.id)).tokens.access_token).toBe("IGSUAT-1");
  });

  test("Facebook: user token upgraded to long-lived, one account per managed Page with its own token", async () => {
    const { seen, impl } = mock([
      (r) => (r.url.pathname === "/v27.0/oauth/access_token" && r.url.searchParams.get("grant_type") === "fb_exchange_token" ? Response.json({ access_token: "FBLONG-1", token_type: "bearer", expires_in: 5183999 }) : undefined),
      (r) => (r.url.pathname === "/v27.0/oauth/access_token" ? Response.json({ access_token: "FBSHORT-1", token_type: "bearer", expires_in: 3600 }) : undefined),
      (r) => (r.url.pathname === "/v27.0/me/accounts" ? Response.json({ data: [{ id: "p1", name: "Page One", access_token: "PAGETOKEN-1", tasks: ["CREATE_CONTENT", "MANAGE"] }, { id: "p2", name: "Page Two", access_token: "PAGETOKEN-2", tasks: ["MODERATE"] }, { id: "p3", name: "No Token Page" }] }) : undefined),
    ]);
    await open(impl);
    const { auth, st } = await login("facebook");
    expect(st.status).toBe("connected");
    expect(auth.origin + auth.pathname).toBe("https://www.facebook.com/v27.0/dialog/oauth");
    expect(auth.searchParams.get("scope")).toBe("pages_manage_engagement,pages_manage_posts,pages_read_engagement,pages_show_list");
    expect(seen.find((s) => s.url.pathname === "/v27.0/me/accounts")!.url.searchParams.get("access_token")).toBe("FBLONG-1");
    const pages = accountsOf("facebook");
    expect(pages.map((a) => a.display_name).sort()).toEqual(["Page One", "Page Two"]);
    expect(pages.every((a) => a.account_type === "page")).toBe(true);
    expect((await app.accounts.tokens(pages.find((a) => a.display_name === "Page One")!.id)).tokens.access_token).toBe("PAGETOKEN-1");
    expect(pages.find((a) => a.display_name === "Page One")!.role).toBe("CREATE_CONTENT,MANAGE");
  });

  test("Reddit: permanent duration, Basic authentication, user agent, u/ identity, revoke on disconnect", async () => {
    const { seen, impl } = mock([
      (r) => (r.url.pathname === "/api/v1/access_token" ? Response.json({ access_token: "RDACCESS-1", refresh_token: "RDREFRESH-1", expires_in: 3600, scope: "identity submit read", token_type: "bearer" }) : undefined),
      (r) => (r.url.pathname === "/api/v1/me" ? Response.json({ id: "rd1", name: "redditor" }) : undefined),
      (r) => (r.url.pathname === "/api/v1/revoke_token" ? new Response(null, { status: 204 }) : undefined),
    ]);
    await open(impl);
    const { auth, st } = await login("reddit");
    expect(st.status).toBe("connected");
    expect(auth.origin + auth.pathname).toBe("https://www.reddit.com/api/v1/authorize");
    expect(auth.searchParams.get("duration")).toBe("permanent");
    expect(auth.href).toContain("scope=identity%20read%20submit");
    const ex = seen.find((s) => s.url.pathname === "/api/v1/access_token")!;
    expect(ex.headers.get("authorization")).toBe(`Basic ${Buffer.from("REDDIT-ID:REDDIT-SECRET-zz").toString("base64")}`);
    expect(ex.headers.get("user-agent")).toContain("xn-interact");
    expect(accountsOf("reddit")[0]!.display_name).toBe("u/redditor");
    const id = accountsOf("reddit")[0]!.id;
    const plan = await invoke(app, "social_auth_disconnect", { mode: "plan", account_id: id });
    const a = app.approvals.get((plan.data as { approval: { approval_id: string } }).approval.approval_id);
    app.approvals.decideFromTrustedTerminal(a.id, "approved", { tty: true, user: "t", confirmed_hash_prefix: a.plan_hash.slice(0, 8) });
    const exec = await invoke(app, "social_auth_disconnect", { mode: "execute", plan_id: (plan.data as { plan_id: string }).plan_id, operation_id: "op-reddit-disconnect-1" });
    const view = exec.data as { status: string; targets: { warnings?: string[] }[] };
    expect(view.status).toBe("succeeded");
    expect(view.targets[0]!.warnings ?? []).toEqual([]);
    expect(seen.find((s) => s.url.pathname === "/api/v1/revoke_token")!.body.get("token")).toBe("RDREFRESH-1");
  });

  test("a provider rejection leaves no account behind, and no token ever reaches the database or the tool output", async () => {
    const { impl } = mock([
      (r) => (r.url.pathname === "/2/oauth2/token" ? Response.json({ access_token: "XSECRETACCESS-9", refresh_token: "XSECRETREFRESH-9", expires_in: 7200 }) : undefined),
      (r) => (r.url.pathname === "/2/users/me" ? new Response("{}", { status: 500 }) : undefined),
    ]);
    const home = await open(impl);
    const { st } = await login("x");
    expect(st.status).toBe("failed");
    expect(accountsOf("x")).toHaveLength(0);
    app.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const f of readdirSync(home)) if (f.startsWith("xn-interact.sqlite")) expect(readFileSync(join(home, f)).toString("latin1")).not.toContain("XSECRET");
    expect(app.audit.exportScrubbed()).not.toContain("XSECRET");
  });

  test("after login every provider still refuses to publish, with the verification reason", async () => {
    const { impl } = mock([
      (r) => (r.url.pathname === "/2/oauth2/token" ? Response.json({ access_token: "XACCESS-1", refresh_token: "XREFRESH-1", expires_in: 7200 }) : undefined),
      (r) => (r.url.pathname === "/2/users/me" ? Response.json({ data: { id: "x1", name: "X", username: "xo" } }) : undefined),
    ]);
    await open(impl);
    await login("x");
    const id = accountsOf("x")[0]!.id;
    const draft = await invoke(app, "social_content_create", { text: "hello" });
    const plan = await invoke(app, "social_content_publish", { mode: "plan", account_ids: [id], draft_id: (draft.data as { draft_id: string }).draft_id });
    expect(plan.ok).toBe(false);
    expect(plan.error?.code).toBe("UNVERIFIED");
  });
});
