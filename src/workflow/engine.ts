import type { Acceptance } from "../policy/acceptance.ts";
import { CATALOG, operation as catalogOp, workflow as catalogWorkflow, type CatalogStep, type CatalogWorkflow } from "../contracts/catalog.ts";
import { digest } from "../contracts/canonical.ts";
import { GatewayError, type ErrorCode } from "../contracts/errors.ts";
import type { AccountRegistry } from "../identity/account-registry.ts";
import type { AppSecrets } from "../identity/app-secrets.ts";
import type { TokenManager } from "../identity/token-manager.ts";
import { log } from "../observability/logger.ts";
import type { Audit } from "../observability/audit.ts";
import type { Results } from "../performance/results.ts";
import type { Budget } from "../policy/budget.ts";
import type { CapabilityResolver } from "../policy/capability-resolver.ts";
import type { AdapterContext, WriteRequest } from "../providers/contract.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { PlanTarget, StoredPlan } from "../routing/plans.ts";
import type { ProviderHttp } from "../transport/provider-http.ts";
import { type Db, jsonOr, newId, nowIso } from "../storage/db.ts";
import type { Leases } from "./leases.ts";

export type RunState = "accepted" | "preflight" | "unsupported" | "approval_pending" | "queued" | "running" | "waiting_provider" | "reconciling" | "succeeded" | "partially_succeeded" | "failed" | "unknown_outcome" | "cancelled";
export type StepState = "pending" | "ready" | "running" | "waiting_provider" | "awaiting_user" | "completed" | "failed" | "unknown_outcome" | "skipped" | "cancelled";
export type TargetOutcome = "succeeded" | "failed" | "unsupported" | "needs_reauth" | "app_approval_required" | "pending" | "unknown_outcome" | "cancelled" | "skipped";

export const TERMINAL: readonly RunState[] = ["unsupported", "succeeded", "partially_succeeded", "failed", "unknown_outcome", "cancelled"];
const SKIP_INTERNAL = new Set(["preflight", "approval_gate", "aggregate", "fanout"]);
const MAX_RATE_RETRIES = 3;
const MAX_POLLS = 20;

interface RunRow {
  id: string;
  definition_id: string;
  definition_rev: number;
  definition_json: string;
  plan_id: string;
  plan_hash: string;
  operation_id: string;
  approval_id: string | null;
  state: RunState;
  due_at: string | null;
  version: number;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  id: string;
  run_id: string;
  target_index: number;
  account_id: string | null;
  definition_id: string;
  step_id: string;
  seq: number;
  attempt: number;
  status: StepState;
  provider_ref: string | null;
  detail_json: string;
  updated_at: string;
}

interface IntentRow {
  id: string;
  step_row_id: string;
  run_id: string;
  account_id: string;
  operation: string;
  dedupe_key: string;
  request_digest: string;
  outcome: "pending" | "succeeded" | "failed" | "unknown_outcome";
  provider_ref: string | null;
  evidence_json: string | null;
}

interface MaterialStep extends CatalogStep {
  definition_id: string;
}

export interface TargetView {
  index: number;
  account_id: string;
  provider: string;
  operation: string;
  state: TargetOutcome;
  provider_ref?: string | null;
  url?: string | null;
  error?: { code: string; message: string } | null;
  warnings?: string[];
}

export interface RunView {
  run_id: string;
  plan_id: string;
  workflow: string;
  status: RunState;
  version: number;
  due_at: string | null;
  counts: Record<string, number>;
  targets: TargetView[];
  result_ref?: string;
  process_lifetime_caveat?: string;
}

export interface EngineDeps {
  db: Db;
  providers: ProviderRegistry;
  accounts: AccountRegistry;
  tokens: TokenManager;
  apps: AppSecrets;
  budget: Budget;
  resolver: CapabilityResolver;
  results: Results;
  audit: Audit;
  leases: Leases;
  http: ProviderHttp;
  acceptance?: Acceptance;
}

const OUTCOME_FOR_CODE: Partial<Record<ErrorCode, TargetOutcome>> = {
  REAUTH_REQUIRED: "needs_reauth",
  NOT_CONNECTED: "needs_reauth",
  MISSING_SCOPES: "needs_reauth",
  APP_APPROVAL_REQUIRED: "app_approval_required",
  UNSUPPORTED: "unsupported",
  UNVERIFIED: "unsupported",
  MANUAL_ONLY: "unsupported",
  PROHIBITED: "unsupported",
  ACCOUNT_TYPE_UNSUPPORTED: "unsupported",
  ACCOUNT_ROLE_INSUFFICIENT: "unsupported",
};

