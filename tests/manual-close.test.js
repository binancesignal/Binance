import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPositions } from '../lib/trading/positionSelect.js';

const positions = [
  { symbol: 'BTCUSDT', side: 'Buy', size: 0.01 },
  { symbol: 'ETHUSDT', side: 'Sell', size: 0.5 },
  { symbol: 'ETHUSDT', side: 'Buy', size: 0.2 },
];

test('selects one position by symbol and direction', () => {
  const r = selectPositions(positions, { symbol: 'ethusdt', direction: 'short' });
  assert.equal(r.length, 1);
  assert.equal(r[0].size, 0.5);
});

test('symbol without direction matches every side', () => {
  assert.equal(selectPositions(positions, { symbol: 'ETHUSDT' }).length, 2);
});

test('all closes everything, unknown symbol closes nothing', () => {
  assert.equal(selectPositions(positions, { all: true }).length, 3);
  assert.equal(selectPositions(positions, { symbol: 'XRPUSDT' }).length, 0);
});
