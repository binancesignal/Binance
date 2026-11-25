/**
 * Extra strategies that live on the Harmonic board (same coins, same chunks, same lifecycle):
 *
 *  1. ELLIOTT  — "Elliott Wave – Impulse" (HeWhoMustNotBeNamed, Pine v4) ported 1:1
 *                zigzag(10) → wave 1 (P0→P1) + wave 2 (P1→P2), W2/W1 ≈ 0.5 / 0.618 / 0.764 / 0.854 (±5 %),
 *                entry = P2 ± 30 % of W2, stop = P0, trailing stop = P2 ∓ 30 % of W2,
 *                targets = P2 ± 1.618 / 2.0 / 2.618 / 3.236 × W2
 *  2. ABCD_SP  — ABCD pattern (Pine v6 "ABCD + PRZ") + "SP breaker"
 *                SP breaker = a breaker block whose origin candle lies on the AB or BC wave, that touches the C
 *                candle (wick or body), and was born at or before C (never one formed after C).
 *                Trend filter = EMA200: pattern fully BELOW the EMA → trend down, fully ABOVE → trend up,
 *                touching the EMA anywhere → dropped.
 *                  trend down + upward ABCD (HH, HL)  → LONG  at the SP breaker's TOP line,  SL below its bottom line
 *                  trend up   + downward ABCD (LL, LH) → SHORT at the SP breaker's BOTTOM line, SL above its top line
 *
 * Every event has the same shape the board already understands (plan / status / przLow…), so the refresh cron,
 * the feed, the admin status pin and the auto-trader work on them unchanged.
 *
 * Lifecycle at the moment of a scan (price replayed after the structure):
 *   TP already hit            → FORMED
 *   entry hit, no TP / no SL  → IN_TRADE
 *   entry hit, stop hit       → dropped (dead setup)
 *   entry not hit, close      → ENTRY_READY      far → WATCHING
 *   structure broken before entry → dropped
 */
import { calcATR, calcEMASeries } from '../../indicators.js';
import { detectBreakers, BREAKER_DEFAULTS } from './breakerBlock.js';

export const EXTRA_DEFAULTS = Object.freeze({
  harmonicEnabled: true, // master switch for the harmonic XABCD scan (kept here so the harmonic settings stay untouched)
  tfs: Object.freeze(['1h', '4h']), // timeframes of THESE strategies (independent of the harmonic ones)
  enableElliott: false,
  enableAbcdSp: false,
  elliott: Object.freeze({
    zigzagLength: 10, // Pine: zigzagLength
    errorPercent: 5, // Pine: errorPercent
    entryPercent: 30, // Pine: entryPercent
    maxAgeBars: 80, // wave 2 pivot must be this recent (bars before the last candle)
    maxPerSide: 2,
  }),
  abcd: Object.freeze({
    swingLeft: 5,
    swingRight: 5,
    bcMin: 0.5,
    bcMax: 0.886,
    cdMin: 1.13,
    cdMax: 1.618,
    minLegAtr: 1.5, // Pine: Minimum AB leg (x ATR)
    emaPeriod: 200,
    stopBufferAtr: 0.25, // SL distance below/above the SP breaker line, in ATR (admin editable)
    spStrictBorn: false, // true: the breaker must ALSO have been confirmed (broken) at or before C; false: its origin candle must be at/before C
    maxAgeBars: 120, // D pivot must be this recent
    maxPerSide: 2,
  }),
});

const num = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const bool = (v, d = false) => (v === undefined || v === null ? d : v === true || v === 'true');

export function normalizeExtraConfig(raw = {}) {
  const e = { ...EXTRA_DEFAULTS.elliott, ...(raw.elliott || {}) };
  const a = { ...EXTRA_DEFAULTS.abcd, ...(raw.abcd || {}) };
  return {
    enableElliott: bool(raw.enableElliott),
    harmonicEnabled: raw.harmonicEnabled === undefined ? true : bool(raw.harmonicEnabled, true),
    tfs: Array.isArray(raw.tfs) && raw.tfs.length ? raw.tfs.map(String) : [...EXTRA_DEFAULTS.tfs],
    enableAbcdSp: bool(raw.enableAbcdSp),
    elliott: {
      zigzagLength: Math.round(num(e.zigzagLength, 10, 2, 60)),
      errorPercent: num(e.errorPercent, 5, 1, 20),
      entryPercent: num(e.entryPercent, 30, 5, 100),
      maxAgeBars: Math.round(num(e.maxAgeBars, 80, 5, 400)),
      maxPerSide: Math.round(num(e.maxPerSide, 2, 1, 6)),
    },
    abcd: {
      swingLeft: Math.round(num(a.swingLeft, 5, 1, 20)),
      swingRight: Math.round(num(a.swingRight, 5, 1, 20)),
      bcMin: num(a.bcMin, 0.5, 0.1, 0.99),
      bcMax: num(a.bcMax, 0.886, 0.1, 0.99),
      cdMin: num(a.cdMin, 1.13, 0.5, 4),
      cdMax: num(a.cdMax, 1.618, 0.5, 4),
      minLegAtr: num(a.minLegAtr, 1.5, 0, 20),
      emaPeriod: Math.round(num(a.emaPeriod, 200, 20, 400)),
      stopBufferAtr: num(a.stopBufferAtr, 0.25, 0, 5),
      spStrictBorn: bool(a.spStrictBorn, false),
      maxAgeBars: Math.round(num(a.maxAgeBars, 120, 10, 400)),
      maxPerSide: Math.round(num(a.maxPerSide, 2, 1, 6)),
    },
  };
}

