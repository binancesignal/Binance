/**
 * Elliott Wave context engine.
 * Does NOT generate trades independently — provides context/confluence only.
 * No lookahead: uses only closed candles up to the evaluation point.
 */
import { findSwings, calcATR } from '../indicators.js';

const FIB_RETR = [0.236, 0.382, 0.5, 0.618, 0.705, 0.786];
const FIB_EXT = [1.0, 1.272, 1.618, 2.0, 2.618];

function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

function ratio(a, b) {
  if (!b || Math.abs(b) < 1e-12) return null;
  return Math.abs(a / b);
}

/**
 * Build a candidate impulse count from a sequence of alternating swings.
 * swings: array of { i, price, type: 'H'|'L' } sorted by index ascending.
 */
function tryImpulse(swings, atr, direction) {
  // Need at least 5 pivots for 1-2-3-4-5
  if (swings.length < 5) return null;
  const long = direction === 'bullish';
  // Filter to alternating sequence starting with appropriate type
  const seq = [];
  let expect = long ? 'L' : 'H'; // wave 1 starts from a low for bull, high for bear
  for (const s of swings) {
    if (s.type === expect) {
      seq.push(s);
      expect = expect === 'H' ? 'L' : 'H';
    }
  }
  if (seq.length < 5) return null;

  // Take last 5 alternating pivots as potential 0-1-2-3-4-5 origin + waves
  // Actually: pivot0 (start), W1, W2, W3, W4, W5
  const pivots = seq.slice(-6);
  if (pivots.length < 6) return null;

  const [p0, p1, p2, p3, p4, p5] = pivots;
  const tol = atr * 0.4;

  // Directional checks
  if (long) {
    if (!(p1.price > p0.price && p2.price < p1.price && p2.price > p0.price &&
          p3.price > p1.price && p4.price < p3.price && p4.price > p1.price &&
          p5.price > p3.price)) return null;
  } else {
    if (!(p1.price < p0.price && p2.price > p1.price && p2.price < p0.price &&
          p3.price < p1.price && p4.price > p3.price && p4.price < p1.price &&
          p5.price < p3.price)) return null;
  }

  const w1 = p1.price - p0.price;
  const w2 = p2.price - p1.price;
  const w3 = p3.price - p2.price;
  const w4 = p4.price - p3.price;
  const w5 = p5.price - p4.price;

  // Wave 2 should not retrace more than 100% of W1
  if (Math.abs(w2) >= Math.abs(w1)) return null;
  // Wave 3 should not be shortest (classic rule: W3 not shortest of 1/3/5)
  const abs1 = Math.abs(w1), abs3 = Math.abs(w3), abs5 = Math.abs(w5);
  if (abs3 < abs1 && abs3 < abs5) return null;
  // Wave 4 should not overlap Wave 1 territory (soft)
  if (long && p4.price < p1.price - tol) return null;
  if (!long && p4.price > p1.price + tol) return null;

  // Fib relationships for scoring
  let fibScore = 0;
  const notes = [];
  const r2 = ratio(w2, w1);
  if (r2 != null) {
    for (const f of [0.382, 0.5, 0.618]) {
      if (near(r2, f, 0.12)) { fibScore += 12; notes.push(`W2 ~${f} of W1`); break; }
    }
  }
  const r3 = ratio(w3, w1);
  if (r3 != null) {
    for (const f of [1.618, 2.0, 2.618, 1.0]) {
      if (near(r3, f, 0.2)) { fibScore += 10; notes.push(`W3 ~${f}× W1`); break; }
    }
  }
  const r4 = ratio(w4, w3);
  if (r4 != null) {
    for (const f of [0.236, 0.382, 0.5]) {
      if (near(r4, f, 0.12)) { fibScore += 8; notes.push(`W4 ~${f} of W3`); break; }
    }
  }
  const r5 = ratio(w5, w1);
  if (r5 != null) {
    for (const f of [0.618, 1.0, 1.618]) {
      if (near(r5, f, 0.2)) { fibScore += 8; notes.push(`W5 ~${f}× W1`); break; }
    }
  }

  // Current wave: assume we are at/near p5 completion
  const currentWave = 5;
  const invalidation = long ? p4.price : p4.price; // break of W4 invalidates W5
  const confidence = Math.min(90, 40 + fibScore + (abs3 > abs1 ? 10 : 0));

  return {
    type: 'IMPULSE',
    direction: long ? 'bullish' : 'bearish',
    degree: 'intermediate',
    currentWave,
    pivots: [
      { label: '0', i: p0.i, price: p0.price },
      { label: '1', i: p1.i, price: p1.price },
      { label: '2', i: p2.i, price: p2.price },
      { label: '3', i: p3.i, price: p3.price },
      { label: '4', i: p4.i, price: p4.price },
      { label: '5', i: p5.i, price: p5.price },
    ],
    confidence,
    invalidation,
    notes,
    fibScore,
    primary: true,
  };
}

