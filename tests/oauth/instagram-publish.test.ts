import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { App } from "../../src/app.ts";
import { loadConfig, parsePublicMediaBase } from "../../src/bootstrap/config.ts";
import { MemoryKeyring } from "../../src/identity/keyring.ts";
import type { AdapterContext } from "../../src/providers/contract.ts";
import { InstagramAdapter, publicMediaUrl } from "../../src/providers/instagram/adapter.ts";
import { invoke } from "../../src/routing/gateway.ts";
import { hostPublicly } from "../../src/content/public-media.ts";
import { ROOT, tempHome, testEnv } from "../helpers.ts";

const IG = "17841400000000001";
const BASE = "https://media.example.com/ig/";
const SHA = "ab".repeat(32);
const CONTAINER = "17900000000000001";
const MEDIA = "18000000000000001";
let app: App | undefined;
afterEach(() => {
  app?.close();
  app = undefined;
});

interface Call {
  method: string;
  url: URL;
  body: string;
}

function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { status, headers: new Headers(headers), text: JSON.stringify(body), json: <T>() => body as T };
}

type Handler = (c: Call) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined;

function direct(handler: Handler) {
  const calls: Call[] = [];
  const http = {
    request: async (_p: string, req: { method: string; url: string; body?: unknown }) => {
      const url = new URL(req.url);
      const body = req.body instanceof URLSearchParams ? req.body.toString() : String(req.body ?? "");
      const call = { method: req.method, url, body };
      calls.push(call);
      const r = handler(call) ?? { status: 404, body: {} };
      return res(r.status, r.body ?? {}, r.headers);
    },
  };
  const ctx = { account: { account_id: "acc_1", provider: "instagram", provider_subject: IG, account_type: "professional", role: null }, tokens: { access_token: "TOK", expires_at: null, scopes: [], token_type: "bearer" }, http } as unknown as AdapterContext;
  const adapter = new InstagramAdapter({ http: http as never }, { publicMediaBase: BASE, sleep: async () => {}, maxPolls: 3 });
  return { calls, ctx, adapter };
}

const UP = (over: Record<string, unknown> = {}) => ({ operation: "media.upload", params: { text: "Hello from X90 Labs", media: [{ kind: "image", mime: "image/jpeg", sha256: SHA, alt_text: "A logo" }], ...over }, intent_id: "int_1", dedupe_key: "dk_1" });
const PUB = (over: Record<string, unknown> = {}) => ({ operation: "content.publish.image", params: { text: "Hello from X90 Labs", media_ref: CONTAINER, ...over }, intent_id: "int_2", dedupe_key: "dk_2" });

const happy: Handler = (c) => {
  if (c.method === "HEAD" && c.url.href === `${BASE}${SHA}.jpg`) return { status: 200, headers: { "content-type": "image/jpeg" } };
  if (c.method === "POST" && c.url.pathname === `/v27.0/${IG}/media`) return { status: 200, body: { id: CONTAINER } };
  if (c.url.pathname === `/v27.0/${CONTAINER}`) return { status: 200, body: { status_code: "FINISHED" } };
  if (c.method === "POST" && c.url.pathname === `/v27.0/${IG}/media_publish`) return { status: 200, body: { id: MEDIA } };
  if (c.url.pathname === `/v27.0/${MEDIA}`) return { status: 200, body: { permalink: "https://www.instagram.com/p/NEW/", timestamp: "2026-11-20T09:00:00+0000" } };
  return undefined;
};

