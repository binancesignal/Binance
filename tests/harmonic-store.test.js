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

test('admin status pin: refresh keeps it, Auto releases it, market SL/TP3 ends it', { skip: !store }, async () => {
  let ok = true;
  try { await store.clearSaved(); } catch (e) { ok = false; }
  if (!ok) return;
  await store.mergeScanned([mk()]);
  const id = (await store.loadSaved())[0].id;
  const now = () => Math.floor(Date.now() / 1000);

  await store.setAdminStatus(id, 'IN_TRADE');
  await store.applyRefresh(new Map([[id, { status: 'WAITING', price: 5, refreshedAt: now() }]]));
  let it = (await store.loadSaved())[0];
  assert.equal(it.status, 'IN_TRADE'); // pinned
  assert.equal(it.price, 5); // …but the price still moves
  assert.equal(it.entryTouched, true);

  // a re-scan must not push it back either
  await store.mergeScanned([mk({ status: 'WAITING' })]);
  assert.equal((await store.loadSaved())[0].status, 'IN_TRADE');

  await store.releaseAdminStatus(id);
  await store.applyRefresh(new Map([[id, { status: 'ENTRY_READY', refreshedAt: now() }]]));
  assert.equal((await store.loadSaved())[0].status, 'ENTRY_READY');

  await store.setAdminStatus(id, 'WATCHING');
  await store.applyRefresh(new Map([[id, { status: 'TP3_HIT', refreshedAt: now() }]]));
  it = (await store.loadSaved())[0];
  assert.equal(it.status, 'TP3_HIT'); // the market finished the trade → pin gone
  assert.equal(it.adminStatusOverride, false);

  await store.setAdminStatus(id, 'TP2_HIT');
  assert.equal((await store.loadSaved())[0].tpReached, 2);
  await store.clearSaved();
});
