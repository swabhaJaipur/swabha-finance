// Parser for an exported WhatsApp payment log (the Ritesh / owner thread).
// It NEVER imports on its own: it returns a reviewable proposal, because a chat
// message is evidence of a payment, not a ledger entry.
const { all, get } = require('./db');

// iOS:     [13/08/2026, 10:23:45] Ritesh: text
// Android: 13/08/2026, 10:23 - Ritesh: text
const HEAD = /^\s*(?:\[)?(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:[ap]\.?m\.?)?\s*(?:\])?\s*(?:-\s*)?([^:]{1,60}?):\s?([\s\S]*)$/i;

const IN_WORDS  = /\b(received|recieved|recd|rcvd|credited|credit|got|mila|aaya|aagaya|aa gaya|payment received|received payment|collection|deposit)\b/i;
const OUT_WORDS = /\b(paid|payment done|pay|sent|bheja|bheji|diya|dediya|de diya|debited|debit|transfer(?:red)?|salary|advance|expense|kharcha|kharch)\b/i;

// Amounts, most confident first. Bare numbers are accepted too (the chat is full of
// "Palm 34 ka payment aa gaya 9440") but flagged lower-confidence than ₹-marked ones.
const CURRENCY = /(?:₹|\brs\.?|\binr\b)\s*([\d,]+(?:\.\d{1,2})?)\s*(k\b|thousand\b)?/gi;
const SUFFIXED = /(?<![\d.,])([\d,]+(?:\.\d{1,2})?)\s*(?:\/-|\b(?:rs|rupees?|inr)\b)/gi;
const KSHORT   = /(?<![\d.,])(\d+(?:\.\d+)?)\s*k\b/gi;
// two shapes: comma-grouped (12,500 / 1,12,500 — clearly money) and plain (9440)
const GROUPED  = /(?<![\d.,:\/-])(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?)(?![\d.,:\/-])/g;
const BARE     = /(?<![\d.,:\/-])(\d{3,8}(?:\.\d{1,2})?)(?![\d.,:\/-])/g;

function parseAmount(text) {
  // strip times and dates so 10:23 and 13/08/2026 are never read as money
  const clean = text.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?/gi, ' ')
                    .replace(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/g, ' ')
                    .replace(/\b(?:\+91[- ]?)?[6-9]\d{9}\b/g, ' ');   // phone numbers
  const out = [];
  const push = (v, conf) => {
    if (!isFinite(v) || v < 10 || v > 1e8) return;
    if (!out.some(o => Math.abs(o.value - v) < 0.01)) out.push({ value: v, confidence: conf });
  };
  for (const m of clean.matchAll(CURRENCY)) {
    let v = parseFloat(m[1].replace(/,/g, ''));
    if (m[2]) v *= 1000;
    push(v, 'high');
  }
  for (const m of clean.matchAll(SUFFIXED)) push(parseFloat(m[1].replace(/,/g, '')), 'high');
  for (const m of clean.matchAll(KSHORT))   push(parseFloat(m[1]) * 1000, 'medium');
  for (const m of clean.matchAll(GROUPED)) push(parseFloat(m[1].replace(/,/g, '')), 'medium');
  if (!out.length) for (const m of clean.matchAll(BARE))
    push(parseFloat(m[1].replace(/,/g, '')), 'low');
  return out;
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function nameIndex() {
  const rows = [
    ...all('SELECT party_id AS id, display_name AS name FROM parties').map(r => ({ ...r, kind: 'party' })),
    ...all('SELECT cleaner_id AS id, name FROM cleaners').map(r => ({ ...r, kind: 'cleaner' })),
    ...all('SELECT host_id AS id, name FROM hosts').map(r => ({ ...r, kind: 'host' })),
    ...all('SELECT property_id AS id, name FROM properties').map(r => ({ ...r, kind: 'property' })),
  ];
  return rows.map(r => ({ ...r, toks: new Set(norm(r.name).split(' ').filter(t => t.length > 2)) }));
}

