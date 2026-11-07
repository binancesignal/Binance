/**
 * Rejection Engine.
 * Scores rejection quality (0–100) based on wick, failed breakout,
 * close back inside, engulfing, displacement, liquidity sweep, structure shift.
 */
import { detectStructure } from '../structure.js';
import { detectLiquidity } from '../liquidity.js';
import { findSwings, calcATR } from '../indicators.js';

export function evaluateRejection({ candles, pattern, direction, breakout, atr, liquidity }) {
  const result = {
    rejectionScore: 0,
    notes: [],
    events: [],
    hasSweep: false,
    hasRejection: false,
    hasStructureShift: false,
  };
  if (!candles?.length) return result;

  const closed = candles.slice(0, -1);
  if (closed.length < 5) return result;
  const A = atr > 0 ? atr : calcATR(closed, 14) || closed[closed.length - 1].close * 0.004;
  const long = direction === 'LONG';
  let score = 0;

  // 1. Liquidity sweep event
  const liq = liquidity || (() => {
    try {
      return detectLiquidity(closed, findSwings(closed, 3, 3));
    } catch (_) { return {}; }
  })();

  if (long && liq.bullishSweep) {
    score += 22;
    result.hasSweep = true;
    result.events.push('SELL_SIDE_SWEEP');
    result.notes.push('Sell-side liquidity swept');
  } else if (!long && liq.bearishSweep) {
    score += 22;
    result.hasSweep = true;
    result.events.push('BUY_SIDE_SWEEP');
    result.notes.push('Buy-side liquidity swept');
  }

  // 2. Wick rejection on recent candles (especially around pattern end / breakout)
  const look = Math.min(8, closed.length - 1);
  const recent = closed.slice(-look);
  let bestWick = 0;
  for (const c of recent) {
    const range = c.high - c.low || 1e-9;
    if (long) {
      const lowerWick = Math.min(c.open, c.close) - c.low;
      const ratio = lowerWick / range;
      if (ratio >= 0.55 && c.close > c.open) {
        bestWick = Math.max(bestWick, ratio);
      }
    } else {
      const upperWick = c.high - Math.max(c.open, c.close);
      const ratio = upperWick / range;
      if (ratio >= 0.55 && c.close < c.open) {
        bestWick = Math.max(bestWick, ratio);
      }
    }
  }
  if (bestWick >= 0.7) {
    score += 18;
    result.hasRejection = true;
    result.events.push('STRONG_WICK_REJECTION');
    result.notes.push(`Strong wick rejection (${(bestWick * 100).toFixed(0)}%)`);
  } else if (bestWick >= 0.55) {
    score += 10;
    result.hasRejection = true;
    result.events.push('WICK_REJECTION');
    result.notes.push('Wick rejection');
  }

  // 3. Failed breakout / close back inside (fakeout style)
  if (breakout && !breakout.ok && breakout.failed) {
    score += 20;
    result.events.push('FAILED_BREAKOUT');
    result.notes.push('Failed breakout / close back inside');
  } else if (pattern?.patternType) {
    // Check if price briefly broke a level then closed back
    const level = long ? pattern.support : pattern.resistance;
    if (level != null) {
      for (let i = recent.length - 1; i >= 0; i--) {
        const c = recent[i];
        if (long) {
          if (c.low < level - 0.05 * A && c.close > level) {
            score += 12;
            result.events.push('SPRING');
            result.notes.push('Spring (sweep below support + reclaim)');
            break;
          }
        } else {
          if (c.high > level + 0.05 * A && c.close < level) {
            score += 12;
            result.events.push('UPTHRUST');
            result.notes.push('Upthrust (sweep above resistance + reclaim)');
            break;
          }
        }
      }
    }
  }

  // 4. Engulfing structure
  if (recent.length >= 2) {
    const a = recent[recent.length - 2];
    const b = recent[recent.length - 1];
    if (long && b.close > b.open && a.close < a.open &&
        b.close > a.open && b.open < a.close &&
        (b.close - b.open) > (a.open - a.close) * 0.8) {
      score += 10;
      result.events.push('BULLISH_ENGULFING');
      result.notes.push('Bullish engulfing');
    } else if (!long && b.close < b.open && a.close > a.open &&
        b.close < a.open && b.open > a.close &&
        (b.open - b.close) > (a.close - a.open) * 0.8) {
      score += 10;
      result.events.push('BEARISH_ENGULFING');
      result.notes.push('Bearish engulfing');
    }
  }

  // 5. Displacement (strong directional candle)
  const last = recent[recent.length - 1];
  if (last) {
    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low || 1e-9;
    if (body / range >= 0.65 && body >= A * 0.4) {
      if ((long && last.close > last.open) || (!long && last.close < last.open)) {
        score += 8;
        result.events.push('DISPLACEMENT');
        result.notes.push('Displacement candle');
      }
    }
  }

  // 6. Structure shift (CHOCH / BOS)
  try {
    const st = detectStructure(closed.slice(-50));
    const want = long ? 'bullish' : 'bearish';
    if (st.choch === want) {
      score += 15;
      result.hasStructureShift = true;
      result.events.push('CHOCH');
      result.notes.push(`CHOCH ${want}`);
    } else if (st.bos === want) {
      score += 10;
      result.hasStructureShift = true;
      result.events.push('BOS');
      result.notes.push(`BOS ${want}`);
    }
  } catch (_) {}

  // 7. Bonus if rejection occurs inside a meaningful zone (caller can boost further)
  result.rejectionScore = Math.max(0, Math.min(100, Math.round(score)));
  return result;
}
