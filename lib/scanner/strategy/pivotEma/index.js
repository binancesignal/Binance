/**
 * Pivot + EMA + Trendline-break strategy (experimental — BACKTEST first).
 *
 * Idea (trader observation):
 *   1. Market trades around / above the Standard pivot P.
 *   2. EMA 20/50 cross happens near P.
 *   3. LEFT of that cross there is a clean directional leg (nice upward or downward move)
 *      on which a trendline can be drawn (rising lows → uptrend line, falling highs → downtrend).
 *   4. ENTRY when that trendline BREAKS, while price is still near the pivot.
 *        - break of uptrend support  → SHORT
 *        - break of downtrend resistance → LONG
 *
 * Pivot P = (H+L+C)/3 of previous period (TradingView Auto: ≤15m Daily, 30m–12h Weekly, 1d Monthly).
 *
 * SL modes: 'pivot' | 'cross' | 'swing' (beyond the trend leg extreme — default for trendline mode)
 */
import { calcEMASeries, findSwings } from '../../indicators.js';

export const PIVOT_EMA_TFS = ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];
export const PIVOT_EMA_FIXED = {
  fastPeriod: 20,
  slowPeriod: 50,
  atrPeriod: 14,
  approachBars: 3,
  crossBars: 24, // bars after EMA cross allowed for post-cross swing + trendline break
  maxCrossDistATR: 2.5, // |crossPrice − P| and |break − P| must be ≤ this (admin can set from 0.05)
  requireNoRecross: true,
  minRunATR: 0.5, // min height of the left-side leg in ATR (clean move)
  minCrossBarsAgo: 0,
  legLookback: 40, // bars left of the cross to search for swing leg / trendline
  swingLeft: 2,
  swingRight: 2,
  minSwingPoints: 2, // need at least 2 swing lows (up) or highs (down)
  requirePostCrossPoint: true, // second trendline anchor must be AFTER the EMA cross
  // Both sides of the leg: first EMA cross on the LEFT and first on the RIGHT must each be near the same pivot
  requireBothSidePivotCross: false, // admin toggle — when true, only these setups pass
  // Chop filter: too many EMA flips around the leg = skip
  rejectChop: true,
  maxEmaCrossesInWindow: 3, // max EMA20/50 crosses from leg start → break (exclusive of the signal cross itself counts toward total)
  minBarsBetweenCrosses: 2, // if two crosses closer than this many bars → chop
  maxBarsBetweenFirstSecondCross: 18, // 1st and 2nd EMA cross must not be farther apart than this (bars)

  breakBeyondATR: 0.02, // how far past the line counts as a break (ATR fraction)
  breakMode: 'wick', // 'wick' = earlier entry on high/low pierce · 'close' = wait for candle close beyond line
  useLegPatterns: true, // detect falling/rising wedge & bull/bear flag inside the leg for safer entry
  targetATR: 1,
  stopATR: 1,
  slMode: 'swing', // 'pivot' | 'cross' | 'swing'
  slFromCrossATR: 0.6,
  swingSlBufferATR: 0.15, // buffer beyond leg extreme for SL
  maxBars: 24,
};

/** True if EMA20/50 crossed on bar j (j vs j-1). */
function isCrossAt(fast, slow, j) {
  if (j < 1 || fast[j] == null || slow[j] == null || fast[j - 1] == null || slow[j - 1] == null) return false;
  const now = fast[j] - slow[j];
  const prev = fast[j - 1] - slow[j - 1];
  return (now > 0 && prev <= 0) || (now < 0 && prev >= 0);
}

/** Nearest EMA cross at or before idx (scanning left). Returns { index, price, type } or null. */
function nearestCrossLeft(fast, slow, idx) {
  for (let j = idx; j >= 1; j--) {
    if (!isCrossAt(fast, slow, j)) continue;
    const now = fast[j] - slow[j];
    const prev = fast[j - 1] - slow[j - 1];
    const t = prev === now ? 1 : prev / (prev - now);
    const price = fast[j - 1] + t * (fast[j] - fast[j - 1]);
    return { index: j, price, type: now > 0 ? 'BULL' : 'BEAR' };
  }
  return null;
}

/** Nearest EMA cross at or after idx (scanning right). Returns { index, price, type } or null. */
function nearestCrossRight(fast, slow, idx, last) {
  for (let j = idx; j <= last; j++) {
    if (!isCrossAt(fast, slow, j)) continue;
    const now = fast[j] - slow[j];
    const prev = fast[j - 1] - slow[j - 1];
    const t = prev === now ? 1 : prev / (prev - now);
    const price = fast[j - 1] + t * (fast[j] - fast[j - 1]);
    return { index: j, price, type: now > 0 ? 'BULL' : 'BEAR' };
  }
  return null;
}


