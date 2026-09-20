// A customer is usually a brand covering several flats ("Pinkcity BnB" = 11 units).
// Match on the brand token, then attach every property that carries it.
const { all, get, run, tx, audit } = require('../server/db');
const L = x => 'Rs ' + Math.round(x || 0).toLocaleString('en-IN');
const sq = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// brand key -> [party name patterns]
const BRANDS = [
  ['pinkcity',   ['pinkcitybnb', 'pinkcityluxe', 'pinkcityretreat'], p => /pink\s*city/i.test(p.name)],
  ['evergreen',  ['evergreenescapes', 'evergreenescape'],            p => /evergreen/i.test(p.name)],
  ['lalluji',    ['lallujiluxe'],                                     p => /lalluji/i.test(p.name)],
  ['cozyconnect',['sarfarazlaluenterprises', 'cozyconnect'],          p => /cozy\s*connect/i.test(p.name)],
  ['58gram',     ['58gram', '58grams'],                               p => /58\s*gram/i.test(p.name)],
  ['eclore',     ['eclorehospitality'],                               p => /eclore/i.test(p.name)],
  ['upasana',    ['upasanafirstavenue'],                              p => /upasana/i.test(p.name)],
  ['plum',       ['plumexperiences'],                                 p => /plum/i.test(p.name)],
  ['bluesroyal', ['fauziabluesroyals', 'fauziapatel'],                p => /blues?\s*&?\s*royal/i.test(p.name)],
  ['talvista',   ['ankishm', 'talvista'],                             p => /tal\s*vista/i.test(p.name)],
  ['palmstay',   ['palm34', 'palmleisurestays', 'palmleisure'],       p => /palm/i.test(p.name)],
  ['houseofnivesa',['houseofnivesa', 'tussar'],                       p => /nivesa/i.test(p.name)],
  ['peacehouse', ['peacehouse', 'saltbypeacehouse', 'mrinalpeacehouse', 'amberbypeacehouse'],
                                                                      p => /peace\s*house/i.test(p.name)],
  ['mysticcastle',['prashulmysticcastle', 'mysticcastle'],            p => /mystic\s*castle/i.test(p.name)],
  ['thinkingthree',['thethinkingthree'],                              p => /orange oasis|caket|orchid opera|7th avenue|blue moon/i.test(p.name)],
  ['serenecedars',['theserenecedars'],                                p => /serene|cedar/i.test(p.name)],
  ['stayora',    ['ananyastayorahomes', 'stayorahomes'],              p => /stayora/i.test(p.name)],
  ['velvetkey',  ['velvetkey', 'yadavienterprises', 'thevelvetnook'], p => /velvet/i.test(p.name)],
  ['judgeabode', ['palmleisurestays'],                                p => /judge abode|borderman|palm vardante/i.test(p.name)],
];

const props = all('SELECT property_id, name, active FROM properties');
const parties = all(`SELECT p.party_id, p.display_name,
   (SELECT coalesce(sum(t.gross_amount),0) FROM transactions t JOIN categories c USING(category_id)
     WHERE t.party_id=p.party_id AND c.kind='revenue' AND t.direction='in' AND t.status='Posted') v
  FROM parties p WHERE coalesce(p.kind,'') <> 'internal'`);

const applied = [], missed = [];
tx(() => {
  for (const [key, patterns, test] of BRANDS) {
    const matchedProps = props.filter(test);
    if (!matchedProps.length) { missed.push([key, 'no property carries this brand']); continue; }
    const matchedParties = parties.filter(pa => patterns.some(pt => sq(pa.display_name).includes(pt)
                                                              || pt.includes(sq(pa.display_name))));
    if (!matchedParties.length) { missed.push([key, 'no customer matches these patterns']); continue; }
    for (const pa of matchedParties) {
      // an existing confirmed link is never overwritten
      run('DELETE FROM party_properties WHERE party_id=? AND source LIKE ?', [pa.party_id, 'auto%']);
      for (const pr of matchedProps)
        run(`INSERT OR IGNORE INTO party_properties(party_id,property_id,confidence,source)
             VALUES(?,?,0.9,'auto_brand')`, [pa.party_id, pr.property_id]);
      // only point transactions at a single property when the brand has exactly one
      let moved = 0;
      if (matchedProps.length === 1)
        moved = run('UPDATE transactions SET property_id=? WHERE party_id=? AND property_id IS NULL',
                    [matchedProps[0].property_id, pa.party_id]).changes;
      applied.push({ party: pa.display_name, v: pa.v, props: matchedProps.length, moved,
                     ids: matchedProps.map(p => p.property_id) });
    }
  }
  audit({ actor: 'system', table: 'party_properties', action: 'insert',
    note: `brand-level mapping: ${applied.length} customers linked to their properties` });
});

console.log('MAPPED BY BRAND');
console.log('  ' + 'customer'.padEnd(32) + 'revenue'.padStart(13) + '  units  txns moved   properties');
for (const a of applied.sort((x, y) => y.v - x.v))
  console.log('  ' + a.party.slice(0, 31).padEnd(32) + L(a.v).padStart(13) + String(a.props).padStart(7) +
    String(a.moved).padStart(6) + '   ' + a.ids.slice(0, 6).join(',') + (a.ids.length > 6 ? ' +' + (a.ids.length - 6) : ''));
if (missed.length) {
  console.log('\n  brands with no match:');
  for (const [k, why] of missed) console.log('    ' + k.padEnd(18) + why);
}
const att = get(`SELECT coalesce(sum(CASE WHEN t.property_id IS NULL THEN t.gross_amount END),0) un,
   coalesce(sum(t.gross_amount),0) tot FROM transactions t JOIN categories c USING(category_id)
   WHERE c.kind='revenue' AND t.status='Posted' AND t.direction='in'`);
console.log(`\n  revenue now tied to a property: ${L(att.tot - att.un)} of ${L(att.tot)} (${(100*(att.tot-att.un)/att.tot).toFixed(1)}%)`);
console.log(`  customers linked to at least one property: ${get('SELECT count(DISTINCT party_id) n FROM party_properties').n}`);
