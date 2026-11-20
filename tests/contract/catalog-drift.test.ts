import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import bridge from "../../plan/bridge.json" with { type: "json" };
import { CATALOG } from "../../src/contracts/catalog.ts";
import { GatewayError } from "../../src/contracts/errors.ts";
import { TOOL_SPECS } from "../../src/routing/gateway.ts";
import { Db } from "../../src/storage/db.ts";
import { migrate, tableNames } from "../../src/storage/migrations.ts";
import { ROOT } from "../helpers.ts";

describe("implementation equals plan/catalog.json", () => {
  test("tool handlers equal the catalog tools", () => {
    expect(Object.keys(TOOL_SPECS).sort()).toEqual(CATALOG.tools.map((t) => t.name).sort());
  });

  test("two-phase tools accept mode plan and execute; others have no mode", () => {
    for (const t of CATALOG.tools) {
      const shape = TOOL_SPECS[t.name]!.input.shape as Record<string, unknown>;
      expect("plan_id" in shape && "operation_id" in shape).toBe(Boolean(t.modes?.length));
      if (t.modes?.length) {
        expect("mode" in shape).toBe(true);
        expect("confirm" in shape || "approved" in shape).toBe(false);
      }
    }
  });

  test("account-scoped tools take explicit account ids, never an ambient account", () => {
    for (const t of CATALOG.tools.filter((x) => x.operations.some((o) => ["content.read", "engagement.read", "analytics.read", "search.content", "capability.read"].includes(o)))) {
      const shape = TOOL_SPECS[t.name]!.input.shape as Record<string, unknown>;
      expect("account_id" in shape || "account_ids" in shape).toBe(true);
    }
  });

  test("skill and workflow manifests equal the catalog", () => {
    const skills = readdirSync(join(ROOT, "skills")).map((f) => JSON.parse(readFileSync(join(ROOT, "skills", f), "utf8")));
    expect(skills.map((s) => s.id).sort()).toEqual(CATALOG.skills.map((s) => s.id).sort());
    const wfs = readdirSync(join(ROOT, "workflows")).map((f) => JSON.parse(readFileSync(join(ROOT, "workflows", f), "utf8")));
    for (const w of CATALOG.workflows) expect(wfs.find((x) => x.id === w.id)).toEqual(w);
  });

  test("database tables equal the catalog tables", () => {
    const db = new Db(":memory:");
    migrate(db, null);
    expect(tableNames(db).filter((t) => t !== "sqlite_sequence").sort()).toEqual(CATALOG.tables.map((t) => t.name).sort());
    for (const t of CATALOG.tables) {
      const cols = db.all<{ name: string }>(`PRAGMA table_info(${t.name})`).map((c) => c.name);
      for (const c of t.encrypted_columns) expect(cols).toContain(c);
    }
  });

  test("every error code builds and carries a valid bridge error class", () => {
    const classes = (bridge as { bridge_contract: { error_classes: string[] } }).bridge_contract.error_classes;
    for (const e of CATALOG.error_codes) {
      const body = new GatewayError(e.code as never, "x").body();
      expect(classes).toContain(body.bridge_error_class);
      expect(body.category).toBe(e.category);
    }
  });

  test("bridge risk rules classify every implemented tool as the catalog does", () => {
    const rules = (bridge as { risk_rules: { tool: string; risk: string }[] }).risk_rules;
    for (const t of CATALOG.tools) expect(rules.find((r) => r.tool === t.name)?.risk).toBe(t.risk);
    expect(rules[rules.length - 1]).toEqual({ server: "xn-interact", tool: "*", risk: "EXTERNAL_WRITE" } as never);
  });
});
