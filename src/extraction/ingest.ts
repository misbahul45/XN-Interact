import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { extname, join } from "node:path";
import * as z from "zod/v4";
import type { Config } from "../bootstrap/config.ts";
import { digest } from "../contracts/canonical.ts";
import { PROVIDERS } from "../contracts/catalog.ts";
import { GatewayError } from "../contracts/errors.ts";
import { extractInput, fieldName, sourceId } from "./contracts.ts";
import { normalize } from "./engine.ts";
import type { ExtractionStore, Observation } from "./store.ts";
import { readZipMember } from "./zip.ts";

const MAX_INPUT = 20 * 1024 * 1024;
const MAX_ROWS = 25_000;
const importSchema = z.strictObject({
  source_id: sourceId,
  provider: z.string().refine((value) => PROVIDERS.includes(value) || value === "generic"),
  entity_type: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  fields: z.array(fieldName).min(1).max(24).refine((names) => new Set(names).size === names.length),
  identity_field: fieldName.optional(),
  archive_member: z.string().min(1).max(240).optional(),
});

function readOwnerBytes(cfg: Config, path: string, maximum: number): Buffer {
  const real = realpathSync(path);
  const home = realpathSync(cfg.home);
  const protectedDirs = [join(home, "browser"), join(home, "datasets"), "/proc", "/sys", "/dev"];
  if (protectedDirs.some((dir) => real === dir || real.startsWith(`${dir}/`))) throw new GatewayError("PROHIBITED", "protected directories are outside the import scope");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.size < 1 || st.size > maximum) {
      throw new GatewayError("PROHIBITED", "import requires a bounded regular file owned by the desktop user");
    }
    const bytes = Buffer.alloc(st.size + 1);
    let n = 0;
    while (n < bytes.length) {
      const count = readSync(fd, bytes, n, bytes.length - n, n);
      if (!count) break;
      n += count;
    }
    if (n !== st.size) throw new GatewayError("VALIDATION_FAILED", "import file changed while reading");
    return bytes.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function decode(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
}

export function readOwnerDocument(cfg: Config, path: string, maximum = MAX_INPUT): string {
  return decode(readOwnerBytes(cfg, path, maximum));
}

function rowsFromTable(rows: string[][]): Record<string, unknown>[] {
  const head = rows.shift();
  if (!head || head.some((value) => !value) || new Set(head).size !== head.length || rows.some((values) => values.length !== head.length)) {
    throw new GatewayError("VALIDATION_FAILED", "table requires unique headers and consistent columns");
  }
  return rows.map((values) => Object.fromEntries(head.map((key, i) => [key, values[i]])));
}

function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let state: "plain" | "quoted" | "closed" = "plain";
  const push = () => { row.push(field); field = ""; state = "plain"; };
  const line = () => {
    push();
    if (row.length > 256 || rows.length > MAX_ROWS) throw new GatewayError("VALIDATION_FAILED", "CSV dimensions exceed the import limit");
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (state === "quoted") {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') { field += char; i++; }
      else state = "closed";
    } else if (char === ",") push();
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      line();
    } else if (char === '"' && state === "plain" && field === "") state = "quoted";
    else if (state === "closed" || char === '"') throw new GatewayError("VALIDATION_FAILED", "invalid CSV quoting");
    else field += char;
  }
  if (state === "quoted") throw new GatewayError("VALIDATION_FAILED", "unterminated CSV field");
  if (field || row.length || state === "closed") line();
  return rowsFromTable(rows);
}

function parseHtml(text: string): Record<string, unknown>[] {
  let tables = 0;
  let currentRow: string[] | null = null;
  let value: string | null = null;
  const rows: string[][] = [];
  const structured = new HTMLRewriter().on("script,style,form,iframe,template,[hidden]", { element: (node) => { node.remove(); } }).transform(text);
  new HTMLRewriter().on("table", { element: () => { tables++; } }).on("table tr", {
    element(node) {
      currentRow = [];
      node.onEndTag(() => {
        if (currentRow?.length) rows.push(currentRow);
        currentRow = null;
      });
    },
  }).on("table tr th,table tr td", {
    element(node) {
      value = "";
      node.onEndTag(() => {
        currentRow?.push(value?.trim() ?? "");
        value = null;
      });
    },
    text(node) { if (value !== null && value.length < 2048) value += node.text.slice(0, 2048 - value.length); },
  }).transform(structured);
  if (tables !== 1 || rows.length > MAX_ROWS + 1 || rows.some((row) => row.length > 256)) throw new GatewayError("VALIDATION_FAILED", "HTML import requires one bounded table");
  return rowsFromTable(rows);
}

