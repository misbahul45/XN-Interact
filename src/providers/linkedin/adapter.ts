import { GatewayError } from "../../contracts/errors.ts";
import { OAuthAdapter, type HttpHolder, form, url } from "../base.ts";
import type { ClientCredentials, OAuthProfile, ProviderIdentity, TokenSet } from "../contract.ts";

const TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";

interface LinkedInToken {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export class LinkedInAdapter extends OAuthAdapter {
  readonly oauth: OAuthProfile = {
    verified: true,
    authorize_url: "https://www.linkedin.com/oauth/v2/authorization",
    token_url: TOKEN,
    revoke_url: null,
    pkce: "none",
    redirect: "https",
    scope_separator: " ",
    callback_path: "/oauth/callback/linkedin",
    caveat: "LinkedIn documents only HTTPS redirect URLs, so this uses the local self-signed HTTPS callback (register https://127.0.0.1:47820/oauth/callback/linkedin). If LinkedIn refuses a loopback address you need an operator-owned HTTPS host (task P8-08). Access tokens last 60 days and cannot be refreshed unless LinkedIn enabled programmatic refresh for your app.",
  };

  constructor(holder: HttpHolder) {
    super(holder, {
      provider: "linkedin",
      hosts: ["www.linkedin.com", "api.linkedin.com"],
      api_version: null,
      login_scopes: ["openid", "profile", "w_member_social"],
      account_types: ["member"],
      scopes: {
        "account.read": ["openid", "profile"],
        "content.publish.text": ["w_member_social"],
        "content.publish.image": ["w_member_social"],
        "content.publish.video": ["w_member_social"],
        "media.upload": ["w_member_social"],
      },
    });
  }

  authorizeUrl(p: { state: string; redirect_uri: string; scopes: string[]; client: ClientCredentials }): string {
    return url("https://www.linkedin.com/oauth/v2/authorization", { response_type: "code", client_id: p.client.client_id, redirect_uri: p.redirect_uri, state: p.state, scope: p.scopes.join(" ") });
  }

  private parse(res: { status: number; text: string; json<T>(): T }, what: string, reauth: boolean, requested: string[]): TokenSet {
    if (res.status !== 200) this.fail(res, what, reauth);
    const j = res.json<LinkedInToken>();
    if (!j.access_token) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "LinkedIn returned no access token", { provider: "linkedin" });
    const scopes = j.scope ? j.scope.split(/[ ,]+/).filter(Boolean) : requested;
    return this.tokens(j.access_token, j.expires_in, scopes, { refresh_token: j.refresh_token ?? null });
  }

  async exchangeCode(p: { code: string; redirect_uri: string; client: ClientCredentials; scopes: string[] }): Promise<TokenSet> {
    const res = await this.request({ method: "POST", url: TOKEN, headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "authorization_code", code: p.code, client_id: p.client.client_id, client_secret: this.need(p.client), redirect_uri: p.redirect_uri }), safe: false });
    return this.parse(res, "the authorization code exchange", false, p.scopes);
  }

  async refresh(tokens: TokenSet, client: ClientCredentials): Promise<TokenSet> {
    if (!tokens.refresh_token) throw new GatewayError("REAUTH_REQUIRED", "LinkedIn grant has no refresh token; the member must consent again", { provider: "linkedin" });
    const res = await this.request({ method: "POST", url: TOKEN, headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, client_secret: this.need(client) }), safe: false });
    return this.parse(res, "the token refresh", true, tokens.scopes);
  }

  async identities(tokens: TokenSet): Promise<ProviderIdentity[]> {
    const res = await this.request({ method: "GET", url: "https://api.linkedin.com/v2/userinfo", headers: { authorization: `Bearer ${tokens.access_token}` }, safe: true });
    if (res.status !== 200) this.fail(res, "the profile lookup", true);
    const j = res.json<{ sub?: string; name?: string }>();
    if (!j.sub) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "LinkedIn returned no member id", { provider: "linkedin" });
    return [{ subject: j.sub, display_name: j.name ?? j.sub, account_type: "member", role: null }];
  }
}
