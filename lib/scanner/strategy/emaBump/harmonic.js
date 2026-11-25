/**
 * EMA Bump × Harmonic overlay
 *
 * User mapping (down-leg LONG example; SHORT is mirrored):
 *   X  = nearest HH before the dip
 *   A  = LL (the EMA-bump dip)
 *   B  = TOP / entry-mark (EMA-bump top high)
 *   C  = future entry zone (BC retrace of AB, typically 0.382–0.886)
 *   D  = TP projection (AD ratios of the matched harmonic family)
 *   SL = below A (LL)
 *
 * When useHarmonicEntry is on, the live/backtest entry is the C zone (not the top break).
 */

/** Ideal XB windows (how much of XA was recovered at B). Same family names as chartPattern/harmonics. */
const XB_SPECS = {
  GARTLEY: { XB: [0.55, 0.68], AD: [0.72, 0.86], idealXB: 0.618, idealAD: 0.786 },
  BAT: { XB: [0.35, 0.55], AD: [0.82, 0.95], idealXB: 0.5, idealAD: 0.886 },
  ALT_BAT: { XB: [0.33, 0.43], AD: [1.05, 1.2], idealXB: 0.382, idealAD: 1.13 },
  BUTTERFLY: { XB: [0.72, 0.86], AD: [1.2, 1.7], idealXB: 0.786, idealAD: 1.27 },
  CRAB: { XB: [0.35, 0.65], AD: [1.5, 1.75], idealXB: 0.618, idealAD: 1.618 },
  DEEP_CRAB: { XB: [0.82, 0.95], AD: [1.5, 1.75], idealXB: 0.886, idealAD: 1.618 },
};

const DEFAULT_BC = [0.382, 0.886];

/**
 * Find HH (X) before the dip index on a bull-oriented series.
 * Prefer the highest swing high strictly before `lo`, falling back to raw max high.
 */
function findX(cs, lo, lookback = 60) {
  const from = Math.max(1, lo - lookback);
  let bestI = -1;
  let bestP = -Infinity;
  // prefer local swing highs (left=2,right=2)
  for (let i = from + 2; i <= lo - 2; i++) {
    const h = cs[i].high;
    if (h > cs[i - 1].high && h > cs[i - 2].high && h >= cs[i + 1].high && h >= cs[i + 2].high) {
      if (h > bestP) {
        bestP = h;
        bestI = i;
      }
    }
  }
  if (bestI < 0) {
    for (let i = from; i < lo; i++) {
      if (cs[i].high > bestP) {
        bestP = cs[i].high;
        bestI = i;
      }
    }
  }
  if (bestI < 0 || !(bestP > 0)) return null;
  return { i: bestI, price: bestP, time: cs[bestI].time };
}

/**
 * Build XAB → match harmonic family → project C zone + D targets.
 * Works on the (possibly mirrored) bull series: A low, B high, X higher than A.
 *
 * @returns {null | object}
 */
