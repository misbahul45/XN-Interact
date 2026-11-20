import { join } from "node:path";
import { check, type Finding } from "./check.ts";
import { CHECKPOINTS_PATH, PLAN_DIR, STATUS_PATH, STATUSES, TRANSITIONS, loadModel, type Checkpoint, type Model, type Status, type Task } from "./model.ts";
import { criticalPath, gateSatisfied, phaseState, readyTasks, renderStatus, requirementVerified } from "./report.ts";

const USAGE = `usage:
  bun run plan                      status board
  bun run plan check                consistency check (non-zero exit on errors)
  bun run plan render               regenerate docs/plan/STATUS.md
  bun run plan next                 tasks whose dependencies are verified
  bun run plan show <task-id>       task detail, requirements and history
  bun run plan set <task-id> <STATUS> [--evidence <ref>]... [--note <text>] [--blocker <text>] [--actor agent|owner] [--via chat --quote "<owner's words>"]
statuses: ${STATUSES.join(", ")}`;

function inline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(", ")}}`;
  return JSON.stringify(v);
}

export function formatTasksDoc(doc: Record<string, unknown>, tasks: Task[]): string {
  const head = Object.entries(doc)
    .filter(([k]) => k !== "tasks")
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${inline(v)}`);
  const body: string[] = [];
  tasks.forEach((t, i) => {
    if (i > 0 && tasks[i - 1]?.phase !== t.phase) body.push("");
    body.push(`    ${inline(t)}${i < tasks.length - 1 ? "," : ""}`);
  });
  return `{\n${head.join(",\n")},\n  "tasks": [\n${body.join("\n")}\n  ]\n}\n`;
}

function print(findings: Finding[]): void {
  for (const f of findings) console.error(`${f.level === "error" ? "ERROR" : "warn "} ${f.code.padEnd(24)} ${f.where}: ${f.message}`);
}

function board(m: Model): void {
  const verified = m.tasks.filter((t) => t.status === "VERIFIED").length;
  const must = m.requirements.filter((r) => r.priority === "MUST");
  console.log(`XN-Interact plan: ${verified}/${m.tasks.length} tasks verified, MUST ${must.filter((r) => requirementVerified(m, r)).length}/${must.length}`);
  for (const p of [...m.phases].sort((a, b) => a.order - b.order)) {
    const ts = m.tasks.filter((t) => t.phase === p.id);
    const v = ts.filter((t) => t.status === "VERIFIED").length;
    const bar = "#".repeat(Math.round((v / ts.length) * 20)).padEnd(20, ".");
    console.log(`  ${p.id.padEnd(4)} [${bar}] ${String(v).padStart(2)}/${String(ts.length).padEnd(2)} ${phaseState(m, p).padEnd(11)} gate ${gateSatisfied(m, p) ? "passed" : "open  "} ${p.title}`);
  }
  const ready = readyTasks(m);
  console.log(`\nready (${ready.length}): ${ready.map((t) => t.id).join(" ")}`);
  const blocked = m.tasks.filter((t) => t.status === "BLOCKED");
  if (blocked.length) console.log(`blocked: ${blocked.map((t) => `${t.id} (${t.blocker})`).join("; ")}`);
  const approvals = m.tasks.filter((t) => t.status === "APPROVAL_REQUESTED");
  if (approvals.length) console.log(`awaiting owner approval: ${approvals.map((t) => t.id).join(" ")}`);
  console.log(`critical path: ${criticalPath(m).length} open tasks`);
}

interface Flags {
  evidence: string[];
  note?: string;
  blocker?: string;
  actor: string;
  via?: string;
  quote?: string;
}

function flags(args: string[]): Flags {
  const out: Flags = { evidence: [], actor: "agent" };
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    const v = args[i + 1];
    if (v === undefined) throw new Error(`missing value for ${k}`);
    if (k === "--evidence") out.evidence.push(v);
    else if (k === "--note") out.note = v;
    else if (k === "--blocker") out.blocker = v;
    else if (k === "--actor") out.actor = v;
    else if (k === "--via") out.via = v;
    else if (k === "--quote") out.quote = v;
    else throw new Error(`unknown flag ${k}`);
    i++;
  }
  return out;
}