function matchName(text, idx) {
  const words = new Set(norm(text).split(' '));
  let best = null, bestScore = 0;
  for (const r of idx) {
    if (!r.toks.size) continue;
    let hit = 0;
    for (const tok of r.toks) if (words.has(tok)) hit++;
    if (!hit) continue;
    // reward matching all of a name's words; long names matched fully win
    const score = (hit / r.toks.size) + (hit >= 2 ? 0.15 : 0);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return bestScore >= 0.5
    ? { id: best.id, name: best.name, kind: best.kind, score: +Math.min(bestScore, 1).toFixed(2) }
    : null;
}

function iso(d, m, y) {
  y = +y; if (y < 100) y += y > 70 ? 1900 : 2000;
  return `${y}-${String(+m).padStart(2, '0')}-${String(+d).padStart(2, '0')}`;
}

// Returns a proposal the owner reviews line by line.
function parse(text, opts = {}) {
  const lines = String(text).split(/\r?\n/);
  const idx = nameIndex();
  const msgs = [];
  for (const line of lines) {
    const m = HEAD.exec(line);
    if (m) {
      const dmy = opts.dateOrder === 'mdy' ? iso(m[2], m[1], m[3]) : iso(m[1], m[2], m[3]);
      msgs.push({ date: dmy, time: `${m[4]}:${m[5]}`, sender: m[7].trim(), text: m[8] });
    } else if (msgs.length) msgs[msgs.length - 1].text += '\n' + line;   // continuation
  }
  const proposals = [], skipped = [];
  for (const msg of msgs) {
    if (/\b(omitted|deleted this message|joined|left|changed the subject)\b/i.test(msg.text)) continue;
    const amts = parseAmount(msg.text);
    if (!amts.length) { skipped.push({ ...msg, why: 'no amount found' }); continue; }
    const inHit = IN_WORDS.test(msg.text), outHit = OUT_WORDS.test(msg.text);
    const direction = inHit && !outHit ? 'in' : outHit && !inHit ? 'out' : null;
    const hit = matchName(msg.text, idx);
    const top = amts.reduce((a, b) =>
      (a.confidence === b.confidence ? (b.value > a.value ? b : a)
       : ({ high: 3, medium: 2, low: 1 }[b.confidence] > { high: 3, medium: 2, low: 1 }[a.confidence] ? b : a)));
    proposals.push({
      date: msg.date, time: msg.time, sender: msg.sender,
      text: msg.text.trim().slice(0, 240),
      amount: top.value, amount_confidence: top.confidence,
      all_amounts: amts.map(a => a.value),
      direction,
      match: hit ? hit.name : null, match_kind: hit ? hit.kind : null,
      party_id: hit && hit.kind === 'party' ? hit.id : null,
      property_id: hit && hit.kind === 'property' ? hit.id : null,
      match_confidence: hit?.score ?? 0,
      ambiguous: !direction || amts.length > 1 || !hit || top.confidence === 'low',
      reason: [!direction && 'direction unclear',
               amts.length > 1 && `${amts.length} amounts in one message`,
               !hit && 'name not recognised',
               top.confidence === 'low' && 'amount is a bare number'].filter(Boolean).join('; ') || null,
    });
  }

  // a payment mentioned twice in the chat is still one payment
  const seen = new Map();
  for (const p of proposals) {
    const k = `${p.date}|${p.amount}|${p.party_id ?? ''}`;
    seen.set(k, (seen.get(k) || 0) + 1);
    p.duplicate_in_chat = seen.get(k) > 1;
  }
  return {
    messages: msgs.length,
    proposals,
    skipped: skipped.slice(0, 50),
    summary: {
      total: proposals.length,
      clear: proposals.filter(p => !p.ambiguous).length,
      needs_review: proposals.filter(p => p.ambiguous).length,
      money_in:  proposals.filter(p => p.direction === 'in').reduce((a, p) => a + p.amount, 0),
      money_out: proposals.filter(p => p.direction === 'out').reduce((a, p) => a + p.amount, 0),
      senders: [...new Set(msgs.map(m => m.sender))],
      date_range: msgs.length ? [msgs[0].date, msgs[msgs.length - 1].date] : null,
    },
  };
}

// Which of these are already in the ledger (Tally likely has the GST ones)?
function reconcile(proposals) {
  return proposals.map(p => {
    const near = all(
      `SELECT txn_id, txn_date, gross_amount, source FROM transactions
       WHERE abs(gross_amount - ?) <= max(2, ? * 0.02)
         AND abs(julianday(txn_date) - julianday(?)) <= 4`,
      [p.amount, p.amount, p.date]);
    return { ...p, already_in_ledger: near.length > 0, matches: near.slice(0, 3) };
  });
}

module.exports = { parse, reconcile };
