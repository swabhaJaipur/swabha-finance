-- Swabha Financial Control System — canonical schema
-- SQLite is the single source of truth. No Excel dependency.
PRAGMA foreign_keys = ON;

------------------------------------------------------------------ MASTERS
CREATE TABLE IF NOT EXISTS hosts (
  host_id      INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  email        TEXT,
  phone        TEXT,
  phone_status TEXT DEFAULT 'ok',      -- ok | pending | invalid
  active       INTEGER DEFAULT 1,
  joined_date  TEXT,
  notes        TEXT
);

CREATE TABLE IF NOT EXISTS properties (
  property_id   TEXT PRIMARY KEY,       -- P001 …
  name          TEXT NOT NULL,
  type          TEXT,                   -- studio | apartment | villa …
  host_id       INTEGER REFERENCES hosts(host_id),
  city          TEXT,
  bedrooms      INTEGER,
  bathrooms     INTEGER,
  max_guests    INTEGER,
  onboarding_date TEXT,                 -- normalised ISO
  package_type  TEXT,                   -- Monthly | Pay per cleaning | N cleanings in month
  package_rate  REAL,                   -- monthly billing rate  (MISSING for 77/80 today)
  cleanings_included INTEGER,
  per_cleaning_price REAL,
  active        INTEGER DEFAULT 1,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS cleaners (
  cleaner_id    INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  phone         TEXT,
  pay_type      TEXT,                   -- per_visit | monthly_salary
  pay_rate      REAL,                   -- per visit  (MISSING today)
  monthly_salary REAL,                  -- (MISSING today)
  active        INTEGER DEFAULT 1,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS property_cleaners (
  property_id TEXT REFERENCES properties(property_id),
  cleaner_id  INTEGER REFERENCES cleaners(cleaner_id),
  from_date   TEXT, to_date TEXT,
  PRIMARY KEY (property_id, cleaner_id, from_date)
);

-- Tally counterparty. The bridge that today does not exist.
CREATE TABLE IF NOT EXISTS parties (
  party_id     INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE,
  tally_name   TEXT,
  party_group  TEXT,                    -- Sundry Debtors | Sundry Creditors …
  gstin        TEXT,
  state        TEXT,
  aliases      TEXT,
  host_id      INTEGER REFERENCES hosts(host_id),
  kind         TEXT,                    -- customer | vendor | both | internal
  match_status TEXT DEFAULT 'unmapped', -- unmapped | auto | confirmed
  notes        TEXT
);

CREATE TABLE IF NOT EXISTS party_properties (
  party_id    INTEGER REFERENCES parties(party_id),
  property_id TEXT REFERENCES properties(property_id),
  confidence  REAL DEFAULT 1.0,
  source      TEXT,                     -- auto_name_match | manual
  PRIMARY KEY (party_id, property_id)
);

------------------------------------------------------------------ CHART OF ACCOUNTS
CREATE TABLE IF NOT EXISTS categories (
  category_id   INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,          -- revenue | cogs | opex | capex | other_income | tax | transfer
  cost_behaviour TEXT,                  -- fixed | variable | n/a
  parent_id     INTEGER REFERENCES categories(category_id),
  active        INTEGER DEFAULT 1
);

------------------------------------------------------------------ LEDGER
CREATE TABLE IF NOT EXISTS transactions (
  txn_id        INTEGER PRIMARY KEY,
  voucher_no    TEXT,
  voucher_type  TEXT,                   -- Sales | Purchase | Payment | Receipt | Journal | Credit Note
  txn_date      TEXT NOT NULL,          -- ISO yyyy-mm-dd
  fy            TEXT,
  month         TEXT,                   -- yyyy-mm
  direction     TEXT NOT NULL,          -- in | out
  party_id      INTEGER REFERENCES parties(party_id),
  property_id   TEXT REFERENCES properties(property_id),
  category_id   INTEGER REFERENCES categories(category_id),
  gross_amount  REAL NOT NULL,          -- the ONLY amount of record
  taxable_value REAL,
  cgst REAL DEFAULT 0, sgst REAL DEFAULT 0, igst REAL DEFAULT 0,
  round_off     REAL DEFAULT 0,
  gst_treatment TEXT DEFAULT 'none',    -- inclusive | exclusive | none
  payment_mode  TEXT,
  status        TEXT DEFAULT 'Posted',  -- Posted | Cancelled | Draft
  narration     TEXT,
  source        TEXT,                   -- Tally | Manual | Bank | Import
  source_ref    TEXT,
  confidence    REAL DEFAULT 1.0,
  needs_review  INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_txn_date  ON transactions(txn_date);
CREATE INDEX IF NOT EXISTS ix_txn_party ON transactions(party_id);
CREATE INDEX IF NOT EXISTS ix_txn_prop  ON transactions(property_id);
CREATE INDEX IF NOT EXISTS ix_txn_cat   ON transactions(category_id);
CREATE INDEX IF NOT EXISTS ix_txn_month ON transactions(month);

CREATE TABLE IF NOT EXISTS transaction_lines (
  line_id     INTEGER PRIMARY KEY,
  txn_id      INTEGER NOT NULL REFERENCES transactions(txn_id) ON DELETE CASCADE,
  service     TEXT,                     -- Regular Cleaning | Laundry | Housekeeping | Deep Cleaning
  property_id TEXT REFERENCES properties(property_id),
  qty         REAL, rate REAL,
  amount      REAL NOT NULL,
  taxable_value REAL, gst_rate REAL, gst_amount REAL
);
CREATE INDEX IF NOT EXISTS ix_line_txn ON transaction_lines(txn_id);

------------------------------------------------------------------ RECEIVABLES
CREATE TABLE IF NOT EXISTS invoices (
  invoice_id  INTEGER PRIMARY KEY,
  party_id    INTEGER REFERENCES parties(party_id),
  period      TEXT,                     -- yyyy-mm
  issue_date  TEXT, due_date TEXT,
  cleaning REAL DEFAULT 0, laundry REAL DEFAULT 0, other REAL DEFAULT 0,
  taxable REAL DEFAULT 0, gst REAL DEFAULT 0, total REAL DEFAULT 0,
  received REAL DEFAULT 0,
  status      TEXT DEFAULT 'open',      -- open | part | paid | written_off
  source      TEXT, notes TEXT
);
CREATE INDEX IF NOT EXISTS ix_inv_party ON invoices(party_id);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id INTEGER PRIMARY KEY,
  party_id   INTEGER REFERENCES parties(party_id),
  invoice_id INTEGER REFERENCES invoices(invoice_id),
  txn_id     INTEGER REFERENCES transactions(txn_id),
  rcpt_date  TEXT, amount REAL, mode TEXT, notes TEXT
);

------------------------------------------------------------------ CASH
CREATE TABLE IF NOT EXISTS opening_balances (
  account TEXT PRIMARY KEY,             -- Bank | Cash | …
  as_of   TEXT, amount REAL
);

------------------------------------------------------------------ INTELLIGENCE
-- Learned categorisation. Every correction the owner makes becomes a rule.
CREATE TABLE IF NOT EXISTS rules (
  rule_id     INTEGER PRIMARY KEY,
  priority    INTEGER DEFAULT 100,
  match_field TEXT,                     -- party | narration | voucher_type | amount | voucher_no
  match_op    TEXT,                     -- equals | contains | regex | between
  match_value TEXT,
  set_category_id INTEGER REFERENCES categories(category_id),
  set_property_id TEXT REFERENCES properties(property_id),
  set_party_id    INTEGER REFERENCES parties(party_id),
  active      INTEGER DEFAULT 1,
  hits        INTEGER DEFAULT 0,
  origin      TEXT,                     -- seed | learned
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Every edit is recoverable. The original Tally figure is never lost.
CREATE TABLE IF NOT EXISTS audit_log (
  log_id     INTEGER PRIMARY KEY,
  ts         TEXT DEFAULT (datetime('now')),
  actor      TEXT DEFAULT 'owner',
  table_name TEXT, row_id TEXT, field TEXT,
  old_value  TEXT, new_value TEXT,
  action     TEXT,                      -- insert | update | delete | import
  note       TEXT
);

-- Anything the system thinks is wrong: duplicates, GST mismatch, missing link…
CREATE TABLE IF NOT EXISTS data_flags (
  flag_id  INTEGER PRIMARY KEY,
  txn_id   INTEGER REFERENCES transactions(txn_id) ON DELETE CASCADE,
  flag_type TEXT, severity TEXT,        -- high | medium | low
  message  TEXT,
  resolved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

------------------------------------------------------------------ ACCESS
CREATE TABLE IF NOT EXISTS users (
  user_id    INTEGER PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  full_name  TEXT,
  pw_hash    TEXT NOT NULL,           -- scrypt
  pw_salt    TEXT NOT NULL,
  perms      TEXT NOT NULL DEFAULT '',-- csv: finance.view,finance.entry,finance.edit,finance.masters,finance.approve,finance.admin
  active     INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(user_id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  ip         TEXT
);
