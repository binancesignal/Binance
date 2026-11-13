/**
 * POI SYSTEM — market-structure primitives. Pure functions on CLOSED candles only
 * ({time (s), open, high, low, close, volume}, oldest → newest). No look-ahead: every pivot is only
 * "known" `right` bars after it formed, and every break needs a candle that has already CLOSED.
 */
import { findSwings, calcATR } from '../scanner/indicators.js';
import { detectLuxAlgoOrderBlocksHistorical } from '../scanner/orderBlocks.js';
import { POI_TF_SEC } from './config.js';

const r8 = (n) => +(+n).toFixed(8);

/** keep only candles that have fully closed at `nowSec` (the last, still-forming candle never produces structure) */
export function closedCandles(raw, tf, nowSec) {
  const sec = POI_TF_SEC[tf];
  return (Array.isArray(raw) ? raw : [])
    .filter((c) => c && [c.time, c.open, c.high, c.low, c.close].every((v) => Number.isFinite(+v)) && +c.high >= +c.low)
    .map((c) => ({ time: +c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: Number.isFinite(+c.volume) ? +c.volume : 0 }))
    .filter((c) => c.time + sec <= nowSec)
    .sort((a, b) => a.time - b.time);
}

export const atrOf = (candles, period = 14) => calcATR(candles, period) || (candles.length ? Math.abs(candles.at(-1).high - candles.at(-1).low) : 0);

/**
 * Pivots (swing highs / lows), alternated so that two highs in a row keep only the higher one (and lows the lower one).
 * Each pivot carries `confirmedAt` = index of the candle that confirmed it (i + right).
 */
export function pivots(candles, bars) {
  const raw = findSwings(candles, bars, bars)
    .map((s) => ({ i: s.i, type: s.type === 'H' ? 'high' : 'low', price: s.price, time: s.time, confirmedAt: s.i + bars }))
    .sort((a, b) => a.i - b.i || (a.type === 'high' ? -1 : 1));
  const out = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (last && last.type === p.type) {
      if ((p.type === 'high' && p.price > last.price) || (p.type === 'low' && p.price < last.price)) out[out.length - 1] = p;
    } else out.push(p);
  }
  return out;
}

/** HH/HL/LH/LL labels on an alternated pivot list + the resulting trend */
export function labelPivots(alt) {
  let ph = null;
  let pl = null;
  const labeled = alt.map((p) => {
    let label;
    if (p.type === 'high') {
      label = ph == null ? 'H' : p.price > ph.price ? 'HH' : 'LH';
      ph = p;
    } else {
      label = pl == null ? 'L' : p.price > pl.price ? 'HL' : 'LL';
      pl = p;
    }
    return { ...p, label };
  });
  const highs = labeled.filter((p) => p.type === 'high').slice(-2);
  const lows = labeled.filter((p) => p.type === 'low').slice(-2);
  let trend = 'RANGE';
  if (highs.length === 2 && lows.length === 2) {
    const hh = highs[1].price > highs[0].price;
    const hl = lows[1].price > lows[0].price;
    if (hh && hl) trend = 'BULLISH';
    else if (!hh && !hl) trend = 'BEARISH';
  }
  return { labeled, trend };
}

/**
 * Walk the candles once and emit BOS / MSS events. A swing can be broken only once, so one price movement never
 * produces duplicate events.
 *   BOS = break of the latest swing in the direction of the current trend (continuation)
 *   MSS = break of the latest OPPOSITE swing (structure shift / CHoCH)
 * `confirm: 'close'` needs a candle close beyond the level (default) · `'wick'` accepts the high/low.
 */
