import { GatewayError } from "../../contracts/errors.ts";
import { OAuthAdapter, type HttpHolder, basic, form, url } from "../base.ts";
import type { ClientCredentials, OAuthProfile, ProviderIdentity, TokenSet } from "../contract.ts";

const TOKEN = "https://api.x.com/2/oauth2/token";

interface XToken {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export class XAdapter extends OAuthAdapter {
  readonly oauth: OAuthProfile = {
    verified: true,
    authorize_url: "https://x.com/i/oauth2/authorize",
    token_url: TOKEN,
    revoke_url: "https://api.x.com/2/oauth2/revoke",
    pkce: "S256",
    redirect: "loopback",
    scope_separator: " ",
    callback_path: "/oauth/callback/x",
    caveat: "X's pages do not say whether a loopback callback URL is accepted (exact match against the app settings). Every write later costs money (pay-per-usage credits).",
  };

  constructor(holder: HttpHolder) {
    super(holder, {
      provider: "x",
      hosts: ["api.x.com"],
      api_version: "2",
      login_scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
      account_types: ["user"],
      scopes: {
        "account.read": ["users.read", "tweet.read"],
        "content.read": ["tweet.read", "users.read"],
        "content.publish.text": ["tweet.read", "tweet.write", "users.read"],
        "engagement.react": ["like.write", "tweet.read", "users.read"],
        "engagement.read": ["tweet.read", "users.read"],
      },
    });
  }

  authorizeUrl(p: { state: string; code_challenge: string | null; redirect_uri: string; scopes: string[]; client: ClientCredentials }): string {
    return url("https://x.com/i/oauth2/authorize", {
      response_type: "code",
      client_id: p.client.client_id,
      redirect_uri: p.redirect_uri,
      scope: p.scopes.join(" "),
      state: p.state,
      code_challenge: p.code_challenge ?? undefined,
      code_challenge_method: "S256",
    });
  }

  private headers(client: ClientCredentials): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (client.client_secret) h.authorization = basic(client.client_id, client.client_secret);
    return h;
  }

  private parse(res: { status: number; text: string; json<T>(): T }, what: string, reauth: boolean, requested: string[], previous?: TokenSet): TokenSet {
    if (res.status !== 200) this.fail(res, what, reauth);
    const j = res.json<XToken>();
    if (!j.access_token) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "X returned no access token", { provider: "x" });
    const scopes = j.scope ? j.scope.split(/[ ,]+/).filter(Boolean) : requested;
    return this.tokens(j.access_token, j.expires_in ?? 7200, scopes, { refresh_token: j.refresh_token ?? previous?.refresh_token ?? null });
  }

  async exchangeCode(p: { code: string; verifier: string | null; redirect_uri: string; client: ClientCredentials; scopes: string[] }): Promise<TokenSet> {
    const res = await this.request({ method: "POST", url: TOKEN, headers: this.headers(p.client), body: form({ code: p.code, grant_type: "authorization_code", redirect_uri: p.redirect_uri, code_verifier: p.verifier ?? undefined, client_id: p.client.client_id }), safe: false });
    return this.parse(res, "the authorization code exchange", false, p.scopes);
  }

  async refresh(tokens: TokenSet, client: ClientCredentials): Promise<TokenSet> {
    if (!tokens.refresh_token) throw new GatewayError("REAUTH_REQUIRED", "X grant has no refresh token (offline.access was not granted)", { provider: "x" });
    const res = await this.request({ method: "POST", url: TOKEN, headers: this.headers(client), body: form({ refresh_token: tokens.refresh_token, grant_type: "refresh_token", client_id: client.client_id }), safe: false });
    return this.parse(res, "the token refresh", true, tokens.scopes, tokens);
  }

  override async revoke(tokens: TokenSet, client: ClientCredentials): Promise<boolean> {
    const res = await this.request({ method: "POST", url: "https://api.x.com/2/oauth2/revoke", headers: this.headers(client), body: form({ token: tokens.access_token, client_id: client.client_id }), safe: false });
    return res.status === 200;
  }

  async identities(tokens: TokenSet): Promise<ProviderIdentity[]> {
    const res = await this.request({ method: "GET", url: "https://api.x.com/2/users/me", headers: { authorization: `Bearer ${tokens.access_token}` }, safe: true });
    if (res.status !== 200) this.fail(res, "the profile lookup", true);
    const j = res.json<{ data?: { id?: string; name?: string; username?: string } }>();
    if (!j.data?.id) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "X returned no user id", { provider: "x" });
    return [{ subject: j.data.id, display_name: j.data.username ? `@${j.data.username}` : (j.data.name ?? j.data.id), account_type: "user", role: null }];
  }
}
