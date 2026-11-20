import { afterEach, describe, expect, test } from "bun:test";
import { App } from "../../src/app.ts";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { MemoryKeyring } from "../../src/identity/keyring.ts";
import type { AdapterContext } from "../../src/providers/contract.ts";
import { InstagramAdapter } from "../../src/providers/instagram/adapter.ts";
import { invoke } from "../../src/routing/gateway.ts";
import { tempHome, testEnv } from "../helpers.ts";

const IG = "17841400000000001";
let app: App | undefined;
afterEach(() => {
  app?.close();
  app = undefined;
});

function res(status: number, body: unknown) {
  return { status, headers: new Headers(), text: JSON.stringify(body), json: <T>() => body as T };
}

function direct(handler: (method: string, url: URL) => { status: number; body: unknown }) {
  const calls: { method: string; url: URL }[] = [];
  const http = {
    request: async (_p: string, req: { method: string; url: string }) => {
      const url = new URL(req.url);
      calls.push({ method: req.method, url });
      const r = handler(req.method, url);
      return res(r.status, r.body);
    },
  };
  const ctx = { account: { account_id: "acc_1", provider: "instagram", provider_subject: IG, account_type: "professional", role: null }, tokens: { access_token: "TOK", expires_at: null, scopes: [], token_type: "bearer" }, http } as unknown as AdapterContext;
  return { calls, ctx, adapter: new InstagramAdapter({ http: http as never }) };
}