function fileRows(format: string, text: string): Record<string, unknown>[] {
  let rows: unknown;
  try {
    if (format === ".csv") rows = parseCsv(text);
    else if (format === ".html") rows = parseHtml(text);
    else if (format === ".jsonl") rows = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown);
    else rows = JSON.parse(text);
  } catch {
    throw new GatewayError("VALIDATION_FAILED", "the selected import file is malformed");
  }
  if (!Array.isArray(rows) || rows.length > MAX_ROWS || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new GatewayError("VALIDATION_FAILED", "import requires a list of flat structured records");
  }
  return rows;
}

export function ingestOwnerExport(cfg: Config, store: ExtractionStore, path: string, input: unknown) {
  const manifest = importSchema.parse(input);
  const archive = extname(path).toLowerCase() === ".zip";
  if (archive !== Boolean(manifest.archive_member)) throw new GatewayError("VALIDATION_FAILED", "ZIP import requires one explicitly selected archive member");
  const format = extname(manifest.archive_member ?? path).toLowerCase();
  if (![".json", ".jsonl", ".csv", ".html"].includes(format)) throw new GatewayError("UNSUPPORTED", "import supports JSON, JSONL, CSV, HTML and supported members of ZIP");
  const source = store.ownerExportSource(manifest.source_id);
  if (source.spec.provider !== manifest.provider) throw new GatewayError("PROHIBITED", "import provider does not match the owner registration");
  if (manifest.identity_field && !manifest.fields.includes(manifest.identity_field)) {
    throw new GatewayError("VALIDATION_FAILED", "import identity field must be selected");
  }
  const fields = manifest.fields.map((name) => {
    const field = source.spec.fields.find((candidate) => candidate.name === name);
    if (!field) throw new GatewayError("PROHIBITED", "import field is outside the registered schema");
    return { name, type: field.type };
  });
  const data = readOwnerBytes(cfg, path, MAX_INPUT);
  const rows = fileRows(format, decode(manifest.archive_member ? readZipMember(data, manifest.archive_member, MAX_INPUT) : data));
  const batch = new Map<string, Observation>();
  const observedAt = new Date().toISOString();
  let matches = 0;
  let bytes = 0;
  for (const [index, row] of rows.entries()) {
    const values = Object.fromEntries(fields.map(({ name, type }) => {
      const value = Object.hasOwn(row, name) ? row[name] : null;
      const scalars = (Array.isArray(value) ? value.slice(0, 12) : [value]).filter((v) => ["string", "number", "boolean"].includes(typeof v));
      return [name, normalize(scalars.map(String), type)];
    }));
    if (Object.values(values).every((value) => value === null)) continue;
    matches++;
    const recordDigest = digest(values);
    const identity = manifest.identity_field ? values[manifest.identity_field] : null;
    const entity = digest([manifest.source_id, identity ?? index]);
    const key = digest([entity, recordDigest]);
    if (batch.has(key)) continue;
    const record = {
      key, entity, digest: recordDigest, values,
      provenance: { source_id: manifest.source_id, provider: manifest.provider, ownership: "USER_PROVIDED",
        mechanism: "official_account_export", source_url: null, observed_at: observedAt, record_digest: recordDigest },
    };
    bytes += Buffer.byteLength(JSON.stringify(record));
    if (bytes > MAX_INPUT) throw new GatewayError("COST_LIMITED", "normalized import exceeds the storage budget");
    batch.set(key, record);
  }
  return store.db.tx(() => {
    store.ownerExportSource(manifest.source_id, source.generation);
    const request = extractInput.parse({
      request_id: `import-${digest([manifest, source.generation, [...batch.keys()]])}`, objective: "Owner-provided structured export",
      entity_type: manifest.entity_type, fields, sources: [manifest.source_id], coverage: "all_accessible",
    });
    const run = store.start(request, "owner_export");
    if (run.state !== "queued") return store.view(run.id);
    store.setState(run.id, "running");
    store.save(run.id, { ...store.checkpoints(run.id)[0]!, cursor: null, pages: 1, observations: rows.length,
      matching_observations: matches, bytes, termination: "verified_end" }, [...batch.values()]);
    store.setState(run.id, "succeeded");
    return store.view(run.id);
  });
}
