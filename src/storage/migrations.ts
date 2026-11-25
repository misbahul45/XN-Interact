import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CATALOG } from "../contracts/catalog.ts";
import type { Db } from "./db.ts";
import { backup, verifyBackup } from "./retention.ts";

export const MIGRATIONS_DIR = resolve(import.meta.dir, "..", "..", "migrations");

export interface MigrationResult {
  applied: string[];
  current: string[];
}

function checksum(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export function migrate(db: Db, dbPath: string | null, dir = MIGRATIONS_DIR): MigrationResult {
  const hasMeta = () => db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_meta'") !== null;
  let needsBackup = Boolean(dbPath && hasMeta());
  const applied: string[] = [];
  for (const name of CATALOG.migrations) {
    const sql = readFileSync(join(dir, `${name}.sql`), "utf8");
    const sum = checksum(sql);
    const key = `migration:${name}`;
    const changed = db.tx(() => {
      const prior = hasMeta() && db.get<{ value: string }>("SELECT value FROM schema_meta WHERE key=?", key);
      if (prior) {
        if (prior.value !== sum) throw new Error(`migration ${name} changed after it was applied (checksum mismatch); restore the original file`);
        return false;
      }
      if (needsBackup && dbPath) {
        const snapshot = `${dbPath}.pre-${name}.bak`;
        if (existsSync(snapshot)) {
          if (!verifyBackup(snapshot).ok) throw new Error("the pre-migration snapshot failed integrity verification");
        } else {
          const reader = new Database(dbPath, { readonly: true });
          try { backup({ raw: reader }, snapshot); }
          finally { reader.close(); }
        }
        needsBackup = false;
      }
      db.raw.exec(sql);
      db.run("INSERT INTO schema_meta(key, value) VALUES (?, ?)", key, sum);
      return true;
    });
    if (changed) applied.push(name);
  }
  return { applied, current: [...CATALOG.migrations] };
}

export function tableNames(db: Db): string[] {
  return db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
}
