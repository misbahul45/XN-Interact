import { GatewayError } from "../contracts/errors.ts";
import type { AccountContext, ProviderIdentity, TokenSet } from "../providers/contract.ts";
import { type Db, jsonOr, newId, nowIso } from "../storage/db.ts";
import type { Vault } from "./vault.ts";

export interface AccountRow {
  id: string;
  provider: string;
  provider_subject: string;
  display_name: string | null;
  account_type: string;
  role: string | null;
  state: "connected" | "needs_reauth" | "revoked";
  created_at: string;
  updated_at: string;
}

export interface GrantRow {
  id: string;
  account_id: string;
  scopes_json: string;
  encrypted_tokens: Uint8Array;
  key_version: number;
  expires_at: string | null;
  revision: number;
  state: "active" | "refresh_failed" | "revoked";
}

export function grantAad(provider: string, accountId: string, grantId: string, revision: number): string {
  return `xn-grant|v1|${provider}|${accountId}|${grantId}|${revision}`;
}

export class AccountRegistry {
  constructor(private readonly db: Db, private readonly vault: Vault) {}

  list(filter: { provider?: string; state?: string } = {}): AccountRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.provider) {
      where.push("provider = ?");
      args.push(filter.provider);
    }
    if (filter.state) {
      where.push("state = ?");
      args.push(filter.state);
    }
    return this.db.all<AccountRow>(`SELECT * FROM connected_accounts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY provider, created_at`, ...args);
  }

  get(id: string): AccountRow | null {
    return this.db.get<AccountRow>("SELECT * FROM connected_accounts WHERE id = ?", id);
  }

  require(id: string): AccountRow {
    const a = this.get(id);
    if (!a) throw new GatewayError("NOT_CONNECTED", `account ${id} is not connected`, { actionable_next_step: "List accounts with social_accounts_list or connect with social_auth_connect" });
    return a;
  }

  context(a: AccountRow): AccountContext {
    return { account_id: a.id, provider: a.provider, provider_subject: a.provider_subject, account_type: a.account_type, role: a.role };
  }

  grant(accountId: string): GrantRow | null {
    return this.db.get<GrantRow>("SELECT * FROM oauth_grants WHERE account_id = ?", accountId);
  }

  scopes(accountId: string): string[] {
    return jsonOr<string[]>(this.grant(accountId)?.scopes_json, []);
  }

  async upsertIdentity(provider: string, ident: ProviderIdentity, tokens: TokenSet): Promise<{ account: AccountRow; created: boolean }> {
    const now = nowIso();
    const existing = this.db.get<AccountRow>("SELECT * FROM connected_accounts WHERE provider = ? AND provider_subject = ? AND account_type = ?", provider, ident.subject, ident.account_type);
    const accountId = existing?.id ?? newId("acc");
    const prior = existing ? this.grant(accountId) : null;
    const grantId = prior?.id ?? newId("grt");
    const revision = (prior?.revision ?? 0) + 1;
    const blob = await this.vault.sealJson(tokens, grantAad(provider, accountId, grantId, revision));
    this.db.tx(() => {
      if (existing) {
        this.db.run("UPDATE connected_accounts SET display_name = ?, role = ?, state = 'connected', updated_at = ? WHERE id = ?", ident.display_name, ident.role ?? null, now, accountId);
      } else {
        this.db.run(
          "INSERT INTO connected_accounts(id, provider, provider_subject, display_name, account_type, role, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'connected', ?, ?)",
          accountId, provider, ident.subject, ident.display_name, ident.account_type, ident.role ?? null, now, now,
        );
      }
      if (prior) {
        this.db.run("UPDATE oauth_grants SET scopes_json = ?, encrypted_tokens = ?, key_version = ?, expires_at = ?, revision = ?, state = 'active', updated_at = ? WHERE id = ?",
          JSON.stringify(tokens.scopes), blob, this.vault.keyVersion, tokens.expires_at ?? null, revision, now, grantId);
      } else {
        this.db.run("INSERT INTO oauth_grants(id, account_id, scopes_json, encrypted_tokens, key_version, expires_at, revision, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
          grantId, accountId, JSON.stringify(tokens.scopes), blob, this.vault.keyVersion, tokens.expires_at ?? null, revision, now, now);
      }
      this.db.run("DELETE FROM capability_snapshots WHERE account_id = ?", accountId);
    });
    return { account: this.require(accountId), created: !existing };
  }

  async tokens(accountId: string): Promise<{ tokens: TokenSet; grant: GrantRow; account: AccountRow }> {
    const account = this.require(accountId);
    const grant = this.grant(accountId);
    if (!grant || grant.state === "revoked" || account.state === "revoked") throw new GatewayError("NOT_CONNECTED", `account ${accountId} has no active grant`, { actionable_next_step: "Reconnect with social_auth_connect" });
    const tokens = await this.vault.openJson<TokenSet>(new Uint8Array(grant.encrypted_tokens), grantAad(account.provider, account.id, grant.id, grant.revision), ["access_token", "refresh_token"]);
    return { tokens, grant, account };
  }

  async replaceTokens(accountId: string, expectedRevision: number, tokens: TokenSet): Promise<boolean> {
    const account = this.require(accountId);
    const grant = this.grant(accountId);
    if (!grant || grant.revision !== expectedRevision) return false;
    const blob = await this.vault.sealJson(tokens, grantAad(account.provider, account.id, grant.id, expectedRevision + 1));
    const r = this.db.run("UPDATE oauth_grants SET encrypted_tokens = ?, key_version = ?, expires_at = ?, scopes_json = ?, revision = ?, state = 'active', updated_at = ? WHERE id = ? AND revision = ?",
      blob, this.vault.keyVersion, tokens.expires_at ?? null, JSON.stringify(tokens.scopes), expectedRevision + 1, nowIso(), grant.id, expectedRevision);
    return r.changes === 1;
  }

  markNeedsReauth(accountId: string): void {
    this.db.tx(() => {
      this.db.run("UPDATE oauth_grants SET state = 'refresh_failed', updated_at = ? WHERE account_id = ?", nowIso(), accountId);
      this.db.run("UPDATE connected_accounts SET state = 'needs_reauth', updated_at = ? WHERE id = ?", nowIso(), accountId);
    });
  }

  purge(accountId: string): void {
    this.db.tx(() => {
      this.db.run("DELETE FROM oauth_grants WHERE account_id = ?", accountId);
      this.db.run("DELETE FROM capability_snapshots WHERE account_id = ?", accountId);
      this.db.run("UPDATE connected_accounts SET state = 'revoked', updated_at = ? WHERE id = ?", nowIso(), accountId);
    });
  }
}
