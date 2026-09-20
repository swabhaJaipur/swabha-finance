// Swabha Financial Control System — chart primitives.
// Hand-written SVG on purpose: every mark must be a click target that feeds the
// global filter, which charting libraries make awkward. Palette from the Swabha mark.
const NS = 'http://www.w3.org/2000/svg';
const el = (n, a = {}, kids = []) => {
  const e = document.createElementNS(NS, n);
  for (const [k, v] of Object.entries(a)) if (v != null) e.setAttribute(k, v);
  for (const c of [].concat(kids)) e.append(c);
  return e;
};
const txt = (s, a = {}) => { const t = el('text', a); t.textContent = s; return t; };
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export const C = () => ({ in: css('--in'), out: css('--out'), water: css('--water'),
  leaf: css('--leaf'), saffron: css('--saffron'), warn: css('--warn'), cap: css('--cap'),
  muted: css('--muted-2'), line: css('--line'), ink: css('--ink') });

// categorical order starts with the three mark colours, then supports
const PAL = ['#3FA0D8','#3F9E4D','#ED8022','#7C5CBF','#2B7FB0','#2E7D3A','#D26A10',
             '#17A2B8','#C2185B','#5D7A8C','#8BC34A','#FF7043'];
export const colorAt = i => PAL[i % PAL.length];

export function money(v, full = false) {
  const n = Number(v) || 0, a = Math.abs(n), s = n < 0 ? '−' : '';
  if (full) return s + '₹' + a.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  if (a >= 1e7) return s + '₹' + (a / 1e7).toFixed(2) + 'Cr';
  if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(2) + 'L';
  if (a >= 1e3) return s + '₹' + (a / 1e3).toFixed(1) + 'k';
  return s + '₹' + Math.round(a);
}
export const pct = (a, b) => (b ? (a / b) * 100 : 0);

/* ---------------------------------------------------------------- tooltip */
function tipOf(host) {
  let t = host.querySelector('.cht-tip');
  if (!t) {
    t = document.createElement('div'); t.className = 'cht-tip';
    t.style.cssText = 'position:absolute;pointer-events:none;opacity:0;transition:opacity .1s;' +
      'background:var(--ink);color:var(--panel);padding:6px 10px;border-radius:8px;font-size:11.5px;' +
      'font-weight:600;white-space:nowrap;z-index:9;box-shadow:0 4px 14px rgba(0,0,0,.25)';
    host.style.position = 'relative'; host.append(t);
  }
  return t;
}
function bind(host, node, label, onClick) {
  const t = tipOf(host);
  if (onClick) node.style.cursor = 'pointer';
  node.addEventListener('mousemove', e => {
    const r = host.getBoundingClientRect();
    t.innerHTML = label; t.style.opacity = 1;
    t.style.left = Math.max(2, Math.min(e.clientX - r.left + 12, host.clientWidth - t.offsetWidth - 6)) + 'px';
    t.style.top = Math.max(2, e.clientY - r.top - 36) + 'px';
  });
  node.addEventListener('mouseleave', () => t.style.opacity = 0);
  if (onClick) node.addEventListener('click', ev => { ev.stopPropagation(); t.style.opacity = 0; onClick(); });
}
const frame = (host, h) => {
  const tip = host.querySelector('.cht-tip');
  host.innerHTML = ''; if (tip) host.append(tip);
  const w = Math.max(host.clientWidth || 520, 240);
  const s = el('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', height: h, style: 'display:block' });
  host.append(s); return { s, w };
};
const none = host => { host.innerHTML = '<div class="empty">Nothing matches this filter</div>'; };
const nice = v => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const r = v / p;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * p; };
const yAxis = (s, w, P, ih, max, min = 0) => {
  const c = C();
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * i / 4, y = P.t + ih - (ih * i / 4);
    s.append(el('line', { x1: P.l, x2: w - P.r, y1: y, y2: y, stroke: c.line }));
    s.append(txt(money(v), { x: P.l - 7, y: y + 3.5, 'text-anchor': 'end', fill: c.muted, 'font-size': 10 }));
  }
};
const xLabel = (s, rows, i, x, y) => {
  if (rows.length <= 18 || i % Math.ceil(rows.length / 12) === 0)
    s.append(txt(String(rows[i].key ?? '').replace(/^\d{4}-/, '').slice(0, 12),
      { x, y, 'text-anchor': 'middle', fill: C().muted, 'font-size': 10 }));
};

