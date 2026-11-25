/**
 * Elliott Wave context engine.
 * Soft confluence by default; crypto_confluence can hard-require a primary count.
 * No lookahead: uses only closed candles up to the evaluation point.
 *
 * Supported counts:
 *  - IMPULSE          classic 0-1-2-3-4-5 (W3 not shortest, W2 < 100% W1, soft W4 vs W1)
 *  - IMPULSE_PARTIAL  0-1-2-3 or 0-1-2-3-4 (in-progress motive)
 *  - ENDING_DIAGONAL  5-wave wedge, W4 may overlap W1
 *  - LEADING_DIAGONAL 5-wave wedge in wave-1 position, overlap allowed
 *  - CORRECTION       classic zigzag A-B-C
 *  - FLAT             A-B-C with B ≈ 90–125% of A
 *  - TRIANGLE         5-leg contracting / expanding A-B-C-D-E
 *  - DOUBLE_ZIGZAG    W-X-Y (two zigzags joined by X)
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

function altSeq(swings, startType) {
  const seq = [];
  let expect = startType;
  for (const s of swings) {
    if (s.type === expect) {
      seq.push(s);
      expect = expect === 'H' ? 'L' : 'H';
    }
  }
  return seq;
}

function mkPivots(list, labels) {
  return list.map((p, i) => ({
    label: labels[i] ?? String(i),
    i: p.i,
    price: p.price,
    time: p.time,
  }));
}

/**
 * Classic impulse 0-1-2-3-4-5
 */
function tryImpulse(swings, atr, direction) {
  if (swings.length < 6) return null;
  const long = direction === 'bullish';
  const seq = altSeq(swings, long ? 'L' : 'H');
  if (seq.length < 6) return null;
  const pivots = seq.slice(-6);
  const [p0, p1, p2, p3, p4, p5] = pivots;
  const tol = atr * 0.4;

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

  if (Math.abs(w2) >= Math.abs(w1)) return null;
  const abs1 = Math.abs(w1), abs3 = Math.abs(w3), abs5 = Math.abs(w5);
  if (abs3 < abs1 && abs3 < abs5) return null;
  if (long && p4.price < p1.price - tol) return null;
  if (!long && p4.price > p1.price + tol) return null;

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

  const confidence = Math.min(90, 40 + fibScore + (abs3 > abs1 ? 10 : 0));
  return {
    type: 'IMPULSE',
    direction: long ? 'bullish' : 'bearish',
    degree: 'intermediate',
    currentWave: 5,
    pivots: mkPivots(pivots, ['0', '1', '2', '3', '4', '5']),
    confidence,
    invalidation: p4.price,
    notes,
    fibScore,
    primary: true,
  };
}

/**
 * In-progress motive: 0-1-2-3 or 0-1-2-3-4 (not yet complete 5)
 */
function tryPartialImpulse(swings, atr, direction) {
  if (swings.length < 4) return null;
  const long = direction === 'bullish';
  const seq = altSeq(swings, long ? 'L' : 'H');
  let pivots = null;
  let waveLabel = 3;
  if (seq.length >= 5) {
    pivots = seq.slice(-5);
    waveLabel = 4;
  } else if (seq.length >= 4) {
    pivots = seq.slice(-4);
    waveLabel = 3;
  } else return null;

  const [p0, p1, p2, p3] = pivots;
  const p4 = pivots[4] || null;

  if (long) {
    if (!(p1.price > p0.price && p2.price < p1.price && p2.price > p0.price && p3.price > p1.price)) return null;
    if (p4 && !(p4.price < p3.price && p4.price > p1.price - atr * 0.5)) return null;
  } else {
    if (!(p1.price < p0.price && p2.price > p1.price && p2.price < p0.price && p3.price < p1.price)) return null;
    if (p4 && !(p4.price > p3.price && p4.price < p1.price + atr * 0.5)) return null;
  }

  const w1 = p1.price - p0.price;
  const w2 = p2.price - p1.price;
  const w3 = p3.price - p2.price;
  if (Math.abs(w2) >= Math.abs(w1)) return null;
  if (Math.abs(w3) < Math.abs(w1) * 0.5) return null;

  let fibScore = 0;
  const notes = [`Partial impulse W${waveLabel}`];
  const r2 = ratio(w2, w1);
  if (r2 != null) {
    for (const f of [0.382, 0.5, 0.618]) {
      if (near(r2, f, 0.15)) { fibScore += 10; notes.push(`W2 ~${f} of W1`); break; }
    }
  }
  const r3 = ratio(w3, w1);
  if (r3 != null) {
    for (const f of [1.0, 1.618, 2.0]) {
      if (near(r3, f, 0.25)) { fibScore += 8; notes.push(`W3 ~${f}× W1`); break; }
    }
  }

  const confidence = Math.min(78, 32 + fibScore + (waveLabel === 4 ? 6 : 0));
  const labels = waveLabel === 4 ? ['0', '1', '2', '3', '4'] : ['0', '1', '2', '3'];
  return {
    type: 'IMPULSE_PARTIAL',
    direction: long ? 'bullish' : 'bearish',
    degree: 'intermediate',
    currentWave: waveLabel,
    pivots: mkPivots(pivots, labels),
    confidence,
    invalidation: p2.price,
    notes,
    fibScore,
    primary: true,
  };
}

