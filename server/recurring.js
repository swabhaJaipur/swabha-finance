// Fixed monthly income and costs. They roll forward automatically, but nothing is
// ever posted to the ledger without the owner confirming the month — silent
// money-creation is precisely the failure mode of the old spreadsheet.
const { all, get, run, tx, audit } = require('./db');

const monthAdd = (m, n) => {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mm - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const thisMonth = () => new Date().toISOString().slice(0, 7);
const daysIn = m => { const [y, mm] = m.split('-').map(Number); return new Date(y, mm, 0).getDate(); };

// What does this item actually bill in this month, after every recorded change?
function effective(rec, month) {
  if (month < rec.start_month) return { amount: 0, why: 'not started' };
  if (rec.end_month && month > rec.end_month) return { amount: 0, why: 'ended' };
  if (!rec.active) return { amount: 0, why: 'paused' };
  const changes = all(
    `SELECT * FROM recurring_changes WHERE rec_id=? AND month<=? ORDER BY month, change_id`,
    [rec.rec_id, month]);
  let amt = rec.amount, stopped = false;
  for (const c of changes) {
    if (c.action === 'stop')   stopped = true;
    if (c.action === 'resume') stopped = false;
    if (c.action === 'change' && c.amount != null) amt = c.amount;
  }
  if (stopped) return { amount: 0, why: 'stopped' };
  const skip = changes.find(c => c.action === 'skip' && c.month === month);
  if (skip) return { amount: 0, why: 'skipped this month' };
  return { amount: amt, why: null };
}

const listItems = () => all(`
  SELECT r.*, c.name AS category, c.kind, p.display_name AS party, pr.name AS property_name
  FROM recurring_items r
  LEFT JOIN categories c USING(category_id)
  LEFT JOIN parties    p ON p.party_id = r.party_id
  LEFT JOIN properties pr ON pr.property_id = r.property_id
  ORDER BY r.direction DESC, r.name`);

// What WOULD post for a month, and what already has
function preview(month) {
  const items = listItems();
  const rows = items.map(r => {
    const e = effective(r, month);
    const posted = get(
      `SELECT txn_id, gross_amount FROM transactions WHERE recurring_id=? AND month=?`,
      [r.rec_id, month]);
    return { ...r, effective: e.amount, why: e.why, posted_txn: posted?.txn_id || null,
             posted_amount: posted?.gross_amount ?? null };
  });
  const due = rows.filter(r => r.effective > 0 && !r.posted_txn);
  return {
    month,
    rows,
    due,
    totals: {
      income_due:  due.filter(r => r.direction === 'in').reduce((a, r) => a + r.effective, 0),
      expense_due: due.filter(r => r.direction === 'out').reduce((a, r) => a + r.effective, 0),
      income_posted:  rows.filter(r => r.direction === 'in'  && r.posted_txn).reduce((a, r) => a + r.posted_amount, 0),
      expense_posted: rows.filter(r => r.direction === 'out' && r.posted_txn).reduce((a, r) => a + r.posted_amount, 0),
    },
  };
}

// Post the confirmed month into the ledger
function post(month, actor, only = null) {
  const p = preview(month);
  const take = only ? p.due.filter(r => only.includes(r.rec_id)) : p.due;
  const made = [];
  tx(() => {
    for (const r of take) {
      const day = Math.min(r.day_of_month || 1, daysIn(month));
      const d = `${month}-${String(day).padStart(2, '0')}`;
      const [y, mm] = month.split('-').map(Number);
      const fy = mm >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
      const gst = r.gst_rate ? r.effective * (r.gst_rate / (100 + r.gst_rate)) : 0;
      const res = run(`INSERT INTO transactions(voucher_type,txn_date,fy,month,direction,party_id,
          property_id,category_id,gross_amount,taxable_value,cgst,sgst,igst,gst_treatment,
          payment_mode,status,narration,source,source_ref,recurring_id,needs_review)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['Recurring', d, fy, month, r.direction, r.party_id, r.property_id, r.category_id,
         r.effective, r.gst_rate ? r.effective - gst : null, gst / 2, gst / 2, 0,
         r.gst_rate ? 'inclusive' : 'none', r.payment_mode, 'Posted',
         `${r.name} — ${month}`, 'Recurring', `rec:${r.rec_id}`, r.rec_id, 0]);
      made.push(Number(res.lastInsertRowid));
    }
    if (made.length)
      audit({ actor, table: 'transactions', rowId: month, action: 'insert',
              note: `posted ${made.length} fixed monthly items for ${month}` });
  });
  return { posted: made.length, month, txn_ids: made };
}

// Turn the Monthly-package properties into fixed income lines, once rates exist.
function generateFromPackages(actor) {
  const props = all(`SELECT p.*, h.name AS host_name FROM properties p
                     LEFT JOIN hosts h USING(host_id)
                     WHERE p.active=1 AND p.package_rate IS NOT NULL AND p.package_rate > 0`);
  const cat = get(`SELECT category_id FROM categories WHERE name='Service Revenue'`).category_id;
  const start = thisMonth();
  let made = 0, skipped = 0;
  tx(() => {
    for (const p of props) {
      const exists = get(`SELECT 1 x FROM recurring_items WHERE property_id=? AND direction='in'
                          AND auto_source='property_package'`, [p.property_id]);
      if (exists) { skipped++; continue; }
      run(`INSERT INTO recurring_items(name,direction,category_id,property_id,amount,day_of_month,
             gst_rate,start_month,auto_source,notes)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [`${p.name} — monthly package`, 'in', cat, p.property_id, p.package_rate, 1,
         0, start, 'property_package', `auto-generated from ${p.package_type || 'package'}`]);
      made++;
    }
    if (made) audit({ actor, table: 'recurring_items', action: 'insert',
                      note: `generated ${made} monthly income lines from property packages` });
  });
  return { created: made, skipped, eligible: props.length };
}

// Backdate an item to when it actually started and post every month it was missed.
// Charts need no special handling: they read the ledger, so they move the moment this runs.
function backfill(rec_id, fromMonth, toMonth, actor) {
  const rec = get('SELECT * FROM recurring_items WHERE rec_id=?', [rec_id]);
  if (!rec) throw new Error('unknown item');
  if (fromMonth < rec.start_month) {
    run('UPDATE recurring_items SET start_month=? WHERE rec_id=?', [fromMonth, rec_id]);
    audit({ actor, table: 'recurring_items', rowId: rec_id, field: 'start_month',
            oldValue: rec.start_month, newValue: fromMonth, action: 'update',
            note: 'backdated to actual start' });
    rec.start_month = fromMonth;
  }
  const end = toMonth || thisMonth();
  let m = fromMonth, total = 0, months = [];
  while (m <= end) {
    const e = effective(rec, m);
    const already = get('SELECT 1 x FROM transactions WHERE recurring_id=? AND month=?', [rec_id, m]);
    if (e.amount > 0 && !already) { post(m, actor, [rec_id]); total += e.amount; months.push(m); }
    m = monthAdd(m, 1);
    if (months.length > 240) break;
  }
  audit({ actor, table: 'transactions', rowId: `rec:${rec_id}`, action: 'insert',
          note: `backfilled ${months.length} months (${fromMonth}..${end}) for "${rec.name}", ${total}` });
  return { rec_id, months, posted: months.length, total };
}

module.exports = { listItems, effective, preview, post, generateFromPackages, backfill, monthAdd, thisMonth };
