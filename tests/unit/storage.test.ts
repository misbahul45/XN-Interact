import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR, migrate, tableNames } from "../../src/storage/migrations.ts";
import { Db } from "../../src/storage/db.ts";
import { CATALOG } from "../../src/contracts/catalog.ts";
import { verifyBackup } from "../../src/storage/retention.ts";
import { ROOT, tempHome } from "../helpers.ts";

describe("migrations", () => {
  test("apply once, record checksums, and are idempotent", () => {
    const home = tempHome();
    const db = new Db(join(home, "a.sqlite"));
    expect(migrate(db, join(home, "a.sqlite")).applied).toHaveLength(9);
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
    expect(migrate(db, null, dir).applied).toEqual(CATALOG.migrations.slice(2));
  });

  test("concurrent upgrade from migration eight creates one verified pre-upgrade snapshot", async () => {
    const path = join(tempHome(), "old.sqlite");
    const db = new Db(path);
    for (const name of CATALOG.migrations.slice(0, -1)) {
      const sql = readFileSync(join(MIGRATIONS_DIR, `${name}.sql`), "utf8");
      db.raw.exec(sql);
      const checksum = new Bun.CryptoHasher("sha256").update(sql).digest("hex");
      db.run("INSERT INTO schema_meta VALUES (?,?)", `migration:${name}`, checksum);
    }
    const child = () => Bun.spawn([process.execPath, "-e", `
      import { Db } from "./src/storage/db.ts";
      import { migrate } from "./src/storage/migrations.ts";
      const db = new Db(process.argv.at(-1));
      process.stdout.write(JSON.stringify(migrate(db, process.argv.at(-1)).applied));
      db.close();
    `, path], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    try {
      const results = await Promise.all([child(), child()].map(async (proc) => {
        expect(await proc.exited, await new Response(proc.stderr).text()).toBe(0);
        return JSON.parse(await new Response(proc.stdout).text()) as string[];
      }));
      expect(results.flat()).toEqual(["0009_dataset_deadline"]);
      expect(verifyBackup(`${path}.pre-0009_dataset_deadline.bak`)).toEqual({ ok: true, problems: [], migrations: 8 });
      expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