/**
 * Ending / leading diagonal: 5 waves, overlap of W4 into W1 allowed.
 */
function tryDiagonal(swings, atr, direction, kind) {
  if (swings.length < 6) return null;
  const long = direction === 'bullish';
  const seq = altSeq(swings, long ? 'L' : 'H');
  if (seq.length < 6) return null;
  const pivots = seq.slice(-6);
  const [p0, p1, p2, p3, p4, p5] = pivots;

  if (long) {
    if (!(p1.price > p0.price && p2.price < p1.price &&
          p3.price > p2.price && p4.price < p3.price && p5.price > p4.price)) return null;
    if (p5.price <= p0.price) return null;
  } else {
    if (!(p1.price < p0.price && p2.price > p1.price &&
          p3.price < p2.price && p4.price > p3.price && p5.price < p4.price)) return null;
    if (p5.price >= p0.price) return null;
  }

  const w1 = Math.abs(p1.price - p0.price);
  const w2 = Math.abs(p2.price - p1.price);
  const w3 = Math.abs(p3.price - p2.price);
  const w4 = Math.abs(p4.price - p3.price);
  const w5 = Math.abs(p5.price - p4.price);
  if (w1 < atr * 0.3 || w3 < atr * 0.25) return null;
  if (w2 >= w1 * 1.15) return null;

  let fibScore = 0;
  const notes = [];
  if (w3 < w1 * 1.05 && w5 < w3 * 1.1) {
    fibScore += 14;
    notes.push('Contracting diagonal');
  } else if (w3 > w1 * 0.9) {
    fibScore += 6;
    notes.push('Expanding / neutral diagonal');
  }
  const overlap = long ? p4.price < p1.price : p4.price > p1.price;
  if (overlap) {
    fibScore += 10;
    notes.push('W4 overlaps W1 (diagonal)');
  } else {
    fibScore += 4;
  }

  const type = kind === 'LEADING' ? 'LEADING_DIAGONAL' : 'ENDING_DIAGONAL';
  const confidence = Math.min(82, 34 + fibScore);
  return {
    type,
    direction: long ? 'bullish' : 'bearish',
    degree: 'intermediate',
    currentWave: 5,
    pivots: mkPivots(pivots, ['0', '1', '2', '3', '4', '5']),
    confidence,
    invalidation: p4.price,
    notes,
    fibScore,
    primary: true,
  };
}

/**
 * Classic zigzag A-B-C
 */
function tryCorrection(swings, atr, direction) {
  if (swings.length < 4) return null;
  const long = direction === 'bullish';
  const seq = altSeq(swings, long ? 'L' : 'H');
  if (seq.length < 4) return null;
  const pivots = seq.slice(-4);
  const [p0, pA, pB, pC] = pivots;

  if (long) {
    if (!(pA.price > p0.price && pB.price < pA.price && pC.price > pB.price)) return null;
  } else {
    if (!(pA.price < p0.price && pB.price > pA.price && pC.price < pB.price)) return null;
  }

  const wA = pA.price - p0.price;
  const wB = pB.price - pA.price;
  const wC = pC.price - pB.price;
  if (Math.abs(wB) >= Math.abs(wA) * 1.1) return null;

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
    pivots: mkPivots(pivots, ['0', 'A', 'B', 'C']),
    confidence,
    invalidation: pB.price,
    notes,
    fibScore,
    primary: true,
  };
}

/**
 * Flat: B retraces ~90–125% of A
 */