/** Compute the absolute SL price for a setup. */
export function computeStopPrice(dir, pivot, atr, crossPrice, cfg = PIVOT_EMA_FIXED, swingExtreme = null) {
  const sign = dir === 'LONG' ? 1 : -1;
  if (cfg.slMode === 'swing' && swingExtreme != null && Number.isFinite(swingExtreme)) {
    const buf = (cfg.swingSlBufferATR ?? 0.15) * atr;
    return dir === 'LONG' ? swingExtreme - buf : swingExtreme + buf;
  }
  if (cfg.slMode === 'cross' && crossPrice != null && Number.isFinite(crossPrice)) {
    const buf = (cfg.slFromCrossATR ?? 0.6) * atr;
    return dir === 'LONG' ? crossPrice - buf : crossPrice + buf;
  }
  return pivot - sign * atr * (cfg.stopATR ?? 1);
}

/**
 * Leg BETWEEN two EMA crosses (the move the trader marks: HH→LL or LL→HH).
 *
 * Window = (cross1, cross2) inclusive of interior bars.
 *   - If the extreme high occurs before the extreme low → DOWN leg (HH then LL)
 *   - If the extreme low occurs before the extreme high → UP leg (LL then HH)
 *
 * Trendline:
 *   - DOWN leg → resistance through HH and a later lower-high (or HH → high near LL)
 *   - UP leg   → support through LL and a later higher-low
 *
 * Break of that line (after cross2) is the entry.
 */
export function buildLegBetweenCrosses(candles, cross1, cross2, atr, cfg = PIVOT_EMA_FIXED) {
  if (cross2 <= cross1 + 1 || atr == null || atr <= 0) return null;
  const minH = (cfg.minRunATR ?? 0.5) * atr;
  let hiIdx = cross1, loIdx = cross1;
  let hi = -Infinity, lo = Infinity;
  for (let k = cross1; k <= cross2; k++) {
    const c = candles[k];
    if (c.high > hi) { hi = c.high; hiIdx = k; }
    if (c.low < lo) { lo = c.low; loIdx = k; }
  }
  const height = hi - lo;
  if (height < minH) return null;

  // Need a clear order: HH before LL (down) or LL before HH (up)
  if (hiIdx === loIdx) return null;

  if (hiIdx < loIdx) {
    // DOWN leg: HH → LL (trader's marked dump)
    // Resistance: HH + later lower high before LL (preferred), else high on a bar between HH and LL
    let p2i = -1, p2p = -Infinity;
    for (let k = hiIdx + 1; k < loIdx; k++) {
      if (candles[k].high < hi && candles[k].high > p2p) {
        // prefer swing-ish local highs
        const isLocal =
          (k === 0 || candles[k].high >= candles[k - 1].high) &&
          (k === candles.length - 1 || candles[k].high >= candles[k + 1].high);
        if (isLocal || candles[k].high > p2p) {
          p2i = k;
          p2p = candles[k].high;
        }
      }
    }
    if (p2i < 0) {
      // fallback: bar 60% of the way HH→LL using its high if lower than HH
      p2i = hiIdx + Math.max(1, Math.floor((loIdx - hiIdx) * 0.6));
      p2p = candles[p2i].high;
      if (!(p2p < hi)) p2p = hi - height * 0.15;
    }
    if (p2i <= hiIdx) return null;
    const slope = (p2p - hi) / (p2i - hiIdx);
    // falling resistance expected
    if (slope > 0) return null;
    const lineAt = (i) => hi + slope * (i - hiIdx);
    return {
      kind: 'down',
      p1: { i: hiIdx, price: hi, time: candles[hiIdx].time },
      p2: { i: p2i, price: p2p, time: candles[p2i].time },
      slope,
      heightATR: +(height / atr).toFixed(2),
      hasPostCross: true,
      extreme: lo, // SL side for LONG break is below leg low
      legHigh: hi,
      legLow: lo,
      cross1,
      cross2,
      lineAt,
    };
  }

  // UP leg: LL → HH
  let p2i = -1, p2p = Infinity;
  for (let k = loIdx + 1; k < hiIdx; k++) {
    if (candles[k].low > lo && candles[k].low < p2p) {
      const isLocal =
        (k === 0 || candles[k].low <= candles[k - 1].low) &&
        (k === candles.length - 1 || candles[k].low <= candles[k + 1].low);
      if (isLocal || candles[k].low < p2p) {
        p2i = k;
        p2p = candles[k].low;
      }
    }
  }
  if (p2i < 0) {
    p2i = loIdx + Math.max(1, Math.floor((hiIdx - loIdx) * 0.6));
    p2p = candles[p2i].low;
    if (!(p2p > lo)) p2p = lo + height * 0.15;
  }
  if (p2i <= loIdx) return null;
  const slope = (p2p - lo) / (p2i - loIdx);
  if (slope < 0) return null;
  const lineAt = (i) => lo + slope * (i - loIdx);
  return {
    kind: 'up',
    p1: { i: loIdx, price: lo, time: candles[loIdx].time },
    p2: { i: p2i, price: p2p, time: candles[p2i].time },
    slope,
    heightATR: +(height / atr).toFixed(2),
    hasPostCross: true,
    extreme: hi,
    legHigh: hi,
    legLow: lo,
    cross1,
    cross2,
    lineAt,
  };
}