export const CAPABILITY_TO_CODE: Record<string, ErrorCode> = {
  NOT_CONNECTED: "NOT_CONNECTED",
  MISSING_SCOPES: "MISSING_SCOPES",
  APP_APPROVAL_REQUIRED: "APP_APPROVAL_REQUIRED",
  ACCOUNT_TYPE_UNSUPPORTED: "ACCOUNT_TYPE_UNSUPPORTED",
  ACCOUNT_ROLE_INSUFFICIENT: "ACCOUNT_ROLE_INSUFFICIENT",
  RATE_LIMITED: "RATE_LIMITED",
  COST_LIMITED: "COST_LIMITED",
  NEEDS_APPROVAL: "APPROVAL_REQUIRED",
  MANUAL_ONLY: "MANUAL_ONLY",
  PROHIBITED: "PROHIBITED",
  UNVERIFIED: "UNVERIFIED",
  UNSUPPORTED: "UNSUPPORTED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
};

export interface PinnedDefinition {
  workflow: CatalogWorkflow;
  children: Record<string, CatalogWorkflow>;
}

export function pin(def: CatalogWorkflow): PinnedDefinition {
  const children: Record<string, CatalogWorkflow> = {};
  for (const s of def.steps) for (const c of s.children ?? []) {
    const w = catalogWorkflow(c);
    if (w) children[c] = w;
  }
  return { workflow: def, children };
}

export function materialize(pinned: PinnedDefinition, target: PlanTarget): MaterialStep[] {
  const def = pinned.workflow;
  const out: MaterialStep[] = [];
  for (const s of def.steps) {
    if (s.internal === "fanout") {
      const child = pinned.children[target.workflow];
      if (!child || !(s.children ?? []).includes(child.id)) throw new Error(`target workflow ${target.workflow} is not a child of ${def.id}`);
      for (const c of child.steps) if (!SKIP_INTERNAL.has(c.internal ?? "")) out.push({ ...c, definition_id: child.id });
    } else if (!SKIP_INTERNAL.has(s.internal ?? "")) {
      out.push({ ...s, definition_id: def.id });
    }
  }
  return out;
}

export class WorkflowEngine {
  private readonly d: EngineDeps;

  constructor(deps: EngineDeps) {
    this.d = deps;
  }

  private get db(): Db {
    return this.d.db;
  }

  run(id: string): RunRow {
    const r = this.db.get<RunRow>("SELECT * FROM workflow_runs WHERE id = ?", id);
    if (!r) throw new GatewayError("VALIDATION_FAILED", `unknown run ${id}`);
    return r;
  }

  byOperation(operationId: string): RunRow | null {
    return this.db.get<RunRow>("SELECT * FROM workflow_runs WHERE operation_id = ?", operationId);
  }

  private plan(run: RunRow): StoredPlan {
    const r = this.db.get<{ id: string; plan_hash: string; payload_json: string; created_at: string; expires_at: string }>("SELECT * FROM execution_plans WHERE id = ?", run.plan_id)!;
    return { id: r.id, plan_hash: r.plan_hash, payload: JSON.parse(r.payload_json), created_at: r.created_at, expires_at: r.expires_at };
  }

  createRunInTx(plan: StoredPlan, operationId: string, approvalId: string | null, runId: string = newId("run")): string {
    const def = catalogWorkflow(plan.payload.workflow);
    if (!def) throw new GatewayError("UNSUPPORTED", `unknown workflow ${plan.payload.workflow}`);
    const [, rev] = def.id.split("@");
    const now = nowIso();
    const scheduled = def.steps.some((s) => s.internal === "schedule_wait") && plan.payload.schedule_at;
    this.db.run(
      "INSERT INTO workflow_runs(id, definition_id, definition_rev, definition_json, plan_id, plan_hash, operation_id, approval_id, state, due_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
      runId, def.id, Number(rev), JSON.stringify(pin(def)), plan.id, plan.plan_hash, operationId, approvalId, scheduled ? "queued" : "running", scheduled ? plan.payload.schedule_at : null, now, now,
    );
    const pinned = pin(def);
    for (const t of plan.payload.targets) {
      materialize(pinned, t).forEach((s, seq) => {
        this.db.run("INSERT INTO workflow_steps(id, run_id, target_index, account_id, definition_id, step_id, seq, status, detail_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '{}', ?)",
          newId("stp"), runId, t.index, t.account_id, s.definition_id, s.id, seq, now);
      });
    }
    this.d.audit.record("mcp", "workflow.create", "accepted", { run_id: runId, plan_id: plan.id, workflow: def.id, targets: plan.payload.targets.length });
    return runId;
  }

  private steps(runId: string, target?: number): StepRow[] {
    return target === undefined
      ? this.db.all<StepRow>("SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY target_index, seq", runId)
      : this.db.all<StepRow>("SELECT * FROM workflow_steps WHERE run_id = ? AND target_index = ? ORDER BY seq", runId, target);
  }

