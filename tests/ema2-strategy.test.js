import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findEma2Events,
  tallyEma2,
  buildEma2ChartSvg,
  computeEmas,
} from '../lib/scanner/strategy/ema2/index.js';

/** Flat → violent drop (creates DOWN triple cross) → recovery that eventually touches EMA200 from below. */
function dropThenRecoverSeries() {
  const closes = [];
  for (let i = 0; i < 260; i++) closes.push(100 + Math.sin(i / 9) * 0.3);
  for (let i = 0; i < 12; i++) closes.push(100 - i * 2.5); // crash → EMAs cross down
  // stay low for a while
  for (let i = 0; i < 30; i++) closes.push(68 + Math.sin(i / 5) * 0.4);
  // climb back toward the slow EMA (around ~90–95 after the crash lag)
  for (let i = 0; i < 80; i++) closes.push(68 + i * 0.35);
  return closes.map((c, i) => ({
    time: 1_700_000_000 + i * 900,
    open: c + 0.05,
    high: c + 0.35,
    low: c - 0.35,
    close: c,
    volume: 1,
  }));
}

test('finds TOUCHED events after a DOWN triple cross when price returns to EMA200', () => {
  const c = dropThenRecoverSeries();
  const ev = findEma2Events(c, { windowBars: 15, mode: 'any2', maxTouchBars: 200, requireApproachSide: false });
  const touched = ev.filter((e) => e.status === 'TOUCHED' && e.dir === 'DOWN');
  assert.ok(touched.length >= 1, 'expected at least one TOUCHED DOWN event');
  const t = touched[0];
  assert.ok(t.touch, 'touch object present');
  assert.ok(t.touch.barsAfterCross >= 1);
  assert.ok(t.touch.index > t.crossIndex);
  assert.equal(t.time, t.touch.time);
});

test('PENDING appears when recovery is cut short (no touch yet)', () => {
  const full = dropThenRecoverSeries();
  // keep only enough bars for the cross, truncate the recovery
  const short = full.slice(0, 290);
  const ev = findEma2Events(short, { windowBars: 15, mode: 'any2', maxTouchBars: 200, requireApproachSide: false });
  const down = ev.filter((e) => e.dir === 'DOWN');
  assert.ok(down.length >= 1);
  // most should still be pending because price has not climbed back to EMA200
  const pending = down.filter((e) => e.status === 'PENDING');
  assert.ok(pending.length >= 1, 'expected pending setups when touch not yet formed');
});

test('tally and chart svg work', () => {
  const c = dropThenRecoverSeries();
  const ev = findEma2Events(c, { windowBars: 15, mode: 'any2', maxTouchBars: 200, requireApproachSide: false });
  const t = tallyEma2(ev);
  assert.equal(t.total, ev.length);
  assert.ok(t.touched + t.pending === t.total);
  const touched = ev.find((e) => e.status === 'TOUCHED');
  if (touched) {
    const svg = buildEma2ChartSvg(c, touched, computeEmas(c), { symbol: 'TEST', tf: '15m', tzMin: 330 });
    assert.ok(svg && svg.startsWith('<svg'));
    assert.ok(svg.includes('TOUCH 200') || svg.includes('CROSS'));
  }
});
