import { GatewayError } from "../contracts/errors.ts";
import type { Vault } from "../identity/vault.ts";
import { type Db, nowIso } from "../storage/db.ts";

const TTL_MS = 24 * 3600_000;
const aad = (ref: string, owner: string) => `xn-result|v1|${ref}|${owner}`;

export class Results {
  constructor(private readonly db: Db, private readonly vault: Vault) {}

  async put(ref: string, owner: string, payload: unknown): Promise<string> {
    const blob = await this.vault.sealJson(payload, aad(ref, owner));
    this.db.run("INSERT INTO cached_results(ref, owner_context, encrypted_payload, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(ref) DO UPDATE SET encrypted_payload = excluded.encrypted_payload, expires_at = excluded.expires_at",
      ref, owner, blob, new Date(Date.now() + TTL_MS).toISOString());
    return `social://results/${ref}`;
  }

  async get(ref: string): Promise<{ owner: string; payload: unknown }> {
    const r = this.db.get<{ owner_context: string; encrypted_payload: Uint8Array; expires_at: string }>("SELECT * FROM cached_results WHERE ref = ?", ref);
    if (!r || Date.parse(r.expires_at) < Date.now()) throw new GatewayError("RESULT_REF_EXPIRED", `result ${ref} is unknown or expired`);
    return { owner: r.owner_context, payload: await this.vault.openJson(new Uint8Array(r.encrypted_payload), aad(ref, r.owner_context)) };
  }

  prune(): number {
    return this.db.run("DELETE FROM cached_results WHERE expires_at < ?", nowIso()).changes;
  }
}