  private setStep(id: string, status: StepState, patch: Record<string, unknown> = {}, providerRef?: string | null): void {
    const cur = this.db.get<StepRow>("SELECT * FROM workflow_steps WHERE id = ?", id)!;
    const detail = { ...jsonOr<Record<string, unknown>>(cur.detail_json, {}), ...patch };
    this.db.run("UPDATE workflow_steps SET status = ?, detail_json = ?, provider_ref = COALESCE(?, provider_ref), updated_at = ? WHERE id = ?", status, JSON.stringify(detail), providerRef ?? null, nowIso(), id);
  }

  private bump(runId: string, state?: RunState): void {
    if (state) this.db.run("UPDATE workflow_runs SET state = ?, version = version + 1, updated_at = ? WHERE id = ?", state, nowIso(), runId);
    else this.db.run("UPDATE workflow_runs SET version = version + 1, updated_at = ? WHERE id = ?", nowIso(), runId);
  }

  private intentFor(stepRowId: string): IntentRow | null {
    return this.db.get<IntentRow>("SELECT * FROM operation_intents WHERE step_row_id = ?", stepRowId);
  }

  private lastWriteIntent(runId: string, target: number, beforeSeq: number): IntentRow | null {
    return this.db.get<IntentRow>(
      "SELECT i.* FROM operation_intents i JOIN workflow_steps s ON s.id = i.step_row_id WHERE s.run_id = ? AND s.target_index = ? AND s.seq < ? ORDER BY s.seq DESC LIMIT 1",
      runId, target, beforeSeq,
    );
  }

  private finishIntent(id: string, outcome: IntentRow["outcome"], providerRef: string | null, evidence: Record<string, unknown>): void {
    this.db.run("UPDATE operation_intents SET outcome = ?, provider_ref = COALESCE(?, provider_ref), evidence_json = ?, updated_at = ? WHERE id = ?", outcome, providerRef, JSON.stringify(evidence), nowIso(), id);
  }

  private opFor(step: MaterialStep, target: PlanTarget): string {
    const ops = step.op ?? [];
    if (ops.includes(target.operation)) return target.operation;
    if (ops.length === 1) return ops[0]!;
    throw new Error(`step ${step.id} cannot run operation ${target.operation}`);
  }

  private readonly advancing = new Map<string, Promise<RunView>>();

  advance(runId: string, budgetMs = 20_000): Promise<RunView> {
    const running = this.advancing.get(runId);
    if (running) return running;
    const p = this.advanceExclusive(runId, budgetMs).finally(() => this.advancing.delete(runId));
    this.advancing.set(runId, p);
    return p;
  }

  private async advanceExclusive(runId: string, budgetMs: number): Promise<RunView> {
    const lease = `run:${runId}`;
    if (!this.d.leases.acquire(lease)) return this.view(runId);
    try {
      const deadline = Date.now() + budgetMs;
      let run = this.run(runId);
      if (TERMINAL.includes(run.state)) return this.view(runId);
      if (run.due_at && Date.parse(run.due_at) > Date.now()) return this.view(runId);
      const def = JSON.parse(run.definition_json) as PinnedDefinition;
      const plan = this.plan(run);
      if (run.state === "queued") this.bump(runId, "running");
      const byProvider = new Map<string, PlanTarget[]>();
      for (const t of plan.payload.targets) byProvider.set(t.provider, [...(byProvider.get(t.provider) ?? []), t]);
      await Promise.all([...byProvider.values()].map(async (targets) => {
        for (const t of targets) await this.advanceTarget(run, def, t, deadline);
      }));
      run = this.run(runId);
      if (!TERMINAL.includes(run.state)) await this.aggregate(run, plan);
      return this.view(runId);
    } finally {
      this.d.leases.release(lease);
    }
  }

  private async context(t: PlanTarget): Promise<AdapterContext> {
    const account = this.d.accounts.require(t.account_id);
    const tokens = await this.d.tokens.usable(t.account_id);
    return { account: this.d.accounts.context(account), tokens, http: this.d.http };
  }

  private cancelRequested(runId: string): boolean {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM workflow_steps WHERE run_id = ? AND status = 'cancelled'", runId)!.n > 0
      || this.run(runId).state === "cancelled";
  }

