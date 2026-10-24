/**
 * Harmonic pattern detection (XABCD) for Chart Pattern strategy.
 * Ratios use standard Fibonacci tolerances around ideal values.
 */
import { findSwings, calcATR } from '../../indicators.js';
import { CHART_PATTERN_CONFIG as CFG } from './config.js';

const near = (val, target, tol) => Math.abs(val - target) <= tol;
const ratio = (a, b) => {
  const d = Math.abs(b);
  return d > 1e-12 ? Math.abs(a) / d : 0;
};

/** Ideal ratio windows: [min, max] inclusive */
const SPECS = {
  // Bullish + bearish share ratio rules; direction from geometry
  GARTLEY: {
    XB: [0.55, 0.68], // ~0.618
    AD: [0.72, 0.86], // ~0.786
    BC: [0.35, 0.92], // 0.382–0.886 of AB
    CD_AB: [0.85, 1.35], // AB≈CD-ish
  },
  BAT: {
    XB: [0.35, 0.55], // 0.382–0.50
    AD: [0.82, 0.95], // ~0.886
    BC: [0.35, 0.92],
    CD_AB: [1.2, 2.8], // often 1.27–2.618 of AB
  },
  BUTTERFLY: {
    XB: [0.72, 0.86], // ~0.786
    AD: [1.20, 1.70], // 1.27–1.618
    BC: [0.35, 0.92],
    CD_AB: [1.2, 2.8],
  },
  CRAB: {
    XB: [0.35, 0.65], // 0.382–0.618
    AD: [1.50, 1.75], // ~1.618
    BC: [0.35, 0.92],
    CD_AB: [2.0, 3.8],
  },
  ALT_BAT: {
    XB: [0.33, 0.43], // ~0.382
    AD: [1.05, 1.20], // ~1.13 (D just beyond X)
    BC: [0.35, 0.92],
    CD_AB: [2.0, 3.8], // 2.0–3.618 of AB
  },
  DEEP_CRAB: {
    XB: [0.82, 0.95], // ~0.886
    AD: [1.50, 1.75],
    BC: [0.35, 0.92],
    CD_AB: [2.0, 3.8],
  },
  CYPHER: {
    XB: [0.35, 0.65],
    // C extends XA 1.13–1.414; D retraces XC ~0.786
    XC: [1.05, 1.50],
    XD: [0.72, 0.86],
    BC: [1.05, 1.50], // C beyond B relative to AB often
  },
  SHARK: {
    XB: [0.35, 0.65],
    XC: [1.05, 1.70],
    XD: [0.85, 1.20], // often 0.886–1.13 of XC
  },
  ABCD: {
    // Simple AB=CD: BC retrace 0.382–0.886, CD ≈ AB (0.9–1.15)
    BC: [0.35, 0.92],
    CD_AB: [0.88, 1.20],
  },
  FIVE_O: {
    // 5-0: AB 1.13–1.618 XA, BC 1.618–2.24 AB, CD 0.5 BC
    AB_XA: [1.05, 1.70],
    BC_AB: [1.50, 2.35],
    CD_BC: [0.42, 0.58],
  },
};

function leg(p0, p1) {
  return p1.price - p0.price;
}

