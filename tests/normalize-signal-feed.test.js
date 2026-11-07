import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSignalsPayload } from '../lib/signals/normalizePayload.js';

test('signal feed combines active signals with terminal history', () => {
  const rows = normalizeSignalsPayload({
    ongoing: [{ signal_id: 'ongoing-1', status: 'ONGOING' }],
    ready: [{ signal_id: 'ready-1', status: 'READY' }],
    watching: [],
    history: [{ signal_id: 'stopped-1', status: 'STOPPED' }],
  });

  assert.deepEqual(rows.map((signal) => signal.signal_id), [
    'ongoing-1',
    'ready-1',
    'stopped-1',
  ]);
});

test('signal feed removes a signal duplicated between active and history', () => {
  const stopped = { signal_id: 'same-id', status: 'STOPPED' };
  const rows = normalizeSignalsPayload({
    signals: [stopped],
    history: [{ ...stopped }],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'STOPPED');
});