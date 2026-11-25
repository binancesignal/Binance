import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNearBreakout } from '../lib/scanner/strategy/chartPattern/breakout.js';

// 60 sideways candles inside 98–102 (closes 99.5–100.5), ATR ≈ 1
const candles = Array.from({ length: 60 }, (_, i) => {
  const c = 100 + (i % 2 ? 0.5 : -0.5);
  return { time: 1_000_000 + i * 900, open: c, close: c, high: c + 0.5, low: c - 0.5, volume: 100 };
});
const pat = (over = {}) => ({ direction: 'LONG', resistance: 102, support: 98, endIndex: 50, ...over });
const cfg = { nearMaxPatternAge: 30, nearMaxGapATR: 0.6, nearLivePastATR: 0.5 };

test('price near the level → ok, with the real age', () => {
  const r = evaluateNearBreakout(pat(), candles, 1, 101.7, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.age, 58 - 50);
});

test('price merely drifted away → NOT stale: code not_near and the real (small) age is returned', () => {
  const r = evaluateNearBreakout(pat(), candles, 1, 99.0, cfg);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_near');
  assert.equal(r.age, 8, 'age must be the real age, never a fake 99');
});

test('pattern really too old → code too_old with the real age', () => {
  const r = evaluateNearBreakout(pat({ endIndex: 5 }), candles, 1, 101.7, cfg);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too_old');
  assert.equal(r.age, 53);
});

test('price left through the opposite side → opposite_side', () => {
  const r = evaluateNearBreakout(pat(), candles, 1, 97.0, cfg);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'opposite_side');
});

test('stale rescue (recheck): old pattern near the level is kept, hard cap still applies', () => {
  const rc = { ...cfg, nearRecheck: true, nearStaleRescue: true, nearStaleRescueMaxAge: 150 };
  const old = evaluateNearBreakout(pat({ endIndex: 5 }), candles, 1, 101.7, rc); // age 53 > 30
  assert.equal(old.ok, true, 'age 53 must survive with rescue ON');
  const capped = evaluateNearBreakout(pat({ endIndex: 5 }), candles, 1, 101.7, { ...rc, nearStaleRescueMaxAge: 40 });
  assert.equal(capped.code, 'too_old');
  const off = evaluateNearBreakout(pat({ endIndex: 5 }), candles, 1, 101.7, { ...rc, nearStaleRescue: false });
  assert.equal(off.code, 'too_old', 'rescue OFF = classic behaviour');
});

test('stale rescue does not apply to fresh radar detections (no nearRecheck flag)', () => {
  const r = evaluateNearBreakout(pat({ endIndex: 5 }), candles, 1, 101.7, { ...cfg, nearStaleRescue: true });
  assert.equal(r.code, 'too_old');
});
