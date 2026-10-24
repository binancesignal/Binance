import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findFirstEmaCrossInZone,
  evaluateEmaCrossZone,
  isHiddenByEmaCrossZone,
  normalizeEmaCrossZoneConfig,
  applyEmaCrossZoneToActiveSignals,
} from '../lib/signals/emaCrossZone.js';

// Price drifts down, rallies, then drifts down again → several EMA20/50 crosses at different prices.
function series() {
  const closes = [];
  for (let i = 0; i < 70; i++) closes.push(100 - i * 0.2); // down
  for (let i = 0; i < 60; i++) closes.push(86 + i * 0.5); // up
  for (let i = 0; i < 60; i++) closes.push(116 - i * 0.6); // down
  return closes.map((c, i) => ({ time: 1000 + i * 60, open: c, high: c + 0.1, low: c - 0.1, close: c }));
}
const candles = series();

function allCrosses() {
  const out = [];
  let lo = Infinity, hi = -Infinity;
  for (let w = 0; w < 200; w++) {
    const zl = 80 + w * 0.2;
    const c = findFirstEmaCrossInZone(candles, zl, zl + 0.5, { fast: 20, slow: 50 });
    if (c) out.push(c);
  }
  return out;
}

test('finds a cross inside the zone and reports its price inside the band', () => {
  const found = allCrosses();
  assert.ok(found.length > 0);
  for (const c of found) assert.ok(['bullish', 'bearish'].includes(c.type));
});

test('returns the FIRST (leftmost) cross when several fall in the same zone', () => {
  const wide = findFirstEmaCrossInZone(candles, 0, 1000, { fast: 20, slow: 50 });
  assert.ok(wide);
  // brute force: no earlier cross exists
  const narrowAll = [];
  for (let i = 0; i < candles.length; i++) {
    const c = findFirstEmaCrossInZone(candles.slice(0, i + 1), 0, 1000, { fast: 20, slow: 50 });
    if (c) { narrowAll.push(c); break; }
  }
  assert.equal(narrowAll[0].index, wide.index);
});

test('no cross when the zone is far away from every cross', () => {
  assert.equal(findFirstEmaCrossInZone(candles, 500, 510, { fast: 20, slow: 50 }), null);
});

test('not enough candles → null', () => {
  assert.equal(findFirstEmaCrossInZone(candles.slice(0, 30), 0, 1000), null);
});

test('evaluate uses ob_low/ob_high and stores tf', () => {
  const wide = findFirstEmaCrossInZone(candles, 0, 1000, { fast: 20, slow: 50 });
  const sig = { ob_low: wide.price - 0.05, ob_high: wide.price + 0.05, metadata: { patternTf: '30m' } };
  const r = evaluateEmaCrossZone(sig, candles, { enabled: true, fast: 20, slow: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.tf, '30m');
  const far = evaluateEmaCrossZone({ ob_low: 900, ob_high: 901, metadata: {} }, candles, { enabled: true });
  assert.equal(far.ok, false);
});

test('hide rules: only WATCHING/READY, only when ON, only when checked + failed with same EMA settings', () => {
  const cfg = { enabled: true, fast: 20, slow: 50 };
  const failed = { fast: 20, slow: 50, ok: false };
  assert.equal(isHiddenByEmaCrossZone({ status: 'READY', metadata: { emaCrossZone: failed } }, cfg), true);
  assert.equal(isHiddenByEmaCrossZone({ status: 'WATCHING', metadata: { emaCrossZone: failed } }, cfg), true);
  assert.equal(isHiddenByEmaCrossZone({ status: 'ONGOING', metadata: { emaCrossZone: failed } }, cfg), false);
  assert.equal(isHiddenByEmaCrossZone({ status: 'READY', metadata: { emaCrossZone: failed } }, { ...cfg, enabled: false }), false);
  assert.equal(isHiddenByEmaCrossZone({ status: 'READY', metadata: {} }, cfg), false);
  assert.equal(isHiddenByEmaCrossZone({ status: 'READY', metadata: { emaCrossZone: { ...failed, fast: 21 } } }, cfg), false);
  assert.equal(isHiddenByEmaCrossZone({ status: 'READY', metadata: { emaCrossZone: { ...failed, ok: true } } }, cfg), false);
});

test('normalize keeps fast < slow', () => {
  const c = normalizeEmaCrossZoneConfig({ enabled: true, fast: 60, slow: 50 });
  assert.ok(c.fast < c.slow);
  assert.equal(normalizeEmaCrossZoneConfig({}).enabled, false);
});

test('apply to existing signals: ON checks + marks, OFF clears', async () => {
  const wide = findFirstEmaCrossInZone(candles, 0, 1000, { fast: 20, slow: 50 });
  const store = new Map([
    ['a', { signal_id: 'a', symbol: 'AAA', status: 'READY', ob_low: wide.price - 0.05, ob_high: wide.price + 0.05, metadata: { patternTf: '15m' } }],
    ['b', { signal_id: 'b', symbol: 'BBB', status: 'WATCHING', ob_low: 900, ob_high: 901, metadata: { patternTf: '15m' } }],
    ['c', { signal_id: 'c', symbol: 'CCC', status: 'ONGOING', ob_low: 900, ob_high: 901, metadata: {} }],
  ]);
  const deps = {
    getActiveSignals: async () => [...store.values()],
    updateSignal: async (id, u) => store.set(id, { ...store.get(id), ...u }),
    getKlines: async () => candles,
  };
  const on = await applyEmaCrossZoneToActiveSignals({ enabled: true, fast: 20, slow: 50 }, deps);
  assert.deepEqual([on.checked, on.passed, on.hidden], [2, 1, 1]);
  assert.equal(store.get('a').metadata.emaCrossZone.ok, true);
  assert.equal(store.get('b').metadata.emaCrossZone.ok, false);
  assert.equal(store.get('c').metadata.emaCrossZone, undefined); // ONGOING untouched
  const off = await applyEmaCrossZoneToActiveSignals({ enabled: false }, deps);
  assert.equal(off.cleared, 2);
  assert.equal(store.get('b').metadata.emaCrossZone, undefined);
});
