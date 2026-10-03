/**
 * Universal Pattern Engine.
 * Classifies every pattern as REVERSAL / CONTINUATION / BREAKOUT / FAKEOUT
 * and applies pattern-specific confluence profiles.
 * Never turns a bare pattern into a high-confidence signal.
 */
import { evaluateLocation } from './locationEngine.js';
import { buildConfluenceClusters, clusterScoreForPattern } from './confluenceCluster.js';
import { evaluateRejection } from './rejectionEngine.js';
import { isHard, SOFT_PENALTY } from '../strategy/chartPattern/gates.js';
import { analyseElliottWave, elliottConfluence } from './elliottWave.js';
import { detectStructure } from '../structure.js';
import { detectLiquidity } from '../liquidity.js';
import { findSwings, calcATR, premiumDiscount } from '../indicators.js';

/** Pattern-specific preferred confluence profiles */
export const PATTERN_PROFILES = {
  DOUBLE_TOP: {
    type: 'REVERSAL',
    direction: 'SHORT',
    preferred: ['EQUAL_HIGH', 'BUY_LIQ', 'BEARISH_OB', 'SUPPLY', 'PREMIUM', 'FIB_RESISTANCE', 'BEARISH_FVG', 'HTF_BEAR'],
    sequence: ['HTF_BEAR_ZONE', 'ENTER_ZONE', 'BUY_SIDE_SWEEP', 'SECOND_TOP', 'REJECTION', 'BEARISH_CHOCH', 'NECKLINE_BREAK'],
    requireLocationExtreme: true,
    midRangePenalty: 25,
  },
  DOUBLE_BOTTOM: {
    type: 'REVERSAL',
    direction: 'LONG',
    preferred: ['EQUAL_LOW', 'SELL_LIQ', 'BULLISH_OB', 'DEMAND', 'DISCOUNT', 'FIB_SUPPORT', 'BULLISH_FVG', 'HTF_BULL'],
    sequence: ['HTF_BULL_ZONE', 'ENTER_ZONE', 'SELL_SIDE_SWEEP', 'SECOND_BOTTOM', 'REJECTION', 'BULLISH_CHOCH', 'NECKLINE_BREAK'],
    requireLocationExtreme: true,
    midRangePenalty: 25,
  },
  TRIPLE_TOP: {
    type: 'REVERSAL',
    direction: 'SHORT',
    preferred: ['EQUAL_HIGH', 'LIQ_CLUSTER', 'RESISTANCE', 'BEARISH_OB', 'SUPPLY', 'PREMIUM', 'LIQUIDITY_SWEEP', 'BEARISH_SHIFT'],
    sequence: ['REPEATED_REJECTION', 'LIQUIDITY_SWEEP', 'STRUCTURE_SHIFT'],
    overTestPenalty: 20,
    midRangePenalty: 35,
    requireLocationExtreme: true,
  },
  TRIPLE_BOTTOM: {
    type: 'REVERSAL',
    direction: 'LONG',
    preferred: ['EQUAL_LOW', 'LIQ_CLUSTER', 'SUPPORT', 'BULLISH_OB', 'DEMAND', 'DISCOUNT', 'LIQUIDITY_SWEEP', 'BULLISH_SHIFT'],
    sequence: ['REPEATED_REJECTION', 'LIQUIDITY_SWEEP', 'STRUCTURE_SHIFT'],
    overTestPenalty: 20,
    midRangePenalty: 35,
    requireLocationExtreme: true,
  },
  HEAD_AND_SHOULDERS: {
    type: 'REVERSAL',
    direction: 'SHORT',
    preferred: ['HTF_SUPPLY', 'BEARISH_OB', 'BUY_LIQ', 'PREMIUM', 'FIB_RESISTANCE', 'REJECTION', 'NECKLINE', 'BEARISH_CHOCH'],
    sequence: ['HEAD', 'RIGHT_SHOULDER', 'REJECTION', 'NECKLINE_BREAK'],
    requireRightShoulderQuality: true,
    midRangePenalty: 30,
  },
  INVERSE_HEAD_AND_SHOULDERS: {
    type: 'REVERSAL',
    direction: 'LONG',
    preferred: ['HTF_DEMAND', 'BULLISH_OB', 'SELL_LIQ', 'DISCOUNT', 'FIB_SUPPORT', 'REJECTION', 'NECKLINE', 'BULLISH_CHOCH'],
    sequence: ['HEAD', 'RIGHT_SHOULDER', 'REJECTION', 'NECKLINE_BREAK'],
    requireRightShoulderQuality: true,
    midRangePenalty: 30,
  },
  RISING_WEDGE: {
    type: 'REVERSAL',
    direction: 'SHORT',
    preferred: ['RESISTANCE', 'BEARISH_OB', 'SUPPLY', 'PREMIUM', 'BUY_LIQ', 'FAILED_BREAKOUT', 'REJECTION', 'BEARISH_CHOCH'],
    sequence: ['UPPER_BOUNDARY', 'REJECTION', 'BREAKDOWN'],
    midRangePenalty: 15,
  },
  FALLING_WEDGE: {
    type: 'REVERSAL',
    direction: 'LONG',
    preferred: ['SUPPORT', 'BULLISH_OB', 'DEMAND', 'DISCOUNT', 'SELL_LIQ', 'REJECTION', 'BULLISH_CHOCH', 'BREAKOUT'],
    sequence: ['LOWER_BOUNDARY', 'REJECTION', 'BREAKOUT'],
    midRangePenalty: 15,
  },
  ASCENDING_TRIANGLE: {
    type: 'CONTINUATION',
    direction: 'LONG',
    preferred: ['HTF_BULL', 'BREAKOUT', 'DISPLACEMENT', 'VOLUME', 'RETEST'],
    sequence: ['BREAKOUT', 'CLOSE', 'RETEST', 'CONFIRMATION'],
    requireBreakoutConfirm: true,
  },
  DESCENDING_TRIANGLE: {
    type: 'CONTINUATION',
    direction: 'SHORT',
    preferred: ['HTF_BEAR', 'BREAKOUT', 'DISPLACEMENT', 'VOLUME', 'RETEST'],
    sequence: ['BREAKOUT', 'CLOSE', 'RETEST', 'CONFIRMATION'],
    requireBreakoutConfirm: true,
  },
  SYMMETRICAL_TRIANGLE: {
    type: 'BREAKOUT',
    direction: 'NEUTRAL',
    preferred: ['HTF_TREND', 'LIQUIDITY', 'DISPLACEMENT', 'VOLUME', 'RETEST'],
    sequence: ['BREAKOUT', 'CLOSE', 'RETEST'],
    requireBreakoutConfirm: true,
    noAssumeDirection: true,
  },
  RECTANGLE: {
    type: 'BREAKOUT',
    direction: 'NEUTRAL',
    preferred: ['RANGE_BOUNDARY', 'EQUAL_H_L', 'OB', 'FAILED_BREAKOUT', 'REJECTION'],
    sequence: ['BOUNDARY_TEST', 'REJECTION_OR_BREAK'],
    midRangePenalty: 35,
  },
  BULL_FLAG: {
    type: 'CONTINUATION',
    direction: 'LONG',
    preferred: ['HTF_BULL', 'IMPULSE', 'PULLBACK', 'BULLISH_OB', 'FIB', 'BULLISH_CHOCH'],
    sequence: ['IMPULSE', 'FLAG', 'BREAKOUT'],
  },
  BEAR_FLAG: {
    type: 'CONTINUATION',
    direction: 'SHORT',
    preferred: ['HTF_BEAR', 'IMPULSE', 'PULLBACK', 'BEARISH_OB', 'FIB', 'BEARISH_CHOCH'],
    sequence: ['IMPULSE', 'FLAG', 'BREAKOUT'],
  },
};

