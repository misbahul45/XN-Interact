import { renderStatus } from "./report.ts";
import { STATUSES, TRANSITIONS, type Model, type Risk, type Status, type Task, type Workflow } from "./model.ts";

export interface Finding {
  level: "error" | "warning";
  code: string;
  where: string;
  message: string;
}

const RISK_RANK: Record<Risk, number> = { READ: 0, LOCAL_WRITE: 1, EXTERNAL_WRITE: 2 };

function dupes(values: string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const v of values) (seen.has(v) ? out : seen).add(v);
  return [...out];
}

function maxRisk(risks: Risk[]): Risk {
  return risks.reduce<Risk>((a, b) => (RISK_RANK[b] > RISK_RANK[a] ? b : a), "READ");
}

export function routeMatches(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  const tokens = new Set(lower.split(/[^a-z0-9.]+/).filter(Boolean));
  return terms.some((t) => (/[ .]/.test(t) ? lower.includes(t) : tokens.has(t)));
}

export function referenceRoute(bridge: Model["bridge"], text: string): string {
  const r = bridge.routing;
  if (routeMatches(text, r.career_guard_terms)) return "career";
  if (!routeMatches(text, r.provider_terms)) return "none";
  return r.intents.find((i) => routeMatches(text, i.terms))?.key ?? "social.inspect";
}

