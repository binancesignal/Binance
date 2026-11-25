/**
 * ABCD + SP breaker — standalone strategy package.
 * Logic is the same implementation as findAbcdSpEvents in extraStrategies.js (unchanged).
 * This module only exists so the strategy can be scanned / configured outside the Harmonic board.
 */
export {
  findAbcdSpEvents,
  findSpBreaker,
  abcdPatterns,
  normalizeExtraConfig,
  EXTRA_DEFAULTS,
  buildExtraChartSvg,
  buildExtraAnnotations,
  revalidateExtraSignal,
  preEntryStatus,
  replayPlan,
} from '../harmonicScan/extraStrategies.js';
export { detectBreakers, BREAKER_DEFAULTS } from '../harmonicScan/breakerBlock.js';

import { findAbcdSpEvents, normalizeExtraConfig, EXTRA_DEFAULTS } from '../harmonicScan/extraStrategies.js';

/** Run ABCD+SP on one symbol/tf candle series (logic unchanged). */
export function runAbcdSpStrategy({ symbol, tf, candles, config = {}, proximityPct, breakerCfg } = {}) {
  const abcd = { ...EXTRA_DEFAULTS.abcd, ...(config.abcd || config), ...config };
  const events = findAbcdSpEvents(candles, abcd, { proximityPct, breakerCfg });
  return events.map((e) => ({
    ...e,
    symbol: symbol || e.symbol,
    tf: tf || e.tf,
    strategy: 'ABCD_SP',
    family: e.family || 'ABCD_SP',
    label: e.label || 'ABCD + SP breaker',
    metadata: {
      ...(e.metadata || {}),
      strategy: 'abcd_sp',
      strategyName: 'ABCD + SP breaker',
      pattern: 'ABCD_SP',
      fromAbcdSp: true,
    },
  }));
}

export function defaultAbcdSpConfig() {
  return normalizeExtraConfig({ enableAbcdSp: true, abcd: { ...EXTRA_DEFAULTS.abcd } });
}
