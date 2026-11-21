import test from 'node:test';
import assert from 'node:assert/strict';
import { detectHarmonicPatterns } from '../lib/scanner/strategy/chartPattern/harmonics.js';

// piecewise-linear price path through [barIndex, price] corners → candles
function build(corners, { lead = 12, tail = 6 } = {}) {
  const pts = corners.map(([i, p]) => [i + lead, p]);
  const first = pts[0];
  const path = [];
  for (let i = 0; i < first[0]; i++) path.push(first[1] + (first[0] - i) * 0.3); // lead-in
  for (let k = 0; k < pts.length - 1; k++) {
    const [i0, p0] = pts[k];
    const [i1, p1] = pts[k + 1];
    for (let i = i0; i < i1; i++) path.push(p0 + ((p1 - p0) * (i - i0)) / (i1 - i0));
  }
  const last = pts[pts.length - 1];
  for (let j = 0; j <= tail; j++) path.push(last[1] + (pts[pts.length - 2][1] > last[1] ? 1 : -1) * j * 0.15);
  return path.map((c, i) => {
    // high/low hug the close so every corner bar is a strict swing point
    return { time: 1_000_000 + i * 900, open: c, close: c, high: c + 0.05, low: c - 0.05, volume: 100 };
  });
}
const find = (cs, type) => detectHarmonicPatterns(cs, 0).filter((p) => p.patternType === type);
const L = 9; // bars per leg

test('textbook bullish Gartley is detected (B retraces 0.618 of XA, D 0.786)', () => {
  const cs = build([[0, 100], [L, 120], [2 * L, 107.64], [3 * L, 117.36], [4 * L, 104.28]]);
  const r = find(cs, 'GARTLEY_BULL');
  assert.equal(r.length, 1, JSON.stringify(detectHarmonicPatterns(cs, 0).map((p) => p.patternType)));
  assert.equal(r[0].direction, 'LONG');
});

test('Alt Bat (B 0.382, D 1.13 XA) is detected', () => {
  const cs = build([[0, 100], [L, 120], [2 * L, 112.36], [3 * L, 116.18], [4 * L, 97.08]]);
  assert.equal(find(cs, 'ALT_BAT_BULL').length, 1, JSON.stringify(detectHarmonicPatterns(cs, 0).map((p) => p.patternType)));
});

test('bearish Three Drives (tops) is detected, SHORT at the 3rd drive', () => {
  const cs = build([[0, 100], [L, 110], [2 * L, 103], [3 * L, 113.15], [4 * L, 106.05], [5 * L, 116.35]]);
  const r = find(cs, 'THREE_DRIVES_BEAR');
  assert.equal(r.length, 1, JSON.stringify(detectHarmonicPatterns(cs, 0).map((p) => p.patternType)));
  assert.equal(r[0].direction, 'SHORT');
  assert.equal(r[0].anchors.length, 6);
});

test('bullish Wolfe Wave is detected, point 5 overshoots the 1-3 line', () => {
  const cs = build([[0, 100], [10, 110], [20, 96], [30, 104], [40, 90]]);
  const r = find(cs, 'WOLFE_WAVE_BULL');
  assert.equal(r.length, 1, JSON.stringify(detectHarmonicPatterns(cs, 0).map((p) => p.patternType)));
  assert.equal(r[0].direction, 'LONG');
  assert.ok(r[0].patternHeight > 0);
});

test('random walk does not produce Wolfe / Three Drives', () => {
  let x = 100, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const cs = Array.from({ length: 120 }, (_, i) => {
    const o = x; x += rnd() * 2; return { time: i * 900, open: o, close: x, high: Math.max(o, x) + 0.2, low: Math.min(o, x) - 0.2, volume: 1 };
  });
  const bad = detectHarmonicPatterns(cs, 0).filter((p) => /THREE_DRIVES|WOLFE/.test(p.patternType));
  assert.ok(bad.length <= 1, `too many false positives: ${bad.length}`);
});