export function walkStructure(candles, alt, { confirm = 'close', holdBars = 0, buffer = 0 } = {}) {
  const events = [];
  let trend = 'NONE';
  let hi = null; // latest unbroken pivot high
  let lo = null; // latest unbroken pivot low
  let k = 0;
  const byConf = [...alt].sort((a, b) => a.confirmedAt - b.confirmedAt);
  for (let i = 0; i < candles.length; i++) {
    while (k < byConf.length && byConf[k].confirmedAt <= i - 1) {
      // a pivot becomes usable only after its confirmation candle is complete (strictly before the candle being tested)
      const p = byConf[k++];
      if (p.type === 'high') hi = p;
      else lo = p;
    }
    const c = candles[i];
    const upBreak = confirm === 'wick' ? c.high : c.close;
    const dnBreak = confirm === 'wick' ? c.low : c.close;
    if (hi && upBreak > hi.price + buffer && (confirm === 'wick' || c.close > hi.price)) {
      const hold = holdOk(candles, i, hi.price, 'up', holdBars);
      if (hold) {
        events.push({ kind: trend === 'BEARISH' ? 'MSS' : 'BOS', dir: 'BULL', level: hi.price, levelTime: hi.time, pivotIndex: hi.i, index: i, time: c.time, pending: hold === 'pending' });
        trend = 'BULLISH';
        hi = null;
        continue;
      }
    }
    if (lo && dnBreak < lo.price - buffer && (confirm === 'wick' || c.close < lo.price)) {
      const hold = holdOk(candles, i, lo.price, 'down', holdBars);
      if (hold) {
        events.push({ kind: trend === 'BULLISH' ? 'MSS' : 'BOS', dir: 'BEAR', level: lo.price, levelTime: lo.time, pivotIndex: lo.i, index: i, time: c.time, pending: hold === 'pending' });
        trend = 'BEARISH';
        lo = null;
      }
    }
  }
  return { events, trend };
}

// the break only counts if the next `holdBars` closed candles stay beyond the level (when they exist yet)
function holdOk(candles, i, level, side, holdBars) {
  for (let k = 1; k <= holdBars; k++) {
    const c = candles[i + k];
    if (!c) return 'pending'; // the hold candles are not closed yet → the break is reported but flagged `pending` (never confirms a setup)
    if (side === 'up' ? c.close <= level : c.close >= level) return false;
  }
  return true;
}

/** the swing range that defines the CURRENT dealing range (used for premium / discount) */
export function dealingRange(candles, alt) {
  const highs = alt.filter((p) => p.type === 'high');
  const lows = alt.filter((p) => p.type === 'low');
  if (!highs.length || !lows.length) return null;
  // the most recent confirmed major swing high and low, extended by anything that traded beyond them since
  const H = highs[highs.length - 1];
  const L = lows[lows.length - 1];
  let high = H.price;
  let low = L.price;
  let hi = H;
  let lw = L;
  for (let i = Math.min(H.i, L.i) + 1; i < candles.length; i++) {
    if (candles[i].high > high) { high = candles[i].high; hi = { i, price: high, time: candles[i].time }; }
    if (candles[i].low < low) { low = candles[i].low; lw = { i, price: low, time: candles[i].time }; }
  }
  if (!(high > low)) return null;
  return { high: r8(high), low: r8(low), eq: r8((high + low) / 2), highTime: hi.time, lowTime: lw.time, highIndex: hi.i, lowIndex: lw.i };
}

/** where a price sits in the range: 0 = swing low · 1 = swing high */
export const rangePos = (range, price) => (price - range.low) / (range.high - range.low || 1);

/**
 * Liquidity pools from pivots on one time frame.
 *  - equal highs / lows: ≥2 pivots within `tolAtr`·ATR of each other (counted once as one pool)
 *  - single swing highs / lows that no later candle traded through (still resting liquidity)
 *  - external = the dealing-range extremes · internal = everything inside the range
 */
