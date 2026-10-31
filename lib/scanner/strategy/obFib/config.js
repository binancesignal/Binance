/**
 * OB + HTF Fib strategy (ob_fib)
 *
 * 1. Take the LAST CLOSED reference candle (never the ongoing one) for each
 *    selected HTF: Daily / Weekly / Monthly / 3-Month / Yearly.
 *      bullish candle → Fib from its LOW up to its HIGH
 *      bearish candle → Fib from its HIGH down to its LOW
 *    (admin can force the direction instead of following the candle colour)
 * 2. On each selected lower time frame (15m / 30m / 1h / 2h ...) detect the
 *    LuxAlgo "Order Block Detector" zones.
 * 3. If one of the ADMIN-SELECTED fib lines passes through an order block zone
 *    → signal.  Bearish OB = SELL (SHORT) · Bullish OB = BUY (LONG).
 *    No fib line inside the zone → no signal.
 *
 * Each HTF is processed independently: for every ref TF we draw its own Fib
 * and scan all LTFs against it, so signals are reported per (HTF × LTF) pair.
 */

export const OB_FIB_REF_TFS = ['1d', '1w', '1M', '3M', '1Y']; // reference candle timeframes
export const OB_FIB_TFS = ['5m', '15m', '30m', '1h', '2h', '4h'];

// Retracement levels (0 = end of the HTF move, 1 = start) + a few extensions.
export const OB_FIB_LEVELS = [
  -0.618, -0.272, 0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 0.886, 1, 1.272, 1.618,
];

export const OB_FIB_DEFAULTS = {
  enabled: true,
  timeframes: ['15m', '30m', '1h', '2h'],
  lookback: 300,

  // HTF fib reference
  refTimeframes: ['1w', '1M'], // each on/off: '1d' | '1w' | '1M' | '3M' | '1Y'
  refCandleBack: 1, // 1 = previous CLOSED candle (never the forming one), 2 = the one before ...
  weeklyDirection: 'auto', // 'auto' (candle colour) | 'bullish' | 'bearish'
  fibLevels: [0.382, 0.5, 0.618, 0.786], // only these lines are targeted

  // LuxAlgo order- detector
  obLength: 5, // Volume Pivot Length
  bullExtLast: 3,
  bearExtLast: 3,
  mitigation: 'Wick', // 'Wick' | 'Close'
  onlyFresh: false, // true = skip OBs price already tested

  // validity filters
  requireExtremeOb: true, // OB candle must sit at a swing high (bearish) / swing low (bullish) — not mid-leg / running candle
  extremeWindow: 8, // bars checked on each side of the OB candle
  extremeTolATR: 0.3, // how close to the top/bottom still counts
  singleFibOnly: true, // more than one selected fib line inside the same OB = invalid
  maxObWidthATR: 2.5, // skip wide OBs (zone height > this many ATR). 0 = off
  requireUntouchedEntry: true, // skip if price already touched the entry level after the OB formed
  requireApproachSide: true, // BUY only when price is ABOVE entry, SELL only when price is BELOW entry

  // fib ↔ OB match
  fibMatchMode: 'inside', // 'inside' = anywhere in the zone · 'middle' = near the zone's middle line
  middleBandPct: 50, // 'middle' mode: central % of the zone height that counts
  fibTolATR: 0, // tolerance outside the zone, in ATR
  fibTolPct: 0, // tolerance outside the zone, in % of price (tick-size safety)
  chartEnabled: true, // draw/send chart for valid signals

  // trade levels
  entryMode: 'mid', // 'mid' = OB middle (entry from OB) · 'fib' = matched fib price
  slBufferATR: 0.2,
  minStopATR: 0.3,
  maxStopATR: 5,
  tp1R: 1,
  tp2R: 2,
  tp3R: 3,
  minRR: 0.8,
  maxEntryDistanceATR: 10,
  minScore: 50,

  allowLong: true,
  allowShort: true,
};

