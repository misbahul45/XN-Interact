import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { GatewayError } from "../../contracts/errors.ts";
import type {
  AdapterContext,
  AdapterManifest,
  ClientCredentials,
  OAuthProfile,
  OperationManifest,
  OutcomeEvidence,
  ProviderAdapter,
  ProviderIdentity,
  ReadResult,
  TokenSet,
  WriteRequest,
  WriteResult,
} from "../contract.ts";

export type Fault = "drop_response" | "unprovable_drop" | "rate_limit" | "server_error" | "forbidden" | "slow_container" | "crash_after_apply";

interface Post {
  id: string;
  account: string;
  text: string;
  kind: "text" | "image" | "video";
  media_ref: string | null;
  created_at: string;
  updated_at: string;
  deleted: boolean;
}

interface Comment {
  id: string;
  content_id: string;
  author: string;
  text: string;
  hidden: boolean;
  reactions: number;
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export class FixtureRemote {
  tokenPrefix = "fxt";
  grantScopes: string[] = ["profile", "read", "write", "engage", "insights"];
  identityTemplates: ProviderIdentity[] = [
    { subject: "member-1", display_name: "Fixture Member", account_type: "member", role: null },
    { subject: "page-1", display_name: "Fixture Page", account_type: "page", role: "editor" },
  ];
  usedCodes = new Set<string>();
  tokens = new Map<string, { scopes: string[]; revoked: boolean }>();
  refreshes = new Map<string, string[]>();
  posts = new Map<string, Post>();
  comments = new Map<string, Comment>();
  applied = new Map<string, string>();
  containers = new Map<string, { polls: number; ready_after: number; media_ref: string }>();
  writeCalls: { operation: string; dedupe_key: string }[] = [];
  unprovable = new Set<string>();
  refreshCount = 0;
  faults: Fault[] = [];
  writeDelayMs = 0;
  seq = 0;

  constructor(readonly statePath: string | null = null) {
    this.load();
  }

  load(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    const j = JSON.parse(readFileSync(this.statePath, "utf8"));
    this.tokenPrefix = j.tokenPrefix ?? this.tokenPrefix;
    this.grantScopes = j.grantScopes ?? this.grantScopes;
    this.identityTemplates = j.identityTemplates ?? this.identityTemplates;
    this.usedCodes = new Set(j.usedCodes ?? []);
    this.tokens = new Map(j.tokens ?? []);
    this.refreshes = new Map(j.refreshes ?? []);
    this.posts = new Map(j.posts ?? []);
    this.comments = new Map(j.comments ?? []);
    this.applied = new Map(j.applied ?? []);
    this.containers = new Map(j.containers ?? []);
    this.writeCalls = j.writeCalls ?? [];
    this.unprovable = new Set(j.unprovable ?? []);
    this.refreshCount = j.refreshCount ?? 0;
    this.faults = j.faults ?? [];
    this.writeDelayMs = j.writeDelayMs ?? 0;
    this.seq = j.seq ?? 0;
  }

  save(): void {
    if (!this.statePath) return;
    const j = {
      tokenPrefix: this.tokenPrefix, grantScopes: this.grantScopes, identityTemplates: this.identityTemplates,
      usedCodes: [...this.usedCodes], tokens: [...this.tokens], refreshes: [...this.refreshes], posts: [...this.posts],
      comments: [...this.comments], applied: [...this.applied], containers: [...this.containers], writeCalls: this.writeCalls,
      unprovable: [...this.unprovable], refreshCount: this.refreshCount, faults: this.faults, writeDelayMs: this.writeDelayMs, seq: this.seq,
    };
    writeFileSync(this.statePath, JSON.stringify(j));
  }

  id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  issue(scopes: string[]): TokenSet {
    const access = `${this.tokenPrefix}-access-${this.id("t")}-${b64url(crypto.getRandomValues(new Uint8Array(9)))}`;
    const refresh = `${this.tokenPrefix}-refresh-${this.id("r")}-${b64url(crypto.getRandomValues(new Uint8Array(9)))}`;
    this.tokens.set(access, { scopes, revoked: false });
    this.refreshes.set(refresh, scopes);
    return { access_token: access, refresh_token: refresh, expires_at: new Date(Date.now() + 3600_000).toISOString(), scopes, token_type: "bearer" };
  }

  check(tokens: TokenSet): string[] {
    const t = this.tokens.get(tokens.access_token);
    if (!t || t.revoked) throw new GatewayError("REAUTH_REQUIRED", "fixture token rejected", { provider: "fixture", provider_status: 401 });
    return t.scopes;
  }

  takeFault(): Fault | undefined {
    const f = this.faults.shift();
    if (f) this.save();
    return f;
  }
}

export function fixtureConsent(authUrl: string, opts: { deny?: boolean; scopes?: string[] } = {}): { code?: string; error?: string; state: string; redirect_uri: string } {
  const u = new URL(authUrl);
  const state = u.searchParams.get("state") ?? "";
  const redirect_uri = u.searchParams.get("redirect_uri") ?? "";
  if (opts.deny) return { error: "access_denied", state, redirect_uri };
  const requested = (u.searchParams.get("scope") ?? "").split(" ").filter(Boolean);
  const granted = opts.scopes ?? requested;
  const payload = { challenge: u.searchParams.get("code_challenge"), scopes: granted.filter((s) => requested.includes(s)), redirect_uri, nonce: b64url(crypto.getRandomValues(new Uint8Array(9))) };
  return { code: `fx1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`, state, redirect_uri };
}

const OPS: Record<string, Partial<OperationManifest> & { scopes: string[] }> = {
  "account.read": { scopes: ["profile"] },
  "content.read": { scopes: ["read"] },
  "content.publish.text": { scopes: ["write"], cost: { per_call: 1, uncertain: false }, limits: { text_max: 500 } },
  "content.publish.image": { scopes: ["write"], cost: { per_call: 1, uncertain: false }, limits: { text_max: 500, media_kinds: ["image"], max_media: 1 } },
  "content.publish.video": { scopes: ["write"], cost: { per_call: 1, uncertain: false }, limits: { text_max: 500, media_kinds: ["video"], max_media: 1 } },
  "content.update": { scopes: ["write"], limits: { text_max: 500 } },
  "content.delete": { scopes: ["write"] },
  "engagement.read": { scopes: ["read"] },
  "engagement.reply": { scopes: ["engage"], limits: { text_max: 300 } },
  "engagement.react": { scopes: ["engage"] },
  "engagement.hide": { scopes: ["engage"], roles: ["admin"] },
  "search.content": { scopes: ["read"], verdict: "APP_APPROVAL_REQUIRED", reason: "fixture search requires an app review that was not granted" },
  "analytics.read": { scopes: ["insights"], account_types: ["page"] },
  "media.upload": { scopes: ["write"] },
  "auth.revoke": { scopes: [] },
  "reconcile.read": { scopes: ["read"] },
};

export class FixtureAdapter implements ProviderAdapter {
  readonly testOnly = true;
  readonly manifest: AdapterManifest;
  readonly oauth: OAuthProfile = {
    verified: true,
    authorize_url: "https://fixture.invalid/oauth/authorize",
    token_url: "https://fixture.invalid/oauth/token",
    revoke_url: "https://fixture.invalid/oauth/revoke",
    pkce: "S256",
    scope_separator: " ",
    callback_path: "/oauth/callback/fixture",
  };

