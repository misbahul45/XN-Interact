import { GatewayError } from "../../contracts/errors.ts";
import { OAuthAdapter, type HttpHolder, form, url } from "../base.ts";
import type { AdapterContext, ClientCredentials, OAuthProfile, OutcomeEvidence, ProviderIdentity, ReadResult, TokenSet, WriteRequest, WriteResult } from "../contract.ts";

/**
 * Instagram API with Unified Login (Facebook Login for Business). Meta's new apps cannot use Instagram Login any more,
 * so this adapter follows the Unified Login pages: the login dialog is facebook.com with a `config_id`, the code is
 * exchanged on graph.facebook.com with the Meta app id and secret, the token is a business system user token, and
 * every request names the Instagram professional account id in its path. Publishing needs a public media URL and is
 * not implemented here; reading the owner's own account is.
 */
const VERSION = "v27.0";
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const LOGIN_SCOPES = ["instagram_basic", "instagram_manage_insights", "instagram_content_publish", "instagram_manage_comments"];
const ACCOUNT_FIELDS = "id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website";
const MEDIA_FIELDS = "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count";
const ID = /^\d{5,30}$/;
const METRIC = /^[a-z_]{2,40}$/;
const PERIODS = new Set(["day", "week", "days_28", "lifetime"]);
const METRIC_TYPES = new Set(["total_value", "time_series"]);
const CAPTION_MAX = 2200;
const SHA256 = /^[0-9a-f]{64}$/;
const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** The public URL of an approved JPEG: content-addressed, so the file name is the sha256 of the bytes the owner approved. */
export function publicMediaUrl(base: string, sha256: string): string {
  return `${base}${sha256}.jpg`;
}

function parseTime(ts: string | undefined): number {
  return ts ? Date.parse(ts.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) : Number.NaN;
}

export interface InstagramOptions {
  publicMediaBase?: string | null;
  pollMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Media = { id?: string; caption?: string; media_type?: string; media_product_type?: string; permalink?: string; timestamp?: string; like_count?: number; comments_count?: number };

function mediaRow(m: Media): Record<string, unknown> {
  return {
    id: m.id,
    kind: typeof m.media_type === "string" ? m.media_type.toLowerCase() : "unknown",
    text: m.caption ?? "",
    created_at: m.timestamp,
    url: m.permalink ?? null,
    product_type: m.media_product_type,
    like_count: m.like_count,
    comments_count: m.comments_count,
  };
}

export class InstagramAdapter extends OAuthAdapter {
  private readonly opts: { publicMediaBase: string | null; pollMs: number; maxPolls: number; sleep: (ms: number) => Promise<void> };
  readonly oauth: OAuthProfile = {
    verified: true,
    authorize_url: "https://www.facebook.com/dialog/oauth",
    token_url: `${GRAPH}/oauth/access_token`,
    revoke_url: null,
    pkce: "none",
    redirect: "https",
    scope_separator: ",",
    callback_path: "/oauth/callback/instagram",
    requires_config_id: true,
    caveat: "Instagram API with Unified Login (Facebook Login for Business): needs a Meta app owned by a business portfolio, a login configuration (its config_id is stored with the app credentials), an HTTPS redirect URL (the local self-signed one: register https://127.0.0.1:47820/oauth/callback/instagram; if Meta refuses a loopback address you need an operator-owned HTTPS host) and an Instagram professional account invited as Instagram Tester while the app is in development. Publishing needs a public media URL and is not implemented.",
  };

