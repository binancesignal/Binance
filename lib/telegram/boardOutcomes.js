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

export function summarizeResolvedOutcomes(outcomes) {
  const rows = Array.isArray(outcomes) ? outcomes : [];
  return {
    total: rows.length,
    tp3: rows.filter(
      (signal) => String(signal?.status || '').toUpperCase() === SIGNAL_STATUS.COMPLETED_PROFIT
    ).length,
    sl: rows.filter(
      (signal) => String(signal?.status || '').toUpperCase() === SIGNAL_STATUS.STOPPED
    ).length,
  };
}

export function formatResolvedOutcome(signal) {
  const stopped = String(signal?.status || '').toUpperCase() === SIGNAL_STATUS.STOPPED;
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
            : '';
  const strategyLabel = strategy ? `[${strategy}] ` : '';
  const score =
    signal?.score != null && Number.isFinite(+signal.score)
      ? ` · ${Math.round(+signal.score)}`
      : '';
  const reachedTargets = ['tp1', 'tp2', 'tp3']
    .filter((target) => signal?.[`${target}_hit`])
    .map((target) => target.toUpperCase());
  const outcomeLabel = stopped ? '🔴 SL HIT' : '✅ TP3 HIT';
  const levelLabel = stopped ? 'SL' : 'TP3';
  const levelPrice = stopped ? signal?.sl : signal?.tp3;
  const targetLabel = stopped ? 'Targets before SL' : 'Targets reached';

  return [
    `${outcomeLabel} ${strategyLabel}${symbol} ${direction}${score}`,
    `Entry   ${fmtPrice(signal?.entry ?? signal?.entry_hit_price)}`,
    `${levelLabel.padEnd(7, ' ')}${fmtPrice(levelPrice)}`,
    `${targetLabel}: ${reachedTargets.length ? reachedTargets.join(', ') : 'none'}`,
  ].join('\n');
}