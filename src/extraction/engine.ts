import type { Page } from "playwright-core";
import { digest } from "../contracts/canonical.ts";
import { type BrowserRuntime, navigate, SourceStop, withSourcePage } from "../browser/runtime.ts";
import { advanceUi, assertContinuation, type BrowserRow, readBatch } from "./browser-adapter.ts";
import { type ExtractRequest, publicUrl, type Source } from "./contracts.ts";
import { type Checkpoint, type ExtractionRun, type ExtractionStore, type Observation, type Value, type Values } from "./store.ts";

const confidential = /[\w.%+-]+@[\w.-]+\.[a-z]{2,}|\b(?:bearer|basic)\s+[a-z\d._~-]{8,}|\b(?:password|passphrase|secret|token|credential|cookie|authorization|api[ _-]?key|otp)\s*[:=]|\b(?:eyJ[a-z\d_-]{12,}\.[a-z\d_-]{8,}|sk-[a-z\d_-]{15,})|(?:\+?\d[\s().-]*){10,}/i;

function clean(raw: string): string | null {
  const text = raw.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  return !text || confidential.test(text) ? null : text.slice(0, 600);
}

export function normalize(raw: string[] | undefined, type: ExtractRequest["fields"][number]["type"]): Value {
  const values = raw?.map(clean).filter((v): v is string => v !== null) ?? [];
  if (!values.length) return null;
  if (type === "array") return [...new Set(values)].slice(0, 12);
  if (values.length !== 1) return null;
  const text = values[0]!;
  switch (type) {
    case "number": return /^-?\d+(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text)) ? Number(text) : null;
    case "boolean": return /^(true|yes)$/i.test(text) ? true : /^(false|no)$/i.test(text) ? false : null;
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(text)) return null;
      const day = new Date(`${text.slice(0, 10)}T00:00:00Z`);
      const parsed = new Date(text);
      return Number.isFinite(+parsed) && Number.isFinite(+day) && day.toISOString().slice(0, 10) === text.slice(0, 10)
        ? (text.length === 10 ? text : parsed.toISOString()) : null;
    }
    case "url": return publicUrl(text);
    default: return text;
  }
}

function matches(values: Values, req: ExtractRequest): boolean {
  if (!req.filters.every(({ field, equals }) => values[field] === equals)) return false;
  if (!req.date_range) return true;
  const value = values[req.date_range.field];
  const date = typeof value === "string" ? value.slice(0, 10) : "";
  return Boolean(date && (!req.date_range.from || date >= req.date_range.from) && (!req.date_range.to || date <= req.date_range.to));
}

