import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatResolvedOutcome,
  getRecentResolvedOutcomes,
  summarizeResolvedOutcomes,
} from '../lib/telegram/boardOutcomes.js';

test('recent board outcomes keep closed SL/TP3 records and exclude non-trades', () => {
  const history = [
    { signal_id: 'sl-1', status: 'STOPPED' },
    { signal_id: 'invalid-1', status: 'INVALIDATED' },
    { signal_id: 'tp-1', status: 'COMPLETED_PROFIT' },
  ];

  const outcomes = getRecentResolvedOutcomes(history, 8);

  assert.deepEqual(outcomes.map((signal) => signal.signal_id), ['sl-1', 'tp-1']);
  assert.deepEqual(summarizeResolvedOutcomes(outcomes), { total: 2, tp1: 0, tp2: 0, tp3: 1, sl: 1, tpSl: 0 });
});

test('a stopped outcome with no TP is explicitly labeled SL HIT with entry and stop', () => {
  const line = formatResolvedOutcome({
    status: 'STOPPED',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    score: 83,
    entry: 65000,
    sl: 64000,
    metadata: { confluenceMode: 'ict_chart_pattern' },
    tp1_hit: false,
    tp2_hit: false,
    tp3_hit: false,
  });

  assert.match(line, /SL HIT \[ICT\+CP\] BTCUSDT LONG/);
  assert.match(line, /Entry\s+65000\.00/);
  assert.match(line, /SL\s+64000\.00/);
});

test('TP1 touched then stopped is reported as a TP1 result, never as SL', () => {
  const line = formatResolvedOutcome({
    status: 'STOPPED',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    entry: 65000,
    sl: 64000,
    tp1: 66000,
    tp1_hit: true,
  });
  assert.doesNotMatch(line, /SL HIT/);
  assert.match(line, /TP1 HIT BTCUSDT LONG/);
  assert.match(line, /Targets reached: TP1/);
});

test('stopped after a TP hit stays in the list and counts as that TP (not SL)', () => {
  const history = [
    { signal_id: 'sl', status: 'STOPPED' },
    { signal_id: 'tp1-sl', status: 'STOPPED', tp1_hit: true },
    { signal_id: 'tp2-sl', status: 'STOPPED', tp1_hit: true, tp2_hit: true },
    { signal_id: 'tp3', status: 'COMPLETED_PROFIT', tp3_hit: true },
  ];
  const outcomes = getRecentResolvedOutcomes(history, 8);
  assert.deepEqual(outcomes.map((s) => s.signal_id), ['sl', 'tp1-sl', 'tp2-sl', 'tp3']);
  assert.deepEqual(summarizeResolvedOutcomes(outcomes), { total: 4, tp1: 1, tp2: 1, tp3: 1, sl: 1, tpSl: 0 });
});
