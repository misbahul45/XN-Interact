import type { ProviderHttp } from "../transport/provider-http.ts";

export type Verdict = "UNVERIFIED" | "VERIFIED" | "UNSUPPORTED" | "MANUAL_ONLY" | "PROHIBITED" | "APP_APPROVAL_REQUIRED";

export interface TokenSet {
  access_token: string;
  refresh_token?: string | null;
  expires_at?: string | null;
  scopes: string[];
  token_type?: string;
  subject?: string;
}

export interface ProviderIdentity {
  subject: string;
  display_name: string;
  account_type: string;
  role?: string | null;
  tokens?: TokenSet;
}

export interface OperationManifest {
  verdict: Verdict;
  scopes: string[];
  account_types: string[];
  roles?: string[];
  products?: string[];
  cost?: { per_call: number | null; uncertain: boolean };
  limits?: { text_max?: number; media_kinds?: string[]; media_mimes?: string[]; max_media?: number };
  read_after_write: boolean;
  acceptance?: boolean;
  /** Other operations a single acceptance run of this one needs armed too (their workflow steps resolve capability separately). */
  acceptance_with?: string[];
  manual_url?: string;
  reason?: string;
}

export interface AdapterManifest {
  provider: string;
  adapter_version: string;
  api_version: string | null;
  hosts: string[];
  evidence_verified: boolean;
  docs_urls: string[];
  login_scopes?: string[];
  operations: Record<string, OperationManifest>;
}

export interface OAuthProfile {
  verified: boolean;
  authorize_url: string | null;
  token_url: string | null;
  revoke_url?: string | null;
  pkce: "S256" | "none";
  pkce_encoding?: "base64url" | "hex";
  redirect?: "loopback" | "https";
  /** The operator must also store a login configuration id with the app credentials (`app set` asks for it). */
  requires_config_id?: boolean;
  caveat?: string;
  scope_separator: string;
  callback_path: string;
}

export interface ClientCredentials {
  client_id: string;
  client_secret?: string | null;
  /** Not a secret: names the provider-side login configuration (Meta Facebook Login for Business `config_id`). */
  config_id?: string | null;
}

export interface AccountContext {
  account_id: string;
  provider: string;
  provider_subject: string;
  account_type: string;
  role: string | null;
}

export interface AdapterContext {
  account: AccountContext;
  tokens: TokenSet;
  http: ProviderHttp;
}

export interface WriteRequest {
  operation: string;
  params: Record<string, unknown>;
  intent_id: string;
  dedupe_key: string;
}

export interface WriteResult {
  provider_ref: string;
  url?: string | null;
  at?: string;
  pending?: { container_id: string; poll_after_ms: number };
}

export interface ReadResult {
  items?: Record<string, unknown>[];
  item?: Record<string, unknown>;
  next_cursor?: string | null;
}

export interface OutcomeEvidence {
  found: boolean | null;
  provider_ref?: string;
  url?: string | null;
  note?: string;
}

export interface ProviderAdapter {
  readonly manifest: AdapterManifest;
  readonly oauth: OAuthProfile;
  readonly testOnly?: boolean;
  authorizeUrl(p: { state: string; code_challenge: string | null; redirect_uri: string; scopes: string[]; client: ClientCredentials }): string;
  exchangeCode(p: { code: string; verifier: string | null; redirect_uri: string; client: ClientCredentials; scopes: string[] }): Promise<TokenSet>;
  refresh(tokens: TokenSet, client: ClientCredentials): Promise<TokenSet>;
  revoke(tokens: TokenSet, client: ClientCredentials): Promise<boolean>;
  identities(tokens: TokenSet): Promise<ProviderIdentity[]>;
  read(operation: string, ctx: AdapterContext, params: Record<string, unknown>): Promise<ReadResult>;
  write(req: WriteRequest, ctx: AdapterContext): Promise<WriteResult>;
  poll?(req: WriteRequest, ctx: AdapterContext, containerId: string): Promise<{ done: boolean; provider_ref?: string; url?: string | null }>;
  inspectWriteOutcome(req: WriteRequest, ctx: AdapterContext): Promise<OutcomeEvidence>;
}
