import test from 'node:test';
import assert from 'node:assert/strict';
import { PATTERNS, scanCandlePatterns, atrSeries } from '../lib/candles/patterns.js';

const T0 = 1_700_000_000;
const mk = (o, h, l, c, i) => ({ time: T0 + i * 900, open: o, high: h, low: l, close: c });

/** 20 candles falling (red, ~1.0 range) → prior down-move; then the pattern candles */
function downtrend(tail) {
  const cs = [];
  let p = 120;
  for (let i = 0; i < 20; i++) {
    cs.push(mk(p, p + 0.3, p - 1.3, p - 1, i));
    p -= 1;
  }
  tail.forEach((t, k) => cs.push(mk(...t, 20 + k)));
  return cs;
}
function uptrend(tail) {
  const cs = [];
  let p = 100;
  for (let i = 0; i < 20; i++) {
    cs.push(mk(p, p + 1.3, p - 0.3, p + 1, i));
    p += 1;
  }
  tail.forEach((t, k) => cs.push(mk(...t, 20 + k)));
  return cs;
}
const found = (cs, id, opts) => scanCandlePatterns(cs, { patterns: [id], ...opts }).filter((d) => d.index === cs.length - 1);

test('catalogue: 9 bullish + 9 bearish, unique ids', () => {
  assert.equal(PATTERNS.filter((p) => p.dir === 'BULLISH').length, 9);
  assert.equal(PATTERNS.filter((p) => p.dir === 'BEARISH').length, 9);
  assert.equal(new Set(PATTERNS.map((p) => p.id)).size, 18);
});

test('hammer / inverted hammer after a fall', () => {
  assert.equal(found(downtrend([[100, 100.2, 97, 100.1]]), 'hammer').length, 1);
  assert.equal(found(downtrend([[100, 103, 99.9, 100.1]]), 'inverted_hammer').length, 1);
});

test('hanging man / shooting star after a rise', () => {
  assert.equal(found(uptrend([[120, 120.1, 117, 119.9]]), 'hanging_man').length, 1);
  assert.equal(found(uptrend([[120, 123, 119.9, 120.1]]), 'shooting_star').length, 1);
});

test('the same hammer shape WITHOUT a prior fall is ignored (and shows when the trend filter is off)', () => {
  const flat = [];
  for (let i = 0; i < 20; i++) flat.push(mk(100, 100.7, 99.3, i % 2 ? 100.2 : 99.8, i));
  flat.push(mk(100, 100.1, 97.5, 100.05, 20));
  assert.equal(found(flat, 'hammer').length, 0);
  assert.equal(found(flat, 'hammer', { requireTrend: false }).length, 1);
});

test('engulfing both ways', () => {
  assert.equal(found(downtrend([[100, 100.2, 98.8, 99], [98.8, 101.5, 98.6, 101.2]]), 'bullish_engulfing').length, 1);
  assert.equal(found(uptrend([[120, 121.2, 119.8, 121], [121.2, 121.4, 118.6, 118.8]]), 'bearish_engulfing').length, 1);
});

test('piercing line / dark cloud cover', () => {
  assert.equal(found(downtrend([[102, 102.1, 99.9, 100], [99.5, 101.4, 99.3, 101.3]]), 'piercing_line').length, 1);
  assert.equal(found(uptrend([[118, 120.1, 117.9, 120], [120.5, 120.7, 118.7, 118.9]]), 'dark_cloud_cover').length, 1);
});

test('morning star / evening star', () => {
  assert.equal(found(downtrend([[103, 103.1, 100.9, 101], [100.6, 100.9, 100.2, 100.7], [100.8, 103.2, 100.7, 103]]), 'morning_star').length, 1);
  assert.equal(found(uptrend([[117, 119.1, 116.9, 119], [119.3, 119.8, 119.1, 119.4], [119.2, 119.3, 116.8, 117]]), 'evening_star').length, 1);
});

test('three white soldiers / three black crows', () => {
  assert.equal(found(downtrend([[100, 101.7, 99.9, 101.5], [101, 103.2, 100.9, 103], [102.6, 104.7, 102.5, 104.5]]), 'three_white_soldiers').length, 1);
  assert.equal(found(uptrend([[120, 120.1, 118.3, 118.5], [119, 119.1, 116.8, 117], [117.4, 117.5, 115.3, 115.5]]), 'three_black_crows').length, 1);
});

test('harami / tweezer / doji', () => {
  assert.equal(found(downtrend([[103, 103.1, 99.9, 100], [100.8, 101.8, 100.6, 101.5]]), 'bullish_harami').length, 1);
  assert.equal(found(uptrend([[117, 120.1, 116.9, 120], [119.2, 119.4, 117.6, 117.8]]), 'bearish_harami').length, 1);
  assert.equal(found(downtrend([[100.6, 100.8, 98.9, 99.1], [99.0, 100.7, 98.9, 100.5]]), 'tweezer_bottom').length, 1);
  assert.equal(found(uptrend([[119.2, 121.1, 119.1, 120.9], [121, 121.1, 119.4, 119.6]]), 'tweezer_top').length, 1);
  assert.equal(found(downtrend([[100, 100.05, 98.6, 100.02]]), 'dragonfly_doji').length, 1);
  assert.equal(found(uptrend([[120, 121.4, 119.95, 119.98]]), 'gravestone_doji').length, 1);
});

test('detections carry position info for the chart and are newest first', () => {
  const cs = downtrend([[100, 100.2, 98.8, 99], [98.8, 101.5, 98.6, 101.2]]);
  const d = scanCandlePatterns(cs, { patterns: ['bullish_engulfing'] })[0];
  assert.equal(d.startIndex, cs.length - 2);
  assert.equal(d.index, cs.length - 1);
  assert.equal(d.time, cs[cs.length - 1].time);
  assert.ok(d.high >= d.close && d.low <= d.close);
  assert.equal(d.dir, 'BULLISH');
  const all = scanCandlePatterns(cs);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].index >= all[i].index);
  assert.ok(atrSeries(cs).every((x) => x > 0));
});
