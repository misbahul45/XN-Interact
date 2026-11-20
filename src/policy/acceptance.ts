import { GatewayError } from "../contracts/errors.ts";
import { type Db, newId, nowIso } from "../storage/db.ts";

export interface AcceptanceRow {
  id: string;
  provider: string;
  account_id: string;
  operation: string;
  state: "armed" | "consumed" | "revoked";
  armed_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by_intent: string | null;
}

export const MAX_ACCEPTANCE_TTL_MS = 3600_000;

export class Acceptance {
  constructor(private readonly db: Db, private readonly clock: () => number = Date.now) {}

  arm(provider: string, accountId: string, operation: string, ttlMs = MAX_ACCEPTANCE_TTL_MS): AcceptanceRow {
    if (!(ttlMs > 0) || ttlMs > MAX_ACCEPTANCE_TTL_MS) throw new GatewayError("VALIDATION_FAILED", `an acceptance run lasts at most ${MAX_ACCEPTANCE_TTL_MS / 60_000} minutes`);
    const id = newId("acc");
    const now = this.clock();
    return this.db.tx(() => {
      this.db.run("UPDATE operation_acceptance SET state = 'revoked' WHERE account_id = ? AND operation = ? AND state = 'armed'", accountId, operation);
      this.db.run("INSERT INTO operation_acceptance(id, provider, account_id, operation, state, armed_at, expires_at) VALUES (?, ?, ?, ?, 'armed', ?, ?)",
        id, provider, accountId, operation, new Date(now).toISOString(), new Date(now + ttlMs).toISOString());
      return this.get(id)!;
    });
  }

  get(id: string): AcceptanceRow | undefined {
    return this.db.get<AcceptanceRow>("SELECT * FROM operation_acceptance WHERE id = ?", id) ?? undefined;
  }

  armed(accountId: string, operation: string): AcceptanceRow | undefined {
    const row = this.db.get<AcceptanceRow>("SELECT * FROM operation_acceptance WHERE account_id = ? AND operation = ? AND state = 'armed'", accountId, operation);
    if (!row || Date.parse(row.expires_at) <= this.clock()) return undefined;
    return row;
  }

  consume(accountId: string, operation: string, intentId: string): boolean {
    const row = this.armed(accountId, operation);
    if (!row) return false;
    return this.db.run("UPDATE operation_acceptance SET state = 'consumed', consumed_at = ?, consumed_by_intent = ? WHERE id = ? AND state = 'armed'", nowIso(), intentId, row.id).changes === 1;
  }

  revoke(id: string): boolean {
    return this.db.run("UPDATE operation_acceptance SET state = 'revoked' WHERE id = ? AND state = 'armed'", id).changes === 1;
  }

  list(limit = 20): AcceptanceRow[] {
    return this.db.all<AcceptanceRow>("SELECT * FROM operation_acceptance ORDER BY armed_at DESC LIMIT ?", limit);
  }

  epoch(accountId: string): string {
    const r = this.db.get<{ n: number; last: string | null }>("SELECT COUNT(*) AS n, MAX(COALESCE(consumed_at, armed_at)) AS last FROM operation_acceptance WHERE account_id = ?", accountId);
    const live = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM operation_acceptance WHERE account_id = ? AND state = 'armed' AND expires_at > ?", accountId, new Date(this.clock()).toISOString());
    return `${r?.n ?? 0}:${r?.last ?? ""}:${live?.n ?? 0}`;
  }
}