/* ------------------------------------------------- 1. grouped bars (time) */
export function groupedBars(host, rows, o = {}) {
  const H = o.height || 250, P = { t: 12, r: 10, b: 38, l: 56 };
  const { s, w } = frame(host, H); if (!rows.length) return none(host);
  const c = C();
  const keys = o.keys || [{ f: 'revenue', c: c.in, n: 'Revenue' }, { f: 'opcost', c: c.out, n: 'Cost' }];
  const max = nice(Math.max(1, ...rows.flatMap(r => keys.map(k => Math.abs(r[k.f] || 0)))));
  const iw = w - P.l - P.r, ih = H - P.t - P.b;
  const slot = iw / rows.length, gw = Math.min(slot * .7, 48), one = gw / keys.length;
  yAxis(s, w, P, ih, max);
  rows.forEach((r, i) => {
    const cx = P.l + slot * i + slot / 2;
    keys.forEach((k, j) => {
      const v = Math.abs(r[k.f] || 0), bh = v > 0 ? Math.max(v / max * ih, 1.5) : 0;
      const rect = el('rect', { x: cx - gw / 2 + one * j, y: P.t + ih - bh,
        width: Math.max(one - 2, 2), height: bh, fill: k.c, rx: 2 });
      bind(host, rect, `<b>${r.key}</b><br>${k.n}: ${money(v, true)}<br>${r.txns} entries`,
        o.onClick && (() => o.onClick(r.key, r)));
      s.append(rect);
    });
    xLabel(s, rows, i, cx, H - 16);
  });
  if (o.legend !== false) legendRow(host, keys.map(k => ({ n: k.n, c: k.c })));
}

/* ------------------------------------------------- 2. stacked bars */
export function stackedBars(host, rows, o = {}) {
  const H = o.height || 250, P = { t: 12, r: 10, b: 38, l: 56 };
  const { s, w } = frame(host, H); if (!rows.length) return none(host);
  const cats = o.cats || [];
  const max = nice(Math.max(1, ...rows.map(r => cats.reduce((a, k) => a + Math.abs(r.vals?.[k] || 0), 0))));
  const iw = w - P.l - P.r, ih = H - P.t - P.b, slot = iw / rows.length, bw = Math.min(slot * .68, 46);
  yAxis(s, w, P, ih, max);
  rows.forEach((r, i) => {
    const cx = P.l + slot * i + slot / 2; let acc = 0;
    cats.forEach((k, j) => {
      const v = Math.abs(r.vals?.[k] || 0); if (!v) return;
      const bh = v / max * ih; acc += bh;
      const rect = el('rect', { x: cx - bw / 2, y: P.t + ih - acc, width: bw, height: bh,
        fill: colorAt(j), rx: 1 });
      bind(host, rect, `<b>${r.key}</b><br>${k}: ${money(v, true)}`,
        o.onClick && (() => o.onClick(k, r)));
      s.append(rect);
    });
    xLabel(s, rows, i, cx, H - 16);
  });
  legendRow(host, cats.slice(0, 8).map((k, j) => ({ n: k, c: colorAt(j) })));
}

