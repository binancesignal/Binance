import { calcATR, findSwings, relativeVolume } from '../../indicators.js';
import { detectFVGs } from '../../fvg.js';
import { detectOrderBlocks } from '../../orderBlocks.js';
import { detectStructure } from '../../structure.js';
import { normalizeZonePatternConfig } from './config.js';

const FAMILY_WEIGHT = {
  WEEKLY: 3,
  DAILY: 2,
  SWING: 1,
  FIB: 2,
  ORDER_BLOCK: 3,
  FVG: 2,
};
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
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

function addLevel(levels, {
  price,
  direction,
  family,
  label,
  low = price,
  high = price,
  time = null,
  strength = 1,
}) {
  if (!finite(price) || +price <= 0 || !['support', 'resistance'].includes(direction)) return;
  levels.push({
    price: +price,
    low: finite(low) ? +low : +price,
    high: finite(high) ? +high : +price,
    direction,
    family,
    label,
    time,
    strength: Number.isFinite(+strength) ? +strength : 1,
  });
}

function addSwingLevels(levels, candles, pivotBars) {
  if (candles.length < pivotBars * 2 + 8) return;
  const swings = findSwings(candles, pivotBars, pivotBars).slice(-20);
  for (const swing of swings) {
    addLevel(levels, {
      price: swing.price,
      direction: swing.type === 'L' ? 'support' : 'resistance',
      family: 'SWING',
      label: swing.type === 'L' ? 'Swing low' : 'Swing high',
      time: swing.time,
    });
  }
}

function addFibLevels(levels, candles, cfg, timeframe) {
  if (candles.length < 20) return;
  const swings = findSwings(candles, cfg.pivotBars, cfg.pivotBars).slice(-24);
  const high = [...swings].reverse().find((s) => s.type === 'H');
  const low = [...swings].reverse().find((s) => s.type === 'L');
  if (!high || !low || high.i === low.i) return;
  const range = Math.abs(high.price - low.price);
  const atr = calcATR(candles, 14) || 0;
  if (!(range > 0) || (atr > 0 && range < atr * 1.5)) return;

  const upLeg = low.i < high.i;
  for (const ratio of cfg.fibRatios) {
    const price = upLeg
      ? high.price - range * ratio
      : low.price + range * ratio;
    addLevel(levels, {
      price,
      direction: upLeg ? 'support' : 'resistance',
      family: 'FIB',
      label: `${timeframe} Fib ${Math.round(ratio * 1000) / 10}%`,
      time: upLeg ? high.time : low.time,
      strength: 1.2,
    });
  }
}

