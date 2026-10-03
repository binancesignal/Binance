import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecution } from '../lib/database/executions.js';

test('an active signal execution cannot be claimed twice in the memory store', async () => {
  const record = {
    signal_id: 'idempotency-test-eth-long',
    symbol: 'ETHUSDT',
    side: 'LONG',
    status: 'PENDING',
    dry_run: false,
  };

  await createExecution(record);

  await assert.rejects(
    createExecution(record),
    (error) => error.code === 'DUPLICATE_EXECUTION'
  );
});

test('a rejected exchange attempt does not permanently block a corrected retry', async () => {
  const record = {
    signal_id: 'idempotency-test-rejected-retry',
    symbol: 'ETHUSDT',
    side: 'LONG',
    status: 'REJECTED',
    dry_run: false,
  };

  await createExecution(record);

  const retry = await createExecution({ ...record, status: 'PENDING' });
  assert.equal(retry.status, 'PENDING');
});