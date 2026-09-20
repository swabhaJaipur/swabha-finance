// Laundry is a distinct service line with its own economics, so it gets its own view
// rather than being buried inside "Service Revenue".
const { all, get } = require('./db');

function summary() {
  const tot = get(`SELECT
      coalesce(sum(taxable_laundry + nontax_laundry),0)           AS laundry,
      coalesce(sum(taxable_housekeeping + nontax_housekeeping),0) AS housekeeping,
      coalesce(sum(gst),0) AS gst, count(DISTINCT party_name) AS parties,
      count(DISTINCT month) AS months FROM service_summary`);

  const byMonth = all(`SELECT month AS key,
      coalesce(sum(taxable_laundry + nontax_laundry),0)           AS laundry,
      coalesce(sum(taxable_housekeeping + nontax_housekeeping),0) AS housekeeping,
      coalesce(sum(grand_total),0) AS total, count(*) AS txns
    FROM service_summary WHERE month IS NOT NULL GROUP BY 1 ORDER BY 1`);

  const byParty = all(`SELECT party_name AS key, party_id,
      coalesce(sum(taxable_laundry + nontax_laundry),0)           AS laundry,
      coalesce(sum(taxable_housekeeping + nontax_housekeeping),0) AS housekeeping,
      coalesce(sum(grand_total),0) AS total, count(*) AS txns
    FROM service_summary GROUP BY 1,2 ORDER BY laundry DESC`);

  // from the invoice line detail — laundry that is billed but not collected
  const owed = all(`SELECT coalesce(p.display_name, i.notes, '(unmatched)') AS key,
      coalesce(sum(i.laundry),0) AS laundry, coalesce(sum(i.cleaning),0) AS cleaning,
      coalesce(sum(i.total - i.received),0) AS balance
    FROM invoices i LEFT JOIN parties p USING(party_id)
    WHERE i.laundry > 0 GROUP BY 1 ORDER BY laundry DESC`);

  // service mix straight from the Tally line items
  const lines = all(`SELECT service AS key, count(*) AS txns, coalesce(sum(amount),0) AS gross
    FROM transaction_lines WHERE service IS NOT NULL GROUP BY 1 ORDER BY gross DESC`);

  const takers = byParty.filter(p => p.laundry > 0).length;
  return {
    totals: {
      ...tot,
      laundry_share: tot.laundry + tot.housekeeping
        ? (tot.laundry / (tot.laundry + tot.housekeeping)) * 100 : 0,
      attach_rate: byParty.length ? (takers / byParty.length) * 100 : 0,
      takers, non_takers: byParty.length - takers,
      laundry_owed: owed.reduce((a, r) => a + r.laundry, 0),
      line_laundry: (lines.find(l => /laundry/i.test(l.key)) || {}).gross || 0,
    },
    byMonth, byParty, owed, lines,
  };
}
module.exports = { summary };
