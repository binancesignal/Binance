import {
  calcATR,
  findSwings,
  premiumDiscount,
  relativeVolume,
} from '../../indicators.js';
import { detectFVGs } from '../../fvg.js';
import { detectStructure } from '../../structure.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function directionData(candles, swings, direction, atr, cfg) {
  const bullish = direction === 'LONG';
  const sweepSide = bullish ? 'L' : 'H';
  const breakSide = bullish ? 'H' : 'L';
  const lookback = clamp(Math.round(+cfg.sweepLookbackBars || 32), 8, 80);
  const maxBosAge = clamp(Math.round(+cfg.maxBosAgeBars || 20), 4, 48);
  const start = Math.max(0, candles.length - lookback);
  const pivots = swings.filter((s) => s.type === sweepSide && s.i < candles.length - 3);
  const sweeps = [];

  for (const pivot of pivots) {
    for (let i = Math.max(start, pivot.i + 3); i < candles.length - 3; i++) {
      const candle = candles[i];
      const buffer = Math.max(atr * 0.03, Math.abs(pivot.price) * 0.0001);
      const raided = bullish
        ? candle.low < pivot.price - buffer && candle.close > pivot.price
        : candle.high > pivot.price + buffer && candle.close < pivot.price;
      if (raided) {
        sweeps.push({
          index: i,
          level: pivot.price,
          extreme: bullish ? candle.low : candle.high,
          pivotIndex: pivot.i,
        });
      }
    }
  }

  // Prefer the latest valid raid, then require a confirmed opposite swing and
  // a candle close through it. This prevents intrabar wick breaks from counting.
  sweeps.sort((a, b) => b.index - a.index);
  for (const sweep of sweeps) {
    const oppositePivots = swings
      .filter(
        (s) =>
          s.type === breakSide &&
          s.i > sweep.index &&
          s.i < candles.length - 2 &&
          s.i - sweep.index <= maxBosAge
      )
      .sort((a, b) => a.i - b.i);

    for (const pivot of oppositePivots) {
      for (let i = pivot.i + 3; i < candles.length; i++) {
        if (i - sweep.index > maxBosAge) break;
        const candle = candles[i];
        const breakBuffer = Math.max(atr * 0.025, Math.abs(pivot.price) * 0.00008);
        const body = Math.abs(candle.close - candle.open);
        const range = Math.max(candle.high - candle.low, 1e-12);
        const closeLocation = bullish
          ? (candle.close - candle.low) / range
          : (candle.high - candle.close) / range;
        const closesThrough = bullish
          ? candle.close > pivot.price + breakBuffer
          : candle.close < pivot.price - breakBuffer;
        const displacement =
          (bullish ? candle.close > candle.open : candle.close < candle.open) &&
          (body >= atr * 0.3 || (range >= atr * 0.45 && closeLocation >= 0.72));
        if (closesThrough && displacement) {
          return {
            sweep,
            bos: {
              index: i,
              level: pivot.price,
              close: candle.close,
              time: candle.time,
              displacement: body,
            },
          };
        }
      }
    }
  }
  return null;
}

