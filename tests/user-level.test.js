import test from 'node:test';
import assert from 'node:assert/strict';
import { levelFromVolume, sumTradedVolume } from '../lib/trading/userLevel.js';

test('new user is Bronze with $0 / $1,000,000', () => {
  const l = levelFromVolume(0);
  assert.equal(l.level, 'Bronze');
  assert.equal(l.target, 1_000_000);
  assert.equal(l.progress, 0);
  assert.equal(l.nextLevel, 'Silver');
});

test('volume only counts executions that really traded', () => {
  const v = sumTradedVolume([
    { status: 'FILLED', notional: 1000 },
    { status: 'FAILED', notional: 5000 },
    { status: 'SKIPPED', notional: null },
    { status: 'FILLED', notional: 400, dry_run: true },
    { status: 'PROTECTED', notional: '250.5' },
  ]);
  assert.equal(v, 1250.5);
});

test('level moves up at the thresholds and the top level is capped', () => {
  assert.equal(levelFromVolume(1_000_000).level, 'Silver');
  assert.equal(levelFromVolume(500_000).progress, 0.5);
  const top = levelFromVolume(99_000_000);
  assert.equal(top.level, 'Diamond');
  assert.equal(top.nextLevel, null);
  assert.equal(top.progress, 1);
});
