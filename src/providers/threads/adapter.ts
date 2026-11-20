import { GatewayError } from "../../contracts/errors.ts";
import { OAuthAdapter, type HttpHolder, form, url } from "../base.ts";
import type { AdapterContext, ClientCredentials, OAuthProfile, OutcomeEvidence, ProviderIdentity, ReadResult, TokenSet, WriteRequest, WriteResult } from "../contract.ts";

export type { HttpHolder };

const API = "https://graph.threads.com";
const V = `${API}/v1.0`;
const TEXT_MAX = 500;
const FIELDS = "id,text,permalink,timestamp,username,media_type";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

export function threadsTextLength(text: string): number {
  let n = 0;
  const enc = new TextEncoder();
  for (const ch of text) n += /\p{Extended_Pictographic}/u.test(ch) ? enc.encode(ch).length : 1;
  return n;
}

export interface ThreadsOptions {
  pollMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class ThreadsAdapter extends OAuthAdapter {
  readonly oauth: OAuthProfile = {
    verified: true,
    authorize_url: "https://threads.com/oauth/authorize",
    token_url: `${API}/oauth/access_token`,
    revoke_url: null,
    pkce: "none",
    redirect: "https",
    scope_separator: ",",
    callback_path: "/oauth/callback/threads",
    caveat: "Meta's console refuses http redirects for Threads (\"HTTPS is required for all redirect URLs\"), so this uses the local self-signed HTTPS callback; register https://127.0.0.1:47820/oauth/callback/threads. The browser warns about the certificate once.",
  };

  private readonly opts: Required<ThreadsOptions>;

  constructor(holder: HttpHolder, opts: ThreadsOptions = {}) {
    super(holder, {
      provider: "threads",
      hosts: ["graph.threads.com"],
      api_version: "v1.0",
      login_scopes: ["threads_basic", "threads_content_publish"],
      account_types: ["profile"],
      scopes: {
        "account.read": ["threads_basic"],
        "content.read": ["threads_basic"],
        "content.publish.text": ["threads_basic", "threads_content_publish"],
        "content.publish.image": ["threads_basic", "threads_content_publish"],
        "content.publish.video": ["threads_basic", "threads_content_publish"],
        "media.upload": ["threads_basic", "threads_content_publish"],
        "engagement.read": ["threads_basic", "threads_read_replies"],
        "engagement.reply": ["threads_basic", "threads_manage_replies"],
        "analytics.read": ["threads_basic", "threads_manage_insights"],
        "reconcile.read": ["threads_basic"],
      },
    });
    this.opts = { pollMs: opts.pollMs ?? 3000, maxPolls: opts.maxPolls ?? 10, sleep: opts.sleep ?? ((ms) => Bun.sleep(ms)) };
    const ops = this.manifest.operations;
    for (const op of ["account.read", "content.read", "content.publish.text"]) if (ops[op]) ops[op] = { ...ops[op]!, acceptance: true };
    ops["content.publish.text"] = { ...ops["content.publish.text"]!, read_after_write: true, limits: { text_max: TEXT_MAX } };
    this.manifest.adapter_version = "0.2.0";
  }

  authorizeUrl(p: { state: string; redirect_uri: string; scopes: string[]; client: ClientCredentials }): string {
    return url("https://threads.com/oauth/authorize", { client_id: p.client.client_id, redirect_uri: p.redirect_uri, scope: p.scopes.join(","), response_type: "code", state: p.state });
  }

  async exchangeCode(p: { code: string; redirect_uri: string; client: ClientCredentials; scopes: string[] }): Promise<TokenSet> {
    const secret = this.need(p.client);
    const short = await this.request({ method: "POST", url: `${API}/oauth/access_token`, headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ client_id: p.client.client_id, client_secret: secret, code: p.code, grant_type: "authorization_code", redirect_uri: p.redirect_uri }), safe: false });
    if (short.status !== 200) this.fail(short, "the authorization code exchange", false);
    const s = short.json<{ access_token?: string }>();
    if (!s.access_token) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "Threads returned no access token", { provider: "threads" });
    const long = await this.request({ method: "GET", url: url(`${API}/access_token`, { grant_type: "th_exchange_token", client_secret: secret, access_token: s.access_token }), safe: false });
    if (long.status !== 200) this.fail(long, "the long-lived token exchange", false);
    const l = long.json<{ access_token?: string; expires_in?: number }>();
    if (!l.access_token) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "Threads returned no long-lived token", { provider: "threads" });
    return this.tokens(l.access_token, l.expires_in, p.scopes, { refresh_token: l.access_token });
  }

  async refresh(tokens: TokenSet): Promise<TokenSet> {
    const res = await this.request({ method: "GET", url: url(`${API}/refresh_access_token`, { grant_type: "th_refresh_token", access_token: tokens.access_token }), safe: true });
    if (res.status !== 200) this.fail(res, "the token refresh", true);
    const j = res.json<{ access_token?: string; expires_in?: number }>();
    if (!j.access_token) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "Threads returned no refreshed token", { provider: "threads" });
    return this.tokens(j.access_token, j.expires_in, tokens.scopes, { refresh_token: j.access_token });
  }

  async identities(tokens: TokenSet): Promise<ProviderIdentity[]> {
    const res = await this.request({ method: "GET", url: url(`${API}/v1.0/me`, { fields: "id,username,name", access_token: tokens.access_token }), safe: true });
    if (res.status !== 200) this.fail(res, "the profile lookup", true);
    const j = res.json<{ id?: string; username?: string; name?: string }>();
    if (!j.id) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "Threads returned no profile id", { provider: "threads" });
    return [{ subject: String(j.id), display_name: j.username ?? j.name ?? String(j.id), account_type: "profile", role: null }];
  }

  private qs(path: string, token: string, extra: Record<string, string | undefined> = {}): string {
    return url(`${V}/${path}`, { ...extra, access_token: token });
  }

  override async read(operation: string, ctx: AdapterContext, params: Record<string, unknown>): Promise<ReadResult> {
    const token = ctx.tokens.access_token;
    if (operation === "account.read") {
      const res = await this.request({ method: "GET", url: this.qs("me", token, { fields: "id,username,name" }), safe: true });
      if (res.status !== 200) this.fail(res, "the profile read", res.status === 401);
      return { item: res.json<Record<string, unknown>>() };
    }
    if (operation === "content.read") {
      if (params.content_id !== undefined) {
        const id = String(params.content_id);
        if (!/^\d{5,30}$/.test(id)) throw new GatewayError("VALIDATION_FAILED", "content_id is not a Threads media id");
        const one = await this.request({ method: "GET", url: this.qs(id, token, { fields: FIELDS }), safe: true });
        if (one.status !== 200) this.fail(one, "the post read", one.status === 401);
        return { item: one.json<Record<string, unknown>>() };
      }
      const limit = Math.max(1, Math.min(Number(params.limit ?? 20) || 20, 25));
      const after = typeof params.cursor === "string" && /^[\w-]{1,200}$/.test(params.cursor) ? params.cursor : undefined;
      const list = await this.request({ method: "GET", url: this.qs(`${ctx.account.provider_subject}/threads`, token, { fields: FIELDS, limit: String(limit), after }), safe: true });
      if (list.status !== 200) this.fail(list, "the post list", list.status === 401);
      const j = list.json<{ data?: Record<string, unknown>[]; paging?: { cursors?: { after?: string } } }>();
      const items = j.data ?? [];
      return { items, next_cursor: items.length >= limit ? (j.paging?.cursors?.after ?? null) : null };
    }
    return this.unverified("reading");
  }

  override async write(req: WriteRequest, ctx: AdapterContext): Promise<WriteResult> {
    if (req.operation !== "content.publish.text") return this.unverified("publishing");
    const text = typeof req.params.text === "string" ? req.params.text : "";
    if (!text.trim()) throw new GatewayError("VALIDATION_FAILED", "a Threads text post needs text");
    if (threadsTextLength(text) > TEXT_MAX) throw new GatewayError("VALIDATION_FAILED", `Threads text posts are limited to ${TEXT_MAX} characters (emoji count as their UTF-8 bytes)`);
    const uid = ctx.account.provider_subject;
    const token = ctx.tokens.access_token;

    let created;
    try {
      created = await this.request({ method: "POST", url: `${V}/${uid}/threads`, headers: FORM, body: form({ media_type: "TEXT", text, access_token: token }), safe: false });
    } catch (e) {
      if (e instanceof GatewayError && e.code === "OUTCOME_UNKNOWN") throw new GatewayError("PROVIDER_UNAVAILABLE", "Threads did not answer while creating the post container; nothing was published", { provider: "threads" });
      throw e;
    }
    if (created.status !== 200) this.fail(created, "creating the post container", created.status === 401);
    const containerId = created.json<{ id?: string }>().id;
    if (!containerId) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "Threads returned no container id", { provider: "threads" });

    let ready = false;
    for (let i = 0; i < this.opts.maxPolls && !ready; i++) {
      const st = await this.request({ method: "GET", url: this.qs(containerId, token, { fields: "status,error_message" }), safe: true });
      if (st.status !== 200) this.fail(st, "checking the post container", st.status === 401);
      const status = st.json<{ status?: string; error_message?: string }>();
      if (status.status === "FINISHED") ready = true;
      else if (status.status === "ERROR" || status.status === "EXPIRED") throw new GatewayError("PROVIDER_ERROR", `Threads could not prepare the post (${status.status}${status.error_message ? `: ${String(status.error_message).slice(0, 80)}` : ""}); nothing was published`, { provider: "threads" });
      else await this.opts.sleep(this.opts.pollMs);
    }
    if (!ready) throw new GatewayError("PROVIDER_UNAVAILABLE", "Threads is still preparing the post container; nothing was published and the container expires on its own", { provider: "threads", retry_after_ms: 60_000 });

    const pub = await this.request({ method: "POST", url: `${V}/${uid}/threads_publish`, headers: FORM, body: form({ creation_id: containerId, access_token: token }), safe: false });
    if (pub.status >= 500) throw new GatewayError("OUTCOME_UNKNOWN", "Threads answered the publish request with a server error; the post may or may not exist", { provider: "threads", provider_status: pub.status });
    if (pub.status !== 200) this.fail(pub, "publishing the post", pub.status === 401);
    const id = pub.json<{ id?: string }>().id;
    if (!id) throw new GatewayError("OUTCOME_UNKNOWN", "Threads accepted the publish request but returned no post id", { provider: "threads" });

    let permalink: string | null = null;
    let at: string | undefined;
    try {
      const got = await this.request({ method: "GET", url: this.qs(id, token, { fields: "id,permalink,timestamp" }), safe: true });
      if (got.status === 200) {
        const j = got.json<{ permalink?: string; timestamp?: string }>();
        permalink = typeof j.permalink === "string" ? j.permalink : null;
        at = typeof j.timestamp === "string" ? j.timestamp : undefined;
      }
    } catch {}
    return { provider_ref: id, url: permalink, at };
  }

  override async inspectWriteOutcome(req: WriteRequest, ctx: AdapterContext): Promise<OutcomeEvidence> {
    if (req.operation !== "content.publish.text") return this.unverified("write read-back");
    const text = typeof req.params.text === "string" ? req.params.text : "";
    const token = ctx.tokens.access_token;
    const res = await this.request({ method: "GET", url: this.qs(`${ctx.account.provider_subject}/threads`, token, { fields: FIELDS, limit: "25" }), safe: true });
    if (res.status !== 200) return { found: null, note: `post list unavailable (${res.status})` };
    const rows = res.json<{ data?: { id?: string; text?: string; permalink?: string; timestamp?: string }[] }>().data ?? [];
    const cutoff = Date.now() - 24 * 3600_000;
    const hit = rows.find((r) => r.id && r.text === text && (!r.timestamp || Date.parse(r.timestamp) >= cutoff));
    if (hit) return { found: true, provider_ref: hit.id, url: hit.permalink ?? null, note: "matched by identical text among the 25 most recent posts" };
    return { found: null, note: "no matching post among the 25 most recent; Threads has no client token, so absence cannot be proven" };
  }
}
