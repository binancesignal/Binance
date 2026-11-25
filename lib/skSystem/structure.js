/**
 * Market-structure primitives — confirmed pivots, trend, CHoCH, BOS, sweeps, FVG.
 * Everything uses CLOSED candles and CONFIRMED pivots (a pivot needs `right` later bars), so a
 * historical result never changes when new candles arrive — no repainting.
 *
 * All "bullish" helpers work in LONG space. SHORT setups run the same code on mirrored candles
 * (price × −1), which guarantees LONG / SHORT symmetry.
 */

const finite = (n) => Number.isFinite(+n);

export function cleanCandles(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((c) => c && finite(c.time) && finite(c.open) && finite(c.high) && finite(c.low) && finite(c.close) && +c.high >= +c.low)
    .map((c) => ({ time: +c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: finite(c.volume) ? +c.volume : 0 }));
}

/** price × −1 (high/low swap) — SHORT analysis runs on this */
export function mirrorCandles(candles) {
  return candles.map((c) => ({ time: c.time, open: -c.open, high: -c.low, low: -c.high, close: -c.close, volume: c.volume }));
}

export function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  let sum = 0;
  const from = candles.length - period;
  for (let i = from; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / period;
}

export function sma(values, period) {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

/** raw confirmed pivots: left bars strictly lower/higher, right bars not higher/lower */
export function findPivots(candles, left = 3, right = 3) {
  const out = [];
  const n = candles.length;
  for (let i = left; i < n - right; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    let isH = true;
    let isL = true;
    for (let k = 1; k <= left; k++) {
      if (candles[i - k].high >= h) isH = false;
      if (candles[i - k].low <= l) isL = false;
    }
    for (let k = 1; k <= right; k++) {
      if (candles[i + k].high > h) isH = false;
      if (candles[i + k].low < l) isL = false;
    }
    if (isH) out.push({ i, time: candles[i].time, price: h, type: 'high' });
    if (isL) out.push({ i, time: candles[i].time, price: l, type: 'low' });
  }
  return out;
}

/** make pivots strictly alternate high/low (keep the more extreme of consecutive same-type pivots) */
export function alternatePivots(pivots) {
  const out = [];
  const sorted = [...pivots].sort((a, b) => a.i - b.i || (a.type === 'high' ? -1 : 1));
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && last.type === p.type) {
      if ((p.type === 'high' && p.price > last.price) || (p.type === 'low' && p.price < last.price)) out[out.length - 1] = p;
    } else out.push(p);
  }
  return out;
}

export function swings(candles, bars = 3) {
  return alternatePivots(findPivots(candles, bars, bars));
}

/** 'UP' (HH+HL) · 'DOWN' (LH+LL) · 'RANGE' — from the last two highs and lows */
export function trendOf(alt) {
  const highs = alt.filter((p) => p.type === 'high').slice(-2);
  const lows = alt.filter((p) => p.type === 'low').slice(-2);
  if (highs.length < 2 || lows.length < 2) return 'RANGE';
  const hh = highs[1].price > highs[0].price;
  const hl = lows[1].price > lows[0].price;
  const lh = highs[1].price < highs[0].price;
  const ll = lows[1].price < lows[0].price;
  if (hh && hl) return 'UP';
  if (lh && ll) return 'DOWN';
  return 'RANGE';
}

/**
 * Latest BULLISH CHoCH.
 *   prior down-trend  : H1 > H2 (lower high) and L1 > L2 (lower low), pivots in order H1 L1 H2 L2
 *   CHoCH             : first candle AFTER L2 whose CLOSE is above H2 (+ optional ATR buffer)
 *   validity          : L2 stays the lowest low until the break; break is not older than maxAgeBars
 * Returns { H1, L1, H2, A (= L2), level, breakIdx, breakTime, breakClose } or null.
 */