  private async advanceTarget(run: RunRow, def: PinnedDefinition, t: PlanTarget, deadline: number): Promise<void> {
    const material = materialize(def, t);
    const rows = this.steps(run.id, t.index);
    for (let i = 0; i < rows.length; i++) {
      if (Date.now() > deadline) return;
      const row = this.db.get<StepRow>("SELECT * FROM workflow_steps WHERE id = ?", rows[i]!.id)!;
      const step = material[row.seq]!;
      if (["completed", "skipped"].includes(row.status)) continue;
      if (["failed", "unknown_outcome", "cancelled"].includes(row.status)) {
        if (row.status === "unknown_outcome" && rows.slice(i + 1).some((r) => material[r.seq]?.op?.includes("reconcile.read"))) {
          continue;
        }
        return;
      }
      if (this.cancelRequested(run.id) && step.internal === "journal_intent") {
        this.cancelRest(run.id, t.index, row.seq);
        return;
      }
      if (row.status === "waiting_provider") {
        const retryAt = jsonOr<{ retry_at?: string }>(row.detail_json, {}).retry_at;
        if (retryAt && Date.parse(retryAt) > Date.now()) return;
      }
      const cont = await this.execStep(run, t, step, row);
      this.bump(run.id);
      if (!cont) {
        const now = this.db.get<StepRow>("SELECT * FROM workflow_steps WHERE id = ?", row.id)!;
        if (now.status === "unknown_outcome" && rows.slice(i + 1).some((r) => material[r.seq]?.op?.includes("reconcile.read"))) continue;
        return;
      }
    }
  }

  private cancelRest(runId: string, target: number, fromSeq: number): void {
    this.db.run("UPDATE workflow_steps SET status = 'cancelled', updated_at = ? WHERE run_id = ? AND target_index = ? AND seq >= ? AND status IN ('pending', 'ready', 'waiting_provider')", nowIso(), runId, target, fromSeq);
  }

  private async execStep(run: RunRow, t: PlanTarget, step: MaterialStep, row: StepRow): Promise<boolean> {
    if (step.internal === "schedule_wait") {
      this.setStep(row.id, "completed", { released_at: nowIso() });
      return true;
    }
    if (step.internal === "journal_intent") {
      const next = this.db.get<StepRow>("SELECT * FROM workflow_steps WHERE run_id = ? AND target_index = ? AND seq = ?", run.id, t.index, row.seq + 1);
      if (!next) throw new Error("journal_intent without a following step");
      const nextStep = materialize(JSON.parse(run.definition_json) as PinnedDefinition, t)[next.seq]!;
      const op = this.opFor(nextStep, t);
      const dedupe = `${run.id}:${t.index}:${nextStep.id}`;
      const now = nowIso();
      this.db.tx(() => {
        if (!this.intentFor(next.id)) {
          this.db.run("INSERT INTO operation_intents(id, step_row_id, run_id, account_id, operation, dedupe_key, request_digest, outcome, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
            newId("int"), next.id, run.id, t.account_id, op, dedupe, digest({ op, params: t.params }), now, now);
        }
        this.setStep(row.id, "completed", { dedupe_key: dedupe });
      });
      return true;
    }
    if (step.internal === "provider_poll") return this.poll(run, t, row);
    if (step.internal === "load_journal") {
      this.setStep(row.id, "completed");
      return true;
    }
    const op = this.opFor(step, t);
    if (op === "reconcile.read") return this.reconcile(run, t, row);
    if (catalogOp(op).risk === "EXTERNAL_WRITE") return this.write(run, t, step, row, op);
    this.setStep(row.id, "completed");
    return true;
  }

  private mediaRef(runId: string, target: number): string | null {
    const rows = this.steps(runId, target).filter((s) => s.step_id === "container" && s.status === "completed");
    return rows.length ? (jsonOr<{ media_ref?: string }>(rows[0]!.detail_json, {}).media_ref ?? null) : null;
  }