function findPointOfInterest(candles, sequence, direction, atr) {
  const bullish = direction === 'LONG';
  const { sweep, bos } = sequence;
  const earliest = Math.max(sweep.index + 1, bos.index - 8);
  let orderBlock = null;

  for (let i = bos.index - 1; i >= earliest; i--) {
    const candle = candles[i];
    const opposing = bullish ? candle.close < candle.open : candle.close > candle.open;
    const body = Math.abs(candle.close - candle.open);
    if (!opposing || body < atr * 0.04) continue;
    const zone = bullish
      ? { low: candle.low, high: Math.max(candle.open, candle.close) }
      : { low: Math.min(candle.open, candle.close), high: candle.high };
    if (zone.high <= zone.low) continue;
    orderBlock = {
      ...zone,
      mid: (zone.low + zone.high) / 2,
      index: i,
      time: candle.time,
      type: bullish ? 'bullish' : 'bearish',
      status: 'FRESH',
      tests: 0,
      displacement: bos.displacement,
      strength: 75,
    };
    break;
  }

  const fvg = detectFVGs(candles)
    .filter((item) => {
      if (item.type !== (bullish ? 'bullish' : 'bearish')) return false;
      if (item.index < Math.max(sweep.index + 2, bos.index - 4) || item.index > bos.index) return false;
      return bullish
        ? candles.slice(item.index + 1).every((c) => c.close >= item.low)
        : candles.slice(item.index + 1).every((c) => c.close <= item.high);
    })
    .sort((a, b) => b.index - a.index)[0] || null;

  // Prefer an OB/FVG confluence zone. If they do not overlap, use the most
  // recent OB; the FVG remains separately visible as confluence on the chart.
  let poi = orderBlock;
  let poiType = orderBlock ? 'ORDER_BLOCK' : null;
  if (orderBlock && fvg && fvg.low <= orderBlock.high && fvg.high >= orderBlock.low) {
    const low = Math.max(orderBlock.low, fvg.low);
    const high = Math.min(orderBlock.high, fvg.high);
    if (high > low) {
      poi = { ...orderBlock, low, high, mid: (low + high) / 2 };
      poiType = 'OB_FVG_CONFLUENCE';
    }
  } else if (!orderBlock && fvg) {
    poi = {
      low: fvg.low,
      high: fvg.high,
      mid: (fvg.low + fvg.high) / 2,
      index: fvg.index,
      time: fvg.time,
      type: bullish ? 'bullish' : 'bearish',
      status: fvg.status,
      tests: 0,
      displacement: bos.displacement,
      strength: 65,
    };
    poiType = 'FAIR_VALUE_GAP';
  }

  if (!poi) return null;
  const invalidated = candles
    .slice(poi.index + 1)
    .some((c) => bullish ? c.close < poi.low : c.close > poi.high);
  if (invalidated) return null;

  return { poi, orderBlock, fvg, poiType };
}

/**
 * ICT-inspired 15m setup:
 * closed-candle liquidity raid → displacement close through a confirmed swing
 * (BOS) → fresh order-block/FVG point of interest. This is a rules-based scan,
 * not a claim that a setup is profitable.
 */
