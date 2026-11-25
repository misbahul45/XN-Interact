import { digest } from "../contracts/canonical.ts";
import { GatewayError } from "../contracts/errors.ts";
import { type Db, newId, nowIso } from "../storage/db.ts";
import { assertSourceUrl, type ExtractRequest, exportSourceSchema, inScope, type Source, sourceSchema } from "./contracts.ts";

type RunState = "queued" | "running" | "succeeded" | "partially_succeeded" | "failed" | "cancelled";
export interface ExtractionRun {
  id: string;
  request_hash: string;
  request_json: string;
  backend: "browser" | "owner_export";
  started_at: string | null;
  state: RunState;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Checkpoint {
  source_id: string;
  generation: string;
  cursor: string | null;
  pages: number;
  observations: number;
  matching_observations: number;
  expected_total: number | null;
  total_conflict: number;
  bytes: number;
  fingerprint: string | null;
  detail_attempts: number;
  detail_success: number;
  termination: string | null;
}

type SourceRow = { id: string; generation: string; spec_json: string; state: string; checked_at: string | null };
export type Value = string | number | boolean | string[] | null;
export type Values = Record<string, Value>;
export interface Observation {
  key: string;
  entity: string;
  digest: string;
  values: Values;
  provenance: Record<string, unknown>;
}

export class ExtractionStore {
  constructor(readonly db: Db, private readonly test: boolean) {}

  register(input: unknown): string {
    const parsed = sourceSchema.safeParse(input);
    if (!parsed.success) throw new GatewayError("VALIDATION_FAILED", "invalid browser source manifest");
    const source = parsed.data;
    if (source.fields.some((f) => f.detail) && ["load_more", "scroll"].includes(source.mechanism)) {
      throw new GatewayError("UNSUPPORTED", "detail enrichment currently requires link pagination or a static source");
    }
    const origin = assertSourceUrl(source.url, this.test).origin;
    if (!inScope(source, source.url) || (source.login_url && (!source.account_marker || assertSourceUrl(source.login_url, this.test).origin !== origin)) ||
      (source.policy_url && new URL(source.policy_url).protocol !== "https:")) {
      throw new GatewayError("PROHIBITED", "source URL or interactive login path is outside the declared scope");
    }
    return this.writeRegistration(source);
  }

  registerOwnerExport(input: unknown) {
    return this.writeRegistration(exportSourceSchema.parse(input));
  }

  private writeRegistration(spec: { id: string }): string {
    const generation = newId("src");
    this.db.run(`INSERT INTO browser_sources(id,generation,spec_json) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,spec_json=excluded.spec_json,state='NOT_CONFIGURED',checked_at=NULL`,
      spec.id, generation, JSON.stringify(spec));
    return generation;
  }

  private registration(id: string, generation?: string): SourceRow {
    const row = this.db.get<SourceRow>("SELECT * FROM browser_sources WHERE id = ?", id);
    if (!row || (generation && row.generation !== generation)) throw new GatewayError("NOT_CONNECTED", "source authorization is absent or changed");
    return row;
  }

  source(id: string, generation?: string): { spec: Source; generation: string; state: string } {
    const row = this.registration(id, generation);
    const parsed = sourceSchema.safeParse(JSON.parse(row.spec_json));
    if (!parsed.success) throw new GatewayError("UNSUPPORTED", "source registration is limited to owner-provided exports");
    const spec = parsed.data;
    assertSourceUrl(spec.url, this.test);
    if (!inScope(spec, spec.url)) throw new GatewayError("PROHIBITED", "source authorization is outside the collection scope");
    return { spec, generation: row.generation, state: row.state };
  }

  ownerExportSource(id: string, generation?: string) {
    const row = this.registration(id, generation);
    const parsed = exportSourceSchema.safeParse(JSON.parse(row.spec_json));
    if (!parsed.success) throw new GatewayError("PROHIBITED", "owner-export registration is required for local ingestion");
    return { spec: parsed.data, generation: row.generation };
  }

  sources() {
    return this.db.all<SourceRow>("SELECT * FROM browser_sources ORDER BY id LIMIT 100").map((row) => {
      const raw = JSON.parse(row.spec_json);
      if (raw.kind === "owner_export") {
        const spec = exportSourceSchema.parse(raw);
        return {
          source_id: row.id, provider: spec.provider, auth_mode: "owner_export", mechanism: "official_account_export",
          fields: spec.fields, session_state: "NOT_APPLICABLE", last_checked_at: null,
          verification: { fixture_tested: false, live_tested: false },
        };
      }
      const spec = sourceSchema.parse(raw);
      return {
        source_id: row.id, provider: "generic", auth_mode: spec.account_marker ? "browser_session" : "public",
        mechanism: spec.mechanism, fields: spec.fields, session_state: row.state, last_checked_at: row.checked_at,
        verification: { fixture_tested: this.test && row.state === "HEADLESS_SESSION_VERIFIED", live_tested: !this.test && row.state === "HEADLESS_SESSION_VERIFIED" },
      };
    });
  }

