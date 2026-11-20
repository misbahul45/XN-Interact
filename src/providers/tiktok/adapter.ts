import { GatewayError } from "../../contracts/errors.ts";
import { OAuthAdapter, type HttpHolder, form, url } from "../base.ts";
import type { ClientCredentials, OAuthProfile, ProviderIdentity, TokenSet } from "../contract.ts";

const TOKEN = "https://open.tiktokapis.com/v2/oauth/token/";

interface TikTokToken {
  access_token?: string;
  expires_in?: number;
  open_id?: string;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export class TikTokAdapter extends OAuthAdapter {
  readonly oauth: OAuthProfile = {
    verified: true,
    authorize_url: "https://www.tiktok.com/v2/auth/authorize/",
    token_url: TOKEN,
    revoke_url: "https://open.tiktokapis.com/v2/oauth/revoke/",
    pkce: "S256",
    pkce_encoding: "hex",
    redirect: "loopback",
    scope_separator: ",",
    callback_path: "/oauth/callback/tiktok",
    caveat: "TikTok's desktop flow needs the redirect URI registered in Login Kit with a port. Apps that have not passed TikTok's audit can only post privately.",
  };

  constructor(holder: HttpHolder) {
    super(holder, {
      provider: "tiktok",
      hosts: ["open.tiktokapis.com"],
      api_version: "v2",
      login_scopes: ["user.info.basic", "video.publish"],
      account_types: ["creator"],
      scopes: { "account.read": ["user.info.basic"], "content.publish.video": ["video.publish"] },
    });
  }

  authorizeUrl(p: { state: string; code_challenge: string | null; redirect_uri: string; scopes: string[]; client: ClientCredentials }): string {
    return url("https://www.tiktok.com/v2/auth/authorize/", {
      client_key: p.client.client_id,
      scope: p.scopes.join(","),
      response_type: "code",
      redirect_uri: p.redirect_uri,
      state: p.state,
      code_challenge: p.code_challenge ?? undefined,
      code_challenge_method: "S256",
    });
  }

  private parse(res: { status: number; text: string; json<T>(): T }, what: string, reauth: boolean, requested: string[]): TokenSet {
    if (res.status !== 200) this.fail(res, what, reauth);
    const j = res.json<TikTokToken>();
    if (j.error || !j.access_token) {
      throw new GatewayError(reauth ? "REAUTH_REQUIRED" : "PROVIDER_ERROR", `TikTok rejected ${what}`, { provider: "tiktok", detail: j.error_description ? { message: String(j.error_description).slice(0, 160) } : undefined });
    }
    const scopes = j.scope ? j.scope.split(",").filter(Boolean) : requested;
    return this.tokens(j.access_token, j.expires_in, scopes, { refresh_token: j.refresh_token ?? null, subject: j.open_id });
  }

  async exchangeCode(p: { code: string; verifier: string | null; redirect_uri: string; client: ClientCredentials; scopes: string[] }): Promise<TokenSet> {
    const secret = this.need(p.client);
    const res = await this.request({ method: "POST", url: TOKEN, headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ client_key: p.client.client_id, client_secret: secret, code: p.code, grant_type: "authorization_code", redirect_uri: p.redirect_uri, code_verifier: p.verifier ?? undefined }), safe: false });
    return this.parse(res, "the authorization code exchange", false, p.scopes);
  }

  async refresh(tokens: TokenSet, client: ClientCredentials): Promise<TokenSet> {
    if (!tokens.refresh_token) throw new GatewayError("REAUTH_REQUIRED", "TikTok grant has no refresh token", { provider: "tiktok" });
    const res = await this.request({ method: "POST", url: TOKEN, headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ client_key: client.client_id, client_secret: this.need(client), grant_type: "refresh_token", refresh_token: tokens.refresh_token }), safe: false });
    const t = this.parse(res, "the token refresh", true, tokens.scopes);
    return { ...t, subject: t.subject ?? tokens.subject };
  }

  override async revoke(tokens: TokenSet, client: ClientCredentials): Promise<boolean> {
    const res = await this.request({ method: "POST", url: "https://open.tiktokapis.com/v2/oauth/revoke/", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ client_key: client.client_id, client_secret: this.need(client), token: tokens.access_token }), safe: false });
    return res.status === 200;
  }

  async identities(tokens: TokenSet): Promise<ProviderIdentity[]> {
    const res = await this.request({ method: "GET", url: url("https://open.tiktokapis.com/v2/user/info/", { fields: "open_id,display_name,avatar_url" }), headers: { authorization: `Bearer ${tokens.access_token}` }, safe: true });
    if (res.status !== 200) this.fail(res, "the profile lookup", true);
    const j = res.json<{ data?: { user?: { open_id?: string; display_name?: string } }; error?: { code?: string } }>();
    const u = j.data?.user;
    const id = u?.open_id ?? tokens.subject;
    if (!id) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "TikTok returned no open_id", { provider: "tiktok" });
    return [{ subject: String(id), display_name: u?.display_name ?? String(id), account_type: "creator", role: null }];
  }
}