describe("Instagram adapter (Unified Login): own-account reads", () => {
  test("account, media list, single media and insights use bounded, validated requests on the Instagram account id", async () => {
    const d = direct((_m, u) => {
      if (u.pathname === `/v27.0/${IG}`) return { status: 200, body: { id: IG, username: "igowner", followers_count: 12, media_count: 3 } };
      if (u.pathname === `/v27.0/${IG}/media`) return { status: 200, body: { data: [{ id: "1001", caption: "hello", media_type: "IMAGE", permalink: "https://www.instagram.com/p/AAA/", timestamp: "2026-11-20T00:00:00+0000", like_count: 4 }, { id: "1002", media_type: "VIDEO" }], paging: { cursors: { after: "CUR1" } } } };
      if (u.pathname === "/v27.0/555555") return { status: 200, body: { id: "555555", caption: "one", media_type: "CAROUSEL_ALBUM" } };
      if (u.pathname === `/v27.0/${IG}/insights`) return { status: 200, body: { data: [{ name: "reach", period: "day", values: [{ value: 9 }] }, { name: "views", period: "day", total_value: { value: 5 } }] } };
      if (u.pathname === "/v27.0/555555/insights") return { status: 200, body: { data: [{ name: "reach", period: "lifetime", values: [{ value: 2 }] }] } };
      return { status: 404, body: {} };
    });
    expect((await d.adapter.read("account.read", d.ctx, {})).item).toMatchObject({ username: "igowner", followers_count: 12 });
    const list = await d.adapter.read("content.read", d.ctx, { limit: 2 });
    expect(list.items).toHaveLength(2);
    expect(list.items![0]).toMatchObject({ id: "1001", kind: "image", text: "hello", url: "https://www.instagram.com/p/AAA/", created_at: "2026-11-20T00:00:00+0000" });
    expect(list.items![1]).toMatchObject({ id: "1002", kind: "video", text: "" });
    expect(list.next_cursor).toBe("CUR1");
    expect(d.calls.at(-1)!.url.searchParams.get("limit")).toBe("2");
    expect(d.calls.at(-1)!.url.searchParams.get("access_token")).toBe("TOK");
    expect((await d.adapter.read("content.read", d.ctx, { content_id: "555555" })).item).toMatchObject({ id: "555555", kind: "carousel_album" });
    const ins = await d.adapter.read("analytics.read", d.ctx, { metric: ["reach", "views"], period: "day", metric_type: "total_value" });
    expect(ins.item).toEqual({ reach: [{ value: 9 }], views: 5 });
    expect(ins.items).toBeUndefined();
    const last = d.calls.at(-1)!.url;
    expect(last.searchParams.get("metric")).toBe("reach,views");
    expect(last.searchParams.get("period")).toBe("day");
    expect(last.searchParams.get("metric_type")).toBe("total_value");
    const perPost = await d.adapter.read("analytics.read", d.ctx, { content_id: "555555", period: "lifetime" });
    expect(perPost.item).toEqual({ reach: [{ value: 2 }] });
    expect(d.calls.at(-1)!.url.pathname).toBe("/v27.0/555555/insights");
    for (const c of d.calls) expect(c.url.host).toBe("graph.facebook.com");
  });

  test("bad input is rejected before any request is made", async () => {
    const d = direct(() => ({ status: 200, body: {} }));
    await expect(d.adapter.read("content.read", d.ctx, { content_id: "../me" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(d.adapter.read("analytics.read", d.ctx, { content_id: "../me" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(d.adapter.read("analytics.read", d.ctx, { metric: "reach;drop" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(d.adapter.read("analytics.read", d.ctx, { metric: Array.from({ length: 11 }, (_, i) => `m${i}`.replace(/\d/g, "x")) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(d.adapter.read("analytics.read", d.ctx, { period: "forever" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(d.adapter.read("analytics.read", d.ctx, { metric_type: "other" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(d.calls).toHaveLength(0);
  });

  test("an invalid token (code 190) asks for reauthorization and other operations stay unverified", async () => {
    const d = direct(() => ({ status: 400, body: { error: { message: "Invalid OAuth access token", code: 190 } } }));
    await expect(d.adapter.read("account.read", d.ctx, {})).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    const ok = direct(() => ({ status: 200, body: {} }));
    await expect(ok.adapter.read("engagement.read", ok.ctx, {})).rejects.toMatchObject({ code: "UNVERIFIED" });
    await expect(ok.adapter.write({ operation: "content.publish.video", params: {}, intent_id: "int_1", dedupe_key: "dk_1" }, ok.ctx)).rejects.toMatchObject({ code: "UNVERIFIED" });
    expect(ok.calls).toHaveLength(0);
  });

  test("only the three read operations can be armed without a public media base; publishing needs one", () => {
    const m = new InstagramAdapter({ http: null }).manifest.operations;
    for (const op of ["account.read", "content.read", "analytics.read"]) expect(m[op]!.acceptance, op).toBe(true);
    for (const op of ["content.publish.video", "engagement.reply", "engagement.hide"]) expect(m[op]!.acceptance, op).toBeUndefined();
    expect(m["content.publish.text"]!.verdict).toBe("UNVERIFIED");
  });
});

describe("Instagram login configuration (config_id)", () => {
  test("without a stored config_id the login is refused with an actionable step and nothing is sent", async () => {
    const seen: string[] = [];
    const impl = (async (input: URL | string) => {
      seen.push(String(input));
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    app = await App.open(loadConfig(testEnv(tempHome())), { keyring: new MemoryKeyring(new Map()), fetchImpl: impl, testClients: { instagram: { client_id: "META-ID", client_secret: "META-SECRET-zz" } } });
    const start = await invoke(app, "social_auth_connect", { provider: "instagram" });
    expect(start.ok).toBe(false);
    expect(start.error?.code).toBe("APP_APPROVAL_REQUIRED");
    expect(String(start.error?.message)).toContain("config_id");
    expect(seen).toEqual([]);
  });

  test("app credentials keep the config_id with the client id and secret in the keyring, never in the database", async () => {
    const keyring = new MemoryKeyring(new Map());
    app = await App.open(loadConfig(testEnv(tempHome())), { keyring });
    await app.apps.set("instagram", { client_id: "META-ID", client_secret: "META-SECRET-zz", config_id: "CFG-12345" }, [], "UNVERIFIED");
    const got = await app.apps.lookup("instagram");
    expect(got).toEqual({ client_id: "META-ID", client_secret: "META-SECRET-zz", config_id: "CFG-12345" });
    expect(app.apps.registered("instagram")).toBe(true);
    app.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const dump = JSON.stringify(app.db.all("SELECT * FROM provider_apps"));
    expect(dump).not.toContain("META-SECRET");
    expect(dump).not.toContain("CFG-12345");
  });

  test("the real adapter builds the Facebook Login for Business URL from the config_id and sends no scope", () => {
    const a = new InstagramAdapter({ http: null });
    const u = new URL(a.authorizeUrl({ state: "ST", redirect_uri: "https://127.0.0.1:47820/oauth/callback/instagram", scopes: ["x"], client: { client_id: "META-ID", client_secret: "s", config_id: "CFG-12345" } }));
    expect(u.origin + u.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: "META-ID", config_id: "CFG-12345", redirect_uri: "https://127.0.0.1:47820/oauth/callback/instagram", response_type: "code", override_default_response_type: "true", state: "ST", prompt: "login" });
    expect(() => a.authorizeUrl({ state: "ST", redirect_uri: "https://x", scopes: [], client: { client_id: "META-ID", client_secret: "s" } })).toThrow("config_id");
  });
});
