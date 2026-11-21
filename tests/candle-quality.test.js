import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCandleQuality } from '../lib/signals/candleQuality.js';

const mk = (n, f) => Array.from({ length: n }, (_, i) => f(i));
// healthy: ~0.6% range, body 70% of range
const healthy = mk(20, (i) => {
  const o = 100 + i * 0.1;
  return { open: o, close: o + 0.42, high: o + 0.5, low: o - 0.1 };
});

test('healthy candles pass', () => {
  assert.equal(assessCandleQuality(healthy).ok, true);
});

test('long wicks / tiny bodies → WICKY', () => {
  const c = mk(20, () => ({ open: 100, close: 100.05, high: 101, low: 99 }));
  const r = assessCandleQuality(c);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WICKY');
});

test('tiny candles → SMALL', () => {
  const c = mk(20, (i) => {
    const o = 100 + i * 0.001;
    return { open: o, close: o + 0.03, high: o + 0.035, low: o - 0.002 };
  });
  const r = assessCandleQuality(c);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SMALL');
});

test('flat candles → FLAT', () => {
  const c = mk(20, (i) => (i % 2 ? { open: 100, close: 100, high: 100, low: 100 } : healthy[i]));
  assert.equal(assessCandleQuality(c).code, 'FLAT');
});

test('too few candles → fail-open', () => {
  assert.equal(assessCandleQuality(healthy.slice(0, 5)).ok, true);
});

test('disabled → ok', () => {
  const c = mk(20, () => ({ open: 100, close: 100.05, high: 101, low: 99 }));
  assert.equal(assessCandleQuality(c, { enabled: false }).ok, true);
});