  private async write(run: RunRow, t: PlanTarget, step: MaterialStep, row: StepRow, op: string): Promise<boolean> {
    const intent = this.intentFor(row.id);
    if (!intent) throw new GatewayError("INTERNAL_ERROR", `step ${step.id} has no journaled intent`);
    if (intent.outcome !== "pending") {
      this.setStep(row.id, intent.outcome === "succeeded" ? "completed" : intent.outcome === "failed" ? "failed" : "unknown_outcome");
      return intent.outcome === "succeeded";
    }
    if (row.status === "running") {
      this.finishIntent(intent.id, "unknown_outcome", null, { reason: "found running after interruption; not re-sent" });
      this.setStep(row.id, "unknown_outcome", { reason: "interrupted" });
      return false;
    }
    const verdict = this.d.resolver.resolve(t.account_id, op, { approved: true });
    if (verdict.state !== "AVAILABLE") {
      const code = CAPABILITY_TO_CODE[verdict.state] ?? "UNSUPPORTED";
      if (verdict.state === "RATE_LIMITED" && row.attempt < MAX_RATE_RETRIES) {
        this.db.run("UPDATE workflow_steps SET attempt = attempt + 1 WHERE id = ?", row.id);
        this.setStep(row.id, "waiting_provider", { retry_at: new Date(Date.now() + (verdict.retry_after_ms ?? 60_000)).toISOString(), reason: verdict.reason });
        return false;
      }
      this.finishIntent(intent.id, "failed", null, { code, reason: verdict.reason, sent: false });
      this.setStep(row.id, "failed", { error: { code, message: verdict.reason } });
      return false;
    }
    const adapter = this.d.providers.get(t.provider);
    const m = adapter.manifest.operations[op]!;
    const params: Record<string, unknown> = { ...t.params };
    const media = this.mediaRef(run.id, t.index);
    if (media) params.media_ref = media;
    const req: WriteRequest = { operation: op, params, intent_id: intent.id, dedupe_key: intent.dedupe_key };
    const claimed = this.db.run("UPDATE workflow_steps SET status = 'running', updated_at = ? WHERE id = ? AND status IN ('pending', 'ready', 'waiting_provider')", nowIso(), row.id).changes === 1;
    if (!claimed) return false;
    let ctx: AdapterContext;
    try {
      ctx = await this.context(t);
    } catch (e) {
      const err = e instanceof GatewayError ? e : new GatewayError("INTERNAL_ERROR", "context failed");
      this.finishIntent(intent.id, "failed", null, { code: err.code, sent: false });
      this.setStep(row.id, "failed", { error: { code: err.code, message: err.message } });
      return false;
    }
    this.setStep(row.id, "running", { started_at: nowIso() });
    try {
      if (op === "auth.revoke") {
        const revoked = await adapter.revoke(ctx.tokens, await this.d.apps.lookup(t.provider));
        const warnings = revoked ? [] : ["the provider has no revoke endpoint: the local grant was erased, but access stays valid at the provider until you remove the app in your account settings there"];
        this.finishIntent(intent.id, "succeeded", `revoked:${t.account_id}`, { at: nowIso(), provider_revoked: revoked });
        this.d.accounts.purge(t.account_id);
        this.d.resolver.invalidate(t.account_id);
        this.setStep(row.id, "completed", { purged: true, provider_revoked: revoked, warnings }, `revoked:${t.account_id}`);
        this.d.audit.record("workflow", "auth.revoke", "succeeded", { run_id: run.id }, t.account_id);
        return true;
      }
      const res = await adapter.write(req, ctx);
      if (this.d.acceptance?.consume(t.account_id, op, intent.id)) this.d.audit.record("workflow", `${op}.acceptance`, "consumed", { run_id: run.id, provider_ref: res.provider_ref }, t.account_id);
      this.d.budget.record(t.account_id, op, m);
      this.d.resolver.circuit.ok(t.provider);
      this.finishIntent(intent.id, "succeeded", res.provider_ref, { url: res.url ?? null, at: res.at ?? nowIso(), pending: res.pending ?? null });
      this.setStep(row.id, "completed", { url: res.url ?? null, container_id: res.pending?.container_id ?? null, poll_after_ms: res.pending?.poll_after_ms ?? null }, res.provider_ref);
      this.d.audit.record("workflow", op, "succeeded", { run_id: run.id, provider_ref: res.provider_ref }, t.account_id);
      return true;
    } catch (e) {
      const err = e instanceof GatewayError ? e : new GatewayError("OUTCOME_UNKNOWN", "adapter failed after the request may have been sent");
      if (err.code === "OUTCOME_UNKNOWN") {
        this.d.resolver.circuit.fail(t.provider);
        this.d.acceptance?.consume(t.account_id, op, intent.id);
        this.finishIntent(intent.id, "unknown_outcome", null, { message: err.message });
        this.setStep(row.id, "unknown_outcome", { error: { code: err.code, message: err.message } });
        this.d.audit.record("workflow", op, "unknown_outcome", { run_id: run.id }, t.account_id);
        return false;
      }
      if (err.code === "RATE_LIMITED" && row.attempt < MAX_RATE_RETRIES) {
        this.d.budget.rateLimited(t.account_id, op, err.extras.retry_after_ms ?? 60_000);
        this.db.run("UPDATE workflow_steps SET attempt = attempt + 1 WHERE id = ?", row.id);
        this.setStep(row.id, "waiting_provider", { retry_at: new Date(Date.now() + (err.extras.retry_after_ms ?? 60_000)).toISOString(), reason: "provider rate limit; request was refused, not applied" });
        return false;
      }
      if (err.code === "PROVIDER_ERROR" || err.code === "PROVIDER_UNAVAILABLE") this.d.resolver.circuit.fail(t.provider);
      this.finishIntent(intent.id, "failed", null, { code: err.code, message: err.message, sent: "refused_by_provider" });
      this.setStep(row.id, "failed", { error: { code: err.code, message: err.message } });
      this.d.audit.record("workflow", op, "failed", { run_id: run.id, code: err.code }, t.account_id);
      return false;
    }
  }

