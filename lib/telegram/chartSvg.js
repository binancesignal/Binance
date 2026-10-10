/**
 * Analysis chart as pure SVG (no external service, no native deps here).
 *
 * Draws the candles of the OB timeframe and marks EVERYTHING the strategy
 * looks at:
 *   - Order Block zone (+ OB candle, status, strength)
 *   - Displacement candles after the OB
 *   - Fair Value Gaps (open / partial), highlighting the one overlapping the OB
 *   - Liquidity: buy-side (BSL) / sell-side (SSL), equal highs / lows, sweep
 *   - Swing structure (zig-zag + HH / HL / LH / LL) and HTF bias / BOS / CHOCH
 *   - Premium / Discount range + equilibrium
 *   - EMA20 / EMA21 / EMA50, volume + RVOL, RSI
 *   - RSI divergence pivot marks (when present)
 *   - Entry / SL / TP1-3 with risk & reward boxes, current price
 *   - Analysis table + confluence chips underneath
 *
 * Only glyphs present in the bundled font subset are used
 * (ASCII, · — – … • ↑ ↓ → ▲ ▼ ≥ ≤ × ≈ ±).
 */
import { findSwings, calcRSI, detectRsiDivergence } from '../scanner/indicators.js';
import { detectFVGs } from '../scanner/fvg.js';
import { nowLK } from '../utils/time.js';

const W = 1000;
const FONT = 'DejaVu Sans';
const C = {
  bg: '#0b0e11',
  panel: '#11151b',
  grid: '#1b212a',
  text: '#eaecef',
  muted: '#848e9c',
  up: '#0ecb81',
  down: '#f6465d',
  entry: '#2b8cff',
  gold: '#f0b90b',
  purple: '#a78bfa',
  ema: '#ff9f43',
  ema21: '#ff9f43',
  ema50: '#5ac8fa',
  divBull: '#0ecb81',
  divBear: '#f6465d',
  tp1: '#0ecb81',
  tp2: '#2fd49a',
  tp3: '#5ee6a8',
  dark: '#0b0e11',
};

/* ------------------------------ helpers ------------------------------ */