export function findBullishChoch(candles, alt, { maxAgeBars = 150, buffer = 0, minLowIdx = 0, minLowPrice = -Infinity, accept = null, pick = 'latest', holdCheck = true } = {}) {
  const n = candles.length;
  const order = [];
  for (let k = 3; k < alt.length; k++) order.push(k);
  if (pick === 'latest') order.reverse();
  for (const k of order) {
    const L2 = alt[k];
    if (L2.type !== 'low' || L2.i < minLowIdx || L2.price < minLowPrice) continue;
    const H2 = alt[k - 1];
    const L1 = alt[k - 2];
    const H1 = alt[k - 3];
    if (!(H2.type === 'high' && L1.type === 'low' && H1.type === 'high')) continue;
    if (!(H2.price < H1.price && L2.price < L1.price)) continue; // not a down-trend
    if (accept && !accept({ H1, L1, H2, L2 })) continue;
    const level = H2.price + buffer;
    let lowest = L2.price;
    let breakIdx = -1;
    for (let j = L2.i + 1; j < n; j++) {
      if (candles[j].low < lowest) {
        lowest = candles[j].low;
        if (lowest < L2.price) break; // a lower low formed first → L2 is not the swing low any more
      }
      if (candles[j].close > level) {
        breakIdx = j;
        break;
      }
    }
    if (breakIdx < 0) continue;
    // the swing low must still hold after the break (a later lower low = this structure failed)
    let held = true;
    if (holdCheck) for (let j = breakIdx + 1; j < n; j++) if (candles[j].low < L2.price) { held = false; break; }
    if (!held) continue;
    if (n - 1 - breakIdx > maxAgeBars) { if (pick === 'latest') return null; continue; } // stale
    return {
      H1,
      L1,
      H2,
      A: L2,
      level: H2.price,
      breakIdx,
      breakTime: candles[breakIdx].time,
      breakClose: candles[breakIdx].close,
    };
  }
  return null;
}

/** bearish BOS in the old down-trend (close below a confirmed pivot low) + bullish BOS after the CHoCH */
export function findBosPoints(candles, alt, { fromIdx = 0, side = 'bull' } = {}) {
  const out = [];
  const type = side === 'bull' ? 'high' : 'low';
  for (const p of alt) {
    if (p.type !== type || p.i < fromIdx) continue;
    for (let j = p.i + 1; j < candles.length; j++) {
      const broke = side === 'bull' ? candles[j].close > p.price : candles[j].close < p.price;
      if (broke) {
        out.push({ time: candles[j].time, level: p.price, fromTime: p.time, side });
        break;
      }
    }
  }
  return out.slice(-4);
}

/** liquidity sweep: wick below a prior confirmed pivot low that CLOSES back above it (bullish) */
export function findSweeps(candles, alt, { fromIdx = 0 } = {}) {
  const out = [];
  for (const p of alt) {
    if (p.type !== 'low') continue;
    for (let j = Math.max(p.i + 1, fromIdx); j < candles.length; j++) {
      const c = candles[j];
      if (c.low < p.price && c.close > p.price) {
        out.push({ time: c.time, level: p.price, low: c.low, fromTime: p.time });
        break;
      }
      if (c.close < p.price) break; // closed through it — a break, not a sweep
    }
  }
  return out.slice(-3);
}

/** bullish fair-value gaps (3-candle imbalance) from fromIdx on, newest last */
export function findBullFvgs(candles, fromIdx = 0) {
  const out = [];
  for (let i = Math.max(2, fromIdx); i < candles.length; i++) {
    const a = candles[i - 2];
    const c = candles[i];
    if (c.low > a.high) out.push({ time: candles[i - 1].time, top: c.low, bottom: a.high });
  }
  return out.slice(-3);
}

/** last bearish candle before the bullish impulse that ended at breakIdx → bullish order block */
export function findBullOb(candles, breakIdx, lookback = 12) {
  for (let i = breakIdx - 1; i >= Math.max(0, breakIdx - lookback); i--) {
    if (candles[i].close < candles[i].open) return { time: candles[i].time, top: candles[i].high, bottom: candles[i].low };
  }
  return null;
}

/** highest high / index in (fromIdx, end] */
export function highestAfter(candles, fromIdx) {
  let best = -1;
  for (let i = fromIdx + 1; i < candles.length; i++) if (best < 0 || candles[i].high > candles[best].high) best = i;
  return best;
}
export function lowestAfter(candles, fromIdx) {
  let best = -1;
  for (let i = fromIdx + 1; i < candles.length; i++) if (best < 0 || candles[i].low < candles[best].low) best = i;
  return best;
}
export const idxAtOrAfter = (candles, time) => {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (candles[m].time < time) lo = m + 1;
    else hi = m;
  }
  return lo;
};