  private async poll(run: RunRow, t: PlanTarget, row: StepRow): Promise<boolean> {
    const upload = this.steps(run.id, t.index).find((s) => s.seq === row.seq - 1);
    const container = upload ? jsonOr<{ container_id?: string }>(upload.detail_json, {}).container_id : null;
    const ref = upload?.provider_ref ?? null;
    if (!container) {
      this.setStep(row.id, "completed", { media_ref: ref });
      return true;
    }
    const adapter = this.d.providers.get(t.provider);
    if (!adapter.poll) {
      this.setStep(row.id, "completed", { media_ref: ref });
      return true;
    }
    if (row.attempt >= MAX_POLLS) {
      this.setStep(row.id, "failed", { error: { code: "PROVIDER_ERROR", message: "media container never became ready; nothing was published" } });
      return false;
    }
    this.db.run("UPDATE workflow_steps SET attempt = attempt + 1 WHERE id = ?", row.id);
    const ctx = await this.context(t);
    const intent = this.intentFor(upload!.id)!;
    const r = await adapter.poll({ operation: "media.upload", params: t.params, intent_id: intent.id, dedupe_key: intent.dedupe_key }, ctx, container);
    if (r.done) {
      this.setStep(row.id, "completed", { media_ref: r.provider_ref ?? ref });
      return true;
    }
    this.setStep(row.id, "waiting_provider", { retry_at: new Date(Date.now() + 25).toISOString() });
    return false;
  }

  private async reconcile(run: RunRow, t: PlanTarget, row: StepRow): Promise<boolean> {
    const intent = this.lastWriteIntent(run.id, t.index, row.seq);
    if (!intent || intent.outcome === "failed") {
      this.setStep(row.id, "skipped");
      return false;
    }
    if (intent.operation === "auth.revoke") {
      const grant = this.d.accounts.grant(t.account_id);
      this.setStep(row.id, grant ? "failed" : "completed", { verified: !grant, evidence: "local grant purged" });
      return !grant;
    }
    const adapter = this.d.providers.get(t.provider);
    const m = adapter.manifest.operations[intent.operation];
    if (intent.outcome === "succeeded" && !m?.read_after_write) {
      this.setStep(row.id, "completed", { verified: false, note: "provider offers no read-after-write" });
      return true;
    }
    this.db.run("UPDATE workflow_runs SET state = 'reconciling' WHERE id = ? AND state IN ('running', 'waiting_provider')", run.id);
    let ev;
    try {
      ev = await adapter.inspectWriteOutcome({ operation: intent.operation, params: t.params, intent_id: intent.id, dedupe_key: intent.dedupe_key }, await this.context(t));
    } catch (e) {
      ev = { found: null, note: e instanceof GatewayError ? e.code : "inspect failed" };
    }
    if (intent.outcome === "succeeded") {
      this.setStep(row.id, "completed", { verified: ev.found === true, evidence: ev, warnings: ev.found === false ? ["provider reported success but read-back could not find it"] : [] });
      this.db.run("UPDATE workflow_runs SET state = 'running' WHERE id = ? AND state = 'reconciling'", run.id);
      return true;
    }
    if (ev.found === true) {
      this.finishIntent(intent.id, "succeeded", ev.provider_ref ?? null, { reconciled: true, url: ev.url ?? null, note: ev.note });
      this.db.run("UPDATE workflow_steps SET status = 'completed', provider_ref = ?, updated_at = ? WHERE id = ?", ev.provider_ref ?? null, nowIso(), intent.step_row_id);
      this.setStep(row.id, "completed", { verified: true, reconciled: "found", evidence: ev });
      this.d.audit.record("workflow", "reconcile", "found", { run_id: run.id }, t.account_id);
      this.db.run("UPDATE workflow_runs SET state = 'running' WHERE id = ? AND state = 'reconciling'", run.id);
      return true;
    }
    if (ev.found === false) {
      this.finishIntent(intent.id, "failed", null, { reconciled: true, absent: true, note: ev.note });
      this.db.run("UPDATE workflow_steps SET status = 'failed', detail_json = json_set(detail_json, '$.error', json(?)), updated_at = ? WHERE id = ?",
        JSON.stringify({ code: "PROVIDER_ERROR", message: "reconciliation proved the write was not applied" }), nowIso(), intent.step_row_id);
      this.setStep(row.id, "completed", { verified: true, reconciled: "absent", evidence: ev });
      this.d.audit.record("workflow", "reconcile", "absent", { run_id: run.id }, t.account_id);
      return false;
    }
    this.setStep(row.id, "unknown_outcome", { reconciled: "unprovable", evidence: ev });
    return false;
  }

