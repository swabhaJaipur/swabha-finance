// Idempotent migrations applied at boot, so a live database is upgraded in place
// and never has to be rebuilt (which would throw away entries people have posted).
const { db, get, run, all } = require('./db');

const cols = t => all(`PRAGMA table_info(${t})`).map(c => c.name);
const addCol = (t, c, decl) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${decl}`); };
const hasTable = t => !!get(`SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?`, [t]);

function migrate() {
  // v2 shipped an expense-only table; fixed INCOME matters just as much here
  // (76 of 80 properties bill a fixed monthly package), so it is one table with a direction.
  if (hasTable('recurring_expenses') && !hasTable('recurring_items')) {
    const n = get('SELECT count(*) c FROM recurring_expenses').c;
    if (n === 0) db.exec('DROP TABLE recurring_expenses');
  }
  db.exec(`
  CREATE TABLE IF NOT EXISTS recurring_items (
    rec_id       INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    direction    TEXT NOT NULL DEFAULT 'out',      -- in = fixed income, out = fixed cost
    category_id  INTEGER REFERENCES categories(category_id),
    party_id     INTEGER REFERENCES parties(party_id),
    property_id  TEXT    REFERENCES properties(property_id),
    amount       REAL NOT NULL,
    day_of_month INTEGER DEFAULT 1,
    payment_mode TEXT,
    gst_rate     REAL DEFAULT 0,                   -- 18 for taxable packages, 0 otherwise
    start_month  TEXT NOT NULL,                    -- yyyy-mm
    end_month    TEXT,                             -- null = runs until stopped
    active       INTEGER DEFAULT 1,
    auto_source  TEXT,                             -- 'property_package' when generated
    notes        TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS ix_rec_dir ON recurring_items(direction, active);

  -- every change is kept, so you can see the month rent went up or a host renegotiated
  CREATE TABLE IF NOT EXISTS recurring_changes (
    change_id INTEGER PRIMARY KEY,
    rec_id    INTEGER REFERENCES recurring_items(rec_id) ON DELETE CASCADE,
    month     TEXT NOT NULL,                       -- applies from this month on
    amount    REAL,                                -- null with action='skip' = not billed
    action    TEXT,                                -- change | skip | stop | resume
    note      TEXT,
    actor     TEXT,
    ts        TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS ix_rc_rec ON recurring_changes(rec_id, month);
  `);
  // v2 created recurring_changes with a foreign key to the now-dropped expense-only
  // table; CREATE TABLE IF NOT EXISTS will not fix that, so rebuild it in place.
  const rcSql = get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='recurring_changes'`)?.sql || '';
  if (rcSql.includes('recurring_expenses')) {
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec(`
      CREATE TABLE recurring_changes_new (
        change_id INTEGER PRIMARY KEY,
        rec_id    INTEGER REFERENCES recurring_items(rec_id) ON DELETE CASCADE,
        month     TEXT NOT NULL, amount REAL, action TEXT, note TEXT, actor TEXT,
        ts        TEXT DEFAULT (datetime('now')));
      INSERT INTO recurring_changes_new SELECT change_id,rec_id,month,amount,action,note,actor,ts
        FROM recurring_changes;
      DROP TABLE recurring_changes;
      ALTER TABLE recurring_changes_new RENAME TO recurring_changes;
      CREATE INDEX IF NOT EXISTS ix_rc_rec ON recurring_changes(rec_id, month);`);
    db.exec('PRAGMA foreign_keys=ON');
  }
  addCol('transactions', 'recurring_id', 'INTEGER');

  // The books are not the whole business. Some customers pay outside GST and the money
  // lands in an individual account; some staff sit outside ESIC/PF. Both streams are
  // recorded, tagged, and kept separable so the filing view and the management view
  // can never be mistaken for each other.
  addCol('transactions', 'compliance', "TEXT DEFAULT 'unknown'");
  addCol('transactions', 'account_id', 'INTEGER');
  addCol('cleaners',     'on_roll',    'INTEGER DEFAULT 1');
  addCol('cleaners',     'employer_cost', 'REAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id INTEGER PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      kind       TEXT NOT NULL,          -- company_bank | individual | cash | wallet
      holder     TEXT,
      in_books   INTEGER DEFAULT 1,      -- does this account appear in Tally?
      notes      TEXT,
      active     INTEGER DEFAULT 1
    );
    -- what the volume log says SHOULD have been billed, per customer per month
    CREATE TABLE IF NOT EXISTS billing_expectation (
      exp_id      INTEGER PRIMARY KEY,
      party_id    INTEGER REFERENCES parties(party_id),
      party_name  TEXT NOT NULL,
      property_id TEXT REFERENCES properties(property_id),
      month       TEXT NOT NULL,
      service     TEXT NOT NULL,         -- laundry | cleaning
      units       REAL DEFAULT 0,
      expected    REAL DEFAULT 0,
      source      TEXT,
      detail      TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_exp_party ON billing_expectation(party_name, month);
  `);
  if (!get('SELECT 1 x FROM accounts LIMIT 1')) {
    const seed = [
      ['Company Bank (Tally)', 'company_bank', null, 1, 'the account Tally records'],
      ['Cash', 'cash', null, 1, null],
      ['Individual account', 'individual', null, 0, 'non-GST receipts landing outside the company books'],
    ];
    for (const r of seed)
      run('INSERT INTO accounts(name,kind,holder,in_books,notes) VALUES(?,?,?,?,?)', r);
  }
  db.exec(`
    -- One rate card, effective-dated, with per-customer overrides. Cleaning is priced
    -- by property size; laundry per item. Both derived from the owner's own sheets.
    CREATE TABLE IF NOT EXISTS rate_card (
      rate_id    INTEGER PRIMARY KEY,
      service    TEXT NOT NULL,            -- cleaning | deep_cleaning | laundry
      size_key   TEXT,                     -- studio | 1bhk .. 6bhk   (cleaning only)
      item       TEXT,                     -- laundry item            (laundry only)
      base_rate  REAL NOT NULL,
      gst_rate   REAL DEFAULT 18,
      valid_from TEXT NOT NULL DEFAULT '2025-04-01',
      valid_to   TEXT,
      source     TEXT,
      notes      TEXT
    );
    CREATE TABLE IF NOT EXISTS party_rate_override (
      ovr_id     INTEGER PRIMARY KEY,
      party_id   INTEGER REFERENCES parties(party_id),
      party_name TEXT NOT NULL,
      service    TEXT NOT NULL,
      size_key   TEXT, item TEXT,
      base_rate  REAL NOT NULL,
      gst_rate   REAL DEFAULT 18,
      valid_from TEXT NOT NULL DEFAULT '2025-04-01',
      valid_to   TEXT, notes TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_ovr_party ON party_rate_override(party_name, service);
  `);
  if (!get('SELECT 1 x FROM rate_card LIMIT 1')) {
    // seeded from the owner's own data: Palm Leisure rates decode exactly to base + 18%
    const CLEAN = [
      ['studio', 349, 'property sheet (3 properties at 349)'],
      ['1bhk',   349, 'assumed same as studio — CONFIRM'],
      ['2bhk',   449, 'interpolated — CONFIRM'],
      ['3bhk',   499, 'Palm Leisure log, 108 visits at 588.82 incl GST'],
      ['4bhk',   649, 'Palm Leisure log, 79 visits at 765.82 incl GST'],
      ['5bhk',   799, 'interpolated — CONFIRM'],
      ['6bhk',   899, 'Palm Leisure log, 1060.82 incl GST'],
    ];
    for (const [k, r, note] of CLEAN)
      run(`INSERT INTO rate_card(service,size_key,base_rate,gst_rate,valid_from,source,notes)
           VALUES('cleaning',?,?,18,'2025-04-01','derived',?)`, [k, r, note]);
    run(`INSERT INTO rate_card(service,size_key,base_rate,gst_rate,valid_from,source,notes)
         VALUES('deep_cleaning','3bhk',1299,18,'2025-04-01','derived','Palm Leisure log, 1532.82 incl GST')`);
    const LAUNDRY = [
      ['Bedsheet single',15],['Bedsheet double',22],['Pillow cover / cushion cover',8],
      ['Hand towel / face towel',8],['Bath towel',15],['Duvet cover',35],['Bath mat',8],
      ['Runner',8],['Bath robe',50],['Blanket / comforter',170],['Carpet',150],['Sofa cover',45],
    ];
    for (const [it, r] of LAUNDRY)
      run(`INSERT INTO rate_card(service,item,base_rate,gst_rate,valid_from,source,notes)
           VALUES('laundry',?,?,18,'2025-04-01','rate card photo','from Swabha_Chat Rate Cards sheet')`, [it, r]);
  }
  db.exec(`
    -- how the owner settled each billing gap, so a resolved row never reappears
    CREATE TABLE IF NOT EXISTS billing_resolution (
      res_id     INTEGER PRIMARY KEY,
      party_name TEXT NOT NULL,
      month      TEXT NOT NULL,
      action     TEXT NOT NULL,        -- outside_tally | to_invoice | rate_fixed | ignore
      amount     REAL,
      txn_id     INTEGER REFERENCES transactions(txn_id),
      invoice_id INTEGER REFERENCES invoices(invoice_id),
      note       TEXT,
      actor      TEXT,
      ts         TEXT DEFAULT (datetime('now')),
      UNIQUE(party_name, month)
    );
  `);
  db.exec(`
    -- An employee's real cost is not just salary. Guest-house rent, electricity,
    -- groceries and the cook's pay are pooled, then shared across the people who
    -- actually live there, and only then charged out to customers by visits.
    CREATE TABLE IF NOT EXISTS cost_pool (
      pool_id INTEGER PRIMARY KEY,
      name    TEXT NOT NULL UNIQUE,
      basis   TEXT NOT NULL DEFAULT 'headcount',   -- headcount | equal | weight
      active  INTEGER DEFAULT 1,
      notes   TEXT
    );
    -- which spend feeds the pool: by category, by party, or both
    CREATE TABLE IF NOT EXISTS cost_pool_source (
      src_id      INTEGER PRIMARY KEY,
      pool_id     INTEGER NOT NULL REFERENCES cost_pool(pool_id) ON DELETE CASCADE,
      category_id INTEGER REFERENCES categories(category_id),
      party_id    INTEGER REFERENCES parties(party_id),
      cleaner_id  INTEGER REFERENCES cleaners(cleaner_id),  -- e.g. the cook's salary
      note        TEXT
    );
    -- who benefits from the pool, and from when
    CREATE TABLE IF NOT EXISTS staff_facility (
      fac_id     INTEGER PRIMARY KEY,
      cleaner_id INTEGER NOT NULL REFERENCES cleaners(cleaner_id) ON DELETE CASCADE,
      pool_id    INTEGER NOT NULL REFERENCES cost_pool(pool_id) ON DELETE CASCADE,
      weight     REAL DEFAULT 1,
      from_month TEXT NOT NULL DEFAULT '2025-04',
      to_month   TEXT,
      UNIQUE(cleaner_id, pool_id, from_month)
    );
  `);
  if (!get('SELECT 1 x FROM cost_pool LIMIT 1')) {
    run(`INSERT INTO cost_pool(name,basis,notes) VALUES
      ('Guest house, food & utilities','headcount',
       'rent, electricity, groceries and the cook — shared by the staff who live in')`);
    const pool = get("SELECT pool_id FROM cost_pool WHERE name LIKE 'Guest house%'").pool_id;
    for (const nm of ['Rent','Consumables','Miscellaneous']) {
      const c = get('SELECT category_id FROM categories WHERE name=?', [nm]);
      if (c) run('INSERT INTO cost_pool_source(pool_id,category_id,note) VALUES(?,?,?)',
                 [pool, c.category_id, 'seeded — confirm in Masters']);
    }
  }
  // An explicit flag beats guessing from the source string: the Excel sales registers
  // ARE Tally exports, so source<>'Tally' was wrongly calling them off-books.
  addCol('transactions', 'in_tally', 'INTEGER');
  run(`UPDATE transactions SET in_tally = CASE
         WHEN source IN ('Manual','WhatsApp Log','Outside Tally','Recurring','Historical','Chat Extract','Bank')
           THEN 0 ELSE 1 END
       WHERE in_tally IS NULL`);

  db.exec(`
    -- more than one bank, and borrowings that must show on the dashboard
    CREATE TABLE IF NOT EXISTS loans (
      loan_id     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      lender      TEXT,
      kind        TEXT,                      -- term | od | personal | vehicle | bnpl | hand_loan
      principal   REAL,
      rate_pct    REAL,
      emi         REAL,
      emi_day     INTEGER,
      start_month TEXT,
      tenure_months INTEGER,
      account_id  INTEGER REFERENCES accounts(account_id),
      outstanding REAL,
      in_books    INTEGER DEFAULT 1,
      notes       TEXT,
      active      INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS loan_payments (
      pay_id  INTEGER PRIMARY KEY,
      loan_id INTEGER NOT NULL REFERENCES loans(loan_id) ON DELETE CASCADE,
      pay_date TEXT, amount REAL, principal_part REAL, interest_part REAL,
      txn_id  INTEGER REFERENCES transactions(txn_id), note TEXT
    );
    -- assets, and the person answerable for each one
    CREATE TABLE IF NOT EXISTS assets (
      asset_id    INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      category    TEXT,                       -- vehicle | machine | phone | laptop | equipment | furniture
      serial_no   TEXT,
      purchase_date TEXT,
      cost        REAL,
      supplier_party_id INTEGER REFERENCES parties(party_id),
      txn_id      INTEGER REFERENCES transactions(txn_id),
      custodian_id INTEGER REFERENCES cleaners(cleaner_id),   -- who is responsible
      property_id TEXT REFERENCES properties(property_id),
      condition   TEXT DEFAULT 'working',
      status      TEXT DEFAULT 'in_use',      -- in_use | idle | lost | written_off | returned
      useful_life_months INTEGER,
      notes       TEXT
    );
    CREATE TABLE IF NOT EXISTS asset_custody (
      cust_id   INTEGER PRIMARY KEY,
      asset_id  INTEGER NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
      cleaner_id INTEGER REFERENCES cleaners(cleaner_id),
      from_date TEXT NOT NULL,
      to_date   TEXT,
      note      TEXT,
      actor     TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_cust_asset ON asset_custody(asset_id, from_date);
  `);
  // ---- merging duplicate people / accounts, with a trail that explains it ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS merge_log (
      merge_id   INTEGER PRIMARY KEY,
      entity     TEXT NOT NULL,            -- party | cleaner | account
      kept_id    INTEGER, kept_name   TEXT,
      merged_id  INTEGER, merged_name TEXT,
      moved      TEXT,                     -- json summary of what was repointed
      actor      TEXT,
      ts         TEXT DEFAULT (datetime('now'))
    );

    -- what the staff quarter actually provides, priced per line
    CREATE TABLE IF NOT EXISTS facility_item (
      item_id     INTEGER PRIMARY KEY,
      pool_id     INTEGER REFERENCES cost_pool(pool_id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      basis       TEXT DEFAULT 'per_head',  -- per_head | actual | per_person_fixed
      fixed_amount REAL,                    -- null => read actuals from the ledger
      category_id INTEGER REFERENCES categories(category_id),
      party_id    INTEGER REFERENCES parties(party_id),
      charge_to_ctc INTEGER DEFAULT 1,      -- does it load onto the employee's CTC?
      active      INTEGER DEFAULT 1,
      notes       TEXT
    );
    -- which employee uses which facility line
    CREATE TABLE IF NOT EXISTS staff_facility_item (
      sfi_id     INTEGER PRIMARY KEY,
      cleaner_id INTEGER NOT NULL REFERENCES cleaners(cleaner_id) ON DELETE CASCADE,
      item_id    INTEGER NOT NULL REFERENCES facility_item(item_id) ON DELETE CASCADE,
      weight     REAL DEFAULT 1,
      from_month TEXT NOT NULL DEFAULT '2025-04',
      to_month   TEXT,
      UNIQUE(cleaner_id, item_id, from_month)
    );

    -- every expense head: a fixed monthly figure, or read live from the ledger
    CREATE TABLE IF NOT EXISTS expense_head (
      head_id      INTEGER PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      group_name   TEXT,                    -- Rent | Utilities | Vendor | Daily | EMI | Staff
      is_fixed     INTEGER DEFAULT 1,
      fixed_amount REAL,
      category_id  INTEGER REFERENCES categories(category_id),
      party_id     INTEGER REFERENCES parties(party_id),
      due_day      INTEGER,
      active       INTEGER DEFAULT 1,
      source_note  TEXT,
      notes        TEXT
    );
  `);
  addCol('loans', 'purpose',    'TEXT');
  addCol('loans', 'asset_id',   'INTEGER');
  addCol('loans', 'end_month',  'TEXT');
  addCol('loans', 'borrower',   'TEXT');
  addCol('loans', 'paid_count', 'INTEGER DEFAULT 0');

  // seed the expense heads straight from the Recurring Payments sheet
  if (!get('SELECT 1 x FROM expense_head LIMIT 1')) {
    const HEADS = [
      ['Office Rent','Rent',1,13000,4],        ['Staff Quarter Rent','Rent',1,11200,10],
      ['Office Electricity','Utilities',1,4000,null], ['Staff Quarter Electricity','Utilities',1,3000,null],
      ['Internet (wifi)','Utilities',1,1000,null],    ['ESIC PF Consultancy','Staff',1,1500,null],
      ['Tea & Coffee','Staff',1,4000,10],       ['Employee Food','Staff',0,500,null],
      ['Chemicalwala','Vendor',1,5500,null],    ['Disposal Junction','Vendor',1,3000,null],
      ['Raju Housekeeping Agency','Vendor',1,5000,null], ['Y2 Fragrances','Vendor',0,null,null],
      ['Born Good','Vendor',0,null,null],       ['Cleaning Products','Daily',0,500,null],
      ['Conveyance','Daily',0,1500,null],       ['Fuel','Daily',0,6000,null],
      ['Porter Charges','Daily',0,1000,null],   ['Repair & Maintenance','Daily',0,null,null],
      ['Office Expenses','Daily',0,null,null],  ['Salary Advance','Staff',0,null,null],
    ];
    for (const [n, g, fx, amt, day] of HEADS)
      run(`INSERT INTO expense_head(name,group_name,is_fixed,fixed_amount,due_day,source_note)
           VALUES(?,?,?,?,?,'seeded from Recurring Payments.xlsx')`, [n, g, fx, amt, day]);
  }
  // seed the staff-quarter facility lines
  if (!get('SELECT 1 x FROM facility_item LIMIT 1')) {
    const pool = get("SELECT pool_id FROM cost_pool WHERE name LIKE 'Guest house%'");
    if (pool) {
      const ITEMS = [
        ['Staff Quarter Rent', 'per_head', 11200],
        ['Staff Quarter Electricity', 'per_head', 3000],
        ['Employee Food', 'per_head', null],
        ['Tea & Coffee', 'per_head', 4000],
      ];
      for (const [n, b, a] of ITEMS)
        run(`INSERT INTO facility_item(pool_id,name,basis,fixed_amount,charge_to_ctc,notes)
             VALUES(?,?,?,?,1,'from Recurring Payments.xlsx')`, [pool.pool_id, n, b, a]);
    }
  }
  db.exec(`
    -- Bank rows live separately from the ledger. A bank statement records CASH MOVING;
    -- Tally records what was EARNED or OWED. Importing bank rows straight into the ledger
    -- would double-count every invoice that was also paid. So they are matched instead,
    -- and only genuinely unmatched rows become ledger entries.
    CREATE TABLE IF NOT EXISTS bank_accounts (
      bank_id   INTEGER PRIMARY KEY,
      nickname  TEXT NOT NULL UNIQUE,
      bank      TEXT, account_no TEXT, ifsc TEXT, holder TEXT,
      account_id INTEGER REFERENCES accounts(account_id),
      in_books  INTEGER DEFAULT 1, active INTEGER DEFAULT 1, notes TEXT
    );
    CREATE TABLE IF NOT EXISTS bank_transactions (
      bt_id     INTEGER PRIMARY KEY,
      bank_id   INTEGER REFERENCES bank_accounts(bank_id),
      txn_date  TEXT NOT NULL, value_date TEXT, month TEXT,
      particulars TEXT, cheque_no TEXT,
      debit REAL DEFAULT 0, credit REAL DEFAULT 0, balance REAL,
      counterparty TEXT, nature TEXT,
      matched_txn_id INTEGER REFERENCES transactions(txn_id),
      match_kind TEXT,                    -- exact | near | manual | none
      posted_txn_id INTEGER REFERENCES transactions(txn_id),
      category_id INTEGER REFERENCES categories(category_id),
      status    TEXT DEFAULT 'unmatched', -- unmatched | matched | posted | ignored
      src_file  TEXT, src_sheet TEXT, src_row INTEGER,
      fingerprint TEXT UNIQUE,            -- stops the same statement importing twice
      notes     TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_bt_date ON bank_transactions(txn_date);
    CREATE INDEX IF NOT EXISTS ix_bt_status ON bank_transactions(status);
  `);
  // Owner asked for a permanent administrator that is always present, so it is
  // recreated on boot if it ever goes missing. The password is only set at creation —
  // if the owner changes it later, that change is respected.
  if (!get("SELECT 1 x FROM users WHERE username='superadmin'")) {
    const crypto = require('node:crypto');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync('swabha1234', salt, 64).toString('hex');
    run(`INSERT INTO users(username,full_name,pw_hash,pw_salt,perms,active)
         VALUES('superadmin','Swabha Super Admin',?,?,'finance.admin',1)`, [hash, salt]);
    run(`INSERT INTO audit_log(actor,table_name,row_id,action,note)
         VALUES('system','users','superadmin','insert','permanent superadmin restored on boot')`);
  }
  addCol('cleaners', 'joined_month', 'TEXT');
  addCol('cleaners', 'exit_month',   'TEXT');
  addCol('cleaners', 'source_of_truth', 'TEXT');
  // Some money moved through the accounts that is not Swabha's own trade — someone else
  // paid, Swabha bought, the GST credit came here. Marked external, it stays visible but
  // never counts in Swabha's own revenue, cost or profit.
  addCol('transactions', 'is_external', 'INTEGER DEFAULT 0');
  addCol('bank_transactions', 'is_external', 'INTEGER DEFAULT 0');
  addCol('transactions', 'suspense_note', 'TEXT');
  addCol('bank_transactions', 'suspense_note', 'TEXT');
  run("INSERT OR REPLACE INTO settings(key,value) VALUES('schema_version','13')");
}
module.exports = { migrate };
