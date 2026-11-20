import { GatewayError } from "../contracts/errors.ts";
import { log } from "../observability/logger.ts";
import type { Audit } from "../observability/audit.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import { type Db, jsonOr, newId, nowIso } from "../storage/db.ts";
import type { AccountRegistry } from "./account-registry.ts";
import type { AppSecrets } from "./app-secrets.ts";
import type { CallbackListener } from "./callback-listener.ts";
import type { Vault } from "./vault.ts";

export const ATTEMPT_TTL_MS = 10 * 60_000;

interface AttemptRow {
  id: string;
  provider: string;
  state_hash: string;
  encrypted_verifier: Uint8Array | null;
  mode: "connect" | "upgrade";
  account_id: string | null;
  requested_scopes: string;
  redirect_uri: string;
  status: string;
  error: string | null;
  result_account_ids: string | null;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export async function pkceChallenge(verifier: string, encoding: "base64url" | "hex" = "base64url"): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return encoding === "hex" ? Buffer.from(digest).toString("hex") : b64url(digest);
}

const attemptAad = (id: string, provider: string) => `xn-attempt|v1|${provider}|${id}`;

export class OAuthBroker {
  listener: CallbackListener | null = null;
  tlsListener: (() => CallbackListener) | null = null;
  redirectMode: "auto" | "loopback" | "https" = "auto";

  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly providers: ProviderRegistry,
    private readonly accounts: AccountRegistry,
    private readonly apps: AppSecrets,
    private readonly audit: Audit,
  ) {}

  scopesFor(provider: string, operations?: string[]): string[] {
    const m = this.providers.get(provider).manifest;
    const ops = operations?.length ? operations : Object.keys(m.operations).filter((o) => m.operations[o]?.verdict === "VERIFIED");
    const scopes = new Set<string>(operations?.length ? [] : (m.login_scopes ?? []));
    for (const op of ops) {
      const om = m.operations[op];
      if (!om) throw new GatewayError("UNSUPPORTED", `${provider} has no operation ${op}`);
      for (const s of om.scopes) scopes.add(s);
    }
    return [...scopes].sort();
  }

  async start(p: { provider: string; mode: "connect" | "upgrade"; account_id?: string; operations?: string[]; redirect?: "loopback" | "https" }): Promise<Record<string, unknown>> {
    const adapter = this.providers.get(p.provider);
    if (!adapter.oauth.verified) {
      throw new GatewayError("UNVERIFIED", `the ${p.provider} OAuth profile is not verified against official documentation; no consent request is created`, {
        provider: p.provider,
        actionable_next_step: `Complete and sign the ${p.provider} Stage-0 evidence row, then implement its adapter`,
      });
    }
    this.vault.require();
    let scopes = this.scopesFor(p.provider, p.operations);
    if (p.mode === "upgrade") {
      if (!p.account_id) throw new GatewayError("ACCOUNT_REQUIRED", "mode=upgrade needs account_id");
      const acc = this.accounts.require(p.account_id);
      if (acc.provider !== p.provider) throw new GatewayError("VALIDATION_FAILED", "account belongs to another provider");
      scopes = [...new Set([...this.accounts.scopes(acc.id), ...scopes])].sort();
    }
    const client = await this.apps.lookup(p.provider);
    const wanted = p.redirect ?? (this.redirectMode === "auto" ? (adapter.oauth.redirect ?? "loopback") : this.redirectMode);
    const listener = wanted === "https" ? this.tlsListener?.() : this.listener;
    if (!listener) throw new GatewayError("PROVIDER_UNAVAILABLE", "callback listener not configured");
    const port = await listener.ensure();
    const id = newId("att");
    const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const verifier = adapter.oauth.pkce === "S256" ? b64url(crypto.getRandomValues(new Uint8Array(48))) : null;
    const challenge = verifier ? await pkceChallenge(verifier, adapter.oauth.pkce_encoding ?? "base64url") : null;
    const redirect_uri = `${listener.scheme}://127.0.0.1:${port}${adapter.oauth.callback_path}`;
    const encrypted = verifier ? await this.vault.seal(verifier, attemptAad(id, p.provider)) : null;
    const now = Date.now();
    const expires_at = new Date(now + ATTEMPT_TTL_MS).toISOString();
    this.db.run(
      "INSERT INTO oauth_attempts(id, provider, state_hash, encrypted_verifier, mode, account_id, requested_scopes, redirect_uri, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      id, p.provider, sha256(state), encrypted, p.mode, p.account_id ?? null, JSON.stringify(scopes), redirect_uri, new Date(now).toISOString(), expires_at,
    );
    const auth_url = adapter.authorizeUrl({ state, code_challenge: challenge, redirect_uri, scopes, client });
    this.audit.record("mcp", "oauth.start", "pending", { attempt_id: id, provider: p.provider, mode: p.mode, scopes });
    const warnings = [adapter.oauth.caveat, listener.scheme === "https" ? "The redirect uses a local self-signed HTTPS certificate: your browser will warn once; choose to continue to 127.0.0.1." : undefined].filter(Boolean) as string[];
    return { attempt_id: id, provider: p.provider, auth_url, redirect_uri, requested_scopes: scopes, warnings, expires_at, next_step: "Open auth_url in your browser, consent, then poll social_auth_status with attempt_id" };
  }

  private fail(id: string, error: string): { ok: false; message: string } {
    this.db.run("UPDATE oauth_attempts SET status = 'failed', error = ?, completed_at = ? WHERE id = ?", error, nowIso(), id);
    this.audit.record("browser", "oauth.callback", "failed", { attempt_id: id, error });
    return { ok: false, message: "Connection was not completed. Return to your MCP host for details." };
  }

  async handleCallback(provider: string, params: URLSearchParams): Promise<{ ok: boolean; message: string }> {
    const state = params.get("state");
    if (!state || state.length > 200) return { ok: false, message: "Missing state." };
    const row = this.db.get<AttemptRow>("SELECT * FROM oauth_attempts WHERE state_hash = ?", sha256(state));
    if (!row || row.provider !== provider) {
      this.audit.record("browser", "oauth.callback", "rejected", { provider, reason: "unknown state" });
      return { ok: false, message: "Unknown or expired request." };
    }
    if (row.status !== "pending") return { ok: false, message: "This request was already used." };
    if (Date.parse(row.expires_at) < Date.now()) {
      this.db.run("UPDATE oauth_attempts SET status = 'expired', completed_at = ? WHERE id = ?", nowIso(), row.id);
      return { ok: false, message: "This request expired." };
    }
    const claimed = this.db.run("UPDATE oauth_attempts SET status = 'exchanging' WHERE id = ? AND status = 'pending'", row.id);
    if (claimed.changes !== 1) return { ok: false, message: "This request was already used." };
    const error = params.get("error");
    if (error) return this.fail(row.id, `provider_error:${error.slice(0, 60)}`);
    const code = params.get("code");
    if (!code) return this.fail(row.id, "missing_code");
    try {
      const adapter = this.providers.get(provider);
      const verifier = row.encrypted_verifier ? await this.vault.open_(new Uint8Array(row.encrypted_verifier), attemptAad(row.id, provider)) : null;
      const client = await this.apps.lookup(provider);
      const tokens = await adapter.exchangeCode({ code, verifier, redirect_uri: row.redirect_uri, client, scopes: jsonOr<string[]>(row.requested_scopes, []) });
      const identities = await adapter.identities(tokens);
      if (!identities.length) return this.fail(row.id, "no_identity");
      if (row.mode === "upgrade" && row.account_id) {
        const target = this.accounts.require(row.account_id);
        if (!identities.some((i) => i.subject === target.provider_subject && i.account_type === target.account_type)) return this.fail(row.id, "different_account_consented");
      }
      const ids: string[] = [];
      for (const ident of identities) {
        const { account } = await this.accounts.upsertIdentity(provider, ident, ident.tokens ?? tokens);
        ids.push(account.id);
      }
      const requested = jsonOr<string[]>(row.requested_scopes, []);
      const missing = requested.filter((s) => !tokens.scopes.includes(s));
      this.db.run("UPDATE oauth_attempts SET status = 'connected', result_account_ids = ?, error = ?, completed_at = ? WHERE id = ?", JSON.stringify(ids), missing.length ? `partial_consent:${missing.join(",")}` : null, nowIso(), row.id);
      this.audit.record("browser", "oauth.callback", "connected", { attempt_id: row.id, provider, accounts: ids, missing_scopes: missing });
      return { ok: true, message: "Connected. You can close this tab and return to your MCP host." };
    } catch (e) {
      const code_ = e instanceof GatewayError ? e.code : "INTERNAL_ERROR";
      // The provider's own reason (HTTP status and a truncated message, never a token) is what tells a wrong app secret from a
      // missing parameter, so it is kept in the log and the audit trail.
      const extras = e instanceof GatewayError ? e.extras : {};
      const detail = typeof (extras.detail as { message?: unknown } | undefined)?.message === "string" ? String((extras.detail as { message: string }).message).slice(0, 160) : undefined;
      log.warn("oauth exchange failed", { attempt_id: row.id, code: code_, provider_status: extras.provider_status, detail });
      this.audit.record("browser", "oauth.exchange_error", "failed", { attempt_id: row.id, provider, code: code_, provider_status: extras.provider_status, detail });
      return this.fail(row.id, `exchange_failed:${code_}`);
    }
  }

  status(attemptId: string): Record<string, unknown> {
    const row = this.db.get<AttemptRow>("SELECT * FROM oauth_attempts WHERE id = ?", attemptId);
    if (!row) throw new GatewayError("VALIDATION_FAILED", `unknown attempt ${attemptId}`);
    let status = row.status;
    if (status === "pending" && Date.parse(row.expires_at) < Date.now()) {
      this.db.run("UPDATE oauth_attempts SET status = 'expired' WHERE id = ? AND status = 'pending'", row.id);
      status = "expired";
    }
    const missing = row.error?.startsWith("partial_consent:") ? row.error.slice(16).split(",") : [];
    return {
      attempt_id: row.id,
      provider: row.provider,
      mode: row.mode,
      status,
      account_ids: jsonOr<string[]>(row.result_account_ids, []),
      requested_scopes: jsonOr<string[]>(row.requested_scopes, []),
      missing_scopes: missing,
      error: row.error && !row.error.startsWith("partial_consent:") ? row.error : null,
      expires_at: row.expires_at,
    };
  }
}
