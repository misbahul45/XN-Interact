import { GatewayError } from "../contracts/errors.ts";
import type { HttpRequest, HttpResponse, ProviderHttp } from "../transport/provider-http.ts";
import type { AdapterContext, AdapterManifest, ClientCredentials, OAuthProfile, OperationManifest, OutcomeEvidence, ProviderAdapter, ProviderIdentity, ReadResult, TokenSet, WriteRequest, WriteResult } from "./contract.ts";
import { manifestFromEvidence } from "./unverified.ts";

export interface HttpHolder {
  http: ProviderHttp | null;
}

export interface ProviderSpec {
  provider: string;
  hosts: string[];
  api_version: string | null;
  login_scopes: string[];
  scopes: Record<string, string[]>;
  account_types: string[];
}

export const FALLBACK_LIFETIME_S = 60 * 86_400;

export function form(values: Record<string, string | undefined>): URLSearchParams {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined) f.set(k, v);
  return f;
}

export function basic(id: string, secret: string | null | undefined): string {
  return `Basic ${Buffer.from(`${id}:${secret ?? ""}`).toString("base64")}`;
}

export function url(base: string, params: Record<string, string | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  u.search = u.searchParams.toString().replace(/\+/g, "%20");
  return u.toString();
}

export abstract class OAuthAdapter implements ProviderAdapter {
  readonly manifest: AdapterManifest;
  abstract readonly oauth: OAuthProfile;

  constructor(private readonly holder: HttpHolder, private readonly spec: ProviderSpec) {
    const base = manifestFromEvidence(spec.provider);
    const operations: Record<string, OperationManifest> = {};
    for (const [op, m] of Object.entries(base.operations)) operations[op] = { ...m, scopes: spec.scopes[op] ?? [], account_types: spec.account_types };
    this.manifest = { ...base, adapter_version: "0.1.0", api_version: spec.api_version, hosts: spec.hosts, login_scopes: spec.login_scopes, operations };
  }

  protected request(req: HttpRequest): Promise<HttpResponse> {
    if (!this.holder.http) throw new GatewayError("INTERNAL_ERROR", "provider transport is not ready");
    return this.holder.http.request(this.spec.provider, req);
  }

  protected need(client: ClientCredentials): string {
    if (!client.client_secret) {
      throw new GatewayError("APP_APPROVAL_REQUIRED", `the ${this.spec.provider} app secret is not stored; run \`xn-interact app set ${this.spec.provider}\``, { provider: this.spec.provider });
    }
    return client.client_secret;
  }

  protected fail(res: { status: number; text: string }, what: string, reauth: boolean): never {
    let detail = "";
    try {
      const j = JSON.parse(res.text) as Record<string, unknown> & { error?: unknown; message?: unknown };
      const nested = (j.error as { message?: unknown } | undefined)?.message;
      detail = String(nested ?? j.error_description ?? j.error_message ?? j.message ?? (typeof j.error === "string" ? j.error : "")).slice(0, 160);
    } catch {}
    const extras = { provider: this.spec.provider, provider_status: res.status, detail: detail ? { message: detail } : undefined };
    const name = this.spec.provider;
    if (res.status >= 500) throw new GatewayError("PROVIDER_UNAVAILABLE", `${name} ${what} is unavailable`, extras);
    if (reauth && [400, 401, 403].includes(res.status)) {
      throw new GatewayError("REAUTH_REQUIRED", `${name} rejected the token during ${what}; the owner must reconnect`, { ...extras, actionable_next_step: "Call social_auth_connect with mode=upgrade" });
    }
    throw new GatewayError("PROVIDER_ERROR", `${name} rejected ${what}`, extras);
  }

  protected tokens(access: string, expiresIn: unknown, scopes: string[], extra: Partial<TokenSet> = {}): TokenSet {
    const seconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : typeof expiresIn === "string" && Number(expiresIn) > 0 ? Number(expiresIn) : FALLBACK_LIFETIME_S;
    return { access_token: access, expires_at: new Date(Date.now() + seconds * 1000).toISOString(), scopes, token_type: "bearer", ...extra };
  }

  abstract authorizeUrl(p: { state: string; code_challenge: string | null; redirect_uri: string; scopes: string[]; client: ClientCredentials }): string;
  abstract exchangeCode(p: { code: string; verifier: string | null; redirect_uri: string; client: ClientCredentials; scopes: string[] }): Promise<TokenSet>;
  abstract refresh(tokens: TokenSet, client: ClientCredentials): Promise<TokenSet>;
  abstract identities(tokens: TokenSet): Promise<ProviderIdentity[]>;

  async revoke(_tokens: TokenSet, _client: ClientCredentials): Promise<boolean> {
    return false;
  }

  protected unverified(what: string): never {
    throw new GatewayError("UNVERIFIED", `${this.spec.provider} ${what} is not verified yet: login works, publishing and reading need an approved real round trip (task P5/P8)`, {
      provider: this.spec.provider,
      actionable_next_step: "Complete the provider's acceptance suite before enabling its operations",
    });
  }

  async read(_operation: string, _ctx: AdapterContext, _params: Record<string, unknown>): Promise<ReadResult> {
    return this.unverified("reading");
  }

  async write(_req: WriteRequest, _ctx: AdapterContext): Promise<WriteResult> {
    return this.unverified("publishing");
  }

  async inspectWriteOutcome(_req: WriteRequest, _ctx: AdapterContext): Promise<OutcomeEvidence> {
    return this.unverified("write read-back");
  }
}
