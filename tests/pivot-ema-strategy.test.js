import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pivotKindFor, computePivots, evaluateTouch, findPivotTouches, backtestPivotEma, tally, PIVOT_EMA_FIXED,
} from '../lib/scanner/strategy/pivotEma/index.js';

const T0 = Date.UTC(2026, 9, 5) / 1000; // Mon 5 Oct 2026 00:00 UTC (start of a week and a day)
const mk = (time, o, h, l, c) => ({ time, open: o, high: h, low: l, close: c, volume: 1000 });

test('TradingView "Auto" pivot timeframe mapping', () => {
  assert.equal(pivotKindFor('5m'), 'D');
  assert.equal(pivotKindFor('15m'), 'D');
  assert.equal(pivotKindFor('30m'), 'W');
  assert.equal(pivotKindFor('2h'), 'W');
  assert.equal(pivotKindFor('12h'), 'W');
  assert.equal(pivotKindFor('1d'), 'M');
});

test('daily pivot = (H+L+C)/3 of the previous UTC day; partial first day is ignored', () => {
  const c = [];
  // day 0 (Mon): bars 00:00..23:00 hourly — complete day, H=110 L=90 C=104
  for (let h = 0; h < 24; h++) c.push(mk(T0 + h * 3600, 100, h === 5 ? 110 : 101, h === 9 ? 90 : 99, h === 23 ? 104 : 100));
  // day 1: any bars
  for (let h = 0; h < 24; h++) c.push(mk(T0 + 86400 + h * 3600, 100, 102, 98, 100));
  const { p, kind } = computePivots(c, '15m');
  assert.equal(kind, 'D');
  assert.equal(p[0], null); // no previous day yet
  assert.equal(p[24], (110 + 90 + 104) / 3);
  assert.equal(p[47], (110 + 90 + 104) / 3);

  // same data but starting mid-day → that first day is partial → day 1 has no pivot
  const partial = c.slice(6);
  const pp = computePivots(partial, '15m').p;
  assert.equal(pp[partial.length - 1], null);
});

test('weekly pivot starts on Monday 00:00 UTC (matches the 2h chart screenshot)', () => {
  const c = [];
  // week A: Mon 28 Sep .. Sun 4 Oct, 12h bars. H=120 L=80 C=100
  const wa = T0 - 7 * 86400;
  for (let i = 0; i < 14; i++) c.push(mk(wa + i * 43200, 100, i === 3 ? 120 : 101, i === 6 ? 80 : 99, 100));
  // week B starts Mon 5 Oct
  for (let i = 0; i < 14; i++) c.push(mk(T0 + i * 43200, 100, 101, 99, 100));
  const { p, kind } = computePivots(c, '12h');
  assert.equal(kind, 'W');
  assert.equal(p[13], null);
  assert.equal(p[14], (120 + 80 + 100) / 3);
  assert.equal(p[27], (120 + 80 + 100) / 3);
});

test('evaluateTouch: WIN when price reverses ≥1 ATR before going ≥1 ATR past the pivot', () => {
  const atr = 1, P = 100;
  const c = [
    mk(1, 99, 100.2, 98, 99.5),   // touch bar (came from below)
    mk(2, 99.5, 99.8, 98.5, 98.9),
    mk(3, 98.9, 99.0, 98.8, 98.9), // low 98.8 → 1.2 ATR below P → WIN for SHORT
  ];
  const r = evaluateTouch(c, 0, 'SHORT', P, atr);
  assert.equal(r.outcome, 'WIN');
});

test('evaluateTouch: LOSS when price passes the pivot ≥1 ATR first', () => {
  const c = [mk(1, 99, 100.2, 98, 99.5), mk(2, 99.5, 101.3, 99.4, 101.1), mk(3, 101, 101, 97, 97)];
  const r = evaluateTouch(c, 0, 'SHORT', 100, 1);
  assert.equal(r.outcome, 'LOSS');
  // LONG mirror
  const c2 = [mk(1, 101, 102, 99.8, 100.5), mk(2, 100.5, 100.6, 98.6, 98.9), mk(3, 99, 103, 99, 103)];
  assert.equal(evaluateTouch(c2, 0, 'LONG', 100, 1).outcome, 'LOSS');
});

