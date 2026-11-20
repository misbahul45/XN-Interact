import { GatewayError } from "../contracts/errors.ts";
import type { StoredPlan } from "../routing/plans.ts";
import { type Db, newId } from "../storage/db.ts";

export type GrantState = "active" | "revoked" | "suspended" | "exhausted";

export interface GrantRow {
  id: string;
  provider: string;
  account_id: string;
  operation: string;
  state: GrantState;
  max_per_day: number;
  max_total: number;
  used_total: number;
  created_at: string;
  expires_at: string;
  actor_evidence: string;
  ended_at: string | null;
  ended_reason: string | null;
}

/** Only plain text publishing can be covered. Media, edits, deletes, replies and scheduled work always need a human. */
export const GRANTABLE_OPERATIONS: ReadonlySet<string> = new Set(["content.publish.text"]);
export const MAX_GRANT_TTL_MS = 24 * 3600_000;
export const DEFAULT_PER_DAY = 3;
export const MAX_PER_DAY = 10;
export const DEFAULT_TOTAL = 10;
export const MAX_TOTAL = 50;
const DAY_MS = 24 * 3600_000;

export interface GrantCheck {
  grant?: GrantRow;
  reason?: string;
}

export interface GrantOptions {
  ttlMs?: number;
  maxPerDay?: number;
  maxTotal?: number;
}

function intIn(value: number | undefined, fallback: number, max: number, what: string): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < 1 || v > max) throw new GatewayError("VALIDATION_FAILED", `${what} must be a whole number from 1 to ${max}`);
  return v;
}

/**
 * A standing grant is signed by the owner in a terminal (see the `grant` CLI command) and stands in for the
 * per-plan terminal approval of ONE operation on ONE account, for a short time and a few posts. It is not an
 * authorization to bypass the capability gate: an UNVERIFIED operation still cannot run. No MCP tool creates,
 * extends or changes a grant (threat T24).
 */
export class Grants {
  constructor(private readonly db: Db, private readonly clock: () => number = Date.now) {}

  private iso(ms = this.clock()): string {
    return new Date(ms).toISOString();
  }

  create(provider: string, accountId: string, operation: string, opts: GrantOptions, actor: { tty: true; user: string }): GrantRow {
    if (!GRANTABLE_OPERATIONS.has(operation)) throw new GatewayError("VALIDATION_FAILED", `a standing grant can only cover: ${[...GRANTABLE_OPERATIONS].join(", ")}`);
    const ttl = opts.ttlMs ?? MAX_GRANT_TTL_MS;
    if (!(ttl > 0) || ttl > MAX_GRANT_TTL_MS) throw new GatewayError("VALIDATION_FAILED", `a standing grant lasts at most ${MAX_GRANT_TTL_MS / 3600_000} hours`);
    const perDay = intIn(opts.maxPerDay, DEFAULT_PER_DAY, MAX_PER_DAY, "max per day");
    const total = intIn(opts.maxTotal, DEFAULT_TOTAL, MAX_TOTAL, "max total");
    const id = newId("gnt");
    const now = this.clock();
    return this.db.tx(() => {
      this.db.run("UPDATE standing_grants SET state = 'revoked', ended_at = ?, ended_reason = 'replaced' WHERE account_id = ? AND operation = ? AND state IN ('active', 'suspended')", this.iso(now), accountId, operation);
      this.db.run("INSERT INTO standing_grants(id, provider, account_id, operation, state, max_per_day, max_total, used_total, created_at, expires_at, actor_evidence) VALUES (?, ?, ?, ?, 'active', ?, ?, 0, ?, ?, ?)",
        id, provider, accountId, operation, perDay, total, this.iso(now), this.iso(now + ttl), JSON.stringify({ tty: actor.tty, user: actor.user, at: this.iso(now) }));
      return this.get(id)!;
    });
  }

  get(id: string): GrantRow | undefined {
    return this.db.get<GrantRow>("SELECT * FROM standing_grants WHERE id = ?", id) ?? undefined;
  }

  list(limit = 20): GrantRow[] {
    return this.db.all<GrantRow>("SELECT * FROM standing_grants ORDER BY created_at DESC LIMIT ?", limit);
  }

  revoke(id: string): boolean {
    return this.db.run("UPDATE standing_grants SET state = 'revoked', ended_at = ?, ended_reason = 'owner' WHERE id = ? AND state IN ('active', 'suspended')", this.iso(), id).changes === 1;
  }