export async function executeExtraction(store: ExtractionStore, runtime: BrowserRuntime, run: ExtractionRun, stopping: () => boolean) {
  store.setState(run.id, "running");
  const request = JSON.parse(run.request_json) as ExtractRequest;
  const checkpoints = store.checkpoints(run.id);
  const totals = {
    records: store.count(run.id), pages: checkpoints.reduce((n, c) => n + c.pages, 0),
    bytes: checkpoints.reduce((n, c) => n + c.bytes, 0),
    details: checkpoints.reduce((n, c) => n + c.detail_attempts, 0),
  };
  const deadline = Date.parse(store.run(run.id).started_at ?? new Date().toISOString()) + request.budget.max_duration_ms;
  const remaining = () => Math.max(1, Math.min(12_000, deadline - Date.now()));
  for (const checkpoint of checkpoints) {
    if (checkpoint.termination || stopping() || store.run(run.id).state === "cancelled") continue;
    const current = () => store.source(checkpoint.source_id, checkpoint.generation);
    const check = () => {
      if (stopping()) throw new SourceStop("worker_stopping");
      if (store.run(run.id).state === "cancelled") throw new SourceStop("cancelled");
      current();
      if (Date.now() >= deadline) throw new SourceStop("budget_reached");
    };
    try {
      check();
      const { spec } = current();
      const context = await runtime.open(spec.account_marker ? "owner" : "public");
      await withSourcePage(context, spec, (page) => collectSource(page, spec, checkpoint, check));
    } catch (error) {
      const reason = error instanceof SourceStop ? error.reason : stopping() ? "worker_stopping" :
        error instanceof Error && "code" in error && error.code === "NOT_CONNECTED" ? "restriction" : "browser_interrupted";
      if (reason === "worker_stopping" || reason === "cancelled") continue;
      setHealth(reason);
      store.stopSource(run.id, checkpoint.source_id, reason);
    }
    function setHealth(reason: string) {
      const states: Record<string, string> = {
        session_expired: "REAUTH_REQUIRED", challenge_required: "CHALLENGE_REQUIRED", account_mismatch: "ACCOUNT_MISMATCH",
        restriction: "PROVIDER_RESTRICTED", browser_interrupted: "BROWSER_UNAVAILABLE", ui_changed: "UI_CHANGED",
      };
      if (states[reason]) store.health(checkpoint.source_id, checkpoint.generation, states[reason]);
    }
  }
  if (stopping()) return;
  const ends = store.checkpoints(run.id).map((x) => x.termination);
  const succeeded = ends.every((end) => end === "verified_end" || end === "sample_reached");
  store.setState(run.id, succeeded ? "succeeded" : store.count(run.id) ? "partially_succeeded" : "failed");

  async function collectSource(page: Page, source: Source, checkpoint: Checkpoint, check: () => void) {
    if (!checkpoint.cursor) throw new SourceStop("ui_changed");
    const requestFields = request.fields.filter((field) => source.fields.some((f) => f.name === field.name && f.type === field.type));
    const names = requestFields.map((f) => f.name);
    const detailNames = source.fields.filter((f) => f.detail && names.includes(f.name)).map((f) => f.name);
    const listNames = names.filter((name) => !detailNames.includes(name));
    const incrementalUi = source.mechanism === "scroll" || source.mechanism === "load_more";
    const budget = request.budget;
    const maxRecords = request.coverage === "sample" ? Math.min(25, budget.max_records) : budget.max_records;
    function checkBudget() {
      check();
      if (totals.pages >= budget.max_pages || totals.records >= maxRecords || totals.bytes >= budget.max_storage_bytes) {
        throw new SourceStop(request.coverage === "sample" && totals.records >= maxRecords ? "sample_reached" : "budget_reached");
      }
    }
    checkBudget();
    await navigate(page, source, checkpoint.cursor, remaining());
    let batch = await readBatch(page, source, listNames);
    if (incrementalUi && checkpoint.pages > 0) {
      for (let index = 1; index < checkpoint.pages; index++) {
        check();
        batch = await advanceUi(page, source, listNames, batch) ?? fail("pagination_unconfirmed");
      }
      if (checkpoint.fingerprint !== digest(batch.rows)) fail("pagination_unconfirmed");
      batch = await advanceUi(page, source, listNames, batch) ?? fail("pagination_unconfirmed");
    }
    for (;;) {
      checkBudget();
      const fingerprint = digest(batch.rows);
      if (batch.ambiguous || (batch.empty && !batch.end)) fail("ui_changed");
      if (fingerprint === checkpoint.fingerprint) fail("pagination_unconfirmed");
      if (source.authoritative_total && !request.filters.length && !request.date_range && batch.expectedTotal !== null) {
        if (checkpoint.expected_total !== null && checkpoint.expected_total !== batch.expectedTotal) checkpoint.total_conflict = 1;
        checkpoint.expected_total = batch.expectedTotal;
      }
      let termination: string | null = null;
      const records = new Map<string, Observation>();
      let unique = 0;
      let stored = 0;
      const location = page.url();
      for (const row of batch.rows) {
        check();
        const observation = await observe(row);
        checkpoint.observations++;
        if (!observation) continue;
        if (records.has(observation.key)) {
          checkpoint.matching_observations++;
          continue;
        }
        const exists = store.db.get("SELECT 1 FROM dataset_records WHERE run_id=? AND record_key=?", run.id, observation.key);
        const bytes = Buffer.byteLength(JSON.stringify(observation));
        if ((!exists && totals.records + unique >= maxRecords) || totals.bytes + stored + bytes > budget.max_storage_bytes) {
          termination = request.coverage === "sample" && totals.records + unique >= maxRecords ? "sample_reached" : "budget_reached";
          break;
        }
        records.set(observation.key, observation);
        checkpoint.matching_observations++;
        if (!exists) unique++;
        stored += bytes;
      }
      totals.pages++;
      checkpoint.pages++;
      checkpoint.fingerprint = fingerprint;
      if (!termination) {
        if (batch.truncated) termination = "budget_reached";
        else if (batch.end && batch.next) termination = "pagination_unconfirmed";
        else if (batch.end) {
          const inconsistent = checkpoint.total_conflict || (checkpoints.length === 1 && checkpoint.expected_total !== null && checkpoint.expected_total !== totals.records + unique);
          termination = inconsistent ? "pagination_unconfirmed" : "verified_end";
        }
        else if (!incrementalUi && (!batch.next || source.mechanism !== "next")) termination = "pagination_unconfirmed";
        else if (batch.next && batch.next === location) termination = "pagination_unconfirmed";
        else if (batch.next && !incrementalUi) {
          try {
            assertContinuation(source, batch.next);
            checkpoint.cursor = batch.next;
          } catch {
            termination = "restriction";
          }
        }
      }
      checkpoint.termination = termination;
      checkpoint.bytes += stored;
      store.save(run.id, checkpoint, [...records.values()]);
      totals.records += unique;
      totals.bytes += stored;
      store.health(source.id, checkpoint.generation, termination === "restriction" ? "PROVIDER_RESTRICTED" : "HEADLESS_SESSION_VERIFIED");
      if (termination) return;
      checkBudget();
      if (incrementalUi) batch = await advanceUi(page, source, listNames, batch) ?? fail("pagination_unconfirmed");
      else {
        await navigate(page, source, checkpoint.cursor, remaining());
        batch = await readBatch(page, source, listNames);
      }
    }

    async function observe(row: BrowserRow): Promise<Observation | null> {
      let enriched: BrowserRow | undefined;
      let detailSource: string | null = null;
      if (row.detail && detailNames.length && totals.details < budget.max_detail_pages) {
        assertContinuation(source, row.detail);
        const url = page.url();
        totals.details++;
        checkpoint.detail_attempts++;
        try {
          await navigate(page, source, row.detail, remaining());
          enriched = (await readBatch(page, source, detailNames, true)).rows[0];
          detailSource = publicUrl(page.url());
          if (enriched && detailNames.some((name) => enriched?.fields[name]?.length)) checkpoint.detail_success++;
        } catch (error) {
          if (!(error instanceof SourceStop) || error.reason !== "page_unavailable") throw error;
        }
        await navigate(page, source, url, remaining());
      }
      const values = Object.fromEntries(request.fields.map(({ name, type }) => [name, normalize((detailNames.includes(name) ? enriched : row)?.fields[name], type)]));
      if (Object.values(values).every((v) => v === null) || !matches(values, request)) return null;
      const contentDigest = digest(values);
      const detail = row.detail && publicUrl(row.detail);
      const entity = digest(detail || [source.id, row.id || contentDigest]);
      const recordSource = publicUrl(page.url());
      const field_provenance = Object.fromEntries(names.map((name) => [name,
        { state: values[name] === null ? "UNAVAILABLE" : "OBSERVED", source_url: detailNames.includes(name) ? detailSource : recordSource }]));
      return {
        key: digest([entity, contentDigest]), entity, digest: contentDigest, values,
        provenance: {
          source_id: source.id, source_url: recordSource, observed_at: new Date().toISOString(),
          extraction_run_id: run.id, mechanism: source.mechanism, adapter_version: "1", record_digest: contentDigest, field_provenance,
        },
      };
    }
  }
}

function fail(reason: string): never {
  throw new SourceStop(reason);
}
