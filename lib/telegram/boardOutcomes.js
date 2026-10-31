import { SIGNAL_STATUS } from '../config/signalConfig.js';

const CLOSED_OUTCOMES = [
  SIGNAL_STATUS.COMPLETED_PROFIT,
  SIGNAL_STATUS.STOPPED,
];

function fmtPrice(value) {
  if (value == null || !Number.isFinite(+value)) return '—';
  const n = +value;
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(4);
  if (abs >= 0.01) return n.toFixed(5);
  return Number(n.toPrecision(5)).toString();
}

function safeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function getRecentResolvedOutcomes(history, limit = 8) {
  return (Array.isArray(history) ? history : [])
    .filter((signal) => CLOSED_OUTCOMES.includes(String(signal?.status || '').toUpperCase()))
    .slice(0, Math.max(0, Math.floor(limit)));
}

/** Highest TP level a closed trade reached (0 = none). */
export function resolvedTpLevel(signal) {
  const st = String(signal?.status || '').toUpperCase();
  if (signal?.tp3_hit || st === SIGNAL_STATUS.COMPLETED_PROFIT) return 3;
  if (signal?.tp2_hit) return 2;
  if (signal?.tp1_hit) return 1;
  return 0;
}

/**
 * TP1/TP2 then SL is a TP result, not an SL: every trade is counted once, at the highest
 * TP it reached. Only a stop-out that never touched a TP counts as SL.
 */
export function summarizeResolvedOutcomes(outcomes) {
  const rows = Array.isArray(outcomes) ? outcomes : [];
  const lvl = (signal) => resolvedTpLevel(signal);
  return {
    total: rows.length,
    tp1: rows.filter((signal) => lvl(signal) === 1).length,
    tp2: rows.filter((signal) => lvl(signal) === 2).length,
    tp3: rows.filter((signal) => lvl(signal) === 3).length,
    sl: rows.filter(
      (signal) =>
        String(signal?.status || '').toUpperCase() === SIGNAL_STATUS.STOPPED && lvl(signal) === 0
    ).length,
    // kept for old callers: always 0 now (TP→SL is part of tp1/tp2)
    tpSl: 0,
  };
}

export function formatResolvedOutcome(signal) {
  const level = resolvedTpLevel(signal);
  // stopped with NO TP touched = SL; anything that reached a TP is reported as that TP
  const stopped = String(signal?.status || '').toUpperCase() === SIGNAL_STATUS.STOPPED && level === 0;
  const symbol = safeText(signal?.symbol || '—');
  const direction = safeText(String(signal?.direction || signal?.dir || '—').toUpperCase());
  const metadata = signal?.metadata || {};
  const strategy =
    metadata.confluenceMode === 'ict_chart_pattern'
      ? 'ICT+CP'
      : metadata.strategy === 'ict_smc' || signal?.strategy === 'ict_smc'
        ? 'ICT'
        : metadata.strategy === 'chart_pattern' || signal?.strategy === 'chart_pattern'
          ? 'PATTERN'
        : metadata.strategy === 'zone_pattern' || signal?.strategy === 'zone_pattern'
          ? 'ZONE+PATTERN'
          : metadata.strategy === 'ema_bump' || signal?.strategy === 'ema_bump'
            ? 'EMA BUMP'
            : metadata.strategy === 'ob_fib' || signal?.strategy === 'ob_fib'
              ? 'OB'
            : '';
  const strategyLabel = strategy ? `[${strategy}] ` : '';
  const score =
    signal?.score != null && Number.isFinite(+signal.score)
      ? ` · ${Math.round(+signal.score)}`
      : '';
  const reachedTargets = ['tp1', 'tp2', 'tp3']
    .filter((target) => signal?.[`${target}_hit`])
    .map((target) => target.toUpperCase());
  const hitName = level >= 3 ? 'TP3' : level === 2 ? 'TP2' : 'TP1';
  const outcomeLabel = stopped ? '🔴 SL HIT' : `✅ ${hitName} HIT`;
  const levelLabel = stopped ? 'SL' : hitName;
  const levelPrice = stopped ? signal?.sl : signal?.[hitName.toLowerCase()];
  const targetLabel = 'Targets reached';

  return [
    `${outcomeLabel} ${strategyLabel}${symbol} ${direction}${score}`,
    `Entry   ${fmtPrice(signal?.entry ?? signal?.entry_hit_price)}`,
    `${levelLabel.padEnd(7, ' ')}${fmtPrice(levelPrice)}`,
    `${targetLabel}: ${reachedTargets.length ? reachedTargets.join(', ') : 'none'}`,
  ].join('\n');
}