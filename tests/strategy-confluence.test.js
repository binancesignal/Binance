import test from 'node:test';
import assert from 'node:assert/strict';
import { requireIctPatternConfluence } from '../lib/scanner/strategyConfluence.js';

test('strict confluence keeps only ICT setups confirmed by a same-direction breakout', () => {
  const ictLong = {
    strategy: 'ict_smc',
    symbol: 'BTCUSDT',
    dir: 'LONG',
    score: 88,
    entry: 100,
    sl: 95,
    tp1: 107.5,
    conf: ['ICT sweep and BOS'],
  };
  const ictShort = { strategy: 'ict_smc', symbol: 'BTCUSDT', dir: 'SHORT', entry: 100 };
  const chartLong = {
    strategy: 'chart_pattern',
    symbol: 'BTCUSDT',
    dir: 'LONG',
    pattern: 'ASCENDING_TRIANGLE',
    score: 81,
    metadata: { breakoutConfirmed: true, patternTf: '15m', breakoutLevel: 101 },
  };
  const chartShortNotConfirmed = {
    strategy: 'chart_pattern',
    symbol: 'BTCUSDT',
    dir: 'SHORT',
    metadata: { breakoutConfirmed: false },
  };

  const results = requireIctPatternConfluence([
    ictLong,
    ictShort,
    chartLong,
    chartShortNotConfirmed,
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].dir, 'LONG');
  assert.equal(results[0].entry, 100);
  assert.equal(results[0].sl, 95);
  assert.equal(results[0].quality.chartPatternConfirmed, true);
  assert.deepEqual(results[0].metadata.chartPatternConfirmation, {
    pattern: 'ASCENDING_TRIANGLE',
    timeframe: '15m',
    direction: 'LONG',
    score: 81,
    breakoutLevel: 101,
  });
  assert.match(results[0].conf.at(-1), /confirms LONG/);
});

test('strict confluence rejects ICT setups with only opposite-direction or unconfirmed patterns', () => {
  const results = requireIctPatternConfluence([
    { strategy: 'ict_smc', symbol: 'BTCUSDT', dir: 'LONG' },
    { strategy: 'chart_pattern', symbol: 'BTCUSDT', dir: 'SHORT', quality: { breakoutConfirmed: true } },
    { strategy: 'chart_pattern', symbol: 'BTCUSDT', dir: 'LONG', metadata: { breakoutConfirmed: false } },
    { strategy: 'chart_pattern', symbol: 'ETHUSDT', dir: 'LONG', quality: { breakoutConfirmed: true } },
  ]);

  assert.deepEqual(results, []);
});