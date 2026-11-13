/**
 * ICT / SMC PROBABILITY-BASED POI — configuration (independent strategy, paper / analysis only).
 * Every value is validated and clamped; unknown keys are dropped. Stored in app_state under POI_CONFIG_KEY.
 */
export const POI_STRATEGY = 'poi_smc';
export const POI_STRATEGY_NAME = 'ICT / SMC PROBABILITY-BASED POI';
export const POI_CONFIG_KEY = 'poi_system_config';

export const POI_TF_SEC = { '1d': 86400, '4h': 14400, '1h': 3600, '30m': 1800, '15m': 900 };
/** analysis structure: higher TF → intermediate TF → entry confirmation TF */
export const POI_TFS = { htf: ['1d', '4h'], mid: ['1h', '30m'], entry: '15m' };

export const POI_STATES = ['WATCHING', 'READY', 'CONFIRMED', 'INVALIDATED'];
export const POI_CLASSES = ['A+', 'B', 'C'];

/** score weights — each factor is an independent market fact and is counted at most once */
export const POI_WEIGHTS_DEFAULT = {
  htfStrong: 18, // 1D + 4H agree with the setup direction
  htfPartial: 10, // only 4H agrees (1D range)
  htfConflict: -15, // 4H structure opposes the setup
  locationExtreme: 14, // POI sits in the outer 25 % of the discount (long) / premium (short)
  locationSide: 8, // POI is on the correct side of equilibrium
  locationWrong: -12, // POI is on the wrong side of equilibrium
  fresh: 10, // unmitigated zone
  mitigated: 3, // touched once but still valid
  obQuality: 8, // OB with a qualifying displacement + structure break
  fvgOverlap: 7, // a valid FVG overlaps the OB
  doubleOb: 10, // a nested (double) order block inside this zone
  sweepRejected: 15, // liquidity swept AND rejected
  sweepOnly: 5, // swept but no rejection yet
  mss: 15, // entry-TF MSS in the setup direction after the POI was reached
  bos: 8, // entry-TF BOS only (no MSS)
  orderFlow: 8, // 1H internal structure agrees with the setup
  liquidityTarget: 5, // untouched opposite-side liquidity available as a target
  midTfSource: 4, // zone comes from the 1H / 30M (not only the entry TF)
};

export const POI_DEFAULTS = {
  enabled: true,
  // structure / sensitivity
  swingSensitivity: 'medium', // low | medium | high
  liquiditySensitivity: 'medium', // equal-high/low tolerance
  bosConfirm: 'close', // close | wick  (BOS needs a candle CLOSE beyond the swing)
  mssConfirm: 'close',
  confirmCloseBars: 1, // extra closed candles that must hold beyond the break
  // zones
  obLookback: 400,
  obMitigation: 'close', // close | wick — what invalidates an order block
  obMinDisplacementAtr: 1.2, // impulse after the OB, in ATR
  fvgMinAtr: 0.1, // smallest accepted gap, in ATR
  fvgLookback: 150,
  poiOverlapPct: 50, // zones overlapping more than this % are the same POI
  maxPoiAgeBars: 300, // entry-TF bars after which an untouched POI is dropped
  // setup rules
  requireSweep: false, // CONFIRMED needs a swept + rejected liquidity pool
  requireMss: true, // CONFIRMED needs an entry-TF MSS (or BOS when false)
  requireHtfAlignment: true, // direction must not conflict with the 4H bias
  // classification
  minScore: 40, // below this a setup is not listed
  thresholdAplus: 80,
  thresholdB: 60,
  thresholdC: 40,
  maxSignals: 30, // most setups listed after a scan
  // invalidation
  invalidateOnClose: true, // close beyond the far side of the POI invalidates
  invalidateBufferAtr: 0.1,
  invalidateOnBiasFlip: true, // an opposite 4H MSS after the POI was created invalidates
  // paper trade model
  slBufferAtr: 0.2,
  minRR: 1.5,
  weights: { ...POI_WEIGHTS_DEFAULT },
};