async function setStatus(m: Model, id: string, to: Status, rest: string[]): Promise<number> {
  const task = m.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`unknown task ${id}`);
  if (!STATUSES.includes(to)) throw new Error(`unknown status ${to}`);
  const f = flags(rest);
  if (!["agent", "owner"].includes(f.actor)) throw new Error("actor must be agent or owner");
  if (!TRANSITIONS[task.status].includes(to)) throw new Error(`${task.status} -> ${to} is not allowed`);
  if (to === "APPROVED") {
    if (f.actor !== "owner") throw new Error("only the owner can approve");
    if (f.via === "chat") {
      if (!f.quote || f.quote.trim().length < 3) throw new Error("--via chat needs --quote with the owner's exact words");
    } else {
      if (!process.stdin.isTTY) throw new Error("approval needs an interactive terminal, or --via chat --quote \"<owner's exact words>\" for a decision the owner gave in chat");
      const typed = prompt(`Approve ${id} "${task.title}"? Type the task id to confirm:`);
      if (typed?.trim() !== id) throw new Error("approval not confirmed");
    }
  }
  if (to === "BLOCKED" && !f.blocker) throw new Error("BLOCKED needs --blocker");
  if (to === "VERIFIED" && !f.evidence.length && !(task.evidence ?? []).length) throw new Error("VERIFIED needs --evidence");
  const cp: Checkpoint = { at: new Date().toISOString(), task: id, from: task.status, to, actor: f.actor };
  if (f.evidence.length) cp.evidence = f.evidence;
  if (f.note) cp.note = f.note;
  if (f.blocker) cp.blocker = f.blocker;
  if (to === "APPROVED") {
    cp.via = f.via === "chat" ? "chat" : "terminal";
    if (f.via === "chat") {
      cp.quote = f.quote!.trim();
      cp.recorded_by = "agent";
    }
  }
  const updated: Task = { ...task, status: to };
  if (f.evidence.length) updated.evidence = [...new Set([...(task.evidence ?? []), ...f.evidence])];
  if (to === "BLOCKED") updated.blocker = f.blocker;
  else delete updated.blocker;
  const next: Model = { ...m, tasks: m.tasks.map((t) => (t.id === id ? updated : t)), checkpoints: [...m.checkpoints, cp] };
  next.statusMd = renderStatus(next);
  const errors = check(next).filter((x) => x.level === "error");
  if (errors.length) {
    print(errors);
    console.error(`refused: ${id} -> ${to} would leave the plan inconsistent; nothing written`);
    return 1;
  }
  const tasksPath = join(PLAN_DIR, "tasks.json");
  const doc = (await Bun.file(tasksPath).json()) as Record<string, unknown>;
  await Bun.write(tasksPath, formatTasksDoc(doc, next.tasks));
  const cpFile = Bun.file(CHECKPOINTS_PATH);
  const prior = (await cpFile.exists()) ? await cpFile.text() : "";
  await Bun.write(CHECKPOINTS_PATH, `${prior}${JSON.stringify(cp)}\n`);
  await Bun.write(STATUS_PATH, next.statusMd);
  console.log(`${id}: ${task.status} -> ${to} (checkpoint written, STATUS.md rendered)`);
  return 0;
}

function show(m: Model, id: string): void {
  const t = m.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task ${id}`);
  console.log(`${t.id} [${t.status}] ${t.title}\n  phase ${t.phase}, owner ${t.owner}, repo ${t.repo}, approval ${t.approval}`);
  console.log(`  goal: ${t.goal}\n  verify: ${t.verify}`);
  if (t.rollback) console.log(`  rollback: ${t.rollback}`);
  console.log(`  deliverables: ${t.deliverables.join(", ")}`);
  for (const d of t.deps) console.log(`  dep ${d}: ${m.tasks.find((x) => x.id === d)?.status}`);
  for (const r of t.reqs) {
    const req = m.requirements.find((x) => x.id === r);
    console.log(`  req ${r} (${req?.priority}): ${req?.text}`);
  }
  if (t.evidence?.length) console.log(`  evidence: ${t.evidence.join(", ")}`);
  for (const cp of m.checkpoints.filter((c) => c.task === id)) console.log(`  ${cp.at} ${cp.from} -> ${cp.to} by ${cp.actor}${cp.note ? `: ${cp.note}` : ""}`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd = "status", ...rest] = argv;
  const m = await loadModel();
  switch (cmd) {
    case "status":
      board(m);
      return 0;
    case "check": {
      const findings = check(m);
      print(findings);
      const errors = findings.filter((f) => f.level === "error").length;
      console.log(`plan check: ${errors} errors, ${findings.length - errors} warnings, ${m.tasks.length} tasks, ${m.requirements.length} requirements, ${m.catalog.tools.length} tools, ${m.catalog.skills.length} skills, ${m.catalog.workflows.length} workflows`);
      return errors ? 1 : 0;
    }
    case "render":
      await Bun.write(STATUS_PATH, renderStatus(m));
      console.log(`rendered ${STATUS_PATH}`);
      return 0;
    case "next":
      for (const t of readyTasks(m)) console.log(`${t.id.padEnd(7)} ${t.owner.padEnd(12)} ${t.title}`);
      return 0;
    case "show":
      if (!rest[0]) throw new Error("show needs a task id");
      show(m, rest[0]);
      return 0;
    case "set":
      if (!rest[0] || !rest[1]) throw new Error("set needs <task-id> <STATUS>");
      return setStatus(m, rest[0], rest[1] as Status, rest.slice(2));
    default:
      console.log(USAGE);
      return cmd === "help" ? 0 : 2;
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(Bun.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
