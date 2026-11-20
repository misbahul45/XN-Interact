import { GatewayError } from "../contracts/errors.ts";
import type { ClientCredentials } from "../providers/contract.ts";
import { type Db, jsonOr, nowIso } from "../storage/db.ts";
import type { Keyring } from "./keyring.ts";

export class AppSecrets {
  constructor(private readonly keyring: Keyring, private readonly db: Db, private readonly testClients: Record<string, ClientCredentials> = {}) {}

  async lookup(provider: string): Promise<ClientCredentials> {
    const fixed = this.testClients[provider];
    if (fixed) return fixed;
    let id: string | null = null;
    let secret: string | null = null;
    let configId: string | null = null;
    try {
      id = await this.keyring.get(`app:${provider}:client_id`);
      secret = await this.keyring.get(`app:${provider}:client_secret`);
      configId = await this.keyring.get(`app:${provider}:config_id`);
    } catch {
      throw new GatewayError("VAULT_LOCKED", "keyring unavailable while reading the operator app credentials");
    }
    if (!id) throw new GatewayError("APP_APPROVAL_REQUIRED", `no operator developer app is registered for ${provider}`, { provider, actionable_next_step: `Register the app in the ${provider} developer console, then run \`xn-interact app set ${provider}\`` });
    return { client_id: id, client_secret: secret, config_id: configId };
  }

  async set(provider: string, creds: ClientCredentials, products: string[], approvalState: string): Promise<void> {
    await this.keyring.set(`app:${provider}:client_id`, creds.client_id);
    if (creds.client_secret) await this.keyring.set(`app:${provider}:client_secret`, creds.client_secret);
    if (creds.config_id) await this.keyring.set(`app:${provider}:config_id`, creds.config_id);
    this.db.run(
      "INSERT INTO provider_apps(provider, client_id_ref, approval_state, products_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET client_id_ref = excluded.client_id_ref, approval_state = excluded.approval_state, products_json = excluded.products_json, policy_epoch = policy_epoch + 1, updated_at = excluded.updated_at",
      provider, `keyring:app:${provider}:client_id`, approvalState, JSON.stringify(products), nowIso(),
    );
  }

  products(provider: string): string[] {
    if (this.testClients[provider]) return ["*"];
    return jsonOr<string[]>(this.db.get<{ products_json: string }>("SELECT products_json FROM provider_apps WHERE provider = ?", provider)?.products_json, []);
  }

  policyEpoch(provider: string): number {
    return this.db.get<{ policy_epoch: number }>("SELECT policy_epoch FROM provider_apps WHERE provider = ?", provider)?.policy_epoch ?? 0;
  }

  registered(provider: string): boolean {
    return Boolean(this.testClients[provider]) || this.db.get("SELECT 1 FROM provider_apps WHERE provider = ?", provider) !== null;
  }
}
