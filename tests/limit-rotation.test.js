import test from 'node:test';
import assert from 'node:assert/strict';
import {
  harmonicItemToSignal,
  buildReadyPool,
  planLimitRotation,
  describeQueue,
} from '../lib/trading/limitRotation.js';

const item = (symbol, score, over = {}) => ({
  id: `${symbol}|1h|GARTLEY`, symbol, tf: '1h', family: 'GARTLEY', direction: 'LONG', status: 'ENTRY_READY',
  score, plan: { entry: 100, sl: 95, tp1: 105, tp2: 110, tp3: 120 }, ...over,
});
const sig = (symbol, score) => harmonicItemToSignal(item(symbol, score));
const pend = (symbol, score, status = 'WAITING_FILL') => ({ id: `ex_${symbol}`, signal_id: `${symbol}|1h|GARTLEY`, symbol, side: 'LONG', status, score });

test('only ENTRY_READY items with an entry become signals; admin-pinned ones too', () => {
  assert.equal(harmonicItemToSignal(item('A', 70, { status: 'WATCHING' })), null);
  assert.equal(harmonicItemToSignal(item('A', 70, { plan: null })), null);
  assert.equal(harmonicItemToSignal(item('A', 40), { minScore: 50 }), null);
  const s = harmonicItemToSignal(item('A', 70, { adminStatusOverride: true }));
  assert.equal(s.status, 'ENTRY_READY');
  assert.equal(s.entry, 100);
  assert.equal(s.metadata.adminPinned, true);
});

test('pool: best score first, one per symbol+side', () => {
  const pool = buildReadyPool([sig('A', 60), sig('B', 80), harmonicItemToSignal(item('A', 90, { id: 'A2' }))]);
  assert.deepEqual(pool.map((s) => [s.symbol, s.score]), [['A', 90], ['B', 80]]);
});

test('first ready signal gets the limit order', () => {
  const plan = planLimitRotation({ readyPool: buildReadyPool([sig('A', 70)]), executions: [], slots: 1 });
  assert.deepEqual(plan.place.map((s) => s.symbol), ['A']);
  assert.equal(plan.cancel.length, 0);
});

test('a better ready signal replaces the waiting order (cancel old, place new)', () => {
  const plan = planLimitRotation({ readyPool: buildReadyPool([sig('A', 70), sig('B', 85)]), executions: [pend('A', 70)], slots: 1 });
  assert.equal(plan.cancel.length, 1);
  assert.equal(plan.cancel[0].execution.symbol, 'A');
  assert.equal(plan.cancel[0].kind, 'OUTRANKED');
  assert.match(plan.cancel[0].reason, /B score 85 > A score 70/);
  assert.deepEqual(plan.place.map((s) => s.symbol), ['B']);
});

test('a lower or equal score never replaces the waiting order', () => {
  for (const other of [60, 70]) {
    const plan = planLimitRotation({ readyPool: buildReadyPool([sig('A', 70), sig('B', other)]), executions: [pend('A', 70)], slots: 1 });
    assert.equal(plan.cancel.length, 0);
    assert.equal(plan.place.length, 0);
    assert.equal(plan.keep.length, 1);
  }
});

test('the waiting order is cancelled when its signal leaves ENTRY READY', () => {
  const plan = planLimitRotation({ readyPool: [], executions: [pend('A', 70)], slots: 1 });
  assert.equal(plan.cancel[0].kind, 'LEFT_READY');
  assert.equal(plan.place.length, 0);
});

test('when the better signal later disappears the weaker ready one gets its order back', () => {
  const plan = planLimitRotation({ readyPool: buildReadyPool([sig('A', 70)]), executions: [], slots: 1 });
  assert.deepEqual(plan.place.map((s) => s.symbol), ['A']);
});

test('a signal already in trade holds no waiting slot and is not ordered twice', () => {
  const running = { ...pend('A', 90), status: 'PROTECTED' };
  const plan = planLimitRotation({ readyPool: buildReadyPool([sig('A', 90), sig('B', 60)]), executions: [running], slots: 1 });
  assert.deepEqual(plan.place.map((s) => s.symbol), ['B']);
});

test('slots > 1 keeps the top N and replaces the weakest', () => {
  const plan = planLimitRotation({
    readyPool: buildReadyPool([sig('A', 70), sig('B', 65), sig('C', 90)]),
    executions: [pend('A', 70), pend('B', 65)],
    slots: 2,
  });
  assert.deepEqual(plan.cancel.map((c) => c.execution.symbol), ['B']);
  assert.deepEqual(plan.place.map((s) => s.symbol), ['C']);
  assert.deepEqual(plan.keep.map((e) => e.symbol), ['A']);
});

test('queue shows what happened to each ready signal', () => {
  const pool = buildReadyPool([sig('A', 70), sig('B', 85), sig('C', 50)]);
  const plan = planLimitRotation({ readyPool: pool, executions: [pend('A', 70)], slots: 1 });
  const q = describeQueue({ readyPool: pool, plan, executions: [pend('A', 70), { signal_id: 'C|1h|GARTLEY', status: 'SKIPPED', error: 'Max open positions 5' }] });
  const by = Object.fromEntries(q.map((x) => [x.symbol, x]));
  assert.equal(by.A.state, 'ORDER_PLACED');
  assert.equal(by.B.state, 'NEXT');
  assert.equal(by.C.state, 'SKIPPED');
  assert.equal(by.C.note, 'Max open positions 5');
});

test('admin-pinned ENTRY READY ranks first, even with a lower score, and replaces the waiting order', () => {
  const pinnedSig = harmonicItemToSignal(item('P', 40, { adminStatusOverride: true }));
  const pool = buildReadyPool([sig('A', 80), pinnedSig]);
  assert.equal(pool[0].symbol, 'P');
  const plan = planLimitRotation({ readyPool: pool, executions: [pend('A', 80)], slots: 1 });
  assert.deepEqual(plan.place.map((s) => s.symbol), ['P']);
  assert.match(plan.cancel[0].reason, /admin set P to ENTRY READY/);
});
