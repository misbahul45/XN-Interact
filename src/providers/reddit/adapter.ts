import { GatewayError } from "../../contracts/errors.ts";
import { OAuthAdapter, type HttpHolder, basic, form, url } from "../base.ts";
import type { ClientCredentials, OAuthProfile, ProviderIdentity, TokenSet } from "../contract.ts";

const TOKEN = "https://www.reddit.com/api/v1/access_token";
const UA = "xn-interact/0.1 (personal local OAuth client)";

export class RedditAdapter extends OAuthAdapter {
  readonly oauth: OAuthProfile = {
    verified: true,
    authorize_url: "https://www.reddit.com/api/v1/authorize",
    token_url: TOKEN,
    revoke_url: "https://www.reddit.com/api/v1/revoke_token",
    pkce: "none",
    redirect: "loopback",
    scope_separator: " ",
    callback_path: "/oauth/callback/reddit",
    caveat: "These endpoints come from an archived Reddit wiki. Reddit's current API access policy could not be read, so registering an app may need Reddit's approval first; read the Responsible Builder Policy in a browser.",
  };

  constructor(holder: HttpHolder) {
    super(holder, {
      provider: "reddit",
      hosts: ["www.reddit.com", "oauth.reddit.com"],
      api_version: null,
      login_scopes: ["identity", "submit", "read"],
      account_types: ["user"],
      scopes: {
        "account.read": ["identity"],
        "content.read": ["read", "history"],
        "content.publish.text": ["submit"],
        "engagement.reply": ["submit"],
        "engagement.react": ["vote"],
        "engagement.read": ["read"],
      },
    });
  }

  authorizeUrl(p: { state: string; redirect_uri: string; scopes: string[]; client: ClientCredentials }): string {
    return url("https://www.reddit.com/api/v1/authorize", { client_id: p.client.client_id, response_type: "code", state: p.state, redirect_uri: p.redirect_uri, duration: "permanent", scope: p.scopes.join(" ") });
  }

  private headers(client: ClientCredentials): Record<string, string> {
    return { authorization: basic(client.client_id, client.client_secret), "content-type": "application/x-www-form-urlencoded", "user-agent": UA };
  }

  private parse(res: { status: number; text: string; json<T>(): T }, what: string, reauth: boolean, requested: string[], previous?: TokenSet): TokenSet {
    if (res.status !== 200) this.fail(res, what, reauth);
    const j = res.json<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string }>();
    if (!j.access_token || j.error) throw new GatewayError(reauth ? "REAUTH_REQUIRED" : "PROVIDER_ERROR", `Reddit rejected ${what}`, { provider: "reddit" });
    const scopes = j.scope ? j.scope.split(/[ ,]+/).filter(Boolean) : requested;
    return this.tokens(j.access_token, j.expires_in ?? 3600, scopes, { refresh_token: j.refresh_token ?? previous?.refresh_token ?? null });
  }

  async exchangeCode(p: { code: string; redirect_uri: string; client: ClientCredentials; scopes: string[] }): Promise<TokenSet> {
    const res = await this.request({ method: "POST", url: TOKEN, headers: this.headers(p.client), body: form({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirect_uri }), safe: false });
    return this.parse(res, "the authorization code exchange", false, p.scopes);
  }

  async refresh(tokens: TokenSet, client: ClientCredentials): Promise<TokenSet> {
    if (!tokens.refresh_token) throw new GatewayError("REAUTH_REQUIRED", "Reddit grant has no refresh token (permanent duration was not granted)", { provider: "reddit" });
    const res = await this.request({ method: "POST", url: TOKEN, headers: this.headers(client), body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }), safe: false });
    return this.parse(res, "the token refresh", true, tokens.scopes, tokens);
  }

  override async revoke(tokens: TokenSet, client: ClientCredentials): Promise<boolean> {
    const target = tokens.refresh_token ?? tokens.access_token;
    const res = await this.request({ method: "POST", url: "https://www.reddit.com/api/v1/revoke_token", headers: this.headers(client), body: form({ token: target, token_type_hint: tokens.refresh_token ? "refresh_token" : "access_token" }), safe: false });
    return res.status === 200 || res.status === 204;
  }

  async identities(tokens: TokenSet): Promise<ProviderIdentity[]> {
    const res = await this.request({ method: "GET", url: "https://oauth.reddit.com/api/v1/me", headers: { authorization: `Bearer ${tokens.access_token}`, "user-agent": UA }, safe: true });
    if (res.status !== 200) this.fail(res, "the profile lookup", true);
    const j = res.json<{ id?: string; name?: string }>();
    if (!j.id) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "Reddit returned no user id", { provider: "reddit" });
    return [{ subject: j.id, display_name: j.name ? `u/${j.name}` : j.id, account_type: "user", role: null }];
  }
}
