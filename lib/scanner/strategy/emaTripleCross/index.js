/**
 * EMA 20 / 50 / 200 "triple cross" scanner + backtest (history only — creates no live signals).
 *
 * A triple cross = the three EMA pairs (20/50, 20/200, 50/200) all cross in the SAME direction
 * inside a small window of bars (default 5). All pairs crossing DOWN  → 'DOWN' event
 * (fast EMA fell under the slower ones); all crossing UP → 'UP' event.
 *
 * mode 'fast' (default) → EMA20 crossed BOTH EMA50 and EMA200 in the window (the 50/200 pair is not
 *                          required — this is the "one candle run slices through everything" case)
 * mode 'all3'            → all three pairs (20/50, 20/200, 50/200) crossed in the window
 * mode 'any2'            → any two of the three pairs crossed in the window
 *
 * Optional AB=CD filter (requireAbcd): keep only events where a completed AB=CD harmonic exists
 * and the EMA cross bar falls inside the AB or CD leg (or within a few bars of D completion).
 *
 * The event is stamped on the bar where the requirement is first satisfied (a closed candle),
 * so a real-time scanner would have known about it at that bar's close.
 * Forward stats (return after N bars, max favourable / adverse move) show what price did next.
 */
import { calcEMASeries, findSwings } from '../../indicators.js';

export const TRIPLE_TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];

export const TRIPLE_DEFAULTS = {
  fast: 20,
  mid: 50,
  slow: 200,
  windowBars: 5,
  mode: 'fast', // 'fast' | 'all3' | 'any2'
  direction: 'BOTH', // 'BOTH' | 'UP' | 'DOWN'
  forwardBars: 20,
  requireAbcd: false,
  // AB=CD / alternate measured-move tolerances
  abcdBcMin: 0.35,
  abcdBcMax: 0.92,
  // Kept for backward compat; multi-variant matching uses ABCD_VARIANTS below
  abcdCdAbMin: 0.88,
  abcdCdAbMax: 1.20,
  abcdLookbackSwings: 24,
  abcdPadBars: 3, // cross may sit a few bars past D
};

/**
 * Classic + alternate AB=CD measured moves (CD length vs AB).
 * Windows are inclusive tolerances around common Fibonacci extensions.
 */
export const ABCD_VARIANTS = [
  { key: 'AB=CD', label: 'AB=CD', target: 1.0, min: 0.88, max: 1.15 },
  { key: '1.272AB=CD', label: '1.272 AB=CD', target: 1.272, min: 1.18, max: 1.38 },
  { key: '1.414AB=CD', label: '1.414 AB=CD', target: 1.414, min: 1.32, max: 1.52 },
  { key: '1.618AB=CD', label: '1.618 AB=CD', target: 1.618, min: 1.50, max: 1.75 },
  { key: '0.786AB=CD', label: '0.786 AB=CD', target: 0.786, min: 0.70, max: 0.88 },
  { key: '0.618AB=CD', label: '0.618 AB=CD', target: 0.618, min: 0.55, max: 0.70 },
];

export function normalizeTripleConfig(raw = {}) {
  const int = (v, d, lo, hi) => {
    const n = Math.round(+v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const dir = String(raw.direction || 'BOTH').toUpperCase();
  const bool = (v, d) => (v === true || v === false ? v : v === 'true' || v === 1 || v === '1' ? true : v === 'false' || v === 0 || v === '0' ? false : d);
  return {
    fast: TRIPLE_DEFAULTS.fast,
    mid: TRIPLE_DEFAULTS.mid,
    slow: TRIPLE_DEFAULTS.slow,
    windowBars: int(raw.windowBars, TRIPLE_DEFAULTS.windowBars, 1, 30),
    mode: ['fast', 'all3', 'any2'].includes(raw.mode) ? raw.mode : TRIPLE_DEFAULTS.mode,
    direction: ['UP', 'DOWN'].includes(dir) ? dir : 'BOTH',
    forwardBars: int(raw.forwardBars, TRIPLE_DEFAULTS.forwardBars, 3, 100),
    requireAbcd: bool(raw.requireAbcd, TRIPLE_DEFAULTS.requireAbcd),
    abcdBcMin: TRIPLE_DEFAULTS.abcdBcMin,
    abcdBcMax: TRIPLE_DEFAULTS.abcdBcMax,
    abcdCdAbMin: TRIPLE_DEFAULTS.abcdCdAbMin,
    abcdCdAbMax: TRIPLE_DEFAULTS.abcdCdAbMax,
    abcdLookbackSwings: int(raw.abcdLookbackSwings, TRIPLE_DEFAULTS.abcdLookbackSwings, 8, 40),
    abcdPadBars: int(raw.abcdPadBars, TRIPLE_DEFAULTS.abcdPadBars, 0, 12),
  };
}

/** Cross list for a (faster a, slower b) pair: dir +1 = a crossed above b, -1 = below. */
function pairCrosses(a, b) {
  const out = [];
  let prevSign = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] == null || b[i] == null) continue;
    const d = a[i] - b[i];
    const s = d > 0 ? 1 : d < 0 ? -1 : prevSign; // exact tie keeps previous side
    if (prevSign !== 0 && s !== 0 && s !== prevSign) out.push({ i, dir: s });
    if (s !== 0) prevSign = s;
  }
  return out;
}

