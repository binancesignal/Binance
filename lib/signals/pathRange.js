/**
 * Candle-path helpers for the signal monitor.
 *
 * Problem these solve: the monitor only used the high/low of the CURRENT forming 5m
 * candle. Anything that happened between two cron ticks (a wick to TP1, a wick to SL,
 * a wick through entry) was invisible, so
 *   - a READY signal could keep living after price had already tagged TP1 and later
 *     come back to the entry zone (it then looked like a fresh entry), and
 *   - an ONGOING trade could miss the TP1 touch that happened before SL.
 *
 * Here the monitor looks at EVERY candle since the signal was born (pre-entry) or since
 * the entry fill (ONGOING), in time order.
 */

const FIVE_MIN_MS = 5 * 60 * 1000;

function dirOf(signal) {
  return String(signal?.direction || signal?.dir || '').toUpperCase();
}

function candleEndsAfter(c, sinceMs, ivMs) {
  const open = +c?.time * 1000;
  if (!Number.isFinite(open)) return false;
  return open + ivMs > sinceMs;
}

/** Parse an ISO string / Date / ms into ms (NaN → null). */
export function toMs(value) {
  if (value == null || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * High/low over all candles that overlap [sinceMs, now].
 * @returns {{high:number, low:number, candles:number}|null}
 */
export function rangeSince(candles, sinceMs, ivMs = FIVE_MIN_MS) {
  if (!Array.isArray(candles) || !candles.length || sinceMs == null) return null;
  let high = -Infinity;
  let low = Infinity;
  let n = 0;
  for (const c of candles) {
    if (!c || !candleEndsAfter(c, sinceMs, ivMs)) continue;
    if (+c.high > high) high = +c.high;
    if (+c.low < low) low = +c.low;
    n++;
  }
  return n > 0 ? { high, low, candles: n } : null;
}

/**
 * Walk the candles in time order and report which targets were touched BEFORE the SL.
 * A TP touched in the same candle as the SL is counted as a TP (same rule as the
 * lifecycle: "TP first, then SL"); a TP that only appears after the SL candle is not.
 * @returns {{tp1:boolean,tp2:boolean,tp3:boolean,sl:boolean,tp1At:number|null,tp2At:number|null,tp3At:number|null,slAt:number|null,candles:number}}
 */
export function scanPathHits(signal, candles, sinceMs, ivMs = FIVE_MIN_MS) {
  const out = {
    tp1: false, tp2: false, tp3: false, sl: false,
    tp1At: null, tp2At: null, tp3At: null, slAt: null, candles: 0,
  };
  const dir = dirOf(signal);
  const tp1 = +signal?.tp1;
  const tp2 = +signal?.tp2;
  const tp3 = +signal?.tp3;
  const sl = +signal?.sl;
  if ((dir !== 'LONG' && dir !== 'SHORT') || sinceMs == null || !Array.isArray(candles)) return out;

  const sorted = [...candles].sort((a, b) => +a.time - +b.time);
  for (const c of sorted) {
    if (!c || !candleEndsAfter(c, sinceMs, ivMs)) continue;
    out.candles++;
    const hi = +c.high;
    const lo = +c.low;
    const t = +c.time;
    const reach = (level) => (dir === 'LONG' ? hi >= level : lo <= level);
    if (tp1 > 0 && !out.tp1 && reach(tp1)) { out.tp1 = true; out.tp1At = t; }
    if (tp2 > 0 && !out.tp2 && reach(tp2)) { out.tp2 = true; out.tp2At = t; }
    if (tp3 > 0 && !out.tp3 && reach(tp3)) { out.tp3 = true; out.tp3At = t; }
    const slTouched = sl > 0 && (dir === 'LONG' ? lo <= sl : hi >= sl);
    if (slTouched) {
      out.sl = true;
      out.slAt = t;
      break; // anything after the stop-out does not belong to this trade
    }
  }
  return out;
}

/**
 * Did price actually TRADE through the entry level? (range = high/low since the signal was born)
 * Needed because "candle closed beyond entry" is already true for a limit-style signal whose
 * price sits on the profit side (e.g. ICT SHORT with price below entry) — it would go ONGOING
 * without the entry ever being touched.
 */
export function rangeTouchesLevel(range, level, tol = 0) {
  const lv = +level;
  if (!range || !(lv > 0)) return false;
  return +range.low <= lv + tol && +range.high >= lv - tol;
}

/**
 * Open time (epoch SECONDS) of the first candle at/after `sinceMs` whose range traded through
 * `level` (± tol). Lets the lifecycle stamp entry_hit_at with the REAL fill candle instead of the
 * moment the monitor happened to notice it.
 * @returns {number|null}
 */
export function firstTouchTime(candles, level, sinceMs, ivMs = FIVE_MIN_MS, tol = 0) {
  const lv = +level;
  if (!Array.isArray(candles) || !(lv > 0) || sinceMs == null) return null;
  const sorted = [...candles].sort((a, b) => +a.time - +b.time);
  for (const c of sorted) {
    if (!c || !candleEndsAfter(c, sinceMs, ivMs)) continue;
    if (+c.low <= lv + tol && +c.high >= lv - tol) return +c.time;
  }
  return null;
}