function tryFlat(swings, atr, direction) {
  if (swings.length < 4) return null;
  const long = direction === 'bullish';
  const seq = altSeq(swings, long ? 'L' : 'H');
  if (seq.length < 4) return null;
  const pivots = seq.slice(-4);
  const [p0, pA, pB, pC] = pivots;

  if (long) {
    if (!(pA.price > p0.price && pB.price < pA.price && pC.price > pB.price)) return null;
  } else {
    if (!(pA.price < p0.price && pB.price > pA.price && pC.price < pB.price)) return null;
  }

  const wA = pA.price - p0.price;
  const wB = pB.price - pA.price;
  const wC = pC.price - pB.price;
  const rB = ratio(wB, wA);
  if (rB == null || rB < 0.85 || rB > 1.35) return null;

  let fibScore = 10;
  const notes = ['Flat correction'];
  if (rB >= 0.95 && rB <= 1.1) {
    fibScore += 8;
    notes.push('Regular flat (B ≈ A)');
  } else if (rB > 1.1) {
    fibScore += 6;
    notes.push('Expanded flat (B > A)');
  }
  const rC = ratio(wC, wA);
  if (rC != null) {
    for (const f of [0.9, 1.0, 1.272, 1.618]) {
      if (near(rC, f, 0.2)) { fibScore += 8; notes.push(`C ~${f}× A`); break; }
    }
  }

  const confidence = Math.min(80, 30 + fibScore);
  return {
    type: 'FLAT',
    direction: long ? 'bullish' : 'bearish',
    degree: 'intermediate',
    currentWave: 'C',
    pivots: mkPivots(pivots, ['0', 'A', 'B', 'C']),
    confidence,
    invalidation: pB.price,
    notes,
    fibScore,
    primary: true,
  };
}

/**
 * Triangle A-B-C-D-E
 */
function tryTriangle(swings, atr, direction) {
  if (swings.length < 6) return null;
  const long = direction === 'bullish';
  const seq = altSeq(swings, long ? 'L' : 'H');
  if (seq.length < 6) return null;
  const pivots = seq.slice(-6);
  const [p0, pA, pB, pC, pD, pE] = pivots;

  const legs = [
    pA.price - p0.price,
    pB.price - pA.price,
    pC.price - pB.price,
    pD.price - pC.price,
    pE.price - pD.price,
  ];
  for (let i = 1; i < legs.length; i++) {
    if (legs[i] * legs[i - 1] >= 0) return null;
  }

  const absLegs = legs.map(Math.abs);
  if (absLegs.some((L) => L < atr * 0.2)) return null;

  let fibScore = 0;
  const notes = [];
  const early = (absLegs[0] + absLegs[1]) / 2;
  const late = (absLegs[3] + absLegs[4]) / 2;
  if (late < early * 0.95) {
    fibScore += 16;
    notes.push('Contracting triangle');
  } else if (late > early * 1.05) {
    fibScore += 8;
    notes.push('Expanding triangle');
  } else {
    fibScore += 6;
    notes.push('Symmetrical triangle');
  }

  const confidence = Math.min(78, 28 + fibScore);
  return {
    type: 'TRIANGLE',
    direction: long ? 'bullish' : 'bearish',
    degree: 'intermediate',
    currentWave: 'E',
    pivots: mkPivots(pivots, ['0', 'A', 'B', 'C', 'D', 'E']),
    confidence,
    invalidation: long ? Math.min(pA.price, pC.price, pE.price) : Math.max(pA.price, pC.price, pE.price),
    notes,
    fibScore,
    primary: true,
  };
}

/**
 * Double zigzag W-X-Y
 */