export function runIctSmcStrategy({
  symbol,
  setupCandles,
  htfCandles,
  price,
  cfg = {},
  setupTf = '15m',
  htfTf = '1h',
}) {
  const candles = (setupCandles || []).filter(
    (c) => Number.isFinite(+c.open) && Number.isFinite(+c.high) &&
      Number.isFinite(+c.low) && Number.isFinite(+c.close)
  );
  const higher = (htfCandles || []).filter(
    (c) => Number.isFinite(+c.open) && Number.isFinite(+c.high) &&
      Number.isFinite(+c.low) && Number.isFinite(+c.close)
  );
  if (candles.length < 30 || higher.length < 12 || !(+price > 0)) return [];

  const atr = calcATR(candles, 14);
  if (!(atr > 0)) return [];
  const swings = findSwings(candles, 2, 2);
  const htfStructure = detectStructure(higher);
  const htfAligned = (direction) =>
    htfStructure.bias === (direction === 'LONG' ? 'bullish' : 'bearish') ||
    htfStructure.bos === (direction === 'LONG' ? 'bullish' : 'bearish') ||
    htfStructure.choch === (direction === 'LONG' ? 'bullish' : 'bearish');

  const candidates = [];
  for (const direction of ['LONG', 'SHORT']) {
    const sequence = directionData(candles, swings, direction, atr, cfg);
    if (!sequence) continue;
    const ageBars = candles.length - 1 - sequence.bos.index;
    if (ageBars > clamp(Math.round(+cfg.maxBosAgeBars || 20), 4, 48)) continue;
    const poiResult = findPointOfInterest(candles, sequence, direction, atr);
    if (!poiResult) continue;

    const { poi, fvg, poiType } = poiResult;
    const current = +price;
    const bullish = direction === 'LONG';
    const buffer = Math.max(atr * 0.18, current * 0.0004);
    const sl = bullish ? poi.low - buffer : poi.high + buffer;
    const risk = Math.abs(poi.mid - sl);
    if (!(risk > 0)) continue;
    const tp1 = poi.mid + (bullish ? 1 : -1) * risk * 1.5;
    const tp2 = poi.mid + (bullish ? 1 : -1) * risk * 2.5;
    const tp3 = poi.mid + (bullish ? 1 : -1) * risk * 3.5;

    // Ignore a setup that has already invalidated or completed its first target.
    if (
      bullish
        ? current <= sl || current >= tp1 || current <= poi.mid
        : current >= sl || current <= tp1 || current >= poi.mid
    ) continue;

    const pd = premiumDiscount(candles);
    const rvol = relativeVolume(candles);
    const aligned = htfAligned(direction);
    const hasFvg = !!fvg;
    const conf = [
      `${bullish ? 'Sell-side' : 'Buy-side'} liquidity swept`,
      `${bullish ? 'Bullish' : 'Bearish'} BOS on candle close`,
      `Fresh ${poiType.replace(/_/g, ' ')} POI`,
      'Displacement confirmed',
    ];
    if (aligned) conf.push(`${htfTf} bias aligned`);
    if (hasFvg) conf.push(`${fvg.type} FVG`);
    if ((bullish && pd.zone === 'DISCOUNT') || (!bullish && pd.zone === 'PREMIUM')) {
      conf.push(bullish ? 'Discount zone' : 'Premium zone');
    }
    if (rvol >= 1.3) conf.push(`Relative volume ${rvol.toFixed(2)}x`);

    const score = Math.min(
      100,
      20 + // sweep
      25 + // confirmed BOS close
      20 + // fresh POI
      10 + // displacement
      (aligned ? 10 : 0) +
      (hasFvg ? 6 : 0) +
      ((bullish && pd.zone === 'DISCOUNT') || (!bullish && pd.zone === 'PREMIUM') ? 5 : 0) +
      (rvol >= 1.3 ? 4 : 0)
    );
    const latestHigh = swings.filter((s) => s.type === 'H').at(-1)?.price ?? null;
    const latestLow = swings.filter((s) => s.type === 'L').at(-1)?.price ?? null;
    const sweepCandle = candles[sequence.sweep.index];
    const liq = {
      equalHighs: [],
      equalLows: [],
      buySide: latestHigh,
      sellSide: latestLow,
      bullishSweep: bullish,
      bearishSweep: !bullish,
      sweepDetail: {
        side: bullish ? 'sell' : 'buy',
        level: sequence.sweep.level,
        ...(bullish
          ? { sweepLow: sweepCandle.low }
          : { sweepHigh: sweepCandle.high }),
      },
    };

    candidates.push({
      symbol,
      dir: direction,
      strategy: 'ict_smc',
      score,
      qualifies: true,
      conf,
      ob: poi,
      fvgs: fvg ? [fvg] : [],
      liq,
      structure: {
        ...htfStructure,
        bias: bullish ? 'bullish' : 'bearish',
        bos: bullish ? 'bullish' : 'bearish',
        setupTf,
      },
      pd,
      rvol,
      entry: poi.mid,
      sl,
      tp1,
      tp2,
      tp3,
      rr: '1.5',
      price: current,
      quality: {
        htfAligned: aligned,
        hasLiqEdge: true,
        hasSweep: true,
        hasFvg,
        displacement: true,
        fibOte: false,
        rsiDiv: false,
        strongSetup: true,
        ictSequence: true,
      },
      metadata: {
        strategy: 'ict_smc',
        patternTf: setupTf,
        htf: htfTf,
        obTf: setupTf,
        conf,
        ob: poi,
        fvgs: fvg ? [fvg] : [],
        liq,
        pd,
        rvol,
        structure: {
          ...htfStructure,
          bias: bullish ? 'bullish' : 'bearish',
          bos: bullish ? 'bullish' : 'bearish',
        },
        ictAnalysis: {
          setupTf,
          htfTf,
          sequence: 'LIQUIDITY_SWEEP → BOS_CLOSE → POI_RETRACE',
          sweepSide: bullish ? 'SELL_SIDE' : 'BUY_SIDE',
          sweepLevel: sequence.sweep.level,
          sweepExtreme: sequence.sweep.extreme,
          sweepTime: sweepCandle.time,
          bosLevel: sequence.bos.level,
          bosClose: sequence.bos.close,
          bosTime: sequence.bos.time,
          poiType,
          poiLow: poi.low,
          poiHigh: poi.high,
          atr,
          ageBars,
          htfBias: htfStructure.bias,
          htfAligned: aligned,
        },
      },
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}