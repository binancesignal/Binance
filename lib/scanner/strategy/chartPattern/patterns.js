import { findSwings, calcATR, avg } from '../../indicators.js';
import { CHART_PATTERN_CONFIG as CFG } from './config.js';

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
 * Detect measurable chart patterns.
 * `candles` includes the still-forming last candle; pattern geometry is built
 * only from CLOSED candles so the breakout candle is never part of the pattern.
 *
 * Every pattern carries:
 *   upperLine / lowerLine  – { a, b } price = a + b*candleIndex (b = 0 → horizontal)
 *   anchors                – swing points used (index, price, label) for drawing
 */
export function detectPatterns(candles, atr) {
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
