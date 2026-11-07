/**
 * Universal Location Engine.
 * Scores how meaningful the pattern location is (0–100).
 * Patterns at extremes / HTF zones score high; mid-range score low.
 */
import { detectOrderBlocks } from '../orderBlocks.js';
import { detectFVGs } from '../fvg.js';
import { detectLiquidity } from '../liquidity.js';
import { findSwings, premiumDiscount, calcATR } from '../indicators.js';
import { detectStructure } from '../structure.js';

/**
 * Build a location assessment for a pattern/setup.
 * @param {object} opts
 * @param {Array} opts.candles - closed candles on pattern TF
 * @param {Array} opts.htfCandles - higher TF candles
 * @param {object} opts.pattern - pattern object
 * @param {string} opts.direction - LONG | SHORT
 * @param {number} opts.price - current price
 * @param {number} opts.atr
 */
export function evaluateLocation({ candles, htfCandles, pattern, direction, price, atr }) {
  const result = {
    locationScore: 0,
    notes: [],
    factors: [],
    isExtreme: false,
    isMidRange: false,
    premiumDiscount: null,
    nearestZones: [],
  };
  if (!candles?.length || !pattern) return result;

  const closed = candles.slice(0, -1);
  const A = atr > 0 ? atr : calcATR(closed, 14) || price * 0.004;
  const long = direction === 'LONG';
  const base = long ? (pattern.support ?? pattern.neckline) : (pattern.resistance ?? pattern.neckline);
  const evalPrice = base != null ? base : price;

  let score = 0;

  // 1. Premium / Discount
  let pd = { pos: 0.5 };
  try { pd = premiumDiscount(htfCandles?.length ? htfCandles : closed); } catch (_) {}
  result.premiumDiscount = pd.pos;
  if (long && pd.pos <= 0.35) {
    score += 18;
    result.notes.push('Discount zone');
    result.factors.push({ kind: 'DISCOUNT', weight: 18 });
  } else if (!long && pd.pos >= 0.65) {
    score += 18;
    result.notes.push('Premium zone');
    result.factors.push({ kind: 'PREMIUM', weight: 18 });
  } else if (long && pd.pos >= 0.65) {
    score -= 12;
    result.notes.push('Long into premium (weak location)');
  } else if (!long && pd.pos <= 0.35) {
    score -= 12;
    result.notes.push('Short into discount (weak location)');
  } else {
    score += 2;
    result.isMidRange = true;
    result.notes.push('Mid-range location');
  }

  // 2. HTF structure alignment
  let htfStruct = { bias: 'neutral' };
  try { htfStruct = detectStructure(htfCandles?.length ? htfCandles : closed); } catch (_) {}
  if (long && (htfStruct.bias === 'bullish' || htfStruct.bos === 'bullish' || htfStruct.choch === 'bullish')) {
    score += 12;
    result.notes.push('HTF bullish structure');
    result.factors.push({ kind: 'HTF_BULL', weight: 12 });
  } else if (!long && (htfStruct.bias === 'bearish' || htfStruct.bos === 'bearish' || htfStruct.choch === 'bearish')) {
    score += 12;
    result.notes.push('HTF bearish structure');
    result.factors.push({ kind: 'HTF_BEAR', weight: 12 });
  } else if (htfStruct.bias !== 'neutral') {
    score -= 6;
    result.notes.push(`HTF ${htfStruct.bias} opposes`);
  }

  // 3. Order Blocks near pattern base
  let obs = [];
  try { obs = detectOrderBlocks(closed); } catch (_) {}
  const wantOB = long ? 'bullish' : 'bearish';
  const nearOB = obs
    .filter((o) => o.type === wantOB && o.status !== 'INVALIDATED')
    .filter((o) => {
      const mid = (o.high + o.low) / 2;
      return Math.abs(mid - evalPrice) <= A * 1.2;
    })
    .sort((a, b) => b.strength - a.strength)[0];
  if (nearOB) {
    const boost = nearOB.status === 'FRESH' ? 16 : nearOB.status === 'TESTED ONCE' ? 12 : 6;
    score += boost;
    result.notes.push(`${wantOB} OB (${nearOB.status})`);
    result.factors.push({ kind: 'OB', weight: boost, zone: { high: nearOB.high, low: nearOB.low } });
    result.nearestZones.push({ type: 'OB', ...nearOB });
  }

  // 4. FVG near base
  let fvgs = [];
  try { fvgs = detectFVGs(closed); } catch (_) {}
  const nearFVG = fvgs
    .filter((f) => f.type === wantOB && f.status !== 'FILLED')
    .filter((f) => Math.abs(((f.high + f.low) / 2) - evalPrice) <= A * 1.0)
    .sort((a, b) => b.index - a.index)[0];
  if (nearFVG) {
    score += 8;
    result.notes.push(`${wantOB} FVG nearby`);
    result.factors.push({ kind: 'FVG', weight: 8 });
    result.nearestZones.push({ type: 'FVG', high: nearFVG.high, low: nearFVG.low });
  }

  // 5. Liquidity / equal highs-lows / previous swing
  const swings = findSwings(closed, 3, 3);
  let liq = {};
  try { liq = detectLiquidity(closed, swings); } catch (_) {}
  if (long) {
    if (liq.equalLows?.length) {
      score += 10;
      result.notes.push('Equal lows (sell-side liq)');
      result.factors.push({ kind: 'EQUAL_LOWS', weight: 10 });
    }
    if (liq.sellSide && Math.abs(liq.sellSide - evalPrice) <= A * 0.8) {
      score += 8;
      result.notes.push('Near sell-side liquidity');
      result.factors.push({ kind: 'SELL_LIQ', weight: 8 });
    }
  } else {
    if (liq.equalHighs?.length) {
      score += 10;
      result.notes.push('Equal highs (buy-side liq)');
      result.factors.push({ kind: 'EQUAL_HIGHS', weight: 10 });
    }
    if (liq.buySide && Math.abs(liq.buySide - evalPrice) <= A * 0.8) {
      score += 8;
      result.notes.push('Near buy-side liquidity');
      result.factors.push({ kind: 'BUY_LIQ', weight: 8 });
    }
  }

  // 6. Previous swing extremes
  const highs = swings.filter((s) => s.type === 'H');
  const lows = swings.filter((s) => s.type === 'L');
  if (long && lows.length) {
    const prevLow = lows[lows.length - 1];
    if (Math.abs(prevLow.price - evalPrice) <= A * 0.6) {
      score += 7;
      result.notes.push('At previous swing low');
      result.factors.push({ kind: 'SWING_LOW', weight: 7 });
    }
  } else if (!long && highs.length) {
    const prevHigh = highs[highs.length - 1];
    if (Math.abs(prevHigh.price - evalPrice) <= A * 0.6) {
      score += 7;
      result.notes.push('At previous swing high');
      result.factors.push({ kind: 'SWING_HIGH', weight: 7 });
    }
  }

  // 7. Range boundary vs mid-range
  if (pattern.patternType === 'RECTANGLE' || pattern.patternType === 'SYMMETRICAL_TRIANGLE') {
    const mid = ((pattern.support || 0) + (pattern.resistance || 0)) / 2;
    const distToMid = Math.abs(evalPrice - mid);
    const halfRange = Math.abs((pattern.resistance || 0) - (pattern.support || 0)) / 2;
    if (halfRange > 0 && distToMid / halfRange < 0.35) {
      score -= 15;
      result.isMidRange = true;
      result.notes.push('Mid-range of rectangle/triangle — low location quality');
    } else {
      score += 8;
      result.isExtreme = true;
      result.notes.push('At range boundary');
    }
  }

  // Extreme detection
  if ((long && pd.pos <= 0.25) || (!long && pd.pos >= 0.75)) {
    result.isExtreme = true;
  }

  result.locationScore = Math.max(0, Math.min(100, Math.round(score)));
  return result;
}