  constructor(readonly remote: FixtureRemote = new FixtureRemote()) {
    const operations: Record<string, OperationManifest> = {};
    for (const [op, m] of Object.entries(OPS)) {
      operations[op] = { verdict: "VERIFIED", account_types: ["member", "page"], read_after_write: true, ...m } as OperationManifest;
    }
    this.manifest = { provider: "fixture", adapter_version: "1.0.0", api_version: "fixture-1", hosts: ["fixture.invalid"], evidence_verified: true, docs_urls: [], operations };
  }

  private tx<T>(fn: () => T | Promise<T>): Promise<T> {
    this.remote.load();
    let out: T | Promise<T>;
    try {
      out = fn();
    } catch (e) {
      this.remote.save();
      return Promise.reject(e);
    }
    if (out instanceof Promise) return out.finally(() => this.remote.save());
    this.remote.save();
    return Promise.resolve(out);
  }

  authorizeUrl(p: { state: string; code_challenge: string | null; redirect_uri: string; scopes: string[]; client: ClientCredentials }): string {
    const u = new URL(this.oauth.authorize_url!);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", p.client.client_id);
    u.searchParams.set("redirect_uri", p.redirect_uri);
    u.searchParams.set("state", p.state);
    u.searchParams.set("scope", p.scopes.join(this.oauth.scope_separator));
    if (p.code_challenge) {
      u.searchParams.set("code_challenge", p.code_challenge);
      u.searchParams.set("code_challenge_method", "S256");
    }
    return u.toString();
  }

