/**
 * Chart-pattern GATES — each gate is either
 *   HARD  = setup is REJECTED when the check fails
 *   SOFT  = setup is NOT rejected; it only loses SOFT_PENALTY score points per failed check
 * Modes are stored in chart_pattern_config.gateModes = { [key]: 'hard' | 'soft' }.
 * Anything not set falls back to the old boolean setting (legacy) or to `def` — so
 * existing behaviour is unchanged until a toggle is changed on the dashboard.
 */
export const SOFT_PENALTY = 6;

// legacy: old boolean config key that used to control this gate (true = hard)
export const GATE_DEFS = [
  { key: 'htf', label: 'HTF align', hint: 'Higher-TF structure must not oppose the trade', def: 'hard', legacy: 'requireHtfAlign' },
  { key: 'volume', label: 'Breakout volume (RVOL)', hint: 'Breakout candle volume ≥ Min RVOL', def: 'hard', legacy: 'requireVolumeConfirmation' },
  { key: 'retest', label: 'Retest', hint: 'Breakout level must be retested first', def: 'soft', legacy: 'requireRetest' },
  { key: 'pillars', label: 'Confluence pillars', hint: 'At least N of HTF / SMC / Fib', def: 'hard' },
  { key: 'smc', label: 'SMC confluence', hint: 'Sweep / OB / FVG at the pattern', def: 'soft', legacy: 'requireSmcConfluence' },
  { key: 'fib', label: 'Fib confluence', hint: 'Entry/target matches a Fib level', def: 'soft', legacy: 'requireFibConfluence' },
  { key: 'rejectionZone', label: 'Rejection zone (reversals)', hint: 'Triple top, H&S etc. must sit on an OB/Fib/S-R zone', def: 'hard', legacy: 'requireRejectionZone' },
  { key: 'rejection', label: 'Rejection score', hint: 'Real rejection event (wick, sweep, displacement)', def: 'hard', legacy: 'requireRejection' },
  { key: 'location', label: 'Location score', hint: 'Premium/discount + zone quality', def: 'hard' },
  { key: 'midRange', label: 'Mid-range filter', hint: 'Pattern in the middle of nowhere', def: 'hard', legacy: 'midRangeRejectionFilter' },
  { key: 'wave', label: 'Elliott Wave', hint: 'Wave score must reach minimum / no conflicting count', def: 'soft', legacy: 'requireElliottWave' },
  { key: 'blockedPath', label: 'Blocked path to TP1', hint: 'Opposing OB / swing before TP1', def: 'soft', legacy: 'rejectBlockedPath' },
  { key: 'tp1rr', label: 'TP1 RR', hint: 'TP1 reward:risk ≥ Min TP1 RR', def: 'hard' },
  { key: 'tp2rr', label: 'Measured-move RR (TP2)', hint: 'TP2 reward:risk ≥ Min RR', def: 'hard' },
  // Momentum / trend filters (combine with chart patterns)
  { key: 'rsiDiv', label: 'RSI divergence', hint: 'LONG needs bullish RSI div · SHORT needs bearish RSI div', def: 'soft', legacy: 'requireRsiDivergence' },
  { key: 'ema', label: 'EMA trend', hint: 'Price + EMA21/50 stack must agree with trade direction', def: 'soft', legacy: 'requireEmaAlign' },
];

export function isHard(cfg, key) {
  const m = cfg?.gateModes?.[key];
  if (m === 'hard') return true;
  if (m === 'soft') return false;
  const def = GATE_DEFS.find((g) => g.key === key);
  if (def?.legacy && cfg && cfg[def.legacy] !== undefined) return !!cfg[def.legacy];
  return def ? def.def === 'hard' : true;
}

export function defaultGateModes(cfg = {}) {
  const out = {};
  for (const g of GATE_DEFS) out[g.key] = isHard(cfg, g.key) ? 'hard' : 'soft';
  return out;
}

export function sanitizeGateModes(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const g of GATE_DEFS) {
    const v = input[g.key];
    if (v === 'hard' || v === 'soft') out[g.key] = v;
  }
  return out;
}

/** Merge saved overrides over base config and sync the legacy booleans from gateModes. */
export function resolveGateConfig(base, overrides) {
  const cfg = { ...base, ...(overrides || {}) };
  cfg.gateModes = { ...(base?.gateModes || {}), ...(overrides?.gateModes || {}) };
  for (const g of GATE_DEFS) {
    if (g.legacy) cfg[g.legacy] = isHard(cfg, g.key);
  }
  // Keep universal engine floor in sync with admin "Min signal score"
  if (Number.isFinite(+cfg.minSignalScore)) {
    cfg.minFinalScore = +cfg.minSignalScore;
  }
  // Hard Elliott gate: force wave engine ON and a real score floor
  if (isHard(cfg, 'wave')) {
    cfg.waveAnalysisEnabled = true;
    cfg.requireElliottWave = true;
    if (!(cfg.minWaveScore > 0)) cfg.minWaveScore = 40;
  }
  // Soft wave: allow analysis off unless user explicitly enabled it
  if (!isHard(cfg, 'wave') && cfg.waveAnalysisEnabled == null) {
    cfg.waveAnalysisEnabled = false;
  }
  return cfg;
}