  constructor(holder: HttpHolder, opts: InstagramOptions = {}) {
    super(holder, {
      provider: "instagram",
      hosts: opts.publicMediaBase ? ["graph.facebook.com", new URL(opts.publicMediaBase).host] : ["graph.facebook.com"],
      api_version: VERSION,
      login_scopes: LOGIN_SCOPES,
      account_types: ["professional"],
      scopes: {
        "account.read": ["instagram_basic"],
        "content.read": ["instagram_basic"],
        "content.publish.image": ["instagram_basic", "instagram_content_publish"],
        "content.publish.video": ["instagram_basic", "instagram_content_publish"],
        "media.upload": ["instagram_basic", "instagram_content_publish"],
        "engagement.read": ["instagram_basic", "instagram_manage_comments"],
        "engagement.reply": ["instagram_basic", "instagram_manage_comments"],
        "engagement.hide": ["instagram_basic", "instagram_manage_comments"],
        "analytics.read": ["instagram_basic", "instagram_manage_insights"],
        "reconcile.read": ["instagram_basic"],
      },
    });
    this.opts = { publicMediaBase: opts.publicMediaBase ?? null, pollMs: opts.pollMs ?? 3000, maxPolls: opts.maxPolls ?? 5, sleep: opts.sleep ?? ((ms) => Bun.sleep(ms)) };
    const ops = this.manifest.operations;
    for (const op of ["account.read", "content.read", "analytics.read"]) if (ops[op]) ops[op] = { ...ops[op]!, acceptance: true };
    // An image post is two writes under the media_publish workflow: `media.upload` creates the container (Meta fetches the image
    // from the public URL) and `content.publish.image` publishes it, so an acceptance run has to cover both.
    const pub = ops["content.publish.image"];
    const up = ops["media.upload"];
    const noHost = "Instagram fetches the image from a public URL: set XN_INTERACT_PUBLIC_MEDIA_BASE to the HTTPS directory where you host approved JPEGs";
    if (pub && up) {
      if (this.opts.publicMediaBase) {
        ops["content.publish.image"] = { ...pub, acceptance: true, acceptance_with: ["media.upload"], read_after_write: true, limits: { text_max: CAPTION_MAX, media_kinds: ["image"], media_mimes: ["image/jpeg"], max_media: 1 } };
        ops["media.upload"] = { ...up, acceptance: true };
      } else {
        ops["content.publish.image"] = { ...pub, verdict: "UNSUPPORTED", reason: noHost };
        ops["media.upload"] = { ...up, verdict: "UNSUPPORTED", reason: noHost };
      }
    }
    this.manifest.adapter_version = "0.3.0";
  }

  authorizeUrl(p: { state: string; redirect_uri: string; scopes: string[]; client: ClientCredentials }): string {
    if (!p.client.config_id) {
      throw new GatewayError("APP_APPROVAL_REQUIRED", "the Instagram login configuration id (config_id) is not stored; run `xn-interact app set instagram`", { provider: "instagram", actionable_next_step: "Create a configuration under Use cases > Manage messaging & content on Instagram > API setup with Unified login, then run `xn-interact app set instagram`" });
    }
    // The configuration decides the permissions, so no `scope` parameter is sent. `override_default_response_type` is in the
    // Login URL that Meta's own App Dashboard generates for a configuration, so it is sent too.
    return url(this.oauth.authorize_url!, { client_id: p.client.client_id, config_id: p.client.config_id, redirect_uri: p.redirect_uri, response_type: "code", override_default_response_type: "true", state: p.state, prompt: "login" });
  }

  async exchangeCode(p: { code: string; redirect_uri: string; client: ClientCredentials; scopes: string[] }): Promise<TokenSet> {
    const secret = this.need(p.client);
    // Meta's Unified Login page shows the exchange without redirect_uri, but Facebook's standard login flow requires the same
    // redirect_uri that started the login; sending it is correct in both cases.
    const res = await this.request({ method: "GET", url: url(`${GRAPH}/oauth/access_token`, { client_id: p.client.client_id, redirect_uri: p.redirect_uri, client_secret: secret, code: p.code }), safe: false });
    if (res.status !== 200) this.fail(res, "the authorization code exchange", false);
    const j = res.json<{ access_token?: string; expires_in?: number }>();
    if (!j.access_token) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "Instagram returned no access token", { provider: "instagram" });
    // A business system user token may carry no lifetime; it then stays valid until Meta or the client revokes it.
    if (typeof j.expires_in === "number" && j.expires_in > 0) return this.tokens(j.access_token, j.expires_in, p.scopes);
    return { access_token: j.access_token, expires_at: null, scopes: p.scopes, token_type: "bearer" };
  }

  async refresh(): Promise<TokenSet> {
    throw new GatewayError("REAUTH_REQUIRED", "Instagram business tokens are not refreshed here; the owner must log in again if one stops working", { provider: "instagram", actionable_next_step: "Call social_auth_connect with mode=upgrade" });
  }

