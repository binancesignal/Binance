import test from 'node:test';
import assert from 'node:assert/strict';
import { rebaseSignalToExchangePrice, rebaseSignalToTestnet } from '../lib/trading/rebase.js';

const signal = {
  signal_id: 'rebase-test',
  current_price: 100,
  entry: 98,
  entry_hit_price: 99,
  sl: 95,
  tp1: 105,
  tp2: 108,
  tp3: 112,
};

test('rebasing preserves mainnet levels and scales testnet prices by one ratio', () => {
  const result = rebaseSignalToTestnet(signal, 102);

  assert.equal(result.ok, true);
  assert.equal(result.rebased, true);
  assert.equal(result.ratio, 1.02);
  assert.equal(result.signal.entry, 98 * 1.02);
  assert.equal(result.signal.sl, 95 * 1.02);
  assert.equal(result.signal.tp1, 105 * 1.02);
  assert.equal(result.signal.metadata.mainnetLevels.entry, 98);
  assert.equal(result.signal.metadata.testnetLevels.tp1, 105 * 1.02);
});

test('a small price difference keeps the levels unchanged but records both price sets', () => {
  const result = rebaseSignalToTestnet(signal, 100.01);

  assert.equal(result.ok, true);
  assert.equal(result.rebased, false);
  assert.equal(result.signal.entry, signal.entry);
  assert.equal(result.signal.metadata.mainnetLevels.entry, signal.entry);
  assert.equal(result.signal.metadata.testnetLevels.entry, signal.entry);
  assert.equal(result.signal.metadata.testnetRebaseRatio, 1);
});

test('large mainnet/testnet divergence still rebases (no longer blocks)', () => {
  // Testnet price far from mainnet (e.g. broken altcoin book) — still rebase so the
  // full order → protect flow can be tested on Bybit TESTNET.
  const tn = 50;
  const result = rebaseSignalToTestnet(signal, tn);

  assert.equal(result.ok, true);
  assert.equal(result.rebased, true);
  assert.equal(result.ratio, tn / 100);
  assert.equal(result.signal.entry, 98 * (tn / 100));
  assert.equal(result.signal.sl, 95 * (tn / 100));
  assert.ok(result.signal.metadata.testnetDivergencePct > 10);
});

test('missing testnet price still fails closed', () => {
  const result = rebaseSignalToTestnet(signal, 0);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unavailable/i);
});

test('generic exchange rebase records exchange price levels without changing testnet compatibility', () => {
  const result = rebaseSignalToExchangePrice(signal, 125, 'binanceMock');

  assert.equal(result.ok, true);
  assert.equal(result.ratio, 1.25);
  assert.equal(result.signal.tp1, signal.tp1 * 1.25);
  assert.equal(result.signal.metadata.mainnetLevels.entry, signal.entry);
  assert.equal(result.signal.metadata.exchangeLevels.tp1, signal.tp1 * 1.25);
  assert.equal(result.signal.metadata.exchangeRebaseRatio, 1.25);
});
