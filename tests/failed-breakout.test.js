import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFailedBreakout, isConfirmedPatternBreakout } from '../lib/signals/failedBreakout.js';

const SEC = 900; // 15m
const base = 1_000_000;
const sig = (over = {}) => ({
  direction: 'SHORT',
  metadata: {
    strategy: 'chart_pattern',
    breakoutConfirmed: true,
    patternTf: '15m',
    breakoutLevel: 100,
    breakoutCandleTime: base,
    patternGeom: { harmonic: false },
    ...over,
  },
});
const c = (i, close) => ({ time: base + i * SEC, close });
const now = base + 20 * SEC;

test('one shallow close back inside (retest noise) does NOT invalidate', () => {
  const r = checkFailedBreakout(sig(), [c(1, 100.3)], { atr: 1, bufferAtr: 0.5, confirmCandles: 2, nowSec: now });
  assert.equal(r.failed, false);
});

test('one close deeper than the ATR line = clear fake', () => {
  const r = checkFailedBreakout(sig(), [c(1, 100.8)], { atr: 1, bufferAtr: 0.5, confirmCandles: 2, nowSec: now });
  assert.equal(r.failed, true);
  assert.equal(r.kind, 'deep');
});

test('two consecutive shallow closes inside = failed', () => {
  const r = checkFailedBreakout(sig(), [c(1, 100.2), c(2, 100.3)], { atr: 1, bufferAtr: 0.5, confirmCandles: 2, nowSec: now });
  assert.equal(r.failed, true);
  assert.equal(r.kind, 'held_inside');
});

test('a close back outside resets the count (retest then continuation)', () => {
  const r = checkFailedBreakout(sig(), [c(1, 100.2), c(2, 99.5), c(3, 100.2)], { atr: 1, bufferAtr: 0.5, confirmCandles: 2, nowSec: now });
  assert.equal(r.failed, false);
});

test('harmonic patterns are never checked as breakouts', () => {
  const h = sig({ patternGeom: { harmonic: true } });
  assert.equal(isConfirmedPatternBreakout(h), false);
  assert.equal(checkFailedBreakout(h, [c(1, 105)], { atr: 1, nowSec: now }).failed, false);
});
