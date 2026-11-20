import { GatewayError } from "../contracts/errors.ts";
import type { ClientCredentials, TokenSet } from "../providers/contract.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { Leases } from "../workflow/leases.ts";
import type { AccountRegistry } from "./account-registry.ts";

export type ClientLookup = (provider: string) => Promise<ClientCredentials>;

const REFRESH_WAIT_MS = 10_000;
const REFRESH_POLL_MS = 25;

export class TokenManager {
  private readonly inflight = new Map<string, Promise<TokenSet>>();

  constructor(
    private readonly accounts: AccountRegistry,
    private readonly providers: ProviderRegistry,
    private readonly client: ClientLookup,
    private readonly leases: Leases | null = null,
    private readonly skewMs = 60_000,
  ) {}

  async usable(accountId: string): Promise<TokenSet> {
    const { tokens, grant, account } = await this.accounts.tokens(accountId);
    if (account.state === "needs_reauth" || grant.state === "refresh_failed") {
      throw new GatewayError("REAUTH_REQUIRED", `account ${accountId} must be reauthorized`, { actionable_next_step: "Call social_auth_connect with mode=upgrade" });
    }
    const exp = tokens.expires_at ? Date.parse(tokens.expires_at) : Number.POSITIVE_INFINITY;
    if (exp - Date.now() > this.skewMs) return tokens;
    if (!tokens.refresh_token) throw new GatewayError("REAUTH_REQUIRED", "access token expired and no refresh token exists", { actionable_next_step: "Call social_auth_connect with mode=upgrade" });
    const current = this.accounts.grant(accountId);
    if (!current || current.revision !== grant.revision) return this.usable(accountId);
    const key = `${grant.id}:${grant.revision}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.refreshOnce(accountId, account.provider, grant.id, grant.revision, tokens).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async refreshOnce(accountId: string, provider: string, grantId: string, revision: number, tokens: TokenSet): Promise<TokenSet> {
    const lease = `refresh:${grantId}`;
    const advanced = () => {
      const g = this.accounts.grant(accountId);
      return !g || g.revision !== revision;
    };
    if (this.leases && !this.leases.acquire(lease)) {
      const deadline = Date.now() + REFRESH_WAIT_MS;
      for (;;) {
        await Bun.sleep(REFRESH_POLL_MS);
        if (advanced()) return this.usable(accountId);
        if (this.leases.acquire(lease)) break;
        if (Date.now() > deadline) {
          throw new GatewayError("PROVIDER_UNAVAILABLE", "another process is refreshing this grant; retry shortly", { provider });
        }
      }
    }
    try {
      if (advanced()) return this.usable(accountId);
      const fresh = await this.providers.get(provider).refresh(tokens, await this.client(provider));
      const swapped = await this.accounts.replaceTokens(accountId, revision, fresh);
      if (!swapped) return (await this.accounts.tokens(accountId)).tokens;
      return fresh;
    } catch (e) {
      if (e instanceof GatewayError && e.code === "REAUTH_REQUIRED") {
        const now = this.accounts.grant(accountId);
        if (now && now.state === "active" && now.revision !== revision) return (await this.accounts.tokens(accountId)).tokens;
        this.accounts.markNeedsReauth(accountId);
      }
      throw e;
    } finally {
      this.leases?.release(lease);
    }
  }
}