  health(id: string, generation: string, state: string) {
    this.db.run("UPDATE browser_sources SET state=?, checked_at=? WHERE id=? AND generation=?", state, nowIso(), id, generation);
  }

  start(request: ExtractRequest, backend: ExtractionRun["backend"] = "browser"): ExtractionRun {
    if (request.date_range?.from && request.date_range.to && request.date_range.from > request.date_range.to) throw new GatewayError("VALIDATION_FAILED", "invalid date range");
    if (request.date_range && !request.fields.some((f) => f.name === request.date_range!.field && f.type === "date")) throw new GatewayError("VALIDATION_FAILED", "date range requires a selected date field");
    if (request.filters.some((p) => !request.fields.some((f) => f.name === p.field))) throw new GatewayError("VALIDATION_FAILED", "filters require selected fields");
    const { objective: _objective, ...persisted } = request;
    const hash = digest([backend, request]);
    return this.db.tx(() => {
      const prior = this.db.get<ExtractionRun>("SELECT * FROM extraction_runs WHERE request_key=?", request.request_id);
      if (prior) {
        if (hash !== prior.request_hash) throw new GatewayError("IDEMPOTENCY_CONFLICT", "request_id belongs to a different extraction");
        return prior;
      }
      if (this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM extraction_runs WHERE state IN ('queued','running')")!.n >= 8) {
        throw new GatewayError("RATE_LIMITED", "the local extraction queue is full");
      }
      const sources = request.sources.map((id) => backend === "browser" ? this.source(id) : this.ownerExportSource(id));
      const fieldMismatch = sources.some(({ spec }) => request.fields.some((requested) => {
        const available = spec.fields.find((f) => f.name === requested.name && f.type === requested.type);
        return (available && "detail" in available && available.detail && request.detail_level !== "full") || (!available && requested.required);
      }));
      if (fieldMismatch || request.fields.some((f) => !sources.some(({ spec }) => spec.fields.some((a) => a.name === f.name && a.type === f.type)))) {
        throw new GatewayError("PROHIBITED", "requested fields exceed a registered source capability");
      }
      if (request.previous_dataset_ref) {
        const baseline = this.run(request.previous_dataset_ref);
        const base = JSON.parse(baseline.request_json) as ExtractRequest;
        if (!["succeeded", "partially_succeeded"].includes(baseline.state) ||
            digest([base.entity_type, base.fields, base.filters, base.date_range]) !== digest([request.entity_type, request.fields, request.filters, request.date_range]) ||
            digest(this.checkpoints(baseline.id).map((x) => [x.source_id, x.generation]).sort()) !== digest(sources.map((x) => [x.spec.id, x.generation]).sort())) {
          throw new GatewayError("PROHIBITED", "incremental baseline must match source authorizations and schema");
        }
      }
      const id = newId("ext");
      const now = nowIso();
      this.db.run("INSERT INTO extraction_runs(id,request_key,request_hash,request_json,backend,state,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?)",
        id, request.request_id, hash, JSON.stringify(persisted), backend, now, now);
      for (const { spec, generation } of sources) {
        this.db.run("INSERT INTO extraction_sources(run_id,source_id,generation,cursor) VALUES (?,?,?,?)", id, spec.id, generation, "url" in spec ? spec.url : null);
      }
      return this.run(id);
    });
  }

  run(id: string): ExtractionRun {
    const r = this.db.get<ExtractionRun>("SELECT * FROM extraction_runs WHERE id=?", id);
    if (!r) throw new GatewayError("VALIDATION_FAILED", "unknown extraction run");
    return r;
  }

  checkpoints(id: string): Checkpoint[] {
    return this.db.all<Checkpoint>("SELECT * FROM extraction_sources WHERE run_id=? ORDER BY rowid", id);
  }

  next(): ExtractionRun | null {
    return this.db.get<ExtractionRun>("SELECT * FROM extraction_runs WHERE state IN ('queued','running') ORDER BY created_at LIMIT 1");
  }

  setState(id: string, state: RunState) {
    const now = nowIso();
    this.db.run(`UPDATE extraction_runs SET state=?,version=version+1,updated_at=?,
      started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END
      WHERE id=? AND state IN ('queued','running')`, state, now, state, now, id);
  }

  resume(id: string) {
    return this.db.tx(() => {
      const run = this.run(id);
      if (!["failed", "partially_succeeded"].includes(run.state)) return this.view(id);
      const checkpoints = this.checkpoints(id);
      const retryable = checkpoints.filter((x) => ["browser_interrupted", "session_expired", "challenge_required"].includes(x.termination ?? ""));
      if (!retryable.length) return this.view(id);
      for (const source of retryable) {
        this.source(source.source_id, source.generation);
        this.db.run("UPDATE extraction_sources SET termination=NULL WHERE run_id=? AND source_id=?", id, source.source_id);
      }
      this.db.run("UPDATE extraction_runs SET state='queued',started_at=NULL,version=version+1,updated_at=? WHERE id=? AND state IN ('failed','partially_succeeded')", nowIso(), id);
      return this.view(id);
    });
  }