export function normalizeObFibConfig(raw = {}) {
  const d = OB_FIB_DEFAULTS;
  raw = raw && typeof raw === 'object' ? raw : {};
  const int = (v, def, lo, hi) => {
    const n = Math.round(+v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const num = (v, def, lo, hi) => {
    const n = +v;
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const bool = (v, def) =>
    v === true || v === 'true' || v === 1 || v === '1'
      ? true
      : v === false || v === 'false' || v === 0 || v === '0'
        ? false
        : def;

  const tfs = Array.isArray(raw.timeframes)
    ? [...new Set(raw.timeframes.filter((t) => OB_FIB_TFS.includes(t)))]
    : d.timeframes;
  const levels = Array.isArray(raw.fibLevels)
    ? [...new Set(raw.fibLevels.map((x) => +(+x).toFixed(4)).filter((x) => Number.isFinite(x) && x >= -5 && x <= 10))].sort((a, b) => a - b)
    : d.fibLevels;

  const out = {
    enabled: bool(raw.enabled, d.enabled),
    timeframes: tfs.length ? tfs : d.timeframes,
    lookback: int(raw.lookback, d.lookback, 120, 1000),
    refTimeframes: Array.isArray(raw.refTimeframes)
      ? [...new Set(raw.refTimeframes.filter((t) => OB_FIB_REF_TFS.includes(t)))]
      : ['1w'],
    requireExtremeOb: bool(raw.requireExtremeOb, d.requireExtremeOb),
    extremeWindow: int(raw.extremeWindow, d.extremeWindow, 2, 30),
    extremeTolATR: num(raw.extremeTolATR, d.extremeTolATR, 0, 3),
    refCandleBack: int(raw.refCandleBack, d.refCandleBack, 1, 4),
    weeklyDirection: ['auto', 'bullish', 'bearish'].includes(raw.weeklyDirection) ? raw.weeklyDirection : d.weeklyDirection,
    fibLevels: levels.length ? levels : d.fibLevels,
    obLength: int(raw.obLength, d.obLength, 1, 30),
    bullExtLast: int(raw.bullExtLast, d.bullExtLast, 1, 10),
    bearExtLast: int(raw.bearExtLast, d.bearExtLast, 1, 10),
    mitigation: raw.mitigation === 'Close' ? 'Close' : 'Wick',
    onlyFresh: bool(raw.onlyFresh, d.onlyFresh),
    singleFibOnly: bool(raw.singleFibOnly, d.singleFibOnly),
    maxObWidthATR: num(raw.maxObWidthATR, d.maxObWidthATR, 0, 30),
    requireUntouchedEntry: bool(raw.requireUntouchedEntry, d.requireUntouchedEntry),
    requireApproachSide: bool(raw.requireApproachSide, d.requireApproachSide),
    fibMatchMode: raw.fibMatchMode === 'middle' ? 'middle' : 'inside',
    middleBandPct: num(raw.middleBandPct, d.middleBandPct, 5, 100),
    fibTolATR: num(raw.fibTolATR, d.fibTolATR, 0, 2),
    fibTolPct: num(raw.fibTolPct, d.fibTolPct, 0, 2),
    chartEnabled: bool(raw.chartEnabled, d.chartEnabled),
    entryMode: raw.entryMode === 'mid' ? 'mid' : 'fib',
    slBufferATR: num(raw.slBufferATR, d.slBufferATR, 0, 3),
    minStopATR: num(raw.minStopATR, d.minStopATR, 0.05, 5),
    maxStopATR: num(raw.maxStopATR, d.maxStopATR, 0.5, 30),
    tp1R: num(raw.tp1R, d.tp1R, 0.3, 10),
    tp2R: num(raw.tp2R, d.tp2R, 0.5, 15),
    tp3R: num(raw.tp3R, d.tp3R, 0.8, 25),
    minRR: num(raw.minRR, d.minRR, 0.3, 10),
    maxEntryDistanceATR: num(raw.maxEntryDistanceATR, d.maxEntryDistanceATR, 0.5, 60),
    minScore: int(raw.minScore, d.minScore, 0, 100),
    allowLong: bool(raw.allowLong, d.allowLong),
    allowShort: bool(raw.allowShort, d.allowShort),
  };
  if (!out.refTimeframes.length) out.refTimeframes = ['1w'];
  return out;
}