  exchangeCode(p: { code: string; verifier: string | null; redirect_uri: string }): Promise<TokenSet> {
    return this.tx(async () => {
      const bad = () => new GatewayError("PROVIDER_ERROR", "fixture rejected the authorization code", { provider: "fixture", provider_status: 400 });
      if (!p.code.startsWith("fx1.") || this.remote.usedCodes.has(p.code)) throw bad();
      this.remote.usedCodes.add(p.code);
      let rec: { challenge: string | null; scopes: string[]; redirect_uri: string };
      try {
        rec = JSON.parse(Buffer.from(p.code.slice(4), "base64url").toString("utf8"));
      } catch {
        throw bad();
      }
      if (rec.redirect_uri !== p.redirect_uri) throw new GatewayError("PROVIDER_ERROR", "redirect_uri mismatch", { provider: "fixture", provider_status: 400 });
      if (rec.challenge && (!p.verifier || (await s256(p.verifier)) !== rec.challenge)) {
        throw new GatewayError("PROVIDER_ERROR", "PKCE verification failed", { provider: "fixture", provider_status: 400 });
      }
      return this.remote.issue(rec.scopes);
    });
  }

  refresh(tokens: TokenSet): Promise<TokenSet> {
    return this.tx(() => {
      this.remote.refreshCount += 1;
      const scopes = tokens.refresh_token ? this.remote.refreshes.get(tokens.refresh_token) : undefined;
      if (!scopes) throw new GatewayError("REAUTH_REQUIRED", "fixture refresh token rejected", { provider: "fixture", provider_status: 400 });
      this.remote.refreshes.delete(tokens.refresh_token!);
      const old = this.remote.tokens.get(tokens.access_token);
      if (old) old.revoked = true;
      return this.remote.issue(scopes);
    });
  }

  revoke(tokens: TokenSet): Promise<boolean> {
    return this.tx(() => {
      const t = this.remote.tokens.get(tokens.access_token);
      if (t) t.revoked = true;
      if (tokens.refresh_token) this.remote.refreshes.delete(tokens.refresh_token);
      return true;
    });
  }

  identities(tokens: TokenSet): Promise<ProviderIdentity[]> {
    return this.tx(() => {
      this.remote.check(tokens);
      return this.remote.identityTemplates.map((t) => ({ ...t }));
    });
  }