function buildLevels({
  setupCandles,
  contextCandles,
  weeklyCandles,
  dailyCandles,
  cfg,
}) {
  const levels = [];
  const recentWeeks = weeklyCandles.slice(-Math.min(4, cfg.weeklyLookback));
  const recentDays = dailyCandles.slice(-Math.min(5, cfg.dailyLookback));
  if (cfg.includeWeeklyLevels) {
    for (const [index, week] of recentWeeks.entries()) {
      const label = index === recentWeeks.length - 1 ? 'Previous weekly' : 'Recent weekly';
      addLevel(levels, {
        price: week.low,
        direction: 'support',
        family: 'WEEKLY',
        label: `${label} low`,
        time: week.time,
      });
      addLevel(levels, {
        price: week.high,
        direction: 'resistance',
        family: 'WEEKLY',
        label: `${label} high`,
        time: week.time,
      });
    }
  }
  if (cfg.includeDailyLevels) {
    for (const [index, day] of recentDays.entries()) {
      const label = index === recentDays.length - 1 ? 'Previous daily' : 'Recent daily';
      addLevel(levels, {
        price: day.low,
        direction: 'support',
        family: 'DAILY',
        label: `${label} low`,
        time: day.time,
      });
      addLevel(levels, {
        price: day.high,
        direction: 'resistance',
        family: 'DAILY',
        label: `${label} high`,
        time: day.time,
      });
    }
  }

  if (cfg.includeSwingLevels) {
    addSwingLevels(levels, contextCandles, cfg.pivotBars);
    addSwingLevels(levels, setupCandles, cfg.pivotBars);
  }
  if (cfg.includeFibLevels) {
    addFibLevels(levels, contextCandles, cfg, cfg.contextTf);
    addFibLevels(levels, setupCandles, cfg, cfg.setupTf);
  }
  if (cfg.includeOrderBlocks) {
    for (const ob of detectOrderBlocks(contextCandles, cfg.contextLookback)) {
      if (ob.status === 'INVALIDATED') continue;
      const isBullish = ob.type === 'bullish';
      addLevel(levels, {
        price: ob.mid,
        low: ob.low,
        high: ob.high,
        direction: isBullish ? 'support' : 'resistance',
        family: 'ORDER_BLOCK',
        label: `${isBullish ? 'Bullish' : 'Bearish'} order block`,
        time: ob.time,
        strength: 1 + (+ob.strength || 0) / 100,
      });
    }
  }
  if (cfg.includeFvgs) {
    for (const fvg of detectFVGs(contextCandles)) {
      const isBullish = fvg.type === 'bullish';
      addLevel(levels, {
        price: (fvg.low + fvg.high) / 2,
        low: fvg.low,
        high: fvg.high,
        direction: isBullish ? 'support' : 'resistance',
        family: 'FVG',
        label: `${isBullish ? 'Bullish' : 'Bearish'} fair value gap`,
        time: fvg.time,
        strength: 1 + (1 - (+fvg.filled || 0)),
      });
    }
  }
  return levels;
}

function clusterLevels(levels, atr, cfg) {
  const tolerance = Math.max(atr * cfg.zoneToleranceATR, 1e-10);
  const zones = [];
  for (const direction of ['support', 'resistance']) {
    const sorted = levels
      .filter((l) => l.direction === direction)
      .sort((a, b) => a.price - b.price);
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const totalWeight = group.reduce((sum, l) => sum + l.strength, 0) || group.length;
      const center = group.reduce((sum, l) => sum + l.price * l.strength, 0) / totalWeight;
      const families = [...new Set(group.map((l) => l.family))];
      if (families.length >= cfg.minZoneSources) {
        zones.push({
          direction,
          low: Math.min(...group.map((l) => l.low)),
          high: Math.max(...group.map((l) => l.high)),
          center,
          families,
          sourceCount: families.length,
          sourceScore: families.reduce((sum, family) => sum + (FAMILY_WEIGHT[family] || 1), 0),
          sources: group.map(({ family, label, price, time }) => ({ family, label, price, time })),
        });
      }
      group = [];
    };

    for (const level of sorted) {
      if (group.length) {
        const mean = group.reduce((sum, l) => sum + l.price, 0) / group.length;
        if (level.price - mean > tolerance) flush();
      }
      group.push(level);
    }
    flush();
  }
  return zones.sort((a, b) => b.sourceScore - a.sourceScore || b.sourceCount - a.sourceCount);
}

function localFibMatch({ direction, first, neckline, zone, atr, cfg }) {
  if (!cfg.includeFibLevels) return { aligned: false };
  if (zone.families.includes('FIB')) {
    const fibSource = zone.sources.find((s) => s.family === 'FIB');
    return { aligned: true, ratio: fibSource?.label || 'higher-timeframe Fib', price: fibSource?.price ?? zone.center };
  }
  const height = Math.abs(neckline.price - first.price);
  if (!(height > 0)) return { aligned: false };
  for (const ratio of cfg.fibRatios) {
    const price =
      direction === 'LONG'
        ? neckline.price - height * ratio
        : neckline.price + height * ratio;
    if (Math.abs(price - zone.center) <= atr * cfg.fibToleranceATR) {
      return { aligned: true, ratio, price };
    }
  }
  return { aligned: false };
}

