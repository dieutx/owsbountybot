-- BountyBot database schema
-- All timestamps stored as ISO 8601 strings

CREATE TABLE IF NOT EXISTS programs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  wallet_name TEXT,
  wallet_id TEXT,
  wallet_accounts TEXT, -- JSON array
  policy_id TEXT,
  policy_config TEXT,   -- JSON object with maxPerBug, dailyLimit, allowedChains, etc.
  agent_key_id TEXT,
  total_authorized REAL DEFAULT 0,
  total_paid REAL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id),
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low')),
  description TEXT NOT NULL,
  reporter_wallet TEXT NOT NULL,
  chain TEXT NOT NULL,
  -- structured fields
  affected_asset TEXT,
  vuln_class TEXT,
  -- evaluation results
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending','evaluating','pending_review','approved','rejected',
    'signed','broadcasted','confirmed','failed','probable_duplicate'
  )),
  quality_score REAL,
  confidence REAL,
  payout REAL DEFAULT 0,
  reasoning TEXT,
  signals TEXT,          -- JSON array
  duplicate_of TEXT REFERENCES reports(id),
  duplicate_score REAL,
  -- authorization
  authorization_id TEXT,
  signature TEXT,
  tx_hash TEXT,
  nonce TEXT,
  expires_at TEXT,
  -- review
  review_level TEXT CHECK(review_level IN ('auto','manual','admin')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  -- timestamps
  created_at TEXT NOT NULL,
  evaluated_at TEXT,
  signed_at TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id),
  program_id TEXT NOT NULL REFERENCES programs(id),
  amount REAL NOT NULL,
  recipient TEXT NOT NULL,
  chain TEXT NOT NULL,
  token TEXT DEFAULT 'USDC',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending','signed','broadcasted','confirmed','failed'
  )),
  authorization_id TEXT,
  signature TEXT,
  tx_hash TEXT,
  nonce TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  program_id TEXT REFERENCES programs(id),
  name TEXT NOT NULL,
  config TEXT NOT NULL, -- JSON: rules, limits, chains, tokens
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  correlation_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,     -- 'report', 'transaction', 'program', 'policy'
  entity_id TEXT,
  actor TEXT,           -- 'system', 'agent', 'admin', reporter wallet
  details TEXT,         -- JSON
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL REFERENCES reports(id),
  type TEXT NOT NULL,   -- 'title_hash', 'desc_hash', 'vuln_type', 'asset', 'combined'
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Daily budget tracking
CREATE TABLE IF NOT EXISTS daily_budgets (
  date TEXT NOT NULL,
  program_id TEXT NOT NULL REFERENCES programs(id),
  spent REAL DEFAULT 0,
  PRIMARY KEY (date, program_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_reports_program ON reports(program_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_wallet);
CREATE INDEX IF NOT EXISTS idx_transactions_report ON transactions(report_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_log(correlation_id);
CREATE INDEX IF NOT EXISTS idx_fingerprints_type_value ON fingerprints(type, value);
CREATE INDEX IF NOT EXISTS idx_fingerprints_report ON fingerprints(report_id);