const ratioAbs = (a, b) => (Math.abs(b) > 1e-12 ? Math.abs(a) / Math.abs(b) : 0);

function matchAbcdVariant(cdAb) {
  let best = null;
  let bestDist = Infinity;
  for (const v of ABCD_VARIANTS) {
    if (cdAb < v.min || cdAb > v.max) continue;
    const dist = Math.abs(cdAb - v.target);
    if (dist < bestDist) {
      bestDist = dist;
      best = v;
    }
  }
  return best;
}

/**
 * Find completed AB=CD (and alternate measured-move) patterns whose D is near bar `crossIndex`.
 *
 * Supports classic AB=CD plus common extensions:
 *   0.618, 0.786, 1.0, 1.272, 1.414, 1.618 × AB = CD
 *
 * Geometry: alternating swings A-B-C-D, BC retraces 0.35–0.92 of AB,
 * CD and AB same direction. Cross bar must sit in AB leg, CD leg, or within abcdPadBars of D.
 * Returns the best-fit pattern (closest to a variant target).
 */
export function findAbcdForCross(candles, crossIndex, cfg = TRIPLE_DEFAULTS) {
  if (!candles || candles.length < 30 || crossIndex < 10) return null;
  const swings = findSwings(candles, 3, 3);
  if (swings.length < 4) return null;

  // Only swings at or before the cross (pattern must be visible at event time)
  const eligible = swings.filter((s) => s.i <= crossIndex + cfg.abcdPadBars);
  const recent = eligible.slice(-cfg.abcdLookbackSwings);
  if (recent.length < 4) return null;

  let best = null;
  let bestScore = -Infinity;

  for (let i = 0; i + 3 < recent.length; i++) {
    const A = recent[i];
    const B = recent[i + 1];
    const C = recent[i + 2];
    const D = recent[i + 3];
    // Alternating pivot types
    if (A.type === B.type || B.type === C.type || C.type === D.type) continue;
    // D should finish near the cross
    if (D.i < crossIndex - 40 || D.i > crossIndex + cfg.abcdPadBars) continue;

    const ab = B.price - A.price;
    const bc = C.price - B.price;
    const cd = D.price - C.price;
    // AB and CD same direction; BC opposite
    if (ab === 0 || cd === 0) continue;
    if (Math.sign(ab) !== Math.sign(cd)) continue;
    if (Math.sign(bc) === Math.sign(ab)) continue;

    const bcR = ratioAbs(bc, ab);
    const cdAb = ratioAbs(cd, ab);
    if (bcR < cfg.abcdBcMin || bcR > cfg.abcdBcMax) continue;

    const variant = matchAbcdVariant(cdAb);
    if (!variant) continue;

    // Cross bar must sit inside AB leg, CD leg, or a few bars past D
    const inAb = crossIndex >= A.i && crossIndex <= B.i;
    const inCd = crossIndex >= C.i && crossIndex <= D.i;
    const nearD = crossIndex >= D.i && crossIndex <= D.i + cfg.abcdPadBars;
    if (!inAb && !inCd && !nearD) continue;

    // Direction of completion: bullish ends at a low (D is L) → UP bias; bearish at high → DOWN
    const abcdDir = D.type === 'L' ? 'UP' : 'DOWN';
    const fit = 1 - Math.abs(cdAb - variant.target) / Math.max(variant.target, 0.5);
    const recency = 1 / (1 + Math.abs(crossIndex - D.i));
    // Prefer classic AB=CD slightly when fit is equal
    const classicBonus = variant.target === 1.0 ? 0.4 : 0;
    const score = fit * 10 + recency * 2 + (inCd || nearD ? 1 : 0) + classicBonus;
    if (score > bestScore) {
      bestScore = score;
      best = {
        family: variant.key,
        label: variant.label,
        target: variant.target,
        dir: abcdDir,
        A: { i: A.i, price: A.price, time: A.time, type: A.type },
        B: { i: B.i, price: B.price, time: B.time, type: B.type },
        C: { i: C.i, price: C.price, time: C.time, type: C.type },
        D: { i: D.i, price: D.price, time: D.time, type: D.type },
        ratios: { bc: +bcR.toFixed(3), cdAb: +cdAb.toFixed(3), target: variant.target },
        crossIn: inAb ? 'AB' : inCd ? 'CD' : 'nearD',
        score: +score.toFixed(2),
      };
    }
  }
  return best;
}