function classifyXABCD(X, A, B, C, D) {
  const XA = leg(X, A);
  const AB = leg(A, B);
  const BC = leg(B, C);
  const CD = leg(C, D);
  // Retracements are measured FROM the far end of the previous leg (standard harmonic convention):
  //   XB = how much of XA price gave back at B (0.618 for a Gartley), XD = how much of XC it gave back at D.
  const XB = ratio(leg(A, B), XA);
  const AD = ratio(leg(A, D), XA);
  const BCr = ratio(BC, AB);
  const CD_AB = ratio(CD, AB);
  const XC = ratio(leg(X, C), XA);
  const XD = ratio(leg(C, D), leg(X, C) || XA);
  const AB_XA = ratio(AB, XA);
  const BC_AB = ratio(BC, AB);
  const CD_BC = ratio(CD, BC);

  // Direction: bullish completion = D is a low (price rose X→A then structure ends long)
  // Standard: bullish Gartley has X low, A high, B mid, C high-ish, D low → LONG
  // Bearish inverse → SHORT
  const bullishStructure = A.price > X.price && D.price < C.price;
  const bearishStructure = A.price < X.price && D.price > C.price;
  if (!bullishStructure && !bearishStructure) return null;
  const direction = bullishStructure ? 'LONG' : 'SHORT';

  const hits = [];
  const push = (type, score) => hits.push({ type, score, direction });

  // Gartley / Bat / Butterfly / Crab / Deep Crab
  for (const [name, sp] of Object.entries({
    GARTLEY: SPECS.GARTLEY,
    BAT: SPECS.BAT,
    ALT_BAT: SPECS.ALT_BAT,
    BUTTERFLY: SPECS.BUTTERFLY,
    CRAB: SPECS.CRAB,
    DEEP_CRAB: SPECS.DEEP_CRAB,
  })) {
    if (
      XB >= sp.XB[0] && XB <= sp.XB[1] &&
      AD >= sp.AD[0] && AD <= sp.AD[1] &&
      BCr >= sp.BC[0] && BCr <= sp.BC[1] &&
      CD_AB >= sp.CD_AB[0] && CD_AB <= sp.CD_AB[1]
    ) {
      const midXB = (sp.XB[0] + sp.XB[1]) / 2;
      const midAD = (sp.AD[0] + sp.AD[1]) / 2;
      const score = 1 - (Math.abs(XB - midXB) / 0.2 + Math.abs(AD - midAD) / 0.25) / 2;
      push(name, Math.max(0.4, Math.min(1, score)));
    }
  }

  // Cypher
  {
    const sp = SPECS.CYPHER;
    if (
      XB >= sp.XB[0] && XB <= sp.XB[1] &&
      XC >= sp.XC[0] && XC <= sp.XC[1] &&
      XD >= sp.XD[0] && XD <= sp.XD[1]
    ) {
      push('CYPHER', 0.75);
    }
  }

  // Shark
  {
    const sp = SPECS.SHARK;
    if (
      XB >= sp.XB[0] && XB <= sp.XB[1] &&
      XC >= sp.XC[0] && XC <= sp.XC[1] &&
      XD >= sp.XD[0] && XD <= sp.XD[1]
    ) {
      push('SHARK', 0.7);
    }
  }

  // AB=CD (may overlap; still useful)
  {
    const sp = SPECS.ABCD;
    if (BCr >= sp.BC[0] && BCr <= sp.BC[1] && CD_AB >= sp.CD_AB[0] && CD_AB <= sp.CD_AB[1]) {
      push('ABCD', 0.65);
    }
  }

  // 5-0
  {
    const sp = SPECS.FIVE_O;
    if (
      AB_XA >= sp.AB_XA[0] && AB_XA <= sp.AB_XA[1] &&
      BC_AB >= sp.BC_AB[0] && BC_AB <= sp.BC_AB[1] &&
      CD_BC >= sp.CD_BC[0] && CD_BC <= sp.CD_BC[1]
    ) {
      push('FIVE_O', 0.7);
    }
  }

  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score);
  return { ...hits[0], ratios: { XB, AD, BC: BCr, CD_AB, XC, XD } };
}

/** Shared output builder for 5/6-point reversal patterns that complete at their last point (PRZ). */
function buildReversal({ type, direction, pts, labels, height, atrVal, ratios, score, closedLen }) {
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const przPad = atrVal > 0 ? atrVal * 0.15 : Math.abs(last.price) * 0.001;
  const flat = (price) => ({ a: price, b: 0, maxDev: 0 });
  const support = direction === 'LONG' ? last.price : prev.price;
  const resistance = direction === 'LONG' ? prev.price : last.price;
  return {
    patternType: `${type}_${direction === 'LONG' ? 'BULL' : 'BEAR'}`,
    harmonic: true,
    harmonicFamily: type,
    direction,
    startIndex: pts[0].i,
    endIndex: last.i,
    support,
    resistance,
    neckline: last.price,
    breakoutLevel: last.price,
    upperLine: flat(resistance),
    lowerLine: flat(support),
    anchors: pts.map((p, k) => ({ i: p.i, price: p.price, label: labels[k] })),
    patternHeight: height,
    confidence: Math.round(55 + score * 30),
    fit: score,
    touches: pts.length,
    przLow: last.price - przPad,
    przHigh: last.price + przPad,
    ratios,
    pointD: last.price,
    cdLen: Math.abs(last.price - prev.price) || height * 0.5,
  };
}

