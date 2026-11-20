import { GatewayError } from "../../contracts/errors.ts";
import { OAuthAdapter, type HttpHolder, url } from "../base.ts";
import type { ClientCredentials, OAuthProfile, ProviderIdentity, TokenSet } from "../contract.ts";

const VERSION = "v27.0";
const GRAPH = `https://graph.facebook.com/${VERSION}`;

export class FacebookAdapter extends OAuthAdapter {
  readonly oauth: OAuthProfile = {
    verified: true,
    authorize_url: `https://www.facebook.com/${VERSION}/dialog/oauth`,
    token_url: `${GRAPH}/oauth/access_token`,
    revoke_url: null,
    pkce: "none",
    redirect: "loopback",
    scope_separator: ",",
    callback_path: "/oauth/callback/facebook",
    caveat: "Only Facebook Pages you can manage are connected (one account per Page); personal profiles are not offered. Meta's pages do not say whether an http://127.0.0.1 redirect is accepted; if the dashboard rejects it, connect again with --https.",
  };

  constructor(holder: HttpHolder) {
    super(holder, {
      provider: "facebook",
      hosts: ["graph.facebook.com"],
      api_version: VERSION,
      login_scopes: ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "pages_manage_engagement"],
      account_types: ["page"],
      scopes: {
        "account.read": ["pages_show_list"],
        "content.read": ["pages_read_engagement"],
        "content.publish.text": ["pages_manage_posts"],
        "content.publish.image": ["pages_manage_posts"],
        "engagement.read": ["pages_read_engagement"],
        "engagement.reply": ["pages_manage_engagement"],
        "engagement.hide": ["pages_manage_engagement"],
      },
    });
  }

  authorizeUrl(p: { state: string; redirect_uri: string; scopes: string[]; client: ClientCredentials }): string {
    return url(this.oauth.authorize_url!, { client_id: p.client.client_id, redirect_uri: p.redirect_uri, state: p.state, scope: p.scopes.join(","), response_type: "code" });
  }

  async exchangeCode(p: { code: string; redirect_uri: string; client: ClientCredentials; scopes: string[] }): Promise<TokenSet> {
    const secret = this.need(p.client);
    const short = await this.request({ method: "GET", url: url(`${GRAPH}/oauth/access_token`, { client_id: p.client.client_id, redirect_uri: p.redirect_uri, client_secret: secret, code: p.code }), safe: false });
    if (short.status !== 200) this.fail(short, "the authorization code exchange", false);
    const s = short.json<{ access_token?: string }>();
    if (!s.access_token) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "Facebook returned no access token", { provider: "facebook" });
    const long = await this.request({ method: "GET", url: url(`${GRAPH}/oauth/access_token`, { grant_type: "fb_exchange_token", client_id: p.client.client_id, client_secret: secret, fb_exchange_token: s.access_token }), safe: false });
    if (long.status !== 200) this.fail(long, "the long-lived token exchange", false);
    const l = long.json<{ access_token?: string; expires_in?: number }>();
    if (!l.access_token) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "Facebook returned no long-lived token", { provider: "facebook" });
    return this.tokens(l.access_token, l.expires_in, p.scopes);
  }

  async refresh(): Promise<TokenSet> {
    throw new GatewayError("REAUTH_REQUIRED", "Facebook Page tokens are not refreshed; the owner must log in again if one is invalidated", { provider: "facebook" });
  }

  async identities(tokens: TokenSet): Promise<ProviderIdentity[]> {
    const res = await this.request({ method: "GET", url: url(`${GRAPH}/me/accounts`, { fields: "id,name,access_token,tasks", limit: "100", access_token: tokens.access_token }), safe: true });
    if (res.status !== 200) this.fail(res, "the Page listing", true);
    const j = res.json<{ data?: { id?: string; name?: string; access_token?: string; tasks?: string[] }[] }>();
    const pages = (j.data ?? []).filter((x) => x.id && x.access_token);
    if (!pages.length) throw new GatewayError("PROVIDER_ERROR", "Facebook returned no Pages you can manage; only Pages can be connected", { provider: "facebook", actionable_next_step: "Make sure the login grants pages_show_list and that you have a role on at least one Page" });
    return pages.map((pg) => ({
      subject: pg.id!,
      display_name: pg.name ?? pg.id!,
      account_type: "page",
      role: (pg.tasks ?? []).join(",") || null,
      tokens: { access_token: pg.access_token!, expires_at: null, scopes: tokens.scopes, token_type: "bearer" },
    }));
  }
}