export function computeEmas(candles, cfg = TRIPLE_DEFAULTS) {
  return {
    e20: calcEMASeries(candles, cfg.fast),
    e50: calcEMASeries(candles, cfg.mid),
    e200: calcEMASeries(candles, cfg.slow),
  };
}

function forwardStats(candles, i, sign, entry, n) {
  const last = candles.length - 1;
  const end = Math.min(last, i + n);
  let mfe = 0;
  let mae = 0;
  for (let k = i + 1; k <= end; k++) {
    const fav = sign > 0 ? candles[k].high / entry - 1 : 1 - candles[k].low / entry;
    const adv = sign > 0 ? 1 - candles[k].low / entry : candles[k].high / entry - 1;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
  }
  const complete = i + n <= last;
  const retPct = complete ? sign * (candles[i + n].close / entry - 1) * 100 : null;
  return {
    barsAvailable: end - i,
    retPct: retPct == null ? null : +retPct.toFixed(3),
    mfePct: +(mfe * 100).toFixed(3),
    maePct: +(mae * 100).toFixed(3),
    outcome: !complete ? 'OPEN' : retPct > 0 ? 'WIN' : 'LOSS',
  };
}

/** Find every triple-cross event in a candle array (oldest → newest, closed candles). */
export function findTripleCrosses(candles, cfgIn = {}, emas = null) {
  const cfg = normalizeTripleConfig(cfgIn);
  if (!candles || candles.length < cfg.slow + 5) return [];
  const { e20, e50, e200 } = emas || computeEmas(candles, cfg);
  const pairs = [
    { name: '20/50', crosses: pairCrosses(e20, e50) },
    { name: '20/200', crosses: pairCrosses(e20, e200) },
    { name: '50/200', crosses: pairCrosses(e50, e200) },
  ];
  // per-bar lookup: crossAt[pairIdx] = Map(i → dir)
  const crossAt = pairs.map((p) => new Map(p.crosses.map((c) => [c.i, c.dir])));
  const events = [];
  const lastEvent = { 1: -Infinity, '-1': -Infinity };
  const W = cfg.windowBars;

  for (let i = cfg.slow; i < candles.length; i++) {
    // only evaluate on a bar where some pair just crossed (completion bar)
    const relevant = cfg.mode === 'fast' ? [0, 1] : [0, 1, 2];
    if (!relevant.some((p) => crossAt[p].has(i))) continue;
    for (const dir of [1, -1]) {
      if (cfg.direction === 'UP' && dir !== 1) continue;
      if (cfg.direction === 'DOWN' && dir !== -1) continue;
      if (!relevant.some((p) => crossAt[p].get(i) === dir)) continue;
      if (i - lastEvent[dir] < W) continue;
      const hit = [];
      for (const p of relevant) {
        for (let j = i; j > i - W; j--) {
          if (crossAt[p].get(j) === dir) {
            hit.push({ pair: pairs[p].name, index: j, time: candles[j].time });
            break;
          }
        }
      }
      const need = cfg.mode === 'any2' ? 2 : relevant.length;
      if (hit.length < need) continue;
      lastEvent[dir] = i;
      const entry = candles[i].close;
      const sign = dir; // +1 UP event, -1 DOWN event
      const first = Math.min(...hit.map((h) => h.index));

      // Optional AB=CD harmonic confluence
      const abcd = findAbcdForCross(candles, i, cfg);
      if (cfg.requireAbcd && !abcd) continue;

      events.push({
        index: i,
        time: candles[i].time,
        dir: dir === 1 ? 'UP' : 'DOWN',
        pairsCrossed: hit.length,
        crosses: hit,
        spanBars: i - first,
        price: entry,
        ema20: e20[i],
        ema50: e50[i],
        ema200: e200[i],
        abcd: abcd || null,
        ...forwardStats(candles, i, sign, entry, cfg.forwardBars),
      });
    }
  }
  return events;
}

