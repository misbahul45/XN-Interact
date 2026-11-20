-- Evidence signoffs: the owner, in a terminal, states that one operation on one account worked in a real, approved
-- acceptance run, so it can run again after the usual approval (or a live standing grant) without a new arming.
CREATE TABLE evidence_signoffs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  basis_acceptance_id TEXT NOT NULL,
  basis_run_id TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  actor_evidence TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT
);
CREATE UNIQUE INDEX evidence_signoffs_one_active ON evidence_signoffs(account_id, operation) WHERE state = 'active';
CREATE INDEX evidence_signoffs_account ON evidence_signoffs(account_id, operation);