function buildCandidate({
  direction,
  zone,
  touches,
  swings,
  candles,
  price,
  atr,
  contextStructure,
  cfg,
}) {
  const [first, second] = touches;
  if (second.i - first.i < cfg.minTouchSpacingBars) return null;
  if (candles.length - 1 - second.i > cfg.maxBarsAfterSecondTouch) return null;

  const necklineType = direction === 'LONG' ? 'H' : 'L';
  const neckline = swings
    .filter((s) => s.type === necklineType && s.i > first.i && s.i < second.i)
    .sort((a, b) =>
      direction === 'LONG' ? b.price - a.price : a.price - b.price
    )[0];
  if (!neckline) return null;

  const touchGap = Math.abs(second.price - first.price);
  const shapeTolerance = Math.max(atr * cfg.zoneTouchToleranceATR, 1e-10);
  let pattern;
  if (direction === 'LONG') {
    if (second.price < first.price - shapeTolerance * 0.65) return null;
    pattern = touchGap <= shapeTolerance
      ? 'DOUBLE_BOTTOM'
      : second.price > first.price
        ? 'HIGHER_LOW'
        : 'SWEEP_RECLAIM';
  } else {
    if (second.price > first.price + shapeTolerance * 0.65) return null;
    pattern = touchGap <= shapeTolerance
      ? 'DOUBLE_TOP'
      : second.price < first.price
        ? 'LOWER_HIGH'
        : 'SWEEP_RECLAIM';
  }

  const lastIndex = candles.length - 1;
  const last = candles[lastIndex];
  const previous = candles[lastIndex - 1];
  const body = Math.abs(last.close - last.open);
  const range = Math.max(last.high - last.low, 1e-12);
  const bodyRatio = body / range;
  const breakBuffer = Math.max(atr * 0.04, Math.abs(neckline.price) * 0.00008);
  const long = direction === 'LONG';
  const brokeStructure = long
    ? last.close > neckline.price + breakBuffer &&
      previous.close <= neckline.price + breakBuffer * 0.25 &&
      last.close > last.open
    : last.close < neckline.price - breakBuffer &&
      previous.close >= neckline.price - breakBuffer * 0.25 &&
      last.close < last.open;
  if (!brokeStructure) return null;
  if (body < atr * cfg.minBosBodyATR && bodyRatio < cfg.minBosBodyRatio) return null;

  const zoneBuffer = atr * cfg.zoneTouchToleranceATR;
  const invalidated = candles
    .slice(second.i + 1, lastIndex)
    .some((c) =>
      long ? c.close < zone.low - zoneBuffer * 0.35 : c.close > zone.high + zoneBuffer * 0.35
    );
  if (invalidated) return null;

  const entry = +last.close;
  const chase = Math.abs(+price - entry) / atr;
  if (chase > cfg.maxChaseATR) return null;
  if (Math.abs(+price - zone.center) / atr > cfg.maxZoneDistanceATR) return null;
  if (long ? +price <= neckline.price : +price >= neckline.price) return null;

  const sl = long
    ? zone.low - atr * cfg.slBufferATR
    : zone.high + atr * cfg.slBufferATR;
  const risk = Math.abs(entry - sl);
  const riskATR = risk / atr;
  if (riskATR < cfg.minStopATR || riskATR > cfg.maxStopATR) return null;

  const fib = localFibMatch({ direction, first, neckline, zone, atr, cfg });
  const contextBias = contextStructure?.bias || 'neutral';
  const aligned = contextBias === (long ? 'bullish' : 'bearish');
  const opposite = contextBias === (long ? 'bearish' : 'bullish');
  const shapePoints =
    pattern === 'SWEEP_RECLAIM' ? 16 :
      pattern === 'DOUBLE_BOTTOM' || pattern === 'DOUBLE_TOP' ? 14 : 12;
  const sourcePoints = Math.min(24, zone.sourceCount * 6);
  const bodyPoints = clamp(Math.round(bodyRatio * 8), 0, 8);
  const score = clamp(
    30 +
      sourcePoints +
      shapePoints +
      16 + // closed local BOS
      (fib.aligned ? 10 : 0) +
      bodyPoints +
      (aligned ? 5 : opposite ? -4 : 0),
    0,
    100
  );
  if (score < cfg.minSignalScore) return null;

  return {
    direction,
    zone,
    first,
    second,
    neckline,
    pattern,
    entry,
    sl,
    risk,
    riskATR,
    bodyRatio,
    score,
    fib,
    contextBias,
    htfAligned: aligned,
    breakoutCandle: last,
    chaseATR: chase,
  };
}