export function liquidityPools(candles, alt, { tolAtr = 0.15, range = null } = {}) {
  const atr = atrOf(candles);
  const tol = Math.max(atr * tolAtr, 1e-12);
  const pools = [];
  const make = (type, group) => {
    const price = group.reduce((a, p) => a + p.price, 0) / group.length;
    const last = group[group.length - 1];
    const taken = candles.slice(last.i + 1).some((c) => (type === 'BSL' ? c.high > Math.max(...group.map((p) => p.price)) : c.low < Math.min(...group.map((p) => p.price))));
    const ext = range ? (type === 'BSL' ? Math.abs(price - range.high) <= tol : Math.abs(price - range.low) <= tol) : false;
    pools.push({
      type, // BSL (above highs) | SSL (below lows)
      price: r8(type === 'BSL' ? Math.max(...group.map((p) => p.price)) : Math.min(...group.map((p) => p.price))),
      kind: group.length >= 2 ? (type === 'BSL' ? 'EQUAL_HIGHS' : 'EQUAL_LOWS') : type === 'BSL' ? 'SWING_HIGH' : 'SWING_LOW',
      count: group.length,
      scope: ext ? 'EXTERNAL' : 'INTERNAL',
      time: group[0].time,
      lastTime: last.time,
      index: last.i,
      taken,
    });
  };
  for (const [type, side] of [['BSL', 'high'], ['SSL', 'low']]) {
    const ps = alt.filter((p) => p.type === side);
    const used = new Set();
    for (let a = 0; a < ps.length; a++) {
      if (used.has(a)) continue;
      const group = [ps[a]];
      for (let b = a + 1; b < ps.length; b++) if (!used.has(b) && Math.abs(ps[b].price - ps[a].price) <= tol) { group.push(ps[b]); used.add(b); }
      used.add(a);
      make(type, group);
    }
  }
  return pools.sort((a, b) => a.index - b.index);
}

/**
 * Sweep = a candle trades beyond a pool and CLOSES back inside. A sweep is only called REJECTED when price then
 * holds away from the level (no close beyond it) for `holdBars` closed candles AND moves ≥ `moveAtr`·ATR away.
 * A close beyond the level that keeps going is a real break (FAILED), not a sweep.
 */
