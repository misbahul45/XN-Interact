import raw from "../../plan/catalog.json" with { type: "json" };

export type Risk = "READ" | "LOCAL_WRITE" | "EXTERNAL_WRITE";

export interface CatalogOperation {
  id: string;
  scope: "local" | "provider";
  risk: Risk;
  side_effect: string;
  summary: string;
}

export interface CatalogErrorCode {
  code: string;
  category: string;
  retryable: boolean;
  bridge_error_class: string;
  capability_state?: string;
}

export interface CatalogTool {
  n: number;
  name: string;
  spec_name: string;
  risk: Risk;
  approval: "none" | "required" | "per_skill";
  side_effect: string;
  operations: string[];
  modes?: string[];
  route: { kind: string; workflow?: string; skill?: string; operation?: string };
}

export interface CatalogSkill {
  id: string;
  version: string;
  operations: string[];
  execution: "direct" | "workflow";
  workflow: string | null;
  risk: Risk;
  approval: "none" | "required";
  failure_policy: string;
}

export interface CatalogStep {
  id: string;
  op?: string[];
  internal?: string;
  children?: string[];
  inherits_approval?: boolean;
}

export interface CatalogWorkflow {
  id: string;
  risk: Risk;
  steps: CatalogStep[];
}

export interface Catalog {
  version: number;
  server: { name: string; tool_name_pattern: string; expected_tool_count: number; expected_skill_count: number; home_env: string; transport_default: string };
  providers: string[];
  enums: Record<string, string[]>;
  operations: CatalogOperation[];
  error_codes: CatalogErrorCode[];
  tools: CatalogTool[];
  skills: CatalogSkill[];
  skill_routes: { operation: string; dimensions: Record<string, string[]>; routes: { match: Record<string, string>; skill: string; priority: number }[] };
  workflows: CatalogWorkflow[];
  resources: string[];
  prompts: string[];
  migrations: string[];
  tables: { name: string; migration: string; secret: boolean; encrypted_columns: string[] }[];
}

export const CATALOG = raw as unknown as Catalog;

export const RISK_RANK: Record<Risk, number> = { READ: 0, LOCAL_WRITE: 1, EXTERNAL_WRITE: 2 };

export function enumValues(name: string): readonly string[] {
  const v = CATALOG.enums[name];
  if (!v) throw new Error(`catalog enum ${name} missing`);
  return v;
}

export function operation(id: string): CatalogOperation {
  const op = CATALOG.operations.find((o) => o.id === id);
  if (!op) throw new Error(`unknown operation ${id}`);
  return op;
}

export function tool(name: string): CatalogTool {
  const t = CATALOG.tools.find((x) => x.name === name);
  if (!t) throw new Error(`unknown tool ${name}`);
  return t;
}

export function skill(id: string): CatalogSkill | undefined {
  return CATALOG.skills.find((s) => s.id === id);
}

export function workflow(id: string): CatalogWorkflow | undefined {
  return CATALOG.workflows.find((w) => w.id === id);
}

export function workflowOperations(id: string, seen = new Set<string>()): string[] {
  const wf = workflow(id);
  if (!wf || seen.has(id)) return [];
  seen.add(id);
  return wf.steps.flatMap((s) => [...(s.op ?? []), ...(s.children ?? []).flatMap((c) => workflowOperations(c, seen))]);
}

export const PROVIDERS = CATALOG.providers;
export const OUTPUT_PROFILES = ["compact", "standard", "detailed"] as const;
export type OutputProfile = (typeof OUTPUT_PROFILES)[number];
