import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..", "..");
export const PLAN_DIR = join(ROOT, "plan");
export const STATUS_PATH = join(ROOT, "docs", "plan", "STATUS.md");
export const CHECKPOINTS_PATH = join(PLAN_DIR, "checkpoints.jsonl");

export type Risk = "READ" | "LOCAL_WRITE" | "EXTERNAL_WRITE";
export type Status = "PLAN" | "IN_PROGRESS" | "BLOCKED" | "APPROVAL_REQUESTED" | "APPROVED" | "VERIFIED" | "ARCHIVED";
export type Priority = "MUST" | "SHOULD" | "COULD";

export const STATUSES: readonly Status[] = ["PLAN", "IN_PROGRESS", "BLOCKED", "APPROVAL_REQUESTED", "APPROVED", "VERIFIED", "ARCHIVED"];

export const TRANSITIONS: Record<Status, readonly Status[]> = {
  PLAN: ["IN_PROGRESS", "ARCHIVED"],
  IN_PROGRESS: ["BLOCKED", "APPROVAL_REQUESTED", "VERIFIED", "ARCHIVED"],
  BLOCKED: ["IN_PROGRESS", "APPROVAL_REQUESTED", "ARCHIVED"],
  APPROVAL_REQUESTED: ["APPROVED", "BLOCKED", "ARCHIVED"],
  APPROVED: ["IN_PROGRESS", "VERIFIED", "ARCHIVED"],
  VERIFIED: ["IN_PROGRESS", "ARCHIVED"],
  ARCHIVED: [],
};

export interface Gate {
  text: string;
  requires: string[];
  tasks: string[];
  all_must?: boolean;
}

export interface Phase {
  id: string;
  order: number;
  title: string;
  spec_ref: string;
  goal: string;
  gate: Gate;
  rollback: string;
}

export interface Task {
  id: string;
  phase: string;
  title: string;
  goal: string;
  owner: string;
  repo: string;
  deps: string[];
  reqs: string[];
  deliverables: string[];
  verify: string;
  approval: boolean;
  rollback?: string;
  status: Status;
  evidence?: string[];
  blocker?: string | null;
}

export interface Requirement {
  id: string;
  priority: Priority;
  source: string;
  text: string;
  acceptance: string;
  verify: string[];
}

export interface Checkpoint {
  at: string;
  task: string;
  from: Status;
  to: Status;
  actor: string;
  evidence?: string[];
  note?: string;
  blocker?: string;
  via?: "terminal" | "chat";
  quote?: string;
  recorded_by?: string;
}

export interface Operation {
  id: string;
  scope: string;
  risk: Risk;
  side_effect: string;
  summary: string;
}

export interface ErrorCode {
  code: string;
  category: string;
  retryable: boolean;
  bridge_error_class: string;
  capability_state?: string;
}

export interface ToolRoute {
  kind: string;
  workflow?: string;
  skill?: string;
  operation?: string;
}

export interface Tool {
  n: number;
  name: string;
  spec_name: string;
  risk: Risk;
  approval: string;
  side_effect: string;
  operations: string[];
  modes?: string[];
  route: ToolRoute;
}

export interface Skill {
  id: string;
  version: string;
  operations: string[];
  execution: string;
  workflow: string | null;
  risk: Risk;
  approval: string;
  failure_policy: string;
}

export interface WorkflowStep {
  id: string;
  op?: string[];
  internal?: string;
  children?: string[];
  inherits_approval?: boolean;
}

export interface Workflow {
  id: string;
  risk: Risk;
  steps: WorkflowStep[];
}

export interface SkillRoute {
  match: Record<string, string>;
  skill: string;
  priority: number;
}

export interface Catalog {
  version: number;
  server: { name: string; tool_name_pattern: string; expected_tool_count: number; expected_skill_count: number; home_env: string; transport_default: string };
  providers: string[];
  enums: Record<string, string[]>;
  operations: Operation[];
  error_codes: ErrorCode[];
  tools: Tool[];
  skills: Skill[];
  skill_routes: { operation: string; dimensions: Record<string, string[]>; routes: SkillRoute[] };
  workflows: Workflow[];
  resources: string[];
  prompts: string[];
  migrations: string[];
  tables: { name: string; migration: string; secret: boolean; encrypted_columns: string[] }[];
}