/** Counters that explain WHY a scan returned little (shown in the Strategies card). */
export const emptyDiag = () => ({
  windows: 0,
  elliottPivotSets: 0, elliottFibOk: 0, elliottRecent: 0, elliottListed: 0,
  abcdPatterns: 0, abcdRecent: 0, abcdEmaSide: 0, abcdTrendShape: 0, abcdSpBreaker: 0, abcdListed: 0,
});
export function mergeDiag(a, b) {
  const out = { ...emptyDiag(), ...(a || {}) };
  for (const k of Object.keys(emptyDiag())) out[k] = (out[k] || 0) + ((b && b[k]) || 0);
  return out;
}

export const isExtraEvent = (e) => e?.strategy === 'ELLIOTT' || e?.strategy === 'ABCD_SP';

// ─────────────────────────────────────────────────────────────────────────────
// Shared lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/** Distance (in %) from price to entry that counts as "close" (matches the board's proximity setting). */
const READY_PCT_DEFAULT = 2.0; // same default as the board (entryReadyProximityPercent)

/**
 * Replay candles after `fromIndex` against the plan.
 * Entry is "hit" when price TRADES through the entry level (LONG: high ≥ entry after being below, etc.),
 * for a zone-type entry (ABCD_SP) when price touches the entry line.
 */
export function replayPlan(candles, fromIndex, ev, { stopOnly = false } = {}) {
  const plan = ev.plan;
  const long = ev.direction === 'LONG';
  let entryIdx = null;
  let tpReached = 0;
  let outcome = null;
  let status = null;
  let invalid = false;
  const brokenBefore = (c) => (long ? c.low < ev.invalidBelow : c.high > ev.invalidAbove);

  for (let i = Math.max(0, fromIndex); i < candles.length; i++) {
    const c = candles[i];
    if (entryIdx == null) {
      // structure broken before the entry → dead (use CLOSE so a single wick does not kill the setup)
      if (ev.invalidBelow != null && long && c.close < ev.invalidBelow) { invalid = true; break; }
      if (ev.invalidAbove != null && !long && c.close > ev.invalidAbove) { invalid = true; break; }
      const hit = ev.entryMode === 'cross'
        ? (long ? c.high >= plan.entry : c.low <= plan.entry)
        : (long ? c.low <= plan.entry : c.high >= plan.entry);
      if (!hit) continue;
      entryIdx = i;
      // entry candle may already take the stop out (conservative: stop first)
      if (long ? c.low <= plan.sl : c.high >= plan.sl) {
        if (ev.entryMode === 'cross' ? false : true) { outcome = 'SL_HIT'; status = 'SL_HIT'; break; }
      }
      continue;
    }
    // trade running
    if (long ? c.low <= plan.sl : c.high >= plan.sl) {
      outcome = 'SL_HIT';
      status = 'SL_HIT';
      break;
    }
    const lvl = (k) => plan[k];
    const hitTp = (k) => (long ? c.high >= lvl(k) : c.low <= lvl(k));
    if (plan.tp3 != null && hitTp('tp3')) { tpReached = 3; break; }
    if (plan.tp2 != null && hitTp('tp2')) tpReached = Math.max(tpReached, 2);
    else if (plan.tp1 != null && hitTp('tp1')) tpReached = Math.max(tpReached, 1);
  }
  void brokenBefore;
  if (invalid) return { status: 'INVALIDATED', outcome: 'STRUCTURE_BROKEN', entryTouched: false, tpReached: 0, entryIdx: null };
  if (status === 'SL_HIT') return { status, outcome, entryTouched: true, tpReached, entryIdx };
  if (entryIdx == null) return { status: null, outcome: null, entryTouched: false, tpReached: 0, entryIdx: null };
  if (tpReached > 0) return { status: `TP${tpReached}_HIT`, outcome: `TP${tpReached}_HIT`, entryTouched: true, tpReached, entryIdx };
  return { status: 'IN_TRADE', outcome: 'ENTRY_FILLED', entryTouched: true, tpReached: 0, entryIdx };
}

/** Status before the entry is touched: ENTRY_READY when price is close to the entry, else WATCHING. */
export function preEntryStatus(price, ev, proximityPct = READY_PCT_DEFAULT) {
  const entry = ev.plan.entry;
  const dist = (Math.abs(price - entry) / entry) * 100;
  // wrong side (price already beyond the entry in the direction of the trade) cannot happen here: that is "entry hit"
  return dist <= proximityPct ? 'ENTRY_READY' : 'WATCHING';
}

function ratioRR(plan, long) {
  const risk = Math.abs(plan.entry - plan.sl);
  if (!(risk > 0)) return {};
  const rr = (tp) => (tp == null ? null : +(Math.abs(tp - plan.entry) / risk).toFixed(2));
  return { rr1: rr(plan.tp1), rr2: rr(plan.tp2), rr3: rr(plan.tp3) };
}