function tryDoubleZigzag(swings, atr, direction) {
  if (swings.length < 4) return null;
  const long = direction === 'bullish';
  const seq = altSeq(swings, long ? 'L' : 'H');
  if (seq.length < 4) return null;
  const pivots = seq.slice(-4);
  const [p0, pW, pX, pY] = pivots;

  if (long) {
    if (!(pW.price > p0.price && pX.price < pW.price && pY.price > pX.price && pY.price > pW.price * 0.98)) return null;
  } else {
    if (!(pW.price < p0.price && pX.price > pW.price && pY.price < pX.price && pY.price < pW.price * 1.02)) return null;
  }

  const wW = pW.price - p0.price;
  const wX = pX.price - pW.price;
  const wY = pY.price - pX.price;
  if (Math.abs(wX) >= Math.abs(wW) * 1.2) return null;
  if (Math.abs(wY) < Math.abs(wW) * 0.5) return null;

  let fibScore = 8;
  const notes = ['Double zigzag W-X-Y'];
  const rX = ratio(wX, wW);
  if (rX != null) {
    for (const f of [0.382, 0.5, 0.618]) {
      if (near(rX, f, 0.15)) { fibScore += 8; notes.push(`X ~${f} of W`); break; }
    }
  }
  const rY = ratio(wY, wW);
  if (rY != null) {
    for (const f of [0.618, 1.0, 1.272, 1.618]) {
      if (near(rY, f, 0.22)) { fibScore += 8; notes.push(`Y ~${f}× W`); break; }
    }
  }

  const confidence = Math.min(76, 28 + fibScore);
  return {
    type: 'DOUBLE_ZIGZAG',
    direction: long ? 'bullish' : 'bearish',
    degree: 'intermediate',
    currentWave: 'Y',
    pivots: mkPivots(pivots, ['0', 'W', 'X', 'Y']),
    confidence,
    invalidation: pX.price,
    notes,
    fibScore,
    primary: true,
  };
}



/** Additional corrective structures used by Powerful Max. These are deliberately
 * conservative geometric recognizers; they are context candidates, not trade triggers. */
function tryRunningFlat(swings, atr, direction) {
  const c = tryFlat(swings, atr, direction);
  if (!c) return null;
  const piv = c.pivots || [];
  if (piv.length < 4) return null;
  const p0=piv[0].price,pA=piv[1].price,pB=piv[2].price,pC=piv[3].price;
  const long=direction==='bullish';
  const cBeyondStart = long ? pC > p0 : pC < p0;
  if (cBeyondStart) return null;
  return { ...c, type:'RUNNING_FLAT', confidence:Math.min(78,c.confidence+2), notes:[...(c.notes||[]),'Running flat geometry'] };
}

function tryExpandedFlat(swings, atr, direction) {
  const c = tryFlat(swings, atr, direction);
  if (!c) return null;
  const piv = c.pivots || [];
  if (piv.length < 4) return null;
  const p0=piv[0].price,pA=piv[1].price,pB=piv[2].price;
  const long=direction==='bullish';
  const bBeyondA = long ? pB > p0 : pB < p0;
  if (!bBeyondA) return null;
  return { ...c, type:'EXPANDED_FLAT', confidence:Math.min(84,c.confidence+4), notes:[...(c.notes||[]),'Expanded flat B-wave extension'] };
}

function tryTripleZigzag(swings, atr, direction) {
  if (swings.length < 6) return null;
  const long=direction==='bullish';
  const seq=altSeq(swings,long?'L':'H');
  if (seq.length < 6) return null;
  const p=seq.slice(-6);
  const [p0,pW,pX,pY,pX2,pZ]=p;
  const ok=long
    ? pW.price>p0.price && pX.price<pW.price && pY.price>pX.price && pX2.price<pY.price && pZ.price>pX2.price
    : pW.price<p0.price && pX.price>pW.price && pY.price<pX.price && pX2.price>pY.price && pZ.price<pX2.price;
  if(!ok) return null;
  const wW=Math.abs(pW.price-p0.price), wY=Math.abs(pY.price-pX.price), wZ=Math.abs(pZ.price-pX2.price);
  if(wW<atr*.3 || wY<atr*.3 || wZ<atr*.3) return null;
  return { type:'TRIPLE_ZIGZAG', direction:long?'bullish':'bearish', degree:'intermediate', currentWave:'Z',
    pivots:mkPivots(p,['0','W','X','Y','X2','Z']), confidence:Math.min(74,34+(wY>=wW*.45?8:0)+(wZ>=wW*.45?8:0)),
    invalidation:pX2.price, notes:['Triple zigzag W-X-Y-X-Z'], fibScore:0, primary:true };
}