export function backtestTripleCross(candles, cfgIn = {}) {
  const cfg = normalizeTripleConfig(cfgIn);
  return { events: findTripleCrosses(candles, cfg), cfg };
}

export function tallyTriple(list) {
  const t = { total: list.length, win: 0, loss: 0, open: 0, winRate: null, avgRetPct: null, avgMfePct: null, avgMaePct: null };
  let rs = 0;
  let rn = 0;
  let mf = 0;
  let ma = 0;
  for (const e of list) {
    if (e.outcome === 'WIN') t.win++;
    else if (e.outcome === 'LOSS') t.loss++;
    else t.open++;
    if (e.retPct != null) {
      rs += e.retPct;
      rn++;
      mf += e.mfePct;
      ma += e.maePct;
    }
  }
  const done = t.win + t.loss;
  if (done) t.winRate = +((t.win / done) * 100).toFixed(1);
  if (rn) {
    t.avgRetPct = +(rs / rn).toFixed(3);
    t.avgMfePct = +(mf / rn).toFixed(3);
    t.avgMaePct = +(ma / rn).toFixed(3);
  }
  return t;
}

// ───────────────────────────── chart (SVG) ─────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
function fmtTime(t, tzMin) {
  const d = new Date((t + tzMin * 60) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
function tzLabel(tzMin) {
  if (!tzMin) return 'UTC';
  const s = tzMin < 0 ? '-' : '+';
  const a = Math.abs(tzMin);
  return `UTC${s}${Math.floor(a / 60)}${a % 60 ? ':' + pad2(a % 60) : ''}`;
}
function fmtPrice(p) {
  const a = Math.abs(p);
  const dp = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : a >= 0.01 ? 5 : 6;
  return p.toFixed(dp);
}

/**
 * Candle chart with EMA 20 (red), EMA 50 (orange), EMA 200 (blue) and the event bar marked.
 * opts: { symbol, tf, before, after, tzMin, width, height }
 */
export function buildTripleChartSvg(candles, ev, emas, opts = {}) {
  const { symbol = '', tf = '', before = 80, after = 40, tzMin = 0, width = 900, height = 520 } = opts;
  const evIdx = ev.index;
  const from = Math.max(0, evIdx - before);
  const to = Math.min(candles.length - 1, evIdx + after);
  const vis = candles.slice(from, to + 1);
  if (vis.length < 10) return null;

  const L = 10;
  const R = 78;
  const T = 44;
  const B = 34;
  const pw = width - L - R;
  const ph = height - T - B;
  const step = pw / vis.length;
  const bw = Math.max(1, Math.min(10, step * 0.65));

  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < vis.length; k++) {
    lo = Math.min(lo, vis[k].low);
    hi = Math.max(hi, vis[k].high);
    for (const s of [emas.e20, emas.e50, emas.e200]) {
      const v = s[from + k];
      if (v != null) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  const padP = (hi - lo) * 0.06 || hi * 0.01;
  lo -= padP;
  hi += padP;
  const y = (p) => T + ph - ((p - lo) / (hi - lo)) * ph;
  const x = (k) => L + step * k + step / 2;

  const g = [];
  g.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial,Helvetica,sans-serif">`);
  g.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);

  // grid + price labels
  for (let n = 0; n <= 6; n++) {
    const p = lo + ((hi - lo) * n) / 6;
    const yy = y(p).toFixed(1);
    g.push(`<line x1="${L}" x2="${L + pw}" y1="${yy}" y2="${yy}" stroke="#eceff3"/>`);
    g.push(`<text x="${L + pw + 6}" y="${(+yy + 4).toFixed(1)}" font-size="11" fill="#555">${fmtPrice(p)}</text>`);
  }

  // time labels
  const labelEvery = Math.max(1, Math.round(vis.length / 6));
  for (let k = 0; k < vis.length; k += labelEvery) {
    g.push(`<text x="${x(k).toFixed(1)}" y="${height - 12}" font-size="10" fill="#666" text-anchor="middle">${fmtTime(vis[k].time, tzMin).slice(5)}</text>`);
  }

  // event bar highlight
  const ek = evIdx - from;
  const evColor = ev.dir === 'UP' ? '#0ecb81' : '#f6465d';
  g.push(`<rect x="${(x(ek) - step / 2).toFixed(1)}" y="${T}" width="${step.toFixed(1)}" height="${ph}" fill="${evColor}" opacity="0.14"/>`);
  g.push(`<line x1="${x(ek).toFixed(1)}" x2="${x(ek).toFixed(1)}" y1="${T}" y2="${T + ph}" stroke="${evColor}" stroke-dasharray="4 3"/>`);

  // candles
  for (let k = 0; k < vis.length; k++) {
    const c = vis[k];
    const col = c.close >= c.open ? '#089981' : '#f23645';
    const cx = x(k).toFixed(1);
    g.push(`<line x1="${cx}" x2="${cx}" y1="${y(c.high).toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${col}"/>`);
    const top = y(Math.max(c.open, c.close));
    const hgt = Math.max(1, Math.abs(y(c.open) - y(c.close)));
    g.push(`<rect x="${(x(k) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${col}"/>`);
  }

  // EMA lines
  const line = (series, color, w) => {
    const pts = [];
    for (let k = 0; k < vis.length; k++) {
      const v = series[from + k];
      if (v != null) pts.push(`${x(k).toFixed(1)},${y(v).toFixed(1)}`);
    }
    if (pts.length > 1) g.push(`<polyline fill="none" stroke="${color}" stroke-width="${w}" points="${pts.join(' ')}"/>`);
  };
  line(emas.e200, '#2962ff', 2);
  line(emas.e50, '#ff9800', 2);
  line(emas.e20, '#f23645', 1.4);

  // AB=CD harmonic overlay (when present on the event)
  if (ev.abcd && ev.abcd.A && ev.abcd.B && ev.abcd.C && ev.abcd.D) {
    const pts = [ev.abcd.A, ev.abcd.B, ev.abcd.C, ev.abcd.D];
    const labels = ['A', 'B', 'C', 'D'];
    const abcdColor = ev.abcd.dir === 'UP' ? '#0ecb81' : '#f6465d';
    // connecting lines
    for (let p = 0; p < 3; p++) {
      const a = pts[p];
      const b = pts[p + 1];
      if (a.i < from || b.i > to) continue;
      const ka = a.i - from;
      const kb = b.i - from;
      g.push(
        `<line x1="${x(ka).toFixed(1)}" y1="${y(a.price).toFixed(1)}" x2="${x(kb).toFixed(1)}" y2="${y(b.price).toFixed(1)}" stroke="${abcdColor}" stroke-width="1.6" stroke-dasharray="5 3" opacity="0.9"/>`
      );
    }
    // point markers + labels
    for (let p = 0; p < 4; p++) {
      const pt = pts[p];
      if (pt.i < from || pt.i > to) continue;
      const kx = x(pt.i - from);
      const ky = y(pt.price);
      g.push(`<circle cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="4.5" fill="${abcdColor}" stroke="#fff" stroke-width="1.2"/>`);
      g.push(`<text x="${kx.toFixed(1)}" y="${(ky - 9).toFixed(1)}" font-size="11" font-weight="700" fill="${abcdColor}" text-anchor="middle">${labels[p]}</text>`);
    }
    const r = ev.abcd.ratios || {};
    const abcdName = ev.abcd.label || ev.abcd.family || 'AB=CD';
    g.push(
      `<text x="${L}" y="${height - 4}" font-size="10" fill="${abcdColor}">${abcdName} ${ev.abcd.dir} · BC ${r.bc ?? '—'} · CD/AB ${r.cdAb ?? '—'} · cross in ${ev.abcd.crossIn || '?'}</text>`
    );
  }

  // header
  const abcdTag = ev.abcd ? ` + ${ev.abcd.label || ev.abcd.family || 'AB=CD'}` : '';
  const title = `${symbol} · ${tf} · EMA 20/50/200 triple cross ${ev.dir === 'UP' ? '▲ UP' : '▼ DOWN'}${abcdTag}`;
  g.push(`<text x="${L}" y="18" font-size="14" font-weight="700" fill="${evColor}">${title}</text>`);
  g.push(`<text x="${L}" y="35" font-size="11" fill="#444">${fmtTime(ev.time, tzMin)} (${tzLabel(tzMin)}) · close ${fmtPrice(ev.price)} · ${ev.crosses.map((c) => c.pair).join(' + ')} crossed within ${ev.spanBars + 1} bars</text>`);
  // legend
  const lx = width - R - 190;
  g.push(`<text x="${lx}" y="18" font-size="11" fill="#f23645">● EMA20</text>`);
  g.push(`<text x="${lx + 62}" y="18" font-size="11" fill="#ff9800">● EMA50</text>`);
  g.push(`<text x="${lx + 124}" y="18" font-size="11" fill="#2962ff">● EMA200</text>`);
  g.push('</svg>');
  return g.join('');
}
