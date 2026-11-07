import { findSwings, calcATR, avg } from '../../indicators.js';
import { CHART_PATTERN_CONFIG as CFG } from './config.js';
import { detectHarmonicPatterns } from './harmonics.js';
import { detectPriceActionPatterns } from './priceAction.js';

/* ---------- geometry helpers ---------- */

/** least-squares line through swing points, x = candle index → price = a + b*x */
export function fitLine(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (const p of pts) {
    sx += p.i; sy += p.price; sxy += p.i * p.price; sx2 += p.i * p.i;
  }
  const den = n * sx2 - sx * sx;
  if (!den) return null;
  const b = (n * sxy - sx * sy) / den;
  const a = (sy - b * sx) / n;
  const maxDev = Math.max(...pts.map((p) => Math.abs(p.price - (a + b * p.i))));
  return { a, b, maxDev };
}
export const lineAt = (ln, i) => (ln ? ln.a + ln.b * i : null);
const flatLine = (price) => ({ a: price, b: 0, maxDev: 0 });
const nearEqual = (a, b, tol) => Math.abs(a - b) <= tol;

/**
 * CLASSIC patterns (unchanged logic): Double/Triple Top & Bottom, H&S / Inverse,
 * Rectangle, Asc/Desc/Sym Triangle, Rising/Falling Wedge, Bull/Bear Flag.
 */
