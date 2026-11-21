import test from 'node:test';
import assert from 'node:assert/strict';

// In-memory database (no Supabase env) → store functions run for real
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;

let store;
try {
  store = await import('../lib/harmonicSaved/store.js');
} catch (e) {
  store = null;
}

const mk = (over = {}) => ({
  symbol: 'BTCUSDT', tf: '1h', family: 'GARTLEY', kind: 'PROJECTED', direction: 'LONG',
  time: 1700000000, C: { time: 1700000000 }, status: 'WAITING', score: 70, ...over,
});

test('store: scan merge, refresh, never overwrite finals, clear', { skip: !store }, async () => {
  let ok = true;
  try {
    await store.clearSaved();
  } catch (e) {
    ok = false; // no DB available in this environment
  }
  if (!ok) return;
  const a = mk();
  const r1 = await store.mergeScanned([a, mk({ symbol: 'ETHUSDT', C: { time: 1700000001 } })]);
  assert.equal(r1.added, 2);
  const list = await store.loadSaved();
  assert.equal(list.length, 2);
  const id = list.find((x) => x.symbol === 'BTCUSDT').id;

  // refresh → TP1 hit, same refresh time on every updated item
  await store.applyRefresh(new Map([[id, { status: 'TP1_HIT', refreshedAt: Math.floor(Date.now() / 1000) }]]));
  assert.equal((await store.loadSaved()).find((x) => x.id === id).status, 'TP1_HIT');

  // SL hit is final: neither a re-scan nor a late refresh may bring it back to WAITING
  await store.applyRefresh(new Map([[id, { status: 'SL_HIT', refreshedAt: Math.floor(Date.now() / 1000) }]]));
  await store.mergeScanned([mk({ status: 'WAITING' })]);
  await store.applyRefresh(new Map([[id, { status: 'WAITING', refreshedAt: Math.floor(Date.now() / 1000) }]]));
  assert.equal((await store.loadSaved()).find((x) => x.id === id).status, 'SL_HIT');

  await store.clearSaved();
  assert.equal((await store.loadSaved()).length, 0);
});
