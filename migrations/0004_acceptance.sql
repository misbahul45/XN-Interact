CREATE TABLE operation_acceptance (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('armed', 'consumed', 'revoked')),
  armed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_intent TEXT
);
CREATE UNIQUE INDEX operation_acceptance_one_armed ON operation_acceptance(account_id, operation) WHERE state = 'armed';
CREATE INDEX operation_acceptance_account ON operation_acceptance(account_id, operation);