export function buildEmaBumpHarmonic(cs, d, atr, cfg = {}) {
  const lo = d.lo;
  const th = d.th;
  if (lo == null || th == null || lo >= th) return null;
  if (!cs[lo] || !cs[th]) return null;

  const A = { i: lo, price: +cs[lo].low, time: cs[lo].time };
  const B = { i: th, price: +cs[th].high, time: cs[th].time };
  const X = findX(cs, lo, cfg.harmonicXLookback || 60);
  if (!X) return null;

  const XA = X.price - A.price;
  const AB = B.price - A.price;
  if (!(XA > 0) || !(AB > 0)) return null;
  // B should sit between A and X (partial recovery of the down leg)
  if (B.price >= X.price) return null;

  const XB = AB / XA;
  const allowed = Array.isArray(cfg.harmonicPatterns) && cfg.harmonicPatterns.length
    ? cfg.harmonicPatterns.map(String)
    : Object.keys(XB_SPECS);

  const hits = [];
  for (const name of allowed) {
    const sp = XB_SPECS[name];
    if (!sp) continue;
    if (XB >= sp.XB[0] && XB <= sp.XB[1]) {
      const mid = (sp.XB[0] + sp.XB[1]) / 2;
      const score = 1 - Math.abs(XB - mid) / Math.max(0.15, (sp.XB[1] - sp.XB[0]));
      hits.push({ type: name, score: Math.max(0.4, Math.min(1, score)), sp });
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score);
  const best = hits[0];

  const bcMin = Number.isFinite(+cfg.harmonicBcMin) ? +cfg.harmonicBcMin : DEFAULT_BC[0];
  const bcMax = Number.isFinite(+cfg.harmonicBcMax) ? +cfg.harmonicBcMax : DEFAULT_BC[1];
  // C zone: retrace of AB from B toward A
  const cHi = B.price - bcMin * AB; // shallower (closer to B)
  const cLo = B.price - bcMax * AB; // deeper (closer to A)
  const cMid = (cHi + cLo) / 2;

  // D projections from AD ratios of the matched family (and siblings)
  const dLevels = [];
  const seen = new Set();
  for (const h of hits) {
    for (const ad of [h.sp.idealAD, h.sp.AD[0], h.sp.AD[1]]) {
      const p = A.price + ad * XA; // measured from A toward/beyond X
      const key = p.toFixed(8);
      if (seen.has(key)) continue;
      seen.add(key);
      dLevels.push({ price: p, ratio: ad, from: h.type });
    }
  }
  dLevels.sort((a, b) => a.price - b.price);

  // Prefer D above B (extension targets) for LONG TP; still keep all for chart
  const tpCandidates = dLevels.filter((x) => x.price > B.price);
  const dPrimary = tpCandidates[0] || dLevels[dLevels.length - 1] || { price: B.price + AB, ratio: 1 };

  const zonePad = (atr > 0 ? atr : AB) * (cfg.harmonicZonePadATR ?? 0.05);

  return {
    pattern: best.type,
    score: best.score,
    XB: +XB.toFixed(4),
    X: { time: X.time, price: X.price, i: X.i },
    A: { time: A.time, price: A.price, i: A.i },
    B: { time: B.time, price: B.price, i: B.i },
    // C entry zone (zone-style)
    C: {
      high: cHi,
      low: cLo,
      mid: cMid,
      zoneHigh: cHi + zonePad,
      zoneLow: Math.max(A.price, cLo - zonePad),
    },
    D: { price: dPrimary.price, ratio: dPrimary.ratio },
    dLevels,
    XA,
    AB,
    hits: hits.map((h) => h.type),
  };
}

/**
 * After READY: wait for price to enter the C zone, then resolve TP (D / R-multiples) vs SL (below A).
 * Bull series prices.
 */
export function resolveHarmonicCTrade(cs, readyIdx, harm, atr, cfg = {}) {
  const n = cs.length;
  const entry = harm.C.mid;
  const zoneHi = harm.C.zoneHigh;
  const zoneLo = harm.C.zoneLow;
  const sl = harm.A.price - (cfg.slBufferATR ?? 0.2) * (atr || 0);
  // TPs: D primary + R multiples from C entry
  const risk = entry - sl;
  if (!(risk > 0)) {
    return { outcome: 'INVALID', entry, sl, tp1: entry, bars: 0, fillBar: -1, mfe: 0, mae: 0 };
  }
  const tp1 = Math.max(harm.D.price, entry + risk * (cfg.tp1R ?? 1.2));
  const tp2 = entry + risk * (cfg.tp2R ?? 2);
  const tp3 = entry + risk * (cfg.tp3R ?? 3);

  const maxWait = cfg.harmonicMaxCWaitBars ?? 50;
  const maxBars = cfg.harmonicMaxTradeBars ?? 80;
  let fillBar = -1;
  const waitEnd = Math.min(n - 1, readyIdx + maxWait);
  for (let j = readyIdx; j <= waitEnd; j++) {
    const c = cs[j];
    // touch C zone
    if (c.low <= zoneHi && c.high >= zoneLo) {
      fillBar = j;
      break;
    }
  }
  if (fillBar < 0) {
    return {
      outcome: 'NO_ENTRY',
      entry, sl, tp1, tp2, tp3,
      mfe: 0, mae: 0, bars: waitEnd - readyIdx, fillBar: -1,
    };
  }

  let mfe = 0;
  let mae = 0;
  const last = Math.min(n - 1, fillBar + maxBars);
  for (let j = fillBar; j <= last; j++) {
    const c = cs[j];
    mfe = Math.max(mfe, c.high - entry);
    mae = Math.max(mae, entry - c.low);
    if (c.low <= sl) {
      return { outcome: 'LOSS', entry, sl, tp1, tp2, tp3, mfe, mae, bars: j - fillBar, fillBar };
    }
    if (c.high >= tp1) {
      return { outcome: 'WIN', entry, sl, tp1, tp2, tp3, mfe, mae, bars: j - fillBar, fillBar };
    }
  }
  const resolved = n - 1 >= fillBar + maxBars;
  return {
    outcome: resolved ? 'TIMEOUT' : 'OPEN',
    entry, sl, tp1, tp2, tp3,
    mfe, mae, bars: last - fillBar, fillBar,
  };
}

export { XB_SPECS };
