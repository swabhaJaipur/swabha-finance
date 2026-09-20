// Match customers to properties using every signal available, and score the confidence.
// Only unambiguous matches are applied; anything doubtful is listed for the owner.
const { all, get, run, tx, audit } = require('../server/db');

const norm = s => String(s || '').toLowerCase()
  .replace(/\(.*?\)/g, ' ')
  .replace(/\b(pvt|private|limited|ltd|llp|the|and|co|company|stays?|homes?|house|hospitality|enterprises?|associates?|bnb|villa|apartment|studio)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const squash = s => norm(s).replace(/ /g, '');
const toks = s => new Set(norm(s).split(' ').filter(t => t.length > 2));

const props = all(`SELECT p.property_id, p.name, p.active, h.name AS host
                   FROM properties p LEFT JOIN hosts h USING(host_id)`);
const parties = all(`SELECT p.party_id, p.display_name, p.kind,
    (SELECT coalesce(sum(t.gross_amount),0) FROM transactions t JOIN categories c USING(category_id)
      WHERE t.party_id=p.party_id AND c.kind='revenue' AND t.direction='in' AND t.status='Posted') v
  FROM parties p
  WHERE p.party_id NOT IN (SELECT party_id FROM party_properties)
    AND coalesce(p.kind,'') <> 'internal'
  ORDER BY v DESC`);

function score(partyName, prop) {
  const pn = squash(partyName), sn = squash(prop.name), hn = squash(prop.host || '');
  if (!pn) return 0;
  let best = 0, why = '';
  if (sn && pn === sn) return { s: 1.0, why: 'name is identical to the property' };
  if (sn && sn.length >= 5 && (pn.includes(sn) || sn.includes(pn))) {
    const r = Math.min(pn.length, sn.length) / Math.max(pn.length, sn.length);
    if (r > best) { best = 0.9 * r; why = 'party name contains the property name'; }
  }
  if (hn && hn.length >= 5 && (pn.includes(hn) || hn.includes(pn))) {
    const r = Math.min(pn.length, hn.length) / Math.max(pn.length, hn.length);
    if (0.85 * r > best) { best = 0.85 * r; why = 'party name matches the host of this property'; }
  }
  const A = toks(partyName), B = toks(prop.name), H = toks(prop.host || '');
  if (A.size && B.size) {
    const hit = [...A].filter(t => B.has(t)).length;
    const j = hit / new Set([...A, ...B]).size;
    if (j > best) { best = j; why = `${hit} word(s) shared with the property name`; }
  }
  if (A.size && H.size) {
    const hit = [...A].filter(t => H.has(t)).length;
    const j = 0.8 * (hit / new Set([...A, ...H]).size);
    if (j > best) { best = j; why = `${hit} word(s) shared with the host name`; }
  }
  return { s: best, why };
}

const auto = [], ask = [], none = [];
for (const pa of parties) {
  const scored = props.map(pr => ({ pr, ...score(pa.display_name, pr) }))
                      .filter(x => x.s >= 0.45).sort((a, b) => b.s - a.s);
  if (!scored.length) { none.push(pa); continue; }
  const top = scored[0];
  const rivals = scored.filter(x => x.s >= top.s - 0.06);
  // one clear winner => apply; several equally good => ask
  if (top.s >= 0.75 && rivals.length === 1) auto.push({ pa, ...top });
  else ask.push({ pa, options: scored.slice(0, 4) });
}

let applied = 0;
tx(() => {
  for (const a of auto) {
    run(`INSERT OR IGNORE INTO party_properties(party_id,property_id,confidence,source)
         VALUES(?,?,?,'auto_multi_signal')`, [a.pa.party_id, a.pr.property_id, +a.s.toFixed(2)]);
    const n = run(`UPDATE transactions SET property_id=? WHERE party_id=? AND property_id IS NULL`,
                  [a.pr.property_id, a.pa.party_id]);
    applied++;
  }
  if (applied) audit({ actor: 'system', table: 'party_properties', action: 'insert',
    note: `auto-mapped ${applied} customers to a property on an unambiguous name match` });
});

const L = x => 'Rs ' + Math.round(x || 0).toLocaleString('en-IN');
console.log(`AUTO-MAPPED (single clear match): ${auto.length}`);
for (const a of auto.slice(0, 25))
  console.log('  ' + a.pa.display_name.slice(0, 30).padEnd(32) + '-> ' + a.pr.property_id + ' ' +
    a.pr.name.slice(0, 26).padEnd(28) + String(a.s.toFixed(2)).padStart(5) + '  ' + a.why);
console.log();
console.log(`NEEDS YOUR CALL (several properties fit): ${ask.length}`);
for (const q of ask.filter(x => x.pa.v > 0).slice(0, 20)) {
  console.log('  ' + q.pa.display_name.slice(0, 34).padEnd(36) + L(q.pa.v).padStart(13));
  for (const o of q.options)
    console.log('        ' + o.s.toFixed(2) + '  ' + o.pr.property_id + ' ' + o.pr.name.slice(0, 30).padEnd(32) + (o.pr.host || '') );
}
console.log();
const withRev = none.filter(n => n.v > 0);
console.log(`NO PROPERTY RESEMBLES THE NAME: ${none.length} (${withRev.length} of them earn revenue)`);
for (const n of withRev.slice(0, 18))
  console.log('  ' + n.display_name.slice(0, 40).padEnd(42) + L(n.v).padStart(13));
