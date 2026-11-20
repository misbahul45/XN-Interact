import { GatewayError } from "../contracts/errors.ts";
import type { PlanPayload } from "../routing/plans.ts";
import { type Db, jsonOr, newId } from "../storage/db.ts";
import { MAX_EVIDENCE_AGE_DAYS } from "./evidence-freshness.ts";

export interface SignoffRow {
  id: string;
  provider: string;
  account_id: string;
  operation: string;
  state: "active" | "revoked";
  basis_acceptance_id: string;
  basis_run_id: string;
  signed_at: string;
  expires_at: string;
  actor_evidence: string;
  ended_at: string | null;
  ended_reason: string | null;
}

export interface SignoffBasis {
  acceptance_id: string;
  acceptance_consumed_at: string;
  run_id: string;
  run_created_at: string;
}

/** Only plain text publishing can be signed off for now. */
export const SIGNABLE_OPERATIONS: ReadonlySet<string> = new Set(["content.publish.text"]);

/**
 * An evidence signoff is what the owner types in a terminal after a real, approved acceptance run worked: this
 * operation, on this account, has been seen to work. It moves the operation from UNVERIFIED to "available after a
 * trusted approval" for that account until it expires (at most as long as provider evidence stays fresh). It grants
 * no permission to write without approval: every publish still needs a human approval or a live standing grant.
 * No MCP tool signs or revokes evidence (threat T25).
 */
export class Signoffs {
  constructor(private readonly db: Db, private readonly clock: () => number = Date.now) {}

  private iso(ms = this.clock()): string {
    return new Date(ms).toISOString();
  }

  /** The real acceptance run this signoff rests on: a consumed arming plus a succeeded run of that operation on that account. */
  findBasis(accountId: string, operation: string): SignoffBasis | undefined {
    const acc = this.db.get<{ id: string; armed_at: string; consumed_at: string | null }>("SELECT id, armed_at, consumed_at FROM operation_acceptance WHERE account_id = ? AND operation = ? AND state = 'consumed' ORDER BY consumed_at DESC LIMIT 1", accountId, operation);
    if (!acc?.consumed_at) return undefined;
    const runs = this.db.all<{ run_id: string; created_at: string; payload_json: string }>("SELECT r.id AS run_id, r.created_at AS created_at, p.payload_json AS payload_json FROM workflow_runs r JOIN execution_plans p ON p.id = r.plan_id WHERE r.state = 'succeeded' AND r.created_at >= ? ORDER BY r.created_at DESC LIMIT 50", acc.armed_at);
    for (const r of runs) {
      const payload = jsonOr<PlanPayload | null>(r.payload_json, null);
      if (payload?.targets.some((t) => t.account_id === accountId && t.operation === operation)) {
        return { acceptance_id: acc.id, acceptance_consumed_at: acc.consumed_at, run_id: r.run_id, run_created_at: r.created_at };
      }
    }
    return undefined;
  }

  sign(provider: string, accountId: string, operation: string, opts: { days?: number }, actor: { tty: true; user: string }): SignoffRow {
    if (!SIGNABLE_OPERATIONS.has(operation)) throw new GatewayError("VALIDATION_FAILED", `evidence can only be signed for: ${[...SIGNABLE_OPERATIONS].join(", ")}`);
    const days = opts.days ?? MAX_EVIDENCE_AGE_DAYS;
    if (!(days > 0) || days > MAX_EVIDENCE_AGE_DAYS) throw new GatewayError("VALIDATION_FAILED", `a signoff lasts at most ${MAX_EVIDENCE_AGE_DAYS} days`);
    const basis = this.findBasis(accountId, operation);
    if (!basis) throw new GatewayError("VALIDATION_FAILED", `no successful acceptance run of ${operation} on ${accountId} to rest on; run first-post first`);
    const id = newId("evs");
    const now = this.clock();
    return this.db.tx(() => {
      this.db.run("UPDATE evidence_signoffs SET state = 'revoked', ended_at = ?, ended_reason = 'replaced' WHERE account_id = ? AND operation = ? AND state = 'active'", this.iso(now), accountId, operation);
      this.db.run("INSERT INTO evidence_signoffs(id, provider, account_id, operation, state, basis_acceptance_id, basis_run_id, signed_at, expires_at, actor_evidence) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)",
        id, provider, accountId, operation, basis.acceptance_id, basis.run_id, this.iso(now), this.iso(now + days * 86_400_000), JSON.stringify({ tty: actor.tty, user: actor.user, at: this.iso(now) }));
      return this.get(id)!;
    });
  }

  get(id: string): SignoffRow | undefined {
    return this.db.get<SignoffRow>("SELECT * FROM evidence_signoffs WHERE id = ?", id) ?? undefined;
  }

  list(limit = 20): SignoffRow[] {
    return this.db.all<SignoffRow>("SELECT * FROM evidence_signoffs ORDER BY signed_at DESC LIMIT ?", limit);
  }

  revoke(id: string): boolean {
    return this.db.run("UPDATE evidence_signoffs SET state = 'revoked', ended_at = ?, ended_reason = 'owner' WHERE id = ? AND state = 'active'", this.iso(), id).changes === 1;
  }

  active(accountId: string, operation: string): SignoffRow | undefined {
    const row = this.db.get<SignoffRow>("SELECT * FROM evidence_signoffs WHERE account_id = ? AND operation = ? AND state = 'active'", accountId, operation);
    if (!row || Date.parse(row.expires_at) <= this.clock()) return undefined;
    return row;
  }

  /** Part of the capability cache key, so a signoff made or revoked in another process takes effect at once. */
  epoch(accountId: string): string {
    const r = this.db.get<{ n: number; last: string | null }>("SELECT COUNT(*) AS n, MAX(COALESCE(ended_at, signed_at)) AS last FROM evidence_signoffs WHERE account_id = ?", accountId);
    const live = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence_signoffs WHERE account_id = ? AND state = 'active' AND expires_at > ?", accountId, this.iso());
    return `${r?.n ?? 0}:${r?.last ?? ""}:${live?.n ?? 0}`;
  }
}

export function publicSignoff(s: SignoffRow, now = Date.now()): Record<string, unknown> {
  return {
    signoff_id: s.id,
    provider: s.provider,
    account_id: s.account_id,
    operation: s.operation,
    state: s.state === "active" && Date.parse(s.expires_at) <= now ? "expired" : s.state,
    signed_at: s.signed_at,
    expires_at: s.expires_at,
    basis_run_id: s.basis_run_id,
    ended_reason: s.ended_reason,
  };
}