function tryCombinationWxyxz(swings, atr, direction) {
  if (swings.length < 6) return null;
  const long=direction==='bullish';
  const seq=altSeq(swings,long?'L':'H');
  if(seq.length<6) return null;
  const p=seq.slice(-6); const [p0,pW,pX,pY,pX2,pZ]=p;
  const ok=long
    ? pW.price>p0.price && pX.price<pW.price && pY.price>pX.price && pX2.price<pY.price && pZ.price>pX2.price
    : pW.price<p0.price && pX.price>pW.price && pY.price<pX.price && pX2.price>pY.price && pZ.price<pX2.price;
  if(!ok) return null;
  const legs=[pW.price-p0.price,pX.price-pW.price,pY.price-pX.price,pX2.price-pY.price,pZ.price-pX2.price].map(Math.abs);
  if(legs.some(x=>x<atr*.2)) return null;
  const balanced=legs.slice(0,3).reduce((a,b)=>a+b,0)/3;
  const confidence=Math.min(70,30+(legs[4]>=balanced*.45?10:0)+(legs[2]>=balanced*.45?8:0));
  return { type:'COMBINATION_WXYXZ', direction:long?'bullish':'bearish', degree:'intermediate', currentWave:'Z',
    pivots:mkPivots(p,['0','W','X','Y','X2','Z']), confidence, invalidation:pX2.price,
    notes:['Complex combination W-X-Y-X-Z'], fibScore:0, primary:true };
}

function zigzagPivots(swings, minLeg) {
  const out = [];
  for (const s of swings) {
    const last = out[out.length - 1];
    if (!last) { out.push(s); continue; }
    if (s.type === last.type) {
      if ((s.type === 'H' && s.price > last.price) || (s.type === 'L' && s.price < last.price)) {
        out[out.length - 1] = s;
      }
      continue;
    }
    if (Math.abs(s.price - last.price) < minLeg) continue;
    out.push(s);
  }
  return out;
}

function collectFromWindow(zzSlice, atr, dir) {
  const found = [];
  const push = (c) => { if (c) found.push(c); };
  push(tryImpulse(zzSlice, atr, dir));
  push(tryPartialImpulse(zzSlice, atr, dir));
  push(tryDiagonal(zzSlice, atr, dir, 'ENDING'));
  push(tryDiagonal(zzSlice, atr, dir, 'LEADING'));
  push(tryCorrection(zzSlice, atr, dir));
  push(tryFlat(zzSlice, atr, dir));
  push(tryTriangle(zzSlice, atr, dir));
  push(tryDoubleZigzag(zzSlice, atr, dir));
  push(tryRunningFlat(zzSlice, atr, dir));
  push(tryExpandedFlat(zzSlice, atr, dir));
  push(tryTripleZigzag(zzSlice, atr, dir));
  push(tryCombinationWxyxz(zzSlice, atr, dir));
  return found;
}

/**
 * Main entry: analyse closed candles for probable Elliott counts.
 */