function detectClassicPatterns(candles, atr) {
  if (!candles || candles.length < 30) return [];
  const closed = candles.slice(0, -1);
  const swings = findSwings(closed, 3, 3);
  if (swings.length < 4) return [];
  const atrVal = atr > 0 ? atr : calcATR(closed, 14) || 0;
  const tol = atrVal > 0 ? atrVal * 0.35 : closed[closed.length - 1].close * 0.004;
  const maxDev = (atrVal > 0 ? atrVal : tol) * (CFG.maxLineDeviationATR ?? 0.45);
  const minH = CFG.minPatternHeightATR || 0.8;
  const patterns = [];

  const recent = swings.slice(-12);
  const rh = recent.filter((s) => s.type === 'H');
  const rl = recent.filter((s) => s.type === 'L');
  const anc = (arr, prefix) => arr.map((s, k) => ({ i: s.i, price: s.price, label: `${prefix}${k + 1}` }));

  // --- Double Top / Bottom ---
  if (rh.length >= 2 && rl.length >= 1) {
    const h1 = rh[rh.length - 2];
    const h2 = rh[rh.length - 1];
    if (nearEqual(h1.price, h2.price, tol) && h2.i - h1.i >= 5) {
      const neck = rl.filter((l) => l.i > h1.i && l.i < h2.i).sort((a, b) => a.price - b.price)[0];
      if (neck) {
        const topP = (h1.price + h2.price) / 2;
        const height = topP - neck.price;
        if (atrVal <= 0 || height >= atrVal * minH) {
          patterns.push({
            patternType: 'DOUBLE_TOP', direction: 'SHORT',
            startIndex: h1.i, endIndex: h2.i,
            support: neck.price, resistance: topP, neckline: neck.price, breakoutLevel: neck.price,
            upperLine: flatLine(topP), lowerLine: flatLine(neck.price),
            anchors: [
              { i: h1.i, price: h1.price, label: 'Top 1' },
              { i: neck.i, price: neck.price, label: 'Neck' },
              { i: h2.i, price: h2.price, label: 'Top 2' },
            ],
            patternHeight: height, confidence: 70, fit: 1 - Math.abs(h1.price - h2.price) / tol / 2, touches: 2,
          });
        }
      }
    }
  }
  if (rl.length >= 2 && rh.length >= 1) {
    const l1 = rl[rl.length - 2];
    const l2 = rl[rl.length - 1];
    if (nearEqual(l1.price, l2.price, tol) && l2.i - l1.i >= 5) {
      const neck = rh.filter((h) => h.i > l1.i && h.i < l2.i).sort((a, b) => b.price - a.price)[0];
      if (neck) {
        const botP = (l1.price + l2.price) / 2;
        const height = neck.price - botP;
        if (atrVal <= 0 || height >= atrVal * minH) {
          patterns.push({
            patternType: 'DOUBLE_BOTTOM', direction: 'LONG',
            startIndex: l1.i, endIndex: l2.i,
            support: botP, resistance: neck.price, neckline: neck.price, breakoutLevel: neck.price,
            upperLine: flatLine(neck.price), lowerLine: flatLine(botP),
            anchors: [
              { i: l1.i, price: l1.price, label: 'Bottom 1' },
              { i: neck.i, price: neck.price, label: 'Neck' },
              { i: l2.i, price: l2.price, label: 'Bottom 2' },
            ],
            patternHeight: height, confidence: 70, fit: 1 - Math.abs(l1.price - l2.price) / tol / 2, touches: 2,
          });
        }
      }
    }
  }

  // --- trendline based patterns (rectangle / triangles / wedges) ---
  const hSel = rh.slice(-4);
  const lSel = rl.slice(-4);
  if (hSel.length >= 2 && lSel.length >= 2) {
    const up = fitLine(hSel);
    const lo = fitLine(lSel);
    const iStart = Math.min(hSel[0].i, lSel[0].i);
    const iEnd = Math.max(hSel[hSel.length - 1].i, lSel[lSel.length - 1].i);
    if (up && lo && iEnd - iStart >= 8 && up.maxDev <= maxDev && lo.maxDev <= maxDev) {
      const hEnd = lineAt(up, iEnd);
      const lEnd = lineAt(lo, iEnd);
      const hStart = lineAt(up, iStart);
      const lStart = lineAt(lo, iStart);
      const heightEnd = hEnd - lEnd;
      const heightStart = hStart - lStart;
      const span = iEnd - iStart;
      // slope expressed as total move over the pattern, in ATR
      const upMove = (up.b * span) / (atrVal || tol);
      const loMove = (lo.b * span) / (atrVal || tol);
      const flatU = Math.abs(upMove) < 0.6;
      const flatL = Math.abs(loMove) < 0.6;
      const touches = hSel.length + lSel.length;
      const anchors = [...anc(hSel, 'H'), ...anc(lSel, 'L')].sort((a, b) => a.i - b.i);
      const fit = Math.max(0, 1 - (up.maxDev + lo.maxDev) / (2 * maxDev));
      const base = {
        startIndex: iStart, endIndex: iEnd, upperLine: up, lowerLine: lo, anchors, touches, fit,
        support: lEnd, resistance: hEnd, patternHeight: Math.max(heightStart, heightEnd),
      };
      const hOk = heightEnd > 0 && (atrVal <= 0 || heightEnd >= atrVal * 0.4) && (atrVal <= 0 || heightStart >= atrVal * minH);

      if (hOk) {
        if (flatU && flatL) {
          const flatUp = flatLine(avg(hSel.map((h) => h.price)));
          const flatLo = flatLine(avg(lSel.map((l) => l.price)));
          const rect = { ...base, upperLine: flatUp, lowerLine: flatLo, support: flatLo.a, resistance: flatUp.a, patternHeight: flatUp.a - flatLo.a };
          if (rect.patternHeight >= (atrVal || tol) * minH) {
            patterns.push({ ...rect, patternType: 'RECTANGLE', direction: 'NEUTRAL', neckline: null, breakoutLevel: flatUp.a, confidence: 65 });
          }
        } else if (flatU && loMove > 0.8) {
          // flat resistance = true horizontal line through the swing highs (not a tilted fit)
          const flatUp = flatLine(avg(hSel.map((h) => h.price)));
          patterns.push({
            ...base, upperLine: flatUp, resistance: flatUp.a,
            patternHeight: Math.max(flatUp.a - lStart, flatUp.a - lEnd),
            patternType: 'ASCENDING_TRIANGLE', direction: 'LONG', neckline: flatUp.a, breakoutLevel: flatUp.a, confidence: 68,
          });
        } else if (flatL && upMove < -0.8) {
          // flat support = true horizontal line through the swing lows (not a tilted fit)
          const flatLo = flatLine(avg(lSel.map((l) => l.price)));
          patterns.push({
            ...base, lowerLine: flatLo, support: flatLo.a,
            patternHeight: Math.max(hStart - flatLo.a, hEnd - flatLo.a),
            patternType: 'DESCENDING_TRIANGLE', direction: 'SHORT', neckline: flatLo.a, breakoutLevel: flatLo.a, confidence: 68,
          });
        } else if (upMove < -0.4 && loMove > 0.4) {
          patterns.push({ ...base, patternType: 'SYMMETRICAL_TRIANGLE', direction: 'NEUTRAL', neckline: (hEnd + lEnd) / 2, breakoutLevel: hEnd, confidence: 60 });
        } else if (upMove < -0.4 && loMove < -0.4 && loMove < upMove && heightEnd < heightStart * 0.85 && hSel.length >= 3 && lSel.length >= 3) {
          patterns.push({ ...base, patternType: 'FALLING_WEDGE', direction: 'LONG', neckline: hEnd, breakoutLevel: hEnd, confidence: 66 });
        } else if (upMove > 0.4 && loMove > 0.4 && upMove > loMove && heightEnd < heightStart * 0.85 && hSel.length >= 3 && lSel.length >= 3) {
          patterns.push({ ...base, patternType: 'RISING_WEDGE', direction: 'SHORT', neckline: lEnd, breakoutLevel: lEnd, confidence: 66 });
        }
      }
    }
  }

  // --- Flags: impulse → tight counter-drift, breakout candle NOT part of the flag ---
  if (closed.length >= 28 && atrVal > 0) {
    const n = closed.length;
    const impulse = closed.slice(n - 27, n - 9); // 18 candles
    const flag = closed.slice(n - 9, n - 1); // 8 candles, excludes the last closed candle
    const impMove = impulse[impulse.length - 1].close - impulse[0].open;
    const flagHigh = Math.max(...flag.map((c) => c.high));
    const flagLow = Math.min(...flag.map((c) => c.low));
    const flagH = flagHigh - flagLow;
    const impHigh = Math.max(...impulse.map((c) => c.high));
    const impLow = Math.min(...impulse.map((c) => c.low));
    if (Math.abs(impMove) > atrVal * 2 && flagH < atrVal * 1.4) {
      const iF0 = n - 9;
      const iF1 = n - 2;
      const iI0 = n - 27;
      const iI1 = n - 10;
      if (impMove > 0 && (impHigh - flagLow) <= impMove * 0.5) {
        patterns.push({
          patternType: 'BULL_FLAG', direction: 'LONG',
          startIndex: iI0, endIndex: iF1,
          support: flagLow, resistance: flagHigh, neckline: flagHigh, breakoutLevel: flagHigh,
          upperLine: flatLine(flagHigh), lowerLine: flatLine(flagLow),
          anchors: [
            { i: iI0, price: impulse[0].open, label: 'Pole' },
            { i: iI1, price: impulse[impulse.length - 1].close, label: 'Pole top' },
          ],
          flagStartIndex: iF0,
          patternHeight: Math.abs(impMove) * 0.8, confidence: 72, fit: 0.8, touches: 3,
        });
      } else if (impMove < 0 && (flagHigh - impLow) <= Math.abs(impMove) * 0.5) {
        patterns.push({
          patternType: 'BEAR_FLAG', direction: 'SHORT',
          startIndex: iI0, endIndex: iF1,
          support: flagLow, resistance: flagHigh, neckline: flagLow, breakoutLevel: flagLow,
          upperLine: flatLine(flagHigh), lowerLine: flatLine(flagLow),
          anchors: [
            { i: iI0, price: impulse[0].open, label: 'Pole' },
            { i: iI1, price: impulse[impulse.length - 1].close, label: 'Pole low' },
          ],
          flagStartIndex: iF0,
          patternHeight: Math.abs(impMove) * 0.8, confidence: 72, fit: 0.8, touches: 3,
        });
      }
    }
  }

  // --- Triple Top / Bottom ---
  if (rh.length >= 3 && rl.length >= 2) {
    const h1 = rh[rh.length - 3];
    const h2 = rh[rh.length - 2];
    const h3 = rh[rh.length - 1];
    if (nearEqual(h1.price, h2.price, tol) && nearEqual(h2.price, h3.price, tol) &&
        h3.i - h1.i >= 10) {
      const necks = rl.filter((l) => l.i > h1.i && l.i < h3.i).sort((a, b) => a.price - b.price);
      const neck = necks[0];
      if (neck) {
        const topP = (h1.price + h2.price + h3.price) / 3;
        const height = topP - neck.price;
        if (atrVal <= 0 || height >= atrVal * minH) {
          patterns.push({
            patternType: 'TRIPLE_TOP', direction: 'SHORT',
            startIndex: h1.i, endIndex: h3.i,
            support: neck.price, resistance: topP, neckline: neck.price, breakoutLevel: neck.price,
            upperLine: flatLine(topP), lowerLine: flatLine(neck.price),
            anchors: [
              { i: h1.i, price: h1.price, label: 'T1' },
              { i: h2.i, price: h2.price, label: 'T2' },
              { i: h3.i, price: h3.price, label: 'T3' },
              { i: neck.i, price: neck.price, label: 'Neck' },
            ],
            patternHeight: height, confidence: 72, fit: 0.85, touches: 3,
          });
        }
      }
    }
  }
  if (rl.length >= 3 && rh.length >= 2) {
    const l1 = rl[rl.length - 3];
    const l2 = rl[rl.length - 2];
    const l3 = rl[rl.length - 1];
    if (nearEqual(l1.price, l2.price, tol) && nearEqual(l2.price, l3.price, tol) &&
        l3.i - l1.i >= 10) {
      const necks = rh.filter((h) => h.i > l1.i && h.i < l3.i).sort((a, b) => b.price - a.price);
      const neck = necks[0];
      if (neck) {
        const botP = (l1.price + l2.price + l3.price) / 3;
        const height = neck.price - botP;
        if (atrVal <= 0 || height >= atrVal * minH) {
          patterns.push({
            patternType: 'TRIPLE_BOTTOM', direction: 'LONG',
            startIndex: l1.i, endIndex: l3.i,
            support: botP, resistance: neck.price, neckline: neck.price, breakoutLevel: neck.price,
            upperLine: flatLine(neck.price), lowerLine: flatLine(botP),
            anchors: [
              { i: l1.i, price: l1.price, label: 'B1' },
              { i: l2.i, price: l2.price, label: 'B2' },
              { i: l3.i, price: l3.price, label: 'B3' },
              { i: neck.i, price: neck.price, label: 'Neck' },
            ],
            patternHeight: height, confidence: 72, fit: 0.85, touches: 3,
          });
        }
      }
    }
  }

  // --- Head & Shoulders / Inverse ---
  if (rh.length >= 3 && rl.length >= 2) {
    // Classic H&S: left shoulder, higher head, right shoulder ~ left
    for (let i = 0; i <= rh.length - 3; i++) {
      const ls = rh[i];
      const hd = rh[i + 1];
      const rs = rh[i + 2];
      if (hd.price > ls.price + tol && hd.price > rs.price + tol &&
          nearEqual(ls.price, rs.price, tol * 1.5) &&
          rs.i - ls.i >= 8) {
        const necks = rl.filter((l) => l.i > ls.i && l.i < rs.i);
        if (necks.length >= 1) {
          const neckP = Math.min(...necks.map((n) => n.price));
          const height = hd.price - neckP;
          if (atrVal <= 0 || height >= atrVal * minH) {
            patterns.push({
              patternType: 'HEAD_AND_SHOULDERS', direction: 'SHORT',
              startIndex: ls.i, endIndex: rs.i,
              support: neckP, resistance: hd.price, neckline: neckP, breakoutLevel: neckP,
              upperLine: flatLine(hd.price), lowerLine: flatLine(neckP),
              anchors: [
                { i: ls.i, price: ls.price, label: 'LS' },
                { i: hd.i, price: hd.price, label: 'Head' },
                { i: rs.i, price: rs.price, label: 'RS' },
              ],
              patternHeight: height, confidence: 75, fit: 0.8, touches: 3,
            });
            break;
          }
        }
      }
    }
  }
  if (rl.length >= 3 && rh.length >= 2) {
    for (let i = 0; i <= rl.length - 3; i++) {
      const ls = rl[i];
      const hd = rl[i + 1];
      const rs = rl[i + 2];
      if (hd.price < ls.price - tol && hd.price < rs.price - tol &&
          nearEqual(ls.price, rs.price, tol * 1.5) &&
          rs.i - ls.i >= 8) {
        const necks = rh.filter((h) => h.i > ls.i && h.i < rs.i);
        if (necks.length >= 1) {
          const neckP = Math.max(...necks.map((n) => n.price));
          const height = neckP - hd.price;
          if (atrVal <= 0 || height >= atrVal * minH) {
            patterns.push({
              patternType: 'INVERSE_HEAD_AND_SHOULDERS', direction: 'LONG',
              startIndex: ls.i, endIndex: rs.i,
              support: hd.price, resistance: neckP, neckline: neckP, breakoutLevel: neckP,
              upperLine: flatLine(neckP), lowerLine: flatLine(hd.price),
              anchors: [
                { i: ls.i, price: ls.price, label: 'LS' },
                { i: hd.i, price: hd.price, label: 'Head' },
                { i: rs.i, price: rs.price, label: 'RS' },
              ],
              patternHeight: height, confidence: 75, fit: 0.8, touches: 3,
            });
            break;
          }
        }
      }
    }
  }

  return patterns.filter((p) => (p.touches || 0) >= (CFG.minTouches || 2));
}

