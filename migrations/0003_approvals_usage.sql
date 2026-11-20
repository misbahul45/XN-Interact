CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES execution_plans(id),
  plan_hash TEXT NOT NULL,
  operation TEXT NOT NULL,
  account_ids_json TEXT NOT NULL,
  content_digest TEXT,
  nonce TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'approved', 'rejected', 'expired')),
  actor_evidence TEXT,
  decided_at TEXT,
  used_at TEXT,
  consumed_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX approvals_plan ON approvals(plan_id);

CREATE TABLE provider_budgets (
  account_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  period TEXT NOT NULL,
  window_start TEXT NOT NULL,
  spent INTEGER NOT NULL DEFAULT 0,
  max_calls INTEGER,
  spent_cost REAL NOT NULL DEFAULT 0,
  max_cost REAL,
  retry_after TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, operation, period)
);

CREATE TABLE cached_results (
  ref TEXT PRIMARY KEY,
  owner_context TEXT NOT NULL,
  encrypted_payload BLOB NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX cached_results_expiry ON cached_results(expires_at);