  count(id: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM dataset_records WHERE run_id=?", id)!.n;
  }

  save(id: string, checkpoint: Checkpoint, batch: Observation[]) {
    this.db.tx(() => {
      if (this.run(id).state !== "running") return;
      this.registration(checkpoint.source_id, checkpoint.generation);
      for (const record of batch) {
        const prior = this.db.get<{ provenance_json: string }>("SELECT provenance_json FROM dataset_records WHERE run_id=? AND record_key=?", id, record.key);
        if (!prior) this.db.run("INSERT INTO dataset_records VALUES (?,?,?,?,?,?)",
          id, record.key, record.entity, record.digest, JSON.stringify(record.values), JSON.stringify([record.provenance]));
        else {
          const evidence = JSON.parse(prior.provenance_json) as Record<string, unknown>[];
          if (evidence.length < 8 && !evidence.some((p) => p.source_id === record.provenance.source_id)) {
            this.db.run("UPDATE dataset_records SET provenance_json=? WHERE run_id=? AND record_key=?", JSON.stringify([...evidence, record.provenance]), id, record.key);
          }
        }
      }
      this.db.run(`UPDATE extraction_sources SET cursor=?,pages=?,observations=?,matching_observations=?,expected_total=?,total_conflict=?,bytes=?,fingerprint=?,detail_attempts=?,detail_success=?,termination=?
        WHERE run_id=? AND source_id=?`, checkpoint.cursor, checkpoint.pages, checkpoint.observations,
        checkpoint.matching_observations, checkpoint.expected_total, checkpoint.total_conflict, checkpoint.bytes, checkpoint.fingerprint,
        checkpoint.detail_attempts, checkpoint.detail_success, checkpoint.termination, id, checkpoint.source_id);
      this.db.run("UPDATE extraction_runs SET version=version+1,updated_at=? WHERE id=?", nowIso(), id);
    });
  }

  stopSource(id: string, source: string, reason: string) {
    this.db.run("UPDATE extraction_sources SET termination=? WHERE run_id=? AND source_id=?", reason, id, source);
  }

  assertAccess(id: string) {
    this.run(id);
    for (const c of this.checkpoints(id)) this.registration(c.source_id, c.generation);
  }

  view(id: string) {
    const run = this.run(id);
    const checkpoints = this.checkpoints(id);
    const sources = checkpoints.map(({ source_id, pages, observations, termination, detail_attempts, detail_success, expected_total }) =>
      ({ source_id, pages, observations, termination, detail_attempts, detail_success, expected_total }));
    const ends = sources.map((source) => source.termination);
    const state = run.state === "cancelled" ? "CANCELLED" : ends.every((end) => end === "verified_end") ? "COMPLETE_WITHIN_SCOPE" :
      ends.includes("budget_reached") ? "BUDGET_REACHED" : ends.includes("session_expired") ? "SESSION_EXPIRED" :
      ends.includes("restriction") ? "SOURCE_RESTRICTED" : run.state === "failed" ? "FAILED" :
      ends.every((end) => end === "pagination_unconfirmed") ? "UNKNOWN" :
      run.state === "partially_succeeded" ? "PARTIAL" : "UNKNOWN";
    const count = this.count(id);
    const matches = checkpoints.reduce((n, x) => n + x.matching_observations, 0);
    const total = checkpoints.length === 1 && !checkpoints[0]!.total_conflict ? checkpoints[0]!.expected_total : null;
    const knownTotal = total !== null && total >= count ? total : null;
    const request = JSON.parse(run.request_json) as ExtractRequest;
    const detailAttempts = sources.reduce((n, x) => n + x.detail_attempts, 0);
    const available = this.db.get<{ n: number }>(`SELECT count(*) AS n FROM dataset_records r, json_each(r.values_json) v
      WHERE r.run_id=? AND v.type != 'null'`, id)!.n;
    return {
      run_id: id, dataset_ref: id, status: run.state, version: run.version,
      execution: { runtime: "local", backend: run.backend, browser_mode: run.backend === "browser" ? "headless" : null, visible_browser_required: false, extension_required: false },
      coverage: {
        requested: request.coverage, status: state, expected_total: knownTotal,
        collection_coverage: knownTotal ? count / knownTotal : null, unique_records: count,
        raw_observations: sources.reduce((n, x) => n + x.observations, 0), duplicate_observations: Math.max(0, matches - count),
      },
      quality: {
        field_completeness: count ? available / (count * request.fields.length) : null,
        detail_success_ratio: detailAttempts ? sources.reduce((n, x) => n + x.detail_success, 0) / detailAttempts : null,
        duplicate_ratio: matches ? Math.max(0, matches - count) / matches : null,
      },
      sources, untrusted_content: true,
      next_action: ends.includes("session_expired") || ends.includes("challenge_required") ? "owner_reauthentication" :
        ["queued", "running"].includes(run.state) ? "poll_workflow_status" : "query_dataset",
    };
  }
}