/* =====================================================================
 * EXTENDED PATTERNS
 *   Cup & Handle / Inverse, Rounding Bottom / Top, Broadening (megaphone),
 *   Asc/Desc Broadening Wedge, Bull/Bear Pennant, Asc/Desc/Horizontal Channel,
 *   Diamond Top / Bottom.
 *
 * Same contract as the classic patterns:
 *   - geometry from CLOSED candles only (the last closed candle is the breakout
 *     candidate, so converging/consolidation shapes stop at closed[n-2])
 *   - upperLine = the LONG breakout boundary, lowerLine = the SHORT breakout boundary
 *   - anchors + breakoutLevel + direction + confidence + patternHeight (>= minPatternHeightATR)
 * ===================================================================== */

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const isH = (s) => s.type === 'H';
const isL = (s) => s.type === 'L';

/** line through points with a FIXED slope (parallel channel rails) */
function fitLineSlope(pts, b) {
  const a = avg(pts.map((p) => p.price - b * p.i));
  const maxDev = Math.max(...pts.map((p) => Math.abs(p.price - (a + b * p.i))));
  return { a, b, maxDev };
}

/** least-squares parabola y = c0 + c1*x + c2*x² (x,y pre-normalised) with r² */
function quadFit(xs, ys) {
  const n = xs.length;
  if (n < 6) return null;
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let k = 0; k < n; k++) {
    const x = xs[k], y = ys[k], x2 = x * x;
    s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    t0 += y; t1 += x * y; t2 += x2 * y;
  }
  const M = [[n, s1, s2], [s1, s2, s3], [s2, s3, s4]];
  const det3 = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(M);
  if (!D || Math.abs(D) < 1e-12) return null;
  const T = [t0, t1, t2];
  const rep = (col) => M.map((row, r) => row.map((v, c) => (c === col ? T[r] : v)));
  const c0 = det3(rep(0)) / D;
  const c1 = det3(rep(1)) / D;
  const c2 = det3(rep(2)) / D;
  const my = t0 / n;
  let ssr = 0, sst = 0;
  for (let k = 0; k < n; k++) {
    const p = c0 + c1 * xs[k] + c2 * xs[k] * xs[k];
    ssr += (ys[k] - p) ** 2;
    sst += (ys[k] - my) ** 2;
  }
  return { c0, c1, c2, r2: sst > 0 ? 1 - ssr / sst : 0 };
}