  private targetView(run: RunRow, plan: StoredPlan, t: PlanTarget): TargetView {
    const rows = this.steps(run.id, t.index);
    const intents = this.db.all<IntentRow>("SELECT i.* FROM operation_intents i JOIN workflow_steps s ON s.id = i.step_row_id WHERE s.run_id = ? AND s.target_index = ? ORDER BY s.seq", run.id, t.index);
    const final = intents[intents.length - 1];
    const ev = jsonOr<{ url?: string | null }>(final?.evidence_json, {});
    const failed = rows.find((r) => r.status === "failed");
    const warnings = rows.flatMap((r) => jsonOr<{ warnings?: string[] }>(r.detail_json, {}).warnings ?? []);
    const base: TargetView = { index: t.index, account_id: t.account_id, provider: t.provider, operation: t.operation, state: "pending", provider_ref: final?.provider_ref ?? null, url: ev.url ?? null };
    if (warnings.length) base.warnings = warnings;
    if (failed) {
      const err = jsonOr<{ error?: { code: string; message: string } }>(failed.detail_json, {}).error ?? { code: "PROVIDER_ERROR", message: "step failed" };
      return { ...base, state: OUTCOME_FOR_CODE[err.code as ErrorCode] ?? "failed", error: err };
    }
    if (rows.some((r) => r.status === "unknown_outcome")) return { ...base, state: "unknown_outcome", error: { code: "OUTCOME_UNKNOWN", message: "the provider outcome could not be proven; do not retry, reconcile" } };
    if (rows.some((r) => r.status === "cancelled")) return { ...base, state: "cancelled" };
    if (rows.every((r) => r.status === "completed" || r.status === "skipped")) return { ...base, state: final && final.outcome !== "succeeded" ? "failed" : "succeeded" };
    return base;
  }

  private async aggregate(run: RunRow, plan: StoredPlan): Promise<void> {
    const targets = plan.payload.targets.map((t) => this.targetView(run, plan, t));
    if (targets.some((t) => t.state === "pending")) {
      const waiting = this.db.get<{ n: number }>("SELECT count(*) AS n FROM workflow_steps WHERE run_id = ? AND status = 'waiting_provider'", run.id)!.n > 0;
      this.bump(run.id, waiting ? "waiting_provider" : run.due_at && Date.parse(run.due_at) > Date.now() ? "queued" : "running");
      return;
    }
    const states = targets.map((t) => t.state);
    const any = (s: TargetOutcome) => states.includes(s);
    let state: RunState;
    if (states.every((s) => s === "succeeded")) state = "succeeded";
    else if (any("unknown_outcome")) state = "unknown_outcome";
    else if (any("succeeded")) state = "partially_succeeded";
    else if (states.every((s) => s === "cancelled")) state = "cancelled";
    else state = "failed";
    const view = { ...this.view(run.id), status: state, targets };
    const ref = `res_${run.id}`;
    await this.d.results.put(ref, run.id, view);
    this.db.run("UPDATE workflow_runs SET state = ?, result_json = ?, version = version + 1, updated_at = ? WHERE id = ?", state, JSON.stringify({ result_ref: ref, targets }), nowIso(), run.id);
    this.d.audit.record("workflow", "workflow.finish", state, { run_id: run.id });
  }

  view(runId: string): RunView {
    const run = this.run(runId);
    const plan = this.plan(run);
    const targets = plan.payload.targets.map((t) => this.targetView(run, plan, t));
    const counts: Record<string, number> = {};
    for (const t of targets) counts[t.state] = (counts[t.state] ?? 0) + 1;
    const out: RunView = { run_id: run.id, plan_id: run.plan_id, workflow: run.definition_id, status: run.state, version: run.version, due_at: run.due_at, counts, targets };
    if (TERMINAL.includes(run.state)) out.result_ref = `social://results/res_${run.id}`;
    if (run.due_at && !TERMINAL.includes(run.state)) out.process_lifetime_caveat = "Scheduled steps run only while an xn-interact process (MCP server or `xn-interact worker`) is alive at the due time";
    return out;
  }

  cancel(runId: string): RunView {
    const run = this.run(runId);
    if (TERMINAL.includes(run.state)) return this.view(runId);
    this.db.tx(() => {
      this.db.run("UPDATE workflow_steps SET status = 'cancelled', updated_at = ? WHERE run_id = ? AND status IN ('pending', 'ready', 'waiting_provider')", nowIso(), runId);
      this.bump(runId);
    });
    this.d.audit.record("mcp", "workflow.cancel", "requested", { run_id: runId });
    return this.view(runId);
  }

  async finalizeCancelled(runId: string): Promise<RunView> {
    const run = this.run(runId);
    if (!TERMINAL.includes(run.state) && !this.d.leases.heldByOther(`run:${runId}`)) await this.aggregate(run, this.plan(run));
    return this.view(runId);
  }

