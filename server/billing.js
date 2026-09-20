// What the operational log says should have been billed, beside what Tally actually
// billed. The gap is the point: it is where work was done and money was not asked for.
const { all, get, run, tx, audit } = require('./db');

function gap({ from = null, to = null } = {}) {
  const w = [], p = [];
  if (from) { w.push('be.month >= ?'); p.push(from); }
  if (to)   { w.push('be.month <= ?'); p.push(to); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';

  const rows = all(`
    SELECT be.party_name, be.month,
           coalesce(sum(CASE WHEN be.service='cleaning' THEN be.expected END),0) AS exp_cleaning,
           coalesce(sum(CASE WHEN be.service='laundry'  THEN be.expected END),0) AS exp_laundry,
           coalesce(sum(be.expected),0) AS expected,
           coalesce(sum(CASE WHEN be.service='cleaning' THEN be.units END),0) AS visits,
           coalesce(sum(CASE WHEN be.service='laundry'  THEN be.units END),0) AS pieces,
           max(be.party_id) AS party_id
    FROM billing_expectation be ${where}
    GROUP BY be.party_name, be.month ORDER BY be.party_name, be.month`, p);

  // what Tally billed that customer that month (GST-inclusive gross)
  const billedFor = (party_id, month) => party_id == null ? null : get(
    `SELECT coalesce(sum(t.gross_amount),0) AS v, count(*) AS n
     FROM transactions t JOIN categories c USING(category_id)
     WHERE t.party_id=? AND t.month=? AND t.direction='in'
       AND c.kind='revenue' AND t.status='Posted'`, [party_id, month]);

  const resolved = {};
  for (const r of all('SELECT * FROM billing_resolution')) resolved[`${r.party_name}|${r.month}`] = r;
  let totExp = 0, totBill = 0, totGap = 0, unmatched = 0;
  const out = rows.map(r => {
    const b = billedFor(r.party_id, r.month);
    const expectedGross = r.expected * 1.18;        // rate card is ex-GST, Tally is gross
    const billed = b ? b.v : null;
    const g = billed == null ? null : expectedGross - billed;
    totExp += expectedGross;
    if (billed != null) { totBill += billed; totGap += g; } else unmatched += expectedGross;
    const res = resolved[`${r.party_name}|${r.month}`] || null;
    return { ...r, expected_gross: expectedGross, billed, entries: b ? b.n : 0, gap: g,
             resolution: res ? res.action : null, resolution_note: res ? res.note : null,
             status: res ? 'settled'
                   : billed == null ? 'no customer match'
                   : g > expectedGross * 0.15 ? 'under-billed'
                   : g < -expectedGross * 0.15 ? 'billed more than logged' : 'matches' };
  });
  const byParty = {};
  for (const r of out) {
    const k = r.party_name;
    byParty[k] = byParty[k] || { key: k, party_id: r.party_id, expected: 0, billed: 0, gap: 0,
                                 months: 0, visits: 0, pieces: 0, matched: r.party_id != null };
    const e = byParty[k];
    e.expected += r.expected_gross; e.months++; e.visits += r.visits; e.pieces += r.pieces;
    if (r.billed != null) { e.billed += r.billed; e.gap += r.gap; }
  }
  return {
    rows: out,
    byParty: Object.values(byParty).sort((a, b) => b.gap - a.gap),
    totals: { expected: totExp, billed: totBill, gap: totGap, unmatched,
              coverage: totExp ? ((totExp - unmatched) / totExp) * 100 : 0 },
    period: get(`SELECT min(month) a, max(month) b FROM billing_expectation`),
  };
}

const rateCard = () => ({
  rates: all(`SELECT * FROM rate_card ORDER BY service,
                CASE size_key WHEN 'studio' THEN 0 WHEN '1bhk' THEN 1 WHEN '2bhk' THEN 2
                  WHEN '3bhk' THEN 3 WHEN '4bhk' THEN 4 WHEN '5bhk' THEN 5 ELSE 6 END, item`),
  overrides: all(`SELECT * FROM party_rate_override ORDER BY party_name, service`),
});


// Settle one gap row. 'outside_tally' records money that really came in but never
// reached Tally — tagged non-GST and pointed at the individual account, so the
// management view is true while the filing view stays exactly as Tally has it.
function resolve({ party_name, month, action, amount, note, actor }) {
  const cat = get("SELECT category_id FROM categories WHERE name='Service Revenue'");
  const acct = get("SELECT account_id FROM accounts WHERE kind='individual'");
  const party = get('SELECT party_id FROM parties WHERE display_name=?', [party_name]);
  let txn_id = null, invoice_id = null;
  tx(() => {
    if (action === 'outside_tally') {
      const d = `${month}-28`;
      const [y, m] = month.split('-').map(Number);
      const r = run(`INSERT INTO transactions(voucher_type,txn_date,fy,month,direction,party_id,
          category_id,gross_amount,gst_treatment,status,narration,source,compliance,account_id,needs_review)
          VALUES('Outside Tally',?,?,?,'in',?,?,?, 'none','Posted',?,'Outside Tally','non_gst',?,0)`,
        [d, m >= 4 ? `${y}-${y+1}` : `${y-1}-${y}`, month, party?.party_id ?? null,
         cat.category_id, Number(amount), note || `settled billing gap for ${month}`,
         acct?.account_id ?? null]);
      txn_id = Number(r.lastInsertRowid);
    } else if (action === 'to_invoice') {
      const r = run(`INSERT INTO invoices(party_id,period,total,received,status,source,notes)
                     VALUES(?,?,?,0,'open','billing_gap',?)`,
        [party?.party_id ?? null, month, Number(amount), note || 'raised from billing gap']);
      invoice_id = Number(r.lastInsertRowid);
    }
    run(`INSERT INTO billing_resolution(party_name,month,action,amount,txn_id,invoice_id,note,actor)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(party_name,month) DO UPDATE SET action=excluded.action, amount=excluded.amount,
           txn_id=excluded.txn_id, invoice_id=excluded.invoice_id, note=excluded.note,
           actor=excluded.actor, ts=datetime('now')`,
      [party_name, month, action, amount ?? null, txn_id, invoice_id, note ?? null, actor]);
    audit({ actor, table: 'billing_resolution', rowId: `${party_name}|${month}`, action: 'insert',
            newValue: action, note: `billing gap ${amount ?? ''} settled as ${action}` });
  });
  return { ok: true, txn_id, invoice_id };
}

module.exports = { gap, rateCard, resolve };