/* ---- bullish-orientation detectors are mirrored (price × -1) for the bearish twin ---- */
const mirrorCandles = (cs) => cs.map((c) => ({ ...c, open: -c.open, close: -c.close, high: -c.low, low: -c.high }));
const TYPE_MIRROR = {
  CUP_AND_HANDLE: 'INVERSE_CUP_AND_HANDLE',
  ROUNDING_BOTTOM: 'ROUNDING_TOP',
  BULL_PENNANT: 'BEAR_PENNANT',
};
function unmirror(p) {
  const neg = (ln) => (ln ? { a: -ln.a, b: -ln.b, maxDev: ln.maxDev } : null);
  const n = (v) => (v == null ? v : -v);
  return {
    ...p,
    patternType: TYPE_MIRROR[p.patternType],
    direction: p.direction === 'LONG' ? 'SHORT' : p.direction === 'SHORT' ? 'LONG' : p.direction,
    support: n(p.resistance),
    resistance: n(p.support),
    neckline: n(p.neckline),
    breakoutLevel: n(p.breakoutLevel),
    upperLine: neg(p.lowerLine),
    lowerLine: neg(p.upperLine),
    anchors: (p.anchors || []).map((a) => ({ ...a, price: -a.price })),
  };
}

/** Cup & Handle (bullish orientation): rounded base, rims ~equal, shallow handle, close below rim */
function detectCupHandle(c, swings, A, minH, tol, mir) {
  const n = c.length;
  const highs = swings.filter(isH).slice(-14);
  let best = null;
  for (let a = 0; a < highs.length - 1; a++) {
    for (let b = a + 1; b < highs.length; b++) {
      const h1 = highs[a];
      const h2 = highs[b];
      const width = h2.i - h1.i;
      if (width < 14 || width > 80) continue;
      if (h2.i > n - 5) continue; // handle needs >= 3 closed candles after the right rim (excl. breakout candle)

      let bottom = Infinity, ib = -1, innerMax = -Infinity;
      for (let i = h1.i; i <= h2.i; i++) {
        if (c[i].low < bottom) { bottom = c[i].low; ib = i; }
        if (i > h1.i && i < h2.i && c[i].high > innerMax) innerMax = c[i].high;
      }
      const rimHi = Math.max(h1.price, h2.price);
      const depth = (h1.price + h2.price) / 2 - bottom;
      if (depth < A * minH) continue;
      const rimTol = Math.max(tol * 1.5, depth * 0.15);
      if (Math.abs(h1.price - h2.price) > rimTol) continue;
      if (innerMax > rimHi + 0.25 * A) continue; // no higher peak inside the cup
      const pos = (ib - h1.i) / width;
      if (pos < 0.25 || pos > 0.75) continue;

      // roundness: parabola opening upward through the closes
      const xs = [], ys = [];
      let dwell = 0;
      for (let i = h1.i; i <= h2.i; i++) {
        const y = (c[i].close - bottom) / depth;
        xs.push((i - h1.i) / width); ys.push(y);
        if (y <= 0.4) dwell++;
      }
      if (dwell / ys.length < 0.5) continue; // V-shaped drop/recovery is not a rounded cup
      const q = quadFit(xs, ys);
      if (!q || q.c2 <= 0 || q.r2 < 0.6) continue;

      // handle: shallow pullback under the rim, no close above it yet
      const hLen = n - 2 - h2.i;
      if (hLen < 3 || hLen > Math.max(8, Math.round(width * 0.5))) continue;
      let hLow = Infinity, hHigh = -Infinity, closeAbove = false;
      for (let i = h2.i + 1; i <= n - 2; i++) {
        if (c[i].low < hLow) hLow = c[i].low;
        if (c[i].high > hHigh) hHigh = c[i].high;
        if (c[i].close > rimHi) closeAbove = true;
      }
      if (closeAbove || hHigh > rimHi + 0.25 * A) continue;
      const hDepth = rimHi - hLow;
      if (hDepth < 0.3 * A || hDepth > depth * 0.5) continue;
      if (hLow < bottom + depth * 0.5) continue; // handle stays in the upper half of the cup

      const score = q.r2 * 0.6 + (1 - Math.abs(pos - 0.5) * 2) * 0.2 + (1 - Math.abs(h1.price - h2.price) / rimTol) * 0.2;
      if (!best || score > best.score) {
        best = { score, h1, h2, ib, bottom, rimHi, depth, hLow, q, hStart: h2.i + 1 };
      }
    }
  }
  if (!best) return null;
  const { h1, h2, ib, bottom, rimHi, depth, hLow, q, score, hStart } = best;
  let hLowI = hStart;
  for (let i = hStart; i <= n - 2; i++) if (c[i].low <= hLow) { hLowI = i; break; }
  return {
    patternType: 'CUP_AND_HANDLE', direction: 'LONG',
    startIndex: h1.i, endIndex: n - 2, handleStartIndex: hStart,
    support: bottom, resistance: rimHi, neckline: rimHi, breakoutLevel: rimHi,
    upperLine: flatLine(rimHi), lowerLine: flatLine(hLow),
    anchors: [
      { i: h1.i, price: h1.price, label: 'Rim L' },
      { i: ib, price: bottom, label: mir ? 'Cup high' : 'Cup low' },
      { i: h2.i, price: h2.price, label: 'Rim R' },
      { i: hLowI, price: hLow, label: mir ? 'H Handle' : 'L Handle' },
    ],
    patternHeight: rimHi - bottom,
    confidence: Math.round(66 + 8 * clamp01(score)), fit: clamp01(q.r2), touches: 4,
  };
}

