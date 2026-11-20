import { GatewayError } from "../contracts/errors.ts";
import type { StoredPlan } from "../routing/plans.ts";
import { type Db, jsonOr, newId, nowIso } from "../storage/db.ts";

export interface ApprovalRow {
  id: string;
  plan_id: string;
  plan_hash: string;
  operation: string;
  account_ids_json: string;
  content_digest: string | null;
  nonce: string;
  expires_at: string;
  decision: "pending" | "approved" | "rejected" | "expired";
  actor_evidence: string | null;
  decided_at: string | null;
  used_at: string | null;
  consumed_by: string | null;
  created_at: string;
}

export const APPROVAL_TTL_MS = 3600_000;

export function publicApproval(a: ApprovalRow): Record<string, unknown> {
  const expired = a.decision === "pending" && Date.parse(a.expires_at) < Date.now();
  return {
    approval_id: a.id,
    plan_id: a.plan_id,
    plan_hash: a.plan_hash,
    operation: a.operation,
    account_ids: jsonOr<string[]>(a.account_ids_json, []),
    decision: expired ? "expired" : a.decision,
    consumed: Boolean(a.used_at),
    consumed_by: a.consumed_by,
    expires_at: a.expires_at,
    decided_at: a.decided_at,
    via_standing_grant: jsonOr<{ standing_grant?: string }>(a.actor_evidence, {}).standing_grant,
    how_to_decide: a.decision === "pending" && !expired ? `In your own terminal: xn-interact approve ${a.id}` : undefined,
  };
}

export class Approvals {
  constructor(private readonly db: Db) {}

  request(plan: StoredPlan): ApprovalRow {
    const existing = this.db.get<ApprovalRow>("SELECT * FROM approvals WHERE plan_id = ? AND decision = 'pending' AND expires_at > ?", plan.id, nowIso());
    if (existing) return existing;
    const id = newId("apr");
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
    const now = nowIso();
    const expires = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
    this.db.run("INSERT INTO approvals(id, plan_id, plan_hash, operation, account_ids_json, content_digest, nonce, expires_at, decision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      id, plan.id, plan.plan_hash, plan.payload.operation, JSON.stringify(plan.payload.targets.map((t) => t.account_id)), plan.payload.content_digest, nonce, expires, now);
    return this.get(id);
  }

  get(id: string): ApprovalRow {
    const a = this.db.get<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", id);
    if (!a) throw new GatewayError("APPROVAL_INVALID", `unknown approval ${id}`);
    return a;
  }

  forPlan(planId: string): ApprovalRow | null {
    return this.db.get<ApprovalRow>("SELECT * FROM approvals WHERE plan_id = ? ORDER BY created_at DESC LIMIT 1", planId);
  }

  pending(): ApprovalRow[] {
    return this.db.all<ApprovalRow>("SELECT * FROM approvals WHERE decision = 'pending' AND expires_at > ? ORDER BY created_at", nowIso());
  }

  decideFromTrustedTerminal(id: string, decision: "approved" | "rejected", evidence: { tty: true; user: string; confirmed_hash_prefix: string }): ApprovalRow {
    const a = this.get(id);
    if (a.decision !== "pending") throw new GatewayError("APPROVAL_INVALID", `approval is already ${a.decision}`);
    if (Date.parse(a.expires_at) < Date.now()) {
      this.db.run("UPDATE approvals SET decision = 'expired' WHERE id = ?", id);
      throw new GatewayError("APPROVAL_INVALID", "approval request expired; create a new plan");
    }
    if (!a.plan_hash.startsWith(evidence.confirmed_hash_prefix) || evidence.confirmed_hash_prefix.length < 8) throw new GatewayError("APPROVAL_INVALID", "confirmation does not match the plan hash");
    this.db.run("UPDATE approvals SET decision = ?, actor_evidence = ?, decided_at = ? WHERE id = ? AND decision = 'pending'", decision, JSON.stringify({ ...evidence, at: nowIso() }), nowIso(), id);
    return this.get(id);
  }

  /**
   * A live standing grant stands in for the terminal approval. It can only complete a request that is still pending,
   * unexpired and bound to this exact plan hash: a rejected, used or expired approval is never overridden.
   */
  pendingFor(plan: StoredPlan): ApprovalRow | null {
    const a = this.forPlan(plan.id);
    if (!a || a.decision !== "pending" || a.used_at) return null;
    if (Date.parse(a.expires_at) < Date.now() || a.plan_hash !== plan.plan_hash) return null;
    return a;
  }

  approveByGrantInTx(plan: StoredPlan, approvalId: string, grantId: string, runId: string): ApprovalRow {
    const now = nowIso();
    const evidence = JSON.stringify({ standing_grant: grantId, tty: false, at: now });
    const r = this.db.run("UPDATE approvals SET decision = 'approved', actor_evidence = ?, decided_at = ?, used_at = ?, consumed_by = ? WHERE id = ? AND decision = 'pending' AND used_at IS NULL AND plan_hash = ?", evidence, now, now, runId, approvalId, plan.plan_hash);
    if (r.changes !== 1) throw new GatewayError("APPROVAL_INVALID", "approval was consumed concurrently", { approval_id: approvalId });
    return this.get(approvalId);
  }

  consumeInTx(plan: StoredPlan, runId: string): ApprovalRow {
    const a = this.forPlan(plan.id);
    if (!a) throw new GatewayError("APPROVAL_REQUIRED", "this plan has no approval request");
    if (a.decision === "pending") {
      if (Date.parse(a.expires_at) < Date.now()) throw new GatewayError("APPROVAL_INVALID", "approval request expired; create a new plan");
      throw new GatewayError("APPROVAL_REQUIRED", "a human has not approved this plan yet", { approval_id: a.id, actionable_next_step: `The owner runs \`xn-interact approve ${a.id}\` in a terminal` });
    }
    if (a.decision !== "approved") throw new GatewayError("APPROVAL_INVALID", `approval was ${a.decision}`, { approval_id: a.id });
    if (a.used_at) throw new GatewayError("APPROVAL_INVALID", "approval was already used", { approval_id: a.id });
    if (Date.parse(a.expires_at) < Date.now()) throw new GatewayError("APPROVAL_INVALID", "approval expired before it was used; create a new plan", { approval_id: a.id });
    if (a.plan_hash !== plan.plan_hash) throw new GatewayError("PLAN_CHANGED", "the plan changed after approval", { approval_id: a.id });
    const r = this.db.run("UPDATE approvals SET used_at = ?, consumed_by = ? WHERE id = ? AND decision = 'approved' AND used_at IS NULL AND plan_hash = ?", nowIso(), runId, a.id, plan.plan_hash);
    if (r.changes !== 1) throw new GatewayError("APPROVAL_INVALID", "approval was consumed concurrently", { approval_id: a.id });
    return this.get(a.id);
  }
}
