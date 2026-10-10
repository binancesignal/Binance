/**
 * Double Top / Double Bottom Confluence Strategy
 * PATTERN → HTF → LIQUIDITY → SMC → FIB → BREAKOUT → RETEST → LTF → SCORE → TRADE
 */
import { calcATR } from '../../indicators.js';
import { normalizeDoubleConfluenceConfig, resolveTfPairs } from './config.js';
import {
  detectDoublePattern,
  analyzeHtfContext,
  analyzeLiquidity,
  analyzeSmc,
  analyzeFibonacci,
  analyzeBreakout,
  analyzeRetest,
  analyzeLtfConfirm,
} from './detect.js';

const finite = (n) => Number.isFinite(+n);

function validCandles(candles) {
  return (Array.isArray(candles) ? candles : []).filter(
    (c) =>
      finite(c?.open) &&
      finite(c?.high) &&
      finite(c?.low) &&
      finite(c?.close) &&
      +c.high >= +c.low
  );
}

function effectiveMinScore(cfg) {
  let min = cfg.minScore ?? 8;
  if (cfg.confluenceMode === 'flexible') min = Math.min(min, 7);
  if (cfg.confluenceMode === 'strict') min = Math.max(min, 10);
  return min;
}

function computeLevels({ pattern, liq, smc, atr, cfg, price }) {
  const isLong = pattern.direction === 'LONG';
  const A = atr || 1;

  // Entry: prefer retest/neckline area, else second extreme recovery
  let entry = pattern.neckline.price;
  if (price && Math.abs(price - entry) / A < 1.5) {
    entry = isLong ? Math.min(entry, price) : Math.max(entry, price);
  }

  const extremes = [pattern.secondPoint.price];
  if (liq.detail?.extreme) extremes.push(liq.detail.extreme);
  if (smc.orderBlock) {
    extremes.push(isLong ? smc.orderBlock.low : smc.orderBlock.high);
  }

  let sl = isLong
    ? Math.min(...extremes.filter(finite)) - A * (cfg.slBufferATR ?? 0.25)
    : Math.max(...extremes.filter(finite)) + A * (cfg.slBufferATR ?? 0.25);

  const risk = Math.abs(entry - sl);
  const riskATR = risk / A;
  if (riskATR < (cfg.minStopATR ?? 0.4) || riskATR > (cfg.maxStopATR ?? 4)) return null;

  const tp1 = isLong ? entry + risk * (cfg.tp1R ?? 1) : entry - risk * (cfg.tp1R ?? 1);
  const tp2 = isLong ? entry + risk * (cfg.tp2R ?? 2) : entry - risk * (cfg.tp2R ?? 2);
  const tp3 = isLong ? entry + risk * (cfg.tp3R ?? 3) : entry - risk * (cfg.tp3R ?? 3);
  const rr = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
  if (rr < (cfg.minRR ?? 1.2) * 0.85) return null; // soft vs tp1R

  return {
    entry: +entry.toFixed(8),
    sl: +sl.toFixed(8),
    tp1: +tp1.toFixed(8),
    tp2: +tp2.toFixed(8),
    tp3: +tp3.toFixed(8),
    rr: +rr.toFixed(3),
    riskATR: +riskATR.toFixed(3),
  };
}

/**
 * Run for one HTF/Entry pair.
 * @param {object} opts - symbol, price, htfCandles, entryCandles, htf, entryTf, presetLabel, config
 */
