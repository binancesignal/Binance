/**
 * Scoring logic preserved from original scanner.
 * Do not arbitrarily change weights.
 */
import { detectStructure } from './structure.js';
import { detectOrderBlocks } from './orderBlocks.js';
import { detectFVGs } from './fvg.js';
import { detectLiquidity } from './liquidity.js';
import {
  findSwings,
  relativeVolume,
  premiumDiscount,
  calcEMA,
  calcRSI,
  detectRsiDivergence,
  fibConfluence,
  detectChartPatterns,
  calcATR,
} from './indicators.js';
import { SIGNAL_CONFIG } from '../config/signalConfig.js';

export function scoreSetup(symbol, htfCandles, obCandles, entryStyle, threshold, price, opts = {}) {
  const includeAll = !!opts.includeAll;
  const htfStruct = detectStructure(htfCandles);
  const obs = detectOrderBlocks(obCandles);
  const fvgs = detectFVGs(obCandles);
  const swings = findSwings(obCandles);
  const liq = detectLiquidity(obCandles, swings);
  const pd = premiumDiscount(obCandles);
  const rvol = relativeVolume(obCandles);
  const ema20 = calcEMA(obCandles, 20);
  const rsi = calcRSI(obCandles);
  const divergence = detectRsiDivergence(obCandles);
  const atrOb = calcATR(obCandles, 14) || 0;

  const results = [];
  const style = entryStyle || SIGNAL_CONFIG.entryStyle;
  const minScore = threshold ?? SIGNAL_CONFIG.minScore;

  for (const ob of obs) {
    if (ob.status === 'INVALIDATED') continue;

    // LONG
    if (ob.type === 'bullish') {
      let score = 0;
      const conf = [];

      if (htfStruct.bias === 'bullish' || htfStruct.bos === 'bullish') {
        score += 15;
        conf.push('HTF Bullish');
      } else if (htfStruct.choch === 'bullish') {
        score += 10;
        conf.push('HTF CHOCH↑');
      } else if (htfStruct.bias === 'neutral') score += 5;

      score += Math.min(20, ob.strength * 0.2);
      conf.push(`OB ${ob.status} (${ob.strength.toFixed(0)})`);

      let liqScore = 0;
      let hasLiqEdge = false;
      if (liq.bullishSweep) {
        liqScore = 18;
        hasLiqEdge = true;
        conf.push('Liquidity Sweep↑');
      } else if (liq.sellSide && price > liq.sellSide * 0.998) {
        liqScore = 12;
        hasLiqEdge = true;
        conf.push('Near Sell-side Liq');
      }
      if (liq.equalLows.length) {
        liqScore = Math.max(liqScore, hasLiqEdge ? liqScore : 8);
        if (!conf.includes('Equal Lows')) conf.push('Equal Lows');
        hasLiqEdge = true;
      }
      score += liqScore;

      if (htfStruct.bos === 'bullish' || htfStruct.choch === 'bullish') {
        score += 15;
        conf.push('Bullish BOS/CHOCH');
      } else if (htfStruct.bias === 'bullish') score += 8;

      const nearFVG = fvgs.find(
        (f) => f.type === 'bullish' && f.low <= ob.high && f.high >= ob.low
      );
      if (nearFVG) {
        score += 10;
        conf.push('FVG overlap');
      } else if (fvgs.some((f) => f.type === 'bullish' && f.status === 'OPEN')) {
        score += 5;
        conf.push('Bullish FVG');
      }

      if (ob.displacement > 0) {
        score += Math.min(10, ob.displacement * 2);
        conf.push('Displacement');
      }
      if (ob.volumeExp || rvol > 1.4) {
        score += 5;
        conf.push('Vol expansion');
      } else if (rvol > 1.1) score += 2;

      if (pd.zone === 'DISCOUNT') {
        score += 5;
        conf.push('Discount');
      } else if (pd.zone === 'EQUILIBRIUM') score += 2;

      if (ema20 && price > ema20) {
        score += 3;
        conf.push('Above EMA20');
      }
      if (rsi > 45 && rsi < 70) score += 2;

      // --- Confluence layer (Fib OTE / RSI div / chart patterns) ---
      const entryEst =
        style === 'aggressive'
          ? ob.mid
          : style === 'conservative'
            ? ob.low + (ob.high - ob.low) * 0.3
            : ob.low + (ob.high - ob.low) * 0.4;
      const fib = fibConfluence(obCandles, swings, entryEst, 'LONG');
      if (fib.deepOte) {
        score += 10;
        conf.push('Fib OTE');
      } else if (fib.inOte) {
        score += 6;
        conf.push('Fib zone');
      }
      if (divergence.bullish) {
        score += 8;
        conf.push('RSI Div↑');
      }
      const pat = detectChartPatterns(swings, 'LONG');
      if (pat.doubleBottom) {
        score += 6;
        conf.push('Double Bottom');
      } else if (pat.structure === 'HH-HL') {
        score += 4;
        conf.push('HH-HL');
      }

      score += 3;
      score = Math.min(100, Math.round(score));

      if (includeAll || score >= minScore) {
        // Conservative entry deeper in OB (less premature fill into wick)
        const entry =
          style === 'aggressive'
            ? ob.mid
            : style === 'conservative'
              ? ob.low + (ob.high - ob.low) * 0.25
              : ob.low + (ob.high - ob.low) * 0.35;
        // ATR-aware SL beyond OB — fixed 0.15% was noise food on alts
        const slBufPct = (SIGNAL_CONFIG.slBufferPercent ?? 0.25) / 100;
        const slBufAtr = (SIGNAL_CONFIG.slBufferATR ?? 0.35) * (atrOb || 0);
        const slBuf = Math.max(ob.low * slBufPct, slBufAtr, (ob.high - ob.low) * 0.15);
        const sl = ob.low - slBuf;
        const risk = entry - sl;
        // Intraday target: TP1 at least ~2% (or 1.8R if larger)
        const minTp1 = entry * ((SIGNAL_CONFIG.minTp1Percent ?? 2) / 100);
        const r1 = SIGNAL_CONFIG.tp1R ?? 1.8;
        const r2 = SIGNAL_CONFIG.tp2R ?? 3.0;
        const r3 = SIGNAL_CONFIG.tp3R ?? 4.5;
        const tp1 = entry + Math.max(risk * r1, minTp1);
        const tp2 = entry + Math.max(risk * r2, minTp1 * 1.5);
        const tp3 = entry + Math.max(risk * r3, minTp1 * 2.25);
        const rr = risk > 0 ? ((tp1 - entry) / risk).toFixed(1) : '—';

        const htfAligned =
          htfStruct.bias === 'bullish' ||
          htfStruct.bos === 'bullish' ||
          htfStruct.choch === 'bullish';
        results.push({
          symbol,
          dir: 'LONG',
          score,
          qualifies: score >= minScore,
          conf,
          ob,
          fvgs: nearFVG ? [nearFVG] : [],
          liq,
          structure: htfStruct,
          pd,
          rvol,
          entry,
          sl,
          tp1,
          tp2,
          tp3,
          rr,
          price,
          quality: {
            htfAligned,
            hasLiqEdge: !!hasLiqEdge,
            hasSweep: !!liq.bullishSweep,
            hasFvg: !!nearFVG,
            displacement: !!(ob.displacement > 0),
            fibOte: !!(fib.deepOte || fib.inOte),
            rsiDiv: !!divergence.bullish,
            chartPattern: pat.label || null,
            strongSetup: !!(htfAligned && hasLiqEdge && (liq.bullishSweep || nearFVG) && (ob.displacement > 0 || fib.deepOte || divergence.bullish)),
          },
          fib,
          divergence,
          pattern: pat,
        });
      }
    }

    // SHORT
    if (ob.type === 'bearish') {
      let score = 0;
      const conf = [];

      if (htfStruct.bias === 'bearish' || htfStruct.bos === 'bearish') {
        score += 15;
        conf.push('HTF Bearish');
      } else if (htfStruct.choch === 'bearish') {
        score += 10;
        conf.push('HTF CHOCH↓');
      } else if (htfStruct.bias === 'neutral') score += 5;

      score += Math.min(20, ob.strength * 0.2);
      conf.push(`OB ${ob.status} (${ob.strength.toFixed(0)})`);

      let liqScore = 0;
      let hasLiqEdge = false;
      if (liq.bearishSweep) {
        liqScore = 18;
        hasLiqEdge = true;
        conf.push('Liquidity Sweep↓');
      } else if (liq.buySide && price < liq.buySide * 1.002) {
        liqScore = 12;
        hasLiqEdge = true;
        conf.push('Near Buy-side Liq');
      }
      if (liq.equalHighs.length) {
        liqScore = Math.max(liqScore, hasLiqEdge ? liqScore : 8);
        if (!conf.includes('Equal Highs')) conf.push('Equal Highs');
        hasLiqEdge = true;
      }
      score += liqScore;

      if (htfStruct.bos === 'bearish' || htfStruct.choch === 'bearish') {
        score += 15;
        conf.push('Bearish BOS/CHOCH');
      } else if (htfStruct.bias === 'bearish') score += 8;

      const nearFVG = fvgs.find(
        (f) => f.type === 'bearish' && f.low <= ob.high && f.high >= ob.low
      );
      if (nearFVG) {
        score += 10;
        conf.push('FVG overlap');
      } else if (fvgs.some((f) => f.type === 'bearish' && f.status === 'OPEN')) {
        score += 5;
        conf.push('Bearish FVG');
      }

      if (ob.displacement > 0) {
        score += Math.min(10, ob.displacement * 2);
        conf.push('Displacement');
      }
      if (ob.volumeExp || rvol > 1.4) {
        score += 5;
        conf.push('Vol expansion');
      } else if (rvol > 1.1) score += 2;

      if (pd.zone === 'PREMIUM') {
        score += 5;
        conf.push('Premium');
      } else if (pd.zone === 'EQUILIBRIUM') score += 2;

      if (ema20 && price < ema20) {
        score += 3;
        conf.push('Below EMA20');
      }
      if (rsi < 55 && rsi > 30) score += 2;

      const entryEst =
        style === 'aggressive'
          ? ob.mid
          : style === 'conservative'
            ? ob.high - (ob.high - ob.low) * 0.3
            : ob.high - (ob.high - ob.low) * 0.4;
      const fib = fibConfluence(obCandles, swings, entryEst, 'SHORT');
      if (fib.deepOte) {
        score += 10;
        conf.push('Fib OTE');
      } else if (fib.inOte) {
        score += 6;
        conf.push('Fib zone');
      }
      if (divergence.bearish) {
        score += 8;
        conf.push('RSI Div↓');
      }
      const pat = detectChartPatterns(swings, 'SHORT');
      if (pat.doubleTop) {
        score += 6;
        conf.push('Double Top');
      } else if (pat.structure === 'LH-LL') {
        score += 4;
        conf.push('LH-LL');
      }

      score += 3;
      score = Math.min(100, Math.round(score));

      if (includeAll || score >= minScore) {
        const entry =
          style === 'aggressive'
            ? ob.mid
            : style === 'conservative'
              ? ob.high - (ob.high - ob.low) * 0.25
              : ob.high - (ob.high - ob.low) * 0.35;
        const slBufPct = (SIGNAL_CONFIG.slBufferPercent ?? 0.25) / 100;
        const slBufAtr = (SIGNAL_CONFIG.slBufferATR ?? 0.35) * (atrOb || 0);
        const slBuf = Math.max(ob.high * slBufPct, slBufAtr, (ob.high - ob.low) * 0.15);
        const sl = ob.high + slBuf;
        const risk = sl - entry;
        const minTp1 = entry * ((SIGNAL_CONFIG.minTp1Percent ?? 2) / 100);
        const r1 = SIGNAL_CONFIG.tp1R ?? 1.8;
        const r2 = SIGNAL_CONFIG.tp2R ?? 3.0;
        const r3 = SIGNAL_CONFIG.tp3R ?? 4.5;
        const tp1 = entry - Math.max(risk * r1, minTp1);
        const tp2 = entry - Math.max(risk * r2, minTp1 * 1.5);
        const tp3 = entry - Math.max(risk * r3, minTp1 * 2.25);
        const rr = risk > 0 ? ((entry - tp1) / risk).toFixed(1) : '—';

        const htfAligned =
          htfStruct.bias === 'bearish' ||
          htfStruct.bos === 'bearish' ||
          htfStruct.choch === 'bearish';
        results.push({
          symbol,
          dir: 'SHORT',
          score,
          qualifies: score >= minScore,
          conf,
          ob,
          fvgs: nearFVG ? [nearFVG] : [],
          liq,
          structure: htfStruct,
          pd,
          rvol,
          entry,
          sl,
          tp1,
          tp2,
          tp3,
          rr,
          price,
          quality: {
            htfAligned,
            hasLiqEdge: !!hasLiqEdge,
            hasSweep: !!liq.bearishSweep,
            hasFvg: !!nearFVG,
            displacement: !!(ob.displacement > 0),
            fibOte: !!(fib.deepOte || fib.inOte),
            rsiDiv: !!divergence.bearish,
            chartPattern: pat.label || null,
            strongSetup: !!(htfAligned && hasLiqEdge && (liq.bearishSweep || nearFVG) && (ob.displacement > 0 || fib.deepOte || divergence.bearish)),
          },
          fib,
          divergence,
          pattern: pat,
        });
      }
    }
  }
  return results;
}