  async identities(tokens: TokenSet): Promise<ProviderIdentity[]> {
    const res = await this.request({ method: "GET", url: url(`${GRAPH}/me/assigned_instagram_accounts`, { fields: "id,username", limit: "100", access_token: tokens.access_token }), safe: true });
    if (res.status !== 200) this.fail(res, "the Instagram account listing", true);
    const rows = (res.json<{ data?: { id?: string; username?: string }[] }>().data ?? []).filter((r) => typeof r.id === "string" && ID.test(r.id));
    if (!rows.length) {
      throw new GatewayError("PROVIDER_ERROR", "Instagram returned no professional account shared with this login", { provider: "instagram", actionable_next_step: "Pick an Instagram professional account in the login dialog, accept the Instagram Tester invitation, and keep instagram_basic granted" });
    }
    return rows.map((r) => ({
      subject: r.id!,
      display_name: r.username ?? r.id!,
      account_type: "professional",
      role: null,
      tokens: { access_token: tokens.access_token, expires_at: tokens.expires_at ?? null, scopes: tokens.scopes, token_type: "bearer" },
    }));
  }

  private reauth(res: { status: number; text: string }): boolean {
    return res.status === 401 || /"code"\s*:\s*190\b/.test(res.text);
  }

  override async read(operation: string, ctx: AdapterContext, params: Record<string, unknown>): Promise<ReadResult> {
    const token = ctx.tokens.access_token;
    const ig = ctx.account.provider_subject;
    if (!ID.test(ig)) throw new GatewayError("VALIDATION_FAILED", "the stored Instagram account id is not valid");

    if (operation === "account.read") {
      const res = await this.request({ method: "GET", url: url(`${GRAPH}/${ig}`, { fields: ACCOUNT_FIELDS, access_token: token }), safe: true });
      if (res.status !== 200) this.fail(res, "the account read", this.reauth(res));
      return { item: res.json<Record<string, unknown>>() };
    }

    if (operation === "content.read") {
      if (params.content_id !== undefined) {
        const id = String(params.content_id);
        if (!ID.test(id)) throw new GatewayError("VALIDATION_FAILED", "content_id is not an Instagram media id");
        const one = await this.request({ method: "GET", url: url(`${GRAPH}/${id}`, { fields: MEDIA_FIELDS, access_token: token }), safe: true });
        if (one.status !== 200) this.fail(one, "the media read", this.reauth(one));
        return { item: mediaRow(one.json<Media>()) };
      }
      const limit = Math.max(1, Math.min(Number(params.limit ?? 20) || 20, 25));
      const after = typeof params.cursor === "string" && /^[\w=-]{1,300}$/.test(params.cursor) ? params.cursor : undefined;
      const list = await this.request({ method: "GET", url: url(`${GRAPH}/${ig}/media`, { fields: MEDIA_FIELDS, limit: String(limit), after, access_token: token }), safe: true });
      if (list.status !== 200) this.fail(list, "the media list", this.reauth(list));
      const j = list.json<{ data?: Media[]; paging?: { cursors?: { after?: string } } }>();
      const items = (j.data ?? []).map(mediaRow);
      return { items, next_cursor: items.length >= limit ? (j.paging?.cursors?.after ?? null) : null };
    }

    if (operation === "analytics.read") {
      const contentId = params.content_id === undefined ? undefined : String(params.content_id);
      if (contentId !== undefined && !ID.test(contentId)) throw new GatewayError("VALIDATION_FAILED", "content_id is not an Instagram media id");
      const raw = params.metric ?? "reach";
      const metrics = (Array.isArray(raw) ? raw : String(raw).split(",")).map((m) => String(m).trim()).filter(Boolean);
      if (!metrics.length || metrics.length > 10 || metrics.some((m) => !METRIC.test(m))) throw new GatewayError("VALIDATION_FAILED", "metric must be 1 to 10 insight metric names such as reach");
      const period = String(params.period ?? "day");
      if (!PERIODS.has(period)) throw new GatewayError("VALIDATION_FAILED", `period must be one of ${[...PERIODS].join(", ")}`);
      const metricType = params.metric_type === undefined ? undefined : String(params.metric_type);
      if (metricType !== undefined && !METRIC_TYPES.has(metricType)) throw new GatewayError("VALIDATION_FAILED", `metric_type must be one of ${[...METRIC_TYPES].join(", ")}`);
      const res = await this.request({ method: "GET", url: url(`${GRAPH}/${contentId ?? ig}/insights`, { metric: metrics.join(","), period, metric_type: metricType, access_token: token }), safe: true });
      if (res.status !== 200) this.fail(res, "the insights read", this.reauth(res));
      // The gateway reports `item` as the metrics object: one entry per metric, a total or the list of values over time.
      const rows = res.json<{ data?: { name?: string; total_value?: { value?: unknown }; values?: unknown[] }[] }>().data ?? [];
      const item: Record<string, unknown> = {};
      for (const r of rows) if (typeof r.name === "string") item[r.name] = r.total_value?.value ?? r.values ?? null;
      return { item };
    }

    return this.unverified("reading");
  }

