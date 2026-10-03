import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLifecycle } from '../lib/signals/signalLifecycle.js';
import { SIGNAL_STATUS } from '../lib/config/signalConfig.js';

const now = new Date('2026-10-02T08:00:00.000Z');

function makeSignal(status, overrides = {}) {
  return {
    signal_id: 'lifecycle-test-btc-long',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    status,
    entry: 100,
    sl: 90,
    tp1: 120,
    tp2: 130,
    tp3: 140,
    score: 90,
    rr: 2,
    created_at: new Date(now.getTime() - 60_000).toISOString(),
    ...overrides,
  };
}

test('WATCHING entry hit advances only to READY in that evaluation', () => {
  const result = applyLifecycle(
    makeSignal(SIGNAL_STATUS.WATCHING),
    101,
    1,
    now,
    { high: 101, low: 100 },
    { ok: true },
    { scanSessionStart: now.getTime() }
  );

  assert.equal(result.nextStatus, SIGNAL_STATUS.READY);
  assert.equal(result.updates.status, SIGNAL_STATUS.READY);
  assert.equal(result.updates.entry_hit_price, undefined);
  assert.deepEqual(result.events.map((event) => event.event_type), ['READY']);
  assert.equal(result.notifications.some((item) => item.type === 'ENTRY_HIT'), false);
});

test('a later READY evaluation records the entry hit and advances to ONGOING', () => {
  const result = applyLifecycle(
    makeSignal(SIGNAL_STATUS.READY, {
      ready_at: new Date(now.getTime() - 1000).toISOString(),
    }),
    101,
    1,
    now,
    { high: 101, low: 100 },
    { ok: true },
    { scanSessionStart: now.getTime() }
  );

  assert.equal(result.nextStatus, SIGNAL_STATUS.ONGOING);
  assert.equal(result.updates.status, SIGNAL_STATUS.ONGOING);
  assert.equal(result.events.filter((event) => event.event_type === 'ENTRY_HIT').length, 1);
});

test('failed entry quality blocks entry on the later READY evaluation', () => {
  const ready = applyLifecycle(
    makeSignal(SIGNAL_STATUS.WATCHING),
    101,
    1,
    now,
    { high: 101, low: 100 },
    { ok: false, reason: 'Setup quality fell below threshold' }
  );

  assert.equal(ready.nextStatus, SIGNAL_STATUS.READY);
  assert.equal(ready.events.some((event) => event.event_type === 'ENTRY_HIT'), false);

  const result = applyLifecycle(
    makeSignal(SIGNAL_STATUS.READY, {
      ...ready.updates,
      ready_at: now.toISOString(),
    }),
    101,
    1,
    new Date(now.getTime() + 1000),
    { high: 101, low: 100 },
    { ok: false, reason: 'Setup quality fell below threshold' }
  );

  assert.equal(result.nextStatus, SIGNAL_STATUS.INVALIDATED);
  assert.equal(result.updates.status, SIGNAL_STATUS.INVALIDATED);
  assert.equal(result.events.some((event) => event.event_type === 'ENTRY_HIT'), false);
});

test('ONGOING price updates recalculate PnL without creating another entry event', () => {
  const result = applyLifecycle(
    makeSignal(SIGNAL_STATUS.ONGOING, {
      entry_hit_price: 100,
      entry_hit_at: new Date(now.getTime() - 30_000).toISOString(),
    }),
    110,
    1,
    now,
    { high: 110, low: 109 },
    null
  );

  assert.equal(result.nextStatus, SIGNAL_STATUS.ONGOING);
  assert.equal(result.updates.status, undefined);
  assert.ok(result.updates.current_pnl_percent > 0);
  assert.equal(result.events.some((event) => event.event_type === 'ENTRY_HIT'), false);
  assert.equal(result.notifications.some((item) => item.type === 'ENTRY_HIT'), false);
});