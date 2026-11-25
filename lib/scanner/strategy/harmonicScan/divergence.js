/**
 * Harmonic helpers (pure, no server imports):
 *   1. X at the extreme of the leg before the pattern
 *        bearish (SHORT) pattern → X must be the TOP of an up-leg
 *        bullish (LONG)  pattern → X must be the BOTTOM of a down-leg
 *      Only history BEFORE X is looked at, so D beyond X (Crab, Deep Crab …) never matters.
 *   2. RSI divergence between X and D (regular / hidden), evaluated when the signal becomes ENTRY READY.
 */

/** Wilder RSI over closes. Returns an array aligned with `candles` (null until enough data). */
export function rsiSeries(candles, period = 14) {
  const n = candles?.length || 0;
  const out = new Array(n).fill(null);
  if (n <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = candles[i].close - candles[i - 1].close;
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  const calc = () => (avgL === 0 ? (avgG === 0 ? 50 : 100) : 100 - 100 / (1 + avgG / avgL));
  out[period] = calc();
  for (let i = period + 1; i < n; i++) {
    const ch = candles[i].close - candles[i - 1].close;
    avgG = (avgG * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgL = (avgL * (period - 1) + (ch < 0 ? -ch : 0)) / period;
    out[i] = calc();
  }
  return out;
}

// ───────────────────────── X must be the extreme of the leg ─────────────────────────

export const LEG_DEFAULTS = Object.freeze({ legLookbackBars: 40, legMinAtr: 3 });

function atrAt(candles, endIdx, period = 14) {
  const from = Math.max(1, endIdx - period + 1);
  let sum = 0;
  let cnt = 0;
  for (let i = from; i <= endIdx; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

/**
 * @param candles  oldest → newest
 * @param X        { i, price }  swing point (high for SHORT, low for LONG)
 * @param direction 'SHORT' | 'LONG'
 * @returns { ok, legSizeAtr, startI, startPrice, reason }
 */
export function xIsLegExtreme(candles, X, direction, opts = {}) {
  const lookback = Math.max(5, Math.round(opts.legLookbackBars ?? LEG_DEFAULTS.legLookbackBars));
  const minAtr = Math.max(0.1, +(opts.legMinAtr ?? LEG_DEFAULTS.legMinAtr));
  if (!candles?.length || !X || X.i == null || X.i < 3) return { ok: false, reason: 'not enough history before X' };
  const start = Math.max(0, X.i - lookback);
  const atr = opts.atr > 0 ? opts.atr : atrAt(candles, X.i);
  if (!(atr > 0)) return { ok: false, reason: 'no ATR' };

  if (direction === 'SHORT') {
    // X is a swing HIGH → must be the highest high of the window (top of the up-leg)
    let maxHigh = -Infinity;
    let lowV = Infinity;
    let lowI = start;
    for (let i = start; i <= X.i; i++) {
      if (candles[i].high > maxHigh) maxHigh = candles[i].high;
      if (candles[i].low < lowV) {
        lowV = candles[i].low;
        lowI = i;
      }
    }
    if (X.price < maxHigh - 1e-12) return { ok: false, reason: 'a higher high exists before X' };
    if (lowI >= X.i) return { ok: false, reason: 'no up-leg before X' };
    const size = (X.price - lowV) / atr;
    return { ok: size >= minAtr, legSizeAtr: +size.toFixed(2), startI: lowI, startPrice: lowV, reason: size >= minAtr ? null : 'up-leg too small' };
  }
  // LONG: X is a swing LOW → must be the lowest low of the window (bottom of the down-leg)
  let minLow = Infinity;
  let highV = -Infinity;
  let highI = start;
  for (let i = start; i <= X.i; i++) {
    if (candles[i].low < minLow) minLow = candles[i].low;
    if (candles[i].high > highV) {
      highV = candles[i].high;
      highI = i;
    }
  }
  if (X.price > minLow + 1e-12) return { ok: false, reason: 'a lower low exists before X' };
  if (highI >= X.i) return { ok: false, reason: 'no down-leg before X' };
  const size = (highV - X.price) / atr;
  return { ok: size >= minAtr, legSizeAtr: +size.toFixed(2), startI: highI, startPrice: highV, reason: size >= minAtr ? null : 'down-leg too small' };
}

// ───────────────────────────── RSI divergence X ↔ D ─────────────────────────────

export const DIV_LABEL = {
  REGULAR_BEARISH: 'Regular bearish divergence',
  HIDDEN_BEARISH: 'Hidden bearish divergence',
  REGULAR_BULLISH: 'Regular bullish divergence',
  HIDDEN_BULLISH: 'Hidden bullish divergence',
};

/** Statuses at which the divergence is judged (near / at D). Once judged it is frozen on the signal. */
export function divergenceStatusOk(status) {
  const st = String(status || '').toUpperCase();
  return st === 'ENTRY_READY' || st === 'IN_TRADE' || st === 'FORMED' || st.startsWith('TP');
}

/**
 * Compare X with D (RSI vs price) using the divergence cheat-sheet:
 *   regular bullish : price lower low   + RSI higher low
 *   hidden  bullish : price higher low  + RSI lower  low
 *   regular bearish : price higher high + RSI lower  high
 *   hidden  bearish : price lower high  + RSI higher high
 *
 * D = the real D swing for a completed pattern; otherwise the extreme bar after C up to `untilIndex`
 * (the developing D that price is sitting at when the signal is entry-ready).
 */
export function detectXDDivergence(candles, ev, opts = {}) {
  const period = opts.rsiPeriod || 14;
  const minRsiDiff = opts.minRsiDiff ?? 1;
  const priceTol = opts.priceTolPct ?? 0.0004; // 0.04 % → "equal" highs/lows are not a divergence
  if (!candles?.length || !ev?.X || ev.X.i == null || !ev.C || ev.C.i == null) return null;
  const last = candles.length - 1;
  const bearish = ev.direction === 'SHORT';
  const until = Math.min(last, opts.untilIndex ?? last);

  let dI = null;
  let dPrice = null;
  if (ev.D?.i != null && ev.D.i <= last) {
    dI = ev.D.i;
    dPrice = ev.D.price;
  } else {
    if (until <= ev.C.i) return { found: false, none: true, reason: 'D not reached yet', evaluatedAt: Math.floor(Date.now() / 1000) };
    for (let i = ev.C.i + 1; i <= until; i++) {
      const v = bearish ? candles[i].high : candles[i].low;
      if (dI == null || (bearish ? v > dPrice : v < dPrice)) {
        dI = i;
        dPrice = v;
      }
    }
  }
  if (dI == null || dI <= ev.X.i) return null;

  const rsi = rsiSeries(candles, period);
  const xRsi = rsi[ev.X.i];
  const dRsi = rsi[dI];
  const base = {
    xI: ev.X.i,
    dI,
    xTime: candles[ev.X.i]?.time ?? ev.X.time ?? null,
    dTime: candles[dI]?.time ?? null,
    xPrice: ev.X.price,
    dPrice,
    xRsi: xRsi == null ? null : +xRsi.toFixed(2),
    dRsi: dRsi == null ? null : +dRsi.toFixed(2),
    bias: bearish ? 'BEARISH' : 'BULLISH',
    evaluatedAt: Math.floor(Date.now() / 1000),
  };
  if (xRsi == null || dRsi == null) return { ...base, found: false, none: true, reason: 'RSI not ready' };

  const higher = dPrice > ev.X.price * (1 + priceTol);
  const lower = dPrice < ev.X.price * (1 - priceTol);
  const rsiLower = dRsi < xRsi - minRsiDiff;
  const rsiHigher = dRsi > xRsi + minRsiDiff;

  let type = null;
  if (bearish) {
    if (higher && rsiLower) type = 'REGULAR_BEARISH';
    else if (lower && rsiHigher) type = 'HIDDEN_BEARISH';
  } else if (lower && rsiHigher) type = 'REGULAR_BULLISH';
  else if (higher && rsiLower) type = 'HIDDEN_BULLISH';

  if (!type) return { ...base, found: false, none: true };
  return { ...base, found: true, type, kind: type.startsWith('REGULAR') ? 'REGULAR' : 'HIDDEN', label: DIV_LABEL[type] };
}

/**
 * Keep an already-judged divergence (frozen); otherwise judge it now if the status qualifies.
 * Returns the divergence object to store on the signal, or `prev`/undefined when nothing to say yet.
 */
export function resolveDivergence(candles, ev, prev, opts = {}) {
  if (prev && prev.evaluatedAt) return prev;
  if (!divergenceStatusOk(ev.status)) return prev || undefined;
  const d = detectXDDivergence(candles, ev, opts);
  return d || prev || undefined;
}
