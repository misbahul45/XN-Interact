-- Standing grants: an owner-signed (terminal only), time-boxed and capped permission that stands in for the
-- per-plan terminal approval of one operation on one account. It never replaces the capability gate.
CREATE TABLE standing_grants (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'suspended', 'exhausted')),
  max_per_day INTEGER NOT NULL CHECK (max_per_day > 0),
  max_total INTEGER NOT NULL CHECK (max_total > 0),
  used_total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  actor_evidence TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT
);
CREATE UNIQUE INDEX standing_grants_one_active ON standing_grants(account_id, operation) WHERE state = 'active';
CREATE INDEX standing_grants_account ON standing_grants(account_id, operation);

CREATE TABLE standing_grant_uses (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES standing_grants(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  run_id TEXT NOT NULL,
  used_at TEXT NOT NULL
);
CREATE INDEX standing_grant_uses_grant ON standing_grant_uses(grant_id, used_at);
