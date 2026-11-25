import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { check } from "../../scripts/plan/check.ts";
import { formatTasksDoc } from "../../scripts/plan/cli.ts";
import { PLAN_DIR, loadModel, type Model } from "../../scripts/plan/model.ts";
import { renderStatus } from "../../scripts/plan/report.ts";

const base = await loadModel();

function mutate(fn: (m: Model) => void): Model {
  const m = structuredClone({ ...base, exists: undefined }) as unknown as Model;
  m.exists = base.exists;
  fn(m);
  m.statusMd = renderStatus(m);
  return m;
}

function codes(m: Model): string[] {
  return check(m).filter((f) => f.level === "error").map((f) => f.code);
}

describe("plan data", () => {
  test("is consistent", () => {
    const errors = check(base).filter((f) => f.level === "error");
    expect(errors).toEqual([]);
  });

  test("tasks.json round-trips through the CLI formatter", async () => {
    const path = join(PLAN_DIR, "tasks.json");
    const text = await Bun.file(path).text();
    const doc = JSON.parse(text) as Record<string, unknown>;
    expect(formatTasksDoc(doc, base.tasks)).toBe(text);
  });

  test("catalog sizes match the baseline", () => {
    expect(base.catalog.tools.length).toBe(28);
    expect(base.catalog.skills.length).toBe(14);
    expect(base.catalog.providers.length).toBe(7);
  });
});

