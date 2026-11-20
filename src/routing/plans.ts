import { CATALOG, type Risk } from "../contracts/catalog.ts";
import { canonical, digest } from "../contracts/canonical.ts";
import { GatewayError } from "../contracts/errors.ts";
import { type Db, jsonOr, newId } from "../storage/db.ts";

export interface PlanTarget {
  index: number;
  account_id: string;
  provider: string;
  operation: string;
  workflow: string;
  params: Record<string, unknown>;
  preview?: { text: string; chars: number; limit: number | null };
}

export interface PlanPayload {
  v: 1;
  tool: string;
  skill: string | null;
  workflow: string;
  risk: Risk;
  approval_required: boolean;
  operation: string;
  targets: PlanTarget[];
  excluded: { account_id: string; state: string; reason: string }[];
  content_digest: string | null;
  schedule_at: string | null;
  estimate: { calls: number; cost: number | null; uncertain: boolean };
  catalog_version: number;
}

export interface StoredPlan {
  id: string;
  plan_hash: string;
  payload: PlanPayload;
  created_at: string;
  expires_at: string;
}

export const PLAN_TTL_MS = 3600_000;

export function planHash(p: PlanPayload): string {
  return digest(canonical(p));
}

export class Plans {
  constructor(private readonly db: Db) {}

  create(p: Omit<PlanPayload, "v" | "catalog_version">): StoredPlan {
    const payload: PlanPayload = { v: 1, catalog_version: CATALOG.version, ...p };
    const id = newId("pln");
    const hash = planHash(payload);
    const created = Date.now();
    const due = payload.schedule_at ? Date.parse(payload.schedule_at) : 0;
    const expires = new Date(Math.max(created + PLAN_TTL_MS, due + PLAN_TTL_MS)).toISOString();
    this.db.run("INSERT INTO execution_plans(id, plan_hash, tool, skill, workflow, risk, approval_required, payload_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, hash, payload.tool, payload.skill, payload.workflow, payload.risk, payload.approval_required ? 1 : 0, canonical(payload), new Date(created).toISOString(), expires);
    return { id, plan_hash: hash, payload, created_at: new Date(created).toISOString(), expires_at: expires };
  }

  get(id: string): StoredPlan {
    const r = this.db.get<{ id: string; plan_hash: string; payload_json: string; created_at: string; expires_at: string }>("SELECT * FROM execution_plans WHERE id = ?", id);
    if (!r) throw new GatewayError("VALIDATION_FAILED", `unknown plan ${id}`);
    const payload = jsonOr<PlanPayload | null>(r.payload_json, null);
    if (!payload || planHash(payload) !== r.plan_hash) throw new GatewayError("PLAN_CHANGED", "stored plan no longer matches its hash", { actionable_next_step: "Create a new plan" });
    return { id: r.id, plan_hash: r.plan_hash, payload, created_at: r.created_at, expires_at: r.expires_at };
  }

  expired(p: StoredPlan): boolean {
    return Date.parse(p.expires_at) < Date.now();
  }

}