  private posts(account: string): Post[] {
    return [...this.remote.posts.values()].filter((p) => p.account === account && !p.deleted).sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }));
  }

  read(operation: string, ctx: AdapterContext, params: Record<string, unknown>): Promise<ReadResult> {
    return this.tx(() => {
      this.remote.check(ctx.tokens);
      const fault = this.remote.takeFault();
      if (fault === "rate_limit") throw new GatewayError("RATE_LIMITED", "fixture rate limit", { provider: "fixture", provider_status: 429, retry_after_ms: 1000 });
      if (fault === "server_error") throw new GatewayError("PROVIDER_UNAVAILABLE", "fixture 503", { provider: "fixture", provider_status: 503 });
      const limit = Math.min(Number(params.limit ?? 20), 50);
      const offset = Number.parseInt(String(params.cursor ?? "0"), 10) || 0;
      const page = <T>(rows: T[]) => ({ items: rows.slice(offset, offset + limit) as Record<string, unknown>[], next_cursor: offset + limit < rows.length ? String(offset + limit) : null });
      const sub = ctx.account.provider_subject;
      switch (operation) {
        case "content.read": {
          if (params.content_id) {
            const p = this.remote.posts.get(String(params.content_id));
            if (!p || p.account !== sub || p.deleted) throw new GatewayError("PROVIDER_ERROR", "content not found", { provider: "fixture", provider_status: 404 });
            return { item: { ...p, url: `https://fixture.invalid/p/${p.id}` } };
          }
          return page(this.posts(sub).map((p) => ({ ...p, url: `https://fixture.invalid/p/${p.id}` })));
        }
        case "engagement.read":
          return page([...this.remote.comments.values()].filter((c) => !params.content_id || c.content_id === params.content_id));
        case "analytics.read": {
          const posts = this.posts(sub);
          return { item: { followers: { value: 42, semantics: "lifetime follower count", provenance: "fixture" }, posts: { value: posts.length, semantics: "non-deleted posts", provenance: "fixture" } } };
        }
        default:
          throw new GatewayError("UNSUPPORTED", `fixture cannot read ${operation}`);
      }
    });
  }

  write(req: WriteRequest, ctx: AdapterContext): Promise<WriteResult> {
    return this.tx(() => {
      const scopes = this.remote.check(ctx.tokens);
      const need = OPS[req.operation]?.scopes ?? [];
      if (need.some((s) => !scopes.includes(s))) throw new GatewayError("MISSING_SCOPES", "fixture token lacks scope", { provider: "fixture", provider_status: 403 });
      const fault = this.remote.takeFault();
      if (fault === "forbidden") throw new GatewayError("APP_APPROVAL_REQUIRED", "fixture app review denied", { provider: "fixture", provider_status: 403 });
      if (fault === "rate_limit") throw new GatewayError("RATE_LIMITED", "fixture rate limit", { provider: "fixture", provider_status: 429, retry_after_ms: 50 });
      if (fault === "server_error") throw new GatewayError("PROVIDER_ERROR", "fixture 500 before applying", { provider: "fixture", provider_status: 500 });
      if (fault === "unprovable_drop") {
        this.remote.unprovable.add(req.dedupe_key);
        throw new GatewayError("OUTCOME_UNKNOWN", "fixture connection dropped", { provider: "fixture" });
      }
      this.remote.writeCalls.push({ operation: req.operation, dedupe_key: req.dedupe_key });
      if (this.remote.writeDelayMs) Bun.sleepSync(this.remote.writeDelayMs);
      const result = this.apply(req, ctx, fault);
      this.remote.applied.set(req.dedupe_key, result.provider_ref);
      if (fault === "crash_after_apply") {
        this.remote.save();
        process.kill(process.pid, "SIGKILL");
      }
      if (fault === "drop_response") throw new GatewayError("OUTCOME_UNKNOWN", "fixture accepted the write but the response was lost", { provider: "fixture" });
      return result;
    });
  }

  private apply(req: WriteRequest, ctx: AdapterContext, fault: Fault | undefined): WriteResult {
    const now = new Date().toISOString();
    const p = req.params;
    const sub = ctx.account.provider_subject;
    switch (req.operation) {
      case "content.publish.text":
      case "content.publish.image":
      case "content.publish.video": {
        const kind = req.operation.split(".")[2] as Post["kind"];
        const id = this.remote.id("post");
        this.remote.posts.set(id, { id, account: sub, text: String(p.text ?? ""), kind, media_ref: (p.media_ref as string | undefined) ?? null, created_at: now, updated_at: now, deleted: false });
        return { provider_ref: id, url: `https://fixture.invalid/p/${id}`, at: now };
      }
      case "media.upload": {
        const id = this.remote.id("container");
        this.remote.containers.set(id, { polls: 0, ready_after: fault === "slow_container" ? 2 : 1, media_ref: id });
        return { provider_ref: id, pending: { container_id: id, poll_after_ms: 10 } };
      }
      case "content.update": {
        const post = this.remote.posts.get(String(p.content_id));
        if (!post || post.account !== sub || post.deleted) throw new GatewayError("PROVIDER_ERROR", "content not found", { provider: "fixture", provider_status: 404 });
        post.text = String(p.text ?? post.text);
        post.updated_at = now;
        return { provider_ref: post.id, url: `https://fixture.invalid/p/${post.id}`, at: now };
      }
      case "content.delete": {
        const post = this.remote.posts.get(String(p.content_id));
        if (!post || post.account !== sub) throw new GatewayError("PROVIDER_ERROR", "content not found", { provider: "fixture", provider_status: 404 });
        post.deleted = true;
        return { provider_ref: post.id, at: now };
      }
      case "engagement.reply": {
        const id = this.remote.id("comment");
        this.remote.comments.set(id, { id, content_id: String(p.target_id), author: sub, text: String(p.text ?? ""), hidden: false, reactions: 0 });
        return { provider_ref: id, at: now };
      }
      case "engagement.react":
      case "engagement.hide": {
        const c = this.remote.comments.get(String(p.target_id));
        if (!c) throw new GatewayError("PROVIDER_ERROR", "comment not found", { provider: "fixture", provider_status: 404 });
        if (req.operation === "engagement.hide") c.hidden = true;
        else c.reactions += 1;
        return { provider_ref: c.id, at: now };
      }
      case "auth.revoke": {
        const t = this.remote.tokens.get(ctx.tokens.access_token);
        if (t) t.revoked = true;
        return { provider_ref: `revoked-${ctx.account.provider_subject}`, at: now };
      }
      default:
        throw new GatewayError("UNSUPPORTED", `fixture cannot write ${req.operation}`);
    }
  }

  poll(_req: WriteRequest, _ctx: AdapterContext, containerId: string): Promise<{ done: boolean; provider_ref?: string }> {
    return this.tx(() => {
      const c = this.remote.containers.get(containerId);
      if (!c) throw new GatewayError("PROVIDER_ERROR", "unknown container", { provider: "fixture", provider_status: 404 });
      c.polls += 1;
      return c.polls >= c.ready_after ? { done: true, provider_ref: c.media_ref } : { done: false };
    });
  }

  async inspectWriteOutcome(req: WriteRequest): Promise<OutcomeEvidence> {
    this.remote.load();
    const ref = this.remote.applied.get(req.dedupe_key);
    if (ref) return { found: true, provider_ref: ref, url: req.operation.startsWith("content.publish") ? `https://fixture.invalid/p/${ref}` : null, note: "matched by client token" };
    if (this.remote.unprovable.has(req.dedupe_key)) return { found: null, note: "fixture cannot prove absence" };
    return { found: false, note: "no write with this client token" };
  }
}