/** Rounding Bottom / saucer (bullish orientation): gradual U-shaped recovery back toward the left rim */
function detectRoundingBottom(c, swings, A, minH, cupStarts, mir) {
  const n = c.length;
  const last = n - 2; // n-1 is the breakout candidate
  const highs = swings.filter(isH).slice(-12);
  let best = null;
  for (const h1 of highs) {
    if (cupStarts.some((s) => Math.abs(s - h1.i) <= 3)) continue; // already reported as cup & handle
    const width = last - h1.i;
    if (width < 24 || width > 100) continue;
    let bottom = Infinity, ib = -1, maxH = -Infinity, maxC = -Infinity;
    for (let i = h1.i; i <= last; i++) {
      if (c[i].low < bottom) { bottom = c[i].low; ib = i; }
      if (i > h1.i) {
        if (c[i].high > maxH) maxH = c[i].high;
        if (c[i].close > maxC) maxC = c[i].close;
      }
    }
    const depth = h1.price - bottom;
    if (depth < A * minH) continue;
    const pos = (ib - h1.i) / width;
    if (pos < 0.3 || pos > 0.7) continue;
    if (maxH > h1.price + 0.25 * A || maxC > h1.price) continue; // not already through the rim
    if (c[last].close < bottom + depth * 0.7) continue; // right side has recovered to the upper 30%
    const xs = [], ys = [];
    let dwell = 0;
    for (let i = h1.i; i <= last; i++) {
      xs.push((i - h1.i) / width);
      const y = (c[i].close - bottom) / depth;
      ys.push(y);
      if (y <= 0.4) dwell++;
    }
    if (dwell / ys.length < 0.5) continue; // V-shape, not a saucer
    const q = quadFit(xs, ys);
    if (!q || q.c2 <= 0 || q.r2 < 0.7) continue;
    const score = q.r2 + (1 - Math.abs(pos - 0.5) * 2) * 0.2;
    if (!best || score > best.score) best = { score, h1, ib, bottom, depth, q };
  }
  if (!best) return null;
  const { h1, ib, bottom, q, score } = best;
  return {
    patternType: 'ROUNDING_BOTTOM', direction: 'LONG',
    startIndex: h1.i, endIndex: last,
    support: bottom, resistance: h1.price, neckline: h1.price, breakoutLevel: h1.price,
    upperLine: flatLine(h1.price), lowerLine: flatLine(bottom),
    anchors: [
      { i: h1.i, price: h1.price, label: 'Rim L' },
      { i: ib, price: bottom, label: mir ? 'Base top' : 'Base' },
      { i: last, price: c[last].close, label: 'Rim R' },
    ],
    patternHeight: h1.price - bottom,
    confidence: Math.round(60 + 8 * clamp01(score - 0.2)), fit: clamp01(q.r2), touches: 3,
  };
}

