import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../lib/database/index.js';
import { getPerformanceSummary } from '../lib/performance/summary.js';

test('performance summary separates pure SL from TP→SL', async () => {
  const db = getDb();
  if (db.type === 'supabase') return; // memory-store only
  const now = new Date().toISOString();
  const mk = (id, extra) => ({
    signal_id: id, symbol: id + 'USDT', direction: 'LONG', created_at: now, entry_hit_at: now, ...extra,
  });
  db.store.signals.set('a', mk('A', { status: 'STOPPED', stopped_at: now }));
  db.store.signals.set('b', mk('B', { status: 'STOPPED', stopped_at: now, tp1_hit: true }));
  db.store.signals.set('c', mk('C', { status: 'STOPPED', stopped_at: now, tp1_hit: true, tp2_hit: true }));
  db.store.signals.set('d', mk('D', { status: 'COMPLETED_PROFIT', completed_at: now, tp1_hit: true, tp2_hit: true, tp3_hit: true }));
  const r = await getPerformanceSummary({ period: 'all' });
  assert.equal(r.totals.slHit, 1);
  assert.equal(r.totals.tpThenSl, 2);
  assert.equal(r.totals.tp1ThenSl, 1);
  assert.equal(r.totals.tp2ThenSl, 1);
  assert.equal(r.totals.stoppedTrades, 3);
  const results = r.recentCompleted.map((x) => x.result).sort();
  assert.deepEqual(results, ['PROFIT', 'SL']);
  // TP→SL skipped from exclusive TP tiles — only pure completed counts
  assert.equal(r.totals.tp1, 0);
  assert.equal(r.totals.tp2, 0);
  assert.equal(r.totals.tp3, 1);
  // win rate ignores TP→SL: 1 profit / (1 profit + 1 pure SL) = 50%
  assert.equal(r.totals.winRate, 50);
});