/** Simple linear fit: price = a + b * i  on points [{i, price}, ...] */
function fitPts(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let sI = 0, sP = 0, sII = 0, sIP = 0;
  for (const p of pts) {
    sI += p.i; sP += p.price; sII += p.i * p.i; sIP += p.i * p.price;
  }
  const den = n * sII - sI * sI;
  if (Math.abs(den) < 1e-12) return { a: sP / n, b: 0, maxDev: 0 };
  const b = (n * sIP - sI * sP) / den;
  const a = (sP - b * sI) / n;
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, Math.abs(p.price - (a + b * p.i)));
  return { a, b, maxDev };
}

/**
 * Inside the leg window [cross1, cross2], detect chart patterns that give a safer/earlier entry:
 *   FALLING_WEDGE → LONG on upper-line break
 *   RISING_WEDGE  → SHORT on lower-line break
 *   BULL_FLAG     → LONG on flag high break
 *   BEAR_FLAG     → SHORT on flag low break
 *
 * Returns null if no clear pattern (caller falls back to simple trendline).
 */
export function detectLegPattern(candles, cross1, cross2, atr, cfg = PIVOT_EMA_FIXED) {
  if (cross2 - cross1 < 6 || !atr) return null;
  const swings = findSwings(candles, cfg.swingLeft ?? 2, cfg.swingRight ?? 2)
    .filter((s) => s.i >= cross1 && s.i <= cross2);
  const highs = swings.filter((s) => s.type === 'H').map((s) => ({ i: s.i, price: s.price }));
  const lows = swings.filter((s) => s.type === 'L').map((s) => ({ i: s.i, price: s.price }));

  // --- Flags: first ~40% impulse, last ~60% tight consolidation ---
  const span = cross2 - cross1;
  const mid = cross1 + Math.max(3, Math.floor(span * 0.4));
  let impHi = -Infinity, impLo = Infinity, flHi = -Infinity, flLo = Infinity;
  let impOpen = candles[cross1].open, impClose = candles[mid].close;
  for (let k = cross1; k <= mid; k++) {
    impHi = Math.max(impHi, candles[k].high);
    impLo = Math.min(impLo, candles[k].low);
  }
  for (let k = mid; k <= cross2; k++) {
    flHi = Math.max(flHi, candles[k].high);
    flLo = Math.min(flLo, candles[k].low);
  }
  const impMove = impClose - impOpen;
  const impRange = impHi - impLo;
  const flagH = flHi - flLo;
  if (impRange > atr * 1.8 && flagH < atr * 1.5 && flagH < impRange * 0.55) {
    // Bull flag: up impulse, flag doesn't retrace > 50% of impulse
    if (impMove > atr * 0.8 && (impHi - flLo) <= impRange * 0.55) {
      const upper = { a: flHi, b: 0 };
      const lower = { a: flLo, b: 0 };
      return {
        patternType: 'BULL_FLAG',
        direction: 'LONG',
        upperLine: upper,
        lowerLine: lower,
        breakLine: 'upper', // break above flag high
        lineAt: (i) => flHi, // entry boundary
        otherAt: (i) => flLo,
        startIndex: cross1,
        endIndex: cross2,
        midIndex: mid,
      };
    }
    // Bear flag: down impulse
    if (impMove < -atr * 0.8 && (flHi - impLo) <= impRange * 0.55) {
      return {
        patternType: 'BEAR_FLAG',
        direction: 'SHORT',
        upperLine: { a: flHi, b: 0 },
        lowerLine: { a: flLo, b: 0 },
        breakLine: 'lower',
        lineAt: (i) => flLo,
        otherAt: (i) => flHi,
        startIndex: cross1,
        endIndex: cross2,
        midIndex: mid,
      };
    }
  }

  // --- Wedges: need ≥2 highs and ≥2 lows with converging slopes ---
  if (highs.length >= 2 && lows.length >= 2) {
    const up = fitPts(highs.slice(-4));
    const lo = fitPts(lows.slice(-4));
    if (up && lo) {
      const iStart = Math.min(highs[0].i, lows[0].i);
      const iEnd = Math.max(highs[highs.length - 1].i, lows[lows.length - 1].i);
      const h0 = up.a + up.b * iStart;
      const h1 = up.a + up.b * iEnd;
      const l0 = lo.a + lo.b * iStart;
      const l1 = lo.a + lo.b * iEnd;
      const heightStart = h0 - l0;
      const heightEnd = h1 - l1;
      const maxDevOk = up.maxDev <= atr * 0.55 && lo.maxDev <= atr * 0.55;
      const converging = heightEnd > 0 && heightStart > 0 && heightEnd < heightStart * 0.88;
      const spanBars = Math.max(1, iEnd - iStart);
      const upMove = (up.b * spanBars) / atr; // total slope in ATR
      const loMove = (lo.b * spanBars) / atr;

      if (maxDevOk && converging && heightEnd >= atr * 0.25) {
        // Falling wedge: both lines down, lower falls slower (or upper falls faster) → bullish
        if (upMove < -0.35 && loMove < -0.15 && loMove > upMove - 0.05) {
          return {
            patternType: 'FALLING_WEDGE',
            direction: 'LONG',
            upperLine: up,
            lowerLine: lo,
            breakLine: 'upper',
            lineAt: (i) => up.a + up.b * i,
            otherAt: (i) => lo.a + lo.b * i,
            startIndex: iStart,
            endIndex: iEnd,
            anchors: { highs, lows },
          };
        }
        // Rising wedge: both lines up, upper rises faster → bearish
        if (upMove > 0.35 && loMove > 0.15 && upMove > loMove - 0.05) {
          return {
            patternType: 'RISING_WEDGE',
            direction: 'SHORT',
            upperLine: up,
            lowerLine: lo,
            breakLine: 'lower',
            lineAt: (i) => lo.a + lo.b * i,
            otherAt: (i) => up.a + up.b * i,
            startIndex: iStart,
            endIndex: iEnd,
            anchors: { highs, lows },
          };
        }
      }
    }
  }
  return null;
}

