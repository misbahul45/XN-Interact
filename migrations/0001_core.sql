CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE provider_apps (
  provider TEXT PRIMARY KEY,
  client_id_ref TEXT,
  approval_state TEXT NOT NULL DEFAULT 'UNVERIFIED',
  products_json TEXT NOT NULL DEFAULT '[]',
  api_version TEXT,
  policy_epoch INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE connected_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  display_name TEXT,
  account_type TEXT NOT NULL,
  role TEXT,
  state TEXT NOT NULL CHECK (state IN ('connected', 'needs_reauth', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject, account_type)
);

CREATE TABLE oauth_attempts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  encrypted_verifier BLOB,
  mode TEXT NOT NULL CHECK (mode IN ('connect', 'upgrade')),
  account_id TEXT REFERENCES connected_accounts(id) ON DELETE SET NULL,
  requested_scopes TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'exchanging', 'connected', 'failed', 'expired')),
  error TEXT,
  result_account_ids TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX oauth_attempts_status ON oauth_attempts(status, expires_at);

CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES connected_accounts(id) ON DELETE CASCADE,
  scopes_json TEXT NOT NULL,
  encrypted_tokens BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  expires_at TEXT,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'refresh_failed', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX oauth_grants_expiry ON oauth_grants(state, expires_at);

CREATE TABLE capability_snapshots (
  account_id TEXT NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (account_id, cache_key)
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  account_id TEXT,
  outcome TEXT NOT NULL,
  redacted_json TEXT NOT NULL
);
CREATE INDEX audit_events_at ON audit_events(at);
