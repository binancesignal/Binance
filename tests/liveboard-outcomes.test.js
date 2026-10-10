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
  assert.deepEqual(summarizeResolvedOutcomes(outcomes), { total: 2, tp3: 1, sl: 1 });
});

test('a stopped outcome is explicitly labeled SL HIT with entry, stop and prior targets', () => {
  const line = formatResolvedOutcome({
    status: 'STOPPED',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    score: 83,
    entry: 65000,
    sl: 64000,
    metadata: { confluenceMode: 'ict_chart_pattern' },
    tp1_hit: true,
    tp2_hit: false,
    tp3_hit: false,
  });

  assert.match(line, /SL HIT \[ICT\+CP\] BTCUSDT LONG/);
  assert.match(line, /Entry\s+65000\.00/);
  assert.match(line, /SL\s+64000\.00/);
  assert.match(line, /Targets before SL: TP1/);
});