/**
 * Three Drives: 3 equal-ish drives separated by 0.618–0.786 corrections.
 * Correction = 0.618–0.786 of the previous drive, next drive = 1.272–1.618 of that correction.
 * SHORT = drives up (tops), LONG = drives down (bottoms). Target = 0.618 of the whole move.
 */
function detectThreeDrives(closed, swings, atrVal) {
  const out = [];
  const recent = swings.slice(-14);
  for (let i = 0; i + 6 <= recent.length; i++) {
    const P = recent.slice(i, i + 6);
    if (P.some((p, k) => k > 0 && p.type === P[k - 1].type)) continue;
    const topFirst = P[5].type === 'H'; // pattern ends on a high → bearish
    const s = topFirst ? 1 : -1; // work in "tops" space
    const v = P.map((p) => s * p.price);
    if (closed.length - 1 - P[5].i > 12) continue; // must be fresh
    if (P[5].i - P[0].i > 90) continue;
    const d1 = v[1] - v[0];
    const c1 = v[1] - v[2];
    const d2 = v[3] - v[2];
    const c2 = v[3] - v[4];
    const d3 = v[5] - v[4];
    if (!(d1 > 0 && c1 > 0 && d2 > 0 && c2 > 0 && d3 > 0)) continue;
    if (!(v[3] > v[1] && v[5] > v[3])) continue; // each drive makes a new extreme
    const r1 = c1 / d1;
    const e2 = d2 / c1;
    const r2 = c2 / d2;
    const e3 = d3 / c2;
    const inR = (x, lo, hi) => x >= lo && x <= hi;
    if (!(inR(r1, 0.55, 0.86) && inR(r2, 0.55, 0.86) && inR(e2, 1.2, 1.7) && inR(e3, 1.2, 1.7))) continue;
    const dev = (Math.abs(r1 - 0.7) + Math.abs(r2 - 0.7)) / 0.3 + (Math.abs(e2 - 1.45) + Math.abs(e3 - 1.45)) / 0.5;
    const score = Math.max(0.4, Math.min(1, 1 - dev / 8));
    const height = 0.618 * Math.abs(P[5].price - P[0].price);
    if (atrVal > 0 && height < atrVal * (CFG.minPatternHeightATR || 0.8) * 0.6) continue;
    out.push(
      buildReversal({
        type: 'THREE_DRIVES',
        direction: topFirst ? 'SHORT' : 'LONG',
        pts: P,
        labels: ['0', '1', '2', '3', '4', '5'],
        height,
        atrVal,
        ratios: { retr1: r1, ext2: e2, retr2: r2, ext3: e3 },
        score,
      })
    );
  }
  return out;
}

/**
 * Wolfe Wave (5 points): lines 1-3 and 2-4 converge; point 5 overshoots the 1-3 line.
 * Target = line 1→4 projected to the time of point 5 (EPA). LONG when point 5 is a low.
 */
