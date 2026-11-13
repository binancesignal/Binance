/**
 * Price-action & wave patterns for the Chart Pattern strategy.
 *
 *   QUASIMODO            (QM)               bullish / bearish   – retest of the left-shoulder level
 *   ONE_TWO_THREE        (1-2-3 reversal)   bullish / bearish   – break of point 2
 *   WYCKOFF_SPRING                           bullish only        – range-low sweep + reclaim
 *   WYCKOFF_UPTHRUST                         bearish only        – range-high sweep + reject
 *   LIQUIDITY_SWEEP                          bullish / bearish   – swing-level sweep + reclaim
 *   BREAKOUT_RETEST                          bullish / bearish   – broken S/R retested and held
 *   CORRECTIVE_ABC                           bullish / bearish   – zig-zag correction ends at C
 *   ELLIOTT_WAVE         (wave-5 launch)     bullish / bearish   – impulse 1-2-3-4 complete, wave 5 starts
 *
 * Every pattern has the same shape as the other chart patterns (patternType, direction, anchors,
 * support/resistance, patternHeight, startIndex/endIndex, …) plus:
 *   priceAction: true            – routes to validatePriceAction() instead of validateBreakout()
 *   paMode: 'reclaim' | 'zone' | 'break' | 'react'
 *   entryLevel, invalidation, przLow/przHigh
 *
 * All detectors work on CLOSED candles only (the forming bar is dropped) and are mirror-symmetric:
 * bearish setups are detected by negating prices ("v-space") and reusing the bullish logic.
 */
import { findSwings, calcATR } from '../../indicators.js';
import { CHART_PATTERN_CONFIG as CFG } from './config.js';

export const PRICE_ACTION_FAMILIES = [
  'QUASIMODO',
  'ONE_TWO_THREE',
  'WYCKOFF_SPRING',
  'WYCKOFF_UPTHRUST',
  'LIQUIDITY_SWEEP',
  'BREAKOUT_RETEST',
  'CORRECTIVE_ABC',
  'ELLIOTT_WAVE',
];

/** patternType keys (BULL + BEAR) — used by config / admin multi-select */
export const PRICE_ACTION_TYPES = [
  'QUASIMODO_BULL', 'QUASIMODO_BEAR',
  'ONE_TWO_THREE_BULL', 'ONE_TWO_THREE_BEAR',
  'WYCKOFF_SPRING_BULL',
  'WYCKOFF_UPTHRUST_BEAR',
  'LIQUIDITY_SWEEP_BULL', 'LIQUIDITY_SWEEP_BEAR',
  'BREAKOUT_RETEST_BULL', 'BREAKOUT_RETEST_BEAR',
  'CORRECTIVE_ABC_BULL', 'CORRECTIVE_ABC_BEAR',
  'ELLIOTT_WAVE_BULL', 'ELLIOTT_WAVE_BEAR',
];

const flat = (price) => ({ a: price, b: 0, maxDev: 0 });
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Merge consecutive same-type swings (keep the more extreme) so H/L strictly alternate. */
function alternate(swings) {
  const out = [];
  for (const sw of swings) {
    const prev = out[out.length - 1];
    if (prev && prev.type === sw.type) {
      const better = sw.type === 'H' ? sw.price > prev.price : sw.price < prev.price;
      if (better) out[out.length - 1] = sw;
    } else {
      out.push(sw);
    }
  }
  return out;
}

/** All windows of `size` consecutive alternating swings among the last `maxBack` swings. */
function windows(swings, size, maxBack = 16) {
  const recent = swings.slice(-maxBack);
  const out = [];
  for (let i = 0; i + size <= recent.length; i++) out.push(recent.slice(i, i + size));
  return out;
}