/**
 * Try corrective A-B-C count.
 */
function tryCorrection(swings, atr, direction) {
  if (swings.length < 4) return null;
  const long = direction === 'bullish'; // corrective after bearish impulse → ABC up
  const seq = [];
  let expect = long ? 'L' : 'H';
  for (const s of swings) {
    if (s.type === expect) {
      seq.push(s);
      expect = expect === 'H' ? 'L' : 'H';
    }
  }
  if (seq.length < 4) return null;
  const pivots = seq.slice(-4);
  const [p0, pA, pB, pC] = pivots;
  const tol = atr * 0.4;

  if (long) {
    if (!(pA.price > p0.price && pB.price < pA.price && pC.price > pB.price)) return null;
  } else {
    if (!(pA.price < p0.price && pB.price > pA.price && pC.price < pB.price)) return null;
  }

  const wA = pA.price - p0.price;
  const wB = pB.price - pA.price;
  const wC = pC.price - pB.price;
  if (Math.abs(wB) >= Math.abs(wA) * 1.1) return null; // B shouldn't exceed A much

  let fibScore = 0;
  const notes = [];
  const rB = ratio(wB, wA);
  if (rB != null) {
    for (const f of [0.382, 0.5, 0.618]) {
      if (near(rB, f, 0.15)) { fibScore += 12; notes.push(`B ~${f} of A`); break; }
    }
  }
  const rC = ratio(wC, wA);
  if (rC != null) {
    for (const f of [0.618, 1.0, 1.272, 1.618]) {
      if (near(rC, f, 0.2)) { fibScore += 12; notes.push(`C ~${f}× A`); break; }
    }
  }

  const confidence = Math.min(85, 35 + fibScore);
  return {
    type: 'CORRECTION',
    direction: long ? 'bullish' : 'bearish',
    degree: 'intermediate',
    currentWave: 'C',
    pivots: [
      { label: '0', i: p0.i, price: p0.price },
      { label: 'A', i: pA.i, price: pA.price },
      { label: 'B', i: pB.i, price: pB.price },
      { label: 'C', i: pC.i, price: pC.price },
    ],
    confidence,
    invalidation: long ? pB.price : pB.price,
    notes,
    fibScore,
    primary: true,
  };
}

/**
 * Main entry: analyse closed candles for probable Elliott counts.
 * Returns { primaryCount, alternativeCount, waveScore, context }
 */
