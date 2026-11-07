import test from 'node:test';
import assert from 'node:assert/strict';
import { runIctSmcStrategy } from '../lib/scanner/strategy/ictSmc/index.js';

function makeCandles() {
  const candles = Array.from({ length: 42 }, (_, i) => ({
    time: 1_700_000_000 + i * 900,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
    closed: true,
  }));

  // Confirmed swing low, followed by a sell-side liquidity raid/reclaim.
  candles[20] = { ...candles[20], open: 98, high: 100, low: 95, close: 98.5 };
  candles[27] = { ...candles[27], open: 96, high: 98, low: 94, close: 96 };

  // A post-sweep swing high, then a strong close above it (BOS).
  candles[30] = { ...candles[30], open: 100, high: 103, low: 99, close: 101 };
  candles[31] = { ...candles[31], open: 99, high: 99.5, low: 98.5, close: 99.2 };
  // Last opposing candle before the displacement becomes the bullish OB.
  candles[32] = { ...candles[32], open: 100, high: 100, low: 99, close: 99.5 };
  candles[33] = { ...candles[33], open: 100.5, high: 104.5, low: 100.5, close: 104 };
  // A partially mitigated FVG overlaps the OB; price has not hit TP1.
  for (let i = 34; i < candles.length; i++) {
    candles[i] = { ...candles[i], open: 100.2, high: 101, low: 100, close: 100.4 };
  }
  return candles;
}

function makeBearishCandles() {
  const candles = Array.from({ length: 42 }, (_, i) => ({
    time: 1_700_000_000 + i * 900,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
    closed: true,
  }));
  candles[20] = { ...candles[20], open: 102, high: 105, low: 100, close: 104 };
  candles[27] = { ...candles[27], open: 104, high: 106, low: 103, close: 104.8 };
  candles[30] = { ...candles[30], open: 100, high: 101, low: 97, close: 99 };
  candles[31] = { ...candles[31], open: 101, high: 102, low: 100, close: 101.5 };
  candles[32] = { ...candles[32], open: 99.5, high: 101, low: 99, close: 100 };
  candles[33] = { ...candles[33], open: 100, high: 100, low: 96, close: 96.5 };
  for (let i = 34; i < candles.length; i++) {
    candles[i] = { ...candles[i], open: 100.4, high: 101, low: 100, close: 100.6 };
  }
  return candles;
}

test('ICT SMC requires sweep → displacement BOS close → fresh POI', () => {
  const candles = makeCandles();
  const setups = runIctSmcStrategy({
    symbol: 'BTCUSDT',
    setupCandles: candles,
    htfCandles: candles,
    price: 100.4,
    setupTf: '15m',
    htfTf: '1h',
  });

  const setup = setups.find((item) => item.dir === 'LONG');
  assert.ok(setup, 'expected a bullish ICT setup');
  assert.equal(setup.strategy, 'ict_smc');
  assert.equal(setup.quality.ictSequence, true);
  assert.equal(setup.metadata.ictAnalysis.sweepSide, 'SELL_SIDE');
  assert.ok(setup.metadata.ictAnalysis.bosLevel < setup.metadata.ictAnalysis.bosClose);
  assert.ok(setup.metadata.ictAnalysis.poiHigh > setup.metadata.ictAnalysis.poiLow);
  assert.ok(setup.sl < setup.entry && setup.entry < setup.tp1);
});

test('ICT SMC does not emit a candidate without a liquidity sweep', () => {
  const candles = makeCandles();
  candles[27] = { ...candles[27], open: 99, high: 100, low: 98.5, close: 99.5 };
  const setups = runIctSmcStrategy({
    symbol: 'BTCUSDT',
    setupCandles: candles,
    htfCandles: candles,
    price: 100.4,
  });
  assert.deepEqual(setups, []);
});

test('ICT SMC recognizes the mirrored buy-side sweep and bearish BOS', () => {
  const candles = makeBearishCandles();
  const setups = runIctSmcStrategy({
    symbol: 'BTCUSDT',
    setupCandles: candles,
    htfCandles: candles,
    price: 99.8,
  });
  const setup = setups.find((item) => item.dir === 'SHORT');
  assert.ok(setup, 'expected a bearish ICT setup');
  assert.equal(setup.metadata.ictAnalysis.sweepSide, 'BUY_SIDE');
  assert.ok(setup.metadata.ictAnalysis.bosLevel > setup.metadata.ictAnalysis.bosClose);
  assert.ok(setup.sl > setup.entry && setup.entry > setup.tp1);
});

test('an intrabar wick beyond the BOS level is not a confirmed break', () => {
  const candles = makeCandles();
  candles[33] = { ...candles[33], close: 102.8 };
  const setups = runIctSmcStrategy({
    symbol: 'BTCUSDT',
    setupCandles: candles,
    htfCandles: candles,
    price: 100.4,
  });
  assert.deepEqual(setups, []);
});