const SENS = { low: 5, medium: 3, high: 2 };
export const swingBarsOf = (cfg) => SENS[cfg?.swingSensitivity] || SENS.medium;
const LIQ_TOL = { low: 0.25, medium: 0.15, high: 0.08 }; // ATR fraction
export const liqTolAtr = (cfg) => LIQ_TOL[cfg?.liquiditySensitivity] || LIQ_TOL.medium;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, d, lo, hi, int = false) => {
  const n = +v;
  if (!Number.isFinite(n)) return d;
  const c = clamp(n, lo, hi);
  return int ? Math.round(c) : +c.toFixed(4);
};
const pick = (v, list, d) => (list.includes(v) ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d);

/** @returns {{config, notes:string[]}} */
export function validatePoiConfig(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = POI_DEFAULTS;
  const notes = [];
  const cfg = {
    enabled: bool(r.enabled, d.enabled),
    swingSensitivity: pick(r.swingSensitivity, ['low', 'medium', 'high'], d.swingSensitivity),
    liquiditySensitivity: pick(r.liquiditySensitivity, ['low', 'medium', 'high'], d.liquiditySensitivity),
    bosConfirm: pick(r.bosConfirm, ['close', 'wick'], d.bosConfirm),
    mssConfirm: pick(r.mssConfirm, ['close', 'wick'], d.mssConfirm),
    confirmCloseBars: num(r.confirmCloseBars, d.confirmCloseBars, 0, 5, true),
    obLookback: num(r.obLookback, d.obLookback, 100, 1000, true),
    obMitigation: pick(r.obMitigation, ['close', 'wick'], d.obMitigation),
    obMinDisplacementAtr: num(r.obMinDisplacementAtr, d.obMinDisplacementAtr, 0, 6),
    fvgMinAtr: num(r.fvgMinAtr, d.fvgMinAtr, 0, 2),
    fvgLookback: num(r.fvgLookback, d.fvgLookback, 30, 500, true),
    poiOverlapPct: num(r.poiOverlapPct, d.poiOverlapPct, 10, 100, true),
    maxPoiAgeBars: num(r.maxPoiAgeBars, d.maxPoiAgeBars, 20, 1000, true),
    requireSweep: bool(r.requireSweep, d.requireSweep),
    requireMss: bool(r.requireMss, d.requireMss),
    requireHtfAlignment: bool(r.requireHtfAlignment, d.requireHtfAlignment),
    minScore: num(r.minScore, d.minScore, 0, 100, true),
    thresholdAplus: num(r.thresholdAplus, d.thresholdAplus, 1, 100, true),
    thresholdB: num(r.thresholdB, d.thresholdB, 1, 100, true),
    thresholdC: num(r.thresholdC, d.thresholdC, 0, 100, true),
    maxSignals: num(r.maxSignals, d.maxSignals, 1, 200, true),
    invalidateOnClose: bool(r.invalidateOnClose, d.invalidateOnClose),
    invalidateBufferAtr: num(r.invalidateBufferAtr, d.invalidateBufferAtr, 0, 1),
    invalidateOnBiasFlip: bool(r.invalidateOnBiasFlip, d.invalidateOnBiasFlip),
    slBufferAtr: num(r.slBufferAtr, d.slBufferAtr, 0, 2),
    minRR: num(r.minRR, d.minRR, 0.5, 10),
    weights: {},
  };
  const rw = r.weights && typeof r.weights === 'object' ? r.weights : {};
  for (const k of Object.keys(POI_WEIGHTS_DEFAULT)) cfg.weights[k] = num(rw[k], POI_WEIGHTS_DEFAULT[k], -50, 50, true);
  // thresholds must be ordered A+ > B > C
  if (!(cfg.thresholdAplus > cfg.thresholdB && cfg.thresholdB > cfg.thresholdC)) {
    notes.push('Thresholds must satisfy A+ > B > C — defaults restored.');
    cfg.thresholdAplus = d.thresholdAplus;
    cfg.thresholdB = d.thresholdB;
    cfg.thresholdC = d.thresholdC;
  }
  if (cfg.minScore < cfg.thresholdC) cfg.minScore = cfg.thresholdC; // nothing below C is ever listed
  return { config: cfg, notes };
}

export const normalizePoiConfig = (raw) => validatePoiConfig(raw).config;