  override async write(req: WriteRequest, ctx: AdapterContext): Promise<WriteResult> {
    if (req.operation === "media.upload") return this.createContainer(req, ctx);
    if (req.operation === "content.publish.image") return this.publishContainer(req, ctx);
    return this.unverified("publishing");
  }

  /** Step 1: Meta fetches the image from its public URL and prepares a container. Nothing is visible on Instagram yet. */
  private async createContainer(req: WriteRequest, ctx: AdapterContext): Promise<WriteResult> {
    const base = this.opts.publicMediaBase;
    if (!base) throw new GatewayError("UNSUPPORTED", "Instagram image publishing needs XN_INTERACT_PUBLIC_MEDIA_BASE", { provider: "instagram" });
    const media = (req.params.media as { mime?: string; sha256?: string; alt_text?: string | null }[] | undefined) ?? [];
    if (media.length !== 1) throw new GatewayError("VALIDATION_FAILED", "an Instagram image post needs exactly one image");
    const m = media[0]!;
    if (m.mime !== "image/jpeg" || !SHA256.test(m.sha256 ?? "")) throw new GatewayError("VALIDATION_FAILED", "Instagram only accepts a JPEG image");
    const caption = typeof req.params.text === "string" ? req.params.text : "";
    if (caption.length > CAPTION_MAX) throw new GatewayError("VALIDATION_FAILED", `Instagram captions are limited to ${CAPTION_MAX} characters`);
    const ig = ctx.account.provider_subject;
    if (!ID.test(ig)) throw new GatewayError("VALIDATION_FAILED", "the stored Instagram account id is not valid");
    const token = ctx.tokens.access_token;
    const imageUrl = publicMediaUrl(base, m.sha256!);

    // Check before anything is sent to Meta that the approved file really is served at its public URL.
    const head = await this.request({ method: "HEAD", url: imageUrl, safe: true });
    if (head.status !== 200) {
      throw new GatewayError("VALIDATION_FAILED", `the approved image is not reachable at its public URL (HTTP ${head.status}); nothing was sent to Instagram`, { provider: "instagram", actionable_next_step: "Host the file first: xn-interact media host <file>" });
    }
    const type = head.headers.get("content-type") ?? "";
    if (!/^image\/jpeg\b/i.test(type)) throw new GatewayError("VALIDATION_FAILED", `the public URL serves ${type || "an unknown type"}, not image/jpeg; nothing was sent to Instagram`, { provider: "instagram" });

    let created;
    try {
      created = await this.request({ method: "POST", url: `${GRAPH}/${ig}/media`, headers: FORM, body: form({ image_url: imageUrl, caption: caption || undefined, alt_text: m.alt_text ?? undefined, access_token: token }), safe: false });
    } catch (e) {
      if (e instanceof GatewayError && e.code === "OUTCOME_UNKNOWN") throw new GatewayError("PROVIDER_UNAVAILABLE", "Instagram did not answer while creating the media container; nothing was published", { provider: "instagram" });
      throw e;
    }
    if (created.status !== 200) this.fail(created, "creating the media container", this.reauth(created));
    const containerId = created.json<{ id?: string }>().id;
    if (!containerId || !ID.test(containerId)) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "Instagram returned no container id", { provider: "instagram" });
    return { provider_ref: containerId, pending: { container_id: containerId, poll_after_ms: this.opts.pollMs } };
  }

  /** Step 2 (polled by the workflow): FINISHED means the image was fetched and the container can be published. */
  async poll(_req: WriteRequest, ctx: AdapterContext, containerId: string): Promise<{ done: boolean; provider_ref?: string }> {
    if (!ID.test(containerId)) throw new GatewayError("VALIDATION_FAILED", "container id is not valid");
    const st = await this.request({ method: "GET", url: url(`${GRAPH}/${containerId}`, { fields: "status_code", access_token: ctx.tokens.access_token }), safe: true });
    if (st.status !== 200) this.fail(st, "checking the media container", this.reauth(st));
    const code = st.json<{ status_code?: string }>().status_code;
    if (code === "FINISHED") return { done: true, provider_ref: containerId };
    if (code === "ERROR" || code === "EXPIRED") throw new GatewayError("PROVIDER_ERROR", `Instagram could not prepare the image (${code}); nothing was published`, { provider: "instagram" });
    return { done: false };
  }

  /** Step 3: the only step that makes the post visible. A server error here is an unknown outcome and is never retried. */
  private async publishContainer(req: WriteRequest, ctx: AdapterContext): Promise<WriteResult> {
    const container = typeof req.params.media_ref === "string" ? req.params.media_ref : "";
    if (!ID.test(container)) throw new GatewayError("VALIDATION_FAILED", "there is no prepared Instagram container to publish");
    const ig = ctx.account.provider_subject;
    if (!ID.test(ig)) throw new GatewayError("VALIDATION_FAILED", "the stored Instagram account id is not valid");
    const token = ctx.tokens.access_token;
    const pub = await this.request({ method: "POST", url: `${GRAPH}/${ig}/media_publish`, headers: FORM, body: form({ creation_id: container, access_token: token }), safe: false });
    if (pub.status >= 500) throw new GatewayError("OUTCOME_UNKNOWN", "Instagram answered the publish request with a server error; the post may or may not exist", { provider: "instagram", provider_status: pub.status });
    if (pub.status !== 200) this.fail(pub, "publishing the media", this.reauth(pub));
    const id = pub.json<{ id?: string }>().id;
    if (!id) throw new GatewayError("OUTCOME_UNKNOWN", "Instagram accepted the publish request but returned no media id", { provider: "instagram" });

    let permalink: string | null = null;
    let at: string | undefined;
    try {
      const got = await this.request({ method: "GET", url: url(`${GRAPH}/${id}`, { fields: "permalink,timestamp", access_token: token }), safe: true });
      if (got.status === 200) {
        const j = got.json<{ permalink?: string; timestamp?: string }>();
        permalink = typeof j.permalink === "string" ? j.permalink : null;
        at = typeof j.timestamp === "string" ? j.timestamp : undefined;
      }
    } catch {}
    return { provider_ref: id, url: permalink, at };
  }

  override async inspectWriteOutcome(req: WriteRequest, ctx: AdapterContext): Promise<OutcomeEvidence> {
    if (req.operation === "media.upload") return { found: null, note: "a prepared container is not visible anywhere; nothing is published until media_publish" };
    if (req.operation !== "content.publish.image") return this.unverified("write read-back");
    const caption = typeof req.params.text === "string" ? req.params.text.trim() : "";
    if (!caption) return { found: null, note: "a post without a caption cannot be matched; check the account in Instagram" };
    const res = await this.request({ method: "GET", url: url(`${GRAPH}/${ctx.account.provider_subject}/media`, { fields: MEDIA_FIELDS, limit: "25", access_token: ctx.tokens.access_token }), safe: true });
    if (res.status !== 200) return { found: null, note: `media list unavailable (${res.status})` };
    const rows = res.json<{ data?: Media[] }>().data ?? [];
    const cutoff = Date.now() - 24 * 3600_000;
    const hit = rows.find((r) => r.id && (r.caption ?? "").trim() === caption && (!r.timestamp || parseTime(r.timestamp) >= cutoff));
    if (hit) return { found: true, provider_ref: hit.id, url: hit.permalink ?? null, note: "matched by identical caption among the 25 most recent posts" };
    return { found: null, note: "no matching post among the 25 most recent; absence cannot be proven" };
  }
}