/** Bull Pennant (bullish orientation): sharp impulse, then a small converging triangle */
function detectBullPennant(c, A, maxDev, mir) {
  const n = c.length;
  if (n < 40) return null;
  const consEnd = n - 2; // n-1 = breakout candidate, never part of the pennant
  const body = c.slice(0, n - 1);
  const minorSets = [findSwings(body, 2, 2), findSwings(body, 1, 1)]; // clean pivots first, tighter pivots as fallback
  const devLim = maxDev * 1.2;
  let best = null;
  for (const L of [8, 11, 14, 18]) {
    const cs = consEnd - L + 1;
    const poleEnd = cs - 1;
    if (poleEnd < 12) continue;
    let ps = -1, move = 0;
    for (const P of [8, 12, 18]) {
      const s = poleEnd - P + 1;
      if (s < 0) continue;
      const m = c[poleEnd].close - c[s].open;
      if (m > move) { move = m; ps = s; }
    }
    if (move < A * 2.2) continue;
    let poleTop = -Infinity;
    for (let i = ps; i <= poleEnd; i++) if (c[i].high > poleTop) poleTop = c[i].high;
    let cHigh = -Infinity, cLow = Infinity;
    for (let i = cs; i <= consEnd; i++) {
      if (c[i].high > cHigh) cHigh = c[i].high;
      if (c[i].low < cLow) cLow = c[i].low;
    }
    if (cHigh - cLow > Math.min(A * 6, move * 0.5)) continue;
    if (poleTop - cLow > move * 0.5) continue; // shallow retrace of the pole
    if (cHigh > poleTop + 0.35 * A) continue;

    for (const minor of minorSets) {
      const hp = minor.filter((s) => isH(s) && s.i >= cs && s.i <= consEnd);
      const lp = minor.filter((s) => isL(s) && s.i >= cs && s.i <= consEnd);
      if (hp.length < 2 || lp.length < 2) continue;
      const up = fitLine(hp);
      const lo = fitLine(lp);
      if (!up || !lo || up.maxDev > devLim || lo.maxDev > devLim) continue;
      const wS = lineAt(up, cs) - lineAt(lo, cs);
      const wE = lineAt(up, consEnd) - lineAt(lo, consEnd);
      if (!(wS > 0) || wE < 0.1 * A || wE > wS * 0.7) continue; // clearly converging, apex not reached
      const upMove = (up.b * L) / A;
      const loMove = (lo.b * L) / A;
      if (upMove > 0.3 || loMove < -0.3) continue;
      if (!(upMove <= -0.3 || loMove >= 0.3)) continue;
      if (lineAt(up, n - 1) - lineAt(lo, n - 1) <= 0.05 * A) continue;
      let inside = 0;
      for (let i = cs; i <= consEnd; i++) {
        if (c[i].high <= lineAt(up, i) + 0.3 * A && c[i].low >= lineAt(lo, i) - 0.3 * A) inside++;
      }
      if (inside / L < 0.9) continue;

      const fit = clamp01(1 - (up.maxDev + lo.maxDev) / (2 * devLim));
      const score = fit + (hp.length + lp.length) * 0.05 + Math.min(move / (A * 6), 1) * 0.2;
      if (!best || score > best.score) best = { score, cs, ps, poleEnd, move, up, lo, cHigh, cLow, hp, lp, fit };
    }
  }
  if (!best) return null;
  const { cs, ps, poleEnd, move, up, lo, cHigh, cLow, hp, lp, fit } = best;
  const lvl = lineAt(up, consEnd);
  return {
    patternType: 'BULL_PENNANT', direction: 'LONG',
    startIndex: cs, endIndex: consEnd, flagStartIndex: cs, poleStartIndex: ps,
    support: cLow, resistance: cHigh, neckline: lvl, breakoutLevel: lvl,
    upperLine: up, lowerLine: lo,
    anchors: [
      { i: ps, price: c[ps].open, label: 'Pole' },
      { i: poleEnd, price: c[poleEnd].close, label: mir ? 'Pole low' : 'Pole top' },
    ],
    patternHeight: move * 0.8, // same measured-move convention as the flags
    confidence: 70, fit, touches: hp.length + lp.length,
  };
}

/** Broadening family from the last swings: megaphone (neutral) + asc/desc broadening wedges */
function detectBroadening(swings, A, minH, maxDev, tol) {
  const S = swings.slice(-24);
  const H = S.filter(isH);
  const L = S.filter(isL);
  const anc = (arr, p) => arr.map((s, k) => ({ i: s.i, price: s.price, label: `${p}${k + 1}` }));
  for (const [kh, kl] of [[4, 4], [3, 3], [4, 3], [3, 4], [3, 2], [2, 3]]) {
    if (H.length < kh || L.length < kl) continue;
    const hs = H.slice(-kh);
    const ls = L.slice(-kl);
    const iStart = Math.min(hs[0].i, ls[0].i);
    const iEnd = Math.max(hs[hs.length - 1].i, ls[ls.length - 1].i);
    const span = iEnd - iStart;
    if (span < 14) continue;
    if (Math.abs(hs[0].i - ls[0].i) > span * 0.5 || Math.abs(hs[hs.length - 1].i - ls[ls.length - 1].i) > span * 0.5) continue;
    const up = fitLine(hs);
    const lo = fitLine(ls);
    if (!up || !lo || up.maxDev > maxDev || lo.maxDev > maxDev) continue;
    const wS = lineAt(up, iStart) - lineAt(lo, iStart);
    const uE = lineAt(up, iEnd);
    const lE = lineAt(lo, iEnd);
    const wE = uE - lE;
    if (!(wS > 0) || wE < wS * 1.4 || wE < A * minH) continue; // must genuinely widen
    const upMove = (up.b * span) / A;
    const loMove = (lo.b * span) / A;
    const risingHighs = hs.every((h, k) => k === 0 || h.price > hs[k - 1].price - tol * 0.5);
    const fallingLows = ls.every((l, k) => k === 0 || l.price < ls[k - 1].price + tol * 0.5);
    const strict = hs.length >= 3 && ls.length >= 3;
    let type = null, direction = null, confidence = 0, level = uE, neckline = (uE + lE) / 2;
    if (upMove >= 0.5 && loMove <= -0.5 && risingHighs && fallingLows) {
      type = 'BROADENING'; direction = 'NEUTRAL'; confidence = 58;
    } else if (strict && upMove > 0.4 && loMove > 0.4 && upMove > loMove * 1.5) {
      type = 'ASCENDING_BROADENING_WEDGE'; direction = 'SHORT'; confidence = 62; level = lE; neckline = lE;
    } else if (strict && upMove < -0.4 && loMove < -0.4 && loMove < upMove * 1.5) {
      type = 'DESCENDING_BROADENING_WEDGE'; direction = 'LONG'; confidence = 62; level = uE; neckline = uE;
    }
    if (!type) continue;
    return {
      patternType: type, direction,
      startIndex: iStart, endIndex: iEnd,
      support: lE, resistance: uE, neckline, breakoutLevel: level,
      upperLine: up, lowerLine: lo,
      anchors: [...anc(hs, 'H'), ...anc(ls, 'L')].sort((a, b) => a.i - b.i),
      patternHeight: wE,
      confidence, fit: clamp01(1 - (up.maxDev + lo.maxDev) / (2 * maxDev)), touches: hs.length + ls.length,
    };
  }
  return null;
}

