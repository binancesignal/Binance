import { CHART_PATTERN_CONFIG as CFG } from './config.js';

export function scoreChartPatternSetup({
  pattern,
  breakout,
  htfAligned,
  confluence = null,
  cfg = CFG,
}) {
  const w = cfg.weights || {};
  let score = 0;
  const conf = [];

  // Pattern quality
  // pattern quality: base confidence + how tightly swings sit on the trendlines
  const pq = Math.min(w.patternQuality || 20, (pattern.confidence || 50) * 0.22 + (pattern.fit ?? 0.5) * 6);
  score += pq;
  conf.push(`Pattern ${pattern.patternType}`);

  if ((pattern.touches || 0) >= 3) {
    score += w.touches || 10;
    conf.push(`Touches ${pattern.touches}`);
  } else if ((pattern.touches || 0) >= 2) {
    score += (w.touches || 10) * 0.5;
  }

  if (pattern.support && pattern.resistance) {
    score += w.cleanLevels || 10;
    conf.push('Clean S/R');
  }

  if (breakout?.ok) {
    score += w.breakoutCandle || 15;
    conf.push('Breakout candle');
  }

  // clean breakout candle: strong body and not over-extended
  if ((breakout?.bodyRatio ?? 0) >= 0.65 && (breakout?.distAtr ?? 9) <= 1.0) {
    score += 4;
    conf.push('Strong breakout body');
  }

  const rvol = breakout?.rvol || 0;
  if (rvol >= 2) {
    score += w.volume || 15;
    conf.push(`RVOL ${rvol.toFixed(2)} surge`);
  } else if (rvol >= 1.5) {
    score += w.volume || 15;
    conf.push(`RVOL ${rvol.toFixed(2)} strong`);
  } else if (rvol >= 1.2) {
    score += (w.volume || 15) * 0.7;
    conf.push(`RVOL ${rvol.toFixed(2)}`);
  } else if (rvol >= 1.0) {
    score += (w.volume || 15) * 0.3;
  }

  if (htfAligned) {
    score += w.htf || 10;
    conf.push('HTF aligned');
  }

  // SMC confluence (direction + location aware, blockers already netted out)
  if (confluence?.smc?.points > 0) {
    score += confluence.smc.points;
    conf.push(...confluence.smc.notes.map((n) => `SMC: ${n}`));
  }
  // Fib confluence (retracement of prior leg / extension targets)
  if (confluence?.fib?.points > 0) {
    score += confluence.fib.points;
    conf.push(...confluence.fib.notes.map((n) => `Fib: ${n}`));
  }
  // Blockers in the path to TP1 cost score and are shown on the signal
  for (const b of confluence?.smc?.blocked || []) {
    if (/before TP1/.test(b)) score -= 4;
    conf.push(`Warn: ${b}`);
  }

  if (breakout?.retestOk && cfg.requireRetest) {
    score += w.retest || 5;
    conf.push('Retest');
  }

  score = Math.min(100, Math.round(score));
  return { score, conf };
}