export function runDoubleConfluencePair(opts = {}) {
  const {
    symbol,
    price,
    htfCandles: rawHtf,
    entryCandles: rawEntry,
    htf,
    entryTf,
    presetId,
    presetLabel,
    config: rawConfig,
  } = opts;

  const cfg = normalizeDoubleConfluenceConfig(rawConfig || {});
  if (!cfg.enabled) return [];

  const htfCandles = validCandles(rawHtf);
  const entryCandles = validCandles(rawEntry);
  if (entryCandles.length < 40 || !finite(price)) return [];

  const atr = calcATR(entryCandles, cfg.atrPeriod) || price * 0.005;

  // 1. Pattern on Entry TF
  const pattern = detectDoublePattern(entryCandles, cfg, atr);
  if (!pattern || pattern.quality < 0.35) return [];

  // Age check
  const age = entryCandles.length - 1 - pattern.secondPoint.i;
  if (age > (cfg.maxPatternAgeBars ?? 60)) return [];

  // 2. HTF context
  const htfCtx = analyzeHtfContext(htfCandles, pattern.direction);

  // 3. Liquidity
  const liq = analyzeLiquidity(entryCandles, pattern, atr);
  if (cfg.requireLiquidity && !liq.sweep) return [];

  // 4. SMC
  const smc = analyzeSmc(entryCandles, pattern.direction, pattern);
  if (cfg.requireBos && !smc.bosOk) return [];
  if (cfg.requireChoch && !smc.chochOk) return [];
  if (cfg.requireOb && !smc.orderBlock) return [];
  if (cfg.requireFvg && !smc.fvg) return [];
  if (cfg.requireSmc && smc.bosPoints === 0 && smc.obFvgPoints === 0) return [];

  // 5. Fibonacci
  const fib = analyzeFibonacci(entryCandles, pattern);
  if (cfg.strictFibMode && !fib.confluence) return [];

  // 6. Neckline breakout
  const breakout = analyzeBreakout(entryCandles, pattern, cfg);

  // 7. Retest
  const retest = analyzeRetest(entryCandles, pattern, breakout, smc);
  if (cfg.requireRetest && !retest.confirmed) return [];

  // 8. LTF confirmation (same entry candles last bars)
  const ltf = analyzeLtfConfirm(entryCandles, pattern.direction);

  // Score 0-14
  // Pattern +2, HTF +2, Liq +2, BOS/CHoCH +2, OB/FVG +1, Fib +1, Breakout +2, Retest +2
  let score = 0;
  const breakdown = {};

  breakdown.pattern = pattern.quality >= 0.55 ? 2 : pattern.quality >= 0.4 ? 1 : 0;
  score += breakdown.pattern;

  breakdown.htf = htfCtx.points >= 2 ? 2 : htfCtx.points >= 1 ? 1 : 0;
  score += breakdown.htf;

  breakdown.liquidity = liq.points; // 0 or 2
  score += breakdown.liquidity;

  breakdown.bosChoch = smc.bosPoints; // 0-2
  score += breakdown.bosChoch;

  breakdown.obFvg = cfg.fibEnabled ? smc.obFvgPoints : smc.obFvgPoints; // 0-1
  score += breakdown.obFvg;

  breakdown.fib = cfg.fibEnabled ? fib.points : 0; // 0-1
  score += breakdown.fib;

  breakdown.breakout = breakout.points; // 0 or 2
  score += breakdown.breakout;

  breakdown.retest = retest.points; // 0 or 2
  score += breakdown.retest;

  // Strict mode: need breakout + (bos or retest)
  if (cfg.confluenceMode === 'strict') {
    if (!breakout.confirmed) return [];
    if (smc.bosPoints === 0 && !retest.confirmed) return [];
  }

  const minScore = effectiveMinScore(cfg);
  if (score < minScore) return [];

  // Levels
  const levels = computeLevels({ pattern, liq, smc, atr, cfg, price: +price });
  if (!levels) return [];

  // Entry distance
  const distATR = Math.abs(+price - levels.entry) / atr;
  if (distATR > (cfg.maxEntryDistanceATR ?? 3.5)) return [];

  // Invalidation: price already deep beyond SL
  const lastClose = entryCandles[entryCandles.length - 1]?.close;
  if (pattern.direction === 'LONG' && lastClose < levels.sl) return [];
  if (pattern.direction === 'SHORT' && lastClose > levels.sl) return [];

  const quality =
    score >= 10 ? 'STRONG' : score >= 8 ? 'VALID' : 'WEAK';

  // Lifecycle suggestion
  let suggestedStatus = 'WATCHING';
  if (breakout.confirmed && (retest.confirmed || ltf.confirmed || score >= 10)) {
    suggestedStatus = 'READY';
  } else if (breakout.confirmed) {
    suggestedStatus = 'WATCHING'; // waiting retest
  }

  const patternLabel =
    pattern.type === 'DOUBLE_BOTTOM' ? 'Double Bottom' : 'Double Top';

  const analysis = [
    `${symbol} — ${pattern.direction} ${patternLabel.toUpperCase()}`,
    `HTF: ${String(htf).toUpperCase()} · Entry TF: ${String(entryTf).toUpperCase()}${presetLabel ? ` (${presetLabel})` : ''}`,
    `Pattern: ${patternLabel} (q=${pattern.quality})`,
    `Structure: ${htfCtx.bias}${htfCtx.bos ? ` · BOS ${htfCtx.bos}` : ''}${htfCtx.choch ? ` · CHoCH ${htfCtx.choch}` : ''}`,
    `Liquidity: ${liq.sweep ? 'Sweep confirmed' : 'No sweep'}`,
    `SMC: ${smc.bosOk ? 'BOS' : smc.chochOk ? 'CHoCH' : '—'}${smc.orderBlock ? ' + OB' : ''}${smc.fvg ? ' + FVG' : ''}`,
    `Fibonacci: ${fib.confluence ? `${fib.level.ratio} confluence` : 'none'}`,
    `Breakout: ${breakout.confirmed ? 'Confirmed' : 'Pending'}`,
    `Retest: ${retest.confirmed ? 'Confirmed' : 'Pending'}`,
    `LTF: ${ltf.confirmed ? ltf.type : '—'}`,
    `Score: ${score}/14 · ${quality}`,
    `Entry: ${levels.entry}  SL: ${levels.sl}`,
    `TP1: ${levels.tp1}  TP2: ${levels.tp2}  TP3: ${levels.tp3}`,
    `RR: 1:${levels.rr}`,
  ].join('\n');

  return [{
    symbol,
    dir: pattern.direction,
    direction: pattern.direction,
    strategy: 'double_confluence',
    pattern: patternLabel,
    score: Math.round((score / 14) * 100), // normalize to ~100 scale for scanner gates
    confluenceScore: score,
    confluenceMax: 14,
    quality,
    entry: levels.entry,
    sl: levels.sl,
    tp1: levels.tp1,
    tp2: levels.tp2,
    tp3: levels.tp3,
    rr: levels.rr,
    atr,
    suggestedStatus,
    analysis,
    ob: {
      time: pattern.secondPoint.time || pattern.neckline.time,
      high: pattern.direction === 'SHORT' ? pattern.secondPoint.price : pattern.neckline.price,
      low: pattern.direction === 'LONG' ? pattern.secondPoint.price : pattern.neckline.price,
    },
    metadata: {
      strategy: 'double_confluence',
      strategyName: 'Double Top / Double Bottom Confluence',
      htf,
      entryTf,
      patternTf: entryTf,
      presetId: presetId || null,
      presetLabel: presetLabel || null,
      pattern: {
        type: pattern.type,
        firstPoint: pattern.firstPoint,
        secondPoint: pattern.secondPoint,
        neckline: pattern.neckline,
        quality: pattern.quality,
        heightATR: pattern.heightATR,
      },
      htfStructure: {
        bias: htfCtx.bias,
        bos: htfCtx.bos,
        choch: htfCtx.choch,
        aligned: htfCtx.aligned,
      },
      liquidity: {
        sweep: liq.sweep,
        detail: liq.detail,
      },
      smc: {
        bos: smc.bos,
        choch: smc.choch,
        orderBlock: smc.orderBlock,
        fvg: smc.fvg,
      },
      fibonacci: {
        confluence: fib.confluence,
        level: fib.level,
        zone: fib.zone,
      },
      breakout: {
        confirmed: breakout.confirmed,
        candle: breakout.breakCandle,
      },
      retest: {
        confirmed: retest.confirmed,
        level: retest.level || null,
      },
      ltfConfirm: ltf,
      confluenceScore: score,
      confluenceMax: 14,
      scoreBreakdown: breakdown,
      quality,
      riskATR: levels.riskATR,
      minScoreAtCreate: minScore,
      minRrAtEntry: cfg.minRR,
      chart: {
        doubleGeometry: {
          type: pattern.type,
          first: pattern.firstPoint,
          second: pattern.secondPoint,
          neckline: pattern.neckline,
        },
        fibZone: fib.zone,
        breakoutLevel: pattern.neckline.price,
        orderBlock: smc.orderBlock,
        fvg: smc.fvg,
      },
    },
  }];
}

