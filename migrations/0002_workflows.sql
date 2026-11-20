CREATE TABLE content_drafts (
  id TEXT PRIMARY KEY,
  content_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  size_bytes INTEGER NOT NULL,
  location_ref TEXT NOT NULL,
  alt_text TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE execution_plans (
  id TEXT PRIMARY KEY,
  plan_hash TEXT NOT NULL,
  tool TEXT NOT NULL,
  skill TEXT,
  workflow TEXT NOT NULL,
  risk TEXT NOT NULL,
  approval_required INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX execution_plans_hash ON execution_plans(plan_hash);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL,
  definition_rev INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES execution_plans(id),
  plan_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  approval_id TEXT,
  state TEXT NOT NULL,
  due_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX workflow_runs_state ON workflow_runs(state, due_at);

CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  target_index INTEGER NOT NULL,
  account_id TEXT,
  definition_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  provider_ref TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, target_index, seq)
);
CREATE INDEX workflow_steps_status ON workflow_steps(run_id, status);

CREATE TABLE operation_intents (
  id TEXT PRIMARY KEY,
  step_row_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'succeeded', 'failed', 'unknown_outcome')),
  provider_ref TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX operation_intents_outcome ON operation_intents(outcome);

CREATE TABLE worker_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
