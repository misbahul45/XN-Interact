import { GatewayError } from "../contracts/errors.ts";
import type { OperationManifest } from "../providers/contract.ts";
import { type Db, nowIso } from "../storage/db.ts";

interface BudgetRow {
  account_id: string;
  operation: string;
  period: string;
  window_start: string;
  spent: number;
  max_calls: number | null;
  spent_cost: number;
  max_cost: number | null;
  retry_after: string | null;
}

function dayStart(now = new Date()): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export interface Admission {
  state: "AVAILABLE" | "RATE_LIMITED" | "COST_LIMITED";
  reason?: string;
  retry_after_ms?: number;
  estimated_cost: number | null;
  cost_uncertain: boolean;
}

export class Budget {
  constructor(private readonly db: Db) {}

  private row(accountId: string, operation: string): BudgetRow | null {
    const r = this.db.get<BudgetRow>("SELECT * FROM provider_budgets WHERE account_id = ? AND operation = ? AND period = 'day'", accountId, operation)
      ?? this.db.get<BudgetRow>("SELECT * FROM provider_budgets WHERE account_id = ? AND operation = '*' AND period = 'day'", accountId);
    if (r && r.window_start !== dayStart()) {
      this.db.run("UPDATE provider_budgets SET spent = 0, spent_cost = 0, window_start = ?, updated_at = ? WHERE account_id = ? AND operation = ? AND period = 'day'", dayStart(), nowIso(), r.account_id, r.operation);
      return { ...r, spent: 0, spent_cost: 0, window_start: dayStart() };
    }
    return r;
  }

  setLimit(accountId: string, operation: string, maxCalls: number | null, maxCost: number | null): void {
    this.db.run(
      "INSERT INTO provider_budgets(account_id, operation, period, window_start, max_calls, max_cost, updated_at) VALUES (?, ?, 'day', ?, ?, ?, ?) ON CONFLICT(account_id, operation, period) DO UPDATE SET max_calls = excluded.max_calls, max_cost = excluded.max_cost, updated_at = excluded.updated_at",
      accountId, operation, dayStart(), maxCalls, maxCost, nowIso(),
    );
  }

  admit(accountId: string, operation: string, m: OperationManifest, calls = 1): Admission {
    const r = this.row(accountId, operation);
    const perCall = m.cost ? m.cost.per_call : 0;
    const uncertain = Boolean(m.cost?.uncertain) || perCall === null;
    const estimated = perCall === null ? null : perCall * calls;
    if (r?.retry_after && Date.parse(r.retry_after) > Date.now()) {
      return { state: "RATE_LIMITED", reason: "provider asked to wait", retry_after_ms: Date.parse(r.retry_after) - Date.now(), estimated_cost: estimated, cost_uncertain: uncertain };
    }
    if (r?.max_calls != null && r.spent + calls > r.max_calls) return { state: "RATE_LIMITED", reason: `daily call budget ${r.max_calls} reached`, estimated_cost: estimated, cost_uncertain: uncertain };
    if (perCall === null) {
      if (r?.max_cost == null) return { state: "COST_LIMITED", reason: "cost is unknown and no cost budget allows it", estimated_cost: null, cost_uncertain: true };
    } else if (r?.max_cost != null && r.spent_cost + (estimated ?? 0) > r.max_cost) {
      return { state: "COST_LIMITED", reason: `daily cost budget ${r.max_cost} would be exceeded`, estimated_cost: estimated, cost_uncertain: uncertain };
    }
    return { state: "AVAILABLE", estimated_cost: estimated, cost_uncertain: uncertain };
  }

  enforce(accountId: string, operation: string, m: OperationManifest): void {
    const a = this.admit(accountId, operation, m);
    if (a.state === "RATE_LIMITED") throw new GatewayError("RATE_LIMITED", a.reason ?? "rate limited", { retry_after_ms: a.retry_after_ms });
    if (a.state === "COST_LIMITED") throw new GatewayError("COST_LIMITED", a.reason ?? "cost limited", { actionable_next_step: "Set a budget with `xn-interact budget set`" });
  }

  record(accountId: string, operation: string, m: OperationManifest): void {
    const cost = m.cost?.per_call ?? 0;
    this.db.run(
      "INSERT INTO provider_budgets(account_id, operation, period, window_start, spent, spent_cost, updated_at) VALUES (?, ?, 'day', ?, 1, ?, ?) ON CONFLICT(account_id, operation, period) DO UPDATE SET spent = spent + 1, spent_cost = spent_cost + excluded.spent_cost, updated_at = excluded.updated_at",
      accountId, operation, dayStart(), cost, nowIso(),
    );
  }

  rateLimited(accountId: string, operation: string, retryAfterMs: number): void {
    const until = new Date(Date.now() + retryAfterMs).toISOString();
    this.db.run(
      "INSERT INTO provider_budgets(account_id, operation, period, window_start, retry_after, updated_at) VALUES (?, ?, 'day', ?, ?, ?) ON CONFLICT(account_id, operation, period) DO UPDATE SET retry_after = excluded.retry_after, updated_at = excluded.updated_at",
      accountId, operation, dayStart(), until, nowIso(),
    );
  }

  snapshot(): BudgetRow[] {
    return this.db.all<BudgetRow>("SELECT * FROM provider_budgets ORDER BY account_id, operation");
  }
}
