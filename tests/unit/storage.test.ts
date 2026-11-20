import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR, migrate, tableNames } from "../../src/storage/migrations.ts";
import { Db } from "../../src/storage/db.ts";
import { tempHome } from "../helpers.ts";

describe("migrations", () => {
  test("apply once, record checksums, and are idempotent", () => {
    const home = tempHome();
    const db = new Db(join(home, "a.sqlite"));
    expect(migrate(db, join(home, "a.sqlite")).applied).toHaveLength(6);
    expect(migrate(db, join(home, "a.sqlite")).applied).toHaveLength(0);
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
  });

  test("an edited applied migration is refused", () => {
    const home = tempHome();
    const dir = mkdtempSync(join(home, "m-"));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const db = new Db(":memory:");
    migrate(db, null, dir);
    writeFileSync(join(dir, "0001_core.sql"), "-- edited\n");
    expect(() => migrate(db, null, dir)).toThrow(/checksum mismatch/);
  });

  test("a failing migration rolls back completely and leaves earlier ones intact", () => {
    const home = tempHome();
    const dir = mkdtempSync(join(home, "m-"));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    writeFileSync(join(dir, "0003_approvals_usage.sql"), "CREATE TABLE approvals (id TEXT PRIMARY KEY); CREATE TABLE broken (;");
    const db = new Db(":memory:");
    expect(() => migrate(db, null, dir)).toThrow();
    const tables = tableNames(db);
    expect(tables).toContain("workflow_runs");
    expect(tables).not.toContain("approvals");
    cpSync(join(MIGRATIONS_DIR, "0003_approvals_usage.sql"), join(dir, "0003_approvals_usage.sql"));
    expect(migrate(db, null, dir).applied).toEqual(["0003_approvals_usage", "0004_acceptance", "0005_standing_grants", "0006_evidence_signoffs"]);
  });
});