/** Initial state at scan time. Returns null when the setup is dead and must not be listed. */
function scanLifecycle(candles, fromIndex, ev, proximityPct) {
  const last = candles[candles.length - 1];
  const r = replayPlan(candles, fromIndex, ev);
  // Always return a status so the setup can appear as a signal card (Harmonic-style board).
  if (r.status === 'INVALIDATED') {
    return { status: 'INVALIDATED', outcome: 'INVALIDATED', entryTouched: !!r.entryTouched, tpReached: r.tpReached || 0, price: last.close };
  }
  if (r.status === 'SL_HIT') {
    return { status: 'SL_HIT', outcome: 'SL_HIT', entryTouched: true, tpReached: r.tpReached || 0, price: last.close };
  }
  if (r.tpReached > 0) return { status: 'FORMED', outcome: r.outcome, entryTouched: true, tpReached: r.tpReached, price: last.close };
  if (r.entryTouched) return { status: 'IN_TRADE', outcome: 'ENTRY_FILLED', entryTouched: true, tpReached: 0, price: last.close };
  return { status: preEntryStatus(last.close, ev, proximityPct), outcome: null, entryTouched: false, tpReached: 0, price: last.close };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Elliott Wave – Impulse  (port of the Pine v4 indicator)
// ─────────────────────────────────────────────────────────────────────────────

/** Bar-by-bar zigzag exactly like the indicator: pivots[0] = newest. dir ±2 = higher-high / lower-low pivot. */
export function runZigzag(candles, length) {
  const n = candles.length;
  const pv = []; // {v, bar, dir}
  let dirPrev = 0;
  const snapshots = new Map(); // bar index → copy of pivots (only on bars where a pivot changed)
  for (let i = 0; i < n; i++) {
    if (i < length - 1) continue;
    let hiv = -Infinity;
    let lov = Infinity;
    for (let k = i - length + 1; k <= i; k++) {
      if (candles[k].high > hiv) hiv = candles[k].high;
      if (candles[k].low < lov) lov = candles[k].low;
    }
    const phigh = candles[i].high >= hiv ? candles[i].high : null; // highestbars(high, length) == 0
    const plow = candles[i].low <= lov ? candles[i].low : null;
    let dir = phigh != null && plow == null ? 1 : plow != null && phigh == null ? -1 : dirPrev;
    const dirChanged = dir !== dirPrev && i > length - 1; // change(dir)
    const dirForStore = dir;
    dirPrev = dir;
    if (phigh == null && plow == null) continue;
    let value = dirForStore === 1 ? phigh : plow;
    let bar = i;
    let storeDir = dirForStore;
    if (!dirChanged && pv.length >= 1) {
      const p = pv.shift();
      const keep = value * p.dir < p.v * p.dir;
      value = keep ? p.v : value;
      bar = keep ? p.bar : bar;
    }
    if (pv.length >= 2) {
      const last = pv[1].v;
      storeDir = storeDir * value > storeDir * last ? storeDir * 2 : storeDir;
    }
    pv.unshift({ v: value, bar, dir: storeDir });
    if (pv.length > 10) pv.pop();
    snapshots.set(i, pv.map((p) => ({ ...p })));
  }
  return snapshots;
}

const FIB_R2 = [0.5, 0.618, 0.764, 0.854];

export function findElliottEvents(candles, cfgIn = {}, { proximityPct = READY_PCT_DEFAULT, diag } = {}) {
  const c = normalizeExtraConfig({ elliott: cfgIn }).elliott;
  const closed = candles.slice(0, -1); // last candle may still be forming
  if (closed.length < c.zigzagLength * 4 + 20) return [];
  const atr = calcATR(closed, 14) || closed[closed.length - 1].close * 0.01;
  const errMin = (100 - c.errorPercent) / 100;
  const errMax = (100 + c.errorPercent) / 100;
  const entryRange = c.entryPercent / 100;
  const snaps = runZigzag(closed, c.zigzagLength);
  const lastIdx = closed.length - 1;

  const found = new Map();
  for (const [barIdx, piv] of snaps) {
    if (piv.length < 4) continue; // start = 1 (wait for confirmation) → needs 3 + 1 pivots
    const p2 = piv[1];
    const p1 = piv[2];
    const p0 = piv[3];
    const w1 = Math.abs(p1.v - p0.v);
    const w2 = Math.abs(p2.v - p1.v);
    if (!(w1 > 0) || !(w2 > 0)) continue;
    const r2 = w2 / w1;
    const fit = FIB_R2.find((f) => r2 > f * errMin && r2 < f * errMax);
    if (fit == null) continue;
    const dirOk = (p1.dir === 2 && p2.dir === -1) || (p1.dir === -2 && p2.dir === 1);
    if (!dirOk) continue;
    const key = `${p0.bar}|${p1.bar}|${p2.bar}`;
    if (found.has(key)) continue;
    if (diag) { diag.elliottPivotSets += 1; diag.elliottFibOk += 1; }
    found.set(key, { p0, p1, p2, w1, w2, r2, fit, seenBar: barIdx });
  }

  const out = [];
  for (const f of found.values()) {
    if (lastIdx - f.p2.bar > c.maxAgeBars) continue;
    if (diag) diag.elliottRecent += 1;
    const dir = f.p0.v > f.p1.v ? -1 : 1;
    const direction = dir === 1 ? 'LONG' : 'SHORT';
    const entry = f.p2.v + dir * entryRange * f.w2;
    const stop = f.p0.v;
    const tstop = f.p2.v - dir * entryRange * f.w2;
    const tps = [1.618, 2.0, 2.618, 3.236].map((m) => f.p2.v + dir * m * f.w2);
    const plan = { entry, sl: stop, tp1: tps[0], tp2: tps[1], tp3: tps[2], tp4: tps[3], tstop };
    Object.assign(plan, ratioRR(plan, dir === 1));
    if (!(Math.abs(entry - stop) > 0)) continue;

    const ev = {
      strategy: 'ELLIOTT',
      family: 'EW_IMPULSE',
      label: 'Elliott Impulse (W1 → W2)',
      kind: 'STRATEGY',
      direction,
      entryMode: 'cross', // entry is ABOVE the wave-2 low (long): price must trade up through it
      invalidBelow: dir === 1 ? f.p2.v : null, // wave 2 extended → this count is replaced by a newer one
      invalidAbove: dir === -1 ? f.p2.v : null,
      plan,
      entry,
      przLow: Math.min(entry, entry - dir * 0.1 * f.w2),
      przHigh: Math.max(entry, entry - dir * 0.1 * f.w2),
      points: [
        { label: '0', i: f.p0.bar, price: f.p0.v, time: closed[f.p0.bar].time },
        { label: '1', i: f.p1.bar, price: f.p1.v, time: closed[f.p1.bar].time },
        { label: '2', i: f.p2.bar, price: f.p2.v, time: closed[f.p2.bar].time },
      ],
      A: { i: f.p0.bar, price: f.p0.v, time: closed[f.p0.bar].time },
      B: { i: f.p1.bar, price: f.p1.v, time: closed[f.p1.bar].time },
      C: { i: f.p2.bar, price: f.p2.v, time: closed[f.p2.bar].time },
      time: closed[f.p2.bar].time,
      index: f.p2.bar,
      ratios: { w2w1: +f.r2.toFixed(3), fib: f.fit },
      theory: ewTheory(direction, f),
    };
    const life = scanLifecycle(candles, f.p2.bar + 1, ev, proximityPct);
    if (!life) continue;
    // score: fib fit (0–20) + wave size in ATR (0–10) + RR to target 1 (0–10)
    const fitPts = 20 * (1 - Math.min(1, Math.abs(f.r2 - f.fit) / (f.fit * (c.errorPercent / 100))));
    const sizePts = Math.min(10, (f.w1 / atr) * 2);
    const rr1 = plan.rr1 || 0;
    const rrPts = Math.min(10, rr1 * 5);
    const score = Math.round(Math.min(95, 55 + fitPts + sizePts + rrPts));
    if (diag) diag.elliottListed += 1;
    out.push({ ...ev, ...life, score, marketTime: candles[candles.length - 1].time, ema200: null });
  }

  // newest structures first, a few per side
  const per = { LONG: 0, SHORT: 0 };
  return out
    .sort((a, b) => b.index - a.index)
    .filter((e) => (per[e.direction] += 1) <= c.maxPerSide);
}

function ewTheory(direction, f) {
  const up = direction === 'LONG';
  return [
    `Elliott impulse, early stage: wave 1 ${up ? 'up' : 'down'} (0 → 1), wave 2 corrects ${(f.r2 * 100).toFixed(0)} % of wave 1 (near the ${f.fit} Fibonacci level) and holds ${up ? 'above' : 'below'} the start of wave 1.`,
    `Wave 3 is expected next: price should leave wave 2 ${up ? 'upwards' : 'downwards'}. Entry = wave 2 end ± 30 % of wave 2 (price must trade through it), stop = start of wave 1, targets = wave 2 length × 1.618 / 2.0 / 2.618 / 3.236 from the wave 2 end.`,
  ].join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) ABCD + SP breaker
// ─────────────────────────────────────────────────────────────────────────────

/** Pivot high / low with `left` before and `right` after (Pine ta.pivothigh / ta.pivotlow: strict on the left? no — ≥ on left, > on right). */
function pivotAt(candles, i, left, right, isHigh) {
  const v = isHigh ? candles[i].high : candles[i].low;
  for (let k = 1; k <= left; k++) {
    const o = isHigh ? candles[i - k].high : candles[i - k].low;
    if (isHigh ? o > v : o < v) return false;
  }
  for (let k = 1; k <= right; k++) {
    const o = isHigh ? candles[i + k].high : candles[i + k].low;
    if (isHigh ? o >= v : o <= v) return false;
  }
  return true;
}

/** Zigzag exactly like the Pine v6 script: alternating pivots, a same-type pivot only replaces when more extreme. */
export function abcdPatterns(candles, c) {
  const n = candles.length;
  const atrAll = [];
  // ATR(14) per bar (simple Wilder), cheap enough for ≤ 1000 bars
  let prevClose = candles[0].close;
  let atr = null;
  for (let i = 0; i < n; i++) {
    const cd = candles[i];
    const tr = Math.max(cd.high - cd.low, Math.abs(cd.high - prevClose), Math.abs(cd.low - prevClose));
    atr = atr == null ? tr : (atr * 13 + tr) / 14;
    atrAll.push(atr);
    prevClose = cd.close;
  }
  let p1 = null, p2 = null, p3 = null, p4 = null; // {v, b, h}
  const out = [];
  const shift = (np) => {
    p4 = p3; p3 = p2; p2 = p1; p1 = np;
  };
  for (let t = c.swingLeft + c.swingRight; t < n; t++) {
    const pb = t - c.swingRight; // pivot bar, confirmed at bar t
    if (pb < c.swingLeft) continue;
    const isH = pivotAt(candles, pb, c.swingLeft, c.swingRight, true);
    const isL = pivotAt(candles, pb, c.swingLeft, c.swingRight, false);
    let newPivot = false;
    if (isH) {
      if (p1 == null || !p1.h) {
        shift({ v: candles[pb].high, b: pb, h: true });
        newPivot = true;
      } else if (candles[pb].high > p1.v) p1 = { v: candles[pb].high, b: pb, h: true };
    }
    if (isL) {
      if (p1 == null || p1.h) {
        shift({ v: candles[pb].low, b: pb, h: false });
        newPivot = true;
      } else if (candles[pb].low < p1.v) p1 = { v: candles[pb].low, b: pb, h: false };
    }
    if (!newPivot || !p4) continue;
    const a = atrAll[t];
    // ↓ bullish ABCD (D is a low): A high, B low, C high (lower than A), D low
    if (p4.h && !p3.h && p2.h && !p1.h) {
      const ab = p4.v - p3.v, bc = p2.v - p3.v, cd = p2.v - p1.v;
      if (ab >= c.minLegAtr * a && ab > 0 && bc > 0 && cd > 0 && p2.v < p4.v) {
        const bcR = bc / ab, cdR = cd / bc;
        if (bcR >= c.bcMin && bcR <= c.bcMax && cdR >= c.cdMin && cdR <= c.cdMax) {
          out.push({ form: 'DOWN', A: p4, B: p3, C: p2, D: p1, bcR, cdR, confirmBar: t });
        }
      }
    }
    // ↑ bearish ABCD (D is a high): A low, B high, C low (higher than A), D high
    if (!p4.h && p3.h && !p2.h && p1.h) {
      const ab = p3.v - p4.v, bc = p3.v - p2.v, cd = p1.v - p2.v;
      if (ab >= c.minLegAtr * a && ab > 0 && bc > 0 && cd > 0 && p2.v > p4.v) {
        const bcR = bc / ab, cdR = cd / bc;
        if (bcR >= c.bcMin && bcR <= c.bcMax && cdR >= c.cdMin && cdR <= c.cdMax) {
          out.push({ form: 'UP', A: p4, B: p3, C: p2, D: p1, bcR, cdR, confirmBar: t });
        }
      }
    }
  }
  return out;
}

/** The SP breaker: origin on AB/BC wave, touches the C candle, born at or before C, side matches the trade. */
export function findSpBreaker(breakers, pat, candles, long, { strictBorn = false } = {}) {
  const Cc = candles[pat.C.b];
  const list = (breakers || []).filter((b) => {
    if (long !== !!b.isBull) return false; // LONG → bullish (support) breaker, SHORT → bearish
    const origin = b.obBar ?? b.bornBar;
    if (origin == null || origin < pat.A.b || origin > pat.C.b) return false; // on the AB or BC wave
    // never one that STARTS after C (its origin is checked above); strict mode also wants it confirmed by C
    if (strictBorn && (b.bornBar == null || b.bornBar > pat.C.b)) return false;
    // touches the C candle with wick OR body
    return Math.min(b.top, Cc.high) - Math.max(b.bot, Cc.low) >= 0;
  });
  return list.sort((x, y) => (y.quality || 0) - (x.quality || 0))[0] || null;
}

export function findAbcdSpEvents(candles, cfgIn = {}, { proximityPct = READY_PCT_DEFAULT, breakerCfg, breakers: injected, diag } = {}) {
  const c = normalizeExtraConfig({ abcd: cfgIn }).abcd;
  const closed = candles.slice(0, -1);
  if (closed.length < Math.max(60, c.emaPeriod * 0.4)) return [];
  const lastIdx = closed.length - 1;
  const atrNow = calcATR(closed, 14) || closed[lastIdx].close * 0.01;
  const ema = calcEMASeries(closed, c.emaPeriod);
  const allPats = abcdPatterns(closed, c);
  const pats = allPats.filter((p) => lastIdx - p.D.b <= c.maxAgeBars);
  if (diag) { diag.abcdPatterns += allPats.length; diag.abcdRecent += pats.length; }
  if (!pats.length) return [];
  const breakers = injected || detectBreakers(closed, { ...(breakerCfg || BREAKER_DEFAULTS), keepAll: true });

  const out = [];
  for (const p of pats) {
    // trend by EMA200: the whole pattern must sit on ONE side of it
    let above = true;
    let below = true;
    let hasEma = true;
    for (let i = p.A.b; i <= p.D.b; i++) {
      const e = ema[i];
      if (e == null) { hasEma = false; break; }
      if (!(closed[i].low > e)) above = false;
      if (!(closed[i].high < e)) below = false;
    }
    if (!hasEma || (!above && !below)) continue; // touches the EMA somewhere → not taken
    if (diag) diag.abcdEmaSide += 1;
    const trend = above ? 'UP' : 'DOWN';
    // trend down + upward ABCD (HH, HL) → LONG;  trend up + downward ABCD (LL, LH) → SHORT
    let long;
    if (trend === 'DOWN' && p.form === 'UP') long = true;
    else if (trend === 'UP' && p.form === 'DOWN') long = false;
    else continue;
    if (diag) diag.abcdTrendShape += 1;

    const sp = findSpBreaker(breakers, p, closed, long, { strictBorn: c.spStrictBorn });
    if (!sp) continue;
    if (diag) diag.abcdSpBreaker += 1;
    const buffer = c.stopBufferAtr * atrNow;
    const entry = long ? sp.top : sp.bot;
    const sl = long ? sp.bot - buffer : sp.top + buffer;
    const risk = Math.abs(entry - sl);
    if (!(risk > 0)) continue;
    const sign = long ? 1 : -1;
    const dPrice = p.D.v;
    // targets: half way back to D, D itself, then an extension of the CD leg — never less than 1R / 1.5R / 2.2R
    const t1 = long ? Math.max(entry + (dPrice - entry) * 0.5, entry + risk) : Math.min(entry + (dPrice - entry) * 0.5, entry - risk);
    const t2 = long ? Math.max(dPrice, entry + 1.5 * risk) : Math.min(dPrice, entry - 1.5 * risk);
    const t3 = long ? Math.max(dPrice + 0.618 * Math.abs(dPrice - p.C.v), entry + 2.2 * risk) : Math.min(dPrice - 0.618 * Math.abs(dPrice - p.C.v), entry - 2.2 * risk);
    const plan = { entry, sl, tp1: t1, tp2: t2, tp3: t3 };
    Object.assign(plan, ratioRR(plan, long));

    const pt = (q, label) => ({ label, i: q.b, price: q.v, time: closed[q.b].time });
    const ev = {
      strategy: 'ABCD_SP',
      family: 'ABCD_SP',
      label: `ABCD + SP breaker (${long ? 'trend down · HH/HL' : 'trend up · LL/LH'})`,
      kind: 'STRATEGY',
      direction: long ? 'LONG' : 'SHORT',
      entryMode: 'touch', // price comes BACK to the SP breaker line
      // structure is dead if price closes through the far side of the breaker before it ever entered
      invalidBelow: long ? sl : null,
      invalidAbove: long ? null : sl,
      plan,
      entry,
      przLow: sp.bot,
      przHigh: sp.top,
      points: [pt(p.A, 'A'), pt(p.B, 'B'), pt(p.C, 'C'), pt(p.D, 'D')],
      A: pt(p.A, 'A'), B: pt(p.B, 'B'), C: pt(p.C, 'C'), D: pt(p.D, 'D'),
      breakers: [{ id: sp.id, isBull: sp.isBull, side: sp.side, top: sp.top, bot: sp.bot, bornBar: sp.bornBar, obBar: sp.obBar, quality: sp.quality }],
      spBreaker: { top: sp.top, bot: sp.bot, bornBar: sp.bornBar, obBar: sp.obBar, quality: sp.quality },
      time: closed[p.D.b].time,
      index: p.D.b,
      trend,
      ema200: ema[lastIdx],
      ratios: { bcAb: +p.bcR.toFixed(3), cdBc: +p.cdR.toFixed(3) },
      theory: abcdTheory(long, trend, p, sp),
    };
    // D extended a lot after completion (beyond noise) before entry → structure likely replaced.
    // Tiny wicks beyond D are normal; require ~0.35 ATR beyond D.
    const afterD = closed.slice(p.D.b + 1);
    const dPad = atrNow * 0.35;
    const dBroken = afterD.some((x) => (long ? x.high > dPrice + dPad : x.low < dPrice - dPad));
    const life = scanLifecycle(candles, p.D.b + 1, ev, proximityPct);
    if (!life) continue;
    // Still show WATCHING / ENTRY_READY / IN_TRADE / FORMED. Only skip pre-entry if D was heavily extended.
    if (!life.entryTouched && dBroken && !['IN_TRADE', 'FORMED', 'SL_HIT'].includes(life.status)) {
      // Keep as INVALIDATED card so admin can still open chart and inspect
      life.status = 'INVALIDATED';
      life.outcome = 'D_EXTENDED';
    }
    // score: ratio fit (0–15) + SP breaker quality (0–15) + RR (0–10)
    const fitPts = 15 * (1 - Math.min(1, (Math.abs(p.bcR - 0.7) / 0.4 + Math.abs(p.cdR - 1.3) / 0.5) / 2));
    const qPts = Math.min(15, (sp.quality || 0) * 0.15);
    const rrPts = Math.min(10, (plan.rr2 || 0) * 3);
    const score = Math.round(Math.min(95, 55 + fitPts + qPts + rrPts));
    if (diag) diag.abcdListed += 1;
    out.push({ ...ev, ...life, score, marketTime: candles[candles.length - 1].time });
  }
  const per = { LONG: 0, SHORT: 0 };
  return out.sort((a, b) => b.index - a.index).filter((e) => (per[e.direction] += 1) <= c.maxPerSide);
}

function abcdTheory(long, trend, p, sp) {
  const f = long ? 'an UPWARD ABCD (A low → B high → C higher low → D higher high)' : 'a DOWNWARD ABCD (A high → B low → C lower high → D lower low)';
  return [
    `EMA200 trend is ${trend}: the whole pattern sits ${trend === 'UP' ? 'above' : 'below'} the EMA200 (never touching it).`,
    `Pattern: ${f}; BC/AB = ${(p.bcR * 100).toFixed(0)} %, CD/BC = ${p.cdR.toFixed(2)}.`,
    `SP breaker = a ${sp.isBull ? 'bullish' : 'bearish'} breaker block that starts on the AB/BC wave, touches the C candle and was born at or before C.`,
    `Price is expected to come back from D to the SP breaker. ${long ? 'LONG at its TOP line, stop just below its bottom line' : 'SHORT at its BOTTOM line, stop just above its top line'}.`,
  ].join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point used by the harmonic scanner
// ─────────────────────────────────────────────────────────────────────────────

export function findExtraEvents(candles, cfg = {}, opts = {}) {
  const x = normalizeExtraConfig(cfg);
  const out = [];
  if (opts.diag) opts.diag.windows += 1;
  if (x.enableElliott) out.push(...findElliottEvents(candles, x.elliott, opts));
  if (x.enableAbcdSp) out.push(...findAbcdSpEvents(candles, x.abcd, { ...opts, breakerCfg: cfg.breakerCfg }));
  return out.sort((a, b) => (b.score || 0) - (a.score || 0));
}
/** The strategies' own entry point (independent of the harmonic settings). */
export const findStrategyEvents = findExtraEvents;

// ─────────────────────────────────────────────────────────────────────────────
// Refresh (board cron): same fields the harmonic revalidate returns
// ─────────────────────────────────────────────────────────────────────────────

export function revalidateExtraSignal(candles, saved, cfgIn = {}) {
  const last = candles.length - 1;
  const price = candles[last].close;
  const ev = { ...saved };
  const from = saved.index != null ? saved.index + 1 : 0;
  // candle indexes shift when the window moves: re-anchor on the structure end TIME
  let startI = from;
  if (saved.time != null) {
    const k = candles.findIndex((c) => +c.time >= +saved.time);
    if (k >= 0) startI = k + 1;
  }
  const r = replayPlan(candles, startI, ev);
  let status;
  let outcome = r.outcome;
  if (r.status === 'INVALIDATED') {
    status = 'INVALIDATED';
  } else if (r.status) {
    status = r.status;
  } else {
    status = preEntryStatus(price, ev, +cfgIn.proximityPercent?.entryReadyProximityPercent || READY_PCT_DEFAULT);
    outcome = null;
  }
  const emaSeries = calcEMASeries(candles, 200);
  return {
    ...saved,
    status,
    outcome,
    entryTouched: r.entryTouched,
    tpReached: r.tpReached,
    price,
    marketTime: candles[last].time,
    ema200: emaSeries[last] ?? saved.ema200 ?? null,
    refreshedAt: Math.floor(Date.now() / 1000),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart (SVG) + annotations
// ─────────────────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const fmtTime = (t, tzMin = 0) => {
  const d = new Date((t + tzMin * 60) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
};
const fmtPrice = (p) => {
  if (p == null || !Number.isFinite(p)) return '—';
  const a = Math.abs(p);
  return p.toFixed(a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : 6);
};

/** Index of the candle with this time (structure points are stored with time so they survive window shifts). */
const idxOfTime = (candles, t) => {
  if (t == null) return -1;
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (+candles[mid].time >= +t) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
};

export function buildExtraChartSvg(candles, ev, opts = {}) {
  const { symbol = '', tf = '', before = 25, after = 30, tzMin = 0, width = 900, height = 520 } = opts;
  const pts = (ev.points || []).map((p) => ({ ...p, i: idxOfTime(candles, p.time) })).filter((p) => p.i >= 0);
  if (pts.length < 3) return null;
  const startI = Math.min(...pts.map((p) => p.i));
  const from = Math.max(0, startI - before);
  const to = Math.min(candles.length - 1, Math.max(...pts.map((p) => p.i)) + Math.max(after, 40));
  const vis = candles.slice(from, to + 1);
  if (vis.length < 8) return null;
  const L = 10, R = 78, T = 50, B = 36;
  const pw = width - L - R;
  const ph = height - T - B;
  const step = pw / vis.length;
  const bw = Math.max(1, Math.min(10, step * 0.65));
  let lo = Infinity, hi = -Infinity;
  for (const c of vis) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); }
  const plan = ev.plan || {};
  for (const k of ['entry', 'sl', 'tp1', 'tp2', 'tp3', 'tp4', 'tstop']) {
    if (plan[k] != null) { lo = Math.min(lo, plan[k]); hi = Math.max(hi, plan[k]); }
  }
  for (const p of pts) { lo = Math.min(lo, p.price); hi = Math.max(hi, p.price); }
  const sp = ev.spBreaker;
  if (sp) { lo = Math.min(lo, sp.bot); hi = Math.max(hi, sp.top); }
  const padP = (hi - lo) * 0.08 || hi * 0.01;
  lo -= padP; hi += padP;
  const y = (p) => T + ph - ((p - lo) / (hi - lo)) * ph;
  const x = (k) => L + step * k + step / 2;
  const dirColor = ev.direction === 'LONG' ? '#0ecb81' : '#f6465d';
  const g = [];
  g.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial,Helvetica,sans-serif">`);
  g.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  const title = `${symbol} ${String(tf).toUpperCase()} · ${ev.label} · ${ev.direction}`;
  g.push(`<text x="${L + 4}" y="20" font-size="14" font-weight="700" fill="#111">${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`);
  g.push(`<text x="${L + 4}" y="38" font-size="11" fill="#666">${ev.status || ''}${ev.score != null ? ` · score ${ev.score}` : ''}</text>`);
  for (let n = 0; n <= 6; n++) {
    const p = lo + ((hi - lo) * n) / 6;
    const yy = y(p).toFixed(1);
    g.push(`<line x1="${L}" x2="${L + pw}" y1="${yy}" y2="${yy}" stroke="#eceff3"/>`);
    g.push(`<text x="${L + pw + 6}" y="${(+yy + 4).toFixed(1)}" font-size="11" fill="#555">${fmtPrice(p)}</text>`);
  }
  const labelEvery = Math.max(1, Math.round(vis.length / 6));
  for (let k = 0; k < vis.length; k += labelEvery) {
    g.push(`<text x="${x(k).toFixed(1)}" y="${height - 12}" font-size="10" fill="#666" text-anchor="middle">${fmtTime(vis[k].time, tzMin).slice(5)}</text>`);
  }
  // SP breaker block
  if (sp) {
    const col = ev.direction === 'LONG' ? '#22c5a6' : '#f472b6';
    const oi = Math.max(from, sp.obBar != null ? Math.min(idxOfTime(candles, candles[Math.min(sp.obBar, candles.length - 1)]?.time), to) : from);
    const x1 = x(Math.max(0, (oi < 0 ? from : oi) - from));
    const x2 = L + pw;
    g.push(`<rect x="${x1.toFixed(1)}" y="${Math.min(y(sp.top), y(sp.bot)).toFixed(1)}" width="${(x2 - x1).toFixed(1)}" height="${Math.max(2, Math.abs(y(sp.bot) - y(sp.top))).toFixed(1)}" fill="${col}" opacity="0.25" stroke="${col}" stroke-width="1.2"/>`);
    g.push(`<text x="${(x1 + 4).toFixed(1)}" y="${(Math.min(y(sp.top), y(sp.bot)) - 4).toFixed(1)}" font-size="10" font-weight="700" fill="${col}">SP BREAKER ${fmtPrice(sp.bot)}–${fmtPrice(sp.top)}</text>`);
  }
  // EMA200
  if (ev.strategy === 'ABCD_SP') {
    const ema = calcEMASeries(candles, 200);
    let d = '';
    for (let k = 0; k < vis.length; k++) {
      const v = ema[from + k];
      if (v == null) continue;
      d += (d ? ' L ' : 'M ') + `${x(k).toFixed(1)} ${y(v).toFixed(1)}`;
    }
    if (d) g.push(`<path d="${d}" fill="none" stroke="#2962ff" stroke-width="1.6"/>`);
  }
  // candles
  for (let k = 0; k < vis.length; k++) {
    const c = vis[k];
    const col = c.close >= c.open ? '#089981' : '#f23645';
    const cx = x(k).toFixed(1);
    g.push(`<line x1="${cx}" x2="${cx}" y1="${y(c.high).toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${col}"/>`);
    g.push(`<rect x="${(x(k) - bw / 2).toFixed(1)}" y="${y(Math.max(c.open, c.close)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y(c.open) - y(c.close))).toFixed(1)}" fill="${col}"/>`);
  }
  // structure path (0-1-2 or A-B-C-D)
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.i < from || b.i > to) continue;
    g.push(`<line x1="${x(a.i - from).toFixed(1)}" y1="${y(a.price).toFixed(1)}" x2="${x(b.i - from).toFixed(1)}" y2="${y(b.price).toFixed(1)}" stroke="${dirColor}" stroke-width="2" ${ev.strategy === 'ELLIOTT' ? '' : ''}/>`);
  }
  // BC "retest" guide for ABCD: dotted line from D back to the breaker entry
  for (const m of pts) {
    if (m.i < from || m.i > to) continue;
    const cx = x(m.i - from), cy = y(m.price);
    g.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5.5" fill="${dirColor}" stroke="#fff" stroke-width="1.4"/>`);
    g.push(`<text x="${cx.toFixed(1)}" y="${(cy - 11).toFixed(1)}" font-size="11" font-weight="700" fill="${dirColor}" text-anchor="middle">${m.label} ${fmtPrice(m.price)}</text>`);
  }
  // levels
  const levels = [
    [plan.entry, '#2563eb', 'Entry'],
    [plan.sl, '#EF4444', 'SL'],
    [plan.tstop, '#f97316', 'T.Stop'],
    [plan.tp1, '#10B981', ev.strategy === 'ELLIOTT' ? 'Target-1' : 'TP1'],
    [plan.tp2, '#10B981', ev.strategy === 'ELLIOTT' ? 'Target-2' : 'TP2'],
    [plan.tp3, '#059669', ev.strategy === 'ELLIOTT' ? 'Target-3' : 'TP3'],
    [plan.tp4, '#047857', 'Target-4'],
  ];
  for (const [price, col, lab] of levels) {
    if (price == null || !Number.isFinite(price)) continue;
    const yy = y(price);
    g.push(`<line x1="${L}" x2="${L + pw}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${col}" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.9"/>`);
    g.push(`<text x="${L + pw - 4}" y="${(yy - 3).toFixed(1)}" font-size="10" fill="${col}" text-anchor="end">${lab} ${fmtPrice(price)}</text>`);
  }
  g.push('</svg>');
  return g.join('');
}