const num = (v) => {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function decs(p) {
  const a = Math.abs(p);
  if (a >= 1000) return 2;
  if (a >= 100) return 3;
  if (a >= 1) return 4;
  if (a >= 0.01) return 5;
  if (a >= 0.0001) return 6;
  return 8;
}

/** width estimate for DejaVu Sans (used to size pills) */
function tw(s, size, bold = false) {
  let w = 0;
  for (const ch of String(s)) {
    if (ch === ' ') w += 0.32;
    else if (/[0-9]/.test(ch)) w += bold ? 0.7 : 0.636;
    else if (/[A-Z]/.test(ch)) w += bold ? 0.77 : 0.68;
    else if (/[a-z]/.test(ch)) w += bold ? 0.63 : 0.57;
    else if ('.,:;|!\'·'.includes(ch)) w += 0.34;
    else w += 0.65;
  }
  return w * size;
}

function niceTicks(lo, hi, count = 7) {
  const span = hi - lo;
  if (!(span > 0)) return { ticks: [], dp: 2 };
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    ticks.push(+v.toPrecision(12));
  }
  const dp = Math.min(8, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
  return { ticks, dp };
}

/** push labels apart vertically so they don't overlap */
function spread(items, gap, lo, hi) {
  const a = items.slice().sort((p, q) => p.y - q.y);
  for (let i = 1; i < a.length; i++) {
    if (a[i].y - a[i - 1].y < gap) a[i].y = a[i - 1].y + gap;
  }
  if (a.length && a[a.length - 1].y > hi) {
    a[a.length - 1].y = hi;
    for (let i = a.length - 2; i >= 0; i--) {
      if (a[i + 1].y - a[i].y < gap) a[i].y = a[i + 1].y - gap;
    }
  }
  if (a.length && a[0].y < lo) {
    a[0].y = lo;
    for (let i = 1; i < a.length; i++) {
      if (a[i].y - a[i - 1].y < gap) a[i].y = a[i - 1].y + gap;
    }
  }
  return a;
}

function emaSeries(cs, p = 20) {
  const out = new Array(cs.length).fill(null);
  if (cs.length < p) return out;
  const k = 2 / (p + 1);
  let e = cs.slice(0, p).reduce((a, c) => a + c.close, 0) / p;
  out[p - 1] = e;
  for (let i = p; i < cs.length; i++) {
    e = cs[i].close * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/* svg primitives */
const T = (x, y, s, o = {}) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${FONT}" font-size="${o.size || 18}"` +
  `${o.bold ? ' font-weight="bold"' : ''} fill="${o.fill || C.text}"` +
  `${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.opacity != null ? ` fill-opacity="${o.opacity}"` : ''}>${esc(s)}</text>`;

const L = (x1, y1, x2, y2, o = {}) =>
  `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${o.stroke || C.grid}" stroke-width="${o.w || 1}"` +
  `${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}${o.opacity != null ? ` stroke-opacity="${o.opacity}"` : ''}/>`;

const R = (x, y, w, h, o = {}) =>
  `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}"` +
  `${o.rx ? ` rx="${o.rx}"` : ''} fill="${o.fill || 'none'}"${o.fo != null ? ` fill-opacity="${o.fo}"` : ''}` +
  `${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw || 1}"` : ''}${o.so != null ? ` stroke-opacity="${o.so}"` : ''}` +
  `${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`;

/** text pill; x = left edge (or right edge when anchor === 'end'), cy = vertical centre */
function pill(x, cy, s, o = {}) {
  const size = o.size || 16;
  const padX = o.padX ?? 7;
  const h = size + (o.padY ?? 6);
  const w = tw(s, size, o.bold !== false) + padX * 2;
  const x0 = o.anchor === 'end' ? x - w : x;
  return (
    R(x0, cy - h / 2, w, h, {
      rx: 4,
      fill: o.bg || C.dark,
      fo: o.bgOpacity ?? 0.82,
      stroke: o.stroke,
      sw: 1.2,
    }) + T(x0 + padX, cy + size * 0.36, s, { size, bold: o.bold !== false, fill: o.fg || C.text })
  );
}

const arrow = (v) => (v === 'bullish' ? '▲' : v === 'bearish' ? '▼' : '—');
const biasColor = (b) => (b === 'bullish' ? C.up : b === 'bearish' ? C.down : C.muted);

/* ------------------------------ main ------------------------------ */

/**
 * @param {object} signal   signal row / scan result (fields on root or in metadata)
 * @param {Array}  candlesAll  [{time(sec), open, high, low, close, volume}] oldest → newest
 * @param {object} opts     { tf: '1h', htf: '4h', visible: 60 }
 * @returns {{svg: string, width: number, height: number} | null}
 */
export function buildChartSvg(signal, candlesAll, opts = {}) {
  const all = (candlesAll || [])
    .map((c) => ({
      time: +c.time,
      open: +c.open,
      high: +c.high,
      low: +c.low,
      close: +c.close,
      volume: +c.volume || 0,
    }))
    .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close));
  if (all.length < 12) return null;

  const tf = String(opts.tf || '1h');
  const htf = String(opts.htf || '4h');
  const VIS = Math.min(opts.visible || 60, all.length);
  const off = all.length - VIS;
  const vis = all.slice(off);
  const dt = vis.length > 1 ? vis[1].time - vis[0].time : 3600;

  const meta = signal.metadata || {};
  const ict = meta.ictAnalysis || null;
  const isZonePattern = (meta.strategy || signal.strategy) === 'zone_pattern';
  const isDoubleConfluence = (meta.strategy || signal.strategy) === 'double_confluence';
  const isEmaBump = (meta.strategy || signal.strategy) === 'ema_bump';
  const EB = isEmaBump ? meta.emaGeom || {} : null;
  // Strategy 2 (chart pattern): draw the pattern instead of SMC objects
  const G =
    (meta.strategy || signal.strategy) === 'chart_pattern' && meta.patternGeom ? meta.patternGeom : null;
  const isPat = !!G;
  // Double Top/Bottom geometry from metadata.chart
  const DH = isDoubleConfluence ? (meta.chart || {}) : null;
  const dhDouble = DH?.doubleGeometry || meta.doublePattern || null;
  const dhHarm = DH?.harmonicGeometry || meta.harmonic || null;
  const dhZone = DH?.zoneGeometry || meta.zone || null;
  const dirRaw = String(signal.direction || signal.dir || '').toUpperCase();
  const isShort = dirRaw === 'SHORT';
  const dirColor = isShort ? C.down : C.up;

  const entry = num(signal.entry);
  const sl = num(signal.sl);
  const tp1 = num(signal.tp1);
  const tp2 = num(signal.tp2);
  const tp3 = num(signal.tp3);
  const cur = num(signal.current_price ?? signal.price) ?? vis[vis.length - 1].close;

  const ob = isPat ? {} : meta.ob || signal.ob || {};
  const obLow = isPat ? null : num(ob.low ?? signal.ob_low);
  const obHigh = isPat ? null : num(ob.high ?? signal.ob_high);
  const obType = ob.type || (isShort ? 'bearish' : 'bullish');
  const obColor = obType === 'bearish' ? C.down : C.up;

  const structure = signal.structure || meta.structure || {};
  const pd = isPat ? {} : signal.pd || meta.pd || {};
  const liq = isPat ? {} : signal.liq || meta.liq || {};
  const conf = signal.conf || meta.conf || [];
  const rvol = num(signal.rvol ?? meta.rvol);
  const score = signal.score != null ? Math.round(+signal.score) : null;

  const pdec = decs(cur);
  const fp = (v) => (v == null ? '—' : Number(v).toFixed(v === cur ? pdec : decs(v)));

  /* ---------- derived analysis (recomputed on the same candles) ---------- */
  const swingsAll = findSwings(all, 3, 3);
  let prevH = null;
  let prevL = null;
  const swings = swingsAll.map((s) => {
    let lab;
    if (s.type === 'H') {
      lab = prevH == null ? 'H' : s.price > prevH ? 'HH' : 'LH';
      prevH = s.price;
    } else {
      lab = prevL == null ? 'L' : s.price > prevL ? 'HL' : 'LL';
      prevL = s.price;
    }
    return { ...s, lab };
  });
  const visSwings = swings.filter((s) => s.i >= off);

  const emaAll = emaSeries(all, 20);
  const ema21All = emaSeries(all, 21);
  const ema50All = emaSeries(all, 50);
  const rsi = calcRSI(all);
  const ema20 = emaAll[all.length - 1];
  const ema21 = ema21All[all.length - 1];
  const ema50 = ema50All[all.length - 1];
  const rsiDiv = detectRsiDivergence(all, 14);

  // FVGs: recompute on the same candles + stored ones from the signal
  const fvgFound = detectFVGs(all).map((f) => ({ ...f, idx0: f.index - 2 - off }));
  for (const f of signal.fvgs || meta.fvgs || []) {
    if (!f || num(f.low) == null || num(f.high) == null) continue;
    if (fvgFound.some((g) => g.time === f.time || (Math.abs(g.low - f.low) < 1e-12 && Math.abs(g.high - f.high) < 1e-12))) continue;
    const ti = f.time != null ? (f.time - vis[0].time) / dt - 2 : -0.5;
    fvgFound.push({ ...f, idx0: ti });
  }
  const overlapsOb = (f) =>
    obLow != null && obHigh != null && f.low <= obHigh && f.high >= obLow;
  const fvgs = (isPat ? [] : fvgFound)
    .filter((f) => f.idx0 > -60)
    .sort((a, b) => Number(overlapsOb(b)) - Number(overlapsOb(a)) || b.index - a.index)
    .slice(0, 4);

  /* ---------- layout ---------- */
  const M = { l: 16, r: 124 };
  const plotX0 = M.l;
  const plotX1 = W - M.r;
  const plotW = plotX1 - plotX0;
  const futureW = Math.round(plotW * 0.22);
  const candleAreaW = plotW - futureW;
  const futureX0 = plotX0 + candleAreaW;
  const step = candleAreaW / VIS;
  const bodyW = Math.max(3, step * 0.64);
  const xC = (i) => plotX0 + step * (i + 0.5);
  const idxOfTime = (t) => (t - vis[0].time) / dt;

  const mainTop = 166;
  const mainH = 620;
  const mainBot = mainTop + mainH;
  const volTop = mainBot + 50;
  const volH = 84;
  const volBot = volTop + volH;

  /* ---------- y range ---------- */
  let lo = Math.min(...vis.map((c) => c.low));
  let hi = Math.max(...vis.map((c) => c.high));
  for (const v of [entry, sl, cur, obLow, obHigh]) {
    if (v != null) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const R0 = hi - lo || hi * 0.01;
  const extLo = lo - R0 * 0.4;
  const extHi = hi + R0 * 0.4;
  const patPrices = isPat
    ? [
        G.top, G.bottom, G.level, G.fib?.price,
        G.smc?.ob?.high, G.smc?.ob?.low, G.smc?.fvg?.high, G.smc?.fvg?.low,
        ...(G.lines || []).flatMap((l) => [l.p1, l.p2]),
        ...(G.anchors || []).map((a) => a.p),
        ...(G.elliott?.pivots || []).map((p) => p.p),
        G.elliott?.invalidation,
        ...(G.zones || []).filter((z) => z.kind === 'REJECTION').flatMap((z) => [z.high, z.low]),
      ].map(num)
    : [];
  for (const v of patPrices) {
    if (v != null) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  if (isDoubleConfluence) {
    const dhPrices = [
      dhDouble?.first?.price, dhDouble?.second?.price, dhDouble?.neckline?.price,
      dhHarm?.X?.price, dhHarm?.A?.price, dhHarm?.B?.price, dhHarm?.C?.price, dhHarm?.D?.price,
      dhHarm?.przLow, dhHarm?.przHigh, dhZone?.low, dhZone?.high,
      tp1, tp2, tp3, sl, entry,
    ].map(num);
    for (const v of dhPrices) {
      if (v != null) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  const optional = [
    tp1, tp2, isPat ? null : tp3, // pattern chart: keep candles readable, TP3 shown as an off-scale tag
    num(liq.buySide), num(liq.sellSide),
    num(ict?.bosLevel), num(ict?.sweepLevel),
    num(pd.high), num(pd.low),
    ...fvgs.flatMap((f) => [f.low, f.high]),
  ];
  for (const v of optional) {
    if (v != null && v >= extLo && v <= extHi) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const pad = (hi - lo) * 0.05;
  const yMin = lo - pad;
  const yMax = hi + pad;
  const yOf = (p) => mainTop + ((yMax - p) / (yMax - yMin)) * mainH;
  const inRange = (p) => p != null && p >= yMin && p <= yMax;

  /* ---------- body parts ---------- */
  const defs = `<defs><clipPath id="mainClip"><rect x="${plotX0}" y="${mainTop}" width="${plotW}" height="${mainH}"/></clipPath>` +
    `<clipPath id="volClip"><rect x="${plotX0}" y="${volTop}" width="${plotW}" height="${volH}"/></clipPath></defs>`;

  const under = []; // grid, zones (drawn beneath candles)
  const candlesSvg = [];
  const over = []; // lines / markers above candles
  const axis = [];

  // panels
  under.push(R(plotX0, mainTop, plotW, mainH, { fill: C.panel }));

  // grid + price ticks (skipped near tags later)
  const { ticks, dp } = niceTicks(yMin, yMax, 7);
  const tickYs = ticks.map((v) => ({ v, y: yOf(v) }));
  for (const t of tickYs) under.push(L(plotX0, t.y, plotX1, t.y, { stroke: C.grid }));

  // time grid + labels
  const kEvery = Math.ceil(VIS / 5);
  const fmtT = (sec) =>
    new Date(sec * 1000)
      .toLocaleString('en-GB', {
        timeZone: 'Asia/Colombo',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
      .replace(',', '');
  for (let i = VIS - 1; i >= 0; i -= kEvery) {
    const x = xC(i);
    if (x - 62 < plotX0) break;
    under.push(L(x, mainTop, x, volBot, { stroke: C.grid }));
    axis.push(T(x, mainBot + 30, fmtT(vis[i].time), { size: 16, fill: C.muted, anchor: 'middle' }));
  }

  // ----- Premium / Discount -----
  const pdHi = num(pd.high);
  const pdLo = num(pd.low);
  const pdEq = num(pd.eq);
  const leftLabels = []; // {y, text, fg, stroke}
  const zoneLabels = []; // {x, y, text, bg, fg} — OB / FVG labels, spread so they never overlap
  if (pdHi != null && pdLo != null && pdEq != null) {
    const yEq = yOf(pdEq);
    const yH = yOf(pdHi);
    const yL = yOf(pdLo);
    under.push(R(plotX0, yH, plotW, yEq - yH, { fill: C.down, fo: 0.045 }));
    under.push(R(plotX0, yEq, plotW, yL - yEq, { fill: C.up, fo: 0.045 }));
    over.push(L(plotX0, yEq, plotX1, yEq, { stroke: C.muted, w: 1.4, dash: '2 6', opacity: 0.9 }));
    if (inRange(pdHi)) over.push(L(plotX0, yH, plotX1, yH, { stroke: C.muted, w: 1, dash: '10 6', opacity: 0.55 }));
    if (inRange(pdLo)) over.push(L(plotX0, yL, plotX1, yL, { stroke: C.muted, w: 1, dash: '10 6', opacity: 0.55 }));
    if (inRange(pdEq)) leftLabels.push({ y: yEq, text: 'EQ 50%', fg: C.muted, stroke: C.muted });
    if (inRange(pdHi)) leftLabels.push({ y: yH + 16, text: 'PREMIUM', fg: C.down, stroke: null, dim: true });
    if (inRange(pdLo)) leftLabels.push({ y: yL - 16, text: 'DISCOUNT', fg: C.up, stroke: null, dim: true });
  }

  // ----- Displacement band after OB -----
  const obTime = num(ob.time);
  const obIdx = obTime != null ? idxOfTime(obTime) : null;
  if (obIdx != null && obIdx >= -0.5 && num(ob.displacement) > 0) {
    const bx0 = xC(obIdx + 0.5) - step / 2;
    const bx1 = Math.min(futureX0, xC(obIdx + 6.5) - step / 2);
    under.push(R(bx0, mainTop, bx1 - bx0, mainH, { fill: '#ffffff', fo: 0.035 }));
    over.push(T((bx0 + bx1) / 2, mainBot - 12, 'DISPLACEMENT', { size: 15, fill: C.muted, anchor: 'middle', bold: true }));
  }

  // ----- FVG zones -----
  const fvgRows = [];
  fvgs.forEach((f) => {
    const x0 = f.idx0 <= -0.5 ? plotX0 : xC(f.idx0) - step / 2;
    const yT = yOf(f.high);
    const yB = yOf(f.low);
    const ov = overlapsOb(f);
    under.push(R(x0, yT, plotX1 - x0, yB - yT, { fill: C.purple, fo: ov ? 0.24 : 0.14, stroke: C.purple, sw: 1.4, so: 0.85, dash: '6 4' }));
    const label = `FVG ${f.type === 'bearish' ? '▼' : '▲'}${f.status === 'PARTIAL' ? ' PART' : ''}${ov ? ' · OB' : ''}`;
    const ly = yB - yT >= 30 ? yB - 15 : yT - 14;
    zoneLabels.push({ x: Math.max(plotX0 + 4, x0 + 4), y: ly, text: label, bg: C.purple, fg: '#fff', size: 15 });
    fvgRows.push({ f, ov });
  });

  // ----- OB zone -----
  if (obLow != null && obHigh != null) {
    const x0 = obIdx == null || obIdx <= -0.5 ? plotX0 : xC(obIdx) - step / 2;
    const yT = yOf(obHigh);
    const yB = yOf(obLow);
    under.push(R(x0, yT, plotX1 - x0, yB - yT, { fill: obColor, fo: 0.2, stroke: obColor, sw: 2, so: 0.9 }));
    const st = String(ob.status || '');
    const status = !st ? '' : st === 'FRESH' ? ' · FRESH' : st === 'TESTED ONCE' ? ' · TESTED 1x' : st === 'TESTED MULTIPLE' ? ' · TESTED 3x+' : ` · ${st}`;
    const label = isZonePattern
      ? `${obType === 'bearish' ? 'BEAR' : 'BULL'} ZONE · ${meta.zone?.sourceCount || 0} SOURCES`
      : `${obType === 'bearish' ? 'BEAR' : 'BULL'} OB${status}`;
    const ly = yT - 17 > mainTop + 34 ? yT - 17 : yB + 17;
    zoneLabels.push({ x: Math.max(plotX0 + 4, x0 + 2), y: ly, text: label, bg: obColor, fg: '#fff', size: 16 });
  }

  // ICT SMC: mark the candle-close break that validated the setup.
  if (!isPat && ict && num(ict.bosLevel) != null && inRange(+ict.bosLevel)) {
    const bosIdx = ict.bosTime != null ? idxOfTime(+ict.bosTime) : VIS - 1;
    const x0 = bosIdx >= -0.5 ? xC(bosIdx) : plotX0;
    over.push(L(x0, yOf(+ict.bosLevel), futureX0, yOf(+ict.bosLevel), {
      stroke: dirColor,
      w: 2.4,
      dash: '7 5',
      opacity: 0.95,
    }));
    zoneLabels.push({
      x: Math.max(plotX0 + 4, x0 + 4),
      y: yOf(+ict.bosLevel) - 15,
      text: `BOS ${isShort ? '▼' : '▲'} CLOSE`,
      bg: dirColor,
      fg: '#fff',
      size: 15,
    });
  }

  if (isZonePattern) {
    const bosLevel = num(meta.internalStructure?.bosLevel ?? meta.breakoutLevel);
    if (bosLevel != null && inRange(bosLevel)) {
      const bosIdx = meta.internalStructure?.bosTime != null
        ? idxOfTime(+meta.internalStructure.bosTime)
        : VIS - 1;
      const x0 = bosIdx >= -0.5 ? xC(bosIdx) : plotX0;
      over.push(L(x0, yOf(bosLevel), futureX0, yOf(bosLevel), {
        stroke: dirColor,
        w: 2.4,
        dash: '7 5',
        opacity: 0.95,
      }));
      zoneLabels.push({
        x: Math.max(plotX0 + 4, x0 + 4),
        y: yOf(bosLevel) - 15,
        text: `PATTERN BOS ${isShort ? '▼' : '▲'} CLOSE`,
        bg: dirColor,
        fg: '#fff',
        size: 15,
      });
    }
    for (const [index, touch] of (meta.patternTouches || []).entries()) {
      const candleIndex = touch.time != null ? idxOfTime(+touch.time) : num(touch.index);
      const touchPrice = num(touch.price);
      if (candleIndex == null || candleIndex < -0.5 || touchPrice == null || !inRange(touchPrice)) continue;
      const x = xC(candleIndex);
      const y = yOf(touchPrice);
      over.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="${C.bg}" stroke="${dirColor}" stroke-width="2.6"/>`);
      over.push(T(x + 11, y - 10, `T${index + 1}`, { size: 13, fill: dirColor, bold: true }));
    }
  }

  // ----- Strategy 2: chart pattern geometry -----
  const patLabels = [];

  // ----- Double Top/Bottom geometry -----
  if (isDoubleConfluence && (dhDouble || dhHarm)) {
    const dhCol = isShort ? C.down : C.up;
    const przCol = C.purple;
    const zoneCol = C.gold;

    // Support / Resistance zone band
    if (dhZone && num(dhZone.low) != null && num(dhZone.high) != null) {
      const zl = yOf(dhZone.high);
      const zh = yOf(dhZone.low);
      under.push(R(plotX0, zl, plotW, Math.max(2, zh - zl), { fill: zoneCol, fo: 0.12, stroke: zoneCol, sw: 1.2, so: 0.7, dash: '8 5' }));
      zoneLabels.push({
        x: plotX0 + 6,
        y: zl - 12,
        text: `${dhZone.type || (isShort ? 'RESISTANCE' : 'SUPPORT')} ZONE`,
        bg: zoneCol,
        fg: '#111',
        size: 14,
      });
    }

    // PRZ band
    if (dhHarm && num(dhHarm.przLow) != null && num(dhHarm.przHigh) != null) {
      const pl = yOf(dhHarm.przHigh);
      const ph = yOf(dhHarm.przLow);
      under.push(R(plotX0, pl, plotW, Math.max(2, ph - pl), { fill: przCol, fo: 0.18, stroke: przCol, sw: 1.5, so: 0.85 }));
      zoneLabels.push({
        x: plotX0 + 6,
        y: pl - 12,
        text: 'PRZ',
        bg: przCol,
        fg: '#fff',
        size: 14,
      });
    }

    // Structure points (Double / H&S / Triple) + neckline
    if (dhDouble) {
      const pts = [
        { key: 'first', p: dhDouble.first },
        { key: 'second', p: dhDouble.second },
      ];
      if (dhDouble.head) pts.push({ key: 'head', p: dhDouble.head });
      if (dhDouble.midPoint) pts.push({ key: 'mid', p: dhDouble.midPoint });
      for (const { key, p } of pts) {
        if (!p || num(p.price) == null) continue;
        const ti = p.time != null ? idxOfTime(p.time) : null;
        if (ti == null || ti < -0.5) continue;
        const ax = xC(ti);
        const ay = yOf(p.price);
        over.push(`<circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="7" fill="${C.bg}" stroke="${dhCol}" stroke-width="2.8"/>`);
        const lab = p.label || (key === 'head' ? 'HEAD' : key === 'mid' ? (isShort ? 'T2' : 'B2') : key === 'first' ? (isShort ? 'H1' : 'L1') : (isShort ? 'H2' : 'L2'));
        over.push(T(ax, ay - 16, lab, { size: 15, bold: true, fill: dhCol, anchor: 'middle' }));
      }
      // Neckline
      if (dhDouble.neckline && num(dhDouble.neckline.price) != null) {
        const ny = yOf(dhDouble.neckline.price);
        over.push(`<line x1="${plotX0}" y1="${ny.toFixed(1)}" x2="${futureX0}" y2="${ny.toFixed(1)}" stroke="${dhCol}" stroke-width="1.6" stroke-dasharray="6 4" opacity="0.85"/>`);
        zoneLabels.push({
          x: plotX0 + 6,
          y: ny - 12,
          text: 'NECKLINE',
          bg: dhCol,
          fg: '#fff',
          size: 13,
        });
      }
      // Connect first-second (double structure)
      if (dhDouble.first?.time != null && dhDouble.second?.time != null &&
          num(dhDouble.first.price) != null && num(dhDouble.second.price) != null) {
        const i1 = idxOfTime(dhDouble.first.time);
        const i2 = idxOfTime(dhDouble.second.time);
        if (i1 != null && i2 != null && i1 >= -0.5 && i2 >= -0.5) {
          over.push(`<line x1="${xC(i1).toFixed(1)}" y1="${yOf(dhDouble.first.price).toFixed(1)}" x2="${xC(i2).toFixed(1)}" y2="${yOf(dhDouble.second.price).toFixed(1)}" stroke="${dhCol}" stroke-width="1.8" opacity="0.7"/>`);
        }
      }
    }

    // Harmonic Structure polyline + labels
    if (dhHarm) {
      const pts = ['X', 'A', 'B', 'C', 'D'].map((lab) => {
        const p = dhHarm[lab];
        if (!p || num(p.price) == null || p.time == null) return null;
        const ti = idxOfTime(p.time);
        if (ti == null || ti < -0.5) return null;
        return { lab, x: xC(ti), y: yOf(p.price), price: p.price };
      }).filter(Boolean);

      if (pts.length >= 2) {
        const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        over.push(`<path d="${d}" fill="none" stroke="${C.gold}" stroke-width="2.2" opacity="0.9"/>`);
      }
      for (const p of pts) {
        over.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="6.5" fill="${C.bg}" stroke="${C.gold}" stroke-width="2.4"/>`);
        const above = p.y < yOf((yMin + yMax) / 2);
        over.push(T(p.x, above ? p.y - 14 : p.y + 22, p.lab, { size: 15, bold: true, fill: C.gold, anchor: 'middle' }));
      }

      const hType = dhHarm.type || meta.harmonic?.type || 'HARMONIC';
      const hDir = isShort ? 'Bearish' : 'Bullish';
      zoneLabels.push({
        x: plotX0 + 6,
        y: mainTop + 18,
        text: `${hDir} ${hType}`,
        bg: C.gold,
        fg: '#111',
        size: 14,
      });
      if (dhDouble?.type) {
        zoneLabels.push({
          x: plotX0 + 6,
          y: mainTop + 40,
          text: String(dhDouble.type).replace('_', ' '),
          bg: dhCol,
          fg: '#fff',
          size: 13,
        });
      }
    }

    // Liquidity sweep marker
    const sweep = meta.liquiditySweep;
    if (sweep?.confirmed && sweep.time != null) {
      const si = idxOfTime(sweep.time);
      if (si != null && si >= -0.5) {
        const sx = xC(si);
        const sy = yOf(num(sweep.sweepExtreme) ?? (isShort ? vis[Math.round(si)]?.high : vis[Math.round(si)]?.low));
        over.push(`<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="8" fill="none" stroke="${C.gold}" stroke-width="2.5"/>`);
        over.push(T(sx, sy - 18, 'SWEEP', { size: 13, bold: true, fill: C.gold, anchor: 'middle' }));
      }
    }
  }


  if (isPat) {
    const patCol = C.gold;
    const idxB = G.tb != null ? idxOfTime(G.tb) : VIS - 2;
    const idx0 = G.t0 != null ? Math.max(-0.5, idxOfTime(G.t0)) : -0.5;
    const xL = idx0 <= -0.5 ? plotX0 : xC(idx0);
    const xB = xC(idxB);
    const xExt = Math.min(futureX0 - 4, xC(idxB + 3));
    const kindName = String(G.type || '').replace(/_/g, ' ');

    // pattern zone (start → breakout)
    if (num(G.top) != null && num(G.bottom) != null && (G.type === 'BULL_FLAG' || G.type === 'BEAR_FLAG')) {
      const fx = G.flagStartT != null ? xC(Math.max(0, idxOfTime(G.flagStartT))) - step / 2 : xL;
      under.push(R(fx, yOf(G.top), xB + step / 2 - fx, yOf(G.bottom) - yOf(G.top), { fill: patCol, fo: 0.1, stroke: patCol, sw: 1.4, so: 0.6, dash: '6 4' }));
    }
    if ((G.lines || []).length === 2) {
      const [a, b] = G.lines;
      const pts = [
        [xL, yOf(a.p1)], [xB, yOf(a.p2)], [xB, yOf(b.p2)], [xL, yOf(b.p1)],
      ].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      if (G.type !== 'BULL_FLAG' && G.type !== 'BEAR_FLAG') {
        under.push(`<polygon points="${pts}" fill="${patCol}" fill-opacity="0.08"/>`);
      }
    }

    // trendlines / neckline, extended a little past the breakout candle
    for (const ln of G.lines || []) {
      const x1 = ln.t1 != null ? Math.max(plotX0, xC(idxOfTime(ln.t1))) : xL;
      const x2 = xB;
      const slopePx = x2 !== x1 ? (yOf(ln.p2) - yOf(ln.p1)) / (x2 - x1) : 0;
      const y1 = ln.t1 != null && xC(idxOfTime(ln.t1)) < plotX0 ? yOf(ln.p1) + slopePx * (plotX0 - xC(idxOfTime(ln.t1))) : yOf(ln.p1);
      const yExt = yOf(ln.p2) + slopePx * (xExt - x2);
      const col = ln.broken ? dirColor : patCol;
      over.push(L(x1, y1, xExt, yExt, { stroke: col, w: ln.broken ? 3 : 2.2, opacity: ln.broken ? 1 : 0.9, dash: ln.broken ? undefined : '10 5' }));
    }

    // breakout level tag + breakout candle marker
    if (num(G.level) != null && inRange(G.level)) {
      over.push(L(xB - step * 1.5, yOf(G.level), futureX0, yOf(G.level), { stroke: dirColor, w: 1.6, dash: '3 4', opacity: 0.9 }));
    }
    const bc = G.pending ? null : vis[Math.round(idxB)];
    if (G.pending && num(G.level) != null) {
      const ly = yOf(G.level);
      patLabels.push({ x: futureX0 - 190, y: isShort ? ly + 24 : ly - 24, text: `WAIT CLOSE ${isShort ? '▼' : '▲'} ${fp(G.level)}`, bg: dirColor, fg: '#fff', size: 15 });
    }
    if (bc) {
      const bx = xC(Math.round(idxB));
      const up = !isShort;
      const ty = up ? yOf(bc.low) + 30 : yOf(bc.high) - 30;
      over.push(`<path d="${up ? `M${bx.toFixed(1)},${(ty - 14).toFixed(1)} l-9,16 h18 z` : `M${bx.toFixed(1)},${(ty + 14).toFixed(1)} l-9,-16 h18 z`}" fill="${dirColor}"/>`);
      patLabels.push({ x: Math.min(futureX0 - 130, Math.max(plotX0 + 4, bx - 50)), y: up ? ty + 26 : ty - 26, text: `BREAKOUT ${up ? '▲' : '▼'}`, bg: dirColor, fg: '#fff', size: 15 });
    }

    // anchor points (the swings the pattern is built from)
    for (const an of G.anchors || []) {
      const ai = an.t != null ? idxOfTime(an.t) : null;
      if (ai == null || ai < -0.5 || num(an.p) == null) continue;
      const ax = xC(ai);
      const ay = yOf(an.p);
      over.push(`<circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="6.5" fill="${C.bg}" stroke="${patCol}" stroke-width="2.6"/>`);
      if (G.anchors.length <= 6) {
        const isHigh = an.label && /^(H|Top|Pole top)/.test(an.label) ? true : an.label && /^(L|Bottom|Pole low)/.test(an.label) ? false : ay < yOf((G.top + G.bottom) / 2);
        over.push(T(ax, isHigh ? ay - 14 : ay + 26, an.label, { size: 14, bold: true, fill: patCol, anchor: 'middle' }));
      }
    }

    // Harmonic XABCD structure line (chart-pattern harmonics)
    if (G.harmonic || /GARTLEY|BAT|BUTTERFLY|CRAB|CYPHER|SHARK|ABCD|FIVE_O|THREE_DRIVES|WOLFE|QUASIMODO|ONE_TWO_THREE|WYCKOFF|LIQUIDITY_SWEEP|BREAKOUT_RETEST|CORRECTIVE_ABC|ELLIOTT_WAVE/.test(String(G.type || ''))) {
      const labs = G.anchors?.length ? G.anchors.map((a) => String(a.label).toUpperCase()) : ['X', 'A', 'B', 'C', 'D'];
      const hPts = [];
      for (const lab of labs) {
        const an = (G.anchors || []).find((a) => String(a.label).toUpperCase() === lab);
        if (!an || an.t == null || num(an.p) == null) continue;
        const ti = idxOfTime(an.t);
        if (ti == null || ti < -0.5) continue;
        hPts.push({ lab, x: xC(ti), y: yOf(an.p) });
      }
      if (hPts.length >= 2) {
        const d = hPts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
        over.push(`<path d="${d}" fill="none" stroke="${C.gold}" stroke-width="2.2" opacity="0.95"/>`);
        for (const pt of hPts) {
          over.push(`<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="6.5" fill="${C.bg}" stroke="${C.gold}" stroke-width="2.4"/>`);
          over.push(T(pt.x, pt.y - 14, pt.lab, { size: 15, bold: true, fill: C.gold, anchor: 'middle' }));
        }
      }
      if (num(G.przLow) != null && num(G.przHigh) != null) {
        const y1 = yOf(G.przHigh);
        const y2 = yOf(G.przLow);
        under.push(R(plotX0, y1, plotW, y2 - y1, { fill: C.gold, fo: 0.08, stroke: C.gold, sw: 1, so: 0.5, dash: '4 4' }));
      }
      zoneLabels.push({
        x: plotX0 + 6,
        y: mainTop + 18,
        text: String(G.type || 'HARMONIC').replace(/_/g, ' '),
        bg: C.gold,
        fg: '#111',
        size: 14,
      });
    }



    // ---- Elliott Wave count ----
    const ew = G.elliott || meta.universal?.elliott || null;
    const ewPivots = ew?.pivots || ew?.primary?.pivots || [];
    if (ewPivots.length >= 2) {
      const ewPts = [];
      for (const pv of ewPivots) {
        const ti = pv.t != null ? idxOfTime(pv.t) : (pv.i != null ? pv.i - off : null);
        const price = num(pv.p ?? pv.price);
        if (ti == null || ti < -0.5 || price == null) continue;
        ewPts.push({ label: String(pv.label ?? ''), x: xC(ti), y: yOf(price), price });
      }
      if (ewPts.length >= 2) {
        const d = ewPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        over.push(`<path d="${d}" fill="none" stroke="${C.purple}" stroke-width="2" opacity="0.9"/>`);
        for (const p of ewPts) {
          over.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5.5" fill="${C.bg}" stroke="${C.purple}" stroke-width="2"/>`);
          over.push(T(p.x, p.y - 14, p.label, { size: 13, bold: true, fill: C.purple, anchor: 'middle' }));
        }
        const ewType = ew.type || ew.primary?.type || 'Elliott';
        const ewDir = ew.direction || ew.primary?.direction || '';
        const ewWave = ew.currentWave ?? ew.primary?.currentWave;
        const ewConf = ew.confidence ?? ew.primary?.confidence;
        const tag = [ewType, ewDir, ewWave != null ? `W${ewWave}` : null, ewConf != null ? `${Math.round(ewConf)}%` : null].filter(Boolean).join(' · ');
        patLabels.push({
          x: plotX0 + 6,
          y: mainTop + 18,
          text: `EW ${tag}`,
          bg: C.purple,
          fg: '#fff',
          size: 13,
        });
      }
      if (num(ew.invalidation ?? ew.primary?.invalidation) != null) {
        const inv = num(ew.invalidation ?? ew.primary?.invalidation);
        const iy = yOf(inv);
        over.push(`<line x1="${plotX0}" y1="${iy.toFixed(1)}" x2="${futureX0}" y2="${iy.toFixed(1)}" stroke="${C.purple}" stroke-width="1.2" stroke-dasharray="4 4" opacity="0.7"/>`);
        patLabels.push({ x: plotX0 + 6, y: iy - 10, text: 'EW invalidation', bg: C.purple, fg: '#fff', size: 12 });
      }
    }

    // ---- SMC confluence: OB at base, FVG, liquidity sweep ----
    const sm = G.smc || {};
    if (sm.ob && num(sm.ob.high) != null) {
      const oi = sm.ob.t != null ? idxOfTime(sm.ob.t) : -0.5;
      const ox0 = oi <= -0.5 ? plotX0 : xC(oi) - step / 2;
      const oc = sm.ob.type === 'bearish' ? C.down : C.up;
      under.push(R(ox0, yOf(sm.ob.high), futureX0 - ox0, yOf(sm.ob.low) - yOf(sm.ob.high), { fill: oc, fo: 0.18, stroke: oc, sw: 1.6, so: 0.85 }));
      patLabels.push({ x: Math.max(plotX0 + 4, ox0 + 2), y: yOf(sm.ob.high) - 14, text: `${sm.ob.type === 'bearish' ? 'BEAR' : 'BULL'} OB`, bg: oc, fg: '#fff', size: 14 });
    }
    if (sm.fvg && num(sm.fvg.high) != null) {
      const fi = sm.fvg.t != null ? idxOfTime(sm.fvg.t) : -0.5;
      const fx0 = fi <= -0.5 ? plotX0 : xC(fi) - step / 2;
      under.push(R(fx0, yOf(sm.fvg.high), futureX0 - fx0, yOf(sm.fvg.low) - yOf(sm.fvg.high), { fill: C.purple, fo: 0.2, stroke: C.purple, sw: 1.3, so: 0.85, dash: '6 4' }));
      patLabels.push({ x: Math.max(plotX0 + 4, fx0 + 2), y: yOf(sm.fvg.low) + 14, text: `FVG ${sm.fvg.type === 'bearish' ? '▼' : '▲'}`, bg: C.purple, fg: '#fff', size: 14 });
    }
    if (sm.sweep && sm.sweep.t != null) {
      const si2 = idxOfTime(sm.sweep.t);
      if (si2 >= -0.5) {
        const sx = xC(si2);
        const sy = yOf(sm.sweep.p);
        over.push(`<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="11" fill="none" stroke="${C.gold}" stroke-width="2.6"/>`);
        patLabels.push({ x: Math.min(futureX0 - 90, Math.max(plotX0 + 4, sx - 34)), y: isShort ? sy - 34 : sy + 34, text: `SWEEP ${isShort ? '▼' : '▲'}`, bg: C.gold, fg: C.dark, size: 14 });
      }
    }
    // ---- Fib confluence: the matched retracement level of the prior leg ----
    const fb = G.fib || {};
    const FIBC = '#5ac8fa';
    if (fb.price != null && inRange(fb.price)) {
      const fy = yOf(fb.price);
      over.push(L(plotX0, fy, futureX0, fy, { stroke: FIBC, w: 1.8, dash: '2 5', opacity: 0.95 }));
      leftLabels.push({ y: fy + 15, text: `FIB ${fb.level}`, fg: C.dark, bg: FIBC });
    }

    // ---- Analysis zones from the universal engine ----
    const ZREJ = '#ff9f1a';
    const gSmcOb = G.smc?.ob, gSmcFvg = G.smc?.fvg;
    const overlap = (a, b) => b && num(b.high) != null && a.low <= b.high && a.high >= b.low;
    for (const z of G.zones || []) {
      if (num(z.high) == null || num(z.low) == null) continue;
      if (z.kind === 'OB' && overlap(z, gSmcOb)) continue; // already drawn by SMC block
      if (z.kind === 'FVG' && overlap(z, gSmcFvg)) continue;
      const zt = Math.max(mainTop, yOf(z.high));
      const zb = Math.min(mainBot, yOf(z.low));
      if (zb < mainTop || zt > mainBot) continue; // outside the visible price range
      const h = Math.max(6, zb - zt);
      if (z.kind === 'REJECTION') {
        under.push(R(plotX0, zt, futureX0 - plotX0, h, { fill: ZREJ, fo: 0.2, stroke: ZREJ, sw: 2.2, so: 0.95 }));
        patLabels.push({ x: plotX0 + 8, y: zt - 14 > mainTop + 40 ? zt - 14 : zb + 16, text: String(z.label || 'REJECTION ZONE').toUpperCase(), bg: ZREJ, fg: C.dark, size: 14 });
      } else if (z.kind === 'OB') {
        const oc = dirColor;
        under.push(R(plotX0, zt, futureX0 - plotX0, h, { fill: oc, fo: 0.14, stroke: oc, sw: 1.4, so: 0.8 }));
        patLabels.push({ x: plotX0 + 8, y: zb + 16, text: String(z.label || 'OB'), bg: oc, fg: '#fff', size: 13 });
      } else if (z.kind === 'FVG') {
        under.push(R(plotX0, zt, futureX0 - plotX0, h, { fill: C.purple, fo: 0.16, stroke: C.purple, sw: 1.3, so: 0.85, dash: '6 4' }));
        patLabels.push({ x: plotX0 + 8, y: zb + 16, text: 'FVG', bg: C.purple, fg: '#fff', size: 13 });
      }
    }
    // liquidity levels (equal highs / lows, buy-side / sell-side)
    const seenLiq = new Set();
    for (const lv of G.liqLevels || []) {
      const pr = num(lv.price);
      if (pr == null || !inRange(pr)) continue;
      const key = Math.round(yOf(pr) / 6);
      if (seenLiq.has(key)) continue;
      seenLiq.add(key);
      const ly = yOf(pr);
      over.push(L(plotX0, ly, futureX0, ly, { stroke: C.gold, w: 1.4, dash: '8 5', opacity: 0.85 }));
      patLabels.push({ x: futureX0 - 118, y: ly - 11, text: String(lv.label || lv.kind), bg: C.dark, fg: C.gold, size: 12 });
    }
    // equilibrium + premium / discount
    if (G.pd && num(G.pd.eq) != null && inRange(+G.pd.eq)) {
      const ey = yOf(+G.pd.eq);
      over.push(L(plotX0, ey, futureX0, ey, { stroke: C.muted, w: 1.4, dash: '2 6', opacity: 0.9 }));
      patLabels.push({ x: plotX0 + 8, y: ey - 11, text: `EQ · ${String(G.pd.zone || '').toUpperCase()}${G.pd.pos != null ? ` ${Math.round(G.pd.pos * 100)}%` : ''}`, bg: C.dark, fg: C.muted, size: 12 });
    }

    // measured move (pattern height projected from the breakout level)
    if (num(G.level) != null && num(G.tp2) != null) {
      const mx = futureX0 - 12;
      const y1 = yOf(G.level);
      const y2 = yOf(G.tp2);
      if (Math.abs(y2 - y1) > 12) {
        over.push(L(mx, y1, mx, y2, { stroke: dirColor, w: 2.2, opacity: 0.9 }));
        const dy = y2 < y1 ? 10 : -10;
        over.push(`<path d="M${mx.toFixed(1)},${y2.toFixed(1)} l-6,${(dy * 1.2).toFixed(1)} h12 z" fill="${dirColor}"/>`);
      }
      patLabels.push({ x: futureX0 - 150, y: (y1 + y2) / 2, text: 'MEASURED MOVE', bg: C.dark, fg: dirColor, size: 14 });
    }

    // pattern name
    patLabels.push({ x: plotX0 + 8, y: mainTop + 22, text: `${isShort ? '▼' : '▲'} ${kindName}${G.pending ? ' · FORMING' : ''}`, bg: patCol, fg: C.dark, size: 18 });
  }

  // ----- Trade box (future area): risk + reward -----
  const tpFar = [tp3, tp2, tp1].find((v) => v != null);
  if (entry != null && sl != null) {
    under.push(R(futureX0, Math.min(yOf(entry), yOf(sl)), futureW, Math.abs(yOf(sl) - yOf(entry)), { fill: C.down, fo: 0.2 }));
  }
  if (entry != null && tpFar != null) {
    under.push(R(futureX0, Math.min(yOf(entry), yOf(tpFar)), futureW, Math.abs(yOf(tpFar) - yOf(entry)), { fill: C.up, fo: 0.13 }));
  }
  over.push(L(futureX0, mainTop, futureX0, mainBot, { stroke: C.muted, w: 1, dash: '3 5', opacity: 0.6 }));

  // ----- Liquidity -----
  const bsl = num(liq.buySide);
  const ssl = num(liq.sellSide);
  const gold = C.gold;
  const dedupe = (arr, ref) => {
    const out = [];
    for (const e of arr || []) {
      const p = num(e.price);
      if (p == null) continue;
      if (ref.some((r) => r != null && Math.abs(r - p) / p < 0.0008)) continue;
      if (out.some((q) => Math.abs(q - p) / p < 0.0015)) continue;
      out.push(p);
    }
    return out.slice(0, 2);
  };
  const eqh = dedupe(liq.equalHighs, [bsl]);
  const eql = dedupe(liq.equalLows, [ssl]);
  const liqLines = [
    ...(bsl != null ? [{ p: bsl, t: 'BSL', w: 2.2, dash: '12 7' }] : []),
    ...(ssl != null ? [{ p: ssl, t: 'SSL', w: 2.2, dash: '12 7' }] : []),
    ...eqh.map((p) => ({ p, t: 'EQH', w: 1.6, dash: '3 5' })),
    ...eql.map((p) => ({ p, t: 'EQL', w: 1.6, dash: '3 5' })),
  ];
  for (const ln of liqLines) {
    if (!inRange(ln.p)) continue;
    over.push(L(plotX0, yOf(ln.p), plotX1, yOf(ln.p), { stroke: gold, w: ln.w, dash: ln.dash, opacity: 0.9 }));
    leftLabels.push({ y: yOf(ln.p) - 15, text: `${ln.t} ${fp(ln.p)}`, fg: C.dark, bg: gold });
  }

  // ----- EMA20 / EMA21 / EMA50 -----
  const pushEma = (series, stroke, w, opacity = 0.9, dash = null) => {
    const pts = [];
    for (let i = 0; i < VIS; i++) {
      const v = series[off + i];
      if (v != null) pts.push(`${xC(i).toFixed(1)},${yOf(v).toFixed(1)}`);
    }
    if (pts.length > 1) {
      over.push(
        `<polyline points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-width="${w}"` +
          ` stroke-opacity="${opacity}" stroke-linejoin="round"` +
          `${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
      );
    }
  };
  if (isEmaBump) {
    // EMA Bump: EMA fast = RED, EMA slow = ORANGE (same look as the trader's own chart)
    pushEma(emaSeries(all, EB.fast || meta.emaFast || 20), '#ff4d4f', 2.2, 0.95);
    pushEma(emaSeries(all, EB.slow || meta.emaSlow || 50), '#ffa940', 3.2, 0.95);

    // geometry markers: dip, break-up, TOP (= entry level), pullback touch
    const ebIdx = (t) => vis.findIndex((c) => c.time === t);
    const ebDot = (t, price, color, label, above) => {
      const i = ebIdx(t);
      if (i < 0 || !Number.isFinite(+price) || !inRange(+price)) return;
      const x = xC(i);
      const y = yOf(+price);
      over.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="none" stroke="${color}" stroke-width="2.4"/>`);
      over.push(T(x, y + (above ? -16 : 26), label, { size: 14, bold: true, fill: color, anchor: 'middle' }));
    };
    if (EB.top?.price != null && inRange(+EB.top.price)) {
      const ti = ebIdx(EB.top.time);
      const x0 = ti >= 0 ? xC(ti) : plotX0;
      over.push(L(x0, yOf(+EB.top.price), plotX1, yOf(+EB.top.price), { stroke: C.entry, w: 2, dash: '8 5', opacity: 0.95 }));
      leftLabels.push({ y: yOf(+EB.top.price) - 15, text: `TOP / ENTRY ${fp(+EB.top.price)}`, fg: C.dark, bg: C.entry });
    }
    ebDot(EB.dip?.time, EB.dip?.price, '#9aa4b2', 'DIP', isShort);
    ebDot(EB.top?.time, EB.top?.price, C.entry, 'TOP', !isShort);
    ebDot(EB.touch?.time, EB.touch?.price, '#ffa940', `EMA${EB.slow || 50} touch`, isShort);
  } else {
    pushEma(emaAll, C.ema, 1.6, 0.55); // EMA20 (legacy, thinner)
    pushEma(ema21All, C.ema21, 2.2, 0.95); // EMA21 — gate uses this
    pushEma(ema50All, C.ema50, 2.0, 0.9, '6 4'); // EMA50 — dashed cyan
  }

  // ----- RSI divergence pivots on price chart -----
  const drawDiv = (pivots, color, label) => {
    if (!pivots?.a || !pivots?.b) return;
    const ia = pivots.a.i - off;
    const ib = pivots.b.i - off;
    if (ia < -2 || ib < -2 || ia >= VIS + 2 || ib >= VIS + 2) return;
    const ya = yOf(label === 'BULL DIV' ? pivots.a.low : pivots.a.high);
    const yb = yOf(label === 'BULL DIV' ? pivots.b.low : pivots.b.high);
    const xa = xC(Math.max(0, Math.min(VIS - 1, ia)));
    const xb = xC(Math.max(0, Math.min(VIS - 1, ib)));
    over.push(L(xa, ya, xb, yb, { stroke: color, w: 2.4, dash: '5 4', opacity: 0.95 }));
    // pivot dots
    over.push(`<circle cx="${xa.toFixed(1)}" cy="${ya.toFixed(1)}" r="5" fill="${color}" fill-opacity="0.9"/>`);
    over.push(`<circle cx="${xb.toFixed(1)}" cy="${yb.toFixed(1)}" r="5" fill="${color}" fill-opacity="0.9"/>`);
    // label near newer pivot
    leftLabels.push({
      y: yb - 18,
      text: `${label} RSI ${pivots.a.rsi.toFixed(0)}→${pivots.b.rsi.toFixed(0)}`,
      fg: C.dark,
      bg: color,
    });
  };
  if (rsiDiv.bullish) drawDiv(rsiDiv.bullPivots, C.divBull, 'BULL DIV');
  if (rsiDiv.bearish) drawDiv(rsiDiv.bearPivots, C.divBear, 'BEAR DIV');

  // ----- structure zig-zag -----
  const zz = (isPat ? [] : visSwings).map((s) => `${xC(s.i - off).toFixed(1)},${yOf(s.price).toFixed(1)}`);
  if (zz.length > 1) {
    over.push(`<polyline points="${zz.join(' ')}" fill="none" stroke="#cfd6e4" stroke-width="1.6" stroke-opacity="0.45" stroke-dasharray="7 5" stroke-linejoin="round"/>`);
  }

  // ----- candles -----
  vis.forEach((c, i) => {
    const up = c.close >= c.open;
    const col = up ? C.up : C.down;
    const x = xC(i);
    const yO = yOf(c.open);
    const yC = yOf(c.close);
    candlesSvg.push(L(x, yOf(c.high), x, yOf(c.low), { stroke: col, w: 1.8 }));
    candlesSvg.push(R(x - bodyW / 2, Math.min(yO, yC), bodyW, Math.max(1.6, Math.abs(yC - yO)), { fill: col }));
  });

  // OB candle outline
  if (obIdx != null && obIdx >= -0.25 && obIdx < VIS) {
    const i = Math.round(obIdx);
    const c = vis[i];
    if (c) {
      over.push(R(xC(i) - step * 0.5, yOf(c.high) - 4, step, yOf(c.low) - yOf(c.high) + 8, { stroke: '#ffffff', sw: 1.8, so: 0.9, dash: '4 3' }));
    }
  }

  // swing labels
  for (const s of isPat ? [] : visSwings) {
    const x = xC(s.i - off);
    const col = s.lab === 'HH' || s.lab === 'HL' ? C.up : s.lab === 'LH' || s.lab === 'LL' ? C.down : C.muted;
    const y = s.type === 'H' ? yOf(s.price) - 11 : yOf(s.price) + 24;
    over.push(T(x, y, s.lab, { size: 15, bold: true, fill: col, anchor: 'middle' }));
  }

  // sweep marker
  let sweepText = 'none';
  const sd = liq.sweepDetail;
  if (sd && (liq.bullishSweep || liq.bearishSweep)) {
    const bull = !!liq.bullishSweep;
    const tipPrice = num(bull ? sd.sweepLow : sd.sweepHigh);
    let si = -1;
    if (tipPrice != null) {
      for (let i = VIS - 1; i >= 0; i--) {
        const v = bull ? vis[i].low : vis[i].high;
        if (Math.abs(v - tipPrice) / tipPrice < 1e-6) {
          si = i;
          break;
        }
      }
    }
    sweepText = `${bull ? '▲ sell-side swept' : '▼ buy-side swept'}`;
    if (si >= 0) {
      const x = xC(si);
      const y = yOf(bull ? vis[si].low : vis[si].high);
      over.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="none" stroke="${gold}" stroke-width="2.6"/>`);
      const ly = bull ? y + 38 : y - 38;
      over.push(pill(Math.min(futureX0 - 60, Math.max(plotX0 + 50, x - 34)), ly, `SWEEP ${bull ? '▲' : '▼'}`, { size: 15, fg: C.dark, bg: gold, bgOpacity: 1 }));
    }
  }

  // ----- trade levels -----
  const pctFromEntry = (p) => (entry ? (((p - entry) / entry) * 100) * (isShort ? -1 : 1) : null);
  const levels = [
    { id: 'tp3', p: tp3, color: C.tp3, name: 'TP3', dash: '9 6', w: 1.8, fg: C.dark },
    { id: 'tp2', p: tp2, color: C.tp2, name: 'TP2', dash: '9 6', w: 1.8, fg: C.dark },
    { id: 'tp1', p: tp1, color: C.tp1, name: 'TP1', dash: '9 6', w: 2, fg: C.dark },
    { id: 'entry', p: entry, color: C.entry, name: 'ENTRY', w: 3, fg: '#fff' },
    { id: 'sl', p: sl, color: C.down, name: 'SL', w: 3, fg: '#fff' },
  ].filter((l) => l.p != null);

  const tagItems = [];
  const futItems = [];
  for (const l of levels) {
    const inR = inRange(l.p);
    const y = inR ? yOf(l.p) : l.p > yMax ? mainTop + 14 : mainBot - 14;
    const arr = inR ? '' : l.p > yMax ? '▲ ' : '▼ ';
    if (inR) over.push(L(plotX0, y, plotX1, y, { stroke: l.color, w: l.w, dash: l.dash }));
    const pc = l.id === 'entry' ? null : pctFromEntry(l.p);
    const pcs = pc == null ? '' : ` ${pc >= 0 ? '+' : ''}${pc.toFixed(1)}%`;
    futItems.push({ y, y0: y, text: `${arr}${l.name}${pcs}`, bg: l.color, fg: l.fg });
    tagItems.push({ y, y0: y, text: `${arr}${fp(l.p)}`, bg: l.color, fg: l.fg });
  }
  // current price
  const yNow = yOf(cur);
  over.push(L(plotX0, yNow, plotX1, yNow, { stroke: '#ffffff', w: 1.5, dash: '2 4', opacity: 0.85 }));
  over.push(`<circle cx="${xC(VIS - 1).toFixed(1)}" cy="${yNow.toFixed(1)}" r="5" fill="#fff"/>`);
  tagItems.push({ y: yNow, y0: yNow, text: fp(cur), bg: '#ffffff', fg: C.dark });
  futItems.push({ y: yNow, y0: yNow, text: 'NOW', bg: '#ffffff', fg: C.dark });
  // BSL / SSL tags on the axis
  for (const [p, name] of [[bsl, 'BSL'], [ssl, 'SSL']]) {
    if (p != null && inRange(p)) tagItems.push({ y: yOf(p), y0: yOf(p), text: fp(p), bg: gold, fg: C.dark, small: true });
  }

  const tagsSpread = spread(tagItems, 29, mainTop + 14, mainBot - 14);
  const futSpread = spread(futItems, 27, mainTop + 14, mainBot - 14);
  const tagY = tagsSpread.map((t) => t.y);

  // axis ticks (skip near tags)
  for (const t of tickYs) {
    if (tagY.some((y) => Math.abs(y - t.y) < 20)) continue;
    axis.push(T(plotX1 + 10, t.y + 6, t.v.toFixed(dp), { size: 17, fill: C.muted }));
  }
  const tagW = W - plotX1 - 8;
  const longest = Math.max(...tagsSpread.map((t) => tw(t.text, 17, true)), 0);
  const tagFont = longest + 12 > tagW ? Math.floor((17 * (tagW - 12)) / longest) : 17;
  for (const t of tagsSpread) {
    if (Math.abs(t.y - t.y0) > 1) axis.push(L(plotX1, t.y0, plotX1 + 4, t.y, { stroke: t.bg, w: 1.4 }));
    axis.push(R(plotX1 + 4, t.y - 13, tagW, 26, { rx: 3, fill: t.bg }));
    axis.push(T(plotX1 + 9, t.y + tagFont * 0.36, t.text, { size: tagFont, bold: true, fill: t.fg }));
  }
  const futLabels = futSpread.map((t) => pill(futureX0 + 8, t.y, t.text, { size: 17, fg: t.fg, bg: t.bg, bgOpacity: 1 })).join('');

  // left labels (liquidity / P-D)
  const leftSpread = spread(leftLabels, 24, mainTop + 14, mainBot - 14);
  const leftSvg = leftSpread
    .map((l) =>
      l.bg
        ? pill(plotX0 + 6, l.y, l.text, { size: 15, fg: l.fg, bg: l.bg, bgOpacity: 0.95 })
        : pill(plotX0 + 6, l.y, l.text, { size: 14, fg: l.fg, bg: C.dark, bgOpacity: l.dim ? 0.55 : 0.8, stroke: l.stroke || undefined, bold: !l.dim })
    )
    .join('');

  for (const pl of patLabels) zoneLabels.push(pl);
  // OB / FVG labels: spread only when they overlap horizontally
  for (const z of zoneLabels) {
    z.w = tw(z.text, z.size, true) + 14;
    z.x = Math.max(plotX0 + 4, Math.min(z.x, futureX0 - z.w - 6)); // keep clear of the trade labels
  }
  zoneLabels.sort((a, b) => a.y - b.y);
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < zoneLabels.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = zoneLabels[i];
        const b = zoneLabels[j];
        const overlapX = a.x < b.x + b.w && a.x + a.w > b.x;
        if (overlapX && Math.abs(a.y - b.y) < 24) a.y = b.y + 24;
      }
    }
  }
  const zoneSvg = zoneLabels
    .map((z) => pill(z.x, Math.min(mainBot - 14, Math.max(mainTop + 14, z.y)), z.text, { size: z.size, fg: z.fg, bg: z.bg, bgOpacity: 0.95 }))
    .join('');

  // HTF badge (goes in the header, third row)
  const htfBadge = pill(
    M.l,
    134,
    `HTF ${htf.toUpperCase()}: ${(structure.bias || 'neutral').toUpperCase()} · BOS ${arrow(structure.bos)} · CHOCH ${arrow(structure.choch)}`,
    { size: 17, fg: biasColor(structure.bias), bg: C.dark, bgOpacity: 1, stroke: biasColor(structure.bias), padY: 10 }
  );

  /* ---------- volume panel ---------- */
  const vols = all.map((c) => c.volume);
  const volSma = vols.map((_, i) => (i < 19 ? null : vols.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20));
  const vMax = Math.max(...vis.map((c) => c.volume), ...volSma.slice(off).filter((v) => v != null), 1);
  const vy = (v) => volBot - (v / vMax) * (volH - 8);
  const volSvg = [R(plotX0, volTop, plotW, volH, { fill: C.panel })];
  vis.forEach((c, i) => {
    const sma = volSma[off + i];
    const big = sma != null && c.volume > sma * 1.5;
    volSvg.push(R(xC(i) - bodyW / 2, vy(c.volume), bodyW, volBot - vy(c.volume), { fill: c.close >= c.open ? C.up : C.down, fo: big ? 0.95 : 0.55 }));
  });
  const smaPts = [];
  for (let i = 0; i < VIS; i++) {
    const v = volSma[off + i];
    if (v != null) smaPts.push(`${xC(i).toFixed(1)},${vy(v).toFixed(1)}`);
  }
  if (smaPts.length > 1) volSvg.push(`<polyline points="${smaPts.join(' ')}" fill="none" stroke="${C.ema}" stroke-width="1.8"/>`);
  volSvg.push(T(plotX0 + 8, volTop + 22, 'VOLUME', { size: 15, bold: true, fill: C.muted }));
  volSvg.push(T(plotX1 - 8, volTop + 22, `RVOL ${rvol != null ? rvol.toFixed(2) : '—'}× · orange = 20-bar avg`, { size: 15, fill: C.muted, anchor: 'end' }));

  /* ---------- header ---------- */
  const head = [];
  head.push(R(0, 0, W, 154, { fill: '#0e1217' }));
  const sym = String(signal.symbol || '');
  head.push(T(M.l, 50, sym, { size: 38, bold: true }));
  let hx = M.l + tw(sym, 38, true) + 16;
  head.push(pill(hx, 37, dirRaw || '—', { size: 22, fg: '#fff', bg: dirColor, bgOpacity: 1, padX: 12, padY: 12 }));
  hx += tw(dirRaw || '—', 22, true) + 24 + 12;
  if (score != null) head.push(pill(hx, 37, `SCORE ${score}`, { size: 22, fg: C.dark, bg: C.gold, bgOpacity: 1, padX: 12, padY: 12 }));
  head.push(T(W - M.l, 48, `${tf.toUpperCase()}`, { size: 26, bold: true, fill: C.muted, anchor: 'end' }));
  const dPct = num(signal.distance_percent);
  const dAtr = num(signal.atr_distance);
  const rr = signal.rr != null && signal.rr !== '—' ? `R:R 1:${signal.rr}` : null;
  const line2 = [
    `Now ${fp(cur)}`,
    entry != null ? `Entry ${fp(entry)}${dPct != null || dAtr != null ? ` (${dPct != null ? dPct.toFixed(2) + '%' : ''}${dPct != null && dAtr != null ? ' · ' : ''}${dAtr != null ? dAtr.toFixed(2) + ' ATR' : ''} away)` : ''}` : null,
    rr,
    signal.status ? String(signal.status) : null,
  ].filter(Boolean).join('   ·   ');
  head.push(T(M.l, 90, line2, { size: 19, fill: '#b7bdc6' }));
  head.push(L(0, 154, W, 154, { stroke: '#1e2530', w: 1.5 }));

  /* ---------- legend ---------- */
  const legendY0 = volBot + 34;
  const legendItems = isEmaBump
    ? [
        [`EMA${EB.fast || 20}`, '#ff4d4f', 'line'], [`EMA${EB.slow || 50}`, '#ffa940', 'line'], ['Top / Entry', C.entry, 'dash'],
        ['SL', C.down, 'line'], ['TP', C.tp1, 'dash'],
      ]
    : isPat
    ? [
        ['Pattern', C.gold, 'box'], ['Trendline', C.gold, 'dash'], ['Breakout', dirColor, 'line'], ['OB', C.up, 'box'], ['FVG', C.purple, 'box'], ['Fib', '#5ac8fa', 'dash'],
        ['Rejection zone', '#ff9f1a', 'box'], ['Liquidity', C.gold, 'dash'], ['EQ', C.muted, 'dash'], ['Elliott', C.purple, 'line'],
        ['EMA21', C.ema21, 'line'], ['EMA50', C.ema50, 'dash'],
        ...(rsiDiv.bullish ? [['Bull DIV', C.divBull, 'dash']] : []),
        ...(rsiDiv.bearish ? [['Bear DIV', C.divBear, 'dash']] : []),
        ['Entry', C.entry, 'line'], ['SL', C.down, 'line'], ['TP', C.tp1, 'dash'],
      ]
    : [
    ['OB zone', obColor, 'box'], ['FVG', C.purple, 'box'], ['Liquidity', gold, 'dash'],
    ...(isPat && (G.elliott?.pivots?.length || meta.universal?.elliott) ? [['Elliott', C.purple, 'line']] : []),
    ...(isDoubleConfluence ? [['PRZ', C.purple, 'box'], ['Structure', C.gold, 'line'], ['Double', dirColor, 'line'], ['S/R Zone', gold, 'dash']] : []),
    ['Prem/Disc', C.muted, 'dot'], ['EMA21', C.ema21, 'line'], ['EMA50', C.ema50, 'dash'], ['Structure', '#cfd6e4', 'dash'],
    ...(rsiDiv.bullish ? [['Bull DIV', C.divBull, 'dash']] : []),
    ...(rsiDiv.bearish ? [['Bear DIV', C.divBear, 'dash']] : []),
    ['Entry', C.entry, 'line'], ['SL', C.down, 'line'], ['TP', C.tp1, 'dash'],
  ];
  let lx = M.l;
  let legendRows = 0;
  const legend = [];
  for (const [name, col, kind] of legendItems) {
    const need = (kind === 'box' ? 16 : 20) + 7 + tw(name, 16) + 22;
    if (lx + need > W - M.l) {
      lx = M.l;
      legendRows++;
    }
    const legendY = legendY0 + legendRows * 28;
    if (kind === 'box') legend.push(R(lx, legendY - 11, 16, 16, { fill: col, fo: 0.35, stroke: col, sw: 1.5 }));
    else legend.push(L(lx, legendY - 3, lx + 20, legendY - 3, { stroke: col, w: 3, dash: kind === 'dash' ? '6 4' : kind === 'dot' ? '2 4' : undefined }));
    const wBox = kind === 'box' ? 16 : 20;
    legend.push(T(lx + wBox + 7, legendY + 3, name, { size: 16, fill: C.muted }));
    lx += wBox + 7 + tw(name, 16) + 22;
  }

  /* ---------- analysis panel ---------- */
  let y = legendY0 + legendRows * 28 + 46;
  const body = [];
  body.push(L(M.l, y - 12, W - M.l, y - 12, { stroke: '#1e2530', w: 1.5 }));
  body.push(T(M.l, y + 12, 'ANALYSIS', { size: 17, bold: true, fill: C.gold }));
  y += 34;

  const round = (v, d = 0) => (v == null ? '—' : Number(v).toFixed(d));
  const ovFvg = fvgRows.find((r) => r.ov);
  const fvgSummary = ovFvg
    ? `${ovFvg.f.type === 'bearish' ? '▼' : '▲'} ${ovFvg.f.status || 'OPEN'}  ${fp(ovFvg.f.low)} – ${fp(ovFvg.f.high)}  (overlaps OB)`
    : fvgRows.length
      ? `${fvgRows.length} open, none overlaps OB`
      : 'none open';
  const risk = entry != null && sl != null ? (Math.abs(entry - sl) / entry) * 100 : null;
  const pf = (v) => (v == null ? '—' : Number(v).toFixed(2));
  const clip = (t, n = 68) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const patRows = isPat
    ? [
        ['Pattern', `${String(G.type || '').replace(/_/g, ' ')} · ${dirRaw || '—'} · ${G.touches ?? '—'} touches${G.fit != null ? ` · fit ${Math.round(G.fit * 100)}%` : ''}`, dirColor],
        ['Breakout', `${G.pending ? 'waiting for close beyond' : 'close beyond'} ${fp(G.level)}${G.breakoutDistAtr != null ? ` · +${pf(G.breakoutDistAtr)} ATR` : ''}${G.bodyRatio != null ? ` · body ${Math.round(G.bodyRatio * 100)}%` : ''}`, dirColor],
        ['Range', `${fp(G.bottom)} – ${fp(G.top)}${G.height != null ? ` · height ${fp(G.height)}` : ''}`, C.text],
        ['Target', `TP2 ${fp(G.tp2)} = 1x pattern height · TP3 ${fp(G.tp3)} = 1.618x`, C.up],
        ['SMC', clip((G.smc?.notes || []).join(' · ') || 'no SMC confluence'), C.purple],
        ['Fib', clip((G.fib?.notes || []).join(' · ') || 'no fib confluence'), '#5ac8fa'],
        ...((G.smc?.blocked || []).length ? [['Warning', clip((G.smc.blocked || []).join(' · ')), C.down]] : []),
        ['HTF ' + htf.toUpperCase(), `${(structure.bias || 'neutral').toUpperCase()} · BOS ${arrow(structure.bos)} · CHOCH ${arrow(structure.choch)}`, biasColor(structure.bias)],
        ['Momentum', `Breakout RVOL ${rvol != null ? rvol.toFixed(2) : '—'}× · RSI ${round(rsi)} · ${ema21 != null && ema50 != null ? (ema21 >= ema50 && cur >= ema21 ? 'EMA bull' : ema21 <= ema50 && cur <= ema21 ? 'EMA bear' : 'EMA mixed') : '—'} · ${rsiDiv.type ? rsiDiv.type + ' DIV' : 'no DIV'}`, C.text],
      ]
    : null;
  const ictRows = !isPat && ict
    ? [
        ['ICT sequence', 'Liquidity sweep → BOS close → fresh POI', dirColor],
        ['Sweep', `${ict.sweepSide || '—'} @ ${fp(num(ict.sweepLevel))} · ${sweepText}`, gold],
        ['BOS', `Close beyond ${fp(num(ict.bosLevel))} · age ${ict.ageBars ?? '—'} bars`, dirColor],
        ['Point of interest', `${String(ict.poiType || '—').replace(/_/g, ' ')} · ${fp(num(ict.poiLow))} – ${fp(num(ict.poiHigh))}`, obColor],
        ['HTF ' + String(ict.htfTf || htf).toUpperCase(), `${String(ict.htfBias || 'neutral').toUpperCase()} · ${ict.htfAligned ? 'aligned' : 'not aligned'}`, biasColor(ict.htfBias)],
        ['FVG', fvgSummary, C.purple],
        ['Momentum', `RVOL ${rvol != null ? rvol.toFixed(2) : '—'}× · RSI ${round(rsi)} · ${ema21 != null && ema50 != null ? (ema21 >= ema50 && cur >= ema21 ? 'EMA bull' : ema21 <= ema50 && cur <= ema21 ? 'EMA bear' : 'EMA mixed') : '—'} · ${rsiDiv.type ? rsiDiv.type + ' DIV' : 'no DIV'}`, C.text],
      ]
    : null;
  const dhRows = isDoubleConfluence
    ? [
        ['Strategy', 'Double Top/Bottom Reversal', dirColor],
        ['Double', `${(dhDouble?.type || meta.doublePattern?.type || '—').toString().replace(/_/g, ' ')} · q ${meta.doublePattern?.quality ?? '—'}`, dirColor],
        ['Harmonic', `${isShort ? 'Bearish' : 'Bullish'} ${dhHarm?.type || meta.harmonic?.type || '—'} · conf ${meta.harmonic?.confidence ?? '—'}`, C.gold],
        ['PRZ', `${fp(num(dhHarm?.przLow ?? meta.harmonic?.przLow))} – ${fp(num(dhHarm?.przHigh ?? meta.harmonic?.przHigh))}`, C.purple],
        ['Zone', `${dhZone?.type || meta.zone?.type || '—'} · ${fp(num(dhZone?.low ?? meta.zone?.low))} – ${fp(num(dhZone?.high ?? meta.zone?.high))}`, gold],
        ['Overlap', `score ${meta.overlap?.score ?? '—'} · ${meta.overlap?.distanceAtr != null ? meta.overlap.distanceAtr + ' ATR' : '—'}`, C.text],
        ['Sweep / Rej', `${meta.liquiditySweep?.confirmed ? 'SWEEP' : '—'} · ${meta.confirmation?.confirmed ? (meta.confirmation.type || 'YES') : 'pending'}`, gold],
        ['Quality', `${meta.quality || '—'} · score ${score ?? '—'} · HTF ${meta.htfBias || '—'}`, dirColor],
      ]
    : null;
  const rows = patRows || ictRows || dhRows || [
    ['HTF ' + htf.toUpperCase(), `${(structure.bias || 'neutral').toUpperCase()} · BOS ${arrow(structure.bos)} · CHOCH ${arrow(structure.choch)}`, biasColor(structure.bias)],
    [`OB ${tf.toUpperCase()}`, `${obType === 'bearish' ? 'BEAR' : 'BULL'} · ${ob.status || '—'} · str ${round(ob.strength)} · tests ${ob.tests ?? '—'}`, obColor],
    ['OB zone', `${fp(obLow)} – ${fp(obHigh)}`, C.text],
    ['FVG', fvgSummary, C.purple],
    ['Liquidity', `BSL ${fp(bsl)} · SSL ${fp(ssl)}`, gold],
    ['Sweep / EQ', `${sweepText} · EQH ${(liq.equalHighs || []).length} · EQL ${(liq.equalLows || []).length}`, gold],
    ['Prem / Disc', `${pd.zone || '—'}${pd.pos != null ? ` · ${Math.round(pd.pos * 100)}% of range` : ''}`, pd.zone === 'DISCOUNT' ? C.up : pd.zone === 'PREMIUM' ? C.down : C.muted],
    ['Momentum', `RVOL ${rvol != null ? rvol.toFixed(2) : '—'}× · RSI ${round(rsi)} · ${ema21 != null && ema50 != null ? (ema21 >= ema50 && cur >= ema21 ? 'EMA bull' : ema21 <= ema50 && cur <= ema21 ? 'EMA bear' : 'EMA mixed') : '—'} · ${rsiDiv.type ? rsiDiv.type + ' DIV' : 'no DIV'}`, C.text],
  ];
  rows.forEach((r, i) => {
    const cy = y + i * 36;
    body.push(T(M.l, cy, r[0], { size: 18, bold: true, fill: C.muted }));
    body.push(T(M.l + 140, cy, r[1], { size: 18, fill: r[2] }));
  });
  y += rows.length * 36;
  // trade row (full width)
  const tradeTxt = [
    risk != null ? `Risk ${risk.toFixed(2)}%` : null,
    tp1 != null ? `TP1 +${pctFromEntry(tp1)?.toFixed(1)}%` : null,
    tp2 != null ? `TP2 +${pctFromEntry(tp2)?.toFixed(1)}%` : null,
    tp3 != null ? `TP3 +${pctFromEntry(tp3)?.toFixed(1)}%` : null,
    ob.displacement > 0 ? 'Displacement yes' : null,
    ob.volumeExp ? 'Vol expansion yes' : null,
  ].filter(Boolean).join('  ·  ');
  body.push(T(M.l, y, 'Trade', { size: 18, bold: true, fill: C.muted }));
  body.push(T(M.l + 140, y, tradeTxt, { size: 18 }));
  y += 44;

  // confluence chips
  if (conf.length) {
    body.push(T(M.l, y, 'CONFLUENCE', { size: 17, bold: true, fill: C.gold }));
    y += 26;
    let cx = M.l;
    for (const cf of conf.slice(0, 14)) {
      const label = String(cf).replace(/\u26a0\ufe0f?\s*/g, '! ');
      const w = tw(label, 16, true) + 22;
      if (cx + w > W - M.l) {
        cx = M.l;
        y += 38;
      }
      body.push(R(cx, y - 19, w, 30, { rx: 15, fill: dirColor, fo: 0.16, stroke: dirColor, sw: 1.2, so: 0.7 }));
      body.push(T(cx + 11, y + 2, label, { size: 16, bold: true, fill: C.text }));
      cx += w + 10;
    }
    y += 38;
  }

  // GATES panel: every admin gate, HARD/SOFT mode and whether this setup passed it
  const gateList = isPat ? G.gates : isEmaBump ? meta.gates : null;
  if (Array.isArray(gateList) && gateList.length) {
    body.push(T(M.l, y, 'GATES', { size: 17, bold: true, fill: C.gold }));
    body.push(T(M.l + 80, y, 'HARD = must pass (setup rejected otherwise) · SOFT = only costs score', { size: 14, fill: C.muted }));
    y += 26;
    let gx = M.l;
    const gOrder = [...gateList].sort((a, b) => (a.mode === 'hard' ? 0 : 1) - (b.mode === 'hard' ? 0 : 1));
    for (const g of gOrder) {
      const st = g.pass === true ? 'PASS' : g.pass === false ? 'FAIL' : 'n/a';
      const col = g.pass === true ? C.up : g.pass === false ? (g.mode === 'hard' ? C.down : C.gold) : C.muted;
      const label = `${st} ${g.label} [${g.mode.toUpperCase()}]`;
      const w = tw(label, 15, true) + 20;
      if (gx + w > W - M.l) {
        gx = M.l;
        y += 36;
      }
      body.push(R(gx, y - 19, w, 29, { rx: 14, fill: col, fo: g.mode === 'hard' ? 0.22 : 0.1, stroke: col, sw: g.mode === 'hard' ? 1.8 : 1, so: 0.85 }));
      body.push(T(gx + 10, y + 1, label, { size: 15, bold: true, fill: C.text }));
      gx += w + 8;
    }
    y += 40;
  }

  body.push(T(M.l, y + 16, `Generated ${nowLK()} LK · closed ${tf.toUpperCase()} candles · time axis = Sri Lanka time`, { size: 15, fill: '#5d6673' }));
  const H = Math.ceil(y + 40);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    defs +
    R(0, 0, W, H, { fill: C.bg }) +
    head.join('') +
    htfBadge +
    `<g clip-path="url(#mainClip)">${under.join('')}${candlesSvg.join('')}${over.join('')}${zoneSvg}${futLabels}${leftSvg}</g>` +
    axis.join('') +
    volSvg.join('') +
    legend.join('') +
    body.join('') +
    `</svg>`;

  return { svg, width: W, height: H };
}