/**
 * Classify setup type from pattern + context.
 */
export function classifySetupType(pattern, breakout, location, rejection) {
  const profile = PATTERN_PROFILES[pattern.patternType] || { type: 'BREAKOUT' };
  let type = profile.type;

  // Override with event evidence
  if (rejection?.events?.includes('FAILED_BREAKOUT') || rejection?.events?.includes('UPTHRUST') || rejection?.events?.includes('SPRING')) {
    type = 'FAKEOUT';
  } else if (breakout?.ok) {
    if (type === 'REVERSAL') type = 'BREAKOUT'; // neckline break of reversal pattern
    else type = type === 'CONTINUATION' ? 'CONTINUATION' : 'BREAKOUT';
  }

  return type;
}

/**
 * Full universal evaluation of a detected pattern.
 * Returns detailed scores, events, why accepted/rejected, lifecycle suggestion.
 */
export function evaluateUniversalSetup({
  symbol,
  pattern,
  breakout,
  candles,
  htfCandles,
  direction,
  price,
  atr,
  cfg = {},
}) {
  const profile = PATTERN_PROFILES[pattern.patternType] || {
    type: 'BREAKOUT',
    preferred: [],
    midRangePenalty: 10,
  };

  const dir = direction || pattern.direction || (profile.direction !== 'NEUTRAL' ? profile.direction : null);
  if (!dir || dir === 'NEUTRAL') {
    return {
      ok: false,
      reject: 'No clear direction',
      patternScore: 0,
      finalScore: 0,
    };
  }

  const closed = candles?.slice(0, -1) || [];
  const A = atr > 0 ? atr : calcATR(closed, 14) || price * 0.004;

  // --- 1. Pattern quality ---
  let patternScore = Math.min(100, (pattern.confidence || 50) + (pattern.fit || 0.5) * 20);
  if ((pattern.touches || 0) >= 3) patternScore += 8;
  if ((pattern.patternHeight || 0) < A * 0.5) patternScore -= 20; // tiny pattern
  patternScore = Math.max(0, Math.min(100, Math.round(patternScore)));

  // --- 2. Location ---
  const location = evaluateLocation({
    candles,
    htfCandles,
    pattern,
    direction: dir,
    price,
    atr: A,
  });
  let locationScore = location.locationScore;
  if (location.isMidRange && profile.midRangePenalty) {
    locationScore = Math.max(0, locationScore - profile.midRangePenalty);
  }

  // --- 3. Confluence clusters ---
  const { clusters } = buildConfluenceClusters(candles, dir, A);
  const clusterResult = clusterScoreForPattern(clusters, pattern, dir, A);
  const confluenceScore = clusterResult.score;

  // --- 4. Liquidity ---
  let liq = {};
  try { liq = detectLiquidity(closed, findSwings(closed, 3, 3)); } catch (_) {}
  let liquidityScore = 0;
  const liqNotes = [];
  if (dir === 'LONG') {
    if (liq.bullishSweep) { liquidityScore += 40; liqNotes.push('Sell-side sweep'); }
    if (liq.equalLows?.length) { liquidityScore += 25; liqNotes.push('Equal lows'); }
    if (liq.sellSide && Math.abs(liq.sellSide - (pattern.support || price)) <= A) {
      liquidityScore += 20; liqNotes.push('Near sell-side liq');
    }
  } else {
    if (liq.bearishSweep) { liquidityScore += 40; liqNotes.push('Buy-side sweep'); }
    if (liq.equalHighs?.length) { liquidityScore += 25; liqNotes.push('Equal highs'); }
    if (liq.buySide && Math.abs(liq.buySide - (pattern.resistance || price)) <= A) {
      liquidityScore += 20; liqNotes.push('Near buy-side liq');
    }
  }
  liquidityScore = Math.min(100, liquidityScore);

  // --- 5. Rejection / event ---
  const rejection = evaluateRejection({
    candles,
    pattern,
    direction: dir,
    breakout,
    atr: A,
    liquidity: liq,
  });
  const rejectionScore = rejection.rejectionScore;

  // --- 6. Structure ---
  let structureScore = 0;
  const structNotes = [];
  try {
    const st = detectStructure(closed.slice(-60));
    const htfSt = htfCandles?.length ? detectStructure(htfCandles) : st;
    const want = dir === 'LONG' ? 'bullish' : 'bearish';
    if (st.choch === want) { structureScore += 40; structNotes.push('LTF CHOCH'); }
    else if (st.bos === want) { structureScore += 30; structNotes.push('LTF BOS'); }
    if (htfSt.bias === want || htfSt.bos === want || htfSt.choch === want) {
      structureScore += 30;
      structNotes.push('HTF aligned');
    } else if (htfSt.bias !== 'neutral' && htfSt.bias !== want) {
      structureScore -= 20;
      structNotes.push(`HTF ${htfSt.bias} opposes`);
    }
  } catch (_) {}
  structureScore = Math.max(0, Math.min(100, structureScore));

  // --- 7. Elliott Wave (context only) — toggle via dashboard checkbox ---
  const ewEnabled = cfg.waveAnalysisEnabled !== false;
  const waveResult = ewEnabled
    ? analyseElliottWave(candles)
    : { primaryCount: null, alternativeCount: null, waveScore: 0, context: null, notes: [] };
  const ewConf = ewEnabled
    ? elliottConfluence(waveResult, dir, pattern.patternType)
    : { points: 0, notes: [], waveScore: 0, penalty: 0 };
  const waveScore = ewEnabled ? (waveResult.waveScore || 0) : 0;

  // --- 8. Momentum (volume / displacement) ---
  let momentumScore = 0;
  if (breakout?.rvol >= 1.5) momentumScore += 50;
  else if (breakout?.rvol >= 1.2) momentumScore += 30;
  if (breakout?.bodyRatio >= 0.6) momentumScore += 30;
  if (rejection.events.includes('DISPLACEMENT')) momentumScore += 20;
  momentumScore = Math.min(100, momentumScore);

  // --- 9. Risk / Path (caller supplies SL/TP; here we only flag issues) ---
  let riskScore = 70; // neutral start; adjusted by caller with real R:R
  let pathScore = 70;
  const riskNotes = [];

  // --- Setup type ---
  const setupType = classifySetupType(pattern, breakout, location, rejection);

  // --- Weighted final score ---
  const weights = cfg.universalWeights || {
    pattern: 15,
    location: 20,
    liquidity: 15,
    rejection: 15,
    structure: 15,
    wave: 10,
    momentum: 5,
    risk: 3,
    path: 2,
  };
  const totalW = Object.values(weights).reduce((a, b) => a + b, 0) || 100;
  let finalScore = (
    (patternScore * weights.pattern +
      locationScore * weights.location +
      liquidityScore * weights.liquidity +
      rejectionScore * weights.rejection +
      structureScore * weights.structure +
      waveScore * weights.wave +
      momentumScore * weights.momentum +
      riskScore * weights.risk +
      pathScore * weights.path) /
    totalW
  );
  // Cluster boost
  if (confluenceScore >= 60) finalScore += 5;
  // EW points
  finalScore += (ewConf.points || 0) * 0.4;
  finalScore = Math.max(0, Math.min(100, Math.round(finalScore)));

  // --- False confluence filters ---
  const whyRejected = [];
  const whyAccepted = [];
  // gate(): HARD → reject reason, SOFT → score penalty only
  const softFails = [];
  const gate = (key, msg) => (isHard(cfg, key) ? whyRejected.push(msg) : softFails.push(msg));
  const minFinal = cfg.minFinalScore ?? 70;
  const minLoc = cfg.minLocationScore ?? 40;
  const minRej = cfg.minRejectionScore ?? 30;
  const minWave = cfg.minWaveScore ?? 0;
  const isReversal = (profile.type === 'REVERSAL') || setupType === 'REVERSAL';

  // ===== MANDATORY REJECTION ZONE for ALL reversal patterns =====
  // User requirement: Double Top / Triple Top / H&S / Rising Wedge etc.
  // MUST sit at a meaningful rejection zone (OB + Fib + S/R / premium cluster).
  // Bare geometric pattern without zone = REJECT.
  if (isReversal) {
    const cluster = clusterResult.cluster;
    const hasStrongCluster = cluster && (
      cluster.sourceCount >= 2 ||
      (cluster.sources || []).some((s) => ['OB', 'FIB', 'EQUAL_HIGH', 'EQUAL_LOW', 'BUY_LIQ', 'SELL_LIQ', 'SWING_HIGH', 'SWING_LOW'].includes(s))
    );
    const hasOB = cluster && (cluster.sources || []).includes('OB');
    const hasFib = cluster && (cluster.sources || []).includes('FIB');
    const hasSR = cluster && (cluster.sources || []).some((s) =>
      ['EQUAL_HIGH', 'EQUAL_LOW', 'SWING_HIGH', 'SWING_LOW', 'BUY_LIQ', 'SELL_LIQ'].includes(s)
    );
    const zoneOk = hasStrongCluster && confluenceScore >= (cfg.minReversalZoneScore ?? 45);
    const locationOk = locationScore >= (cfg.minReversalLocationScore ?? 55);
    const notMid = !location.isMidRange;

    if (!zoneOk) {
      gate('rejectionZone',
        'REVERSAL requires rejection zone (OB / Fib / S-R / liquidity cluster). ' +
        `Cluster score ${confluenceScore}${cluster ? ` sources=[${(cluster.sources || []).join('+')}]` : ' none'}`
      );
    }
    if (!locationOk) {
      gate('rejectionZone', `REVERSAL location too weak (${locationScore} < ${cfg.minReversalLocationScore ?? 55}) — need premium/discount + HTF zone`);
    }
    if (!notMid) {
      gate('midRange', 'REVERSAL mid-range — no meaningful rejection zone');
    }
    // Prefer at least one structural element (OB or Fib or equal H/L)
    if (zoneOk && !hasOB && !hasFib && !hasSR && (cfg.requireStructuralZone !== false)) {
      gate('rejectionZone','REVERSAL zone lacks structural confluence (need OB or Fib or equal high/low / swing)');
    }
  }

  if (location.isMidRange && (profile.midRangePenalty || 0) >= 20) {
    gate('midRange', 'Mid-range pattern — low location quality');
  }
  if (locationScore < minLoc) gate('location', `Location score ${locationScore} < ${minLoc}`);
  if (rejectionScore < minRej) {
    gate('rejection', `Rejection score ${rejectionScore} < ${minRej}`);
  }
  if (ewEnabled && waveScore < minWave) {
    gate('wave', `Wave score ${waveScore} < ${minWave}`);
  }
  if (patternScore < (cfg.minPatternScore ?? 40)) {
    whyRejected.push(`Pattern score too low (${patternScore})`);
  }
  if ((pattern.patternHeight || 0) < A * 0.4) {
    whyRejected.push('Pattern too small (height < 0.4 ATR)');
  }
  if (ewConf.penalty > 10) {
    // original behaviour = always reject; only an explicit SOFT toggle turns it into a penalty
    if (cfg.gateModes?.wave === 'soft') softFails.push('Conflicting alternative Elliott count');
    else whyRejected.push('Conflicting alternative Elliott count');
  }
  // SOFT gate failures only cost score
  finalScore = Math.max(0, finalScore - SOFT_PENALTY * softFails.length);

  // Positive reasons
  if (locationScore >= 70) whyAccepted.push(`Strong location (${locationScore})`);
  if (liquidityScore >= 50) whyAccepted.push(`Liquidity edge (${liqNotes.join(', ')})`);
  if (rejectionScore >= 50) whyAccepted.push(`Quality rejection/event (${rejection.events.join(', ')})`);
  if (structureScore >= 50) whyAccepted.push(`Structure confirmation (${structNotes.join(', ')})`);
  if (ewEnabled && waveScore >= 60) whyAccepted.push(`Elliott context: ${waveResult.context?.label || 'aligned'}`);
  if (confluenceScore >= 50) whyAccepted.push(`Confluence cluster (${clusterResult.notes.join('; ')})`);
  if (isReversal && clusterResult.cluster && clusterResult.cluster.sourceCount >= 2) {
    whyAccepted.push(`Rejection zone: ${(clusterResult.cluster.sources || []).join('+')} (str ${clusterResult.cluster.strength})`);
  }
  if (breakout?.ok) whyAccepted.push('Valid breakout confirmation');

  // --- Lifecycle suggestion ---
  let lifecycle = 'WATCHING';
  if (whyRejected.length === 0 && finalScore >= minFinal) {
    if (breakout?.ok && rejection.hasStructureShift) lifecycle = 'CONFIRMED';
    else if (breakout?.ok || (rejectionScore >= 50 && locationScore >= 60)) lifecycle = 'SETUP';
    else lifecycle = 'WATCHING';
  } else if (whyRejected.length > 0) {
    lifecycle = finalScore >= 50 ? 'WATCHING' : 'REJECTED';
  }

  // Map to existing statuses where possible
  const statusHint = lifecycle === 'CONFIRMED' ? 'READY' : lifecycle === 'SETUP' ? 'WATCHING' : lifecycle === 'REJECTED' ? null : 'WATCHING';

  return {
    ok: whyRejected.length === 0 && finalScore >= minFinal,
    reject: whyRejected.length ? whyRejected.join('; ') : null,
    softFails,
    setupType,
    patternType: pattern.patternType,
    direction: dir,
    patternScore,
    locationScore,
    liquidityScore,
    rejectionScore,
    structureScore,
    momentumScore,
    waveScore,
    riskScore,
    pathScore,
    confluenceScore,
    finalScore,
    location,
    rejection,
    liquidity: { score: liquidityScore, notes: liqNotes, detail: liq },
    structure: { score: structureScore, notes: structNotes },
    elliott: {
      waveScore,
      primary: waveResult.primaryCount,
      alternative: waveResult.alternativeCount,
      context: waveResult.context,
      confluence: ewConf,
    },
    cluster: clusterResult.cluster,
    clusters,
    whyAccepted,
    whyRejected,
    lifecycle,
    statusHint,
    events: rejection.events || [],
    profile,
  };
}
