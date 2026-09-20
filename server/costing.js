// Two-stage staff costing.
//  Stage 1: pool guest-house rent, electricity, groceries and the cook's pay, then
//           share it across the staff who actually live there -> fully loaded cost.
//  Stage 2: charge that loaded cost out to customers in proportion to visits logged.
// Nothing is apportioned by guesswork: the roster and the volume log carry the weights.
const { all, get } = require('./db');

// what the pool actually cost in a given month
function poolCost(pool_id, month) {
  const srcs = all('SELECT * FROM cost_pool_source WHERE pool_id=?', [pool_id]);
  if (!srcs.length) return { total: 0, lines: [] };
  const lines = [];
  for (const s of srcs) {
    if (s.cleaner_id) {                       // a person's salary feeding the pool (the cook)
      const c = get('SELECT name, employer_cost, monthly_salary FROM cleaners WHERE cleaner_id=?', [s.cleaner_id]);
      if (c) lines.push({ what: c.name, amount: c.employer_cost || c.monthly_salary || 0, kind: 'salary' });
      continue;
    }
    const w = ['t.month = ?', "t.direction='out'", "t.status='Posted'"], p = [month];
    if (s.category_id) { w.push('t.category_id = ?'); p.push(s.category_id); }
    if (s.party_id)    { w.push('t.party_id = ?');    p.push(s.party_id); }
    const r = get(`SELECT coalesce(sum(t.gross_amount),0) v, count(*) n FROM transactions t
                   WHERE ${w.join(' AND ')}`, p);
    const label = s.category_id
      ? get('SELECT name FROM categories WHERE category_id=?', [s.category_id])?.name
      : get('SELECT display_name FROM parties WHERE party_id=?', [s.party_id])?.display_name;
    if (r.v) lines.push({ what: label, amount: r.v, kind: 'spend', entries: r.n });
  }
  return { total: lines.reduce((a, l) => a + l.amount, 0), lines };
}

// stage 1 — loaded cost per person for a month, line by line
function loadedCost(month) {
  const staff = all(`SELECT cleaner_id, name, monthly_salary, employer_cost, on_roll, active
                     FROM cleaners WHERE active=1`);
  const items = all(`SELECT * FROM facility_item WHERE active=1`);
  const share = {}, detail = {}, itemDetail = [];

  for (const it of items) {
    const users = all(`SELECT cleaner_id, weight FROM staff_facility_item
                       WHERE item_id=? AND from_month<=? AND (to_month IS NULL OR to_month>=?)`,
                      [it.item_id, month, month]);
    // a fixed figure, or read the month's actual spend from the ledger
    let cost = it.fixed_amount;
    if (cost == null && (it.category_id || it.party_id)) {
      const w = ['t.month=?', "t.direction='out'", "t.status='Posted'"], pr = [month];
      if (it.category_id) { w.push('t.category_id=?'); pr.push(it.category_id); }
      if (it.party_id)    { w.push('t.party_id=?');    pr.push(it.party_id); }
      cost = get(`SELECT coalesce(sum(gross_amount),0) v FROM transactions t WHERE ${w.join(' AND ')}`, pr).v;
    }
    cost = cost || 0;
    const totalW = users.reduce((a, u) => a + (u.weight || 1), 0);
    itemDetail.push({ ...it, month_cost: cost, users: users.length,
                      per_head: totalW ? cost / totalW : 0,
                      source: it.fixed_amount != null ? 'fixed' : 'from ledger' });
    if (!totalW || !cost || !it.charge_to_ctc) continue;
    for (const u of users) {
      const amt = cost * ((u.weight || 1) / totalW);
      share[u.cleaner_id] = (share[u.cleaner_id] || 0) + amt;
      (detail[u.cleaner_id] ||= []).push({ item: it.name, amount: amt });
    }
  }

  const rows = staff.map(s2 => {
    const base = s2.employer_cost || s2.monthly_salary || 0;
    const facility = share[s2.cleaner_id] || 0;
    return { ...s2, base_cost: base, facility_cost: facility, loaded_cost: base + facility,
             facility_lines: detail[s2.cleaner_id] || [] };
  });
  return { month, rows, pools: itemDetail,
           total_base: rows.reduce((a, r) => a + r.base_cost, 0),
           total_facility: rows.reduce((a, r) => a + r.facility_cost, 0),
           total_loaded: rows.reduce((a, r) => a + r.loaded_cost, 0) };
}

// stage 2 — spread the loaded cost across customers by visits logged that month
function allocate(month) {
  const lc = loadedCost(month);
  const visits = all(`SELECT party_name, coalesce(sum(units),0) AS visits
                      FROM billing_expectation WHERE month=? AND service='cleaning'
                      GROUP BY party_name HAVING visits > 0`, [month]);
  const totalVisits = visits.reduce((a, v) => a + v.visits, 0);
  const perVisit = totalVisits ? lc.total_loaded / totalVisits : 0;
  const rows = visits.map(v => ({
    party_name: v.party_name, visits: v.visits,
    staff_cost: v.visits * perVisit,
    share: totalVisits ? (v.visits / totalVisits) * 100 : 0,
  })).sort((a, b) => b.staff_cost - a.staff_cost);
  return { month, per_visit: perVisit, total_visits: totalVisits,
           total_loaded: lc.total_loaded, rows, staff: lc.rows, pools: lc.pools,
           unallocated: totalVisits ? 0 : lc.total_loaded };
}

const facilities = () => ({
  pools: all(`SELECT p.*, (SELECT count(*) FROM staff_facility sf WHERE sf.pool_id=p.pool_id) AS users
              FROM cost_pool p ORDER BY p.name`),
  sources: all(`SELECT s.*, c.name AS category, pa.display_name AS party, cl.name AS cleaner
                FROM cost_pool_source s
                LEFT JOIN categories c USING(category_id)
                LEFT JOIN parties pa ON pa.party_id=s.party_id
                LEFT JOIN cleaners cl ON cl.cleaner_id=s.cleaner_id`),
  members: all(`SELECT sf.*, c.name FROM staff_facility sf JOIN cleaners c USING(cleaner_id)`),
  staff: all(`SELECT cleaner_id, name, monthly_salary, employer_cost, on_roll, active
              FROM cleaners ORDER BY active DESC, employer_cost DESC`),
});

module.exports = { poolCost, loadedCost, allocate, facilities };