export function analyseElliottWave(candles, opts = {}) {
  const result = {
    primaryCount: null,
    alternativeCount: null,
    waveScore: 0,
    context: null,
    notes: [],
    allCounts: [],
  };
  if (!candles || candles.length < 40) return result;

  const closed = candles.slice(0, -1);
  const atr = calcATR(closed, 14) || closed[closed.length - 1].close * 0.005;
  const swings = findSwings(closed, opts.left || 3, opts.right || 3);
  if (swings.length < 4) return result;

  const recent = swings.slice(-16);
  const candidates = [];

  if (opts.zigzag) {
    const zz = zigzagPivots(swings.slice(-40), atr * (opts.minLegAtr ?? 0.85));
    const maxTail = opts.maxTailPivots ?? 3;
    for (let tail = 0; tail <= maxTail; tail++) {
      const stop = zz.length - tail;
      if (stop < 4) continue;
      const window = zz.slice(Math.max(0, stop - 8), stop);
      for (const dir of ['bullish', 'bearish']) {
        for (const c of collectFromWindow(window, atr, dir)) {
          candidates.push({ ...c, tail });
        }
      }
    }
    const minConf = opts.minConfidence ?? 48;
    for (let k = candidates.length - 1; k >= 0; k--) {
      if (candidates[k].confidence < minConf) candidates.splice(k, 1);
    }
    candidates.sort((a, b) => (b.confidence - b.tail * 8) - (a.confidence - a.tail * 8));
  } else {
    for (const dir of ['bullish', 'bearish']) {
      for (const c of collectFromWindow(recent, atr, dir)) candidates.push(c);
    }
  }

  if (!candidates.length) {
    result.notes.push('No reliable Elliott count');
    return result;
  }

  if (!opts.zigzag) candidates.sort((a, b) => b.confidence - a.confidence);
  result.allCounts = candidates.map((c) => ({ ...c, primary: false }));
  result.primaryCount = { ...candidates[0], primary: true };
  if (candidates.length > 1 && candidates[1].confidence >= candidates[0].confidence * 0.55) {
    result.alternativeCount = { ...candidates[1], primary: false };
  }

  let score = result.primaryCount.confidence;
  if (result.alternativeCount) {
    const gap = result.primaryCount.confidence - result.alternativeCount.confidence;
    if (gap < 15) score -= 20;
    else if (gap < 25) score -= 10;
    result.notes.push(
      `Alt count: ${result.alternativeCount.type} ${result.alternativeCount.direction} (${result.alternativeCount.confidence}%)`
    );
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  result.waveScore = score;

  const pc = result.primaryCount;
  const waveStr = pc.currentWave != null ? String(pc.currentWave) : '?';
  const dirStr = pc.direction === 'bullish' ? 'up' : 'down';
  const typeLabel = {
    IMPULSE: 'Impulse',
    IMPULSE_PARTIAL: 'Partial impulse',
    ENDING_DIAGONAL: 'Ending diagonal',
    LEADING_DIAGONAL: 'Leading diagonal',
    CORRECTION: 'Zigzag ABC',
    FLAT: 'Flat',
    TRIANGLE: 'Triangle',
    DOUBLE_ZIGZAG: 'Double zigzag',
    RUNNING_FLAT: 'Running flat',
    EXPANDED_FLAT: 'Expanded flat',
    TRIPLE_ZIGZAG: 'Triple zigzag',
    COMBINATION_WXYXZ: 'Complex W-X-Y-X-Z',
  }[pc.type] || pc.type;

  result.context = {
    type: pc.type,
    direction: pc.direction,
    currentWave: pc.currentWave,
    label: `${typeLabel} W${waveStr} ${dirStr}`,
    invalidation: pc.invalidation,
    confidence: pc.confidence,
  };
  result.notes.push(...(pc.notes || []));

  return result;
}

/**
 * Score alignment with Elliott context (confluence points).
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

  const waveBull = pc.direction === 'bullish';
  if (waveBull === wantBull) {
    points += 8;
    notes.push(`EW aligned (${pc.type} ${pc.currentWave})`);
  } else {
    points -= 5;
    notes.push(`EW opposite (${pc.type} ${pc.direction})`);
  }

  const reversalPatterns = [
    'DOUBLE_TOP', 'DOUBLE_BOTTOM', 'TRIPLE_TOP', 'TRIPLE_BOTTOM',
    'HEAD_AND_SHOULDERS', 'INVERSE_HEAD_AND_SHOULDERS', 'RISING_WEDGE', 'FALLING_WEDGE',
  ];
  if (reversalPatterns.includes(patternType)) {
    if ((pc.type === 'IMPULSE' || pc.type === 'ENDING_DIAGONAL') && pc.currentWave === 5 && waveBull !== wantBull) {
      points += 12;
      notes.push('Potential Wave 5 exhaustion (reversal)');
    } else if ((pc.type === 'CORRECTION' || pc.type === 'FLAT' || pc.type === 'DOUBLE_ZIGZAG') &&
               (pc.currentWave === 'C' || pc.currentWave === 'Y')) {
      points += 10;
      notes.push('Potential corrective completion');
    } else if (pc.type === 'TRIANGLE' && pc.currentWave === 'E') {
      points += 8;
      notes.push('Triangle completion');
    }
  }

  const contPatterns = ['BULL_FLAG', 'BEAR_FLAG', 'ASCENDING_TRIANGLE', 'DESCENDING_TRIANGLE'];
  if (contPatterns.includes(patternType)) {
    if ((pc.type === 'IMPULSE' || pc.type === 'IMPULSE_PARTIAL') &&
        (pc.currentWave === 2 || pc.currentWave === 3 || pc.currentWave === 4) &&
        waveBull === wantBull) {
      points += 10;
      notes.push(`Wave ${pc.currentWave} continuation`);
    }
  }

  if (pc.type === 'IMPULSE' || pc.type === 'IMPULSE_PARTIAL' || pc.type === 'ENDING_DIAGONAL' || pc.type === 'LEADING_DIAGONAL') {
    if (waveBull === wantBull && (pc.currentWave === 3 || pc.currentWave === 4 || pc.currentWave === 5)) {
      points += 4;
    }
  }

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