describe("Instagram image publishing (adapter)", () => {
  test("step 1 checks the public URL, then creates a container from it and publishes nothing", async () => {
    const d = direct(happy);
    const r = await d.adapter.write(UP(), d.ctx);
    expect(r).toEqual({ provider_ref: CONTAINER, pending: { container_id: CONTAINER, poll_after_ms: 3000 } });
    expect(d.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`HEAD /ig/${SHA}.jpg`, `POST /v27.0/${IG}/media`]);
    const container = new URLSearchParams(d.calls[1]!.body);
    expect(container.get("image_url")).toBe(publicMediaUrl(BASE, SHA));
    expect(container.get("caption")).toBe("Hello from X90 Labs");
    expect(container.get("alt_text")).toBe("A logo");
    expect(container.get("access_token")).toBe("TOK");
  });

  test("an image that is not served at its public URL sends nothing to Instagram", async () => {
    for (const head of [{ status: 404 }, { status: 200, headers: { "content-type": "text/html" } }]) {
      const d = direct((c) => (c.method === "HEAD" ? head : happy(c)));
      await expect(d.adapter.write(UP(), d.ctx)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect(d.calls.filter((c) => c.url.host === "graph.facebook.com")).toHaveLength(0);
    }
  });

  test("step 2 polls the container: FINISHED is ready, IN_PROGRESS waits, ERROR or EXPIRED publishes nothing", async () => {
    const mk = (status_code: string) => direct((c) => (c.url.pathname === `/v27.0/${CONTAINER}` ? { status: 200, body: { status_code } } : happy(c)));
    const ready = mk("FINISHED");
    expect(await ready.adapter.poll(UP(), ready.ctx, CONTAINER)).toEqual({ done: true, provider_ref: CONTAINER });
    expect(ready.calls[0]!.url.searchParams.get("fields")).toBe("status_code");
    const waiting = mk("IN_PROGRESS");
    expect(await waiting.adapter.poll(UP(), waiting.ctx, CONTAINER)).toEqual({ done: false });
    for (const bad of ["ERROR", "EXPIRED"]) {
      const d = mk(bad);
      await expect(d.adapter.poll(UP(), d.ctx, CONTAINER)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
      expect(d.calls.some((c) => c.url.pathname.endsWith("/media_publish"))).toBe(false);
    }
    await expect(ready.adapter.poll(UP(), ready.ctx, "../me")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  test("step 3 publishes the prepared container once and reads back the permalink", async () => {
    const d = direct(happy);
    const r = await d.adapter.write(PUB(), d.ctx);
    expect(r).toEqual({ provider_ref: MEDIA, url: "https://www.instagram.com/p/NEW/", at: "2026-11-20T09:00:00+0000" });
    expect(d.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`POST /v27.0/${IG}/media_publish`, `GET /v27.0/${MEDIA}`]);
    expect(new URLSearchParams(d.calls[0]!.body).get("creation_id")).toBe(CONTAINER);
  });

  test("a server error on the publish request is an unknown outcome and is sent once; a missing container is refused", async () => {
    const d = direct((c) => (c.method === "POST" && c.url.pathname.endsWith("/media_publish") ? { status: 500, body: {} } : happy(c)));
    await expect(d.adapter.write(PUB(), d.ctx)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(d.calls.filter((c) => c.url.pathname.endsWith("/media_publish"))).toHaveLength(1);
    const none = direct(happy);
    await expect(none.adapter.write(PUB({ media_ref: undefined }), none.ctx)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(none.adapter.write(PUB({ media_ref: "../x" }), none.ctx)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(none.calls).toHaveLength(0);
  });

  test("anything but exactly one valid JPEG and a short caption is refused before any request", async () => {
    const d = direct(happy);
    const png = { kind: "image", mime: "image/png", sha256: SHA };
    const jpg = { kind: "image", mime: "image/jpeg", sha256: SHA };
    for (const params of [{ media: [png] }, { media: [jpg, jpg] }, { media: [] }, { media: [{ ...jpg, sha256: "not-a-hash" }] }, { text: "x".repeat(2201) }]) {
      await expect(d.adapter.write(UP(params), d.ctx), JSON.stringify(params).slice(0, 40)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    await expect(d.adapter.write({ ...UP(), operation: "content.publish.video" }, d.ctx)).rejects.toMatchObject({ code: "UNVERIFIED" });
    expect(d.calls).toHaveLength(0);
  });

  test("read-back matches an identical recent caption and never claims a post is absent", async () => {
    const recent = new Date().toISOString().replace(/\.\d+Z$/, "+0000");
    const found = direct(() => ({ status: 200, body: { data: [{ id: "1", caption: "other", timestamp: recent }, { id: "2", caption: "Hello from X90 Labs", permalink: "https://www.instagram.com/p/X/", timestamp: recent }] } }));
    expect(await found.adapter.inspectWriteOutcome(PUB(), found.ctx)).toMatchObject({ found: true, provider_ref: "2", url: "https://www.instagram.com/p/X/" });
    const old = direct(() => ({ status: 200, body: { data: [{ id: "2", caption: "Hello from X90 Labs", timestamp: "2026-01-01T00:00:00+0000" }] } }));
    expect((await old.adapter.inspectWriteOutcome(PUB(), old.ctx)).found).toBeNull();
    const down = direct(() => ({ status: 500, body: {} }));
    expect((await down.adapter.inspectWriteOutcome(PUB(), down.ctx)).found).toBeNull();
    const none = direct(() => ({ status: 200, body: { data: [] } }));
    expect((await none.adapter.inspectWriteOutcome(PUB({ text: "" }), none.ctx)).found).toBeNull();
    expect((await none.adapter.inspectWriteOutcome(UP(), none.ctx)).found).toBeNull();
    expect(none.calls).toHaveLength(0);
  });

  test("the manifest needs a public media base, allows its host, accepts one JPEG and arms both write steps together", () => {
    const withBase = new InstagramAdapter({ http: null }, { publicMediaBase: BASE });
    const pub = withBase.manifest.operations["content.publish.image"]!;
    expect(pub.acceptance).toBe(true);
    expect(pub.acceptance_with).toEqual(["media.upload"]);
    expect(pub.read_after_write).toBe(true);
    expect(pub.limits).toEqual({ text_max: 2200, media_kinds: ["image"], media_mimes: ["image/jpeg"], max_media: 1 });
    expect(withBase.manifest.operations["media.upload"]!.acceptance).toBe(true);
    expect(withBase.manifest.hosts).toEqual(["graph.facebook.com", "media.example.com"]);
    const without = new InstagramAdapter({ http: null });
    for (const op of ["content.publish.image", "media.upload"]) {
      expect(without.manifest.operations[op]).toMatchObject({ verdict: "UNSUPPORTED" });
      expect(without.manifest.operations[op]!.reason).toContain("XN_INTERACT_PUBLIC_MEDIA_BASE");
    }
    expect(without.manifest.hosts).toEqual(["graph.facebook.com"]);
    expect(withBase.manifest.operations["content.publish.video"]!.acceptance).toBeUndefined();
  });
});

describe("public media base configuration", () => {
  test("only a plain HTTPS directory URL is accepted", () => {
    expect(parsePublicMediaBase(undefined)).toBeNull();
    expect(parsePublicMediaBase("  ")).toBeNull();
    expect(parsePublicMediaBase(BASE)).toBe(BASE);
    for (const bad of ["http://media.example.com/ig/", "https://media.example.com/ig", "https://u:p@media.example.com/ig/", "https://media.example.com/ig/?x=1", "https://media.example.com/ig/#a", "not a url"]) expect(() => parsePublicMediaBase(bad), bad).toThrow("XN_INTERACT_PUBLIC_MEDIA_BASE");
    expect(loadConfig(testEnv(tempHome(), { XN_INTERACT_PUBLIC_MEDIA_BASE: BASE })).publicMediaBase).toBe(BASE);
  });
});

describe("Instagram image publishing (through the gateway)", () => {
  async function open(seen: Call[], extra: Record<string, string> = { XN_INTERACT_PUBLIC_MEDIA_BASE: BASE }) {
    const posted: string[] = [];
    const impl = (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
      seen.push({ method, url, body });
      const p = url.pathname;
      if (p === "/v27.0/oauth/access_token") return Response.json({ access_token: "IGSUAT-1" });
      if (p === "/v27.0/me/assigned_instagram_accounts") return Response.json({ data: [{ id: IG, username: "x90_labs" }] });
      if (method === "HEAD" && url.href === `${BASE}${SHA_OF_FILE.value}.jpg`) return new Response(null, { status: 200, headers: { "content-type": "image/jpeg" } });
      if (method === "POST" && p === `/v27.0/${IG}/media`) return Response.json({ id: CONTAINER });
      if (p === `/v27.0/${CONTAINER}`) return Response.json({ status_code: "FINISHED" });
      if (method === "POST" && p === `/v27.0/${IG}/media_publish`) {
        posted.push(new URLSearchParams(body).get("creation_id") ?? "");
        return Response.json({ id: MEDIA });
      }
      if (p === `/v27.0/${MEDIA}`) return Response.json({ permalink: "https://www.instagram.com/p/NEW/", timestamp: new Date().toISOString().replace(/\.\d+Z$/, "+0000") });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const home = tempHome();
    app = await App.open(loadConfig(testEnv(home, extra)), { keyring: new MemoryKeyring(new Map()), fetchImpl: impl, testClients: { instagram: { client_id: "META-ID", client_secret: "META-SECRET-zz", config_id: "CFG-1" } } });
    const start = await invoke(app, "social_auth_connect", { provider: "instagram" });
    const auth = new URL((start.data as { auth_url: string }).auth_url);
    const cb = new URL((start.data as { redirect_uri: string }).redirect_uri);
    cb.searchParams.set("code", "CODE-1");
    cb.searchParams.set("state", auth.searchParams.get("state")!);
    await fetch(cb, { tls: { rejectUnauthorized: false } } as RequestInit);
    return { home, posted, id: app.accounts.list({ provider: "instagram" })[0]!.id };
  }

  const SHA_OF_FILE = { value: "" };

  async function stage(home: string, name: string, bytes: number[]) {
    const path = join(home, "inbox", name);
    await Bun.write(path, new Uint8Array([...bytes, ...Array.from({ length: 64 }, (_, i) => i)]));
    const up = await invoke(app!, "social_media_upload", { path, alt_text: "A logo" });
    expect(up.ok, JSON.stringify(up.error)).toBe(true);
    return up.data as { media_id: string; sha256: string; mime: string };
  }

  async function planOf(id: string, mediaId: string, text = "Hello from X90 Labs") {
    const draft = await invoke(app!, "social_content_create", { text, media_ids: [mediaId] });
    expect(draft.ok, JSON.stringify(draft.error)).toBe(true);
    return invoke(app!, "social_content_publish", { mode: "plan", account_ids: [id], draft_id: (draft.data as { draft_id: string }).draft_id });
  }

  test("a JPEG needs an armed acceptance run, an owner approval and the media host; then it is published once", async () => {
    const seen: Call[] = [];
    const { home, posted, id } = await open(seen);
    const jpg = await stage(home, "pic.jpg", [0xff, 0xd8, 0xff, 0xe0]);
    SHA_OF_FILE.value = jpg.sha256;
    expect(jpg.mime).toBe("image/jpeg");

    const unarmed = await planOf(id, jpg.media_id);
    expect(unarmed.ok).toBe(false);
    expect(unarmed.error?.code).toBe("UNVERIFIED");

    app!.acceptance.arm("instagram", id, "content.publish.image");
    app!.acceptance.arm("instagram", id, "media.upload");
    const plan = await planOf(id, jpg.media_id);
    expect(plan.ok, JSON.stringify(plan.error)).toBe(true);
    const d = plan.data as { plan_id: string; approval: { approval_id: string }; standing_grant?: unknown };
    expect(d.standing_grant).toBeUndefined();
    const refused = await invoke(app!, "social_content_publish", { mode: "execute", plan_id: d.plan_id, operation_id: "op-ig-no-approval" });
    expect(refused.error?.code).toBe("APPROVAL_REQUIRED");
    expect(posted).toHaveLength(0);

    const a = app!.approvals.get(d.approval.approval_id);
    app!.approvals.decideFromTrustedTerminal(a.id, "approved", { tty: true, user: "test-owner", confirmed_hash_prefix: a.plan_hash.slice(0, 8) });
    const exec = await invoke(app!, "social_content_publish", { mode: "execute", plan_id: d.plan_id, operation_id: "op-ig-publish-1" });
    expect(exec.ok, JSON.stringify(exec.error)).toBe(true);
    const view = exec.data as { status: string; targets: { provider_ref: string; url: string }[] };
    expect(view.status, JSON.stringify(view).slice(0, 900)).toBe("succeeded");
    expect(view.targets[0]).toMatchObject({ provider_ref: MEDIA, url: "https://www.instagram.com/p/NEW/" });
    expect(posted).toEqual([CONTAINER]);
    expect(seen.find((s) => s.method === "HEAD")!.url.href).toBe(`${BASE}${jpg.sha256}.jpg`);
    expect(app!.acceptance.armed(id, "content.publish.image")).toBeUndefined();
    expect(app!.acceptance.armed(id, "media.upload")).toBeUndefined();
    expect(seen.filter((x) => x.method === "POST" && x.url.pathname === `/v27.0/${IG}/media`)).toHaveLength(1);
  });

  test("a PNG is refused at plan time, before any approval, because Instagram only accepts JPEG", async () => {
    const seen: Call[] = [];
    const { home, id } = await open(seen);
    const png = await stage(home, "pic.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.mime).toBe("image/png");
    app!.acceptance.arm("instagram", id, "content.publish.image");
    const plan = await planOf(id, png.media_id);
    expect(plan.ok).toBe(false);
    expect(JSON.stringify(plan.error)).toContain("image/jpeg");
    expect(seen.filter((s) => s.url.pathname.includes("/media"))).toHaveLength(0);
  });

  test("without a public media base the operation is unsupported and cannot even be planned", async () => {
    const seen: Call[] = [];
    const { home, id } = await open(seen, {});
    const jpg = await stage(home, "pic.jpg", [0xff, 0xd8, 0xff, 0xe0]);
    const plan = await planOf(id, jpg.media_id);
    expect(plan.ok).toBe(false);
    expect(plan.error?.code).toBe("UNSUPPORTED");
    expect(JSON.stringify(plan.error)).toContain("XN_INTERACT_PUBLIC_MEDIA_BASE");
  });
});

describe("hosting an approved JPEG publicly", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    expect(r.exitCode, `${args.join(" ")}: ${r.stderr.toString()}`).toBe(0);
    return r.stdout.toString();
  };

  function checkout() {
    const root = mkdtempSync(join(tempHome(), "git-"));
    const bare = join(root, "remote.git");
    const work = join(root, "work");
    mkdirSync(bare);
    git(bare, "init", "--bare", "-b", "main");
    git(root, "clone", bare, work);
    git(work, "commit", "--allow-empty", "-m", "init");
    git(work, "push", "-u", "origin", "HEAD:main");
    return { bare, work, root };
  }

  test("copies the file into the checkout as <sha256>.jpg, commits and pushes it, and is idempotent", async () => {
    const { bare, work, root } = checkout();
    const src = join(root, "staged.jpg");
    await Bun.write(src, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
    const name = `${SHA}.jpg`;
    const first = hostPublicly(work, src, name, "media abababab");
    expect(first).toEqual({ committed: true });
    expect(readFileSync(join(work, name)).length).toBe(8);
    expect(git(bare, "show", `main:${name}`).length).toBeGreaterThan(0);
    expect(git(bare, "log", "--format=%s", "-1")).toContain("media abababab");
    expect(hostPublicly(work, src, name, "media abababab")).toEqual({ committed: false });
  });

  test("only <sha256>.jpg names and real git checkouts are accepted", async () => {
    const { work, root } = checkout();
    const src = join(root, "x.jpg");
    await Bun.write(src, new Uint8Array([0xff, 0xd8, 0xff, 1]));
    for (const bad of ["../evil.jpg", "logo.jpg", `${SHA}.png`, `${SHA.toUpperCase()}.jpg`, `${SHA}.jpg/../x`]) expect(() => hostPublicly(work, src, bad, "m"), bad).toThrow("<sha256>.jpg");
    expect(() => hostPublicly(root, src, `${SHA}.jpg`, "m")).toThrow("not a git checkout");
  });
});

describe("xn-interact media (CLI)", () => {
  function env(extra: Record<string, string> = {}) {
    const home = tempHome();
    return { home, env: { ...testEnv(home, { XN_INTERACT_KEYRING: "file", XN_INTERACT_PUBLIC_MEDIA_BASE: BASE, ...extra }), PATH: process.env.PATH ?? "" } };
  }
  const cli = (e: Record<string, string>, ...args: string[]) => Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), ...args], { env: e });

  test("url works without a terminal and names the file after its sha256; host and first-post need a terminal", async () => {
    const { home, env: e } = env();
    cli(e, "vault", "init");
    const jpg = join(home, "outside-roots.jpg");
    await Bun.write(jpg, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 40 }, (_, i) => i)]));
    const url = cli(e, "media", "url", jpg);
    expect(url.exitCode, url.stderr.toString()).toBe(0);
    const out = JSON.parse(url.stdout.toString()) as { sha256: string; host_as: string; public_url: string };
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.host_as).toBe(`${out.sha256}.jpg`);
    expect(out.public_url).toBe(`${BASE}${out.sha256}.jpg`);

    const host = cli(e, "media", "host", jpg);
    expect(host.exitCode).not.toBe(0);
    expect(host.stderr.toString()).toContain("interactive terminal");
    const first = cli(e, "first-post", "instagram", "--text-file", "/dev/null", "--image-file", jpg);
    expect(first.exitCode).not.toBe(0);
    expect(first.stderr.toString()).toContain("interactive terminal");
  });

  test("a PNG and a missing base are refused clearly", async () => {
    const { home, env: e } = env();
    cli(e, "vault", "init");
    const png = join(home, "x.png");
    await Bun.write(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 40 }, (_, i) => i)]));
    const r = cli(e, "media", "url", png);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("only accepts JPEG");
    const none = env({ XN_INTERACT_PUBLIC_MEDIA_BASE: "" });
    cli(none.env, "vault", "init");
    const jpg = join(none.home, "p.jpg");
    await Bun.write(jpg, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 40 }, (_, i) => i)]));
    const nb = cli(none.env, "media", "url", jpg);
    expect(nb.exitCode).not.toBe(0);
    expect(nb.stderr.toString()).toContain("XN_INTERACT_PUBLIC_MEDIA_BASE");
  });
});
