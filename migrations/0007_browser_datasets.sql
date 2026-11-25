CREATE TABLE browser_sources (
    id TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    checked_at TEXT
);

CREATE TABLE extraction_runs (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX extraction_runs_state ON extraction_runs(state, created_at);

CREATE TABLE extraction_sources (
    run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    cursor TEXT,
    pages INTEGER NOT NULL DEFAULT 0,
    observations INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT,
    detail_attempts INTEGER NOT NULL DEFAULT 0,
    detail_success INTEGER NOT NULL DEFAULT 0,
    termination TEXT,
    PRIMARY KEY (run_id, source_id)
);

CREATE TABLE dataset_records (
    run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
    record_key TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    record_digest TEXT NOT NULL,
    values_json TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    PRIMARY KEY (run_id, record_key)
);
CREATE INDEX dataset_records_entity ON dataset_records(run_id, entity_key);