  usesToday(id: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM standing_grant_uses WHERE grant_id = ? AND used_at > ?", id, this.iso(this.clock() - DAY_MS))?.n ?? 0;
  }

  /** Read-only: can a grant cover one more run right now? */
  check(accountId: string, operation: string): GrantCheck {
    const g = this.db.get<GrantRow>("SELECT * FROM standing_grants WHERE account_id = ? AND operation = ? AND state = 'active'", accountId, operation);
    if (!g) return { reason: "no active standing grant" };
    if (Date.parse(g.expires_at) <= this.clock()) return { reason: "the standing grant expired" };
    if (g.used_total >= g.max_total) return { reason: "the standing grant is used up" };
    if (this.usesToday(g.id) >= g.max_per_day) return { reason: "the daily limit of the standing grant is reached" };
    const unresolved = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM standing_grant_uses u JOIN workflow_runs r ON r.id = u.run_id WHERE u.grant_id = ? AND r.state IN ('unknown_outcome', 'reconciling')", g.id)?.n ?? 0;
    if (unresolved) return { reason: "an earlier run under this grant has an unresolved outcome; the owner must review it and create a new grant" };
    return { grant: g };
  }

  live(accountId: string, operation: string): GrantRow | undefined {
    return this.check(accountId, operation).grant;
  }

  /** An unresolved outcome ends the grant for good: it is marked suspended and only the owner can issue a new one. */
  suspendIfUnresolved(accountId: string, operation: string): boolean {
    const g = this.db.get<GrantRow>("SELECT * FROM standing_grants WHERE account_id = ? AND operation = ? AND state = 'active'", accountId, operation);
    if (!g) return false;
    const unresolved = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM standing_grant_uses u JOIN workflow_runs r ON r.id = u.run_id WHERE u.grant_id = ? AND r.state IN ('unknown_outcome', 'reconciling')", g.id)?.n ?? 0;
    if (!unresolved) return false;
    return this.db.run("UPDATE standing_grants SET state = 'suspended', ended_at = ?, ended_reason = 'unresolved_outcome' WHERE id = ? AND state = 'active'", this.iso(), g.id).changes === 1;
  }

  /**
   * Call inside the transaction that creates the run. Returns the grant when it covers the whole plan and has been
   * spent for this run; null when a human approval is needed. Only a single-target, immediate, text-only plan is covered.
   */
  consumeInTx(plan: StoredPlan, runId: string): GrantRow | null {
    const p = plan.payload;
    if (!p.approval_required || p.risk !== "EXTERNAL_WRITE" || p.schedule_at || p.targets.length !== 1) return null;
    const t = p.targets[0]!;
    if (!GRANTABLE_OPERATIONS.has(t.operation)) return null;
    const { grant } = this.check(t.account_id, t.operation);
    if (!grant) return null;
    const spent = this.db.run("UPDATE standing_grants SET used_total = used_total + 1 WHERE id = ? AND state = 'active' AND used_total < max_total", grant.id);
    if (spent.changes !== 1) return null;
    this.db.run("INSERT INTO standing_grant_uses(id, grant_id, plan_id, plan_hash, run_id, used_at) VALUES (?, ?, ?, ?, ?, ?)", newId("gnu"), grant.id, plan.id, plan.plan_hash, runId, this.iso());
    if (grant.used_total + 1 >= grant.max_total) {
      this.db.run("UPDATE standing_grants SET state = 'exhausted', ended_at = ?, ended_reason = 'max_total' WHERE id = ? AND state = 'active'", this.iso(), grant.id);
    }
    return { ...grant, used_total: grant.used_total + 1 };
  }
}

export function publicGrant(g: GrantRow, usesToday: number, now = Date.now()): Record<string, unknown> {
  const live = g.state === "active" && Date.parse(g.expires_at) > now && g.used_total < g.max_total;
  return {
    grant_id: g.id,
    provider: g.provider,
    account_id: g.account_id,
    operation: g.operation,
    state: g.state === "active" && !live ? (Date.parse(g.expires_at) <= now ? "expired" : g.state) : g.state,
    expires_at: g.expires_at,
    used_total: g.used_total,
    max_total: g.max_total,
    used_today: usesToday,
    max_per_day: g.max_per_day,
    ended_reason: g.ended_reason,
  };
}
