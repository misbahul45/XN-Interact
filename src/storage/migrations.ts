import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CATALOG } from "../contracts/catalog.ts";
import type { Db } from "./db.ts";

export const MIGRATIONS_DIR = resolve(import.meta.dir, "..", "..", "migrations");

export interface MigrationResult {
  applied: string[];
  current: string[];
}

function checksum(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export function migrate(db: Db, dbPath: string | null, dir = MIGRATIONS_DIR): MigrationResult {
  const hasMeta = db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_meta'")?.n === 1;
  const done = new Map<string, string>();
  if (hasMeta) for (const r of db.all<{ key: string; value: string }>("SELECT key, value FROM schema_meta WHERE key LIKE 'migration:%'")) done.set(r.key.slice(10), r.value);
  const applied: string[] = [];
  const pending = CATALOG.migrations.filter((m) => !done.has(m));
  for (const name of CATALOG.migrations) {
    const sql = readFileSync(join(dir, `${name}.sql`), "utf8");
    const sum = checksum(sql);
    const prior = done.get(name);
    if (prior && prior !== sum) throw new Error(`migration ${name} changed after it was applied (checksum mismatch); restore the original file`);
  }
  if (pending.length && done.size && dbPath && existsSync(dbPath)) {
    db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(dbPath, `${dbPath}.pre-${pending[0]}.bak`);
  }
  for (const name of pending) {
    const sql = readFileSync(join(dir, `${name}.sql`), "utf8");
    db.tx(() => {
      db.raw.exec(sql);
      db.run("INSERT INTO schema_meta(key, value) VALUES (?, ?)", `migration:${name}`, checksum(sql));
    });
    applied.push(name);
  }
  return { applied, current: CATALOG.migrations.filter((m) => done.has(m) || applied.includes(m)) };
}

export function tableNames(db: Db): string[] {
  return db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
}