  recover(): { runs: string[]; interrupted: number } {
    const live = this.db.all<RunRow>("SELECT * FROM workflow_runs WHERE state NOT IN ('unsupported', 'succeeded', 'partially_succeeded', 'failed', 'unknown_outcome', 'cancelled')");
    let interrupted = 0;
    const runs: string[] = [];
    for (const r of live) {
      if (this.d.leases.heldByOther(`run:${r.id}`)) continue;
      const stuck = this.db.all<StepRow>("SELECT * FROM workflow_steps WHERE run_id = ? AND status = 'running'", r.id);
      for (const s of stuck) {
        const intent = this.intentFor(s.id);
        if (intent && intent.outcome === "pending") {
          this.finishIntent(intent.id, "unknown_outcome", null, { reason: "process stopped during the provider call; not re-sent" });
          this.setStep(s.id, "unknown_outcome", { reason: "interrupted" });
          interrupted++;
        } else if (intent) {
          this.setStep(s.id, intent.outcome === "succeeded" ? "completed" : intent.outcome === "failed" ? "failed" : "unknown_outcome");
        } else {
          this.setStep(s.id, "waiting_provider", { retry_at: nowIso() });
        }
      }
      runs.push(r.id);
    }
    if (interrupted) log.warn("recovered interrupted writes as unknown outcomes", { interrupted });
    return { runs, interrupted };
  }

  async tick(): Promise<string[]> {
    const due = this.db.all<{ id: string }>(
      "SELECT id FROM workflow_runs WHERE (state = 'queued' AND (due_at IS NULL OR due_at <= ?)) OR state IN ('waiting_provider', 'running', 'reconciling') ORDER BY created_at LIMIT 20",
      nowIso(),
    );
    const advanced: string[] = [];
    for (const r of due) {
      if (this.d.leases.heldByOther(`run:${r.id}`)) continue;
      await this.advance(r.id, 5_000);
      advanced.push(r.id);
    }
    return advanced;
  }

  async recoverUnknown(runIds?: string[]): Promise<Record<string, unknown>> {
    const rows = this.db.all<IntentRow>("SELECT * FROM operation_intents WHERE outcome = 'unknown_outcome'").filter((i) => !runIds?.length || runIds.includes(i.run_id));
    const report: Record<string, unknown>[] = [];
    for (const i of rows) {
      const run = this.run(i.run_id);
      const plan = this.plan(run);
      const step = this.db.get<StepRow>("SELECT * FROM workflow_steps WHERE id = ?", i.step_row_id)!;
      const t = plan.payload.targets.find((x) => x.index === step.target_index)!;
      let ev;
      try {
        ev = await this.d.providers.get(t.provider).inspectWriteOutcome({ operation: i.operation, params: t.params, intent_id: i.id, dedupe_key: i.dedupe_key }, await this.context(t));
      } catch (e) {
        ev = { found: null, note: e instanceof GatewayError ? e.code : "inspect failed" };
      }
      if (ev.found === true) {
        this.finishIntent(i.id, "succeeded", ev.provider_ref ?? null, { reconciled: true, url: ev.url ?? null });
        this.db.run("UPDATE workflow_steps SET status = 'completed', provider_ref = ?, updated_at = ? WHERE id = ?", ev.provider_ref ?? null, nowIso(), step.id);
        this.db.run("UPDATE workflow_steps SET status = 'completed', updated_at = ? WHERE run_id = ? AND target_index = ? AND seq > ? AND status = 'unknown_outcome'", nowIso(), run.id, step.target_index, step.seq);
      } else if (ev.found === false) {
        this.finishIntent(i.id, "failed", null, { reconciled: true, absent: true });
        this.db.run("UPDATE workflow_steps SET status = 'failed', detail_json = json_set(detail_json, '$.error', json(?)), updated_at = ? WHERE id = ?",
          JSON.stringify({ code: "PROVIDER_ERROR", message: "reconciliation proved the write was not applied" }), nowIso(), step.id);
        this.db.run("UPDATE workflow_steps SET status = 'skipped', updated_at = ? WHERE run_id = ? AND target_index = ? AND seq > ? AND status = 'unknown_outcome'", nowIso(), run.id, step.target_index, step.seq);
      }
      if (ev.found !== null && TERMINAL.includes(run.state)) {
        this.db.run("UPDATE workflow_runs SET state = 'reconciling' WHERE id = ?", run.id);
        await this.aggregate(this.run(run.id), plan);
      }
      report.push({ run_id: run.id, account_id: t.account_id, operation: i.operation, found: ev.found, provider_ref: ev.provider_ref ?? null, run_status: this.run(run.id).state });
    }
    return { examined: rows.length, results: report };
  }

  unknownCount(): number {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM operation_intents WHERE outcome = 'unknown_outcome'")!.n;
  }

  nonterminalCount(): number {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM workflow_runs WHERE state NOT IN ('unsupported', 'succeeded', 'partially_succeeded', 'failed', 'unknown_outcome', 'cancelled')")!.n;
  }

  catalogVersion(): number {
    return CATALOG.version;
  }
}
