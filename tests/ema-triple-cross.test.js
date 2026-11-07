import test from 'node:test';
import assert from 'node:assert/strict';
import { findTripleCrosses, tallyTriple, buildTripleChartSvg, computeEmas } from '../lib/scanner/strategy/emaTripleCross/index.js';

// Long flat/uptrend, then a violent drop that drags EMA20 through EMA50 and EMA200 together.
function dropSeries() {
  const closes = [];
  for (let i = 0; i < 260; i++) closes.push(100 + Math.sin(i / 9) * 0.3); // flat, EMAs bunched
  for (let i = 0; i < 12; i++) closes.push(100 - i * 2.5); // crash
  for (let i = 0; i < 40; i++) closes.push(70 - i * 0.1);
  return closes.map((c, i) => ({ time: 1_700_000_000 + i * 900, open: c + 0.05, high: c + 0.2, low: c - 0.2, close: c, volume: 1 }));
}

test('detects a DOWN triple cross after a crash', () => {
  const c = dropSeries();
  const ev = findTripleCrosses(c, { windowBars: 15, mode: 'any2' });
  assert.ok(ev.some((e) => e.dir === 'DOWN'), 'expected a DOWN event');
  const d = ev.find((e) => e.dir === 'DOWN');
  assert.ok(d.pairsCrossed >= 2);
  assert.ok(d.index > 200);
});

test('direction filter and mirror (UP) work', () => {
  const c = dropSeries();
  assert.equal(findTripleCrosses(c, { windowBars: 15, mode: 'any2', direction: 'UP' }).filter((e) => e.dir === 'DOWN').length, 0);
  const mirrored = c.map((x) => ({ ...x, open: 200 - x.open, close: 200 - x.close, high: 200 - x.low, low: 200 - x.high }));
  assert.ok(findTripleCrosses(mirrored, { windowBars: 15, mode: 'any2' }).some((e) => e.dir === 'UP'));
});

test('too few candles → no events; forward stats + tally + svg', () => {
  assert.deepEqual(findTripleCrosses(dropSeries().slice(0, 100)), []);
  const c = dropSeries();
  const ev = findTripleCrosses(c, { windowBars: 15, mode: 'any2', forwardBars: 5 });
  const t = tallyTriple(ev);
  assert.equal(t.total, ev.length);
  const svg = buildTripleChartSvg(c, ev[0], computeEmas(c), { symbol: 'TEST', tf: '15m', tzMin: 330 });
  assert.ok(svg.startsWith('<svg') && svg.includes('UTC+5:30'));
});

test("default 'fast' mode: EMA20 slicing through 50 and 200 is detected", () => {
  const ev = findTripleCrosses(dropSeries(), { windowBars: 15 });
  const d = ev.find((e) => e.dir === 'DOWN');
  assert.ok(d, 'expected DOWN event');
  assert.deepEqual(d.crosses.map((c) => c.pair).sort(), ['20/200', '20/50']);
});
