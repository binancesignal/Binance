/**
 * Double Top / Bottom detection + confluence detectors (liquidity, fib, breakout, retest).
 */
import { findSwings, calcATR } from '../../indicators.js';
import { detectStructure } from '../../structure.js';
import { detectLiquidity } from '../../liquidity.js';
import { detectFVGs } from '../../fvg.js';
import { detectOrderBlocks } from '../../orderBlocks.js';

const finite = (n) => Number.isFinite(+n);

export function detectDoublePattern(candles, cfg, atr) {
  if (!Array.isArray(candles) || candles.length < 30) return null;
  const A = atr || calcATR(candles, cfg.atrPeriod || 14) || 0;
  if (!(A > 0)) return null;

  const left = Math.max(2, Math.min(5, Math.round((cfg.minSwingSeparationBars || 5) / 2)));
  const swings = findSwings(candles, left, left);
  if (swings.length < 4) return null;

  const minSep = cfg.minSwingSeparationBars || 5;
  const maxSep = cfg.maxSwingSeparationBars || 80;
  const maxAfter = cfg.maxBarsAfterSecond ?? 30;
  const minH = (cfg.minPatternHeightATR ?? 1.0) * A;
  const simPct = (cfg.lowSimilarityPercent ?? 1.0) / 100;
  const lastI = candles.length - 1;

  const highs = swings.filter((s) => s.type === 'H').slice(-14);
  const lows = swings.filter((s) => s.type === 'L').slice(-14);
  let best = null;

  // Double Bottom LONG
  for (let i = 0; i < lows.length - 1; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      const l1 = lows[i];
      const l2 = lows[j];
      const sep = l2.i - l1.i;
      if (sep < minSep || sep > maxSep) continue;
      if (lastI - l2.i > maxAfter) continue;
      const avg = (l1.price + l2.price) / 2;
      if (Math.abs(l2.price - l1.price) / avg > simPct) continue;

      let neckPrice = -Infinity;
      let neckI = -1;
      for (let k = l1.i; k <= l2.i; k++) {
        if (candles[k].high > neckPrice) {
          neckPrice = candles[k].high;
          neckI = k;
        }
      }
      if (!finite(neckPrice) || neckI < 0) continue;
      const height = neckPrice - avg;
      if (height < minH) continue;
      // Must have a mid swing high (rally between lows)
      if (!highs.some((h) => h.i > l1.i && h.i < l2.i)) continue;

      const equality = 1 - Math.min(1, Math.abs(l2.price - l1.price) / (avg * simPct || 1e-9));
      const heightScore = Math.min(1, height / (A * 3));
      const freshness = 1 - Math.min(1, (lastI - l2.i) / maxAfter);
      const quality = 0.35 * equality + 0.35 * heightScore + 0.3 * freshness;

      const candidate = {
        type: 'DOUBLE_BOTTOM',
        direction: 'LONG',
        firstPoint: { i: l1.i, price: l1.price, time: l1.time },
        secondPoint: { i: l2.i, price: l2.price, time: l2.time },
        neckline: { i: neckI, price: neckPrice, time: candles[neckI]?.time },
        height,
        heightATR: height / A,
        quality: +quality.toFixed(3),
        avgExtreme: avg,
      };
      if (!best || candidate.quality > best.quality) best = candidate;
    }
  }

  // Double Top SHORT
  for (let i = 0; i < highs.length - 1; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      const h1 = highs[i];
      const h2 = highs[j];
      const sep = h2.i - h1.i;
      if (sep < minSep || sep > maxSep) continue;
      if (lastI - h2.i > maxAfter) continue;
      const avg = (h1.price + h2.price) / 2;
      if (Math.abs(h2.price - h1.price) / avg > simPct) continue;

      let neckPrice = Infinity;
      let neckI = -1;
      for (let k = h1.i; k <= h2.i; k++) {
        if (candles[k].low < neckPrice) {
          neckPrice = candles[k].low;
          neckI = k;
        }
      }
      if (!finite(neckPrice) || neckI < 0) continue;
      const height = avg - neckPrice;
      if (height < minH) continue;
      if (!lows.some((l) => l.i > h1.i && l.i < h2.i)) continue;

      const equality = 1 - Math.min(1, Math.abs(h2.price - h1.price) / (avg * simPct || 1e-9));
      const heightScore = Math.min(1, height / (A * 3));
      const freshness = 1 - Math.min(1, (lastI - h2.i) / maxAfter);
      const quality = 0.35 * equality + 0.35 * heightScore + 0.3 * freshness;

      const candidate = {
        type: 'DOUBLE_TOP',
        direction: 'SHORT',
        firstPoint: { i: h1.i, price: h1.price, time: h1.time },
        secondPoint: { i: h2.i, price: h2.price, time: h2.time },
        neckline: { i: neckI, price: neckPrice, time: candles[neckI]?.time },
        height,
        heightATR: height / A,
        quality: +quality.toFixed(3),
        avgExtreme: avg,
      };
      if (!best || candidate.quality > best.quality) best = candidate;
    }
  }

  return best;
}