function detectWolfeWave(closed, swings, atrVal) {
  const out = [];
  const recent = swings.slice(-12);
  for (let i = 0; i + 5 <= recent.length; i++) {
    const P = recent.slice(i, i + 5);
    if (P.some((p, k) => k > 0 && p.type === P[k - 1].type)) continue;
    const bull = P[4].type === 'L';
    const s = bull ? 1 : -1; // bull space: 1,3,5 are lows
    const v = P.map((p) => s * p.price);
    const t = P.map((p) => p.i);
    if (closed.length - 1 - t[4] > 12) continue;
    if (t[4] - t[0] > 90) continue;
    // 3 beyond 1, 4 inside (below 2, above 3), 2 above 1
    if (!(v[2] < v[0] && v[3] < v[1] && v[3] > v[2] && v[1] > v[0])) continue;
    const m13 = (v[2] - v[0]) / (t[2] - t[0]);
    const m24 = (v[3] - v[1]) / (t[3] - t[1]);
    if (!(m13 < 0 && m24 < m13)) continue; // both fall, upper falls faster → converging
    const l13At5 = v[0] + m13 * (t[4] - t[0]);
    const over = l13At5 - v[4]; // how far point 5 pierces the 1-3 line
    const minOver = atrVal > 0 ? atrVal * 0.05 : 0;
    const maxOver = atrVal > 0 ? atrVal * 2.5 : Infinity;
    if (!(over >= minOver && over <= maxOver)) continue;
    const m14 = (v[3] - v[0]) / (t[3] - t[0]);
    const epa = v[0] + m14 * (t[4] - t[0]); // target line 1→4 at the time of point 5
    const height = epa - v[4];
    if (!(height > 0)) continue;
    if (atrVal > 0 && height < atrVal * (CFG.minPatternHeightATR || 0.8)) continue;
    // sweet-zone: point 5 not absurdly far beyond point 3 in time vs 3→4
    const timeRatio = (t[4] - t[3]) / Math.max(1, t[3] - t[2]);
    if (timeRatio < 0.4 || timeRatio > 2.5) continue;
    const score = Math.max(0.4, Math.min(1, 0.75 - Math.abs(1 - timeRatio) * 0.15));
    out.push(
      buildReversal({
        type: 'WOLFE_WAVE',
        direction: bull ? 'LONG' : 'SHORT',
        pts: P,
        labels: ['1', '2', '3', '4', '5'],
        height,
        atrVal,
        ratios: { overshootATR: atrVal > 0 ? over / atrVal : null, timeRatio },
        score,
      })
    );
  }
  return out;
}

/**
 * Detect harmonic XABCD patterns from swings.
 * Returns same shape family as classic patterns + harmonic: true.
 */