/* ------------------------------------------------- 3. line / area */
export function lineChart(host, rows, o = {}) {
  const H = o.height || 220, P = { t: 12, r: 12, b: 30, l: 58 };
  const { s, w } = frame(host, H); if (!rows.length) return none(host);
  const c = C(), f = o.field || 'net_operating';
  const vals = rows.map(r => r[f] || 0);
  const hi = Math.max(1, ...vals), lo = Math.min(0, ...vals);
  const iw = w - P.l - P.r, ih = H - P.t - P.b;
  const X = i => P.l + (rows.length === 1 ? iw / 2 : iw * i / (rows.length - 1));
  const Y = v => P.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  yAxis(s, w, P, ih, hi, lo);
  if (lo < 0) s.append(el('line', { x1: P.l, x2: w - P.r, y1: Y(0), y2: Y(0),
    stroke: c.out, 'stroke-dasharray': '3 3' }));
  const col = o.color || c.water;
  const pts = rows.map((r, i) => [X(i), Y(r[f] || 0)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  if (o.area !== false)
    s.append(el('path', { d: `${d} L ${pts.at(-1)[0]} ${Y(lo)} L ${pts[0][0]} ${Y(lo)} Z`, fill: col, opacity: .12 }));
  s.append(el('path', { d, fill: 'none', stroke: col, 'stroke-width': 2.2, 'stroke-linejoin': 'round' }));
  rows.forEach((r, i) => {
    const hit = el('circle', { cx: X(i), cy: Y(r[f] || 0), r: 9, fill: 'transparent' });
    bind(host, hit, `<b>${r.key}</b><br>${money(r[f] || 0, true)}`, o.onClick && (() => o.onClick(r.key, r)));
    s.append(hit);
    s.append(el('circle', { cx: X(i), cy: Y(r[f] || 0), r: 2.8, fill: col }));
    xLabel(s, rows, i, X(i), H - 10);
  });
}

/* ------------------------------------------------- 4. combo: bars + line */
export function comboChart(host, rows, o = {}) {
  const H = o.height || 250, P = { t: 12, r: 52, b: 38, l: 56 };
  const { s, w } = frame(host, H); if (!rows.length) return none(host);
  const c = C(), bf = o.barField || 'revenue', lf = o.lineField || 'margin';
  const max = nice(Math.max(1, ...rows.map(r => Math.abs(r[bf] || 0))));
  const lmax = Math.max(1, ...rows.map(r => Math.abs(r[lf] || 0)));
  const iw = w - P.l - P.r, ih = H - P.t - P.b, slot = iw / rows.length, bw = Math.min(slot * .6, 40);
  yAxis(s, w, P, ih, max);
  rows.forEach((r, i) => {
    const cx = P.l + slot * i + slot / 2, v = Math.abs(r[bf] || 0), bh = v > 0 ? Math.max(v / max * ih, 1.5) : 0;
    const rect = el('rect', { x: cx - bw / 2, y: P.t + ih - bh, width: bw, height: bh,
      fill: o.barColor || c.water, rx: 2, opacity: .85 });
    bind(host, rect, `<b>${r.key}</b><br>${o.barName || bf}: ${money(v, true)}<br>${o.lineName || lf}: ${(r[lf] || 0).toFixed(1)}%`,
      o.onClick && (() => o.onClick(r.key, r)));
    s.append(rect); xLabel(s, rows, i, cx, H - 16);
  });
  const Y2 = v => P.t + ih - (Math.abs(v) / lmax) * ih * .9;
  const pts = rows.map((r, i) => [P.l + slot * i + slot / 2, Y2(r[lf] || 0)]);
  s.append(el('path', { d: pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' '),
    fill: 'none', stroke: o.lineColor || c.saffron, 'stroke-width': 2.2 }));
  pts.forEach(p => s.append(el('circle', { cx: p[0], cy: p[1], r: 3, fill: o.lineColor || c.saffron })));
  for (let i = 0; i <= 2; i++) {
    const y = P.t + ih - ih * .9 * i / 2;
    s.append(txt((lmax * i / 2).toFixed(0) + '%', { x: w - P.r + 6, y: y + 3.5, fill: c.saffron, 'font-size': 10 }));
  }
  legendRow(host, [{ n: o.barName || 'Revenue', c: o.barColor || c.water },
                   { n: o.lineName || 'Margin %', c: o.lineColor || c.saffron }]);
}

/* ------------------------------------------------- 5. ranked horizontal bars */
export function rankBars(host, rows, o = {}) {
  const tip = host.querySelector('.cht-tip'); host.innerHTML = ''; if (tip) host.append(tip);
  if (!rows.length) return none(host);
  const f = o.field || 'gross';
  const max = Math.max(1, ...rows.map(r => Math.abs(r[f] || 0)));
  const total = rows.reduce((a, r) => a + Math.abs(r[f] || 0), 0);
  const box = document.createElement('div');
  box.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  rows.forEach((r, i) => {
    const v = Math.abs(r[f] || 0);
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:3px 10px;align-items:center';
    if (o.onClick) { row.style.cursor = 'pointer'; row.onclick = () => o.onClick(r.key, r); }
    row.onmouseenter = () => row.style.opacity = .75;
    row.onmouseleave = () => row.style.opacity = 1;
    const n = document.createElement('div');
    n.style.cssText = 'font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    n.textContent = r.key ?? '(blank)';
    const a = document.createElement('div');
    a.style.cssText = 'font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums';
    a.innerHTML = `${money(v)} <span style="color:var(--muted-2);font-weight:600;font-size:11px">${pct(v, total).toFixed(0)}%</span>`;
    const tr = document.createElement('div');
    tr.style.cssText = 'grid-column:1/-1;height:6px;border-radius:4px;background:var(--chip);overflow:hidden';
    const fl = document.createElement('i');
    fl.style.cssText = `display:block;height:100%;width:${(v / max * 100).toFixed(1)}%;background:${o.color || colorAt(i)};border-radius:4px`;
    tr.append(fl); row.append(n, a, tr);
    row.title = `${r.key}\n${money(v, true)} · ${r.txns} entries`;
    box.append(row);
  });
  host.append(box);
}

/* ------------------------------------------------- 6. donut */
export function donut(host, rows, o = {}) {
  const H = o.height || 230;
  const { s, w } = frame(host, H); if (!rows.length) return none(host);
  const c = C(), f = o.field || 'gross';
  const total = rows.reduce((a, r) => a + Math.abs(r[f] || 0), 0) || 1;
  const cx = Math.min(w * .27, 116), cy = H / 2, R = Math.min(H * .40, 76), r0 = R * .60;
  let ang = -Math.PI / 2;
  rows.forEach((r, i) => {
    const v = Math.abs(r[f] || 0); if (!v) return;
    const a = (v / total) * Math.PI * 2, big = a > Math.PI ? 1 : 0;
    const pt = (rad, an) => [cx + rad * Math.cos(an), cy + rad * Math.sin(an)];
    const [x1, y1] = pt(R, ang), [x2, y2] = pt(R, ang + a), [x3, y3] = pt(r0, ang + a), [x4, y4] = pt(r0, ang);
    const p = el('path', { fill: colorAt(i), d:
      `M${x1} ${y1}A${R} ${R} 0 ${big} 1 ${x2} ${y2}L${x3} ${y3}A${r0} ${r0} 0 ${big} 0 ${x4} ${y4}Z` });
    bind(host, p, `<b>${r.key}</b><br>${money(v, true)} · ${pct(v, total).toFixed(1)}%`,
      o.onClick && (() => o.onClick(r.key, r)));
    s.append(p); ang += a;
  });
  s.append(txt(money(total), { x: cx, y: cy + 1, 'text-anchor': 'middle', fill: c.ink, 'font-size': 14, 'font-weight': 700 }));
  s.append(txt(o.centreLabel || 'total', { x: cx, y: cy + 16, 'text-anchor': 'middle', fill: c.muted, 'font-size': 10 }));
  const lx = cx + R + 20;
  rows.slice(0, 8).forEach((r, i) => {
    const y = 20 + i * 19; if (y > H - 6) return;
    const g = el('g');
    g.append(el('rect', { x: lx, y: y - 8, width: 9, height: 9, rx: 2, fill: colorAt(i) }));
    g.append(txt(String(r.key ?? '').slice(0, 20), { x: lx + 14, y, fill: c.ink, 'font-size': 11 }));
    g.append(txt(pct(Math.abs(r[f] || 0), total).toFixed(0) + '%', { x: w - 4, y, 'text-anchor': 'end',
      fill: c.muted, 'font-size': 11, 'font-weight': 600 }));
    if (o.onClick) { g.style.cursor = 'pointer'; g.addEventListener('click', () => o.onClick(r.key, r)); }
    s.append(g);
  });
}

/* ------------------------------------------------- 7. waterfall (P&L bridge) */
export function waterfall(host, steps, o = {}) {
  const H = o.height || 260, P = { t: 16, r: 10, b: 46, l: 60 };
  const { s, w } = frame(host, H); if (!steps.length) return none(host);
  const c = C();
  let run = 0; const marks = [];
  for (const st of steps) {
    if (st.total) marks.push({ ...st, from: 0, to: run });
    else { marks.push({ ...st, from: run, to: run + st.value }); run += st.value; }
  }
  const hi = Math.max(0, ...marks.map(m => Math.max(m.from, m.to)));
  const lo = Math.min(0, ...marks.map(m => Math.min(m.from, m.to)));
  const iw = w - P.l - P.r, ih = H - P.t - P.b;
  const Y = v => P.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const slot = iw / marks.length, bw = Math.min(slot * .62, 52);
  yAxis(s, w, P, ih, hi, lo);
  marks.forEach((m, i) => {
    const cx = P.l + slot * i + slot / 2;
    const y1 = Y(Math.max(m.from, m.to)), y2 = Y(Math.min(m.from, m.to));
    const col = m.total ? c.water : m.value >= 0 ? c.in : c.out;
    const rect = el('rect', { x: cx - bw / 2, y: y1, width: bw, height: Math.max(y2 - y1, 2),
      fill: col, rx: 2, opacity: m.total ? 1 : .9 });
    bind(host, rect, `<b>${m.label}</b><br>${money(m.total ? m.to : m.value, true)}`,
      o.onClick && (() => o.onClick(m)));
    s.append(rect);
    if (i < marks.length - 1 && !marks[i + 1].total)
      s.append(el('line', { x1: cx + bw / 2, x2: P.l + slot * (i + 1) + slot / 2 - bw / 2,
        y1: Y(m.to), y2: Y(m.to), stroke: c.muted, 'stroke-dasharray': '2 2', opacity: .6 }));
    s.append(txt(money(m.total ? m.to : m.value), { x: cx, y: y1 - 5, 'text-anchor': 'middle',
      fill: c.ink, 'font-size': 10, 'font-weight': 700 }));
    const words = String(m.label).split(' ');
    words.slice(0, 2).forEach((wd, k) =>
      s.append(txt(wd, { x: cx, y: H - 30 + k * 11, 'text-anchor': 'middle', fill: c.muted, 'font-size': 9.5 })));
  });
}

/* ------------------------------------------------- 8. pareto (80/20 leaks) */
export function pareto(host, rows, o = {}) {
  const H = o.height || 260, P = { t: 14, r: 44, b: 60, l: 58 };
  const { s, w } = frame(host, H); if (!rows.length) return none(host);
  const c = C(), f = o.field || 'gross';
  const sorted = [...rows].sort((a, b) => Math.abs(b[f] || 0) - Math.abs(a[f] || 0)).slice(0, o.limit || 12);
  const total = rows.reduce((a, r) => a + Math.abs(r[f] || 0), 0) || 1;
  const max = nice(Math.abs(sorted[0][f] || 1));
  const iw = w - P.l - P.r, ih = H - P.t - P.b, slot = iw / sorted.length, bw = Math.min(slot * .68, 46);
  yAxis(s, w, P, ih, max);
  let cum = 0; const cumPts = [];
  sorted.forEach((r, i) => {
    const v = Math.abs(r[f] || 0), cx = P.l + slot * i + slot / 2, bh = Math.max(v / max * ih, 1.5);
    cum += v;
    const share = pct(cum, total);
    cumPts.push([cx, P.t + ih - (share / 100) * ih]);
    const rect = el('rect', { x: cx - bw / 2, y: P.t + ih - bh, width: bw, height: bh,
      fill: share <= 80 ? c.out : c.muted, rx: 2, opacity: share <= 80 ? .92 : .45 });
    bind(host, rect, `<b>${r.key}</b><br>${money(v, true)}<br>cumulative ${share.toFixed(0)}% of spend`,
      o.onClick && (() => o.onClick(r.key, r)));
    s.append(rect);
    const lbl = String(r.key ?? '').slice(0, 14);
    s.append(txt(lbl, { x: cx, y: H - 40, 'text-anchor': 'end', fill: c.muted, 'font-size': 9.5,
      transform: `rotate(-38 ${cx} ${H - 40})` }));
  });
  s.append(el('path', { d: cumPts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' '),
    fill: 'none', stroke: c.saffron, 'stroke-width': 2.2 }));
  cumPts.forEach(p => s.append(el('circle', { cx: p[0], cy: p[1], r: 3, fill: c.saffron })));
  const y80 = P.t + ih - .8 * ih;
  s.append(el('line', { x1: P.l, x2: w - P.r, y1: y80, y2: y80, stroke: c.saffron,
    'stroke-dasharray': '4 3', opacity: .7 }));
  s.append(txt('80%', { x: w - P.r + 5, y: y80 + 3.5, fill: c.saffron, 'font-size': 10, 'font-weight': 700 }));
  const vital = cumPts.findIndex(p => p[1] <= y80) + 1;
  if (vital > 0) legendRow(host, [{ n: `${vital} of ${rows.length} account for 80% of this spend`, c: c.out }]);
}