export function analyzeHtfContext(htfCandles, direction) {
  const struct = detectStructure(htfCandles);
  const bias = struct?.bias || 'neutral';
  const isLong = direction === 'LONG';
  let aligned = false;
  let score = 0;
  if (isLong) {
    if (bias === 'bullish') { aligned = true; score = 2; }
    else if (bias === 'neutral' || struct?.choch === 'bullish') { aligned = true; score = 1; }
  } else {
    if (bias === 'bearish') { aligned = true; score = 2; }
    else if (bias === 'neutral' || struct?.choch === 'bearish') { aligned = true; score = 1; }
  }
  return {
    bias,
    bos: struct?.bos || null,
    choch: struct?.choch || null,
    aligned,
    points: score, // 0-2 for scoring (+2 max in table when aligned well)
  };
}

export function analyzeLiquidity(candles, pattern, atr) {
  const swings = findSwings(candles, 3, 3);
  const liq = detectLiquidity(candles, swings);
  const isLong = pattern.direction === 'LONG';
  const level = pattern.secondPoint.price;
  let sweep = false;
  let detail = null;

  // Pattern-local sweep around second extreme
  const from = Math.max(0, pattern.secondPoint.i - 2);
  const to = Math.min(candles.length - 1, pattern.secondPoint.i + 8);
  for (let i = from; i <= to; i++) {
    const c = candles[i];
    if (isLong && c.low < level - atr * 0.05) {
      for (let j = i + 1; j <= to; j++) {
        if (candles[j].close > level) {
          sweep = true;
          detail = { side: 'sell', level, extreme: c.low, time: c.time };
          break;
        }
      }
    }
    if (!isLong && c.high > level + atr * 0.05) {
      for (let j = i + 1; j <= to; j++) {
        if (candles[j].close < level) {
          sweep = true;
          detail = { side: 'buy', level, extreme: c.high, time: c.time };
          break;
        }
      }
    }
    if (sweep) break;
  }

  if (!sweep) {
    if (isLong && liq.bullishSweep) {
      sweep = true;
      detail = liq.sweepDetail;
    }
    if (!isLong && liq.bearishSweep) {
      sweep = true;
      detail = liq.sweepDetail;
    }
  }

  return {
    sweep,
    detail,
    equalHighs: liq.equalHighs?.length || 0,
    equalLows: liq.equalLows?.length || 0,
    points: sweep ? 2 : 0,
  };
}

export function analyzeSmc(candles, direction, pattern) {
  const struct = detectStructure(candles);
  const fvgs = detectFVGs(candles).filter((f) => f.status !== 'FILLED').slice(-8);
  const obs = detectOrderBlocks(candles, 60).slice(-8);
  const isLong = direction === 'LONG';

  const bosOk = isLong ? struct.bos === 'bullish' || struct.choch === 'bullish' : struct.bos === 'bearish' || struct.choch === 'bearish';
  const chochOk = isLong ? struct.choch === 'bullish' : struct.choch === 'bearish';

  const relevantFvg = fvgs.find((f) =>
    isLong ? f.type === 'bullish' && f.index >= (pattern.secondPoint.i || 0) : f.type === 'bearish' && f.index >= (pattern.secondPoint.i || 0)
  );
  const relevantOb = obs.find((o) =>
    isLong ? o.type === 'bullish' : o.type === 'bearish'
  );

  let bosPoints = 0;
  if (bosOk) bosPoints = 2;
  else if (chochOk) bosPoints = 1;

  const obFvgPoints = relevantOb || relevantFvg ? 1 : 0;

  return {
    bias: struct.bias,
    bos: struct.bos,
    choch: struct.choch,
    bosOk,
    chochOk,
    orderBlock: relevantOb
      ? { type: relevantOb.type, high: relevantOb.high, low: relevantOb.low, time: relevantOb.time }
      : null,
    fvg: relevantFvg
      ? { type: relevantFvg.type, high: relevantFvg.high, low: relevantFvg.low, time: relevantFvg.time }
      : null,
    bosPoints,
    obFvgPoints,
  };
}

