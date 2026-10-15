/**
 * Pre-entry candle quality filter.
 *
 * Skips setups whose market just before the entry looks "weird":
 *   - too wicky   → long wicks, tiny bodies (stop-hunt / chop, SL gets tagged)
 *   - too small   → tiny candles, no movement (dead / illiquid market)
 *   - too many dojis / flat candles
 *
 * Pure function — no I/O. Uses the last `lookback` CLOSED candles.
 */

export const CANDLE_QUALITY_DEFAULTS = {
  enabled: true,
  /** how many candles before now to inspect */
  lookback: 20,
  /** need at least this many candles, otherwise the check is skipped (fail-open) */
  minCandles: 10,
  /** average (wick / range) above this → too wicky */
  maxAvgWickRatio: 0.65,
  /** share of candles whose body < dojiBodyRatio of range above this → too many dojis */
  dojiBodyRatio: 0.2,
  maxDojiShare: 0.5,
  /** average candle range (% of price) below this → candles too small */
  minAvgRangePct: 0.15,
  /** share of candles with zero range (flat) above this → illiquid */
  maxFlatShare: 0.2,
  /** average body (% of price) below this → candles too small */
  minAvgBodyPct: 0.05,
};

const pct = (n) => +n.toFixed(3);

/**
 * @param {Array<{open:number,high:number,low:number,close:number}>} candles
 * @returns {{ ok: boolean, reason?: string, code?: string, metrics?: object }}
 */
export function assessCandleQuality(candles, opts = {}) {
  const cfg = { ...CANDLE_QUALITY_DEFAULTS, ...opts };
  if (!cfg.enabled) return { ok: true, reason: 'candle quality check disabled' };
  const recent = (candles || [])
    .filter((c) => c && [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(+v)))
    .slice(-cfg.lookback);
  if (recent.length < cfg.minCandles) {
    return { ok: true, reason: 'not enough candles — skipped' };
  }

  let wickSum = 0;
  let wickN = 0;
  let rangePctSum = 0;
  let bodyPctSum = 0;
  let doji = 0;
  let flat = 0;
  for (const c of recent) {
    const hi = +c.high;
    const lo = +c.low;
    const op = +c.open;
    const cl = +c.close;
    const range = hi - lo;
    const body = Math.abs(cl - op);
    const ref = Math.abs(cl) || 1;
    rangePctSum += (range / ref) * 100;
    bodyPctSum += (body / ref) * 100;
    if (!(range > 0)) {
      flat++;
      doji++;
      continue;
    }
    wickSum += (range - body) / range;
    wickN++;
    if (body / range < cfg.dojiBodyRatio) doji++;
  }
  const n = recent.length;
  const metrics = {
    candles: n,
    avgWickRatio: wickN ? pct(wickSum / wickN) : 1,
    avgRangePct: pct(rangePctSum / n),
    avgBodyPct: pct(bodyPctSum / n),
    dojiShare: pct(doji / n),
    flatShare: pct(flat / n),
  };

  const fail = (code, reason) => ({ ok: false, code, reason, metrics });
  if (metrics.flatShare > cfg.maxFlatShare) {
    return fail('FLAT', `Flat/illiquid candles before entry (${Math.round(metrics.flatShare * 100)}% flat)`);
  }
  if (metrics.avgWickRatio > cfg.maxAvgWickRatio) {
    return fail(
      'WICKY',
      `Wicks too long before entry (avg wick ${Math.round(metrics.avgWickRatio * 100)}% > ${Math.round(cfg.maxAvgWickRatio * 100)}%)`
    );
  }
  if (metrics.dojiShare > cfg.maxDojiShare) {
    return fail('DOJI', `Too many doji candles before entry (${Math.round(metrics.dojiShare * 100)}%)`);
  }
  if (metrics.avgRangePct < cfg.minAvgRangePct || metrics.avgBodyPct < cfg.minAvgBodyPct) {
    return fail(
      'SMALL',
      `Candles too small before entry (avg range ${metrics.avgRangePct}%, body ${metrics.avgBodyPct}%)`
    );
  }
  return { ok: true, metrics };
}