/**
 * Convenience: run all resolved TF pairs (caller supplies candle maps).
 * candlesByTf: { '15m': [...], '1h': [...], ... }
 */
export function runDoubleConfluenceStrategy(opts = {}) {
  const { symbol, price, candlesByTf = {}, config: rawConfig } = opts;
  const cfg = normalizeDoubleConfluenceConfig(rawConfig || {});
  if (!cfg.enabled) return [];

  const pairs = resolveTfPairs(cfg);
  const results = [];
  for (const pair of pairs) {
    const htfCandles = candlesByTf[pair.htf];
    const entryCandles = candlesByTf[pair.entry];
    if (!htfCandles?.length || !entryCandles?.length) continue;
    const out = runDoubleConfluencePair({
      symbol,
      price,
      htfCandles,
      entryCandles,
      htf: pair.htf,
      entryTf: pair.entry,
      presetId: pair.presetId,
      presetLabel: pair.label,
      config: cfg,
    });
    results.push(...out);
  }
  // Best per direction
  results.sort((a, b) => (b.confluenceScore || 0) - (a.confluenceScore || 0));
  return results.slice(0, 3);
}

export { normalizeDoubleConfluenceConfig, resolveTfPairs, TF_PRESETS } from './config.js';
export { detectDoublePattern } from './detect.js';