/** Parallel channels (ascending / descending / horizontal) – neutral, either rail can break */
function detectChannel(c, swings, A, minH, maxDev, hasRectangle) {
  const S = swings.slice(-24);
  const H = S.filter(isH);
  const L = S.filter(isL);
  const anc = (arr, p) => arr.map((s, k) => ({ i: s.i, price: s.price, label: `${p}${k + 1}` }));
  for (const [kh, kl] of [[5, 5], [4, 4], [3, 3], [4, 3], [3, 4]]) { // >= 6 rail touches
    if (H.length < kh || L.length < kl) continue;
    const hs = H.slice(-kh);
    const ls = L.slice(-kl);
    const iStart = Math.min(hs[0].i, ls[0].i);
    const iEnd = Math.max(hs[hs.length - 1].i, ls[ls.length - 1].i);
    const span = iEnd - iStart;
    if (span < 20) continue;
    const u0 = fitLine(hs);
    const l0 = fitLine(ls);
    if (!u0 || !l0) continue;
    const slopeMove0 = (((u0.b + l0.b) / 2) * span) / A;
    let slope = (u0.b + l0.b) / 2;
    let kind = null;
    if (Math.abs(slopeMove0) < 0.8) { kind = 'HORIZONTAL_CHANNEL'; slope = 0; }
    else if (slopeMove0 >= 1.2) kind = 'ASCENDING_CHANNEL';
    else if (slopeMove0 <= -1.2) kind = 'DESCENDING_CHANNEL';
    if (!kind) continue;
    if (kind === 'HORIZONTAL_CHANNEL' && hasRectangle) continue;
    const pu = fitLineSlope(hs, slope);
    const pl = fitLineSlope(ls, slope);
    if (pu.maxDev > maxDev * 0.8 || pl.maxDev > maxDev * 0.8) continue;
    const width = pu.a - pl.a; // rails are parallel → constant vertical width
    if (!(width > 0) || width < A * minH) continue;
    let inside = 0, total = 0;
    for (let i = iStart; i <= iEnd; i++) {
      total++;
      const u = pu.a + pu.b * i;
      const l = pl.a + pl.b * i;
      if (c[i].close <= u + 0.3 * A && c[i].close >= l - 0.3 * A) inside++;
    }
    if (inside / total < 0.93) continue;
    const uE = lineAt(pu, iEnd);
    const lE = lineAt(pl, iEnd);
    return {
      patternType: kind, direction: 'NEUTRAL',
      startIndex: iStart, endIndex: iEnd,
      support: lE, resistance: uE, neckline: (uE + lE) / 2, breakoutLevel: uE,
      upperLine: pu, lowerLine: pl,
      anchors: [...anc(hs, 'H'), ...anc(ls, 'L')].sort((a, b) => a.i - b.i),
      patternHeight: width,
      confidence: kind === 'HORIZONTAL_CHANNEL' ? 60 : 62,
      fit: clamp01(1 - (pu.maxDev + pl.maxDev) / (2 * maxDev * 0.8)), touches: hs.length + ls.length,
    };
  }
  return null;
}

/** Diamond Top / Bottom: broadening then contracting; direction from the trend going in */
function detectDiamond(c, swings, A, minH, maxDev) {
  const n = c.length;
  const S = swings.slice(-14);
  const anc = (arr, p) => arr.map((s, k) => ({ i: s.i, price: s.price, label: `${p}${k + 1}` }));
  const moveATR = (ln, pts) => (ln.b * (pts[pts.length - 1].i - pts[0].i)) / A;
  for (let k = Math.min(S.length, 12); k >= 7; k--) {
    const w = S.slice(-k);
    const hs = w.filter(isH);
    const ls = w.filter(isL);
    if (hs.length < 3 || ls.length < 3) continue;
    const s0 = w[0].i;
    const s1 = w[w.length - 1].i;
    const span = s1 - s0;
    if (span < 20) continue;
    const hMax = hs.reduce((m, s) => (s.price > m.price ? s : m), hs[0]);
    const lMin = ls.reduce((m, s) => (s.price < m.price ? s : m), ls[0]);
    const pH = (hMax.i - s0) / span;
    const pL = (lMin.i - s0) / span;
    if (pH < 0.2 || pH > 0.8 || pL < 0.2 || pL > 0.8) continue; // widest point sits mid-pattern
    const hB = hs.filter((s) => s.i < hMax.i), hA = hs.filter((s) => s.i > hMax.i);
    const lB = ls.filter((s) => s.i < lMin.i), lA = ls.filter((s) => s.i > lMin.i);
    if (!hB.length || !lB.length || !hA.length || !lA.length) continue;
    const ulPts = [...hB, hMax], llPts = [...lB, lMin], urPts = [hMax, ...hA], lrPts = [lMin, ...lA];
    const ul = fitLine(ulPts), ll = fitLine(llPts), ur = fitLine(urPts), lr = fitLine(lrPts);
    if (!ul || !ll || !ur || !lr) continue;
    if ([ul, ll, ur, lr].some((l) => l.maxDev > maxDev)) continue;
    if (moveATR(ul, ulPts) < 0.4 || moveATR(ll, llPts) > -0.4) continue; // left half widens
    if (moveATR(ur, urPts) > -0.4 || moveATR(lr, lrPts) < 0.4) continue; // right half contracts
    const widest = hMax.price - lMin.price;
    if (widest < A * minH) continue;
    const uE = lineAt(ur, s1);
    const lE = lineAt(lr, s1);
    if (!(uE - lE > 0) || uE - lE > widest * 0.75) continue;
    if (lineAt(ur, n - 1) - lineAt(lr, n - 1) <= 0.1 * A) continue; // apex not reached

    // direction from the move INTO the diamond
    const look = Math.min(40, s0);
    if (look < 12) continue;
    const lead = c[s0].close - c[s0 - look].close;
    if (Math.abs(lead) < A * 1.5) continue;
    const top = lead > 0;
    return {
      patternType: top ? 'DIAMOND_TOP' : 'DIAMOND_BOTTOM', direction: top ? 'SHORT' : 'LONG',
      startIndex: Math.min(hMax.i, lMin.i), fullStartIndex: s0, endIndex: s1,
      support: lE, resistance: uE, neckline: top ? lE : uE, breakoutLevel: top ? lE : uE,
      upperLine: ur, lowerLine: lr,
      anchors: [...anc(hs, 'H'), ...anc(ls, 'L')].sort((a, b) => a.i - b.i),
      patternHeight: widest,
      confidence: 66,
      fit: clamp01(1 - ([ul, ll, ur, lr].reduce((s, l) => s + l.maxDev, 0) / 4) / maxDev),
      touches: hs.length + ls.length,
    };
  }
  return null;
}

