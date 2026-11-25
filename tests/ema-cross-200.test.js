import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findCrossTouches,
  computeEmas,
  normalizeEcConfig,
  buildEcChartSvg,
  tallyEc,
  advanceOffset,
} from '../lib/scanner/strategy/emaCross200/index.js';

// deterministic pseudo-random walk
function walk(seed, n = 900, vol = 0.012) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o * (1 + (rnd() - 0.5) * vol * 2);
    const h = Math.max(o, c) * (1 + rnd() * vol * 0.6);
    const l = Math.min(o, c) * (1 - rnd() * vol * 0.6);
    out.push({ time: 1_700_000_000 + i * 3600, open: o, high: h, low: l, close: c, volume: 1 });
    p = c;
  }
  return out;
}

// independent brute-force version of the same rule
function brute(candles, cfg) {
  const { e20, e50, e200 } = computeEmas(candles, cfg);
  const res = [];
  const n = candles.length;
  const startI = Math.max(cfg.trend, n - cfg.maxAgeBars);
  for (let i = Math.max(1, startI); i < n; i++) {
    if ([e20[i - 1], e50[i - 1], e20[i], e50[i]].some((v) => v == null)) continue;
    const d0 = e20[i - 1] - e50[i - 1];
    const d1 = e20[i] - e50[i];
    const dir = d0 <= 0 && d1 > 0 ? 'UP' : d0 >= 0 && d1 < 0 ? 'DOWN' : null;
    if (!dir) continue;
    const t = d0 / (d0 - d1);
    const idx = t < 0.5 ? i - 1 : i;
    const c = candles[idx];
    const e = e200[idx];
    if (e == null) continue;
    if (c.low <= e && e <= c.high) res.push({ dir, index: idx });
  }
  return res;
}

test('every reported event: the candle on the cross line really contains the EMA200', () => {
  let total = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const candles = walk(seed);
    const ev = findCrossTouches(candles, { maxAgeBars: 900, maxPerCoin: 999 });
    for (const e of ev) {
      total++;
      assert.ok(e.candle.low <= e.ema200 && e.ema200 <= e.candle.high, 'EMA200 must be inside the candle range');
      assert.equal(candles[e.index].time, e.time);
      assert.ok(['UP', 'DOWN'].includes(e.dir));
      assert.ok(e.t >= 0 && e.t <= 1);
    }
  }
  assert.ok(total > 0, 'random walks should produce at least some touches');
});

test('engine equals an independent brute-force implementation (many seeds, both directions)', () => {
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const candles = walk(seed, 1000);
    const cfg = normalizeEcConfig({ maxAgeBars: 900, maxPerCoin: 999 });
    const got = findCrossTouches(candles, cfg).map((e) => `${e.dir}@${e.index}`);
    const want = brute(candles, cfg).map((e) => `${e.dir}@${e.index}`);
    assert.deepEqual(got, want);
  }
});

test('touch tolerance only ever ADDS events, direction filter only removes the other side', () => {
  const candles = walk(21, 1000);
  const strict = findCrossTouches(candles, { maxAgeBars: 900, maxPerCoin: 999, touchTolerancePct: 0 });
  const loose = findCrossTouches(candles, { maxAgeBars: 900, maxPerCoin: 999, touchTolerancePct: 1 });
  assert.ok(loose.length >= strict.length);
  const strictKeys = new Set(loose.map((e) => e.index + e.dir));
  for (const e of strict) assert.ok(strictKeys.has(e.index + e.dir), 'strict events are a subset of loose events');
  const up = findCrossTouches(candles, { maxAgeBars: 900, maxPerCoin: 999, direction: 'UP' });
  assert.ok(up.every((e) => e.dir === 'UP'));
});

test('a cross far away from the EMA200 is never reported (negative control)', () => {
  // price oscillates in a tight band that stays far above a long, much lower base → EMA200 never inside the candles
  const candles = [];
  for (let i = 0; i < 260; i++) candles.push({ time: 1e9 + i * 60, open: 10, high: 10.05, low: 9.95, close: 10, volume: 1 });
  for (let i = 260; i < 520; i++) {
    const p = 50 + Math.sin(i / 6) * 3;
    candles.push({ time: 1e9 + i * 60, open: p, high: p + 0.2, low: p - 0.2, close: p, volume: 1 });
  }
  const { e200 } = computeEmas(candles, normalizeEcConfig({}));
  const ev = findCrossTouches(candles, { maxAgeBars: 260, maxPerCoin: 999 });
  for (const e of ev) assert.ok(e.candle.low <= e200[e.index] && e200[e.index] <= e.candle.high);
});

test('maxPerCoin keeps the NEWEST events; chart + tally work', () => {
  const candles = walk(5, 1000);
  const all = findCrossTouches(candles, { maxAgeBars: 900, maxPerCoin: 50 });
  const two = findCrossTouches(candles, { maxAgeBars: 900, maxPerCoin: 2 });
  assert.deepEqual(two.map((e) => e.index), all.slice(-2).map((e) => e.index));
  if (all.length) {
    const emas = computeEmas(candles, normalizeEcConfig({}));
    const svg = buildEcChartSvg(candles, all[all.length - 1], emas, { symbol: 'TESTUSDT', tf: '1h' });
    assert.match(svg, /^<svg/);
    assert.match(svg, /EMA200/);
  }
  const t = tallyEc(all);
  assert.equal(t.total, all.length);
  assert.equal(t.win + t.loss + t.open, all.length);
});

test('too few candles → no events, no crash', () => {
  assert.deepEqual(findCrossTouches([], {}), []);
  assert.deepEqual(findCrossTouches(walk(1, 100), {}), []);
});

test('chunk advance: full chunk advances all; a stopped chunk only advances over leading finished coins', () => {
  assert.equal(advanceOffset([true, true, true], false), 3);
  assert.equal(advanceOffset([true, true, false, true], true), 2); // coin 3 finished but coin 2 did not → retry from 2
  assert.equal(advanceOffset([false, true], true), 0);
  assert.equal(advanceOffset([], true), 0);
});
