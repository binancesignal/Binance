/**
 * Pure AB=CD live strategy (no EMA).
 *
 * Stages:
 *   WATCHING — A/B/C formed, D not yet complete (projected D zone)
 *   READY    — D swing just completed classic AB=CD equality
 *   ONGOING  — D complete and at least one candle after D confirmation
 */

export const ALL_TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];

export const ABCD_DEFAULTS = {
  enabled: true,
  timeframes: ['15m', '1h'],
  lookback: 300,

  swingLeft: 3,
  swingRight: 3,
  minLegATR: 0.25,
  minPatternBars: 6,
  maxPatternBars: 100,

  // BC retrace of AB
  bcMin: 0.30,
  bcMax: 0.95,

  // CD / AB equality only (classic AB=CD)
  cdAbMin: 0.88,
  cdAbMax: 1.15,
  cdAbTarget: 1.0,

  // How many bars to the right of swing to confirm C / D
  swingConfirmBars: 2,
  // Max age of C for incomplete (WATCHING) setups
  maxCAgeBars: 30,
  // Max age of D for completed setups still shown
  maxDAgeBars: 40,

  // READY while D age (bars after confirm) is within this; then ONGOING
  readyMaxAgeBars: 0, // D just confirmed → READY; next bar → ONGOING

  // Projected D zone width for WATCHING (ATR)
  projectZoneATR: 0.25,

  entryBufferATR: 0.05,
  slBufferATR: 0.2,
  minStopATR: 0.35,
  maxStopATR: 4.0,
  tp1R: 1.0,
  tp2R: 1.5,
  tp3R: 2.5,
  minRR: 0.8,
  maxEntryDistanceATR: 5.0,
  minScore: 45,

  allowLong: true,
  allowShort: true,
};

export function normalizeAbcdConfig(raw = {}) {
  const d = ABCD_DEFAULTS;
  const int = (v, def, lo, hi) => {
    const n = Math.round(+v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const num = (v, def, lo, hi) => {
    const n = +v;
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const bool = (v, def) =>
    v === true || v === false
      ? v
      : v === 'true' || v === 1 || v === '1'
        ? true
        : v === 'false' || v === 0 || v === '0'
          ? false
          : def;
  const tfs = Array.isArray(raw.timeframes)
    ? [...new Set(raw.timeframes.filter((t) => ALL_TFS.includes(t)))]
    : d.timeframes;
  return {
    ...d,
    enabled: bool(raw.enabled, d.enabled),
    timeframes: tfs.length ? tfs : d.timeframes,
    lookback: int(raw.lookback, d.lookback, 80, 1000),
    swingLeft: int(raw.swingLeft, d.swingLeft, 2, 8),
    swingRight: int(raw.swingRight, d.swingRight, 2, 8),
    minLegATR: num(raw.minLegATR, d.minLegATR, 0.1, 3),
    minPatternBars: int(raw.minPatternBars, d.minPatternBars, 4, 40),
    maxPatternBars: int(raw.maxPatternBars, d.maxPatternBars, 20, 250),
    bcMin: num(raw.bcMin, d.bcMin, 0.15, 0.9),
    bcMax: num(raw.bcMax, d.bcMax, 0.5, 1.0),
    cdAbMin: num(raw.cdAbMin, d.cdAbMin, 0.7, 1.0),
    cdAbMax: num(raw.cdAbMax, d.cdAbMax, 1.0, 1.4),
    cdAbTarget: num(raw.cdAbTarget, d.cdAbTarget, 0.9, 1.2),
    swingConfirmBars: int(raw.swingConfirmBars, d.swingConfirmBars, 1, 6),
    maxCAgeBars: int(raw.maxCAgeBars, d.maxCAgeBars, 5, 120),
    maxDAgeBars: int(raw.maxDAgeBars, d.maxDAgeBars, 5, 120),
    readyMaxAgeBars: int(raw.readyMaxAgeBars, d.readyMaxAgeBars, 0, 5),
    projectZoneATR: num(raw.projectZoneATR, d.projectZoneATR, 0.05, 1),
    entryBufferATR: num(raw.entryBufferATR, d.entryBufferATR, 0, 0.5),
    slBufferATR: num(raw.slBufferATR, d.slBufferATR, 0, 1),
    minStopATR: num(raw.minStopATR, d.minStopATR, 0.15, 2),
    maxStopATR: num(raw.maxStopATR, d.maxStopATR, 1, 10),
    tp1R: num(raw.tp1R, d.tp1R, 0.5, 5),
    tp2R: num(raw.tp2R, d.tp2R, 0.8, 8),
    tp3R: num(raw.tp3R, d.tp3R, 1, 12),
    minRR: num(raw.minRR, d.minRR, 0.4, 5),
    maxEntryDistanceATR: num(raw.maxEntryDistanceATR, d.maxEntryDistanceATR, 1, 20),
    minScore: int(raw.minScore, d.minScore, 25, 95),
    allowLong: bool(raw.allowLong, d.allowLong),
    allowShort: bool(raw.allowShort, d.allowShort),
  };
}