describe("checker detects", () => {
  test("dependency cycles", () => {
    const m = mutate((x) => x.tasks.find((t) => t.id === "P0-01")!.deps.push("P0-02"));
    expect(codes(m)).toContain("DEPENDENCY_CYCLE");
  });

  test("dependencies on later phases", () => {
    const m = mutate((x) => x.tasks.find((t) => t.id === "P0-14")!.deps.push("P1-09"));
    expect(codes(m)).toContain("PHASE_ORDER");
  });

  test("uncovered requirements", () => {
    const m = mutate((x) => {
      for (const t of x.tasks) t.reqs = t.reqs.filter((r) => r !== "FLOW-06");
    });
    expect(codes(m)).toContain("UNCOVERED_REQUIREMENT");
  });

  test("gates that a later task can still invalidate", () => {
    const m = mutate((x) => x.tasks.find((t) => t.id === "P8-01")!.reqs.push("AUTH-03"));
    expect(codes(m)).toContain("GATE_UNSATISFIABLE");
  });

  test("starting work before dependencies are verified", () => {
    const m = mutate((x) => {
      x.tasks.find((t) => t.id === "P10-09")!.status = "IN_PROGRESS";
      x.checkpoints.push({ at: "2099-01-01T00:00:00.000Z", task: "P10-09", from: "PLAN", to: "IN_PROGRESS", actor: "agent" });
    });
    expect(codes(m)).toContain("DEPENDENCY_VIOLATION");
  });

  test("agent self-approval in checkpoints", () => {
    const m = mutate((x) => {
      const t = x.tasks.find((y) => y.id === "P0-18")!;
      t.status = "IN_PROGRESS";
      x.checkpoints.push({ at: "2099-01-01T00:00:00.000Z", task: "P0-18", from: "PLAN", to: "IN_PROGRESS", actor: "agent" });
      x.checkpoints.push({ at: "2099-01-01T00:00:01.000Z", task: "P0-18", from: "IN_PROGRESS", to: "APPROVAL_REQUESTED", actor: "agent" });
      x.checkpoints.push({ at: "2099-01-01T00:00:02.000Z", task: "P0-18", from: "APPROVAL_REQUESTED", to: "APPROVED", actor: "agent" });
      t.status = "APPROVED";
    });
    expect(codes(m)).toContain("SELF_APPROVAL");
  });

  test("tracker drifting from checkpoints", () => {
    const m = mutate((x) => {
      x.tasks.find((t) => t.id === "P10-06")!.status = "VERIFIED";
      x.tasks.find((t) => t.id === "P10-06")!.evidence = ["docs/evidence/dependency-audit.md"];
    });
    expect(codes(m)).toContain("CHECKPOINT_DRIFT");
  });

  test("an external-write tool without approval", () => {
    const m = mutate((x) => {
      x.catalog.tools.find((t) => t.name === "social_content_publish")!.approval = "none";
    });
    expect(codes(m)).toContain("APPROVAL_POLICY");
  });

  test("a tool that could grant its own approval", () => {
    const m = mutate((x) => {
      x.catalog.tools.find((t) => t.name === "social_approvals_status")!.name = "social_approvals_confirm";
    });
    expect(codes(m)).toContain("SELF_APPROVAL_TOOL");
  });

  test("a misclassified tool risk", () => {
    const m = mutate((x) => {
      x.catalog.tools.find((t) => t.name === "social_content_delete")!.risk = "LOCAL_WRITE";
    });
    expect(codes(m)).toContain("RISK_MISMATCH");
  });

  test("an external write that skips the intent journal", () => {
    const m = mutate((x) => {
      const wf = x.catalog.workflows.find((w) => w.id === "content.publish@1")!;
      wf.steps = wf.steps.filter((s) => s.internal !== "journal_intent");
    });
    expect(codes(m)).toContain("UNJOURNALED_WRITE");
  });

  test("an external write without an approval gate", () => {
    const m = mutate((x) => {
      const wf = x.catalog.workflows.find((w) => w.id === "content.mutate@1")!;
      wf.steps = wf.steps.filter((s) => s.internal !== "approval_gate");
    });
    expect(codes(m)).toContain("UNGATED_WRITE");
  });

  test("ambiguous skill routes", () => {
    const m = mutate((x) => {
      x.catalog.skill_routes.routes.push({ match: { media_kind: "text", target_count: "one", scheduled: "no" }, skill: "content.publish.many", priority: 10 });
    });
    expect(codes(m)).toContain("AMBIGUOUS_SKILL");
  });

  test("skill route gaps", () => {
    const m = mutate((x) => {
      x.catalog.skill_routes.routes = x.catalog.skill_routes.routes.filter((r) => r.skill !== "content.publish.one");
    });
    expect(codes(m)).toContain("ROUTE_GAP");
  });

  test("bridge risk rules that disagree with the catalog", () => {
    const m = mutate((x) => {
      x.bridge.risk_rules.find((r) => r.tool === "social_content_publish")!.risk = "READ";
    });
    expect(codes(m)).toContain("BRIDGE_RISK");
  });

  test("a missing fail-closed bridge default", () => {
    const m = mutate((x) => {
      x.bridge.risk_rules.pop();
    });
    expect(codes(m)).toContain("BRIDGE_RISK");
  });

  test("an unmapped tool in the bridge capabilities", () => {
    const m = mutate((x) => {
      x.bridge.capabilities = x.bridge.capabilities.filter((c) => c.id !== "social.search");
      for (const s of x.bridge.domain.stages) s.optional_capabilities = s.optional_capabilities.filter((c) => c !== "social.search");
    });
    expect(codes(m)).toContain("BRIDGE_MAPPING");
  });

  test("bridge approvals becoming authoritative", () => {
    const m = mutate((x) => {
      x.bridge.approval_convention.authoritative = "xn-bridge";
    });
    expect(codes(m)).toContain("APPROVAL_AUTHORITY");
  });

  test("career requests routed to social", () => {
    const m = mutate((x) => {
      x.bridge.routing.career_guard_terms = [];
    });
    expect(codes(m)).toContain("ROUTING_CASE");
  });

  test("an error code with an unknown bridge error class", () => {
    const m = mutate((x) => {
      x.catalog.error_codes[0]!.bridge_error_class = "SOMETHING";
    });
    expect(codes(m)).toContain("BAD_ENUM");
  });

  test("a verified provider operation without proof", () => {
    const m = mutate((x) => {
      x.providers.rows[0]!.operations["content.publish.text"] = "VERIFIED";
    });
    expect(codes(m)).toContain("UNPROVEN_VERDICT");
  });

  test("a stale STATUS.md", () => {
    const m = mutate(() => {});
    m.statusMd = "stale";
    expect(codes(m)).toContain("STALE_STATUS");
  });
});

describe("chat-recorded owner decisions", () => {
  test("need the owner's quoted words", () => {
    const m = mutate((x) => {
      const t = x.tasks.find((y) => y.id === "P10-06")!;
      t.approval = true;
      t.rollback = "none";
      t.status = "APPROVED";
      x.checkpoints.push({ at: "2099-01-01T00:00:00.000Z", task: "P10-06", from: "PLAN", to: "IN_PROGRESS", actor: "agent" });
      x.checkpoints.push({ at: "2099-01-01T00:00:01.000Z", task: "P10-06", from: "IN_PROGRESS", to: "APPROVAL_REQUESTED", actor: "agent" });
      x.checkpoints.push({ at: "2099-01-01T00:00:02.000Z", task: "P10-06", from: "APPROVAL_REQUESTED", to: "APPROVED", actor: "owner", via: "chat" });
    });
    expect(codes(m)).toContain("CHAT_APPROVAL_WITHOUT_QUOTE");
  });
});
