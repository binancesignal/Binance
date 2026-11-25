/**
 * SP Breaker + AB=CD strategy (admin-toggle next to Harmonic).
 *
 * SP Breaker = order-block / breaker whose source starts in AB or BC wave,
 * and candle C (wick or body) touches then leaves it. Breakers born after C are ignored.
 *
 * Trend (EMA200):
 *   Pattern body below EMA200 → DOWN trend
 *   Pattern body above EMA200 → UP trend
 *   If pattern is on the "wrong" side and touches EMA200 → reject
 *
 * Counter-trend AB=CD in a DOWN market (HH+HL style legs up, then D drops into C zone
 * and turns up again): entry above SP breaker top; SL slightly below breaker bottom.
 * Mirror for UP trend.
 */

export const SP_ABCD_DEFAULTS = {
  enabled: false,
  timeframes: ['15m', '1h', '4h'],
  lookback: 400,
  swingLeft: 3,
  swingRight: 3,
  minLegATR: 0.3,
  maxPatternBars: 100,
  minPatternBars: 8,
  bcMin: 0.35,
  bcMax: 0.92,
  cdAbMin: 0.85,
  cdAbMax: 1.2,
  /** Prefer classic equality */
  cdAbTarget: 1.0,
  emaPeriod: 200,
  /** SL buffer below/above SP breaker outer edge, in ATR multiples (admin). */
  slBufferATR: 0.15,
  /** Extra buffer in price % of breaker height (admin). */
  slBufferPctOfHeight: 0.05,
  /** Near-entry % for ENTRY_READY (falls back to auto-trade proximity if set). */
  readyProximityPercent: 2,
  watchingProximityPercent: 4,
  minScore: 55,
  maxDAgeBars: 60,
  /** Max age of SP breaker source relative to C (bars). */
  maxBreakerAgeBars: 80,
};

export function normalizeSpAbcdConfig(raw = {}) {
  const d = SP_ABCD_DEFAULTS;
  const num = (v, fb, lo, hi) => {
    const n = +v;
    if (!Number.isFinite(n)) return fb;
    return Math.min(hi, Math.max(lo, n));
  };
  const tfs = Array.isArray(raw.timeframes)
    ? raw.timeframes.map(String)
    : Array.isArray(raw.tfs)
      ? raw.tfs.map(String)
      : d.timeframes;
  return {
    enabled: raw.enabled === true || raw.enableSpAbcd === true,
    timeframes: tfs.length ? tfs : d.timeframes,
    lookback: Math.round(num(raw.lookback, d.lookback, 100, 1000)),
    swingLeft: Math.round(num(raw.swingLeft, d.swingLeft, 1, 10)),
    swingRight: Math.round(num(raw.swingRight, d.swingRight, 1, 10)),
    minLegATR: num(raw.minLegATR, d.minLegATR, 0.05, 5),
    maxPatternBars: Math.round(num(raw.maxPatternBars, d.maxPatternBars, 20, 300)),
    minPatternBars: Math.round(num(raw.minPatternBars, d.minPatternBars, 4, 80)),
    bcMin: num(raw.bcMin, d.bcMin, 0.1, 1),
    bcMax: num(raw.bcMax, d.bcMax, 0.2, 1.5),
    cdAbMin: num(raw.cdAbMin, d.cdAbMin, 0.5, 2),
    cdAbMax: num(raw.cdAbMax, d.cdAbMax, 0.6, 3),
    cdAbTarget: num(raw.cdAbTarget, d.cdAbTarget, 0.5, 2),
    emaPeriod: Math.round(num(raw.emaPeriod, d.emaPeriod, 50, 400)),
    slBufferATR: num(raw.slBufferATR, d.slBufferATR, 0, 2),
    slBufferPctOfHeight: num(raw.slBufferPctOfHeight, d.slBufferPctOfHeight, 0, 1),
    readyProximityPercent: num(raw.readyProximityPercent, d.readyProximityPercent, 0.1, 20),
    watchingProximityPercent: num(
      raw.watchingProximityPercent,
      d.watchingProximityPercent,
      0.2,
      50
    ),
    minScore: Math.round(num(raw.minScore, d.minScore, 0, 100)),
    maxDAgeBars: Math.round(num(raw.maxDAgeBars, d.maxDAgeBars, 5, 200)),
    maxBreakerAgeBars: Math.round(num(raw.maxBreakerAgeBars, d.maxBreakerAgeBars, 10, 200)),
  };
}