/** @deprecated kept name for any external imports — delegates to buildLegBetweenCrosses when possible */
export function buildTrendLeg(candles, crossIdx, atr, cfg = PIVOT_EMA_FIXED, untilIdx = null) {
  if (untilIdx != null && untilIdx > crossIdx + 1) {
    return buildLegBetweenCrosses(candles, crossIdx, untilIdx - 1, atr, cfg);
  }
  return null;
}

const DAY = 86400;

export function pivotKindFor(tf) {
  if (['1m', '3m', '5m', '15m'].includes(tf)) return 'D';
  if (tf === '1d') return 'M';
  return 'W';
}

function periodKey(t, kind) {
  const d = Math.floor(t / DAY);
  if (kind === 'D') return d;
  if (kind === 'W') return Math.floor((d + 3) / 7); // weeks start Monday 00:00 UTC
  const dt = new Date(t * 1000);
  return dt.getUTCFullYear() * 12 + dt.getUTCMonth();
}

function isPeriodStart(t, kind) {
  if (t % DAY !== 0) return false;
  const d = t / DAY;
  if (kind === 'D') return true;
  if (kind === 'W') return (d + 3) % 7 === 0;
  return new Date(t * 1000).getUTCDate() === 1;
}

/**
 * Per-candle pivot P (null until a COMPLETE previous period exists in the data).
 * @returns {{p:(number|null)[], kind:string}}
 */