export function findSweeps(candles, pools, { holdBars = 2, moveAtr = 0.5, lookback = 80 } = {}) {
  const atr = atrOf(candles);
  const out = [];
  const from = Math.max(0, candles.length - lookback);
  for (const p of pools) {
    for (let i = Math.max(from, p.index + 1); i < candles.length; i++) {
      const c = candles[i];
      const wickBeyond = p.type === 'BSL' ? c.high > p.price : c.low < p.price;
      const closedBack = p.type === 'BSL' ? c.close < p.price : c.close > p.price;
      if (!wickBeyond) continue;
      if (!closedBack) break; // closed beyond = a break of the pool, not a sweep (pool is consumed)
      const after = candles.slice(i + 1, i + 1 + holdBars);
      const held = after.every((x) => (p.type === 'BSL' ? x.close < p.price : x.close > p.price));
      const far = [c, ...after].reduce((m, x) => (p.type === 'BSL' ? Math.min(m, x.low) : Math.max(m, x.high)), p.type === 'BSL' ? Infinity : -Infinity);
      const moved = p.type === 'BSL' ? p.price - far >= atr * moveAtr : far - p.price >= atr * moveAtr;
      const complete = after.length >= holdBars;
      out.push({
        poolType: p.type,
        side: p.type === 'SSL' ? 'BULL' : 'BEAR', // sweeping sell-side liquidity is the bullish sweep
        level: p.price,
        kind: p.kind,
        scope: p.scope,
        index: i,
        time: c.time,
        extreme: p.type === 'BSL' ? c.high : c.low,
        status: complete ? (held && moved ? 'REJECTED' : 'FAILED') : 'PENDING',
      });
      break; // one sweep per pool
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** three-candle imbalances with a proper lifecycle: FRESH → PARTIAL → FILLED | INVALIDATED */
export function findFvgs(candles, { minAtr = 0.1, lookback = 150 } = {}) {
  const atr = atrOf(candles);
  const out = [];
  const from = Math.max(2, candles.length - lookback);
  for (let i = from; i < candles.length; i++) {
    const a = candles[i - 2];
    const c = candles[i];
    for (const bull of [true, false]) {
      const lo = bull ? a.high : c.high;
      const hi = bull ? c.low : a.low;
      if (!(bull ? a.high < c.low : a.low > c.high)) continue;
      const size = hi - lo;
      if (size < atr * minAtr) continue;
      let deepest = 0; // how far price traded back into the gap (0..1)
      let invalid = false;
      for (let k = i + 1; k < candles.length; k++) {
        const x = candles[k];
        const pen = bull ? (hi - x.low) / size : (x.high - lo) / size;
        if (pen > deepest) deepest = Math.min(1, pen);
        if (bull ? x.close < lo : x.close > hi) { invalid = true; break; }
      }
      out.push({
        type: bull ? 'BULL' : 'BEAR',
        high: r8(hi),
        low: r8(lo),
        index: i,
        time: c.time,
        startTime: a.time,
        status: invalid ? 'INVALIDATED' : deepest >= 1 ? 'FILLED' : deepest > 0 ? 'PARTIAL' : 'FRESH',
        filled: +deepest.toFixed(2),
      });
    }
  }
  return out;
}

/**
 * Order blocks: the LuxAlgo-style detector already used by the Double-OB module (OB = the candle that started
 * the move which later broke structure), re-classified here:
 *   INVALIDATED — price closed (or wicked, per config) through the far side
 *   MITIGATED   — price traded back into the zone after it was confirmed
 *   FRESH       — never revisited
 * and validated: the impulse after the OB must be ≥ `minDisplacementAtr`·ATR.
 */
export function findOrderBlocks(candles, { lookback = 400, mitigation = 'close', minDisplacementAtr = 1.2, length = 5 } = {}) {
  const atr = atrOf(candles);
  const raw = detectLuxAlgoOrderBlocksHistorical(candles, lookback, { length, mitigation: mitigation === 'wick' ? 'Wick' : 'Close' });
  const out = [];
  for (const ob of raw) {
    const bull = ob.type === 'bullish';
    const start = (ob.confBar ?? ob.index) + 1;
    let invalidAt = null;
    let touchAt = null;
    for (let k = start; k < candles.length; k++) {
      const c = candles[k];
      const through = mitigation === 'wick' ? (bull ? c.low < ob.low : c.high > ob.high) : bull ? c.close < ob.low : c.close > ob.high;
      if (through) { invalidAt = k; break; }
      if (touchAt == null && c.low <= ob.high && c.high >= ob.low) touchAt = k;
    }
    // displacement: the strongest move within 6 candles after the OB candle
    const seg = candles.slice(ob.index + 1, ob.index + 7);
    const impulse = seg.length ? (bull ? Math.max(...seg.map((x) => x.high)) - ob.low : ob.high - Math.min(...seg.map((x) => x.low))) : 0;
    const displacementAtr = atr ? impulse / atr : 0;
    out.push({
      type: bull ? 'BULL' : 'BEAR',
      high: r8(ob.high),
      low: r8(ob.low),
      mid: r8(ob.avg ?? ob.mid),
      index: ob.index,
      confBar: ob.confBar ?? ob.index,
      time: ob.time,
      status: invalidAt != null ? 'INVALIDATED' : touchAt != null ? 'MITIGATED' : 'FRESH',
      touchedIndex: touchAt,
      invalidatedIndex: invalidAt,
      displacementAtr: +displacementAtr.toFixed(2),
      valid: displacementAtr >= minDisplacementAtr,
    });
  }
  return out;
}

export const overlapFrac = (a, b) => {
  const lo = Math.max(a.low, b.low);
  const hi = Math.min(a.high, b.high);
  if (hi <= lo) return 0;
  return (hi - lo) / Math.max(1e-12, Math.min(a.high - a.low, b.high - b.low));
};