/** same trade = same direction, overlapping span, ~same breakout level */
function sameSignal(a, b, A) {
  if (a.direction !== b.direction) return false;
  const lo = Math.max(a.startIndex, b.startIndex);
  const hi = Math.min(a.endIndex, b.endIndex);
  const minLen = Math.max(1, Math.min(a.endIndex - a.startIndex, b.endIndex - b.startIndex));
  if ((hi - lo) / minLen < 0.6) return false;
  return Math.abs((a.breakoutLevel ?? 0) - (b.breakoutLevel ?? 0)) <= 0.3 * A;
}

function detectExtraPatterns(candles, atr, classic) {
  if (!candles || candles.length < 30) return { add: [], dropTypes: [] };
  const closed = candles.slice(0, -1);
  const atrVal = atr > 0 ? atr : calcATR(closed, 14) || 0;
  const tol = atrVal > 0 ? atrVal * 0.35 : closed[closed.length - 1].close * 0.004;
  const A = atrVal > 0 ? atrVal : tol;
  const maxDev = A * (CFG.maxLineDeviationATR ?? 0.45);
  const minH = CFG.minPatternHeightATR || 0.8;
  const swings = findSwings(closed, 3, 3);
  const found = [];

  // mirrored series → bearish twins (inverse cup, rounding top, bear pennant)
  const mc = mirrorCandles(closed);
  const mSwings = findSwings(mc, 3, 3);

  const cup = detectCupHandle(closed, swings, A, minH, tol, false);
  const icup = detectCupHandle(mc, mSwings, A, minH, tol, true);
  if (cup) found.push(cup);
  if (icup) found.push(unmirror(icup));

  const dia = detectDiamond(closed, swings, A, minH, maxDev);
  if (dia) found.push(dia);

  const bro = detectBroadening(swings, A, minH, maxDev, tol);
  if (bro) found.push(bro);

  const hasRect = classic.some((p) => p.patternType === 'RECTANGLE');
  const ch = detectChannel(closed, swings, A, minH, maxDev, hasRect);
  if (ch) found.push(ch);

  const rb = detectRoundingBottom(closed, swings, A, minH, cup ? [cup.startIndex] : [], false);
  const rt = detectRoundingBottom(mc, mSwings, A, minH, icup ? [icup.startIndex] : [], true);
  if (rb) found.push(rb);
  if (rt) found.push(unmirror(rt));

  const bp = detectBullPennant(closed, A, maxDev, false);
  const sp = detectBullPennant(mc, A, maxDev, true);
  const pennants = [];
  if (bp) pennants.push(bp);
  if (sp) pennants.push(unmirror(sp));

  // a converging pennant REPLACES a same-direction flag on the same impulse
  const dropTypes = [];
  for (const p of pennants) dropTypes.push(p.direction === 'LONG' ? 'BULL_FLAG' : 'BEAR_FLAG');
  const keptClassic = classic.filter((p) => !dropTypes.includes(p.patternType));

  const add = [];
  for (const p of [...found, ...pennants]) {
    if (!(p.patternHeight >= A * minH)) continue; // CFG.minPatternHeightATR applies to every new pattern
    if (add.concat(keptClassic).some((q) => sameSignal(p, q, A))) continue; // no duplicate trade
    add.push(p);
  }
  return { add, dropTypes };
}

/**
 * Detect measurable chart patterns.
 * `candles` includes the still-forming last candle; pattern geometry is built
 * only from CLOSED candles so the breakout candle is never part of the pattern.
 *
 * Classic: DOUBLE_TOP/BOTTOM, TRIPLE_TOP/BOTTOM, HEAD_AND_SHOULDERS (+INVERSE), RECTANGLE,
 *   ASCENDING/DESCENDING/SYMMETRICAL_TRIANGLE, RISING/FALLING_WEDGE, BULL/BEAR_FLAG.
 * Extended: CUP_AND_HANDLE (+INVERSE), ROUNDING_BOTTOM/TOP, BROADENING,
 *   ASCENDING/DESCENDING_BROADENING_WEDGE, BULL/BEAR_PENNANT,
 *   ASCENDING/DESCENDING/HORIZONTAL_CHANNEL, DIAMOND_TOP/BOTTOM.
 *
 * Every pattern carries:
 *   upperLine / lowerLine  – { a, b } price = a + b*candleIndex (b = 0 → horizontal)
 *                            upperLine = LONG breakout boundary, lowerLine = SHORT boundary
 *   anchors                – swing points used (index, price, label) for drawing
 *   breakoutLevel / direction / confidence / patternHeight / startIndex / endIndex
 */
export function detectPatterns(candles, atr) {
  const classic = detectClassicPatterns(candles, atr);
  let extra = { add: [], dropTypes: [] };
  try {
    extra = detectExtraPatterns(candles, atr, classic);
  } catch (_) {
    extra = { add: [], dropTypes: [] }; // never let the new detectors break the scan
  }
  const base = classic.filter((p) => !extra.dropTypes.includes(p.patternType));
  const minTouches = CFG.minTouches || 2;
  let harmonics = [];
  try {
    harmonics = detectHarmonicPatterns(candles, atr) || [];
  } catch (_) {
    harmonics = [];
  }
  // Price-action & wave patterns (QM, 1-2-3, Wyckoff, liquidity sweep, breakout+retest, ABC, Elliott)
  let priceAction = [];
  try {
    priceAction = detectPriceActionPatterns(candles, atr) || [];
  } catch (_) {
    priceAction = [];
  }
  // Keep all classic + extra + harmonics + price-action (multi-pattern on same chart is intentional)
  return [
    ...base,
    ...extra.add.filter((p) => (p.touches || 0) >= minTouches),
    ...harmonics,
    ...priceAction,
  ];
}