export function buildExtraAnnotations(ev, candles, opts = {}) {
  const tf = opts.tf || ev.tf || '';
  const lastT = candles?.[candles.length - 1]?.time ?? ev.time;
  const tEnd = lastT != null ? lastT + 40 * 60 : (ev.time || 0) + 3600;
  const pts = ev.points || [];
  const anns = [];
  anns.push({
    group: 'abcd',
    kind: 'poly',
    tf,
    points: pts.map((p) => ({ t: p.time, p: p.price })),
    label: ev.label || ev.family,
  });
  for (const p of pts) {
    anns.push({
      group: 'abcd', kind: 'marker', tf, t: p.time, p: p.price,
      shape: ev.direction === 'LONG' ? 'up' : 'down',
      label: `${p.label} ${Number(p.price).toPrecision(6)}`, bold: true,
    });
  }
  const sp = ev.spBreaker;
  if (sp) {
    const t0 = candles[Math.min(sp.obBar ?? 0, candles.length - 1)]?.time ?? pts[0]?.time;
    anns.push({
      group: 'breaker', kind: 'zone', tf, t1: t0, t2: tEnd, p1: sp.top, p2: sp.bot,
      label: `SP BREAKER ${Number(sp.bot).toPrecision(6)} – ${Number(sp.top).toPrecision(6)}`,
    });
  }
  const plan = ev.plan;
  if (plan) {
    const t1 = pts[0]?.time ?? lastT;
    const nm = (k) => (ev.strategy === 'ELLIOTT' ? { tp1: 'Target-1', tp2: 'Target-2', tp3: 'Target-3', tp4: 'Target-4' }[k] : k.toUpperCase());
    anns.push({ group: 'entry', kind: 'hline', tf, t1, t2: tEnd, p1: plan.entry, label: `Entry ${Number(plan.entry).toPrecision(6)}`, tone: 'tp' });
    anns.push({ group: 'entry', kind: 'hline', tf, t1, t2: tEnd, p1: plan.sl, label: `Stop ${Number(plan.sl).toPrecision(6)}`, tone: 'sl', style: 'dashed' });
    if (plan.tstop != null) anns.push({ group: 'entry', kind: 'hline', tf, t1, t2: tEnd, p1: plan.tstop, label: `T.Stop ${Number(plan.tstop).toPrecision(6)}`, tone: 'sl', style: 'dotted' });
    for (const k of ['tp1', 'tp2', 'tp3', 'tp4']) {
      if (plan[k] != null) anns.push({ group: 'targets', kind: 'hline', tf, t1, t2: tEnd, p1: plan[k], label: `${nm(k)} ${Number(plan[k]).toPrecision(6)}`, tone: 'tp', style: k === 'tp1' ? undefined : 'dashed' });
    }
  }
  if (ev.ema200 != null && ev.strategy === 'ABCD_SP') {
    anns.push({ group: 'trend', kind: 'hline', tf, t1: pts[0]?.time, t2: tEnd, p1: ev.ema200, label: `EMA200 ${Number(ev.ema200).toPrecision(6)}`, tone: 'ema' });
  }
  return anns;
}
