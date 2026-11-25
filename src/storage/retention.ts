import { Database } from "bun:sqlite";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG } from "../contracts/catalog.ts";
import type { Db } from "./db.ts";

export interface RetentionPolicy {
  audit_days: number;
  terminal_run_days: number;
  plan_days: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { audit_days: 180, terminal_run_days: 90, plan_days: 30 };

const TERMINAL_OK = ["succeeded", "partially_succeeded", "failed", "unsupported", "cancelled"];

function iso(now: number, days: number): string {
  return new Date(now - days * 86_400_000).toISOString();
}

export function purge(db: Db, mediaDir: string, policy: RetentionPolicy = DEFAULT_RETENTION, now = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  const nowIso = new Date(now).toISOString();
  const expiredMedia = db.all<{ id: string; location_ref: string }>("SELECT id, location_ref FROM media_assets WHERE expires_at < ?", nowIso);
  for (const m of expiredMedia) {
    const name = m.location_ref.replace(/^staged:/, "");
    if (/^[0-9a-f]{64}\.[a-z0-9]{2,4}$/.test(name)) rmSync(join(mediaDir, name), { force: true });
  }
  db.tx(() => {
    out.audit_events = db.run("DELETE FROM audit_events WHERE at < ?", iso(now, policy.audit_days)).changes;
    out.cached_results = db.run("DELETE FROM cached_results WHERE expires_at < ?", nowIso).changes;
    out.media_assets = db.run("DELETE FROM media_assets WHERE expires_at < ?", nowIso).changes;
    out.capability_snapshots = db.run("DELETE FROM capability_snapshots WHERE expires_at < ?", nowIso).changes;
    out.worker_leases = db.run("DELETE FROM worker_leases WHERE expires_at < ?", nowIso).changes;
    out.oauth_attempts = db.run("DELETE FROM oauth_attempts WHERE status != 'pending' AND COALESCE(completed_at, expires_at) < ?", iso(now, 1)).changes
      + db.run("DELETE FROM oauth_attempts WHERE status = 'pending' AND expires_at < ?", iso(now, 1)).changes;
    const marks = TERMINAL_OK.map(() => "?").join(",");
    const runWhere = `state IN (${marks}) AND updated_at < ? AND NOT EXISTS (SELECT 1 FROM operation_intents i WHERE i.run_id = workflow_runs.id AND i.outcome IN ('pending', 'unknown_outcome'))`;
    const runArgs = [...TERMINAL_OK, iso(now, policy.terminal_run_days)];
    out.workflow_runs = db.get<{ n: number }>(`SELECT count(*) AS n FROM workflow_runs WHERE ${runWhere}`, ...runArgs)!.n;
    db.run(`DELETE FROM workflow_runs WHERE ${runWhere}`, ...runArgs);
    out.approvals = db.run(
      "DELETE FROM approvals WHERE decision != 'pending' AND created_at < ? AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.plan_id = approvals.plan_id)",
      iso(now, policy.plan_days),
    ).changes;
    out.execution_plans = db.run(
      "DELETE FROM execution_plans WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.plan_id = execution_plans.id) AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.plan_id = execution_plans.id)",
      iso(now, policy.plan_days),
    ).changes;
  });
  return out;
}

function sha256(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

export function backup(db: Pick<Db, "raw">, dest: string): { path: string; sha256: string; bytes: number } {
  if (existsSync(dest) || existsSync(`${dest}.sha256`)) throw new Error(`refusing to overwrite ${dest}`);
  db.raw.query("VACUUM INTO ?").run(dest);
  chmodSync(dest, 0o600);
  const digest = sha256(dest);
  writeFileSync(`${dest}.sha256`, `${digest}  ${dest.split("/").pop()}\n`, { mode: 0o600 });
  return { path: dest, sha256: digest, bytes: readFileSync(dest).length };
}

export function verifyBackup(path: string): { ok: boolean; problems: string[]; migrations: number } {
  const problems: string[] = [];
  const sidecar = `${path}.sha256`;
  if (!existsSync(sidecar)) problems.push("missing .sha256 file");
  else if (readFileSync(sidecar, "utf8").split(/\s+/)[0] !== sha256(path)) problems.push("sha256 mismatch");
  let migrations = 0;
  try {
    const db = new Database(path, { readonly: true });
    try {
      const integrity = (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
      if (integrity !== "ok") problems.push(`integrity_check: ${integrity}`);
      if (db.query("PRAGMA foreign_key_check").all().length) problems.push("foreign key violations");
      const ids = (db.query("SELECT key FROM schema_meta WHERE key LIKE 'migration:%' ORDER BY key").all() as { key: string }[]).map((row) => row.key.slice(10));
      migrations = ids.length;
      if (!migrations || ids.some((id, index) => id !== CATALOG.migrations[index])) problems.push("unknown migration history");
    } finally {
      db.close();
    }
  } catch (e) {
    problems.push(`cannot open: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: problems.length === 0, problems, migrations };
}