function addTargets(candidate, zones, cfg) {
  const { direction, entry, risk } = candidate;
  const long = direction === 'LONG';
  const targetZones = zones
    .filter((z) => z.direction === (long ? 'resistance' : 'support'))
    .map((z) => ({ zone: z, price: long ? z.low : z.high }))
    .filter((item) => long ? item.price > entry : item.price < entry)
    .sort((a, b) => long ? a.price - b.price : b.price - a.price);
  const firstObstacle = targetZones[0];
  const projected = entry + (long ? 1 : -1) * risk * cfg.targetR;
  const tp1 = firstObstacle
    ? (long ? Math.min(projected, firstObstacle.price) : Math.max(projected, firstObstacle.price))
    : projected;
  const rr = Math.abs(tp1 - entry) / risk;
  if (rr < cfg.minRR) return null;
  return {
    tp1,
    tp2: entry + (long ? 1 : -1) * risk * Math.max(cfg.target2R, cfg.targetR),
    tp3: entry + (long ? 1 : -1) * risk * Math.max(cfg.target3R, cfg.target2R),
    rr,
    targetZone: firstObstacle?.zone || null,
  };
}

/**
 * Independent zone-confluence → reaction-pattern → local-BOS strategy.
 * This module does not read ICT, chart-pattern, or global signal thresholds.
 */