export function computePivots(candles, tf) {
  const kind = pivotKindFor(tf);
  const p = new Array(candles.length).fill(null);
  if (!candles.length) return { p, kind };

  let key = periodKey(candles[0].time, kind);
  let complete = isPeriodStart(candles[0].time, kind); // first period only counts if we have all of it
  let H = -Infinity, L = Infinity, C = 0;
  let current = null; // pivot valid for the current period

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const k = periodKey(c.time, kind);
    if (k !== key) {
      current = complete && Number.isFinite(H) ? (H + L + C) / 3 : null;
      key = k;
      complete = true; // every later period starts inside the data
      H = -Infinity; L = Infinity;
    }
    H = Math.max(H, c.high);
    L = Math.min(L, c.low);
    C = c.close;
    p[i] = current;
  }
  return { p, kind };
}

/** Wilder ATR per bar. */
export function atrSeries(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  let prevClose = null, atr = null;
  const trs = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr = prevClose == null ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    prevClose = c.close;
    if (atr == null) {
      trs.push(tr);
      if (trs.length === period) { atr = trs.reduce((a, b) => a + b, 0) / period; out[i] = atr; }
    } else {
      atr = (atr * (period - 1) + tr) / period;
      out[i] = atr;
    }
  }
  return out;
}

/**
 * Resolve one touch: WIN / LOSS / TIMEOUT / OPEN.
 * dir = expected reversal direction.
 * stopPrice = absolute SL level (from computeStopPrice). If omitted, falls back to pivot ± stopATR.
 */
export function evaluateTouch(candles, i, dir, pivot, atr, cfg = PIVOT_EMA_FIXED, stopPrice = null, entryRef = null) {
  const sign = dir === 'LONG' ? 1 : -1; // favourable direction
  const target = (cfg.targetATR ?? 1) * atr;
  const stopDist = (cfg.stopATR ?? 1) * atr;
  // Entry reference: trendline break price when provided, else pivot
  const entry = entryRef != null && Number.isFinite(entryRef) ? entryRef : pivot;
  const sl = stopPrice != null && Number.isFinite(stopPrice)
    ? stopPrice
    : entry - sign * stopDist;
  let mfe = 0;
  let mae = 0;

  const c0 = candles[i];
  const adv0 = dir === 'SHORT' ? c0.high - entry : entry - c0.low;
  mae = Math.max(mae, adv0);
  const hitSl0 = dir === 'SHORT' ? c0.high >= sl : c0.low <= sl;
  if (hitSl0) return { outcome: 'LOSS', mfe, mae, bars: 0, stopPrice: sl };

  const last = Math.min(candles.length - 1, i + cfg.maxBars);
  for (let j = i + 1; j <= last; j++) {
    const c = candles[j];
    const fav = sign > 0 ? c.high - entry : entry - c.low;
    const adv = sign > 0 ? entry - c.low : c.high - entry;
    mfe = Math.max(mfe, fav);
    mae = Math.max(mae, adv);
    const hitTarget = fav >= target;
    const hitStop = dir === 'SHORT' ? c.high >= sl : c.low <= sl;
    if (hitStop) return { outcome: 'LOSS', mfe, mae, bars: j - i, stopPrice: sl };
    if (hitTarget) return { outcome: 'WIN', mfe, mae, bars: j - i, stopPrice: sl };
  }
  const resolvedAllBars = candles.length - 1 >= i + cfg.maxBars;
  return { outcome: resolvedAllBars ? 'TIMEOUT' : 'OPEN', mfe, mae, bars: last - i, stopPrice: sl };
}

/**
 * Find trendline-break setups near pivot with a prior EMA cross.
 * Event shape kept compatible with admin table (cross=true = strategy hit).
 */