export function analyseElliottWave(candles, opts = {}) {
  const result = {
    primaryCount: null,
    alternativeCount: null,
    waveScore: 0,
    context: null,
    notes: [],
  };
  if (!candles || candles.length < 40) return result;

  const closed = candles.slice(0, -1); // never use forming candle
  const atr = calcATR(closed, 14) || closed[closed.length - 1].close * 0.005;
  const swings = findSwings(closed, opts.left || 3, opts.right || 3);
  if (swings.length < 6) return result;

  const recent = swings.slice(-16);
  const candidates = [];

  // Try both directions for impulse and correction
  for (const dir of ['bullish', 'bearish']) {
    const imp = tryImpulse(recent, atr, dir);
    if (imp) candidates.push(imp);
    const cor = tryCorrection(recent, atr, dir);
    if (cor) candidates.push(cor);
  }

  if (!candidates.length) {
    result.notes.push('No reliable Elliott count');
    return result;
  }

  // Sort by confidence
  candidates.sort((a, b) => b.confidence - a.confidence);
  result.primaryCount = { ...candidates[0], primary: true };
  if (candidates.length > 1 && candidates[1].confidence >= candidates[0].confidence * 0.55) {
    result.alternativeCount = { ...candidates[1], primary: false };
  }

  // waveScore 0-100
  let score = result.primaryCount.confidence;
  if (result.alternativeCount) {
    // Ambiguity penalty
    const gap = result.primaryCount.confidence - result.alternativeCount.confidence;
    if (gap < 15) score -= 20;
    else if (gap < 25) score -= 10;
    result.notes.push(`Alt count: ${result.alternativeCount.type} ${result.alternativeCount.direction} (${result.alternativeCount.confidence}%)`);
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  result.waveScore = score;

  const pc = result.primaryCount;
  result.context = {
    type: pc.type,
    direction: pc.direction,
    currentWave: pc.currentWave,
    label: pc.type === 'IMPULSE'
      ? `Potential Wave ${pc.currentWave} ${pc.direction === 'bullish' ? 'up' : 'down'}`
      : `Potential Wave ${pc.currentWave} ${pc.direction === 'bullish' ? 'up' : 'down'} (ABC)`,
    invalidation: pc.invalidation,
    confidence: pc.confidence,
  };
  result.notes.push(...(pc.notes || []));

  return result;
}

/**
 * Score how well a pattern/setup aligns with Elliott context.
 * Used as confluence layer only.
 */
export function elliottConfluence(waveResult, direction, patternType) {
  if (!waveResult?.primaryCount) {
    return { points: 0, notes: ['No Elliott context'], waveScore: 0, penalty: 0 };
  }
  const pc = waveResult.primaryCount;
  const long = direction === 'LONG';
  const wantBull = long;
  let points = 0;
  const notes = [];
  let penalty = 0;

  // Alignment with setup direction
  const waveBull = pc.direction === 'bullish';
  if (waveBull === wantBull) {
    points += 8;
    notes.push(`EW aligned (${pc.context || pc.type} ${pc.currentWave})`);
  } else {
    points -= 5;
    notes.push(`EW opposite (${pc.type} ${pc.direction})`);
  }

  // Reversal patterns prefer wave 5 / C completion
  const reversalPatterns = ['DOUBLE_TOP', 'DOUBLE_BOTTOM', 'TRIPLE_TOP', 'TRIPLE_BOTTOM',
    'HEAD_AND_SHOULDERS', 'INVERSE_HEAD_AND_SHOULDERS', 'RISING_WEDGE', 'FALLING_WEDGE'];
  if (reversalPatterns.includes(patternType)) {
    if (pc.type === 'IMPULSE' && pc.currentWave === 5 && waveBull !== wantBull) {
      // Wave 5 completion opposing the impulse → good for reversal
      points += 12;
      notes.push('Potential Wave 5 exhaustion (reversal)');
    } else if (pc.type === 'CORRECTION' && pc.currentWave === 'C') {
      points += 10;
      notes.push('Potential Wave C completion');
    }
  }

  // Continuation patterns prefer early waves
  const contPatterns = ['BULL_FLAG', 'BEAR_FLAG', 'ASCENDING_TRIANGLE', 'DESCENDING_TRIANGLE'];
  if (contPatterns.includes(patternType)) {
    if (pc.type === 'IMPULSE' && (pc.currentWave === 2 || pc.currentWave === 4) && waveBull === wantBull) {
      points += 10;
      notes.push(`Wave ${pc.currentWave} pullback continuation`);
    }
  }

  // Ambiguity penalty
  if (waveResult.alternativeCount) {
    const alt = waveResult.alternativeCount;
    if ((alt.direction === 'bullish') !== wantBull) {
      penalty += 8;
      notes.push('Alt EW count conflicts with direction');
    }
  }

  const waveScore = waveResult.waveScore || 0;
  return {
    points: Math.max(-10, Math.min(20, points - penalty)),
    notes,
    waveScore,
    penalty,
    primary: pc,
    alternative: waveResult.alternativeCount,
    context: waveResult.context,
  };
}
