import test from 'node:test';
import assert from 'node:assert/strict';
import { rangeSince, scanPathHits, toMs } from '../lib/signals/pathRange.js';
import { applyLifecycle } from '../lib/signals/signalLifecycle.js';

const MIN5 = 5 * 60 * 1000;
const t0 = Date.UTC(2026, 9, 25, 10, 0, 0); // ms
const c = (i, o, h, l, cl) => ({ time: (t0 + i * MIN5) / 1000, open: o, high: h, low: l, close: cl });

const shortSig = {
  signal_id: 'XUSDT_SHORT_ICT',
  symbol: 'XUSDT',
  direction: 'SHORT',
  status: 'READY',
  entry: 100,
  sl: 103,
  tp1: 96,
  tp2: 93,
  tp3: 90,
  created_at: new Date(t0).toISOString(),
  ready_at: new Date(t0).toISOString(),
  metadata: { strategy: 'ict_smc' },
};

test('rangeSince covers every candle since the signal was born, not just the last one', () => {
  const candles = [
    c(0, 99, 99.5, 98, 98.5),
    c(1, 98.5, 98.6, 95.5, 96.2), // wick below TP1 (96)
    c(2, 96.2, 99.8, 96.1, 99.7),
    c(3, 99.7, 100.4, 99.5, 100.1), // "now": back at entry
  ];
  const r = rangeSince(candles, t0, MIN5);
  assert.equal(r.low, 95.5);
  assert.equal(r.high, 100.4);
  assert.equal(r.candles, 4);
  // the current candle on its own never touched TP1 — that was the old blind spot
  assert.ok(candles[3].low > shortSig.tp1);
});

test('READY signal that tagged TP1 earlier and came back to entry is invalidated (missed entry)', () => {
  const candles = [c(0, 99, 99.5, 98, 98.5), c(1, 98.5, 98.6, 95.5, 96.2), c(2, 96.2, 99.8, 96.1, 99.7), c(3, 99.7, 100.4, 99.5, 100.1)];
  const now = new Date(t0 + 4 * MIN5);
  const preEntryRange = rangeSince(candles, t0, MIN5);

  // old behaviour (current candle only): the signal survives
  const old = applyLifecycle(shortSig, 100.1, 1, now, { high: 100.4, low: 99.5 }, null, {});
  assert.notEqual(old.nextStatus, 'INVALIDATED');

  // new behaviour: full candle history → invalid, reason = TP1 before entry
  const res = applyLifecycle(shortSig, 100.1, 1, now, { high: 100.4, low: 99.5 }, null, { preEntryRange });
  assert.equal(res.nextStatus, 'INVALIDATED');
  assert.equal(res.updates.metadata.invalidation.reasons[0].code, 'TP1_BEFORE_ENTRY');
});

test('a normal READY signal whose price never reached TP1 is untouched', () => {
  const candles = [c(0, 100.5, 101, 99.2, 99.8), c(1, 99.8, 100.6, 99.4, 100.2)];
  const preEntryRange = rangeSince(candles, t0, MIN5);
  const res = applyLifecycle(shortSig, 100.2, 1, new Date(t0 + 2 * MIN5), { high: 100.6, low: 99.4 }, null, { preEntryRange });
  assert.notEqual(res.nextStatus, 'INVALIDATED');
});

const ongoing = {
  ...shortSig,
  status: 'ONGOING',
  entry_hit_at: new Date(t0).toISOString(),
  entry_hit_price: 100,
  tp1_hit: false,
};

test('scanPathHits: TP1 reached before SL is kept, TP after SL is not', () => {
  const tpThenSl = [c(1, 99, 99.5, 95.8, 96.5), c(2, 96.5, 103.5, 96.4, 103.2)];
  const a = scanPathHits(ongoing, tpThenSl, t0, MIN5);
  assert.equal(a.tp1, true);
  assert.equal(a.sl, true);

  const slThenTp = [c(1, 100, 103.4, 99.5, 103.1), c(2, 103, 103.2, 95.5, 96)];
  const b = scanPathHits(ongoing, slThenTp, t0, MIN5);
  assert.equal(b.sl, true);
  assert.equal(b.tp1, false); // came after the stop-out → not part of this trade
});

test('ONGOING: TP1 touched between ticks and SL later → STOPPED with tp1_hit (counts as TP, not SL)', () => {
  const candles = [c(1, 99, 99.5, 95.8, 96.5), c(2, 96.5, 103.5, 96.4, 103.2)];
  const pathHits = scanPathHits(ongoing, candles, t0, MIN5);
  const res = applyLifecycle(ongoing, 103.2, 1, new Date(t0 + 3 * MIN5), { high: 103.5, low: 103 }, null, { pathHits });
  assert.equal(res.nextStatus, 'STOPPED');
  assert.equal(res.updates.tp1_hit, true);
  assert.ok(res.events.some((e) => e.event_type === 'TP1_HIT'));
});

test('ONGOING: plain SL without any TP stays a pure SL', () => {
  const candles = [c(1, 100, 103.4, 99.8, 103.1)];
  const pathHits = scanPathHits(ongoing, candles, t0, MIN5);
  const res = applyLifecycle(ongoing, 103.1, 1, new Date(t0 + 2 * MIN5), { high: 103.4, low: 99.8 }, null, { pathHits });
  assert.equal(res.nextStatus, 'STOPPED');
  assert.notEqual(res.updates.tp1_hit, true);
});

test('toMs parses ISO strings and rejects garbage', () => {
  assert.equal(toMs('2026-10-25T10:00:00.000Z'), t0);
  assert.equal(toMs(null), null);
  assert.equal(toMs('nope'), null);
});

test('READY → ONGOING needs the entry to be touched: price that stayed below a SHORT entry never enters', () => {
  // price sat between entry and TP1 the whole time (entry 100 never reached)
  const candles = [c(0, 98, 98.6, 97.5, 98.4), c(1, 98.4, 98.7, 97.2, 97.6), c(2, 97.6, 98.2, 97.3, 97.5), c(3, 97.5, 97.9, 97.2, 97.4)];
  const closed = candles.slice(0, 3);
  const sig = { ...shortSig, metadata: {} };
  const range = rangeSince(candles, t0, MIN5);
  const now = new Date(t0 + 4 * MIN5);
  const noTouch = applyLifecycle(sig, 97.4, 1, now, { high: 97.9, low: 97.2 }, null, { closedCandles: closed, preEntryRange: range });
  assert.equal(noTouch.nextStatus, 'READY');

  // same candles but the range did reach the entry zone → entry allowed again
  const touched = applyLifecycle(sig, 97.4, 1, now, { high: 97.9, low: 97.2 }, null, { closedCandles: closed, preEntryRange: { high: 100.2, low: 97.2, candles: 4 } });
  assert.equal(touched.nextStatus, 'ONGOING');
});