/* ------------------------------------------------- 9. heatmap (month x dim) */
export function heatmap(host, matrix, o = {}) {
  const tip = host.querySelector('.cht-tip'); host.innerHTML = ''; if (tip) host.append(tip);
  const { rows, cols, get } = matrix;
  if (!rows.length || !cols.length) return none(host);
  const c = C();
  const max = Math.max(1, ...rows.flatMap(r => cols.map(cl => Math.abs(get(r, cl) || 0))));
  const tbl = document.createElement('div');
  tbl.style.cssText = `display:grid;grid-template-columns:minmax(96px,1.2fr) repeat(${cols.length},1fr);gap:2px;font-size:10.5px`;
  tbl.append(cell('', 'head'));
  cols.forEach(cl => tbl.append(cell(String(cl).replace(/^\d{4}-/, ''), 'head')));
  rows.forEach(r => {
    tbl.append(cell(String(r).slice(0, 18), 'rowhead'));
    cols.forEach(cl => {
      const v = Math.abs(get(r, cl) || 0);
      const d = document.createElement('div');
      const t = v / max;
      d.style.cssText = `height:26px;border-radius:4px;display:grid;place-items:center;font-weight:700;` +
        `background:${v ? mix(o.color || c.water, t) : 'var(--chip)'};` +
        `color:${t > .55 ? '#fff' : 'var(--muted)'};font-size:9.5px`;
      d.textContent = v ? money(v) : '';
      bind(host, d, `<b>${r}</b><br>${cl}: ${money(v, true)}`, o.onClick && (() => o.onClick(r, cl, v)));
      tbl.append(d);
    });
  });
  host.append(tbl);
  function cell(s_, kind) {
    const d = document.createElement('div');
    d.textContent = s_;
    d.style.cssText = `font-weight:700;color:var(--muted-2);font-size:9.5px;display:flex;align-items:center;` +
      (kind === 'rowhead' ? 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:4px'
                          : 'justify-content:center');
    d.title = s_; return d;
  }
  function mix(hex, t) {
    const n = parseInt(hex.replace('#', ''), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return `rgba(${r},${g},${b},${(0.12 + t * 0.88).toFixed(2)})`;
  }
}

/* ------------------------------------------------- 10. treemap */
export function treemap(host, rows, o = {}) {
  const H = o.height || 260;
  const { s, w } = frame(host, H); if (!rows.length) return none(host);
  const c = C(), f = o.field || 'gross';
  const items = rows.map(r => ({ ...r, v: Math.abs(r[f] || 0) })).filter(r => r.v > 0)
                    .sort((a, b) => b.v - a.v).slice(0, 16);
  if (!items.length) return none(host);
  const total = items.reduce((a, r) => a + r.v, 0);
  // squarified-ish slice/dice
  let x = 0, y = 0, cw = w, ch = H, i = 0;
  for (const it of items) {
    const area = (it.v / total) * (cw * ch);
    const horiz = cw >= ch;
    const d = Math.min(horiz ? cw : ch, Math.max(area / (horiz ? ch : cw), 2));
    const rw = horiz ? d : cw, rh = horiz ? ch : d;
    const g = el('g');
    const rect = el('rect', { x: x + 1, y: y + 1, width: Math.max(rw - 2, 1), height: Math.max(rh - 2, 1),
      fill: colorAt(i), rx: 4, opacity: .9 });
    bind(host, rect, `<b>${it.key}</b><br>${money(it.v, true)} · ${pct(it.v, total).toFixed(1)}%`,
      o.onClick && (() => o.onClick(it.key, it)));
    g.append(rect);
    if (rw > 58 && rh > 28) {
      g.append(txt(String(it.key ?? '').slice(0, Math.floor(rw / 7)),
        { x: x + 8, y: y + 18, fill: '#fff', 'font-size': 11, 'font-weight': 700 }));
      g.append(txt(money(it.v), { x: x + 8, y: y + 32, fill: '#fff', 'font-size': 10.5, opacity: .9 }));
    }
    s.append(g);
    if (horiz) { x += rw; cw -= rw; } else { y += rh; ch -= rh; }
    i++;
  }
}

/* ------------------------------------------------- 11. scatter (profit map) */
export function scatter(host, pts, o = {}) {
  const H = o.height || 270, P = { t: 14, r: 14, b: 42, l: 62 };
  const { s, w } = frame(host, H); if (!pts.length) return none(host);
  const c = C();
  const xmax = nice(Math.max(1, ...pts.map(p => p.x))), ymax = nice(Math.max(1, ...pts.map(p => p.y)));
  const iw = w - P.l - P.r, ih = H - P.t - P.b;
  const X = v => P.l + (v / xmax) * iw, Y = v => P.t + ih - (v / ymax) * ih;
  yAxis(s, w, P, ih, ymax);
  for (let i = 0; i <= 4; i++) {
    const v = xmax * i / 4;
    s.append(txt(money(v), { x: X(v), y: H - 24, 'text-anchor': 'middle', fill: c.muted, 'font-size': 10 }));
  }
  // break-even diagonal: above it you are making money
  s.append(el('line', { x1: X(0), y1: Y(0), x2: X(Math.min(xmax, ymax)), y2: Y(Math.min(xmax, ymax)),
    stroke: c.muted, 'stroke-dasharray': '4 4', opacity: .5 }));
  const rmax = Math.max(1, ...pts.map(p => p.r || 1));
  pts.forEach((p, i) => {
    const rr = 4 + Math.sqrt((p.r || 1) / rmax) * 12;
    const ci = el('circle', { cx: X(p.x), cy: Y(p.y), r: rr,
      fill: p.y >= p.x ? c.in : c.out, opacity: .55, stroke: '#fff', 'stroke-width': 1 });
    bind(host, ci, `<b>${p.label}</b><br>${o.xName || 'Cost'}: ${money(p.x, true)}<br>${o.yName || 'Revenue'}: ${money(p.y, true)}`,
      o.onClick && (() => o.onClick(p)));
    s.append(ci);
  });
  s.append(txt(o.xName || 'Cost →', { x: P.l + iw / 2, y: H - 8, 'text-anchor': 'middle', fill: c.muted, 'font-size': 10.5, 'font-weight': 600 }));
}

/* ------------------------------------------------- 12. sparkline (in tables) */
export function sparkline(values, o = {}) {
  const w = o.width || 74, h = o.height || 20;
  if (!values.length) return '';
  const hi = Math.max(...values), lo = Math.min(0, ...values), rng = hi - lo || 1;
  const d = values.map((v, i) =>
    `${i ? 'L' : 'M'}${(i / Math.max(values.length - 1, 1) * w).toFixed(1)} ${(h - ((v - lo) / rng) * h).toFixed(1)}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block">
    <path d="${d}" fill="none" stroke="${o.color || 'var(--water)'}" stroke-width="1.6"/></svg>`;
}

/* ------------------------------------------------- 13. gauge / progress */
export function gauge(host, value, target, o = {}) {
  const H = o.height || 130;
  const { s, w } = frame(host, H);
  const c = C(), cx = w / 2, cy = H - 14, R = Math.min(w * .38, H - 30);
  const frac = Math.max(0, Math.min(value / (target || 1), 1.35));
  const arc = (from, to, col, width) => {
    const a0 = Math.PI + Math.PI * Math.min(from, 1), a1 = Math.PI + Math.PI * Math.min(to, 1);
    const p = (a) => [cx + R * Math.cos(a), cy + R * Math.sin(a)];
    const [x1, y1] = p(a0), [x2, y2] = p(a1);
    return el('path', { d: `M${x1} ${y1}A${R} ${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x2} ${y2}`,
      fill: 'none', stroke: col, 'stroke-width': width, 'stroke-linecap': 'round' });
  };
  s.append(arc(0, 1, c.line, 13));
  s.append(arc(0, frac, frac >= 1 ? c.in : frac >= .7 ? c.saffron : c.out, 13));
  s.append(txt(o.format ? o.format(value) : money(value), { x: cx, y: cy - 14,
    'text-anchor': 'middle', fill: c.ink, 'font-size': 17, 'font-weight': 700 }));
  s.append(txt(o.label || `of ${money(target)}`, { x: cx, y: cy + 2, 'text-anchor': 'middle',
    fill: c.muted, 'font-size': 10.5 }));
}

function legendRow(host, items) {
  const d = document.createElement('div');
  d.className = 'legend';
  d.innerHTML = items.map(i => `<span><i style="background:${i.c}"></i>${i.n}</span>`).join('');
  host.append(d);
}