export function findPivotTouches(candles, tf, cfg = PIVOT_EMA_FIXED) {
  const n = candles.length;
  if (n < cfg.slowPeriod + 20) return [];
  const { p, kind } = computePivots(candles, tf);
  const fast = calcEMASeries(candles, cfg.fastPeriod);
  const slow = calcEMASeries(candles, cfg.slowPeriod);
  const atr = atrSeries(candles, cfg.atrPeriod);
  const out = [];
  const maxDist = cfg.maxCrossDistATR ?? 2.5;
  const maxAfter = Math.max(1, cfg.crossBars ?? 12);
  const pierce = cfg.breakBeyondATR ?? 0.05;
  const needNoRecross = cfg.requireNoRecross !== false;
  const usedBreaks = new Set();

  for (let j = cfg.slowPeriod + 1; j < n - 1; j++) {
    if (!isCrossAt(fast, slow, j)) continue;
    const P = p[j];
    if (P == null || atr[j] == null) continue;

    const now = fast[j] - slow[j];
    const prev = fast[j - 1] - slow[j - 1];
    const tFrac = prev === now ? 1 : prev / (prev - now);
    const crossPrice = fast[j - 1] + tFrac * (fast[j] - fast[j - 1]);
    const crossDistATR = Math.abs(crossPrice - P) / atr[j];
    if (crossDistATR > maxDist) continue;

    const crossType = now > 0 ? 'BULL' : 'BEAR';
    const maxSpan = cfg.maxBarsBetweenFirstSecondCross ?? 18;
    const lastSearch = Math.min(n - 1, j + maxSpan);

    // Find the 2nd EMA cross after this one, still near the same pivot, not too far
    let cross2 = -1, cross2Price = null, cross2Type = null;
    for (let k = j + 1; k <= lastSearch; k++) {
      if (!isCrossAt(fast, slow, k)) continue;
      if (p[k] == null || atr[k] == null) continue;
      const n2 = fast[k] - slow[k];
      const p2v = fast[k - 1] - slow[k - 1];
      const tf = p2v === n2 ? 1 : p2v / (p2v - n2);
      const cp2 = fast[k - 1] + tf * (fast[k] - fast[k - 1]);
      // near pivot at cross2
      if (Math.abs(cp2 - (p[k] ?? P)) / atr[k] > maxDist) continue;
      // optional: no extra cross between j and k if requireNoRecross means only these two
      cross2 = k;
      cross2Price = cp2;
      cross2Type = n2 > 0 ? 'BULL' : 'BEAR';
      break;
    }
    if (cross2 < 0) continue;

    // LEG = the HH↔LL move BETWEEN the two crosses (what the trader marks on the chart)
    const leg = buildLegBetweenCrosses(candles, j, cross2, atr[cross2], cfg);
    if (!leg) continue;

    // Chart pattern inside the leg (wedge / flag) → safer & often earlier entry boundary
    const pattern = (cfg.useLegPatterns !== false)
      ? detectLegPattern(candles, j, cross2, atr[cross2], cfg)
      : null;
    if (pattern) {
      leg.pattern = pattern;
      // Prefer pattern breakout line for entry (earlier / clearer than single trendline)
      leg.lineAt = pattern.lineAt;
      leg.otherAt = pattern.otherAt;
      leg.patternType = pattern.patternType;
      // Align expected direction with pattern when available
      if (pattern.direction === 'LONG') leg.kind = 'down'; // resistance-side break → long
      if (pattern.direction === 'SHORT') leg.kind = 'up';
    }

    // Chop: crosses strictly inside the leg window (between the two)
    if (cfg.rejectChop !== false) {
      const maxX = cfg.maxEmaCrossesInWindow ?? 3;
      const minGap = cfg.minBarsBetweenCrosses ?? 2;
      const inner = [];
      for (let k = j; k <= cross2; k++) {
        if (isCrossAt(fast, slow, k)) inner.push(k);
      }
      // inner includes the two bookends; extra flips in between = chop
      if (inner.length > maxX) continue;
      let tooTight = false;
      for (let c = 1; c < inner.length; c++) {
        if (inner[c] - inner[c - 1] < minGap) { tooTight = true; break; }
      }
      if (tooTight) continue;
    }

    // After 2nd cross: wait for trendline BREAK near pivot
    const breakLast = Math.min(n - 1, cross2 + maxAfter);
    for (let i = cross2 + 1; i <= breakLast; i++) {
      if (usedBreaks.has(i)) continue;
      if (p[i] == null || atr[i] == null) continue;
      const Pi = p[i];
      const line = leg.lineAt(i);
      const c = candles[i];
      const prevC = candles[i - 1];
      const prevLine = leg.lineAt(i - 1);
      const buf = pierce * atr[i];
      const mode = cfg.breakMode === 'close' ? 'close' : 'wick';

      let broke = false;
      let dir = null;
      if (leg.kind === 'down') {
        // resistance break up → LONG
        // previous bar still at/under the line (not already broken)
        const wasOk = prevC.close <= prevLine + buf && prevC.high <= prevLine + buf * 2;
        // wick: high pierces line (earlier) · close: body closes above
        const nowBreak = mode === 'wick'
          ? (c.high > line + buf)
          : (c.close > line + buf);
        if (wasOk && nowBreak) { broke = true; dir = 'LONG'; }
      } else {
        // support break down → SHORT
        const wasOk = prevC.close >= prevLine - buf && prevC.low >= prevLine - buf * 2;
        const nowBreak = mode === 'wick'
          ? (c.low < line - buf)
          : (c.close < line - buf);
        if (wasOk && nowBreak) { broke = true; dir = 'SHORT'; }
      }
      if (!broke) continue;

      const nearPivot = (c.low <= Pi && c.high >= Pi) || Math.abs(c.close - Pi) / atr[i] <= maxDist;
      if (!nearPivot) continue;

      // optional both-side: 1st cross and 2nd cross already ARE the sides of the leg
      if (cfg.requireBothSidePivotCross) {
        const d1 = Math.abs(crossPrice - Pi) / atr[i];
        const d2 = Math.abs(cross2Price - Pi) / atr[i];
        if (d1 > maxDist || d2 > maxDist) continue;
      }

      usedBreaks.add(i);
      const entryPrice = +line.toFixed(8);
      const swingExt = dir === 'LONG' ? leg.legLow : leg.legHigh;
      const stopPrice = computeStopPrice(dir, Pi, atr[i], crossPrice, cfg, swingExt);
      const res = evaluateTouch(candles, i, dir, Pi, atr[i], cfg, stopPrice, entryPrice);
      out.push({
        index: i,
        time: c.time,
        dir,
        entry: entryPrice,
        pivot: Pi,
        pivotKind: kind,
        atr: atr[i],
        cross: true,
        crossType,
        crossBarsAgo: i - j,
        crossPrice,
        crossDistATR: +(Math.abs(crossPrice - Pi) / atr[i]).toFixed(2),
        crossDistAtSignal: +crossDistATR.toFixed(2),
        runATR: leg.heightATR,
        clean: true,
        trendKind: leg.kind,
        trendline: {
          kind: leg.kind,
          p1: leg.p1,
          p2: leg.p2,
          slope: leg.slope,
          breakPrice: entryPrice,
          hasPostCross: true,
          legHigh: leg.legHigh,
          legLow: leg.legLow,
          leftCross: { index: j, price: crossPrice, type: crossType },
          rightCross: { index: cross2, price: cross2Price, type: cross2Type },
          patternType: leg.patternType || null,
          pattern: leg.pattern ? {
            patternType: leg.pattern.patternType,
            direction: leg.pattern.direction,
            startIndex: leg.pattern.startIndex,
            endIndex: leg.pattern.endIndex,
            // sample line endpoints for chart (at start/end of pattern window)
            upper: leg.pattern.upperLine ? {
              p1: { i: leg.pattern.startIndex, price: leg.pattern.upperLine.a + leg.pattern.upperLine.b * leg.pattern.startIndex },
              p2: { i: leg.pattern.endIndex, price: leg.pattern.upperLine.a + leg.pattern.upperLine.b * leg.pattern.endIndex },
            } : null,
            lower: leg.pattern.lowerLine ? {
              p1: { i: leg.pattern.startIndex, price: leg.pattern.lowerLine.a + leg.pattern.lowerLine.b * leg.pattern.startIndex },
              p2: { i: leg.pattern.endIndex, price: leg.pattern.lowerLine.a + leg.pattern.lowerLine.b * leg.pattern.endIndex },
            } : null,
          } : null,
        },
        patternType: leg.patternType || null,
        bothSidePivotCross: true,
        stopPrice: res.stopPrice ?? stopPrice,
        slMode: cfg.slMode || 'swing',
        emaPivotDistATR: +(Math.abs((fast[i] + slow[i]) / 2 - Pi) / atr[i]).toFixed(2),
        outcome: res.outcome,
        mfeATR: +(res.mfe / atr[i]).toFixed(2),
        maeATR: +(res.mae / atr[i]).toFixed(2),
        bars: res.bars,
      });
      break;
    }
  }

  // Baseline: plain pivot touches without trendline-break (admin comparison)
  for (let i = cfg.slowPeriod + 1; i < n; i++) {
    const P = p[i];
    if (P == null || atr[i] == null) continue;
    const c = candles[i];
    if (!(c.low <= P && c.high >= P)) continue;
    if (out.some((e) => e.index === i && e.cross)) continue;
    let below = true, above = true;
    const ab = cfg.approachBars ?? 3;
    for (let k = 1; k <= ab; k++) {
      if (i - k < 0) { below = false; above = false; break; }
      const b = candles[i - k];
      if (p[i - k] !== P) { below = false; above = false; break; }
      if (!(b.high < P)) below = false;
      if (!(b.low > P)) above = false;
    }
    if (!below && !above) continue;
    const dir = below ? 'SHORT' : 'LONG';
    const stopPrice = computeStopPrice(dir, P, atr[i], null, { ...cfg, slMode: 'pivot' });
    const res = evaluateTouch(candles, i, dir, P, atr[i], cfg, stopPrice);
    out.push({
      index: i,
      time: c.time,
      dir,
      pivot: P,
      pivotKind: kind,
      atr: atr[i],
      cross: false,
      crossType: null,
      crossBarsAgo: null,
      crossPrice: null,
      crossDistATR: null,
      runATR: null,
      clean: false,
      stopPrice: res.stopPrice ?? stopPrice,
      slMode: 'pivot',
      outcome: res.outcome,
      mfeATR: +(res.mfe / atr[i]).toFixed(2),
      maeATR: +(res.mae / atr[i]).toFixed(2),
      bars: res.bars,
    });
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

/** Pure helper: tally outcomes. */
export function tally(list) {
  const t = { total: list.length, win: 0, loss: 0, timeout: 0, open: 0 };
  for (const e of list) {
    if (e.outcome === 'WIN') t.win++;
    else if (e.outcome === 'LOSS') t.loss++;
    else if (e.outcome === 'TIMEOUT') t.timeout++;
    else t.open++;
  }
  const decided = t.win + t.loss;
  t.winRate = decided ? +((t.win / decided) * 100).toFixed(1) : null;
  return t;
}

/** Backtest one coin on one TF: strategy events (list) + baseline tally. */
export function backtestPivotEma(candles, tf, cfg = PIVOT_EMA_FIXED) {
  const touches = findPivotTouches(candles, tf, cfg);
  const strategy = touches.filter((e) => e.cross);
  const baseline = touches.filter((e) => !e.cross);
  return { events: strategy, baselineTally: tally(baseline), totalTouches: touches.length };
}

/** Build the signal-shaped object the chart renderer understands (for a historical setup). */
export function buildPivotChartSignal(symbol, tf, candles, ev, cfg = PIVOT_EMA_FIXED) {
  const sign = ev.dir === 'LONG' ? 1 : -1;
  const { p } = computePivots(candles, tf);
  const segments = [];
  for (let i = 0; i < candles.length; i++) {
    if (p[i] == null) continue;
    const seg = segments[segments.length - 1];
    if (seg && seg.p === p[i]) seg.to = candles[i].time;
    else segments.push({ from: candles[i].time, to: candles[i].time, p: p[i] });
  }
  const swingExt = ev.trendline
    ? (ev.dir === 'LONG'
        ? Math.min(ev.trendline.p1?.price ?? Infinity, ev.trendline.p2?.price ?? Infinity)
        : Math.max(ev.trendline.p1?.price ?? 0, ev.trendline.p2?.price ?? 0))
    : null;
  const stopPrice = ev.stopPrice != null
    ? ev.stopPrice
    : computeStopPrice(ev.dir, ev.pivot, ev.atr, ev.crossPrice, cfg, Number.isFinite(swingExt) ? swingExt : null);
  // ENTRY must be the trendline break point — never the pivot
  const entry = (ev.entry != null && Number.isFinite(ev.entry))
    ? ev.entry
    : (ev.trendline?.breakPrice != null ? ev.trendline.breakPrice : ev.pivot);
  return {
    symbol,
    direction: ev.dir,
    dir: ev.dir,
    strategy: 'pivot_ema',
    status: 'PREVIEW',
    entry,
    sl: stopPrice,
    tp1: entry + sign * ev.atr * (cfg.targetATR ?? 1),
    atr: ev.atr,
    current_price: candles[candles.length - 1].close,
    metadata: {
      strategy: 'pivot_ema',
      patternTf: tf,
      pivotGeom: {
        kind: ev.pivotKind,
        segments,
        touchTime: ev.time,
        pivot: ev.pivot,
        crossPrice: ev.crossPrice ?? null,
        crossType: ev.crossType ?? null,
        stopPrice,
        slMode: cfg.slMode || ev.slMode || 'swing',
        trendline: ev.trendline || null,
        trendKind: ev.trendKind || null,
      },
      backtest: {
        outcome: ev.outcome,
        mfeATR: ev.mfeATR,
        maeATR: ev.maeATR,
        bars: ev.bars,
        crossType: ev.crossType,
        crossDistATR: ev.crossDistATR,
        runATR: ev.runATR,
        stopPrice,
        slMode: cfg.slMode || ev.slMode || 'swing',
        trendKind: ev.trendKind,
      },
    },
  };
}