export function check(m: Model): Finding[] {
  const out: Finding[] = [];
  const err = (code: string, where: string, message: string) => out.push({ level: "error", code, where, message });
  const warn = (code: string, where: string, message: string) => out.push({ level: "warning", code, where, message });

  const phaseById = new Map(m.phases.map((p) => [p.id, p]));
  const taskById = new Map(m.tasks.map((t) => [t.id, t]));
  const reqById = new Map(m.requirements.map((r) => [r.id, r]));
  const c = m.catalog;
  const enums = c.enums;
  const en = (name: string): string[] => enums[name] ?? [];

  for (const d of dupes(m.phases.map((p) => p.id))) err("DUPLICATE_ID", `phase ${d}`, "phase id repeated");
  for (const d of dupes(m.phases.map((p) => String(p.order)))) err("DUPLICATE_ORDER", `phase order ${d}`, "phase order repeated");
  for (const d of dupes(m.tasks.map((t) => t.id))) err("DUPLICATE_ID", `task ${d}`, "task id repeated");
  for (const d of dupes(m.requirements.map((r) => r.id))) err("DUPLICATE_ID", `requirement ${d}`, "requirement id repeated");

  const orderOf = (phaseId: string) => phaseById.get(phaseId)?.order ?? Number.POSITIVE_INFINITY;
  const coverage = new Map<string, Task[]>();
  for (const t of m.tasks) for (const r of t.reqs) coverage.set(r, [...(coverage.get(r) ?? []), t]);

  for (const r of m.requirements) {
    if (!["MUST", "SHOULD", "COULD"].includes(r.priority)) err("BAD_ENUM", r.id, `priority ${r.priority}`);
    if (!r.verify.length) err("NO_VERIFICATION", r.id, "requirement has no verification method");
    for (const v of r.verify) if (!m.verificationMethods.includes(v)) err("BAD_ENUM", r.id, `verification method ${v}`);
    if (!coverage.has(r.id)) err("UNCOVERED_REQUIREMENT", r.id, `${r.priority} requirement has no task`);
  }

  const verified = (id: string) => taskById.get(id)?.status === "VERIFIED";
  const owners = ["agent", "owner", "owner+agent"];
  const repos = ["xn-interact", "xn-bridge", "host", "provider"];

  for (const t of m.tasks) {
    const where = `task ${t.id}`;
    if (!phaseById.has(t.phase)) err("UNKNOWN_PHASE", where, `phase ${t.phase}`);
    if (!t.id.startsWith(`${t.phase}-`)) err("ID_PHASE_MISMATCH", where, `id does not start with ${t.phase}-`);
    if (!owners.includes(t.owner)) err("BAD_ENUM", where, `owner ${t.owner}`);
    if (!repos.includes(t.repo)) err("BAD_ENUM", where, `repo ${t.repo}`);
    if (!STATUSES.includes(t.status)) err("BAD_ENUM", where, `status ${t.status}`);
    if (!t.goal || !t.verify || !t.title) err("MISSING_FIELD", where, "title, goal and verify are required");
    if (!t.deliverables.length) err("MISSING_FIELD", where, "no deliverables");
    for (const d of t.deps) {
      const dep = taskById.get(d);
      if (!dep) err("UNKNOWN_DEPENDENCY", where, d);
      else if (d === t.id) err("SELF_DEPENDENCY", where, d);
      else if (orderOf(dep.phase) > orderOf(t.phase)) err("PHASE_ORDER", where, `depends on later-phase task ${d}`);
    }
    for (const r of t.reqs) if (!reqById.has(r)) err("UNKNOWN_REQUIREMENT", where, r);
    if ((t.approval || t.repo === "host") && !t.rollback) err("MISSING_ROLLBACK", where, "approval-gated or host task needs a rollback");
    const active: Status[] = ["IN_PROGRESS", "APPROVAL_REQUESTED", "APPROVED", "VERIFIED"];
    if (active.includes(t.status)) {
      const unmet = t.deps.filter((d) => !verified(d));
      if (unmet.length) err("DEPENDENCY_VIOLATION", where, `${t.status} before ${unmet.join(", ")} verified`);
    }
    if (t.status === "VERIFIED" && !(t.evidence ?? []).length) err("MISSING_EVIDENCE", where, "VERIFIED without evidence");
    if (t.status === "BLOCKED" && !t.blocker) err("MISSING_BLOCKER", where, "BLOCKED without blocker");
    if (t.status !== "BLOCKED" && t.blocker) warn("STALE_BLOCKER", where, "blocker set on a task that is not BLOCKED");
    if ((t.status === "APPROVAL_REQUESTED" || t.status === "APPROVED") && !t.approval) err("APPROVAL_NOT_REQUIRED", where, `${t.status} on a task without approval`);
    if (t.status === "VERIFIED" && t.repo === "xn-interact") {
      for (const d of t.deliverables) {
        if (/[#<~ ]/.test(d)) continue;
        if (!m.exists(d.replace(/\/$/, ""))) err("MISSING_DELIVERABLE", where, d);
      }
    }
  }

  const state = new Map<string, number>();
  const visit = (id: string, stack: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      err("DEPENDENCY_CYCLE", `task ${id}`, [...stack, id].join(" -> "));
      return;
    }
    state.set(id, 1);
    for (const d of taskById.get(id)?.deps ?? []) if (taskById.has(d)) visit(d, [...stack, id]);
    state.set(id, 2);
  };
  for (const t of m.tasks) visit(t.id, []);

  const maxOrder = Math.max(...m.phases.map((p) => p.order));
  for (const p of m.phases) {
    const where = `phase ${p.id}`;
    if (!m.tasks.some((t) => t.phase === p.id)) err("EMPTY_PHASE", where, "phase has no tasks");
    for (const r of p.gate.requires) {
      if (!reqById.has(r)) err("UNKNOWN_REQUIREMENT", where, `gate requires ${r}`);
      for (const t of coverage.get(r) ?? []) {
        if (orderOf(t.phase) > p.order) err("GATE_UNSATISFIABLE", where, `${r} is also covered by later task ${t.id}`);
      }
    }
    for (const g of p.gate.tasks) {
      const t = taskById.get(g);
      if (!t) err("UNKNOWN_TASK", where, `gate task ${g}`);
      else if (orderOf(t.phase) > p.order) err("GATE_UNSATISFIABLE", where, `gate task ${g} is in a later phase`);
    }
    if (p.order === maxOrder && !p.gate.all_must) err("RELEASE_GATE", where, "the last phase gate must require all MUST requirements");
  }

  for (const e of m.checkpointErrors) err("BAD_CHECKPOINT", "checkpoints.jsonl", e);
  const history = new Map<string, Status[]>();
  let lastAt = "";
  m.checkpoints.forEach((cp, i) => {
    const where = `checkpoint ${i + 1} (${cp.task})`;
    if (!taskById.has(cp.task)) err("UNKNOWN_TASK", where, cp.task);
    if (!cp.at || Number.isNaN(Date.parse(cp.at))) err("BAD_CHECKPOINT", where, "invalid timestamp");
    if (cp.at < lastAt) err("BAD_CHECKPOINT", where, "timestamps out of order");
    lastAt = cp.at;
    const seq = history.get(cp.task) ?? ["PLAN"];
    const current = seq[seq.length - 1] ?? "PLAN";
    if (cp.from !== current) err("BAD_TRANSITION", where, `from ${cp.from} but task was ${current}`);
    if (!TRANSITIONS[cp.from]?.includes(cp.to)) err("BAD_TRANSITION", where, `${cp.from} -> ${cp.to} is not allowed`);
    if (cp.to === "APPROVED" && cp.actor !== "owner") err("SELF_APPROVAL", where, "only the owner can approve");
    if (cp.to === "APPROVED" && cp.via === "chat" && !(cp.quote && cp.quote.trim().length >= 3)) err("CHAT_APPROVAL_WITHOUT_QUOTE", where, "a chat-recorded approval must quote the owner");
    if (cp.to === "VERIFIED" && !(cp.evidence ?? []).length) err("MISSING_EVIDENCE", where, "VERIFIED checkpoint without evidence");
    if (cp.to === "VERIFIED" && taskById.get(cp.task)?.approval && !seq.includes("APPROVED")) err("UNAPPROVED_VERIFY", where, "approval-gated task verified without APPROVED");
    history.set(cp.task, [...seq, cp.to]);
  });
  for (const t of m.tasks) {
    const seq = history.get(t.id);
    const last = seq ? seq[seq.length - 1] : "PLAN";
    if (last !== t.status) err("CHECKPOINT_DRIFT", `task ${t.id}`, `tasks.json says ${t.status}, checkpoints say ${last}`);
  }

  const opById = new Map(c.operations.map((o) => [o.id, o]));
  const sideRank = (s: string) => en("side_effect").indexOf(s);
  const maxSide = (sides: string[]) => sides.reduce((a, b) => (sideRank(b) > sideRank(a) ? b : a), "none");
  const wfById = new Map(c.workflows.map((w) => [w.id, w]));
  const skillById = new Map(c.skills.map((s) => [s.id, s]));
  const pattern = new RegExp(c.server.tool_name_pattern);

  for (const d of dupes(c.operations.map((o) => o.id))) err("DUPLICATE_ID", `operation ${d}`, "operation repeated");
  for (const o of c.operations) {
    if (!en("risk_class").includes(o.risk)) err("BAD_ENUM", `operation ${o.id}`, `risk ${o.risk}`);
    if (!en("side_effect").includes(o.side_effect)) err("BAD_ENUM", `operation ${o.id}`, `side_effect ${o.side_effect}`);
    if (!en("operation_scope").includes(o.scope)) err("BAD_ENUM", `operation ${o.id}`, `scope ${o.scope}`);
    if ((o.risk === "EXTERNAL_WRITE") !== ["public_write", "destructive", "provider_private"].includes(o.side_effect)) {
      err("RISK_SIDE_EFFECT_MISMATCH", `operation ${o.id}`, `${o.risk} with ${o.side_effect}`);
    }
    if (o.risk === "EXTERNAL_WRITE" && o.scope !== "provider") err("RISK_SCOPE_MISMATCH", `operation ${o.id}`, "external writes must be provider-scoped");
  }

  const wfOps = (id: string, seen = new Set<string>()): string[] => {
    const wf = wfById.get(id);
    if (!wf || seen.has(id)) return [];
    seen.add(id);
    return wf.steps.flatMap((s) => [...(s.op ?? []), ...(s.children ?? []).flatMap((ch) => wfOps(ch, seen))]);
  };
  const opsRisk = (ops: string[]) => maxRisk(ops.map((o) => opById.get(o)?.risk ?? "EXTERNAL_WRITE"));

  if (c.tools.length !== c.server.expected_tool_count) err("TOOL_COUNT", "catalog", `${c.tools.length} tools, expected ${c.server.expected_tool_count}`);
  for (const d of dupes(c.tools.map((t) => t.name))) err("DUPLICATE_ID", `tool ${d}`, "tool name repeated");
  c.tools.forEach((t, i) => {
    const where = `tool ${t.name}`;
    if (t.n !== i + 1) err("TOOL_NUMBERING", where, `n=${t.n} at position ${i + 1}`);
    if (!pattern.test(t.name)) err("TOOL_NAME", where, `does not match ${c.server.tool_name_pattern}`);
    if (t.spec_name.replaceAll(".", "_") !== t.name) err("TOOL_NAME", where, `spec_name ${t.spec_name} does not map to the wire name`);
    if (/confirm|_approve$|_grant$/.test(t.name)) err("SELF_APPROVAL_TOOL", where, "approval must not be grantable through a tool");
    if (t.name.includes("approv") && t.risk !== "READ") err("SELF_APPROVAL_TOOL", where, "approval tools must be read-only");
    for (const o of t.operations) if (!opById.has(o)) err("UNKNOWN_OPERATION", where, o);
    if (!en("approval_policy").includes(t.approval)) err("BAD_ENUM", where, `approval ${t.approval}`);
    if (!en("route_kind").includes(t.route.kind)) err("BAD_ENUM", where, `route ${t.route.kind}`);
    let expectedRisk: Risk;
    let expectedSide: string;
    if (t.route.kind === "caller_skill") {
      if (t.operations.length) err("ROUTE_SHAPE", where, "caller_skill tools declare no operations");
      if (t.approval !== "per_skill") err("APPROVAL_POLICY", where, "caller_skill tools use per_skill approval");
      expectedRisk = maxRisk(c.skills.map((s) => s.risk));
      expectedSide = maxSide(c.skills.flatMap((s) => s.operations.map((o) => opById.get(o)?.side_effect ?? "destructive")));
    } else {
      if (!t.operations.length) err("ROUTE_SHAPE", where, "tool declares no operations");
      expectedRisk = opsRisk(t.operations);
      expectedSide = maxSide(t.operations.map((o) => opById.get(o)?.side_effect ?? "destructive"));
    }
    if (t.risk !== expectedRisk) err("RISK_MISMATCH", where, `risk ${t.risk}, operations imply ${expectedRisk}`);
    if (t.side_effect !== expectedSide) err("SIDE_EFFECT_MISMATCH", where, `side_effect ${t.side_effect}, operations imply ${expectedSide}`);
    if (t.risk === "EXTERNAL_WRITE") {
      if (t.approval === "none") err("APPROVAL_POLICY", where, "external write without approval");
      if ((t.modes ?? []).join(",") !== "plan,execute") err("TWO_PHASE", where, "external write tools need modes plan and execute");
      if (t.route.kind === "direct") err("DIRECT_EXTERNAL_WRITE", where, "external writes must run through a workflow");
    } else {
      if (t.approval !== "none") err("APPROVAL_POLICY", where, "only external writes need approval");
      if (t.modes?.length) err("TWO_PHASE", where, "only external writes are two-phase");
    }
    const subset = (ops: string[], within: string[], target: string) => {
      const missing = ops.filter((o) => !within.includes(o));
      if (missing.length) err("ROUTE_COVERAGE", where, `${target} lacks ${missing.join(", ")}`);
    };
    if (t.route.kind === "workflow") {
      if (!t.route.workflow || !wfById.has(t.route.workflow)) err("UNKNOWN_WORKFLOW", where, String(t.route.workflow));
      else subset(t.operations, wfOps(t.route.workflow), t.route.workflow);
    }
    if (t.route.kind === "skill") {
      const s = t.route.skill ? skillById.get(t.route.skill) : undefined;
      if (!s) err("UNKNOWN_SKILL", where, String(t.route.skill));
      else subset(t.operations, s.operations, s.id);
    }
    if (t.route.kind === "skill_map") {
      if (t.route.operation !== c.skill_routes.operation) err("UNKNOWN_SKILL_MAP", where, String(t.route.operation));
      const union = c.skill_routes.routes.flatMap((r) => skillById.get(r.skill)?.operations ?? []);
      subset(t.operations, union, "skill_routes");
    }
  });

  if (c.skills.length !== c.server.expected_skill_count) err("SKILL_COUNT", "catalog", `${c.skills.length} skills, expected ${c.server.expected_skill_count}`);
  for (const d of dupes(c.skills.map((s) => s.id))) err("DUPLICATE_ID", `skill ${d}`, "skill repeated");
  for (const s of c.skills) {
    const where = `skill ${s.id}`;
    if (!/^\d+\.\d+\.\d+$/.test(s.version)) err("BAD_VERSION", where, s.version);
    if (!s.operations.length) err("ROUTE_SHAPE", where, "skill declares no operations");
    for (const o of s.operations) if (!opById.has(o)) err("UNKNOWN_OPERATION", where, o);
    const implied = opsRisk(s.operations);
    if (RISK_RANK[s.risk] < RISK_RANK[implied]) err("RISK_MISMATCH", where, `risk ${s.risk} below operations ${implied}`);
    if ((implied === "EXTERNAL_WRITE") !== (s.approval === "required")) err("APPROVAL_POLICY", where, "approval required exactly when an operation is an external write");
    if (!en("skill_execution").includes(s.execution)) err("BAD_ENUM", where, `execution ${s.execution}`);
    if (s.execution === "workflow") {
      const wf = s.workflow ? wfById.get(s.workflow) : undefined;
      if (!wf) err("UNKNOWN_WORKFLOW", where, String(s.workflow));
      else {
        if (wf.risk !== s.risk) err("RISK_MISMATCH", where, `skill ${s.risk} but workflow ${wf.risk}`);
        const missing = s.operations.filter((o) => !wfOps(wf.id).includes(o));
        if (missing.length) err("ROUTE_COVERAGE", where, `${wf.id} lacks ${missing.join(", ")}`);
      }
    } else {
      if (s.workflow) err("ROUTE_SHAPE", where, "direct skills have no workflow");
      if (s.risk === "EXTERNAL_WRITE") err("DIRECT_EXTERNAL_WRITE", where, "external writes must run through a workflow");
    }
  }

  const referenced = new Set<string>([
    ...c.tools.flatMap((t) => (t.route.workflow ? [t.route.workflow] : [])),
    ...c.skills.flatMap((s) => (s.workflow ? [s.workflow] : [])),
    ...c.workflows.flatMap((w) => w.steps.flatMap((s) => s.children ?? [])),
  ]);
  for (const d of dupes(c.workflows.map((w) => w.id))) err("DUPLICATE_ID", `workflow ${d}`, "workflow repeated");
  const checkWorkflow = (w: Workflow) => {
    const where = `workflow ${w.id}`;
    if (!/^[a-z][a-z0-9_.]*@\d+$/.test(w.id)) err("BAD_VERSION", where, "id must be name@version");
    if (!referenced.has(w.id)) err("UNREFERENCED_WORKFLOW", where, "no tool, skill or fanout uses it");
    for (const d of dupes(w.steps.map((s) => s.id))) err("DUPLICATE_ID", where, `step ${d}`);
    const ops = wfOps(w.id);
    const implied = opsRisk(ops);
    if (RISK_RANK[w.risk] < RISK_RANK[implied]) err("RISK_MISMATCH", where, `risk ${w.risk} below operations ${implied}`);
    if (w.risk === "EXTERNAL_WRITE" && implied !== "EXTERNAL_WRITE") err("RISK_MISMATCH", where, "declared EXTERNAL_WRITE without an external operation");
    w.steps.forEach((s, i) => {
      const at = `${where} step ${s.id}`;
      if (Boolean(s.op) === Boolean(s.internal)) err("STEP_SHAPE", at, "a step has exactly one of op or internal");
      if (s.internal && !en("internal_step").includes(s.internal)) err("BAD_ENUM", at, `internal ${s.internal}`);
      for (const o of s.op ?? []) if (!opById.has(o)) err("UNKNOWN_OPERATION", at, o);
      const before = w.steps.slice(0, i);
      const after = w.steps.slice(i + 1);
      const gated = before.some((b) => b.internal === "approval_gate");
      if ((s.op ?? []).some((o) => opById.get(o)?.risk === "EXTERNAL_WRITE")) {
        if (!gated) err("UNGATED_WRITE", at, "external write without an earlier approval_gate");
        if (before[before.length - 1]?.internal !== "journal_intent") err("UNJOURNALED_WRITE", at, "external write not immediately preceded by journal_intent");
        if (!after.some((a) => a.op?.includes("reconcile.read"))) err("UNRECONCILED_WRITE", at, "external write without a later reconcile.read");
      }
      if (s.internal === "fanout") {
        if (!s.children?.length) err("STEP_SHAPE", at, "fanout without children");
        for (const ch of s.children ?? []) {
          if (!wfById.has(ch)) err("UNKNOWN_WORKFLOW", at, ch);
          if (ch === w.id) err("DEPENDENCY_CYCLE", at, "fanout includes itself");
        }
        if (s.inherits_approval && !gated) err("UNGATED_WRITE", at, "inherited approval needs an earlier approval_gate");
      }
    });
  };
  c.workflows.forEach(checkWorkflow);

  const sr = c.skill_routes;
  if (!c.operations.some((o) => o.id.startsWith(`${sr.operation}.`))) err("UNKNOWN_SKILL_MAP", "skill_routes", `no operation family ${sr.operation}`);
  const dims = Object.entries(sr.dimensions);
  for (const r of sr.routes) {
    if (!skillById.has(r.skill)) err("UNKNOWN_SKILL", "skill_routes", r.skill);
    for (const [k, v] of Object.entries(r.match)) {
      const allowed = sr.dimensions[k];
      if (!allowed) err("BAD_ROUTE", "skill_routes", `unknown dimension ${k}`);
      else if (v !== "*" && !allowed.includes(v)) err("BAD_ROUTE", "skill_routes", `${k}=${v}`);
    }
  }
  const combos = dims.reduce<Record<string, string>[]>((acc, [k, vals]) => acc.flatMap((a) => vals.map((v) => ({ ...a, [k]: v }))), [{}]);
  for (const combo of combos) {
    const key = Object.entries(combo).map(([k, v]) => `${k}=${v}`).join(",");
    const hits = sr.routes
      .filter((r) => dims.every(([k]) => (r.match[k] ?? "*") === "*" || r.match[k] === combo[k]))
      .map((r) => ({ r, score: r.priority * 100 + Object.values(r.match).filter((v) => v !== "*").length }));
    if (!hits.length) {
      err("ROUTE_GAP", "skill_routes", `no skill for ${key}`);
      continue;
    }
    const best = Math.max(...hits.map((h) => h.score));
    const winners = new Set(hits.filter((h) => h.score === best).map((h) => h.r.skill));
    if (winners.size > 1) err("AMBIGUOUS_SKILL", "skill_routes", `${key} -> ${[...winners].join(" | ")}`);
  }

  for (const d of dupes(c.error_codes.map((e) => e.code))) err("DUPLICATE_ID", `error ${d}`, "error code repeated");
  for (const e of c.error_codes) {
    if (!en("error_category").includes(e.category)) err("BAD_ENUM", `error ${e.code}`, `category ${e.category}`);
    if (!m.bridge.bridge_contract.error_classes.includes(e.bridge_error_class)) err("BAD_ENUM", `error ${e.code}`, `bridge_error_class ${e.bridge_error_class}`);
    if (e.capability_state && !en("capability_state").includes(e.capability_state)) err("BAD_ENUM", `error ${e.code}`, `capability_state ${e.capability_state}`);
  }
  for (const s of en("capability_state").filter((s) => s !== "AVAILABLE")) {
    const n = c.error_codes.filter((e) => e.capability_state === s).length;
    if (n !== 1) err("CAPABILITY_ERROR_MAP", `capability_state ${s}`, `${n} error codes map to it, expected 1`);
  }
  for (const s of en("run_terminal")) if (!en("run_state").includes(s)) err("BAD_ENUM", "run_terminal", s);

  for (const d of dupes(c.resources)) err("DUPLICATE_ID", `resource ${d}`, "resource repeated");
  for (const r of c.resources) if (!r.startsWith("social://")) err("RESOURCE_SCHEME", `resource ${r}`, "must use social://");
  for (const d of dupes(c.prompts)) err("DUPLICATE_ID", `prompt ${d}`, "prompt repeated");
  for (const p of c.prompts) if (!pattern.test(p)) err("PROMPT_NAME", `prompt ${p}`, "must match the tool name pattern");
  for (const d of dupes(c.tables.map((t) => t.name))) err("DUPLICATE_ID", `table ${d}`, "table repeated");
  for (const t of c.tables) {
    if (!c.migrations.includes(t.migration)) err("UNKNOWN_MIGRATION", `table ${t.name}`, t.migration);
    if (t.secret !== t.encrypted_columns.length > 0) err("ENCRYPTION", `table ${t.name}`, "secret tables need encrypted columns and only they have them");
  }
  for (const mg of c.migrations) if (!c.tables.some((t) => t.migration === mg) && !c.migration_updates?.[mg]?.length) err("EMPTY_MIGRATION", mg, "no table change");
  for (const [mg, names] of Object.entries(c.migration_updates ?? {})) {
    if (!c.migrations.includes(mg)) err("UNKNOWN_MIGRATION", mg, "table update references unknown migration");
    for (const name of names) if (!c.tables.some((t) => t.name === name && c.migrations.indexOf(t.migration) < c.migrations.indexOf(mg))) {
      err("UNKNOWN_TABLE", mg, `table ${name} must already exist`);
    }
  }

  const pv = m.providers;
  const providerOps = c.operations.filter((o) => o.scope === "provider").map((o) => o.id);
  const rows = new Map(pv.rows.map((r) => [r.provider, r]));
  for (const p of c.providers) if (!rows.has(p)) err("MISSING_PROVIDER", `provider ${p}`, "no evidence row");
  for (const r of pv.rows) {
    const where = `provider ${r.provider}`;
    if (!c.providers.includes(r.provider)) err("UNKNOWN_PROVIDER", where, "not in catalog providers");
    const task = taskById.get(r.evidence_task);
    if (!task) err("UNKNOWN_TASK", where, r.evidence_task);
    for (const k of Object.keys(r.fields)) if (!pv.evidence_fields.includes(k)) err("UNKNOWN_FIELD", where, k);
    for (const [op, verdict] of Object.entries(r.operations)) {
      if (!providerOps.includes(op)) err("UNKNOWN_OPERATION", where, op);
      if (!pv.operation_verdicts.includes(verdict)) err("BAD_ENUM", where, `${op}=${verdict}`);
      if (verdict === "VERIFIED" && (!r.verified_date || !r.proof_test)) err("UNPROVEN_VERDICT", where, `${op} VERIFIED without verified_date and proof_test`);
    }
    if (task?.status === "VERIFIED") {
      const missingFields = pv.evidence_fields.filter((f) => !r.fields[f]);
      const missingOps = providerOps.filter((o) => !r.operations[o]);
      if (missingFields.length || missingOps.length || !r.verified_date) {
        err("INCOMPLETE_EVIDENCE", where, `evidence task verified but fields [${missingFields.join(", ")}] ops [${missingOps.join(", ")}] missing`);
      }
    }
  }
  for (const cf of pv.conflicts) {
    const where = `conflict ${cf.id}`;
    for (const p of cf.providers) if (!c.providers.includes(p)) err("UNKNOWN_PROVIDER", where, p);
    const t = taskById.get(cf.resolved_by);
    if (!t) err("UNKNOWN_TASK", where, cf.resolved_by);
    if (cf.status === "RESOLVED" && t?.status !== "VERIFIED") err("UNRESOLVED_CONFLICT", where, `marked RESOLVED but ${cf.resolved_by} is not VERIFIED`);
    if (cf.status === "OPEN" && t?.status === "VERIFIED") warn("UNRESOLVED_CONFLICT", where, `${cf.resolved_by} is VERIFIED but the conflict is still OPEN`);
  }

  const b = m.bridge;
  const toolByName = new Map(c.tools.map((t) => [t.name, t]));
  if (b.server !== c.server.name) err("BRIDGE_SERVER", "bridge", `${b.server} != ${c.server.name}`);
  for (const d of dupes(b.capabilities.map((x) => x.id))) err("DUPLICATE_ID", `bridge capability ${d}`, "repeated");
  const mapped = b.capabilities.flatMap((x) => x.tools);
  for (const x of b.capabilities) {
    if (![b.domain.name, b.data_domain.name].some((name) => x.id.startsWith(`${name}.`))) err("BRIDGE_CAPABILITY", x.id, "unknown capability namespace");
    if (!x.degraded) err("BRIDGE_CAPABILITY", x.id, "degraded behaviour required");
    for (const t of x.tools) if (!toolByName.has(t)) err("UNKNOWN_TOOL", `bridge capability ${x.id}`, t);
  }
  for (const t of c.tools) {
    const n = mapped.filter((x) => x === t.name).length;
    if (n !== 1) err("BRIDGE_MAPPING", `tool ${t.name}`, `mapped by ${n} bridge capabilities, expected 1`);
  }
  const capRisk = (id: string): Risk => maxRisk((b.capabilities.find((x) => x.id === id)?.tools ?? []).map((t) => toolByName.get(t)?.risk ?? "EXTERNAL_WRITE"));
  b.risk_rules.forEach((rule, i) => {
    const isGlob = /[*?[]/.test(rule.tool) || /[*?[]/.test(rule.server);
    if (rule.server !== c.server.name) err("BRIDGE_RISK", `risk rule ${i + 1}`, `server ${rule.server}`);
    if (!b.bridge_contract.risks.includes(rule.risk)) err("BAD_ENUM", `risk rule ${i + 1}`, rule.risk);
    if (isGlob && i !== b.risk_rules.length - 1) err("BRIDGE_RISK", `risk rule ${i + 1}`, "only the final rule may be a glob (first match wins)");
    if (!isGlob) {
      const tool = toolByName.get(rule.tool);
      if (!tool) err("UNKNOWN_TOOL", `risk rule ${i + 1}`, rule.tool);
      else if (tool.risk !== rule.risk) err("BRIDGE_RISK", `risk rule ${rule.tool}`, `${rule.risk} != catalog ${tool.risk}`);
    }
  });
  const last = b.risk_rules[b.risk_rules.length - 1];
  if (!last || last.tool !== "*" || last.risk !== "EXTERNAL_WRITE") err("BRIDGE_RISK", "risk rules", "final rule must be xn-interact:* EXTERNAL_WRITE");
  for (const t of c.tools) {
    const n = b.risk_rules.filter((r) => r.tool === t.name).length;
    if (n !== 1) err("BRIDGE_RISK", `tool ${t.name}`, `${n} specific risk rules, expected 1`);
  }
  const terminal = en("run_terminal");
  for (const s of terminal) if (!b.outcome_map.some((o) => o.run_state === s)) err("OUTCOME_MAP", `run_state ${s}`, "no bridge outcome");
  for (const o of b.outcome_map) {
    if (!terminal.includes(o.run_state)) err("OUTCOME_MAP", o.run_state, "not a terminal run state");
    if (!b.bridge_contract.outcomes.includes(o.outcome)) err("BAD_ENUM", `outcome ${o.run_state}`, o.outcome);
    if (o.error_class !== "FROM_ERROR_CODE" && !b.bridge_contract.error_classes.includes(o.error_class)) err("BAD_ENUM", `outcome ${o.run_state}`, o.error_class);
  }
  const ac = b.approval_convention;
  if (ac.authoritative !== c.server.name) err("APPROVAL_AUTHORITY", "approval_convention", "XN-Interact must stay authoritative for social writes");
  if (!/^https:\/\/[^/]+\/.*\{plan_id\}/.test(ac.target_template)) err("APPROVAL_TARGET", "approval_convention", "target must be an https URL containing {plan_id}");
  for (const f of ["plan_id", "plan_hash"]) if (!ac.payload_fields.includes(f)) err("APPROVAL_PAYLOAD", "approval_convention", `missing ${f}`);
  if (!b.bridge_contract.evidence_origins.includes(b.evidence_convention.origin)) err("BAD_ENUM", "evidence_convention", b.evidence_convention.origin);

  const stageNames = b.domain.stages.map((s) => s.name);
  for (const d of dupes(stageNames)) err("DUPLICATE_ID", `stage ${d}`, "repeated");
  const capIds = new Set(b.capabilities.map((x) => x.id));
  const used = new Set<string>();
  for (const s of [...b.domain.stages, ...b.data_domain.stages]) {
    const where = `bridge stage ${s.name}`;
    const caps = [...s.capabilities, ...s.optional_capabilities];
    for (const cap of caps) {
      used.add(cap);
      if (!capIds.has(cap)) err("UNKNOWN_CAPABILITY", where, cap);
    }
    const implied = maxRisk(caps.map(capRisk));
    if (RISK_RANK[s.risk] < RISK_RANK[implied]) err("STAGE_RISK", where, `risk ${s.risk} below capabilities ${implied}`);
    if (!s.optional && !s.capabilities.length) err("STAGE_SHAPE", where, "required stage needs required capabilities");
    for (const a of s.actions) if (!b.domain.actions.some((x) => x.name === a && x.stage === s.name)) err("STAGE_ACTION", where, `action ${a} not declared for this stage`);
  }
  for (const id of capIds) if (!used.has(id)) err("UNUSED_CAPABILITY", id, "no bridge stage uses it");
  for (const a of b.domain.actions) {
    if (!stageNames.includes(a.stage)) err("UNKNOWN_STAGE", `bridge action ${a.name}`, a.stage);
    if (!b.domain.stages.find((s) => s.name === a.stage)?.actions.includes(a.name)) err("STAGE_ACTION", `bridge action ${a.name}`, "stage does not list it");
    if (!b.bridge_contract.risks.includes(a.risk)) err("BAD_ENUM", `bridge action ${a.name}`, a.risk);
    if (!a.payload_fields.length) err("STAGE_ACTION", `bridge action ${a.name}`, "payload fields required");
  }
  const rt = b.routing;
  if (rt.precedence.indexOf("career") < 0 || rt.precedence.indexOf("career") > rt.precedence.indexOf("social")) err("ROUTING", "precedence", "career must precede social");
  for (const i of rt.intents) if (!stageNames.includes(i.stage)) err("UNKNOWN_STAGE", `intent ${i.key}`, i.stage);
  for (const cs of rt.cases) {
    const got = referenceRoute(b, cs.text);
    if (got !== cs.expect) err("ROUTING_CASE", `"${cs.text}"`, `reference router gives ${got}, expected ${cs.expect}`);
  }

  const rendered = renderStatus(m);
  if (m.statusMd !== rendered) err("STALE_STATUS", "docs/plan/STATUS.md", "run bun run plan:render");

  return out;
}