function avgVolume(closed, to, len = 20) {
  const from = Math.max(0, to - len);
  let sum = 0;
  let cnt = 0;
  for (let i = from; i < to; i++) {
    sum += closed[i].volume || 0;
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

function build({
  family, direction, pts, level, support, resistance, height, score, mode,
  zoneLow, zoneHigh, invalidation, ratios, touches, startIndex, endIndex,
}) {
  return {
    patternType: `${family}_${direction === 'LONG' ? 'BULL' : 'BEAR'}`,
    priceAction: true,
    paFamily: family,
    paMode: mode,
    direction,
    startIndex: startIndex ?? pts[0].i,
    endIndex: endIndex ?? pts[pts.length - 1].i,
    support,
    resistance,
    neckline: level,
    breakoutLevel: level,
    entryLevel: level,
    invalidation,
    upperLine: flat(resistance),
    lowerLine: flat(support),
    anchors: pts.map((p) => ({ i: p.i, price: p.price, label: p.label })),
    patternHeight: height,
    confidence: Math.round(55 + score * 30),
    fit: score,
    touches: touches ?? pts.length,
    przLow: zoneLow,
    przHigh: zoneHigh,
    ratios: ratios || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Quasimodo (QM): L0 · H1 (left shoulder) · L1 · H2 (head, higher) · L2 (breaks L1)
// Sell the retest of the left-shoulder level; stop above the head.
// ─────────────────────────────────────────────────────────────────────────────
function detectQuasimodo(closed, alt, A) {
  const out = [];
  const n = closed.length;
  for (const P of windows(alt, 5, 16)) {
    if (P.some((p, k) => k > 0 && p.type === P[k - 1].type)) continue;
    const bear = P[4].type === 'L';
    const s = bear ? 1 : -1;
    const v = P.map((p) => s * p.price); // bearish space: low, high, low, high, low
    const [v0, ls, l1, head, bos] = v;
    if (!(v0 < l1)) continue; // prior uptrend: higher low
    if (!(head > ls + 0.15 * A)) continue; // head exceeds the left shoulder
    if (!(bos < l1 - 0.1 * A)) continue; // break of structure below the previous low
    const age = n - 1 - P[4].i;
    if (age > 45) continue;
    // price must not have closed above the head since the BOS
    let dead = false;
    for (let k = P[4].i + 1; k < n; k++) {
      if (s * closed[k].close > head) {
        dead = true;
        break;
      }
    }
    if (dead) continue;
    // retest of the left-shoulder zone after the BOS
    const zoneLo = ls - 0.4 * A;
    const zoneHi = Math.min(head, ls + 0.6 * A);
    let touchIdx = -1;
    for (let k = n - 1; k > P[4].i; k--) {
      const vh = bear ? closed[k].high : -closed[k].low;
      if (vh >= zoneLo) {
        touchIdx = k;
        break;
      }
    }
    if (touchIdx < 0) continue;
    const headPx = P[3].price;
    const bosPx = P[4].price;
    const lsPx = P[1].price;
    const height = Math.abs(headPx - bosPx);
    if (height < 1.2 * A) continue;
    const score = clamp(0.6 + Math.min(0.2, ((head - ls) / A) * 0.05) + (age <= 20 ? 0.1 : 0), 0, 1);
    const zA = s * zoneLo;
    const zB = s * zoneHi;
    out.push(
      build({
        family: 'QUASIMODO',
        direction: bear ? 'SHORT' : 'LONG',
        pts: [
          { ...P[0], label: 'A' },
          { ...P[1], label: 'LS' },
          { ...P[2], label: 'B' },
          { ...P[3], label: 'HEAD' },
          { ...P[4], label: 'BOS' },
        ],
        level: lsPx,
        support: bear ? bosPx : headPx,
        resistance: bear ? headPx : bosPx,
        height,
        score,
        mode: 'zone',
        zoneLow: Math.min(zA, zB),
        zoneHigh: Math.max(zA, zB),
        invalidation: headPx,
        endIndex: touchIdx,
        ratios: { headOverLsATR: (head - ls) / A, bosBelowLowATR: (l1 - bos) / A },
      })
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1-2-3 reversal: point 1 = extreme of a trend, 2 = counter-rally, 3 = higher low (bullish).
// Signal = first close beyond point 2.
// ─────────────────────────────────────────────────────────────────────────────
function detectOneTwoThree(closed, alt, A) {
  const out = [];
  const n = closed.length;
  for (const P of windows(alt, 3, 12)) {
    if (P.some((p, k) => k > 0 && p.type === P[k - 1].type)) continue;
    const bull = P[0].type === 'L';
    const s = bull ? 1 : -1;
    const v = P.map((p) => s * p.price); // low, high, low
    const leg = v[1] - v[0];
    if (leg < 1.5 * A) continue;
    if (!(v[2] > v[0] + 0.1 * A)) continue; // point 3 holds above point 1
    const retr = (v[1] - v[2]) / leg;
    if (retr < 0.3 || retr > 0.95) continue;
    // point 1 must end a real trend: price was clearly higher (v-space) in the 25 bars before it
    const back = Math.max(0, P[0].i - 25);
    let before = -Infinity;
    for (let k = back; k < P[0].i; k++) before = Math.max(before, bull ? closed[k].high : -closed[k].low);
    if (!(before >= v[0] + 2 * A)) continue;
    // first close beyond point 2 after point 3
    let r = -1;
    for (let k = P[2].i + 1; k < n; k++) {
      if (s * closed[k].close < v[2]) {
        r = -2; // closed under point 3 first → pattern dead
        break;
      }
      if (s * closed[k].close > v[1] + 0.1 * A) {
        r = k;
        break;
      }
    }
    if (r < 0 || n - 1 - r > 4) continue;
    // stays above point 3 afterwards
    let dead = false;
    for (let k = r; k < n; k++) if (s * closed[k].close < v[2]) dead = true;
    if (dead) continue;
    const p1 = P[0].price;
    const p2 = P[1].price;
    const p3 = P[2].price;
    const score = clamp(0.58 + (retr >= 0.382 && retr <= 0.786 ? 0.12 : 0) + Math.min(0.15, (leg / A) * 0.02) + (n - 1 - r <= 1 ? 0.1 : 0), 0, 1);
    out.push(
      build({
        family: 'ONE_TWO_THREE',
        direction: bull ? 'LONG' : 'SHORT',
        pts: [
          { ...P[0], label: '1' },
          { ...P[1], label: '2' },
          { ...P[2], label: '3' },
        ],
        level: p2,
        support: bull ? p3 : p2,
        resistance: bull ? p2 : p3,
        height: Math.abs(p2 - p1),
        score,
        mode: 'break',
        zoneLow: Math.min(p2, p2 + (bull ? -0.2 : 0.2) * A),
        zoneHigh: Math.max(p2, p2 + (bull ? -0.2 : 0.2) * A),
        invalidation: p3,
        endIndex: r,
        ratios: { retrace: retr },
      })
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Corrective ABC (zig-zag) inside a trend: S · top · A · B · C — LONG when C ends a pullback in an uptrend.
// ─────────────────────────────────────────────────────────────────────────────
function detectCorrectiveABC(closed, alt, A) {
  const out = [];
  const n = closed.length;
  for (const P of windows(alt, 5, 16)) {
    if (P.some((p, k) => k > 0 && p.type === P[k - 1].type)) continue;
    const bull = P[4].type === 'L';
    const s = bull ? 1 : -1;
    const v = P.map((p) => s * p.price); // low(start), high(impulse top), low(A), high(B), low(C)
    const imp = v[1] - v[0];
    const a = v[1] - v[2];
    const bRetr = (v[3] - v[2]) / a;
    const cA = (v[3] - v[4]) / a;
    if (imp < 2.5 * A || a < 1.0 * A) continue;
    if (imp < a) continue; // trend leg bigger than the correction leg
    if (bRetr < 0.382 || bRetr > 0.886) continue;
    if (!(v[4] < v[2] - 0.05 * A)) continue; // C pushes beyond A (zig-zag)
    if (cA < 0.9 || cA > 1.75) continue;
    if (!(v[4] > v[0])) continue; // correction does not erase the whole impulse
    if ((v[1] - v[4]) / imp > 0.886) continue;
    if (n - 1 - P[4].i > 12) continue;
    const cPx = P[4].price;
    const topPx = P[1].price;
    const score = clamp(0.6 + (bRetr >= 0.5 && bRetr <= 0.786 ? 0.1 : 0) + (cA >= 1.0 && cA <= 1.272 ? 0.1 : 0) + Math.min(0.1, (imp / A) * 0.01), 0, 1);
    out.push(
      build({
        family: 'CORRECTIVE_ABC',
        direction: bull ? 'LONG' : 'SHORT',
        pts: [
          { ...P[1], label: '0' },
          { ...P[2], label: 'A' },
          { ...P[3], label: 'B' },
          { ...P[4], label: 'C' },
        ],
        level: cPx,
        support: bull ? cPx : topPx,
        resistance: bull ? topPx : cPx,
        height: Math.abs(topPx - cPx),
        score,
        mode: 'react',
        zoneLow: Math.min(cPx, cPx + (bull ? 0.5 : -0.5) * A),
        zoneHigh: Math.max(cPx, cPx + (bull ? 0.5 : -0.5) * A),
        invalidation: cPx,
        startIndex: P[0].i,
        ratios: { bRetrace: bRetr, cOverA: cA },
      })
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Elliott Wave — wave-5 launch: waves 1-2-3-4 are complete and wave 4 has held (strict rules).
//   W2 stays above the origin · W3 longer than W1 · W4 does not overlap W1 · W4 retraces 0.236–0.618 of W3
// ─────────────────────────────────────────────────────────────────────────────
function detectElliottWave(closed, alt, A) {
  const out = [];
  const n = closed.length;
  for (const P of windows(alt, 5, 16)) {
    if (P.some((p, k) => k > 0 && p.type === P[k - 1].type)) continue;
    const bull = P[4].type === 'L';
    const s = bull ? 1 : -1;
    const v = P.map((p) => s * p.price); // origin, W1 end, W2 end, W3 end, W4 end
    const w1 = v[1] - v[0];
    const w3 = v[3] - v[2];
    if (w1 < 1.5 * A) continue;
    if (!(v[2] > v[0])) continue; // wave 2 never breaks the origin
    const r2 = (v[1] - v[2]) / w1;
    if (r2 < 0.236 || r2 > 0.886) continue;
    if (!(v[3] > v[1] && w3 > w1)) continue; // wave 3 is the longest so far
    const r4 = (v[3] - v[4]) / w3;
    if (r4 < 0.236 || r4 > 0.618) continue;
    if (!(v[4] > v[1])) continue; // no overlap with wave 1 territory
    if (n - 1 - P[4].i > 12) continue;
    const w4Px = P[4].price;
    const score = clamp(0.6 + (r2 >= 0.382 && r2 <= 0.786 ? 0.1 : 0) + (r4 >= 0.236 && r4 <= 0.5 ? 0.1 : 0) + (w3 >= 1.618 * w1 ? 0.1 : 0.05), 0, 1);
    const w1Len = Math.abs(P[1].price - P[0].price);
    out.push(
      build({
        family: 'ELLIOTT_WAVE',
        direction: bull ? 'LONG' : 'SHORT',
        pts: [
          { ...P[0], label: '0' },
          { ...P[1], label: '1' },
          { ...P[2], label: '2' },
          { ...P[3], label: '3' },
          { ...P[4], label: '4' },
        ],
        level: w4Px,
        support: bull ? w4Px : P[3].price,
        resistance: bull ? P[3].price : w4Px,
        height: w1Len,
        score,
        mode: 'react',
        zoneLow: Math.min(w4Px, w4Px + (bull ? 0.5 : -0.5) * A),
        zoneHigh: Math.max(w4Px, w4Px + (bull ? 0.5 : -0.5) * A),
        invalidation: P[1].price, // closing back through wave-1 territory kills the count
        ratios: { wave2Retrace: r2, wave3OverWave1: w3 / w1, wave4Retrace: r4 },
      })
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Liquidity sweep / Wyckoff Spring / Wyckoff Upthrust
//   A resting swing level is pierced by a wick (0.1–1.6 ATR) and price closes back beyond it within 3 bars.
//   Sweep of a sideways range low  → WYCKOFF_SPRING (bullish); range high → WYCKOFF_UPTHRUST (bearish);
//   any other untouched swing level → LIQUIDITY_SWEEP (either direction).
// ─────────────────────────────────────────────────────────────────────────────
function detectSweeps(closed, swings, A) {
  const out = [];
  const n = closed.length;
  for (const dir of ['LONG', 'SHORT']) {
    const s = dir === 'LONG' ? 1 : -1;
    const vLow = (c) => (dir === 'LONG' ? c.low : -c.high);
    const vHigh = (c) => (dir === 'LONG' ? c.high : -c.low);
    const vClose = (c) => s * c.close;
    const wantType = dir === 'LONG' ? 'L' : 'H';
    let best = null;
    for (let sb = n - 1; sb >= Math.max(0, n - 8); sb--) {
      for (const sw of swings) {
        if (sw.type !== wantType) continue;
        if (sw.i > sb - 6 || sw.i < sb - 80) continue;
        const lvl = s * sw.price;
        let intact = true;
        for (let k = sw.i + 1; k < sb; k++) {
          if (vClose(closed[k]) < lvl || vLow(closed[k]) < lvl - 0.1 * A) {
            intact = false;
            break;
          }
        }
        if (!intact) continue;
        const pen = lvl - vLow(closed[sb]);
        if (pen < 0.1 * A || pen > 1.6 * A) continue;
        let r = -1;
        for (let k = sb; k <= Math.min(sb + 2, n - 1); k++) {
          if (vClose(closed[k]) > lvl) {
            r = k;
            break;
          }
          if (vClose(closed[k]) < lvl - 0.8 * A) break;
        }
        if (r < 0) continue;
        let ext = Infinity;
        for (let k = sb; k <= r; k++) ext = Math.min(ext, vLow(closed[k]));
        // range context before the sweep bar
        const w0 = Math.max(0, sb - 40);
        let top = -Infinity;
        for (let k = w0; k < sb; k++) top = Math.max(top, vHigh(closed[k]));
        const rangeH = top - lvl;
        if (!(rangeH >= 1.2 * A)) continue;
        const touches = swings.filter((x) => x.type === wantType && x.i >= w0 && x.i < sb && Math.abs(s * x.price - lvl) <= 0.4 * A).length;
        const topTouches = swings.filter((x) => x.type !== wantType && x.i >= w0 && x.i < sb && s * x.price >= top - 0.5 * A).length;
        const drift = Math.abs(vClose(closed[Math.max(0, sb - 1)]) - vClose(closed[Math.max(0, sb - 30)]));
        const isRange = touches >= 2 && sb - sw.i >= 15 && rangeH >= 1.5 * A && rangeH <= 8 * A && topTouches >= 1 && drift <= 0.6 * rangeH;
        const cb = closed[sb];
        const rng = cb.high - cb.low || 1e-9;
        const wick = dir === 'LONG' ? (cb.close - cb.low) / rng : (cb.high - cb.close) / rng;
        const va = avgVolume(closed, sb);
        const volSpike = va > 0 && (cb.volume || 0) >= 1.3 * va;
        const score = clamp(
          0.55 + (touches >= 2 ? 0.1 : 0) + (wick >= 0.5 ? 0.1 : 0) + (volSpike ? 0.1 : 0) + (r === sb ? 0.05 : 0) + (isRange ? 0.1 : 0),
          0,
          1
        );
        if (!best || score > best.score || (score === best.score && sb > best.sb)) {
          best = { sb, r, sw, lvl, ext, top, rangeH, touches, isRange, score, wick, volSpike, pen };
        }
      }
    }
    if (!best) continue;
    const family = best.isRange ? (dir === 'LONG' ? 'WYCKOFF_SPRING' : 'WYCKOFF_UPTHRUST') : 'LIQUIDITY_SWEEP';
    const lvlPx = s * best.lvl;
    const extPx = s * best.ext;
    const topPx = s * best.top;
    const sweepBar = closed[best.sb];
    const reclaimBar = closed[best.r];
    const pts = [
      { i: best.sw.i, price: best.sw.price, label: 'LIQ' },
      { i: best.sb, price: dir === 'LONG' ? sweepBar.low : sweepBar.high, label: family === 'LIQUIDITY_SWEEP' ? 'SWEEP' : dir === 'LONG' ? 'SPRING' : 'UT' },
      { i: best.r, price: reclaimBar.close, label: 'RECLAIM' },
    ];
    out.push(
      build({
        family,
        direction: dir,
        pts,
        level: lvlPx,
        support: dir === 'LONG' ? extPx : lvlPx,
        resistance: dir === 'LONG' ? topPx : extPx,
        height: Math.min(best.rangeH, family === 'LIQUIDITY_SWEEP' ? 5 * A : 8 * A),
        score: best.score,
        mode: 'reclaim',
        zoneLow: Math.min(lvlPx, extPx),
        zoneHigh: Math.max(lvlPx, extPx),
        invalidation: extPx,
        touches: Math.max(2, best.touches + 1),
        ratios: { sweepATR: best.pen / A, wickRatio: best.wick, volumeSpike: best.volSpike },
      })
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Breakout + Retest: a horizontal S/R level (≥2 swing touches) is broken by a close, price runs away
// from it, then returns to the level and holds.
// ─────────────────────────────────────────────────────────────────────────────
function detectBreakoutRetest(closed, swings, A) {
  const out = [];
  const n = closed.length;
  for (const dir of ['LONG', 'SHORT']) {
    const s = dir === 'LONG' ? 1 : -1;
    const vLow = (c) => (dir === 'LONG' ? c.low : -c.high);
    const vClose = (c) => s * c.close;
    const t = dir === 'LONG' ? 'H' : 'L';
    const sws = swings.filter((x) => x.type === t && x.i >= n - 90 && x.i <= n - 8);
    let best = null;
    for (const anchor of sws) {
      const base = s * anchor.price;
      const cluster = sws.filter((x) => Math.abs(s * x.price - base) <= 0.35 * A);
      if (cluster.length < 2) continue;
      const first = Math.min(...cluster.map((x) => x.i));
      const lastTouch = Math.max(...cluster.map((x) => x.i));
      if (lastTouch - first < 5) continue;
      const lvl = cluster.reduce((sum, x) => sum + s * x.price, 0) / cluster.length;
      // first close through the level (level must be intact until then)
      let b = -1;
      for (let k = first + 1; k < n; k++) {
        if (vClose(closed[k]) > lvl + 0.15 * A) {
          b = k;
          break;
        }
      }
      if (b < 0 || b <= lastTouch) continue;
      if (b > n - 3) continue; // need room for a retest
      // price must have really left the level, then come back
      let maxAway = -Infinity;
      let r = -1;
      let held = true;
      for (let k = b; k < n; k++) {
        maxAway = Math.max(maxAway, vClose(closed[k]) - lvl);
        if (vClose(closed[k]) < lvl - 0.3 * A) held = false;
        if (k >= b + 2 && vLow(closed[k]) <= lvl + 0.3 * A) r = k;
      }
      if (!held || r < 0 || maxAway < 0.6 * A) continue;
      if (n - 1 - r > 4) continue;
      let baseLow = Infinity;
      for (let k = first; k <= b; k++) baseLow = Math.min(baseLow, vLow(closed[k]));
      const height = clamp(lvl - baseLow, 1.2 * A, 6 * A);
      if (!(lvl - baseLow >= 1.0 * A)) continue;
      let retestExt = Infinity;
      for (let k = Math.max(b + 1, r - 1); k < n; k++) retestExt = Math.min(retestExt, vLow(closed[k]));
      const cr = closed[r];
      const rng = cr.high - cr.low || 1e-9;
      const wick = dir === 'LONG' ? (cr.close - cr.low) / rng : (cr.high - cr.close) / rng;
      const score = clamp(0.58 + (cluster.length >= 3 ? 0.1 : 0.04) + (wick >= 0.5 ? 0.1 : 0) + (maxAway >= 1.2 * A ? 0.1 : 0.04), 0, 1);
      if (!best || b > best.b) best = { b, r, lvl, first, cluster, height, retestExt, score, maxAway };
    }
    if (!best) continue;
    const lvlPx = s * best.lvl;
    const extPx = s * best.retestExt;
    const targetPx = lvlPx + (dir === 'LONG' ? best.height : -best.height);
    const pts = [
      ...best.cluster
        .slice()
        .sort((a, c) => a.i - c.i)
        .slice(0, 2)
        .map((x, k) => ({ i: x.i, price: x.price, label: `L${k + 1}` })),
      { i: best.b, price: closed[best.b].close, label: 'BRK' },
      { i: best.r, price: dir === 'LONG' ? closed[best.r].low : closed[best.r].high, label: 'RT' },
    ];
    out.push(
      build({
        family: 'BREAKOUT_RETEST',
        direction: dir,
        pts,
        level: lvlPx,
        support: dir === 'LONG' ? extPx : targetPx,
        resistance: dir === 'LONG' ? targetPx : extPx,
        height: best.height,
        score: best.score,
        mode: 'zone',
        zoneLow: Math.min(lvlPx - 0.3 * A, lvlPx + 0.3 * A),
        zoneHigh: Math.max(lvlPx - 0.3 * A, lvlPx + 0.3 * A),
        invalidation: lvlPx - (dir === 'LONG' ? 0.5 : -0.5) * A,
        touches: best.cluster.length,
        endIndex: best.r,
        startIndex: best.first,
        ratios: { runawayATR: best.maxAway / A },
      })
    );
  }
  return out;
}

/** Detect all price-action / wave patterns. Never throws. */
export function detectPriceActionPatterns(candles, atr) {
  if (!candles || candles.length < 40) return [];
  const closed = candles.slice(0, -1);
  const A = atr > 0 ? atr : calcATR(closed, 14) || 0;
  if (!(A > 0)) return [];
  const swings = findSwings(closed, 3, 3);
  if (swings.length < 3) return [];
  const alt = alternate(swings);
  const out = [];
  const run = (fn, sw) => {
    try {
      out.push(...fn(closed, sw, A));
    } catch (_) {}
  };
  run(detectQuasimodo, alt);
  run(detectOneTwoThree, alt);
  run(detectCorrectiveABC, alt);
  run(detectElliottWave, alt);
  run(detectSweeps, swings);
  run(detectBreakoutRetest, swings);

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
 * Entry validation for price-action patterns (counterpart of validateBreakout / validateHarmonic).
 *   reclaim – last closed candle holds beyond the swept level
 *   zone    – a recent candle touched the zone; last candle confirms in trade direction
 *   break   – fresh close beyond point 2 (1-2-3)
 *   react   – last candle confirms the turn away from the completion point (ABC / wave 4)
 */
export function validatePriceAction(pattern, candles, atr, cfg = CFG) {
  if (!pattern?.priceAction) return { ok: false, reason: 'Not a price-action pattern' };
  if (!candles?.length) return { ok: false, reason: 'No candles' };
  const closed = candles.slice(0, -1);
  if (closed.length < 20) return { ok: false, reason: 'Not enough candles' };
  const A = atr > 0 ? atr : calcATR(closed, 14) || 0;
  const bi = closed.length - 1;
  const last = closed[bi];
  const dir = pattern.direction;
  const long = dir === 'LONG';
  const L = pattern.entryLevel;
  if (L == null) return { ok: false, reason: 'No entry level' };
  const mode = pattern.paMode;
  const label = pattern.paFamily || pattern.patternType;

  const maxAge = mode === 'break' ? cfg.paBreakMaxAgeBars ?? 2 : cfg.paMaxAgeBars ?? 8;
  const age = bi - (pattern.endIndex ?? bi);
  if (age > maxAge) return { ok: false, reason: `${label} too old (${age} bars)` };

  // invalidation: a CLOSE through the stop reference kills the setup
  const inv = pattern.invalidation;
  if (inv != null && (long ? last.close < inv : last.close > inv)) {
    return { ok: false, reason: `${label} invalidated (closed beyond ${inv})` };
  }

  const body = last.close - last.open;
  const range = last.high - last.low || 1e-9;
  const bodyRatio = Math.abs(body) / range;
  const inDir = long ? body > 0 : body < 0;
  const pad = A > 0 ? A * (cfg.paZoneATR ?? 0.35) : Math.abs(L) * 0.002;
  const zl = pattern.przLow ?? L - pad;
  const zh = pattern.przHigh ?? L + pad;

  if (mode === 'reclaim') {
    if (long ? !(last.close > L) : !(last.close < L)) return { ok: false, reason: `${label}: not holding beyond swept level` };
    if (age > 0 && !inDir && bodyRatio > 0.6) return { ok: false, reason: `${label}: strong counter candle after reclaim` };
  } else if (mode === 'zone') {
    let touched = false;
    for (let k = Math.max(0, bi - 2); k <= bi; k++) {
      if (closed[k].low <= zh && closed[k].high >= zl) touched = true;
    }
    if (!touched) return { ok: false, reason: `${label}: price not in retest zone` };
    if (!inDir) return { ok: false, reason: `${label}: no ${long ? 'bullish' : 'bearish'} confirmation candle` };
    if (long ? !(last.close >= zl) : !(last.close <= zh)) return { ok: false, reason: `${label}: closed back through the zone` };
  } else if (mode === 'break') {
    const need = A > 0 ? A * (cfg.breakoutAtrMin ?? 0.15) : 0;
    if (long ? !(last.close > L + need) : !(last.close < L - need)) return { ok: false, reason: `${label}: no close beyond point 2` };
    if (!inDir) return { ok: false, reason: `${label}: last candle against the break` };
  } else if (mode === 'react') {
    if (long ? !(last.close > L) : !(last.close < L)) return { ok: false, reason: `${label}: price not turning away from completion point` };
    if (!inDir) return { ok: false, reason: `${label}: no ${long ? 'bullish' : 'bearish'} confirmation candle` };
  } else {
    return { ok: false, reason: 'Unknown price-action mode' };
  }

  const dist = long ? last.close - L : L - last.close;
  const distAtr = A > 0 ? dist / A : 0;
  if (A > 0 && distAtr > (cfg.maxBreakoutDistanceATR ?? 1.8)) {
    return { ok: false, reason: `${label}: too extended (${distAtr.toFixed(2)} ATR)` };
  }

  const va = avgVolume(closed, bi);
  const rvol = va > 0 ? (last.volume || 0) / va : 1;
  const softFails = [];
  if (bodyRatio < (cfg.minBodyRatio ?? 0.45)) softFails.push(`weak confirmation body (${bodyRatio.toFixed(2)})`);

  return {
    ok: true,
    direction: dir,
    entry: last.close,
    level: L,
    breakoutIndex: bi,
    distAtr,
    bodyRatio,
    rvol,
    softFails,
    priceAction: true,
  };
}