export interface ProviderRow {
  provider: string;
  evidence_task: string;
  spec_reference_urls: string[];
  spec_concern: string;
  fields: Record<string, string>;
  operations: Record<string, string>;
  verified_date: string | null;
  proof_test: string | null;
}

export interface Providers {
  evidence_fields: string[];
  operation_verdicts: string[];
  rows: ProviderRow[];
  conflicts: { id: string; providers: string[]; text: string; resolved_by: string; status: string }[];
}

export interface BridgeStage {
  name: string;
  goal: string;
  capabilities: string[];
  optional_capabilities: string[];
  risk: Risk;
  optional: boolean;
  actions: string[];
}

export interface Bridge {
  bridge_contract: { risks: string[]; outcomes: string[]; evidence_origins: string[]; error_classes: string[]; tools_used: string[] };
  server: string;
  capabilities: { id: string; tools: string[]; cost: string; description: string; degraded: string }[];
  risk_rules: { server: string; tool: string; risk: string }[];
  outcome_map: { run_state: string; outcome: string; error_class: string; note: string }[];
  approval_convention: { authoritative: string; target_template: string; payload_fields: string[]; r1_mode: string };
  evidence_convention: { origin: string };
  domain: {
    name: string;
    skill: string;
    stages: BridgeStage[];
    actions: { name: string; stage: string; risk: string; payload_fields: string[]; safe_when_pending?: boolean }[];
  };
  routing: {
    precedence: string[];
    career_guard_terms: string[];
    provider_terms: string[];
    intents: { key: string; stage: string; terms: string[] }[];
    cases: { text: string; expect: string }[];
  };
}

export interface Model {
  phases: Phase[];
  tasks: Task[];
  requirements: Requirement[];
  verificationMethods: string[];
  checkpoints: Checkpoint[];
  checkpointErrors: string[];
  catalog: Catalog;
  providers: Providers;
  bridge: Bridge;
  statusMd: string | null;
  exists: (relPath: string) => boolean;
}

async function readJson<T>(name: string): Promise<T> {
  return (await Bun.file(join(PLAN_DIR, name)).json()) as T;
}

export function parseCheckpoints(text: string): { checkpoints: Checkpoint[]; errors: string[] } {
  const checkpoints: Checkpoint[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      checkpoints.push(JSON.parse(line) as Checkpoint);
    } catch {
      errors.push(`line ${i + 1} is not valid JSON`);
    }
  });
  return { checkpoints, errors };
}

export async function loadModel(): Promise<Model> {
  const [phases, tasks, reqs, catalog, providers, bridge] = await Promise.all([
    readJson<{ phases: Phase[] }>("phases.json"),
    readJson<{ tasks: Task[] }>("tasks.json"),
    readJson<{ requirements: Requirement[]; verification_methods: Record<string, string> }>("requirements.json"),
    readJson<Catalog>("catalog.json"),
    readJson<Providers>("providers.json"),
    readJson<Bridge>("bridge.json"),
  ]);
  const cpFile = Bun.file(CHECKPOINTS_PATH);
  const cpText = (await cpFile.exists()) ? await cpFile.text() : "";
  const { checkpoints, errors } = parseCheckpoints(cpText);
  const statusFile = Bun.file(STATUS_PATH);
  const statusMd = (await statusFile.exists()) ? await statusFile.text() : null;
  return {
    phases: phases.phases,
    tasks: tasks.tasks,
    requirements: reqs.requirements,
    verificationMethods: Object.keys(reqs.verification_methods),
    checkpoints,
    checkpointErrors: errors,
    catalog,
    providers,
    bridge,
    statusMd,
    exists: (rel) => existsSync(join(ROOT, rel)),
  };
}