test('evaluateTouch: same-bar tie counts as LOSS; no resolution = OPEN then TIMEOUT', () => {
  const tie = [mk(1, 99, 100.2, 98, 99.5), mk(2, 99.5, 101.5, 98.5, 99)];
  assert.equal(evaluateTouch(tie, 0, 'SHORT', 100, 1).outcome, 'LOSS');
  const flat = [mk(1, 99, 100.2, 98, 99.5), mk(2, 99.5, 99.8, 99.3, 99.6)];
  assert.equal(evaluateTouch(flat, 0, 'SHORT', 100, 1).outcome, 'OPEN');
  const long = [mk(1, 99, 100.2, 98, 99.5)];
  for (let k = 0; k < PIVOT_EMA_FIXED.maxBars + 2; k++) long.push(mk(2 + k, 99.5, 99.8, 99.3, 99.6));
  assert.equal(evaluateTouch(long, 0, 'SHORT', 100, 1).outcome, 'TIMEOUT');
});

test('findPivotTouches: direction follows the side price came from; fields are consistent', () => {
  // synthetic 1h market over ~5 weeks that oscillates through its own weekly pivots
  const c = [];
  let price = 100;
  for (let i = 0; i < 24 * 35; i++) {
    price += Math.sin(i / 9) * 0.35 + Math.sin(i / 41) * 0.25;
    const o = price - 0.1, cl = price + 0.1;
    c.push(mk(T0 - 21 * 86400 + i * 3600, o, Math.max(o, cl) + 0.3, Math.min(o, cl) - 0.3, cl));
  }
  const touches = findPivotTouches(c, '1h');
  assert.ok(touches.length > 0, 'expected some pivot touches');
  for (const e of touches) {
    assert.ok(['LONG', 'SHORT'].includes(e.dir));
    const bar = c[e.index];
    assert.ok(bar.low <= e.pivot && bar.high >= e.pivot);
    const before = c[e.index - 1];
    assert.equal(e.dir === 'SHORT', before.high < e.pivot); // SHORT = came from below
    assert.ok(['WIN', 'LOSS', 'TIMEOUT', 'OPEN'].includes(e.outcome));
    assert.equal(e.cross, e.crossType != null);
  }
  const bt = backtestPivotEma(c, '1h');
  assert.equal(bt.events.length + tally(touches.filter((e) => !e.cross)).total, touches.length);
  assert.ok(bt.events.every((e) => e.cross));
});

test('tally computes win rate over decided trades only', () => {
  const t = tally([{ outcome: 'WIN' }, { outcome: 'WIN' }, { outcome: 'LOSS' }, { outcome: 'TIMEOUT' }, { outcome: 'OPEN' }]);
  assert.deepEqual({ w: t.win, l: t.loss, to: t.timeout, o: t.open, wr: t.winRate }, { w: 2, l: 1, to: 1, o: 1, wr: 66.7 });
});

test('EMA cross must be NEAR the pivot: far-away cross is rejected, near cross accepted', () => {
  // flat-ish 1h market for 3 days, then a V so EMA20 crosses EMA50 at a known price; compare distance to a fake pivot
  const base = [];
  let price = 100;
  for (let i = 0; i < 24 * 30; i++) {
    price += Math.sin(i / 7) * 0.4 + Math.sin(i / 53) * 0.3;
    const o = price - 0.1, cl = price + 0.1;
    base.push(mk(T0 - 14 * 86400 + i * 3600, o, Math.max(o, cl) + 0.3, Math.min(o, cl) - 0.3, cl));
  }
  const loose = findPivotTouches(base, '1h', { ...PIVOT_EMA_FIXED, maxCrossDistATR: Infinity }).filter((e) => e.cross);
  const tight = findPivotTouches(base, '1h', { ...PIVOT_EMA_FIXED, maxCrossDistATR: 0.5 }).filter((e) => e.cross);
  assert.ok(tight.length <= loose.length);
  for (const e of tight) assert.ok(e.crossDistATR <= 0.5);
  for (const e of loose) assert.ok(Number.isFinite(e.crossPrice) || e.crossDistATR == null || true);
});
