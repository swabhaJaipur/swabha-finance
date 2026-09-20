// Every chart, tile and table on the dashboard is produced by these functions from
// ONE filter object. That is what makes the visuals interlinked: click anything,
// the filter grows, everything else re-reads. Drill ends at the root entries.
const { all, get } = require('./db');

const DIMS = {
  month:        { sql: "t.month",                       label: 'Month' },
  quarter:      { sql: "t.fy || ' Q' || ((cast(strftime('%m',t.txn_date) as int)+8)%12/3+1)", label: 'Quarter' },
  fy:           { sql: "t.fy",                          label: 'Financial Year' },
  direction:    { sql: "t.direction",                   label: 'In / Out' },
  kind:         { sql: "c.kind",                        label: 'Account Kind' },
  category:     { sql: "c.name",                        label: 'Category' },
  cost_behaviour:{sql: "coalesce(c.cost_behaviour,'n/a')", label: 'Fixed / Variable' },
  party:        { sql: "coalesce(p.display_name,'(no party)')", label: 'Party' },
  party_group:  { sql: "coalesce(p.party_group,'(none)')",label: 'Party Group' },
  property:     { sql: "coalesce(pr.name,'(unattributed)')", label: 'Property' },
  host:         { sql: "coalesce(h.name,'(unattributed)')",  label: 'Host' },
  voucher_type: { sql: "t.voucher_type",                label: 'Voucher Type' },
  payment_mode: { sql: "coalesce(t.payment_mode,'(blank)')", label: 'Payment Mode' },
  status:       { sql: "t.status",                      label: 'Status' },
  gst:          { sql: "CASE WHEN (t.cgst+t.sgst+t.igst)>0 THEN 'With GST' ELSE 'No GST' END", label: 'GST' },
  source:       { sql: "coalesce(t.source,'(unknown)')", label: 'Source' },
  external:     { sql: "CASE WHEN coalesce(t.is_external,0)=1 THEN 'External' ELSE 'Swabha' END", label: 'Whose money' },
  compliance:   { sql: "coalesce(t.compliance,'unknown')", label: 'Tax status' },
  books:        { sql: "CASE WHEN coalesce(t.in_tally,1)=1 THEN 'In Tally' ELSE 'Not in Tally' END", label: 'Books' },
  account:      { sql: "coalesce((SELECT a.name FROM accounts a WHERE a.account_id=t.account_id),'(unassigned)')", label: 'Account' },
};

const FROM = `
  FROM transactions t
  LEFT JOIN categories c ON c.category_id = t.category_id
  LEFT JOIN parties    p ON p.party_id    = t.party_id
  LEFT JOIN properties pr ON pr.property_id = t.property_id
  LEFT JOIN hosts      h ON h.host_id     = pr.host_id
`;

// filter -> WHERE. Unknown keys are ignored; arrays become IN(...).
function where(f = {}) {
  const w = [], p = [];
  if (f.from)  { w.push('t.txn_date >= ?'); p.push(f.from); }
  if (f.to)    { w.push('t.txn_date <= ?'); p.push(f.to); }
  if (f.includeCancelled !== true) w.push("t.status = 'Posted'");
  if (f.flaggedOnly)  w.push('EXISTS(SELECT 1 FROM data_flags df WHERE df.txn_id=t.txn_id AND df.resolved=0)');
  // duplicates are imported on purpose and flagged; this hides them from the totals
  if (f.excludeDupes) w.push(`NOT EXISTS(SELECT 1 FROM data_flags df WHERE df.txn_id=t.txn_id
                              AND df.resolved=0 AND df.flag_type='possible_duplicate')`);
  if (f.needsReview)  w.push('t.needs_review = 1');
  if (f.unattributed) w.push('t.property_id IS NULL');
  // the books switch: what Tally has, what it does not, or everything
  // external money is never part of Swabha's own figures unless you ask for it
  if (f.includeExternal !== true) w.push('coalesce(t.is_external,0) = 0');
  if (f.externalOnly === true)    w.push('coalesce(t.is_external,0) = 1');
  if (f.books === 'tally')     w.push('t.in_tally = 1');
  if (f.books === 'non_tally') w.push('coalesce(t.in_tally,1) = 0');
  if (f.minAmount != null) { w.push('t.gross_amount >= ?'); p.push(Number(f.minAmount)); }
  if (f.maxAmount != null) { w.push('t.gross_amount <= ?'); p.push(Number(f.maxAmount)); }
  if (f.search) {
    w.push('(t.narration LIKE ? OR t.voucher_no LIKE ? OR p.display_name LIKE ? OR pr.name LIKE ?)');
    const q = `%${f.search}%`; p.push(q, q, q, q);
  }
  // dimension filters — these are what chart clicks add
  for (const [k, d] of Object.entries(DIMS)) {
    if (k === 'books' || k === 'external') continue;   // handled above as a three-way switch, not an IN(...) filter
    const v = f[k];
    if (v == null || (Array.isArray(v) && !v.length)) continue;
    const vals = Array.isArray(v) ? v : [v];
    w.push(`${d.sql} IN (${vals.map(() => '?').join(',')})`);
    p.push(...vals.map(String));
  }
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
}

