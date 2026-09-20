// Merging duplicate people and accounts.
// References are discovered from the schema itself rather than hardcoded, so a table
// added later cannot be silently left pointing at a record that no longer exists.
const { db, all, get, run, tx, audit } = require('./db');

const TARGET = {
  party:   { table: 'parties',  pk: 'party_id',   label: 'display_name' },
  cleaner: { table: 'cleaners', pk: 'cleaner_id', label: 'name' },
  account: { table: 'accounts', pk: 'account_id', label: 'name' },
};

// every (table, column) that points at the given table's primary key
function referrers(targetTable) {
  const out = [];
  for (const t of all(`SELECT name FROM sqlite_master WHERE type='table'
                       AND name NOT LIKE 'sqlite_%'`)) {
    for (const fk of all(`PRAGMA foreign_key_list("${t.name}")`)) {
      if (fk.table === targetTable) out.push({ table: t.name, column: fk.from });
    }
  }
  return out;
}

function preview(entity, keepId, mergeId) {
  const cfg = TARGET[entity];
  if (!cfg) throw new Error(`cannot merge "${entity}"`);
  const keep  = get(`SELECT * FROM ${cfg.table} WHERE ${cfg.pk}=?`, [keepId]);
  const drop  = get(`SELECT * FROM ${cfg.table} WHERE ${cfg.pk}=?`, [mergeId]);
  if (!keep || !drop) throw new Error('one of those records does not exist');
  const refs = referrers(cfg.table).map(r => ({
    ...r,
    rows: get(`SELECT count(*) n FROM "${r.table}" WHERE "${r.column}"=?`, [mergeId]).n,
  })).filter(r => r.rows > 0);
  return { entity, keep, drop, refs, total: refs.reduce((a, r) => a + r.rows, 0) };
}

// Merge `mergeId` into `keepId`. Everything is repointed, then the duplicate is removed.
function merge(entity, keepId, mergeId, actor) {
  if (String(keepId) === String(mergeId)) throw new Error('those are the same record');
  const cfg = TARGET[entity];
  const p = preview(entity, keepId, mergeId);
  const moved = [];
  tx(() => {
    for (const r of p.refs) {
      // a UNIQUE(a,b) pair can collide once both point at the same survivor
      try {
        const res = run(`UPDATE "${r.table}" SET "${r.column}"=? WHERE "${r.column}"=?`, [keepId, mergeId]);
        moved.push({ table: r.table, column: r.column, rows: res.changes });
      } catch (e) {
        const res = run(`UPDATE OR IGNORE "${r.table}" SET "${r.column}"=? WHERE "${r.column}"=?`,
                        [keepId, mergeId]);
        const left = run(`DELETE FROM "${r.table}" WHERE "${r.column}"=?`, [mergeId]);
        moved.push({ table: r.table, column: r.column, rows: res.changes,
                     dropped_as_duplicate: left.changes });
      }
    }
    run(`DELETE FROM ${cfg.table} WHERE ${cfg.pk}=?`, [mergeId]);
    run(`INSERT INTO merge_log(entity,kept_id,kept_name,merged_id,merged_name,moved,actor)
         VALUES(?,?,?,?,?,?,?)`,
      [entity, keepId, p.keep[cfg.label], mergeId, p.drop[cfg.label], JSON.stringify(moved), actor]);
    audit({ actor, table: cfg.table, rowId: keepId, action: 'update',
            oldValue: p.drop[cfg.label], newValue: p.keep[cfg.label],
            note: `merged "${p.drop[cfg.label]}" into "${p.keep[cfg.label]}" — ${moved.reduce((a, m) => a + m.rows, 0)} rows repointed` });
  });
  return { ok: true, moved, kept: p.keep[cfg.label], removed: p.drop[cfg.label] };
}

// Likely duplicates, so the owner is not hunting for them by eye.
function candidates(entity = 'party') {
  const cfg = TARGET[entity];
  const rows = all(`SELECT ${cfg.pk} AS id, ${cfg.label} AS name FROM ${cfg.table}`);
  const norm = s => String(s || '').toLowerCase()
    .replace(/\b(pvt|private|limited|ltd|llp|the|and|co|company|mr|mrs|ms|sir|maam|madam)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const squash = s => norm(s).replace(/ /g, '');
  const toks = s => new Set(norm(s).split(' ').filter(t => t.length > 2));
  const usage = {};
  for (const r of rows) {
    usage[r.id] = referrers(cfg.table)
      .reduce((a, x) => a + get(`SELECT count(*) n FROM "${x.table}" WHERE "${x.column}"=?`, [r.id]).n, 0);
  }
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      const sa = squash(a.name), sb = squash(b.name);
      if (!sa || !sb) continue;
      let score = 0, why = '';
      if (sa === sb) { score = 1; why = 'identical once punctuation is ignored'; }
      else if (sa.includes(sb) || sb.includes(sa)) {
        score = 0.85 * Math.min(sa.length, sb.length) / Math.max(sa.length, sb.length);
        why = 'one name contains the other';
      } else {
        const A = toks(a.name), B = toks(b.name);
        if (A.size && B.size) {
          const inter = [...A].filter(t => B.has(t)).length;
          const j2 = inter / new Set([...A, ...B]).size;
          if (j2 >= 0.5) { score = j2; why = `${inter} name part(s) in common`; }
        }
      }
      if (score >= 0.55)
        pairs.push({ a: { ...a, uses: usage[a.id] }, b: { ...b, uses: usage[b.id] },
                     score: +score.toFixed(2), why,
                     suggest_keep: usage[a.id] >= usage[b.id] ? a.id : b.id });
    }
  }
  return pairs.sort((x, y) => y.score - x.score).slice(0, 200);
}

module.exports = { preview, merge, candidates, referrers };
