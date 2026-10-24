/**
 * Re-apply current chart-pattern strategy gates to an existing WATCHING/READY signal.
 * Used when admin updates gates (RSI, EMA, RR, HTF, …) so old open setups follow new rules
 * on the next scan — not only newly discovered ones.
 */
import { detectStructure } from '../../structure.js';
import {
  rsiDivergenceForDirection,
  checkEmaAlignment,
} from '../../indicators.js';
import { isHard, resolveGateConfig } from './gates.js';
import { CHART_PATTERN_CONFIG } from './config.js';

/**
 * @param {object} signal  active WATCHING/READY chart_pattern row
 * @param {object[]} patternCandles  pattern TF klines (closed preferred)
 * @param {object[]|null} htfCandles
 * @param {object} rawCfg  chart_pattern_config from app state
 * @returns {{ ok: boolean, reason?: string, checks: object }}
 */
export function revalidateChartPatternSignal(signal, patternCandles, htfCandles, rawCfg = {}) {
  const cfg = resolveGateConfig(CHART_PATTERN_CONFIG, rawCfg || {});
  const direction = String(signal.direction || signal.dir || '').toUpperCase();
  const checks = {};

  if (direction !== 'LONG' && direction !== 'SHORT') {
    return { ok: false, reason: 'Invalid direction', checks };
  }
  if (!patternCandles?.length) {
    // No candles — do not kill the signal just for missing data
    return { ok: true, reason: 'no pattern candles — skipped strategy revalidate', checks };
  }

  const entry = +signal.entry;
  const sl = +signal.sl;
  const tp1 = +signal.tp1;
  const tp2 = +signal.tp2;
  const risk = entry && sl ? Math.abs(entry - sl) : 0;

  // --- TP1 / TP2 RR (hard gates) ---
  if (risk > 0 && tp1) {
    const rr = Math.abs(+tp1 - entry) / risk;
    checks.tp1rr = { rr, min: cfg.minTp1RR ?? 1.0, pass: rr + 1e-6 >= (cfg.minTp1RR ?? 1.0) };
    if (!checks.tp1rr.pass && isHard(cfg, 'tp1rr')) {
      return {
        ok: false,
        reason: `Strategy update: TP1 RR ${rr.toFixed(2)} < min ${cfg.minTp1RR ?? 1.0}`,
        checks,
      };
    }
  }
  if (risk > 0 && tp2) {
    const rrM = Math.abs(+tp2 - entry) / risk;
    checks.tp2rr = { rr: rrM, min: cfg.minRR ?? 1.2, pass: rrM >= (cfg.minRR ?? 1.2) };
    if (!checks.tp2rr.pass && isHard(cfg, 'tp2rr')) {
      return {
        ok: false,
        reason: `Strategy update: Measured RR ${rrM.toFixed(2)} < min ${cfg.minRR ?? 1.2}`,
        checks,
      };
    }
  }

  // --- HTF align ---
  if (htfCandles?.length) {
    const htf = detectStructure(htfCandles);
    const aligned =
      direction === 'LONG'
        ? htf.bias === 'bullish' || htf.bos === 'bullish' || htf.choch === 'bullish'
        : htf.bias === 'bearish' || htf.bos === 'bearish' || htf.choch === 'bearish';
    const pass = aligned || htf.bias === 'neutral';
    checks.htf = { bias: htf.bias, pass };
    if (!pass && isHard(cfg, 'htf')) {
      return {
        ok: false,
        reason: `Strategy update: HTF ${htf.bias} contradicts ${direction}`,
        checks,
      };
    }
  }

  // --- RSI divergence ---
  try {
    const rsi = rsiDivergenceForDirection(patternCandles, direction, cfg.rsiPeriod ?? 14);
    checks.rsiDiv = { ok: rsi.ok, detail: rsi.detail, against: rsi.against };
    if (!rsi.ok && isHard(cfg, 'rsiDiv')) {
      return {
        ok: false,
        reason: `Strategy update: ${rsi.detail}`,
        checks,
      };
    }
  } catch (e) {
    checks.rsiDiv = { error: e.message };
    if (isHard(cfg, 'rsiDiv')) {
      return { ok: false, reason: 'Strategy update: RSI divergence could not be evaluated', checks };
    }
  }

  // --- EMA trend ---
  try {
    const ema = checkEmaAlignment(patternCandles, direction, {
      fast: cfg.emaFast ?? 21,
      slow: cfg.emaSlow ?? 50,
    });
    checks.ema = { aligned: ema.aligned, reason: ema.reason };
    if (!ema.aligned && isHard(cfg, 'ema')) {
      return {
        ok: false,
        reason: `Strategy update: ${ema.reason}`,
        checks,
      };
    }
  } catch (e) {
    checks.ema = { error: e.message };
    if (isHard(cfg, 'ema')) {
      return { ok: false, reason: 'Strategy update: EMA alignment could not be evaluated', checks };
    }
  }

  // Soft-gate failures are recorded but do not invalidate existing signals
  // (admin can still see them on the next chart / gates panel after sibling refresh).
  return { ok: true, reason: 'passes current hard strategy gates', checks };
}