const MEASURES = `
  count(*)                                                        AS txns,
  coalesce(sum(t.gross_amount),0)                                 AS gross,
  coalesce(sum(CASE WHEN t.direction='in'  THEN t.gross_amount END),0) AS money_in,
  coalesce(sum(CASE WHEN t.direction='out' THEN t.gross_amount END),0) AS money_out,
  -- Direction decides, not the category label. Money that left the business is a cost
  -- even when nobody has classified it yet; otherwise unclassified spend silently
  -- inflates profit, which is exactly how the old spreadsheet went wrong.
  coalesce(sum(CASE WHEN c.kind NOT IN ('capex','transfer') THEN
      (CASE WHEN t.direction='in' THEN t.gross_amount ELSE -t.gross_amount END) END),0)
    + coalesce(sum(CASE WHEN c.kind NOT IN ('capex','transfer') AND t.direction='out'
                        THEN t.gross_amount END),0)                       AS revenue,
  coalesce(sum(CASE WHEN c.kind NOT IN ('capex','transfer') AND t.direction='out'
                    THEN t.gross_amount END),0)                           AS opcost,
  coalesce(sum(CASE WHEN c.kind='cogs' AND t.direction='out' THEN t.gross_amount END),0) AS cogs,
  coalesce(sum(CASE WHEN c.kind IN ('opex','other') AND t.direction='out' THEN t.gross_amount END),0) AS opex,
  coalesce(sum(CASE WHEN c.kind='capex'    THEN t.gross_amount END),0) AS capex,
  coalesce(sum(t.cgst+t.sgst+t.igst),0)                           AS gst,
  coalesce(sum(t.taxable_value),0)                                AS taxable
`;

function kpis(f) {
  const { sql, params } = where(f);
  const r = get(`SELECT ${MEASURES} ${FROM} ${sql}`, params) || {};
  const revenue = r.revenue || 0, opcost = r.opcost || 0;
  return {
    ...r,
    net_operating: revenue - opcost,
    margin: revenue > 0 ? ((revenue - opcost) / revenue) * 100 : 0,
    net_cash: (r.money_in || 0) - (r.money_out || 0),
  };
}

// group by any dimension — powers every chart, and the next drill level
function breakdown(f, dim, limit = 50) {
  const d = DIMS[dim];
  if (!d) throw new Error(`unknown dimension: ${dim}`);
  const { sql, params } = where(f);
  return all(
    `SELECT ${d.sql} AS key, ${MEASURES} ${FROM} ${sql}
     GROUP BY 1 ORDER BY (money_in + money_out) DESC LIMIT ${Number(limit)}`, params)
    .map(r => ({ ...r, net_operating: (r.revenue || 0) - (r.opcost || 0) }));
}

// a time series always ordered by period, never by size
function series(f, dim = 'month') {
  const d = DIMS[dim];
  const { sql, params } = where(f);
  return all(`SELECT ${d.sql} AS key, ${MEASURES} ${FROM} ${sql} GROUP BY 1 ORDER BY 1`, params)
    .map(r => ({ ...r, net_operating: (r.revenue || 0) - (r.opcost || 0) }));
}