export function runZonePatternStrategy({
  symbol,
  setupCandles: setupInput,
  contextCandles: contextInput,
  weeklyCandles: weeklyInput = [],
  dailyCandles: dailyInput = [],
  price,
  cfg: configInput = {},
}) {
  const cfg = normalizeZonePatternConfig(configInput);
  const setupCandles = validCandles(setupInput);
  const contextCandles = validCandles(contextInput);
  const weeklyCandles = validCandles(weeklyInput);
  const dailyCandles = validCandles(dailyInput);
  if (setupCandles.length < 40 || contextCandles.length < 20 || !(+price > 0)) return [];

  const atr = calcATR(setupCandles, 14);
  if (!(atr > 0)) return [];
  const levels = buildLevels({
    setupCandles,
    contextCandles,
    weeklyCandles,
    dailyCandles,
    cfg,
  });
  const zones = clusterLevels(levels, atr, cfg);
  if (!zones.length) return [];

  const contextStructure = detectStructure(contextCandles);
  const swings = findSwings(setupCandles, cfg.pivotBars, cfg.pivotBars);
  const cutoff = Math.max(0, setupCandles.length - cfg.patternLookbackBars);
  const tolerance = atr * cfg.zoneTouchToleranceATR;
  const candidates = [];

  for (const zone of zones) {
    if (zone.sourceCount < cfg.minZoneSources) continue;
    if (zone.direction === 'support') {
      const touches = swings
        .filter((s) =>
          s.type === 'L' &&
          s.i >= cutoff &&
          s.price >= zone.low - tolerance &&
          s.price <= zone.high + tolerance
        )
        .slice(-2);
      if (touches.length < 2) continue;
      const candidate = buildCandidate({
        direction: 'LONG',
        zone,
        touches,
        swings,
        candles: setupCandles,
        price: +price,
        atr,
        contextStructure,
        cfg,
      });
      if (candidate) candidates.push(candidate);
    } else {
      const touches = swings
        .filter((s) =>
          s.type === 'H' &&
          s.i >= cutoff &&
          s.price >= zone.low - tolerance &&
          s.price <= zone.high + tolerance
        )
        .slice(-2);
      if (touches.length < 2) continue;
      const candidate = buildCandidate({
        direction: 'SHORT',
        zone,
        touches,
        swings,
        candles: setupCandles,
        price: +price,
        atr,
        contextStructure,
        cfg,
      });
      if (candidate) candidates.push(candidate);
    }
  }

  return candidates
    .map((candidate) => {
      const targets = addTargets(candidate, zones, cfg);
      if (!targets) return null;
      const { direction, zone, pattern, entry, sl, score, fib, neckline } = candidate;
      const long = direction === 'LONG';
      const conf = [
        `${zone.sourceCount} zone sources: ${zone.families.join(' + ')}`,
        `${zone.direction === 'support' ? 'Support' : 'Resistance'} reaction pattern: ${pattern}`,
        `Closed structure break ${long ? 'above' : 'below'} ${neckline.price}`,
        fib.aligned ? `Fib confluence: ${fib.ratio}` : 'Fib checked; no direct level match',
        candidate.htfAligned
          ? `${cfg.contextTf} structure aligned`
          : `Context structure: ${candidate.contextBias}`,
      ];
      return {
        symbol,
        dir: direction,
        strategy: 'zone_pattern',
        score,
        qualifies: true,
        conf,
        pattern,
        entry,
        sl,
        ...targets,
        rr: targets.rr.toFixed(2),
        price: +price,
        ob: {
          low: zone.low,
          high: zone.high,
          mid: zone.center,
          time: candidate.breakoutCandle.time,
          type: long ? 'bullish' : 'bearish',
          status: 'ZONE_CONFLUENCE',
        },
        structure: {
          bias: candidate.contextBias,
          bos: long ? 'bullish' : 'bearish',
          setupTf: cfg.setupTf,
          contextTf: cfg.contextTf,
          setupLookback: cfg.setupLookback,
        },
        rvol: relativeVolume(setupCandles),
        quality: {
          zoneConfluence: true,
          zoneSourceCount: zone.sourceCount,
          patternAtZone: true,
          localStructureBreak: true,
          fibAligned: fib.aligned,
          htfAligned: candidate.htfAligned,
          breakoutConfirmed: true,
        },
        metadata: {
          strategy: 'zone_pattern',
          pattern,
          patternTf: cfg.setupTf,
          setupTf: cfg.setupTf,
          contextTf: cfg.contextTf,
          breakoutConfirmed: true,
          breakoutLevel: neckline.price,
          breakoutTime: candidate.breakoutCandle.time,
          zone: {
            direction: zone.direction,
            low: zone.low,
            high: zone.high,
            center: zone.center,
            sourceCount: zone.sourceCount,
            sourceScore: zone.sourceScore,
            families: zone.families,
            sources: zone.sources,
          },
          patternTouches: [
            { index: candidate.first.i, price: candidate.first.price, time: candidate.first.time },
            { index: candidate.second.i, price: candidate.second.price, time: candidate.second.time },
          ],
          internalStructure: {
            bosLevel: neckline.price,
            bosTime: candidate.breakoutCandle.time,
            bodyRatio: candidate.bodyRatio,
          },
          fib: {
            aligned: fib.aligned,
            ratio: fib.ratio ?? null,
            price: fib.price ?? null,
          },
          contextBias: candidate.contextBias,
          riskATR: candidate.riskATR,
          chaseATR: candidate.chaseATR,
          targetZone: targets.targetZone
            ? {
                low: targets.targetZone.low,
                high: targets.targetZone.high,
                families: targets.targetZone.families,
              }
            : null,
          minScoreAtCreate: cfg.minSignalScore,
          minRrAtEntry: cfg.minRR,
          minRRAtEntry: cfg.minRR,
        },
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

export { buildLevels, clusterLevels };