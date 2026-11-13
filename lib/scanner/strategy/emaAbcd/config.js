/**
 * EMA + AB=CD live signal strategy config.
 *
 * Stages:
 *   WATCHING — EMA cross (mode: triple / any_two / any_pair / off) + clear AB=CD (D swing confirmed)
 *   READY    — after D, price rejects from the D extreme and the rejection touches EMA20
 *   ONGOING  — same rejection move continues and touches EMA50 (after EMA20)
 *   INVALID  — before EMA20 touch:
 *                • any two EMA pairs cross again, OR
 *                • a close beyond D extreme (new high after bearish D / new low after bullish D)
 */

export const ALL_TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];

export const EMA_ABCD_DEFAULTS = {
  enabled: true,
  timeframes: ['15m', '1h'],
  lookback: 300,

  // EMAs
  fast: 20,
  mid: 50,
  slow: 200,

  // Swing / AB=CD geometry
  swingLeft: 3,
  swingRight: 3,
  minLegATR: 0.35, // each of AB, BC, CD must be at least this many ATR
  maxPatternBars: 80, // A→D span
  minPatternBars: 8,
  // BC retrace of AB
  bcMin: 0.35,
  bcMax: 0.92,
  // CD / AB variants (classic + extensions)
  variants: [
    { key: 'AB=CD', label: 'AB=CD', target: 1.0, min: 0.88, max: 1.15 },
    { key: '1.272AB=CD', label: '1.272 AB=CD', target: 1.272, min: 1.18, max: 1.38 },
    { key: '1.414AB=CD', label: '1.414 AB=CD', target: 1.414, min: 1.32, max: 1.52 },
    { key: '1.618AB=CD', label: '1.618 AB=CD', target: 1.618, min: 1.50, max: 1.75 },
    { key: '0.786AB=CD', label: '0.786 AB=CD', target: 0.786, min: 0.70, max: 0.88 },
    { key: '0.618AB=CD', label: '0.618 AB=CD', target: 0.618, min: 0.55, max: 0.70 },
  ],
  // D must be a clear extreme: at least this many bars confirmed (right side of swing)
  dConfirmBars: 2,
  // How recent D may be for a live setup
  maxDAgeBars: 40,

  // EMA cross near D for WATCHING
  //   'triple'   — 20 must cross both 50 and 200 same direction (strict)
  //   'any_two'  — any 2 of the 3 pairs (20/50, 20/200, 50/200) same direction
  //   'any_pair' — any 1 pair is enough (20/50 OR 20/200 OR 50/200)
  //   'off'      — no EMA cross required (AB=CD structure only)
  crossWindowBars: 24,
  emaCrossMode: 'any_pair',
  // legacy bool — if set true forces mode 'triple'; if false leaves emaCrossMode as-is
  requireTripleCross: false,

  // READY: rejection from D that touches EMA20
  touchTolATR: 0.12,
  // Rejection must move at least this many ATR from D toward the trade
  minRejectATR: 0.15,
  // Max bars from D to first EMA20 touch
  maxRejectBars: 25,
  // When same rejection move also touches EMA50 → status becomes ONGOING
  trackEma50Touch: true,

  // INVALID rules (before EMA20 touch only)
  invalidateOnEmaCross: true, // ≥2 EMA pairs re-cross after D → invalid
  invalidateOnNewExtreme: true, // close beyond D extreme → invalid

  // Levels / risk once READY
  entryBufferATR: 0.05,
  slBufferATR: 0.2,
  minStopATR: 0.4,
  maxStopATR: 4.0,
  tp1R: 1.2,
  tp2R: 2.0,
  tp3R: 3.0,
  minRR: 1.0,
  maxEntryDistanceATR: 4.0,
  minScore: 55,

  allowLong: true,
  allowShort: true,
};

export function normalizeEmaAbcdConfig(raw = {}) {
  const d = EMA_ABCD_DEFAULTS;
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
    lookback: int(raw.lookback, d.lookback, 120, 1000),
    fast: d.fast,
    mid: d.mid,
    slow: d.slow,
    swingLeft: int(raw.swingLeft, d.swingLeft, 2, 8),
    swingRight: int(raw.swingRight, d.swingRight, 2, 8),
    minLegATR: num(raw.minLegATR, d.minLegATR, 0.1, 3),
    maxPatternBars: int(raw.maxPatternBars, d.maxPatternBars, 20, 200),
    minPatternBars: int(raw.minPatternBars, d.minPatternBars, 4, 40),
    bcMin: num(raw.bcMin, d.bcMin, 0.2, 0.8),
    bcMax: num(raw.bcMax, d.bcMax, 0.5, 1.0),
    dConfirmBars: int(raw.dConfirmBars, d.dConfirmBars, 1, 8),
    maxDAgeBars: int(raw.maxDAgeBars, d.maxDAgeBars, 5, 120),
    crossWindowBars: int(raw.crossWindowBars, d.crossWindowBars, 3, 80),
    requireTripleCross: bool(raw.requireTripleCross, d.requireTripleCross),
    emaCrossMode: (() => {
      const allowed = ['triple', 'any_two', 'any_pair', 'off'];
      const fromRaw = typeof raw.emaCrossMode === 'string' ? raw.emaCrossMode.toLowerCase() : null;
      if (fromRaw && allowed.includes(fromRaw)) return fromRaw;
      // legacy: requireTripleCross true → force triple
      if (raw.requireTripleCross === true || raw.requireTripleCross === 'true' || raw.requireTripleCross === 1) {
        return 'triple';
      }
      return d.emaCrossMode;
    })(),
    touchTolATR: num(raw.touchTolATR, d.touchTolATR, 0.02, 0.5),
    minRejectATR: num(raw.minRejectATR, d.minRejectATR, 0.05, 2),
    maxRejectBars: int(raw.maxRejectBars, d.maxRejectBars, 3, 80),
    trackEma50Touch: bool(raw.trackEma50Touch, d.trackEma50Touch),
    invalidateOnEmaCross: bool(raw.invalidateOnEmaCross, d.invalidateOnEmaCross),
    invalidateOnNewExtreme: bool(raw.invalidateOnNewExtreme, d.invalidateOnNewExtreme),
    entryBufferATR: num(raw.entryBufferATR, d.entryBufferATR, 0, 0.5),
    slBufferATR: num(raw.slBufferATR, d.slBufferATR, 0, 1),
    minStopATR: num(raw.minStopATR, d.minStopATR, 0.2, 2),
    maxStopATR: num(raw.maxStopATR, d.maxStopATR, 1, 10),
    tp1R: num(raw.tp1R, d.tp1R, 0.5, 5),
    tp2R: num(raw.tp2R, d.tp2R, 1, 8),
    tp3R: num(raw.tp3R, d.tp3R, 1.5, 12),
    minRR: num(raw.minRR, d.minRR, 0.5, 5),
    maxEntryDistanceATR: num(raw.maxEntryDistanceATR, d.maxEntryDistanceATR, 1, 15),
    minScore: int(raw.minScore, d.minScore, 30, 95),
    allowLong: bool(raw.allowLong, d.allowLong),
    allowShort: bool(raw.allowShort, d.allowShort),
    variants: Array.isArray(raw.variants) && raw.variants.length ? raw.variants : d.variants,
  };
}
