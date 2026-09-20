// Side-by-side export of every flagged possible duplicate, so the owner can see
// the two entries next to each other and decide which one to keep.
const { all, get } = require('../server/db');
const fs = require('node:fs');
const OUT = process.env.HOME + '/Downloads/Swabha_Duplicates_To_Clear.csv';

const flags = all(`SELECT df.flag_id, df.txn_id, df.flag_type, df.severity, df.message,
   t.txn_date, t.gross_amount, t.direction, t.voucher_no, t.narration, t.source,
   c.name AS category, p.display_name AS party
 FROM data_flags df JOIN transactions t USING(txn_id)
 LEFT JOIN categories c ON c.category_id = t.category_id
 LEFT JOIN parties p ON p.party_id = t.party_id
 WHERE df.resolved = 0 AND df.flag_type = 'possible_duplicate'
 ORDER BY t.gross_amount DESC`);

const rows = [];
for (const f of flags) {
  let other = null, kind = '';
  let m = /bank row (\d+)/.exec(f.message);
  if (m) {
    const b = get(`SELECT bt.*, ba.nickname FROM bank_transactions bt
                   JOIN bank_accounts ba USING(bank_id) WHERE bt.bt_id=?`, [+m[1]]);
    if (b) { other = { date: b.txn_date, amount: b.credit || b.debit, who: b.counterparty || '',
                       desc: b.particulars, src: 'BANK — ' + b.nickname, ref: 'bank#' + b.bt_id };
             kind = 'same payment also in the bank statement'; }
  } else if ((m = /(?:Tally )?entry (\d+)/.exec(f.message))) {
    const t = get(`SELECT t.*, c.name cat, p.display_name party FROM transactions t
       LEFT JOIN categories c ON c.category_id=t.category_id
       LEFT JOIN parties p ON p.party_id=t.party_id WHERE t.txn_id=?`, [+m[1]]);
    if (t) { other = { date: t.txn_date, amount: t.gross_amount, who: t.party || '',
                       desc: ((t.voucher_no || '') + ' ' + (t.narration || '')).trim(),
                       src: 'LEDGER — ' + t.source, ref: 'txn#' + t.txn_id };
             kind = 'same entry already in the ledger'; }
  } else if (/share date/.test(f.message)) kind = 'same date, amount and party as another entry';
  rows.push({ f, other, kind: kind || f.flag_type });
}

const esc = s => { s = String(s ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const hdr = ['DECIDE: keep / remove', 'Why it is flagged', 'Severity',
  'A: Date', 'A: Amount', 'A: In/Out', 'A: Party', 'A: Category', 'A: Description', 'A: Source', 'A: Ref',
  'B: Date', 'B: Amount', 'B: Party', 'B: Description', 'B: Source', 'B: Ref',
  'Same amount?', 'Days apart'];
const lines = [hdr.join(',')];
for (const { f, other, kind } of rows) {
  const same = other ? (Math.abs(other.amount - f.gross_amount) < 1 ? 'YES — identical'
                        : 'differs by ' + Math.round(Math.abs(other.amount - f.gross_amount))) : '';
  const days = other ? Math.round(Math.abs(new Date(other.date) - new Date(f.txn_date)) / 86400000) : '';
  lines.push([ '', kind, f.severity,
    f.txn_date, Math.round(f.gross_amount), f.direction === 'in' ? 'RECEIVED' : 'PAID OUT',
    f.party || '', f.category || '', ((f.voucher_no || '') + ' ' + (f.narration || '')).trim().slice(0, 140),
    f.source, 'txn#' + f.txn_id,
    other ? other.date : '', other ? Math.round(other.amount) : '', other ? other.who : '',
    other ? String(other.desc).slice(0, 140) : '', other ? other.src : '', other ? other.ref : '',
    same, days ].map(esc).join(','));
}
fs.writeFileSync(OUT, '﻿' + lines.join('\n'));   // BOM so Excel opens it cleanly
console.log(`wrote ${rows.length} flagged pairs to ${OUT}`);
console.log('  counterpart identified : ' + rows.filter(r => r.other).length);
console.log('  identical amount       : ' + rows.filter(r => r.other && Math.abs(r.other.amount - r.f.gross_amount) < 1).length);
console.log('  same day               : ' + rows.filter(r => r.other && r.other.date === r.f.txn_date).length);
const byKind = {};
for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
for (const [k, n] of Object.entries(byKind)) console.log(`  ${n} × ${k}`);
console.log('  total value flagged    : Rs ' + Math.round(rows.reduce((a, r) => a + r.f.gross_amount, 0)).toLocaleString('en-IN'));
