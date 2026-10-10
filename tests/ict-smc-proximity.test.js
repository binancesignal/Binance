import test from 'node:test';
import assert from 'node:assert/strict';
import { SIGNAL_CONFIG } from '../lib/config/signalConfig.js';
import { getEntryProximity } from '../lib/signals/proximity.js';
import { applyLifecycle } from '../lib/signals/signalLifecycle.js';

const shortSignal = {
  signal_id: 'BTCUSDT_SHORT_ICT_15m_test',
  symbol: 'BTCUSDT',
  direction: 'SHORT',
  status: 'READY',
  entry: 100,
  sl: 105,
  tp1: 95,
  tp2: 90,
  tp3: 85,
  ob_low: 99,
  ob_high: 101,
  created_at: new Date().toISOString(),
  metadata: { strategy: 'ict_smc' },
};

test('ICT bearish limit entry waits below the POI and fills on an upward retrace', () => {
  const tol = SIGNAL_CONFIG.entryToleranceATR;
  assert.equal(getEntryProximity(shortSignal, 100 - tol * 3, 1).entryHit, false);
  assert.equal(getEntryProximity(shortSignal, 100 + tol / 2, 1).entryHit, true);
  assert.equal(
    getEntryProximity(shortSignal, 99, 1, { high: 100 + tol / 2, low: 98.8 }).entryHit,
    true
  );
});

test('ICT short lifecycle changes READY to ONGOING only after the POI entry is reached', () => {
  const waiting = applyLifecycle(shortSignal, 99, 1, new Date());
  assert.equal(waiting.nextStatus, 'READY');
  const reached = applyLifecycle(shortSignal, 100 + SIGNAL_CONFIG.entryToleranceATR / 2, 1, new Date());
  assert.equal(reached.nextStatus, 'ONGOING');
  assert.equal(reached.events[0].event_type, 'ENTRY_HIT');
});