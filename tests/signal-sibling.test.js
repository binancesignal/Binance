import test from 'node:test';
import assert from 'node:assert/strict';
import { siblingKey, pickSibling, describeLevelChange } from '../lib/signals/sibling.js';

const base = (o = {}) => ({
  signal_id: 'BTCUSDT_LONG_1_a',
  symbol: 'BTCUSDT',
  direction: 'LONG',
  strategy: 'chart_pattern',
  status: 'WATCHING',
  entry: 100,
  metadata: { patternTf: '15m', pattern: 'DOUBLE_BOTTOM' },
  ...o,
});

test('same coin/direction/strategy/pattern/tf shares a key regardless of levels', () => {
  assert.equal(siblingKey(base({ entry: 100 })), siblingKey(base({ entry: 101, signal_id: 'x' })));
  assert.notEqual(siblingKey(base()), siblingKey(base({ direction: 'SHORT' })));
  assert.notEqual(siblingKey(base()), siblingKey(base({ metadata: { patternTf: '1h', pattern: 'DOUBLE_BOTTOM' } })));
});

test('WATCHING and READY siblings are updatable, ONGOING and closed are never matched', () => {
  const fresh = base({ signal_id: 'new', entry: 101 });
  assert.equal(pickSibling(fresh, [base({ status: 'READY' })])?.signal_id, 'BTCUSDT_LONG_1_a');
  assert.equal(pickSibling(fresh, [base({ status: 'ONGOING' })]), null);
  assert.equal(pickSibling(fresh, [base({ status: 'TP1' })]), null);
  assert.equal(pickSibling(fresh, [base({ status: 'INVALIDATED' })]), null);
});

test('closest entry wins and claimed ids are skipped', () => {
  const pool = [base({ signal_id: 'far', entry: 150 }), base({ signal_id: 'near', entry: 102 })];
  const fresh = base({ signal_id: 'new', entry: 101 });
  assert.equal(pickSibling(fresh, pool)?.signal_id, 'near');
  assert.equal(pickSibling(fresh, pool, new Set(['near']))?.signal_id, 'far');
});

test('exact-id match is never its own sibling', () => {
  const same = base();
  assert.equal(pickSibling(same, [same]), null);
});

test('describeLevelChange reports only real changes', () => {
  assert.equal(describeLevelChange({ entry: 1, sl: 2, tp1: 3 }, { entry: 1, sl: 2, tp1: 3 }), null);
  assert.match(describeLevelChange({ entry: 1, sl: 2 }, { entry: 1.5, sl: 2 }), /ENTRY 1 → 1.5/);
});
