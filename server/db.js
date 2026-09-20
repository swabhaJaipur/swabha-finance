// Data-access layer. Deliberately thin so the same API can sit on MySQL later
// (LAN now -> Hostinger later) without touching route or query code.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const DB_PATH = process.env.SWABHA_DB || path.join(__dirname, '..', 'db', 'swabha_finance.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');      // concurrent readers while one writer works
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

const all = (sql, params = []) => db.prepare(sql).all(...params);
const get = (sql, params = []) => db.prepare(sql).get(...params);
const run = (sql, params = []) => db.prepare(sql).run(...params);

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Nothing changes without a trace. The original Tally figure is always recoverable.
function audit({ actor, table, rowId, field, oldValue, newValue, action, note }) {
  run(`INSERT INTO audit_log(actor,table_name,row_id,field,old_value,new_value,action,note)
       VALUES(?,?,?,?,?,?,?,?)`,
      [actor || 'system', table, String(rowId ?? ''), field ?? null,
       oldValue == null ? null : String(oldValue),
       newValue == null ? null : String(newValue), action, note ?? null]);
}

module.exports = { db, all, get, run, tx, audit, DB_PATH };
