const q = require('./query');
const { all, get, run, tx, audit } = require('./db');
const auth = require('./auth');
const REC = require('./recurring');
const os = require('node:os');
const WA = require('./whatsapp');
const LAUNDRY = require('./laundry');
const BILLING = require('./billing');
const COST = require('./costing');
const MERGE = require('./merge');
const { answerQuestion } = require('./assistant');

const ok   = (res, data) => send(res, 200, data);
const fail = (res, code, msg) => send(res, code, { error: msg });
function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
                        'Cache-Control': 'no-store' });
  res.end(body);
}
const need = (res, user, perm) => {
  if (!user) { fail(res, 401, 'not signed in'); return false; }
  if (!auth.can(user, perm)) { fail(res, 403, `needs ${perm}`); return false; }
  return true;
};

const routes = {
  // ---------------------------------------------------------------- assistant
  'POST /api/ask': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.view')) return;
    const question = body?.question || '';
    if (!question.trim()) return fail(res, 400, 'question is required');
    try {
      const result = answerQuestion(question);
      ok(res, result);
    } catch (e) {
      console.error('Assistant error:', e);
      ok(res, { answer: 'Sorry, I had trouble with that question. Try a simpler one.', error: true });
    }
  },

  // ---------------------------------------------------------------- access
  'GET /api/me': (req, res, { user }) =>
    ok(res, { user, setupNeeded: !auth.hasAnyUser() }),

  'POST /api/setup': (req, res, { body }) => {
    if (auth.hasAnyUser()) return fail(res, 409, 'already set up');
    const { username, password, fullName } = body || {};
    if (!username || !password) return fail(res, 400, 'username and password required');
    if (String(password).length < 8) return fail(res, 400, 'password must be at least 8 characters');
    const u = auth.createUser({ username, password, fullName, perms: 'finance.admin' });
    audit({ actor: username, table: 'users', rowId: u.user_id, action: 'insert', note: 'first admin' });
    res.setHeader('Set-Cookie', cookie(auth.startSession(u.user_id, req.socket.remoteAddress)));
    ok(res, { user: u });
  },

  'POST /api/login': (req, res, { body, req: r }) => {
    const u = auth.verify(body?.username, body?.password || '');
    if (!u) return fail(res, 401, 'wrong username or password');
    res.setHeader('Set-Cookie', cookie(auth.startSession(u.user_id, r.socket.remoteAddress)));
    ok(res, { user: { user_id: u.user_id, username: u.username, full_name: u.full_name, perms: u.perms } });
  },

  'POST /api/logout': (req, res) => {
    auth.endSession(req.headers.cookie);
    res.setHeader('Set-Cookie', `${auth.COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    ok(res, { ok: true });
  },

  // so the page can show the exact address to type on a phone
  'GET /api/net': (q_, res, { user, req: r }) => {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    // the .local name survives a DHCP change, so offer it as the stable address
    const host = os.hostname();
    ok(res, { ips, port: Number(process.env.PORT || 4040), host,
              hostname: /\.local$/.test(host) ? host : `${host}.local`,
              signedIn: !!user });
  },

  // ---------------------------------------------------------------- read
  'GET /api/options':     (q_, res, { user }) => need(res, user, 'finance.view') && ok(res, q.filterOptions()),
  'GET /api/gaps':        (q_, res, { user }) => need(res, user, 'finance.view') && ok(res, q.gaps()),
  'GET /api/outstanding': (q_, res, { user }) => need(res, user, 'finance.view') && ok(res, q.outstanding()),
  'GET /api/flags':       (q_, res, { user }) => need(res, user, 'finance.view') && ok(res, q.flags()),

  // one call powers the whole dashboard for the current filter
  'POST /api/analytics': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.view')) return;
    const f = body?.filter || {};
    const dims = body?.dims || ['category', 'party', 'property', 'voucher_type', 'cost_behaviour', 'host'];
    const out = { kpis: q.kpis(f), series: q.series(f, body?.timeDim || 'month'), breakdowns: {} };
    for (const d of dims) { try { out.breakdowns[d] = q.breakdown(f, d, body?.limit || 12); } catch {} }
    ok(res, out);
  },

  'POST /api/breakdown': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.view')) return;
    try { ok(res, q.breakdown(body?.filter || {}, body?.dim, body?.limit || 50)); }
    catch (e) { fail(res, 400, e.message); }
  },

  // the bottom of every drill-down
  'POST /api/entries': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.view')) return;
    ok(res, q.entries(body?.filter || {}, body?.paging || {}));
  },

  'POST /api/txn/detail': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.view')) return;
    const id = Number(body?.txn_id);
    const row = get(`SELECT t.*, c.name AS category, c.kind, p.display_name AS party, pr.name AS property
                     FROM transactions t LEFT JOIN categories c USING(category_id)
                     LEFT JOIN parties p ON p.party_id=t.party_id
                     LEFT JOIN properties pr ON pr.property_id=t.property_id
                     WHERE t.txn_id=?`, [id]);
    if (!row) return fail(res, 404, 'not found');
    ok(res, { txn: row,
      lines:   all('SELECT * FROM transaction_lines WHERE txn_id=?', [id]),
      flags:   all('SELECT * FROM data_flags WHERE txn_id=?', [id]),
      history: all(`SELECT * FROM audit_log WHERE table_name='transactions' AND row_id=?
                    ORDER BY ts DESC LIMIT 50`, [String(id)]) });
  },

  // ---------------------------------------------------------------- write
  'POST /api/txn/create': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.entry')) return;
    const b = body || {};
    if (!b.txn_date || !b.gross_amount) return fail(res, 400, 'date and amount are required');
    const cat = get('SELECT category_id, kind FROM categories WHERE name=?', [b.category || 'Unclassified'])
             || get("SELECT category_id, kind FROM categories WHERE name='Unclassified'");
    const dir = b.direction || (cat.kind === 'revenue' ? 'in' : 'out');
    const d = String(b.txn_date).slice(0, 10);
    const fy = (() => { const y = +d.slice(0,4), m = +d.slice(5,7); return m >= 4 ? `${y}-${y+1}` : `${y-1}-${y}`; })();
    const pid = b.party ? get('SELECT party_id FROM parties WHERE display_name=?', [b.party])?.party_id : null;
    const id = tx(() => {
      const r = run(`INSERT INTO transactions(voucher_no,voucher_type,txn_date,fy,month,direction,
              party_id,property_id,category_id,gross_amount,taxable_value,cgst,sgst,igst,
              gst_treatment,payment_mode,status,narration,source,needs_review)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [b.voucher_no || null, b.voucher_type || 'Manual', d, fy, d.slice(0,7), dir,
         pid, b.property_id || null, cat.category_id, Number(b.gross_amount),
         b.taxable_value ?? null, Number(b.cgst||0), Number(b.sgst||0), Number(b.igst||0),
         b.gst_treatment || 'none', b.payment_mode || null, 'Posted',
         b.narration || null, 'Manual', 0]);
      const nid = Number(r.lastInsertRowid);
      audit({ actor: user.username, table: 'transactions', rowId: nid, action: 'insert',
              note: `manual entry ${d} ${b.gross_amount} ${b.category || ''}` });
      return nid;
    });
    ok(res, { txn_id: id });
  },

  // edit a figure from the dashboard — old value preserved in audit_log forever
  'POST /api/txn/bulk': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.entry')) return;
    const { txns, action, value } = body || {};
    if (!Array.isArray(txns) || !txns.length || !action) return fail(res, 400, 'txns array and action required');

    try {
      tx(() => {
        for (const tid of txns) {
          if (action === 'set_category') {
            const cat = get('SELECT category_id FROM categories WHERE name=?', [value]) ||
                        get("SELECT category_id FROM categories WHERE name='Unclassified'");
            run('UPDATE transactions SET category_id=? WHERE txn_id=?', [cat.category_id, tid]);
          } else if (action === 'set_property') {
            run('UPDATE transactions SET property_id=? WHERE txn_id=?', [value, tid]);
          } else if (action === 'set_status') {
            run('UPDATE transactions SET status=? WHERE txn_id=?', [value, tid]);
          }
          audit({ actor: user.user_id, table: 'transactions', rowId: tid, action: 'bulk_' + action, note: `bulk value=${value}` });
        }
      });
      ok(res, { updated: txns.length });
    } catch (e) {
      fail(res, 400, e.message);
    }
  },

  'POST /api/txn/update': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.edit')) return;
    const id = Number(body?.txn_id), changes = body?.changes || {};
    const cur = get('SELECT * FROM transactions WHERE txn_id=?', [id]);
    if (!cur) return fail(res, 404, 'not found');
    const ALLOWED = ['txn_date','voucher_no','voucher_type','direction','gross_amount','taxable_value',
                     'cgst','sgst','igst','gst_treatment','payment_mode','status','narration',
                     'property_id','needs_review'];
    const sets = [], vals = [];
    tx(() => {
      for (const [k, v] of Object.entries(changes)) {
        if (k === 'category') {
          const c = get('SELECT category_id FROM categories WHERE name=?', [v]);
          if (c) { sets.push('category_id=?'); vals.push(c.category_id);
                   audit({ actor:user.username, table:'transactions', rowId:id, field:'category',
                           oldValue: get('SELECT name FROM categories WHERE category_id=?',[cur.category_id])?.name,
                           newValue: v, action:'update' }); }
          continue;
        }
        if (k === 'party') {
          const p = get('SELECT party_id FROM parties WHERE display_name=?', [v]);
          sets.push('party_id=?'); vals.push(p?.party_id ?? null);
          audit({ actor:user.username, table:'transactions', rowId:id, field:'party',
                  oldValue: cur.party_id, newValue: v, action:'update' });
          continue;
        }
        if (!ALLOWED.includes(k)) continue;
        if (String(cur[k] ?? '') === String(v ?? '')) continue;
        sets.push(`${k}=?`); vals.push(v);
        audit({ actor:user.username, table:'transactions', rowId:id, field:k,
                oldValue:cur[k], newValue:v, action:'update' });
      }
      if (sets.length) {
        sets.push("updated_at=datetime('now')");
        run(`UPDATE transactions SET ${sets.join(',')} WHERE txn_id=?`, [...vals, id]);
      }
    });
    ok(res, { updated: sets.length, txn: get('SELECT * FROM transactions WHERE txn_id=?', [id]) });
  },

  // Historical actuals that never went through Tally (cash, old books, owner-paid).
  // Always stamped with source + a mandatory reason, so Tally-backed vs added is
  // never ambiguous again — the dashboard can show either view.
  'POST /api/txn/bulk': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.entry')) return;
    const rows = body?.rows || [];
    const src  = body?.source || 'Historical';
    const reason = (body?.reason || '').trim();
    if (!rows.length) return fail(res, 400, 'no rows');
    if (!reason)      return fail(res, 400, 'a reason is required for non-Tally entries');
    if (rows.length > 5000) return fail(res, 400, 'too many rows in one batch (max 5000)');
    const errors = [], made = [];
    tx(() => {
      const batch = run(`INSERT INTO audit_log(actor,table_name,action,note)
                         VALUES(?,'transactions','import',?)`,
                        [user.username, `batch "${src}": ${reason} (${rows.length} rows)`]);
      rows.forEach((b, i) => {
        const d = String(b.txn_date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { errors.push({ i, why: 'bad date' }); return; }
        const amt = Number(b.gross_amount);
        if (!isFinite(amt) || amt === 0) { errors.push({ i, why: 'bad amount' }); return; }
        const cat = get('SELECT category_id,kind FROM categories WHERE name=?', [b.category])
                 || get("SELECT category_id,kind FROM categories WHERE name='Unclassified'");
        const dir = b.direction || (cat.kind === 'revenue' ? 'in' : 'out');
        const y = +d.slice(0,4), m = +d.slice(5,7);
        let pid = null;
        if (b.party) {
          pid = get('SELECT party_id FROM parties WHERE display_name=?', [b.party])?.party_id ?? null;
          if (!pid && b.create_party) {
            pid = Number(run('INSERT INTO parties(display_name,tally_name,match_status) VALUES(?,?,\'unmapped\')',
                             [b.party, b.party]).lastInsertRowid);
          }
        }
        const r = run(`INSERT INTO transactions(voucher_no,voucher_type,txn_date,fy,month,direction,
                party_id,property_id,category_id,gross_amount,taxable_value,cgst,sgst,igst,
                gst_treatment,payment_mode,status,narration,source,source_ref,needs_review)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [b.voucher_no || null, b.voucher_type || 'Historical', d,
           m >= 4 ? `${y}-${y+1}` : `${y-1}-${y}`, d.slice(0,7), dir,
           pid, b.property_id || null, cat.category_id, Math.abs(amt),
           b.taxable_value ?? null, Number(b.cgst||0), Number(b.sgst||0), Number(b.igst||0),
           b.gst_treatment || 'none', b.payment_mode || null, 'Posted',
           b.narration || null, src, `batch:${batch.lastInsertRowid}`, b.needs_review ? 1 : 0]);
        made.push(Number(r.lastInsertRowid));
      });
    });
    ok(res, { inserted: made.length, errors, source: src });
  },

  // ---------------------------------------------------------------- masters
  'POST /api/masters/property': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const { property_id, package_rate, per_cleaning_price, cleanings_included, package_type } = body || {};
    const cur = get('SELECT * FROM properties WHERE property_id=?', [property_id]);
    if (!cur) return fail(res, 404, 'unknown property');
    tx(() => {
      for (const [k, v] of Object.entries({ package_rate, per_cleaning_price, cleanings_included, package_type })) {
        if (v === undefined) continue;
        if (String(cur[k] ?? '') === String(v ?? '')) continue;
        run(`UPDATE properties SET ${k}=? WHERE property_id=?`, [v, property_id]);
        audit({ actor:user.username, table:'properties', rowId:property_id, field:k,
                oldValue:cur[k], newValue:v, action:'update' });
      }
    });
    ok(res, get('SELECT * FROM properties WHERE property_id=?', [property_id]));
  },

  'POST /api/masters/cleaner': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const { cleaner_id, pay_type, pay_rate, monthly_salary } = body || {};
    const cur = get('SELECT * FROM cleaners WHERE cleaner_id=?', [cleaner_id]);
    if (!cur) return fail(res, 404, 'unknown cleaner');
    tx(() => {
      for (const [k, v] of Object.entries({ pay_type, pay_rate, monthly_salary })) {
        if (v === undefined || String(cur[k] ?? '') === String(v ?? '')) continue;
        run(`UPDATE cleaners SET ${k}=? WHERE cleaner_id=?`, [v, cleaner_id]);
        audit({ actor:user.username, table:'cleaners', rowId:cleaner_id, field:k,
                oldValue:cur[k], newValue:v, action:'update' });
      }
    });
    ok(res, get('SELECT * FROM cleaners WHERE cleaner_id=?', [cleaner_id]));
  },

  // the mapping that unlocks per-property profit
  'POST /api/masters/map-party': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const { party_id, property_ids = [], host_id } = body || {};
    tx(() => {
      run('DELETE FROM party_properties WHERE party_id=?', [party_id]);
      for (const pid of property_ids)
        run(`INSERT OR IGNORE INTO party_properties(party_id,property_id,confidence,source)
             VALUES(?,?,1.0,'manual')`, [party_id, pid]);
      if (host_id !== undefined) run('UPDATE parties SET host_id=? WHERE party_id=?', [host_id, party_id]);
      run("UPDATE parties SET match_status='confirmed' WHERE party_id=?", [party_id]);
      audit({ actor:user.username, table:'parties', rowId:party_id, field:'properties',
              newValue:property_ids.join(','), action:'update', note:'owner mapping' });
      // back-fill: attribute this party's existing transactions to the property
      if (property_ids.length === 1) {
        const n = run(`UPDATE transactions SET property_id=? WHERE party_id=? AND property_id IS NULL`,
                      [property_ids[0], party_id]);
        audit({ actor:user.username, table:'transactions', rowId:`party:${party_id}`, action:'update',
                note:`back-filled ${n.changes} transactions to ${property_ids[0]}` });
      }
    });
    ok(res, { ok: true });
  },

  'GET /api/masters': (q_, res, { user }) => {
    if (!need(res, user, 'finance.view')) return;
    ok(res, {
      properties: all(`SELECT p.*, h.name AS host_name,
                        (SELECT group_concat(c.name) FROM property_cleaners pc
                          JOIN cleaners c USING(cleaner_id) WHERE pc.property_id=p.property_id) AS cleaners
                       FROM properties p LEFT JOIN hosts h USING(host_id) ORDER BY p.property_id`),
      cleaners: all(`SELECT c.*, (SELECT count(*) FROM property_cleaners pc
                       WHERE pc.cleaner_id=c.cleaner_id) AS properties FROM cleaners c ORDER BY c.name`),
      hosts: all('SELECT * FROM hosts ORDER BY name'),
      parties: all(`SELECT p.*, (SELECT group_concat(pp.property_id) FROM party_properties pp
                      WHERE pp.party_id=p.party_id) AS mapped_properties,
                      (SELECT count(*) FROM transactions t WHERE t.party_id=p.party_id) AS txns,
                      (SELECT coalesce(sum(t.gross_amount),0) FROM transactions t
                        WHERE t.party_id=p.party_id AND t.direction='in') AS money_in
                    FROM parties p ORDER BY money_in DESC`),
      categories: all('SELECT * FROM categories ORDER BY kind, name'),
    });
  },

  'GET /api/laundry': (q_, res, { user }) =>
    need(res, user, 'finance.view') && ok(res, LAUNDRY.summary()),

  // ------------------------------------------------- merge duplicates
  'GET /api/merge/candidates': (q_, res, { user, url }) => {
    if (!need(res, user, 'finance.masters')) return;
    try { ok(res, MERGE.candidates(url.searchParams.get('entity') || 'party')); }
    catch (e) { fail(res, 400, e.message); }
  },

  'POST /api/merge/preview': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    try { ok(res, MERGE.preview(body.entity || 'party', body.keep_id, body.merge_id)); }
    catch (e) { fail(res, 400, e.message); }
  },

  'POST /api/merge/apply': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    try { ok(res, MERGE.merge(body.entity || 'party', body.keep_id, body.merge_id, user.username)); }
    catch (e) { fail(res, 400, e.message); }
  },

  // ------------------------------------------------- bank reconciliation
  'GET /api/bank': (q_, res, { user, url }) => {
    if (!need(res, user, 'finance.view')) return;
    const status = url.searchParams.get('status') || 'unmatched';
    const month  = url.searchParams.get('month') || '';
    const w = [], p = [];
    if (status !== 'all') { w.push('bt.status=?'); p.push(status); }
    if (month) { w.push('bt.month=?'); p.push(month); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    ok(res, {
      accounts: all(`SELECT b.*, (SELECT count(*) FROM bank_transactions t WHERE t.bank_id=b.bank_id) AS rows
                     FROM bank_accounts b ORDER BY b.nickname`),
      months: all(`SELECT month AS key, count(*) n, coalesce(sum(debit),0) d, coalesce(sum(credit),0) c
                   FROM bank_transactions GROUP BY 1 ORDER BY 1`),
      summary: get(`SELECT count(*) n,
                      coalesce(sum(debit),0) d, coalesce(sum(credit),0) c,
                      sum(CASE WHEN status='unmatched' THEN 1 ELSE 0 END) unmatched,
                      sum(CASE WHEN status='matched'   THEN 1 ELSE 0 END) matched,
                      sum(CASE WHEN status='posted'    THEN 1 ELSE 0 END) posted,
                      sum(CASE WHEN status='ignored'   THEN 1 ELSE 0 END) ignored
                    FROM bank_transactions`),
      rows: all(`SELECT bt.*, c.name AS category FROM bank_transactions bt
                 LEFT JOIN categories c USING(category_id) ${where}
                 ORDER BY bt.txn_date DESC, bt.bt_id DESC LIMIT 400`, p),
      categories: all('SELECT name AS key, kind FROM categories ORDER BY kind, name'),
    });
  },

  // Post an unmatched bank row into the ledger, tagged as not-in-Tally.
  'POST /api/bank/post': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.entry')) return;
    const ids = body?.bt_ids || (body?.bt_id ? [body.bt_id] : []);
    if (!ids.length) return fail(res, 400, 'nothing selected');
    const made = [];
    tx(() => {
      for (const id of ids) {
        const bt = get('SELECT * FROM bank_transactions WHERE bt_id=?', [id]);
        if (!bt || bt.status === 'posted') continue;
        const amt = bt.debit || bt.credit;
        if (!amt) continue;
        const dir = bt.debit ? 'out' : 'in';
        const catName = body?.category || null;
        const cat = catName ? get('SELECT category_id FROM categories WHERE name=?', [catName])
                            : (bt.category_id ? { category_id: bt.category_id } : null)
                            || get("SELECT category_id FROM categories WHERE name='Unclassified'");
        const party = bt.counterparty
          ? get('SELECT party_id FROM parties WHERE display_name=?', [bt.counterparty]) : null;
        const [y, m] = bt.txn_date.split('-').map(Number);
        const acct = get("SELECT account_id FROM accounts WHERE kind='company_bank'");
        const r = run(`INSERT INTO transactions(voucher_type,txn_date,fy,month,direction,party_id,
            category_id,gross_amount,gst_treatment,payment_mode,status,narration,source,source_ref,
            compliance,account_id,in_tally,needs_review)
            VALUES('Bank',?,?,?,?,?,?,?, 'none',?,'Posted',?,'Bank',?, 'unknown',?,0,1)`,
          [bt.txn_date, m >= 4 ? `${y}-${y+1}` : `${y-1}-${y}`, bt.month, dir,
           party?.party_id ?? null, cat.category_id, amt,
           bt.particulars?.slice(0, 20) ?? null,
           `${bt.particulars || ''}${bt.counterparty ? ' — ' + bt.counterparty : ''}`.slice(0, 300),
           `bank:${bt.bt_id}`, acct?.account_id ?? null]);
        const nid = Number(r.lastInsertRowid);
        run("UPDATE bank_transactions SET posted_txn_id=?, status='posted' WHERE bt_id=?", [nid, id]);
        made.push(nid);
      }
      if (made.length)
        audit({ actor: user.username, table: 'transactions', rowId: 'bank', action: 'insert',
                note: `posted ${made.length} bank rows into the ledger as not-in-Tally entries` });
    });
    ok(res, { posted: made.length });
  },

  'POST /api/bank/set': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.edit')) return;
    const ids = body?.bt_ids || (body?.bt_id ? [body.bt_id] : []);
    if (!ids.length) return fail(res, 400, 'nothing selected');
    const cat = body?.category ? get('SELECT category_id FROM categories WHERE name=?', [body.category]) : null;
    tx(() => {
      for (const id of ids) {
        if (body.status) run('UPDATE bank_transactions SET status=? WHERE bt_id=?', [body.status, id]);
        if (cat) run('UPDATE bank_transactions SET category_id=? WHERE bt_id=?', [cat.category_id, id]);
        if (body.counterparty !== undefined)
          run('UPDATE bank_transactions SET counterparty=? WHERE bt_id=?', [body.counterparty, id]);
      }
      audit({ actor: user.username, table: 'bank_transactions', rowId: ids.join(','), action: 'update',
              newValue: `${body.status || ''} ${body.category || ''}`.trim() });
    });
    ok(res, { updated: ids.length });
  },

  // ------------------------------------------------- suspense
  // Everything unresolved in one place: bank rows with no category, flagged entries,
  // entries awaiting review, pay proposals and the known data gaps.
  'GET /api/suspense': (q_, res, { user, url }) => {
    if (!need(res, user, 'finance.view')) return;
    const kind = url.searchParams.get('kind') || 'bank';
    const out = { kind };
    out.counts = {
      bank:     get(`SELECT count(*) n, coalesce(sum(debit),0) d, coalesce(sum(credit),0) c
                     FROM bank_transactions WHERE category_id IS NULL AND coalesce(is_external,0)=0`),
      flagged:  get(`SELECT count(DISTINCT df.txn_id) n FROM data_flags df WHERE df.resolved=0`),
      review:   get(`SELECT count(*) n FROM transactions WHERE needs_review=1 AND coalesce(is_external,0)=0`),
      external: get(`SELECT count(*) n, coalesce(sum(gross_amount),0) v FROM transactions WHERE is_external=1`),
      extbank:  get(`SELECT count(*) n FROM bank_transactions WHERE is_external=1`),
      proposals:get(`SELECT count(*) n FROM pay_proposals WHERE status='open'`),
      gaps:     get(`SELECT count(*) n FROM data_gaps WHERE status='open'`),
    };
    if (kind === 'bank')
      out.rows = all(`SELECT bt.*, b.nickname AS bank FROM bank_transactions bt
        JOIN bank_accounts b USING(bank_id)
        WHERE bt.category_id IS NULL AND coalesce(bt.is_external,0)=0
        ORDER BY (CASE WHEN bt.credit>0 THEN bt.credit ELSE bt.debit END) DESC LIMIT 400`);
    else if (kind === 'flagged')
      out.rows = all(`SELECT t.txn_id, t.txn_date, t.gross_amount, t.direction, t.narration, t.source,
          c.name AS category, p.display_name AS party,
          group_concat(df.flag_type || ': ' || df.message, ' | ') AS flags
        FROM transactions t JOIN data_flags df USING(txn_id)
        LEFT JOIN categories c USING(category_id) LEFT JOIN parties p ON p.party_id=t.party_id
        WHERE df.resolved=0 GROUP BY t.txn_id
        ORDER BY t.gross_amount DESC LIMIT 400`);
    else if (kind === 'review')
      out.rows = all(`SELECT t.txn_id, t.txn_date, t.gross_amount, t.direction, t.narration, t.source,
          c.name AS category, p.display_name AS party
        FROM transactions t LEFT JOIN categories c USING(category_id)
        LEFT JOIN parties p ON p.party_id=t.party_id
        WHERE t.needs_review=1 AND coalesce(t.is_external,0)=0
        ORDER BY t.gross_amount DESC LIMIT 400`);
    else if (kind === 'external') {
      out.rows = all(`SELECT t.txn_id, t.txn_date, t.gross_amount, t.direction, t.narration, t.source,
          t.suspense_note, c.name AS category, p.display_name AS party
        FROM transactions t LEFT JOIN categories c USING(category_id)
        LEFT JOIN parties p ON p.party_id=t.party_id
        WHERE t.is_external=1 ORDER BY t.txn_date DESC LIMIT 400`);
      out.bankRows = all(`SELECT bt.*, b.nickname AS bank FROM bank_transactions bt
        JOIN bank_accounts b USING(bank_id) WHERE bt.is_external=1 ORDER BY bt.txn_date DESC LIMIT 400`);
    }
    else if (kind === 'proposals')
      out.rows = all(`SELECT pp.*, c.name AS staff FROM pay_proposals pp
        LEFT JOIN cleaners c USING(cleaner_id) WHERE pp.status='open' ORDER BY pp.suggested DESC`);
    else if (kind === 'gaps') out.rows = all(`SELECT * FROM data_gaps ORDER BY status, area`);
    out.categories = all('SELECT name AS key, kind FROM categories ORDER BY kind, name');
    ok(res, out);
  },

  // mark as external / bring back to actuals / set a category — on either table
  'POST /api/suspense/act': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.edit')) return;
    const b = body || {};
    const bankIds = b.bt_ids || [], txnIds = b.txn_ids || [];
    if (!bankIds.length && !txnIds.length) return fail(res, 400, 'nothing selected');
    const cat = b.category ? get('SELECT category_id FROM categories WHERE name=?', [b.category]) : null;
    let n = 0;
    tx(() => {
      for (const id of bankIds) {
        if (b.action === 'external')  { run('UPDATE bank_transactions SET is_external=1, suspense_note=? WHERE bt_id=?', [b.note || 'not Swabha\'s own trade', id]); n++; }
        if (b.action === 'actual')    { run('UPDATE bank_transactions SET is_external=0, suspense_note=NULL WHERE bt_id=?', [id]); n++; }
        if (b.action === 'category' && cat) { run('UPDATE bank_transactions SET category_id=?, notes=? WHERE bt_id=?', [cat.category_id, b.note || 'set from Suspense', id]); n++; }
        if (b.action === 'ignore')    { run("UPDATE bank_transactions SET status='ignored', suspense_note=? WHERE bt_id=?", [b.note || 'set aside', id]); n++; }
      }
      for (const id of txnIds) {
        if (b.action === 'external')  { run('UPDATE transactions SET is_external=1, suspense_note=? WHERE txn_id=?', [b.note || 'not Swabha\'s own trade', id]); n++; }
        if (b.action === 'actual')    { run('UPDATE transactions SET is_external=0, suspense_note=NULL, needs_review=0 WHERE txn_id=?', [id]); n++; }
        if (b.action === 'category' && cat) { run('UPDATE transactions SET category_id=? WHERE txn_id=?', [cat.category_id, id]); n++; }
        if (b.action === 'cleared')   { run('UPDATE transactions SET needs_review=0 WHERE txn_id=?', [id]);
                                        run('UPDATE data_flags SET resolved=1 WHERE txn_id=?', [id]); n++; }
      }
      audit({ actor: user.username, table: 'suspense', rowId: [...bankIds, ...txnIds].join(','),
              action: 'update', newValue: b.action, note: b.note || null });
    });
    ok(res, { updated: n });
  },

  // ------------------------------------------------- staff
  'GET /api/staff': (q_, res, { user, url }) => {
    if (!need(res, user, 'finance.view')) return;
    const month = url.searchParams.get('month') || null;
    const staff = all(`SELECT c.*,
        (SELECT count(DISTINCT a.month) FROM attendance a WHERE a.cleaner_id=c.cleaner_id) att_months,
        (SELECT coalesce(sum(a.present),0) FROM attendance a WHERE a.cleaner_id=c.cleaner_id) present,
        (SELECT coalesce(sum(a.absent),0)  FROM attendance a WHERE a.cleaner_id=c.cleaner_id) absent,
        (SELECT count(*) FROM property_cleaners pc WHERE pc.cleaner_id=c.cleaner_id) props,
        (SELECT count(*) FROM assets s WHERE s.custodian_id=c.cleaner_id) assets
      FROM cleaners c ORDER BY c.active DESC, present DESC, c.name`);
    const months = all(`SELECT month AS key, count(*) people,
        coalesce(sum(present),0) present, coalesce(sum(absent),0) absent
      FROM attendance GROUP BY 1 ORDER BY 1`);
    const perMonth = month ? all(`SELECT a.*, c.name, c.employer_cost, c.on_roll
        FROM attendance a LEFT JOIN cleaners c USING(cleaner_id)
        WHERE a.month=? ORDER BY a.present DESC`, [month]) : [];
    const cur = staff.filter(s2 => s2.active);
    ok(res, { staff, months, perMonth, month,
      totals: {
        current: cur.length, former: staff.length - cur.length,
        on_roll: cur.filter(s2 => s2.on_roll).length,
        cash: cur.filter(s2 => !s2.on_roll).length,
        ctc: cur.reduce((a, s2) => a + (s2.employer_cost || 0), 0),
        missing_salary: cur.filter(s2 => !s2.employer_cost).length,
        attendance_months: months.length,
      },
      gaps: all(`SELECT * FROM data_gaps WHERE status='open' ORDER BY area, period`) });
  },

  'POST /api/staff/save': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const b = body || {};
    const cur = b.cleaner_id ? get('SELECT * FROM cleaners WHERE cleaner_id=?', [b.cleaner_id]) : null;
    const fields = { name: b.name, monthly_salary: b.monthly_salary === '' ? null : Number(b.monthly_salary),
      employer_cost: b.employer_cost === '' ? null : Number(b.employer_cost),
      pay_type: b.pay_type || 'monthly_salary', pay_rate: b.pay_rate === '' ? null : Number(b.pay_rate),
      on_roll: b.on_roll ? 1 : 0, active: b.active ? 1 : 0,
      joined_month: b.joined_month || null, exit_month: b.exit_month || null, notes: b.notes || null };
    if (cur) {
      const sets = [], vals = [];
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        if (String(cur[k] ?? '') === String(v ?? '')) continue;
        sets.push(`${k}=?`); vals.push(v);
        audit({ actor: user.username, table: 'cleaners', rowId: b.cleaner_id, field: k,
                oldValue: cur[k], newValue: v, action: 'update' });
      }
      if (sets.length) run(`UPDATE cleaners SET ${sets.join(',')} WHERE cleaner_id=?`, [...vals, b.cleaner_id]);
      return ok(res, { cleaner_id: b.cleaner_id, changed: sets.length });
    }
    if (!fields.name) return fail(res, 400, 'a name is required');
    const cols = Object.keys(fields);
    const r = run(`INSERT INTO cleaners(${cols.join(',')},source_of_truth)
                   VALUES(${cols.map(() => '?').join(',')},'manual')`, Object.values(fields));
    audit({ actor: user.username, table: 'cleaners', rowId: r.lastInsertRowid, action: 'insert',
            newValue: fields.name });
    ok(res, { cleaner_id: Number(r.lastInsertRowid) });
  },

  'GET /api/gaps-list': (q_, res, { user }) =>
    need(res, user, 'finance.view') && ok(res, all('SELECT * FROM data_gaps ORDER BY status, area')),

  // ------------------------------------------------- assets & custody
  'GET /api/assets': (q_, res, { user }) => {
    if (!need(res, user, 'finance.view')) return;
    const assets = all(`SELECT a.*, c.name AS custodian, p.name AS property, pa.display_name AS supplier,
        (SELECT count(*) FROM asset_custody ac WHERE ac.asset_id=a.asset_id) AS handovers
      FROM assets a LEFT JOIN cleaners c ON c.cleaner_id=a.custodian_id
      LEFT JOIN properties p ON p.property_id=a.property_id
      LEFT JOIN parties pa ON pa.party_id=a.supplier_party_id
      ORDER BY a.status, a.cost DESC`);
    ok(res, { assets,
      totals: { count: assets.length,
                value: assets.filter(a => a.status !== 'written_off').reduce((x, a) => x + (a.cost || 0), 0),
                unassigned: assets.filter(a => !a.custodian_id && a.status === 'in_use').length,
                lost: assets.filter(a => a.status === 'lost').length },
      staff: all('SELECT cleaner_id, name, active FROM cleaners ORDER BY active DESC, name'),
      properties: all('SELECT property_id, name FROM properties ORDER BY name') });
  },

  'POST /api/assets/save': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const b = body || {};
    if (!b.name) return fail(res, 400, 'a name is required');
    const sup = b.supplier ? get('SELECT party_id FROM parties WHERE display_name=?', [b.supplier]) : null;
    const cols = ['name','category','serial_no','purchase_date','cost','supplier_party_id',
                  'custodian_id','property_id','condition','status','useful_life_months','notes'];
    const vals = [b.name, b.category || null, b.serial_no || null, b.purchase_date || null,
      b.cost === '' || b.cost == null ? null : Number(b.cost), sup?.party_id ?? null,
      b.custodian_id ? Number(b.custodian_id) : null, b.property_id || null,
      b.condition || 'working', b.status || 'in_use',
      b.useful_life_months ? Number(b.useful_life_months) : null, b.notes || null];
    let id = b.asset_id;
    tx(() => {
      if (id) {
        const cur = get('SELECT custodian_id FROM assets WHERE asset_id=?', [id]);
        run(`UPDATE assets SET ${cols.map(c => `${c}=?`).join(',')} WHERE asset_id=?`, [...vals, id]);
        // a change of custodian is a handover — record it with dates
        if (String(cur?.custodian_id ?? '') !== String(vals[6] ?? '')) {
          run(`UPDATE asset_custody SET to_date=date('now')
               WHERE asset_id=? AND to_date IS NULL`, [id]);
          if (vals[6]) run(`INSERT INTO asset_custody(asset_id,cleaner_id,from_date,note,actor)
                            VALUES(?,?,date('now'),?,?)`, [id, vals[6], 'custodian changed', user.username]);
          audit({ actor: user.username, table: 'assets', rowId: id, field: 'custodian_id',
                  oldValue: cur?.custodian_id, newValue: vals[6], action: 'update' });
        }
      } else {
        const r = run(`INSERT INTO assets(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, vals);
        id = Number(r.lastInsertRowid);
        if (vals[6]) run(`INSERT INTO asset_custody(asset_id,cleaner_id,from_date,note,actor)
                          VALUES(?,?,coalesce(?,date('now')),'first assignment',?)`,
                         [id, vals[6], b.purchase_date || null, user.username]);
        audit({ actor: user.username, table: 'assets', rowId: id, action: 'insert',
                newValue: `${b.name} ${b.cost ?? ''}` });
      }
    });
    ok(res, { asset_id: id });
  },

  'GET /api/assets/history': (q_, res, { user, url }) => {
    if (!need(res, user, 'finance.view')) return;
    const id = Number(url.searchParams.get('asset_id'));
    ok(res, all(`SELECT ac.*, c.name FROM asset_custody ac LEFT JOIN cleaners c USING(cleaner_id)
                 WHERE ac.asset_id=? ORDER BY ac.from_date DESC`, [id]));
  },

  'POST /api/assets/delete': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    run('DELETE FROM assets WHERE asset_id=?', [body?.asset_id]);
    audit({ actor: user.username, table: 'assets', rowId: body?.asset_id, action: 'delete' });
    ok(res, { ok: true });
  },

  // ------------------------------------------------- loans
  'GET /api/loans': (q_, res, { user }) => {
    if (!need(res, user, 'finance.view')) return;
    const loans = all(`SELECT l.*, a.name AS account, s.name AS asset_name,
        (SELECT count(*) FROM loan_payments lp WHERE lp.loan_id=l.loan_id) AS payments_made,
        (SELECT coalesce(sum(lp.amount),0) FROM loan_payments lp WHERE lp.loan_id=l.loan_id) AS paid
      FROM loans l LEFT JOIN accounts a USING(account_id)
      LEFT JOIN assets s ON s.asset_id=l.asset_id ORDER BY l.active DESC, l.emi DESC`);
    const enriched = loans.map(l => {
      const n = l.tenure_months || 0;
      const done = l.paid_count || l.payments_made || 0;
      const left = n ? Math.max(n - done, 0) : null;
      let end = l.end_month;
      if (!end && l.start_month && n) {
        const [y, m] = l.start_month.split('-').map(Number);
        const d = new Date(Date.UTC(y, m - 1 + n, 1));
        end = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      }
      return { ...l, months_left: left, computed_end: end,
               remaining: left != null && l.emi ? left * l.emi : null };
    });
    ok(res, { loans: enriched,
      totals: {
        monthly_emi: enriched.filter(l => l.active).reduce((a, l) => a + (l.emi || 0), 0),
        outstanding: enriched.filter(l => l.active)
          .reduce((a, l) => a + (l.outstanding ?? l.remaining ?? 0), 0),
        count: enriched.filter(l => l.active).length,
      },
      accounts: all('SELECT * FROM accounts ORDER BY name'),
      assets: all('SELECT asset_id, name FROM assets ORDER BY name') });
  },

  'POST /api/loans/save': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const b = body || {};
    if (!b.name || !(Number(b.emi) > 0 || Number(b.principal) > 0))
      return fail(res, 400, 'a name and either an EMI or a principal are required');
    const cols = ['name','lender','borrower','kind','principal','rate_pct','emi','emi_day',
                  'start_month','tenure_months','end_month','account_id','outstanding',
                  'purpose','asset_id','in_books','notes','active','paid_count'];
    const vals = cols.map(c => {
      const v = b[c];
      if (v === undefined || v === '') return c === 'active' ? 1 : c === 'in_books' ? 1 : null;
      return ['principal','rate_pct','emi','emi_day','tenure_months','outstanding','account_id',
              'asset_id','in_books','active','paid_count'].includes(c) ? Number(v) : v;
    });
    if (b.loan_id) {
      run(`UPDATE loans SET ${cols.map(c => `${c}=?`).join(',')} WHERE loan_id=?`, [...vals, b.loan_id]);
      audit({ actor: user.username, table: 'loans', rowId: b.loan_id, action: 'update', newValue: b.name });
      return ok(res, { loan_id: b.loan_id });
    }
    const r = run(`INSERT INTO loans(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, vals);
    audit({ actor: user.username, table: 'loans', rowId: r.lastInsertRowid, action: 'insert',
            newValue: `${b.name} EMI ${b.emi ?? ''} principal ${b.principal ?? ''}` });
    ok(res, { loan_id: Number(r.lastInsertRowid) });
  },

  'POST /api/loans/delete': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const cur = get('SELECT name FROM loans WHERE loan_id=?', [body?.loan_id]);
    if (!cur) return fail(res, 404, 'no such loan');
    run('DELETE FROM loans WHERE loan_id=?', [body.loan_id]);
    audit({ actor: user.username, table: 'loans', rowId: body.loan_id, action: 'delete', oldValue: cur.name });
    ok(res, { ok: true });
  },

  // ------------------------------------------------- expense heads
  'GET /api/expense-heads': (q_, res, { user, url }) => {
    if (!need(res, user, 'finance.view')) return;
    const month = url.searchParams.get('month') || REC.thisMonth();
    const heads = all(`SELECT h.*, c.name AS category, p.display_name AS party
                       FROM expense_head h LEFT JOIN categories c USING(category_id)
                       LEFT JOIN parties p ON p.party_id=h.party_id
                       ORDER BY h.group_name, h.name`);
    const withActual = heads.map(h => {
      let actual = null;
      if (h.category_id || h.party_id) {
        const w = ["t.month=?", "t.direction='out'", "t.status='Posted'"], pr = [month];
        if (h.category_id) { w.push('t.category_id=?'); pr.push(h.category_id); }
        if (h.party_id)    { w.push('t.party_id=?');    pr.push(h.party_id); }
        actual = get(`SELECT coalesce(sum(gross_amount),0) v FROM transactions t WHERE ${w.join(' AND ')}`, pr).v;
      }
      return { ...h, actual, variance: (actual != null && h.fixed_amount != null) ? actual - h.fixed_amount : null };
    });
    ok(res, { month, heads: withActual,
      totals: { fixed: withActual.filter(h => h.is_fixed && h.active).reduce((a, h) => a + (h.fixed_amount || 0), 0),
                actual: withActual.reduce((a, h) => a + (h.actual || 0), 0) },
      categories: all('SELECT name AS key, kind FROM categories ORDER BY kind, name') });
  },

  'POST /api/expense-heads/save': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const b = body || {};
    if (!b.name) return fail(res, 400, 'a name is required');
    const cat = b.category ? get('SELECT category_id FROM categories WHERE name=?', [b.category]) : null;
    const par = b.party ? get('SELECT party_id FROM parties WHERE display_name=?', [b.party]) : null;
    const vals = [b.name, b.group_name || 'Other', b.is_fixed ? 1 : 0,
                  b.fixed_amount === '' || b.fixed_amount == null ? null : Number(b.fixed_amount),
                  cat?.category_id ?? null, par?.party_id ?? null,
                  b.due_day ? Number(b.due_day) : null, b.active === false ? 0 : 1, b.notes || null];
    if (b.head_id) {
      run(`UPDATE expense_head SET name=?,group_name=?,is_fixed=?,fixed_amount=?,category_id=?,
           party_id=?,due_day=?,active=?,notes=? WHERE head_id=?`, [...vals, b.head_id]);
      audit({ actor: user.username, table: 'expense_head', rowId: b.head_id, action: 'update', newValue: b.name });
      return ok(res, { head_id: b.head_id });
    }
    const r = run(`INSERT INTO expense_head(name,group_name,is_fixed,fixed_amount,category_id,
                   party_id,due_day,active,notes) VALUES(?,?,?,?,?,?,?,?,?)`, vals);
    audit({ actor: user.username, table: 'expense_head', rowId: r.lastInsertRowid, action: 'insert', newValue: b.name });
    ok(res, { head_id: Number(r.lastInsertRowid) });
  },

  // ------------------------------------------------- suspense
  // Everything unresolved in one place: bank rows with no category, flagged entries,
  // entries awaiting review, pay proposals and the known data gaps.
  'GET /api/suspense': (q_, res, { user, url }) => {
    if (!need(res, user, 'finance.view')) return;
    const kind = url.searchParams.get('kind') || 'bank';
    const out = { kind };
    out.counts = {
      bank:     get(`SELECT count(*) n, coalesce(sum(debit),0) d, coalesce(sum(credit),0) c
                     FROM bank_transactions WHERE category_id IS NULL AND coalesce(is_external,0)=0`),
      flagged:  get(`SELECT count(DISTINCT df.txn_id) n FROM data_flags df WHERE df.resolved=0`),
      review:   get(`SELECT count(*) n FROM transactions WHERE needs_review=1 AND coalesce(is_external,0)=0`),
      external: get(`SELECT count(*) n, coalesce(sum(gross_amount),0) v FROM transactions WHERE is_external=1`),
      extbank:  get(`SELECT count(*) n FROM bank_transactions WHERE is_external=1`),
      proposals:get(`SELECT count(*) n FROM pay_proposals WHERE status='open'`),
      gaps:     get(`SELECT count(*) n FROM data_gaps WHERE status='open'`),
    };
    if (kind === 'bank')
      out.rows = all(`SELECT bt.*, b.nickname AS bank FROM bank_transactions bt
        JOIN bank_accounts b USING(bank_id)
        WHERE bt.category_id IS NULL AND coalesce(bt.is_external,0)=0
        ORDER BY (CASE WHEN bt.credit>0 THEN bt.credit ELSE bt.debit END) DESC LIMIT 400`);
    else if (kind === 'flagged')
      out.rows = all(`SELECT t.txn_id, t.txn_date, t.gross_amount, t.direction, t.narration, t.source,
          c.name AS category, p.display_name AS party,
          group_concat(df.flag_type || ': ' || df.message, ' | ') AS flags
        FROM transactions t JOIN data_flags df USING(txn_id)
        LEFT JOIN categories c USING(category_id) LEFT JOIN parties p ON p.party_id=t.party_id
        WHERE df.resolved=0 GROUP BY t.txn_id
        ORDER BY t.gross_amount DESC LIMIT 400`);
    else if (kind === 'review')
      out.rows = all(`SELECT t.txn_id, t.txn_date, t.gross_amount, t.direction, t.narration, t.source,
          c.name AS category, p.display_name AS party
        FROM transactions t LEFT JOIN categories c USING(category_id)
        LEFT JOIN parties p ON p.party_id=t.party_id
        WHERE t.needs_review=1 AND coalesce(t.is_external,0)=0
        ORDER BY t.gross_amount DESC LIMIT 400`);
    else if (kind === 'external') {
      out.rows = all(`SELECT t.txn_id, t.txn_date, t.gross_amount, t.direction, t.narration, t.source,
          t.suspense_note, c.name AS category, p.display_name AS party
        FROM transactions t LEFT JOIN categories c USING(category_id)
        LEFT JOIN parties p ON p.party_id=t.party_id
        WHERE t.is_external=1 ORDER BY t.txn_date DESC LIMIT 400`);
      out.bankRows = all(`SELECT bt.*, b.nickname AS bank FROM bank_transactions bt
        JOIN bank_accounts b USING(bank_id) WHERE bt.is_external=1 ORDER BY bt.txn_date DESC LIMIT 400`);
    }
    else if (kind === 'proposals')
      out.rows = all(`SELECT pp.*, c.name AS staff FROM pay_proposals pp
        LEFT JOIN cleaners c USING(cleaner_id) WHERE pp.status='open' ORDER BY pp.suggested DESC`);
    else if (kind === 'gaps') out.rows = all(`SELECT * FROM data_gaps ORDER BY status, area`);
    out.categories = all('SELECT name AS key, kind FROM categories ORDER BY kind, name');
    ok(res, out);
  },

  // mark as external / bring back to actuals / set a category — on either table
  'POST /api/suspense/act': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.edit')) return;
    const b = body || {};
    const bankIds = b.bt_ids || [], txnIds = b.txn_ids || [];
    if (!bankIds.length && !txnIds.length) return fail(res, 400, 'nothing selected');
    const cat = b.category ? get('SELECT category_id FROM categories WHERE name=?', [b.category]) : null;
    let n = 0;
    tx(() => {
      for (const id of bankIds) {
        if (b.action === 'external')  { run('UPDATE bank_transactions SET is_external=1, suspense_note=? WHERE bt_id=?', [b.note || 'not Swabha\'s own trade', id]); n++; }
        if (b.action === 'actual')    { run('UPDATE bank_transactions SET is_external=0, suspense_note=NULL WHERE bt_id=?', [id]); n++; }
        if (b.action === 'category' && cat) { run('UPDATE bank_transactions SET category_id=?, notes=? WHERE bt_id=?', [cat.category_id, b.note || 'set from Suspense', id]); n++; }
        if (b.action === 'ignore')    { run("UPDATE bank_transactions SET status='ignored', suspense_note=? WHERE bt_id=?", [b.note || 'set aside', id]); n++; }
      }
      for (const id of txnIds) {
        if (b.action === 'external')  { run('UPDATE transactions SET is_external=1, suspense_note=? WHERE txn_id=?', [b.note || 'not Swabha\'s own trade', id]); n++; }
        if (b.action === 'actual')    { run('UPDATE transactions SET is_external=0, suspense_note=NULL, needs_review=0 WHERE txn_id=?', [id]); n++; }
        if (b.action === 'category' && cat) { run('UPDATE transactions SET category_id=? WHERE txn_id=?', [cat.category_id, id]); n++; }
        if (b.action === 'cleared')   { run('UPDATE transactions SET needs_review=0 WHERE txn_id=?', [id]);
                                        run('UPDATE data_flags SET resolved=1 WHERE txn_id=?', [id]); n++; }
      }
      audit({ actor: user.username, table: 'suspense', rowId: [...bankIds, ...txnIds].join(','),
              action: 'update', newValue: b.action, note: b.note || null });
    });
    ok(res, { updated: n });
  },

  // ------------------------------------------------- staff facilities
  'GET /api/facilities': (q_, res, { user }) => {
    if (!need(res, user, 'finance.view')) return;
    ok(res, {
      items: all(`SELECT f.*, c.name AS category, p.display_name AS party,
                    (SELECT count(*) FROM staff_facility_item si WHERE si.item_id=f.item_id) AS users
                  FROM facility_item f LEFT JOIN categories c USING(category_id)
                  LEFT JOIN parties p ON p.party_id=f.party_id ORDER BY f.name`),
      assigned: all(`SELECT si.*, c.name AS staff, f.name AS item, f.fixed_amount, f.basis
                     FROM staff_facility_item si JOIN cleaners c USING(cleaner_id)
                     JOIN facility_item f USING(item_id) ORDER BY c.name, f.name`),
      staff: all(`SELECT cleaner_id, name, active, monthly_salary, employer_cost, on_roll
                  FROM cleaners ORDER BY active DESC, name`),
      categories: all('SELECT name AS key FROM categories ORDER BY name'),
    });
  },

  'POST /api/facilities/item': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const b = body || {};
    if (b.remove) { run('DELETE FROM facility_item WHERE item_id=?', [b.remove]);
      audit({ actor: user.username, table: 'facility_item', rowId: b.remove, action: 'delete' });
      return ok(res, { ok: true }); }
    const cat = b.category ? get('SELECT category_id FROM categories WHERE name=?', [b.category]) : null;
    const pool = get("SELECT pool_id FROM cost_pool WHERE name LIKE 'Guest house%'");
    const vals = [pool?.pool_id ?? null, b.name, b.basis || 'per_head',
                  b.fixed_amount === '' || b.fixed_amount == null ? null : Number(b.fixed_amount),
                  cat?.category_id ?? null, b.charge_to_ctc === false ? 0 : 1, b.notes || null];
    if (b.item_id) {
      run(`UPDATE facility_item SET pool_id=?,name=?,basis=?,fixed_amount=?,category_id=?,
           charge_to_ctc=?,notes=? WHERE item_id=?`, [...vals, b.item_id]);
      return ok(res, { item_id: b.item_id });
    }
    const r = run(`INSERT INTO facility_item(pool_id,name,basis,fixed_amount,category_id,charge_to_ctc,notes)
                   VALUES(?,?,?,?,?,?,?)`, vals);
    audit({ actor: user.username, table: 'facility_item', rowId: r.lastInsertRowid, action: 'insert', newValue: b.name });
    ok(res, { item_id: Number(r.lastInsertRowid) });
  },

  'POST /api/facilities/assign': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const b = body || {};
    if (b.remove) { run('DELETE FROM staff_facility_item WHERE sfi_id=?', [b.remove]);
      return ok(res, { ok: true }); }
    run(`INSERT OR REPLACE INTO staff_facility_item(cleaner_id,item_id,weight,from_month,to_month)
         VALUES(?,?,?,?,?)`,
      [b.cleaner_id, b.item_id, Number(b.weight || 1), b.from_month || '2025-04', b.to_month || null]);
    audit({ actor: user.username, table: 'staff_facility_item', rowId: `${b.cleaner_id}/${b.item_id}`,
            action: 'insert', note: 'facility assigned to employee' });
    ok(res, { ok: true });
  },

  'GET /api/costing': (q_, res, { user, url }) => {
    if (!need(res, user, 'finance.view')) return;
    const month = url.searchParams.get('month') || REC.thisMonth();
    ok(res, { ...COST.allocate(month), config: COST.facilities() });
  },

  'POST /api/costing/pool-source': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const b = body || {};
    if (b.remove) {
      run('DELETE FROM cost_pool_source WHERE src_id=?', [b.remove]);
      audit({ actor: user.username, table: 'cost_pool_source', rowId: b.remove, action: 'delete' });
      return ok(res, { ok: true });
    }
    const cat = b.category ? get('SELECT category_id FROM categories WHERE name=?', [b.category]) : null;
    const par = b.party ? get('SELECT party_id FROM parties WHERE display_name=?', [b.party]) : null;
    if (!cat && !par && !b.cleaner_id) return fail(res, 400, 'pick a category, a supplier, or a person');
    const r = run(`INSERT INTO cost_pool_source(pool_id,category_id,party_id,cleaner_id,note)
                   VALUES(?,?,?,?,?)`,
      [b.pool_id, cat?.category_id ?? null, par?.party_id ?? null, b.cleaner_id ?? null, b.note ?? null]);
    audit({ actor: user.username, table: 'cost_pool_source', rowId: r.lastInsertRowid, action: 'insert',
            newValue: b.category || b.party || `cleaner:${b.cleaner_id}` });
    ok(res, { src_id: Number(r.lastInsertRowid) });
  },

  'POST /api/costing/member': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const b = body || {};
    if (b.remove) {
      run('DELETE FROM staff_facility WHERE fac_id=?', [b.remove]);
      audit({ actor: user.username, table: 'staff_facility', rowId: b.remove, action: 'delete' });
      return ok(res, { ok: true });
    }
    run(`INSERT OR REPLACE INTO staff_facility(cleaner_id,pool_id,weight,from_month,to_month)
         VALUES(?,?,?,?,?)`,
      [b.cleaner_id, b.pool_id, Number(b.weight || 1), b.from_month || '2025-04', b.to_month || null]);
    audit({ actor: user.username, table: 'staff_facility', rowId: `${b.cleaner_id}/${b.pool_id}`,
            action: 'insert', note: 'added to facility pool' });
    ok(res, { ok: true });
  },

  'GET /api/billing-gap': (q_, res, { user, url }) => {
    if (!need(res, user, 'finance.view')) return;
    ok(res, BILLING.gap({ from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
  },

  'POST /api/billing-gap/resolve': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.entry')) return;
    const b = body || {};
    if (!b.party_name || !b.month || !b.action) return fail(res, 400, 'party, month and action required');
    if (['outside_tally','to_invoice'].includes(b.action) && !(Number(b.amount) > 0))
      return fail(res, 400, 'an amount is required for this action');
    try { ok(res, BILLING.resolve({ ...b, actor: user.username })); }
    catch (e) { fail(res, 400, e.message); }
  },

  'GET /api/ratecard': (q_, res, { user }) =>
    need(res, user, 'finance.view') && ok(res, BILLING.rateCard()),

  'POST /api/ratecard/save': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const b = body || {};
    if (b.rate_id) {
      const cur = get('SELECT * FROM rate_card WHERE rate_id=?', [b.rate_id]);
      if (!cur) return fail(res, 404, 'no such rate');
      run('UPDATE rate_card SET base_rate=?, gst_rate=?, valid_from=?, notes=? WHERE rate_id=?',
          [Number(b.base_rate), Number(b.gst_rate ?? cur.gst_rate), b.valid_from || cur.valid_from,
           b.notes ?? cur.notes, b.rate_id]);
      if (Number(cur.base_rate) !== Number(b.base_rate))
        audit({ actor: user.username, table: 'rate_card', rowId: b.rate_id, field: 'base_rate',
                oldValue: cur.base_rate, newValue: b.base_rate, action: 'update' });
      return ok(res, { ok: true });
    }
    const r = run(`INSERT INTO party_rate_override(party_name,service,size_key,item,base_rate,gst_rate,valid_from,notes)
                   VALUES(?,?,?,?,?,?,?,?)`,
      [b.party_name, b.service, b.size_key || null, b.item || null, Number(b.base_rate),
       Number(b.gst_rate ?? 18), b.valid_from || '2025-04-01', b.notes || null]);
    audit({ actor: user.username, table: 'party_rate_override', rowId: r.lastInsertRowid,
            action: 'insert', newValue: `${b.party_name} ${b.service} ${b.base_rate}` });
    ok(res, { ovr_id: Number(r.lastInsertRowid) });
  },

  // ------------------------------------------------- WhatsApp payment log
  // Parse only. Returns a proposal for review — a chat message is evidence of a
  // payment, not a ledger entry, so nothing is written here.
  'POST /api/whatsapp/parse': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.entry')) return;
    const text = body?.text || '';
    if (text.length < 20) return fail(res, 400, 'paste the exported chat text');
    if (text.length > 8e6) return fail(res, 400, 'chat too large — split it by month');
    const r = WA.parse(text, { dateOrder: body?.dateOrder || 'dmy' });
    r.proposals = WA.reconcile(r.proposals);
    r.summary.already_in_ledger = r.proposals.filter(p => p.already_in_ledger).length;
    ok(res, r);
  },

  // ------------------------------------------------- fixed monthly in & out
  'GET /api/recurring': (q_, res, { user, url }) => {
    if (!need(res, user, 'finance.view')) return;
    const month = url.searchParams.get('month') || REC.thisMonth();
    ok(res, { month, prev: REC.monthAdd(month, -1), next: REC.monthAdd(month, 1),
              ...REC.preview(month) });
  },

  'POST /api/recurring/save': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const b = body || {};
    if (!b.name || !b.amount) return fail(res, 400, 'name and amount are required');
    const cat = get('SELECT category_id FROM categories WHERE name=?', [b.category])
             || get("SELECT category_id FROM categories WHERE name='Unclassified'");
    const pid = b.party ? get('SELECT party_id FROM parties WHERE display_name=?', [b.party])?.party_id : null;
    const fields = [b.name, b.direction === 'in' ? 'in' : 'out', cat.category_id, pid,
      b.property_id || null, Number(b.amount), Number(b.day_of_month || 1),
      b.payment_mode || null, Number(b.gst_rate || 0),
      b.start_month || REC.thisMonth(), b.end_month || null, b.active === false ? 0 : 1, b.notes || null];
    if (b.rec_id) {
      const cur = get('SELECT * FROM recurring_items WHERE rec_id=?', [b.rec_id]);
      if (!cur) return fail(res, 404, 'not found');
      run(`UPDATE recurring_items SET name=?,direction=?,category_id=?,party_id=?,property_id=?,
             amount=?,day_of_month=?,payment_mode=?,gst_rate=?,start_month=?,end_month=?,active=?,notes=?
           WHERE rec_id=?`, [...fields, b.rec_id]);
      if (Number(cur.amount) !== Number(b.amount))
        audit({ actor: user.username, table: 'recurring_items', rowId: b.rec_id, field: 'amount',
                oldValue: cur.amount, newValue: b.amount, action: 'update' });
      return ok(res, { rec_id: b.rec_id });
    }
    const r = run(`INSERT INTO recurring_items(name,direction,category_id,party_id,property_id,
        amount,day_of_month,payment_mode,gst_rate,start_month,end_month,active,notes)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, fields);
    audit({ actor: user.username, table: 'recurring_items', rowId: r.lastInsertRowid,
            action: 'insert', note: `${b.direction === 'in' ? 'fixed income' : 'fixed cost'}: ${b.name} ${b.amount}` });
    ok(res, { rec_id: Number(r.lastInsertRowid) });
  },

  // change / skip / stop one item from a given month — history is kept
  'POST /api/recurring/change': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const { rec_id, month, action, amount, note } = body || {};
    if (!rec_id || !month || !action) return fail(res, 400, 'rec_id, month and action required');
    run(`INSERT INTO recurring_changes(rec_id,month,amount,action,note,actor) VALUES(?,?,?,?,?,?)`,
        [rec_id, month, amount ?? null, action, note || null, user.username]);
    audit({ actor: user.username, table: 'recurring_items', rowId: rec_id, field: action,
            newValue: amount ?? '', action: 'update', note: `from ${month}: ${action} ${note || ''}` });
    ok(res, { ok: true });
  },

  'POST /api/recurring/delete': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const cur = get('SELECT * FROM recurring_items WHERE rec_id=?', [body?.rec_id]);
    if (!cur) return fail(res, 404, 'not found');
    run('DELETE FROM recurring_items WHERE rec_id=?', [body.rec_id]);
    audit({ actor: user.username, table: 'recurring_items', rowId: body.rec_id, action: 'delete',
            oldValue: `${cur.name} ${cur.amount}`, note: 'removed' });
    ok(res, { ok: true });
  },

  'POST /api/recurring/post': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.entry')) return;
    const month = body?.month || REC.thisMonth();
    ok(res, REC.post(month, user.username, body?.rec_ids || null));
  },

  // change an item to its REAL start date and post every month that was missed
  'POST /api/recurring/backfill': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.entry')) return;
    const { rec_id, from_month, to_month } = body || {};
    if (!rec_id || !/^\d{4}-\d{2}$/.test(from_month || ''))
      return fail(res, 400, 'rec_id and from_month (yyyy-mm) are required');
    try { ok(res, REC.backfill(Number(rec_id), from_month, to_month || null, user.username)); }
    catch (e) { fail(res, 400, e.message); }
  },

  'POST /api/recurring/generate': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    ok(res, REC.generateFromPackages(user.username));
  },

  // ------------------------------------------------- people
  'GET /api/users': (q_, res, { user }) => {
    if (!need(res, user, 'finance.admin')) return;
    ok(res, {
      users: all(`SELECT user_id, username, full_name, perms, active, created_at, last_login,
                    (SELECT count(*) FROM sessions s WHERE s.user_id=u.user_id
                      AND s.expires_at > datetime('now')) AS live_sessions
                  FROM users u ORDER BY user_id`),
      permissions: auth.PERMS.map(([key, label]) => ({ key, label })),
      me: user.user_id,
    });
  },

  'POST /api/users/create': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.admin')) return;
    const { username, fullName, password, perms } = body || {};
    if (!username || !password) return fail(res, 400, 'username and password are required');
    if (String(password).length < 8) return fail(res, 400, 'password must be at least 8 characters');
    if (get('SELECT 1 x FROM users WHERE username=?', [username])) return fail(res, 409, 'that username is taken');
    const clean = String(perms || 'finance.view').split(',').map(s2 => s2.trim())
      .filter(s2 => auth.PERMS.some(([k]) => k === s2));
    if (!clean.length) clean.push('finance.view');
    const u = auth.createUser({ username, fullName, password, perms: clean.join(',') });
    audit({ actor: user.username, table: 'users', rowId: u.user_id, action: 'insert',
            newValue: clean.join(','), note: `added ${username}` });
    ok(res, { user: u });
  },

  'POST /api/users/update': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.admin')) return;
    const { user_id, perms, active, full_name } = body || {};
    const cur = get('SELECT * FROM users WHERE user_id=?', [user_id]);
    if (!cur) return fail(res, 404, 'no such user');
    const nowAdmin = String(perms ?? cur.perms).includes('finance.admin');
    const wasAdmin = String(cur.perms).includes('finance.admin');
    const stillOn  = active === undefined ? cur.active : (active ? 1 : 0);
    // never let the last administrator be removed or switched off
    if ((wasAdmin && (!nowAdmin || !stillOn)) && auth.adminCount() <= 1)
      return fail(res, 400, 'this is the only administrator — make someone else an administrator first');
    tx(() => {
      if (perms !== undefined) {
        const clean = String(perms).split(',').map(s2 => s2.trim())
          .filter(s2 => auth.PERMS.some(([k]) => k === s2)).join(',');
        run('UPDATE users SET perms=? WHERE user_id=?', [clean, user_id]);
        audit({ actor: user.username, table: 'users', rowId: user_id, field: 'perms',
                oldValue: cur.perms, newValue: clean, action: 'update' });
      }
      if (active !== undefined) {
        run('UPDATE users SET active=? WHERE user_id=?', [active ? 1 : 0, user_id]);
        if (!active) run('DELETE FROM sessions WHERE user_id=?', [user_id]);
        audit({ actor: user.username, table: 'users', rowId: user_id, field: 'active',
                oldValue: cur.active, newValue: active ? 1 : 0, action: 'update' });
      }
      if (full_name !== undefined) run('UPDATE users SET full_name=? WHERE user_id=?', [full_name, user_id]);
    });
    ok(res, { ok: true });
  },

  'POST /api/users/password': (req, res, { body, user }) => {
    if (!user) return fail(res, 401, 'not signed in');
    const { user_id, password, current } = body || {};
    const target = Number(user_id || user.user_id);
    const self = target === user.user_id;
    if (!self && !auth.can(user, 'finance.admin')) return fail(res, 403, 'needs finance.admin');
    if (String(password || '').length < 8) return fail(res, 400, 'password must be at least 8 characters');
    if (self && !auth.verify(user.username, current || '')) return fail(res, 400, 'current password is wrong');
    auth.setPassword(target, password);
    audit({ actor: user.username, table: 'users', rowId: target, field: 'password',
            action: 'update', note: self ? 'changed own password' : 'password reset by admin' });
    ok(res, { ok: true, signedOutEverywhere: true });
  },

  'POST /api/users/delete': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.admin')) return;
    const id = Number(body?.user_id);
    if (id === user.user_id) return fail(res, 400, 'you cannot delete your own account');
    const cur = get('SELECT * FROM users WHERE user_id=?', [id]);
    if (!cur) return fail(res, 404, 'no such user');
    if (String(cur.perms).includes('finance.admin') && auth.adminCount() <= 1)
      return fail(res, 400, 'this is the only administrator');
    tx(() => {
      run('DELETE FROM sessions WHERE user_id=?', [id]);
      run('DELETE FROM users WHERE user_id=?', [id]);
      audit({ actor: user.username, table: 'users', rowId: id, action: 'delete',
              oldValue: cur.username, note: 'account removed' });
    });
    ok(res, { ok: true });
  },

  'POST /api/flag/resolve': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.edit')) return;
    run('UPDATE data_flags SET resolved=1 WHERE flag_id=?', [Number(body?.flag_id)]);
    audit({ actor:user.username, table:'data_flags', rowId:body?.flag_id, action:'update', note:'resolved' });
    ok(res, { ok: true });
  },


  'GET /api/disputed': (req, res, { user }) => {
    if (!require('./auth').can(user, 'finance.view')) return require('./api').fail(res, 403, 'no access');
    const db = require('./db');
    const rows = db.all(`
      SELECT txn_id, txn_date, gross_amount, narration, category_id, needs_review
      FROM transactions
      WHERE status='Posted' AND (needs_review=1 OR category_id IS NULL)
      ORDER BY txn_date DESC
      LIMIT 100
    `);
    require('./api').ok(res, { entries: rows, count: rows.length });
  },

  'POST /api/template/export': (req, res, { body }) => {
    const type = (body?.type || 'revenue').toLowerCase();
    const templates = {
      'revenue': 'Date,Host,Property,Service Type,Amount,Description,Status\n2026-09-01,Host Name,P001,Cleaning,5000,Monthly cleaning revenue,Posted',
      'expense': 'Date,Vendor,Category,Amount,Description,Property,Status\n2026-09-01,Vendor Name,Supplies,2000,Cleaning supplies,P001,Posted',
      'salary': 'Date,Employee Name,Amount,Notes,Status\n2026-09-01,Employee Name,15000,Monthly salary,Posted',
      'outstanding': 'Invoice#,Customer,Property,Amount,Due Date,Status\nINV-001,Customer Name,P001,5000,2026-10-01,Outstanding',
      'disputed': 'Entry ID,Date,Amount,Current Category,Suggested Category,Reason,Action\n12345,2026-09-01,5000,Other,Supplies,Wrong category,Approve'
    };
    const csv = templates[type] || templates['revenue'];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="swabha_${type}_template.csv"`);
    res.end(csv);
  },

  'POST /api/template/upload': (req, res, { user, body }) => {
    if (!require('./auth').can(user, 'finance.edit')) return require('./api').fail(res, 403, 'no access');
    // Placeholder - file upload handling would go here
    // For now, return success message
    require('./api').ok(res, { ok: true, count: 0, message: 'Template upload ready - upload CSV file' });
  },

  
  'POST /api/masters/party': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.edit')) return;
    const { display_name, kind } = body || {};
    if (!display_name) return fail(res, 400, 'party name required');
    try {
      run('INSERT INTO parties (display_name, kind, match_status) VALUES (?, ?, ?)',
          [display_name, kind || 'vendor', 'confirmed']);
      const party = get('SELECT * FROM parties WHERE display_name=?', [display_name]);
      audit({ actor: user.username, table: 'parties', rowId: party?.party_id, action: 'insert',
              note: `quick-added ${display_name}` });
      ok(res, { ok: true, party_id: party?.party_id });
    } catch (e) {
      fail(res, 400, e.message);
    }
  },

  'POST /api/masters/category': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.edit')) return;
    const { name, kind } = body || {};
    if (!name) return fail(res, 400, 'category name required');
    try {
      run('INSERT INTO categories (name, kind) VALUES (?, ?)',
          [name, kind || 'opex']);
      const cat = get('SELECT * FROM categories WHERE name=?', [name]);
      audit({ actor: user.username, table: 'categories', rowId: cat?.category_id, action: 'insert',
              note: `quick-added ${name}` });
      ok(res, { ok: true, category_id: cat?.category_id });
    } catch (e) {
      fail(res, 400, e.message);
    }
  },

  // ------------------------------------------------------------- hosts CRUD
  'POST /api/masters/host/create': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const { name, phone, email, notes } = body || {};
    if (!name) return fail(res, 400, 'host name required');
    if (get('SELECT 1 x FROM hosts WHERE name=?', [name])) return fail(res, 409, 'that host already exists');
    try {
      run(`INSERT INTO hosts(name, phone, email, notes, active, joined_date)
           VALUES(?,?,?,?,1,date('now'))`, [name, phone || null, email || null, notes || null]);
      const h = get('SELECT * FROM hosts WHERE name=?', [name]);
      audit({ actor: user.username, table: 'hosts', rowId: h.host_id, action: 'insert', note: `added host ${name}` });
      ok(res, { ok: true, host: h });
    } catch (e) { fail(res, 400, e.message); }
  },

  'POST /api/masters/host/update': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const { host_id, name, phone, email, notes, active } = body || {};
    const cur = get('SELECT * FROM hosts WHERE host_id=?', [host_id]);
    if (!cur) return fail(res, 404, 'unknown host');
    tx(() => {
      for (const [k, v] of Object.entries({ name, phone, email, notes, active })) {
        if (v === undefined) continue;
        if (String(cur[k] ?? '') === String(v ?? '')) continue;
        run(`UPDATE hosts SET ${k}=? WHERE host_id=?`, [v, host_id]);
        audit({ actor: user.username, table: 'hosts', rowId: host_id, field: k,
                oldValue: cur[k], newValue: v, action: 'update' });
      }
    });
    ok(res, get('SELECT * FROM hosts WHERE host_id=?', [host_id]));
  },

  // --------------------------------------------------------- properties CRUD
  'POST /api/masters/property/create': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const { property_id, name, host_id, type, city, bedrooms, bathrooms, max_guests,
            package_type, package_rate, per_cleaning_price, cleanings_included, notes } = body || {};
    if (!name || !host_id) return fail(res, 400, 'property name & host required');
    const host = get('SELECT host_id FROM hosts WHERE host_id=?', [host_id]);
    if (!host) return fail(res, 404, 'unknown host');
    const pid = property_id || `P${Date.now().toString().slice(-6)}`;
    if (get('SELECT 1 x FROM properties WHERE property_id=?', [pid])) return fail(res, 409, 'that property ID already exists');
    try {
      run(`INSERT INTO properties(property_id,name,host_id,type,city,bedrooms,bathrooms,max_guests,
             onboarding_date,package_type,package_rate,per_cleaning_price,cleanings_included,active,notes)
           VALUES(?,?,?,?,?,?,?,?,date('now'),?,?,?,?,1,?)`,
          [pid, name, host_id, type || null, city || null, bedrooms || null, bathrooms || null,
           max_guests || null, package_type || null, package_rate || null, per_cleaning_price || null,
           cleanings_included || null, notes || null]);
      audit({ actor: user.username, table: 'properties', rowId: pid, action: 'insert', note: `added property ${name}` });
      ok(res, { ok: true, property_id: pid });
    } catch (e) { fail(res, 400, e.message); }
  },

  'POST /api/masters/property/edit': (req, res, { body, user }) => {
    if (!need(res, user, 'finance.masters')) return;
    const { property_id, name, type, city, bedrooms, bathrooms, max_guests, host_id, active, notes } = body || {};
    const cur = get('SELECT * FROM properties WHERE property_id=?', [property_id]);
    if (!cur) return fail(res, 404, 'unknown property');
    tx(() => {
      for (const [k, v] of Object.entries({ name, type, city, bedrooms, bathrooms, max_guests, host_id, active, notes })) {
        if (v === undefined) continue;
        if (String(cur[k] ?? '') === String(v ?? '')) continue;
        run(`UPDATE properties SET ${k}=? WHERE property_id=?`, [v, property_id]);
        audit({ actor: user.username, table: 'properties', rowId: property_id, field: k,
                oldValue: cur[k], newValue: v, action: 'update' });
      }
    });
    ok(res, get('SELECT * FROM properties WHERE property_id=?', [property_id]));
  },


    'GET /api/audit': (q_, res, { user }) => need(res, user, 'finance.view') &&
    ok(res, all('SELECT * FROM audit_log ORDER BY log_id DESC LIMIT 200')),
};

const cookie = v => `${auth.COOKIE}=${encodeURIComponent(v)}; Path=/; Max-Age=${auth.DAYS*86400}; HttpOnly; SameSite=Lax`;

module.exports = { routes, fail };