export function detectHarmonicPatterns(candles, atr) {
  if (!candles || candles.length < 40) return [];
  const closed = candles.slice(0, -1);
  const swings = findSwings(closed, 3, 3);
  if (swings.length < 5) return [];
  const atrVal = atr > 0 ? atr : calcATR(closed, 14) || 0;
  const recent = swings.slice(-16);
  const out = [];
  const minBars = 3;
  const maxBars = 80;

  // Alternate H/L sequences for X-A-B-C-D
  for (let i = 0; i < recent.length - 4; i++) {
    const pts = recent.slice(i, i + 5);
    // need alternating types
    let okAlt = true;
    for (let k = 1; k < 5; k++) {
      if (pts[k].type === pts[k - 1].type) {
        okAlt = false;
        break;
      }
    }
    if (!okAlt) continue;
    const [X, A, B, C, D] = pts;
    if (D.i - X.i < minBars * 4 || D.i - X.i > maxBars) continue;
    // D should be near the end of the series (fresh)
    if (closed.length - 1 - D.i > 12) continue;

    const classified = classifyXABCD(X, A, B, C, D);
    if (!classified) continue;

    const height = Math.abs(A.price - D.price);
    if (atrVal > 0 && height < atrVal * (CFG.minPatternHeightATR || 0.8) * 0.6) continue;

    const direction = classified.direction;
    const patternType = `${classified.type}_${direction === 'LONG' ? 'BULL' : 'BEAR'}`;
    // PRZ around D
    const przPad = atrVal > 0 ? atrVal * 0.15 : Math.abs(D.price) * 0.001;
    const przLow = Math.min(D.price, D.price) - przPad;
    const przHigh = Math.max(D.price, D.price) + przPad;

    // Flat lines: support/resistance at D and A for drawing
    const support = direction === 'LONG' ? D.price : Math.min(D.price, A.price);
    const resistance = direction === 'LONG' ? Math.max(D.price, A.price) : D.price;
    const flat = (price) => ({ a: price, b: 0, maxDev: 0 });

    // CD length for measured TPs
    const cdLen = Math.abs(C.price - D.price) || height * 0.5;

    out.push({
      patternType,
      harmonic: true,
      harmonicFamily: classified.type,
      direction,
      startIndex: X.i,
      endIndex: D.i,
      support,
      resistance,
      neckline: D.price,
      breakoutLevel: D.price,
      upperLine: flat(resistance),
      lowerLine: flat(support),
      anchors: [
        { i: X.i, price: X.price, label: 'X' },
        { i: A.i, price: A.price, label: 'A' },
        { i: B.i, price: B.price, label: 'B' },
        { i: C.i, price: C.price, label: 'C' },
        { i: D.i, price: D.price, label: 'D' },
      ],
      patternHeight: height,
      confidence: Math.round(55 + classified.score * 30),
      fit: classified.score,
      touches: 5,
      przLow,
      przHigh,
      ratios: classified.ratios,
      // helper for SL/TP
      pointX: X.price,
      pointA: A.price,
      pointC: C.price,
      pointD: D.price,
      cdLen,
    });
  }

  // Extra reversal families built on the same harmonic flow (never break the scan)
  try {
    out.push(...detectThreeDrives(closed, swings, atrVal), ...detectWolfeWave(closed, swings, atrVal));
  } catch (_) {}

  // Prefer higher confidence, unique D index
  out.sort((a, b) => b.confidence - a.confidence);
  const seen = new Set();
  const unique = [];
  for (const p of out) {
    const key = `${p.patternType}_${p.endIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  return unique.slice(0, 8);
}

/**
 * Harmonic completion validation (reversal at D / PRZ), not classic breakout.
 */
export function validateHarmonic(pattern, candles, atr, cfg = CFG) {
  if (!pattern?.harmonic) return { ok: false, reason: 'Not harmonic' };
  if (!candles?.length) return { ok: false, reason: 'No candles' };
  const closed = candles.slice(0, -1);
  if (closed.length < 20) return { ok: false, reason: 'Not enough candles' };
  const atrVal = atr > 0 ? atr : calcATR(closed, 14) || 0;
  const bi = closed.length - 1;
  const last = closed[bi];
  const direction = pattern.direction;
  const D = pattern.pointD ?? pattern.breakoutLevel;
  if (D == null) return { ok: false, reason: 'No D level' };

  // D must be recent
  const age = bi - (pattern.endIndex ?? bi);
  if (age > (cfg.harmonicMaxAgeBars ?? 8)) {
    return { ok: false, reason: `Harmonic D too old (${age} bars)` };
  }

  // Price must have interacted with PRZ / D
  const pad = atrVal > 0 ? atrVal * (cfg.harmonicPrzATR ?? 0.35) : Math.abs(D) * 0.002;
  const touched =
    direction === 'LONG'
      ? last.low <= D + pad
      : last.high >= D - pad;
  if (!touched) return { ok: false, reason: 'Price not in PRZ / D zone' };

  // Confirmation candle in trade direction
  const body = last.close - last.open;
  if (direction === 'LONG' && body <= 0) return { ok: false, reason: 'No bullish confirmation at D' };
  if (direction === 'SHORT' && body >= 0) return { ok: false, reason: 'No bearish confirmation at D' };

  // Not too extended past D
  const dist = direction === 'LONG' ? last.close - D : D - last.close;
  const distAtr = atrVal > 0 ? dist / atrVal : 0;
  if (atrVal > 0 && distAtr > (cfg.maxBreakoutDistanceATR ?? 1.8)) {
    return { ok: false, reason: `Too extended from D (${distAtr.toFixed(2)} ATR)` };
  }

  const range = last.high - last.low || 1e-9;
  const bodyRatio = Math.abs(body) / range;
  const rvol = 1; // optional

  return {
    ok: true,
    direction,
    entry: last.close,
    level: D,
    breakoutIndex: bi,
    distAtr,
    bodyRatio,
    rvol,
    softFails: [],
    harmonic: true,
  };
}