// the bottom of every drill-down: the actual entries
function entries(f, { limit = 200, offset = 0, sort = 'txn_date', dir = 'desc' } = {}) {
  const SORT = { txn_date:'t.txn_date', amount:'t.gross_amount', party:'p.display_name',
                 category:'c.name', voucher:'t.voucher_no' };
  const col = SORT[sort] || 't.txn_date';
  const { sql, params } = where(f);
  const total = get(`SELECT count(*) AS n, coalesce(sum(t.gross_amount),0) AS sum ${FROM} ${sql}`, params);
  const rows = all(
    `SELECT t.txn_id, t.txn_date, t.voucher_no, t.voucher_type, t.direction, t.gross_amount,
            t.taxable_value, (t.cgst+t.sgst+t.igst) AS gst, t.gst_treatment, t.status,
            t.narration, t.source, t.needs_review,
            c.name AS category, c.kind, p.display_name AS party, pr.name AS property, h.name AS host,
            (SELECT count(*) FROM data_flags df WHERE df.txn_id=t.txn_id AND df.resolved=0) AS flags,
            CASE WHEN c.name LIKE '%salary%' OR c.name LIKE '%staff%' THEN t.gross_amount ELSE 0 END AS is_staff_cost
     ${FROM} ${sql} ORDER BY ${col} ${dir === 'asc' ? 'ASC' : 'DESC'}, t.txn_id DESC
     LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params);
  return { total: total.n, sum: total.sum, rows };
}

// receivables are not in the ledger — they are what the ledger is still waiting for
function outstanding(f = {}) {
  const rows = all(`
    SELECT i.invoice_id, coalesce(p.display_name, '(unmatched)') AS party, p.party_id,
           i.period, i.cleaning, i.laundry, i.total, i.received,
           (i.total - i.received) AS balance, i.status, i.notes,
           (SELECT max(t.txn_date) FROM transactions t WHERE t.party_id=i.party_id) AS last_txn
    FROM invoices i LEFT JOIN parties p USING(party_id)
    WHERE (i.total - i.received) > 0 ORDER BY balance DESC`);
  const tot = rows.reduce((s, r) => s + r.balance, 0);
  return { rows, total: tot, count: rows.length };
}

const flags = () => all(`
  SELECT df.flag_id, df.flag_type, df.severity, df.message, df.txn_id,
         t.txn_date, t.voucher_no, t.gross_amount, coalesce(p.display_name,'(no party)') AS party
  FROM data_flags df JOIN transactions t USING(txn_id)
  LEFT JOIN parties p ON p.party_id=t.party_id
  WHERE df.resolved=0
  ORDER BY CASE df.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.txn_date DESC`);

// what the dashboard cannot answer yet, and why — shown to the owner, not hidden
function gaps() {
  const g = {};
  g.propertiesNoRate = get(`SELECT count(*) n FROM properties WHERE package_rate IS NULL AND per_cleaning_price IS NULL`).n;
  g.propertiesTotal  = get(`SELECT count(*) n FROM properties`).n;
  g.cleanersNoRate   = get(`SELECT count(*) n FROM cleaners WHERE pay_rate IS NULL AND monthly_salary IS NULL`).n;
  g.cleanersTotal    = get(`SELECT count(*) n FROM cleaners`).n;
  g.partiesUnmapped  = get(`SELECT count(*) n FROM parties WHERE party_id NOT IN (SELECT party_id FROM party_properties)`).n;
  g.partiesTotal     = get(`SELECT count(*) n FROM parties`).n;
  const att = get(`SELECT coalesce(sum(CASE WHEN t.property_id IS NULL THEN t.gross_amount END),0) AS un,
                          coalesce(sum(t.gross_amount),0) AS tot
                   FROM transactions t JOIN categories c USING(category_id)
                   WHERE c.kind='revenue' AND t.status='Posted'`);
  g.revenueUnattributed = att.un; g.revenueTotal = att.tot;
  g.revenueUnattributedPct = att.tot ? (att.un / att.tot) * 100 : 0;
  g.openingBalanceSet = get(`SELECT count(*) n FROM opening_balances`).n > 0;
  g.lastTxnDate = get(`SELECT max(txn_date) d FROM transactions`).d;
  g.openFlags = get(`SELECT count(*) n FROM data_flags WHERE resolved=0`).n;
  return g;
}

const filterOptions = () => ({
  categories: all(`SELECT name AS key, kind FROM categories ORDER BY kind, name`),
  parties:    all(`SELECT display_name AS key, party_group FROM parties ORDER BY display_name`),
  properties: all(`SELECT name AS key, property_id FROM properties ORDER BY name`),
  hosts:      all(`SELECT name AS key FROM hosts ORDER BY name`),
  voucherTypes: all(`SELECT DISTINCT voucher_type AS key FROM transactions ORDER BY 1`),
  months:     all(`SELECT DISTINCT month AS key FROM transactions ORDER BY 1`),
  dims: Object.entries(DIMS).map(([k, v]) => ({ key: k, label: v.label })),
  dateRange: get(`SELECT min(txn_date) AS min, max(txn_date) AS max FROM transactions`),
});

module.exports = { DIMS, where, kpis, breakdown, series, entries, outstanding, flags, gaps, filterOptions };
