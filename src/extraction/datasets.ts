import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import type { Config } from "../bootstrap/config.ts";
import { privateDir } from "../browser/runtime.ts";
import { GatewayError } from "../contracts/errors.ts";
import { type ExtractRequest, type exportInput, type queryInput } from "./contracts.ts";
import type { ExtractionStore, Values } from "./store.ts";

type Query = z.output<typeof queryInput>;
type Format = z.output<typeof exportInput>["format"];
type Row = { record_key: string; entity_key: string; values_json: string; provenance_json: string; change?: string };

export function queryDataset(store: ExtractionStore, input: Query) {
  store.assertAccess(input.dataset_ref);
  const request = JSON.parse(store.run(input.dataset_ref).request_json) as ExtractRequest;
  const scope = request.fields.map((field) => field.name);
  const fields = input.fields ?? scope;
  if ([...fields, input.filter?.field, input.sort?.field].some((field) => field && !scope.includes(field))) {
    throw new GatewayError("VALIDATION_FAILED", "unknown dataset field");
  }
  const baseline = request.previous_dataset_ref && store.db.get("SELECT 1 FROM extraction_runs WHERE id=?", request.previous_dataset_ref)
    ? request.previous_dataset_ref : null;
  if (baseline) store.assertAccess(baseline);
  const bindings: unknown[] = [];
  const change = baseline ? `CASE
    WHEN EXISTS (SELECT 1 FROM dataset_records p WHERE p.run_id=? AND p.record_key=r.record_key) THEN 'unchanged'
    WHEN EXISTS (SELECT 1 FROM dataset_records p WHERE p.run_id=? AND p.entity_key=r.entity_key) THEN 'updated'
    ELSE 'new' END AS change` : "NULL AS change";
  if (baseline) bindings.push(baseline, baseline);
  bindings.push(input.dataset_ref);
  const filter = input.filter ? "AND EXISTS (SELECT 1 FROM json_each(r.values_json) v WHERE v.key=? AND v.type=? AND v.value=?)" : "";
  if (input.filter) {
    const { field, equals } = input.filter;
    const type = typeof equals;
    bindings.push(field, type === "boolean" ? String(equals) : type === "string" ? "text" : Number.isInteger(equals) ? "integer" : "real",
      type === "boolean" ? Number(equals) : equals);
  }
  const sort = input.sort ? `(SELECT value FROM json_each(r.values_json) WHERE key=?) ${input.sort.direction === "desc" ? "DESC" : "ASC"},` : "";
  if (input.sort) bindings.push(input.sort.field);
  const rows = store.db.all<Row>(`SELECT r.record_key, r.entity_key, r.values_json, r.provenance_json, ${change}
    FROM dataset_records r WHERE r.run_id=? ${filter} ORDER BY ${sort} r.record_key LIMIT ? OFFSET ?`,
    ...bindings, input.limit + 1, input.offset);
  const items = [];
  let bytes = 0;
  for (const row of rows.slice(0, input.limit)) {
    const values = JSON.parse(row.values_json) as Values;
    const item = { record_ref: row.record_key, entity_ref: row.entity_key, values: Object.fromEntries(fields.map((f) => [f, values[f]])),
      change: row.change, provenance: JSON.parse(row.provenance_json) };
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (items.length && bytes > 64_000) break;
    items.push(item);
  }
  return { ...store.view(input.dataset_ref), items, next_offset: rows.length > items.length ? input.offset + items.length : null };
}

function csv(value: unknown): string {
  const raw = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  const safe = typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function exportDataset(cfg: Config, store: ExtractionStore, id: string, format: Format) {
  return store.db.raw.transaction(() => exportSnapshot(cfg, store, id, format))();
}

function exportSnapshot(cfg: Config, store: ExtractionStore, id: string, format: Format) {
  store.assertAccess(id);
  const view = store.view(id);
  if (["queued", "running"].includes(view.status)) throw new GatewayError("VALIDATION_FAILED", "export requires a finished dataset");
  privateDir(cfg.home);
  const dir = privateDir(join(cfg.home, "datasets"));
  const ref = `${id}.${crypto.randomUUID()}.${format}`;
  const path = join(dir, ref);
  const handle = openSync(path, "wx", 0o600);
  const run = store.run(id);
  const fields = (JSON.parse(run.request_json) as ExtractRequest).fields.map((f) => f.name);
  const records = store.db.raw.query<Row, [string]>(`SELECT record_key,entity_key,values_json,provenance_json FROM dataset_records
    WHERE run_id=? ORDER BY record_key`);
  const metadata = JSON.stringify({ ...view, fields });
  try {
    if (format === "sqlite") {
      const output = new Database(path);
      try {
        output.transaction(() => {
          output.exec(`CREATE TABLE metadata (document TEXT NOT NULL);
            CREATE TABLE records (record_ref TEXT PRIMARY KEY,entity_ref TEXT NOT NULL,data TEXT NOT NULL,provenance TEXT NOT NULL)`);
          output.query("INSERT INTO metadata VALUES (?)").run(metadata);
          const insert = output.query("INSERT INTO records VALUES (?,?,?,?)");
          for (const row of records.iterate(id)) insert.run(row.record_key, row.entity_key, row.values_json, row.provenance_json);
        })();
      } finally {
        output.close();
      }
    } else {
      if (format === "json") writeSync(handle, `{"metadata":${metadata},"records":[`);
      if (format === "csv") writeSync(handle, `record_ref,entity_ref,${fields.map(csv).join(",")},provenance\r\n`);
      let first = true;
      for (const row of records.iterate(id)) {
        const values = JSON.parse(row.values_json) as Values;
        const record = JSON.stringify({ record_ref: row.record_key, entity_ref: row.entity_key, values, provenance: JSON.parse(row.provenance_json) });
        if (format === "json") writeSync(handle, `${first ? "" : ","}${record}`);
        else if (format === "jsonl") writeSync(handle, `${record}\n`);
        else writeSync(handle, [row.record_key, row.entity_key, ...fields.map((f) => values[f]), row.provenance_json].map(csv).join(",") + "\r\n");
        first = false;
      }
      if (format === "json") writeSync(handle, "]}\n");
    }
  } catch {
    unlinkSync(path);
    throw new GatewayError("INTERNAL_ERROR", "local dataset export failed");
  } finally {
    closeSync(handle);
  }
  return { dataset_ref: id, export_ref: ref, format, records: view.coverage.unique_records, coverage: view.coverage };
}

export function deleteDataset(cfg: Config, store: ExtractionStore, id: string) {
  const dir = join(cfg.home, "datasets");
  if (existsSync(dir)) privateDir(dir);
  const removed = store.db.run("DELETE FROM extraction_runs WHERE id=? AND state NOT IN ('queued','running')", id).changes;
  if (!removed) throw new GatewayError("VALIDATION_FAILED", "dataset is unknown or still running");
  let exports = 0;
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.startsWith(`${id}.`) || !/^ext_[\w-]+\.[a-f0-9-]{36}\.(?:json|jsonl|csv|sqlite)$/.test(file)) continue;
      unlinkSync(join(dir, file));
      exports++;
    }
  }
  return { dataset_ref: id, deleted: true, exports_deleted: exports };
}