export function analyzeFibonacci(candles, pattern) {
  const isLong = pattern.direction === 'LONG';
  // Swing: first extreme → neckline
  const swingLow = isLong ? pattern.firstPoint.price : pattern.neckline.price;
  const swingHigh = isLong ? pattern.neckline.price : pattern.firstPoint.price;
  const range = Math.abs(swingHigh - swingLow);
  if (!(range > 0)) return { confluence: false, level: null, points: 0 };

  const ratios = [0.5, 0.618, 0.786];
  const second = pattern.secondPoint.price;
  let best = null;
  for (const r of ratios) {
    const price = isLong
      ? swingHigh - range * r
      : swingLow + range * r;
    const dist = Math.abs(second - price) / range;
    if (dist <= 0.08) {
      if (!best || dist < best.dist) best = { ratio: r, price, dist };
    }
  }
  return {
    confluence: !!best,
    level: best,
    zone: best ? { low: Math.min(second, best.price), high: Math.max(second, best.price), ratio: best.ratio } : null,
    points: best ? 1 : 0,
  };
}

export function analyzeBreakout(candles, pattern, cfg) {
  const neck = pattern.neckline.price;
  const isLong = pattern.direction === 'LONG';
  const after = candles.slice(pattern.secondPoint.i + 1);
  if (!after.length) return { confirmed: false, points: 0 };

  const type = cfg.breakoutConfirmType || 'close';
  let confirmed = false;
  let breakCandle = null;

  for (let i = 0; i < after.length; i++) {
    const c = after[i];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low || 1e-9;
    const strong = body / range >= 0.55;
    const broke = isLong ? c.close > neck : c.close < neck;
    if (!broke) continue;

    if (type === 'close') {
      confirmed = true;
      breakCandle = c;
      break;
    }
    if (type === 'strong_body' && strong) {
      confirmed = true;
      breakCandle = c;
      break;
    }
    if (type === 'multi_candle') {
      // need this + next also beyond neckline
      if (i + 1 < after.length) {
        const n = after[i + 1];
        if (isLong ? n.close > neck : n.close < neck) {
          confirmed = true;
          breakCandle = n;
          break;
        }
      }
    }
  }

  return {
    confirmed,
    breakCandle: breakCandle
      ? { time: breakCandle.time, close: breakCandle.close }
      : null,
    points: confirmed ? 2 : 0,
  };
}

export function analyzeRetest(candles, pattern, breakout, smc) {
  if (!breakout.confirmed) return { confirmed: false, points: 0 };
  const isLong = pattern.direction === 'LONG';
  const neck = pattern.neckline.price;
  const levels = [neck];
  if (smc.orderBlock) levels.push((smc.orderBlock.high + smc.orderBlock.low) / 2);
  if (smc.fvg) levels.push((smc.fvg.high + smc.fvg.low) / 2);

  const afterBreak = candles.filter((c) =>
    breakout.breakCandle?.time != null ? c.time >= breakout.breakCandle.time : true
  );
  if (afterBreak.length < 2) return { confirmed: false, points: 0 };

  for (const c of afterBreak.slice(1)) {
    for (const lvl of levels) {
      const tol = Math.abs(lvl) * 0.003;
      if (isLong) {
        if (c.low <= lvl + tol && c.close >= lvl - tol) {
          return { confirmed: true, level: lvl, time: c.time, points: 2 };
        }
      } else {
        if (c.high >= lvl - tol && c.close <= lvl + tol) {
          return { confirmed: true, level: lvl, time: c.time, points: 2 };
        }
      }
    }
  }
  return { confirmed: false, points: 0 };
}

export function analyzeLtfConfirm(candles, direction) {
  if (!candles?.length) return { confirmed: false, type: null };
  const last = candles[candles.length - 1];
  const prev = candles.length > 1 ? candles[candles.length - 2] : null;
  const isLong = direction === 'LONG';
  const range = last.high - last.low || 1e-9;
  const body = Math.abs(last.close - last.open);
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;

  if (isLong) {
    if (lower > body * 1.2 && lower > range * 0.35 && last.close > last.open) {
      return { confirmed: true, type: 'rejection_candle' };
    }
    if (prev && last.close > last.open && prev.close < prev.open && last.close > prev.open && last.open < prev.close) {
      return { confirmed: true, type: 'engulfing' };
    }
    if (body / range >= 0.6 && last.close > last.open) {
      return { confirmed: true, type: 'strong_close' };
    }
  } else {
    if (upper > body * 1.2 && upper > range * 0.35 && last.close < last.open) {
      return { confirmed: true, type: 'rejection_candle' };
    }
    if (prev && last.close < last.open && prev.close > prev.open && last.close < prev.open && last.open > prev.close) {
      return { confirmed: true, type: 'engulfing' };
    }
    if (body / range >= 0.6 && last.close < last.open) {
      return { confirmed: true, type: 'strong_close' };
    }
  }
  return { confirmed: false, type: null };
}
