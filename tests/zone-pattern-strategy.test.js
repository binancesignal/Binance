import test from 'node:test';
import assert from 'node:assert/strict';
import { runZonePatternStrategy } from '../lib/scanner/strategy/zonePattern/index.js';
import { buildChartSvg } from '../lib/telegram/chartSvg.js';
import {
  ZONE_PATTERN_DEFAULTS,
  normalizeZonePatternConfig,
} from '../lib/scanner/strategy/zonePattern/config.js';

function makeBullishSetup({ breakout = true } = {}) {
  const candles = Array.from({ length: 80 }, (_, i) => ({
    time: i * 900,
    open: 94,
    high: 96,
    low: 92,
    close: 94,
    volume: 100,
  }));
  candles[40] = { ...candles[40], open: 92, high: 94, low: 90, close: 93 };
  candles[47] = { ...candles[47], open: 96, high: 100, low: 95, close: 98 };
  candles[51] = { ...candles[51], open: 92, high: 95, low: 90.2, close: 93 };
  candles[79] = breakout
    ? { ...candles[79], open: 95, high: 102, low: 95, close: 101 }
    : { ...candles[79], open: 94, high: 100.5, low: 93, close: 99 };
  const contextCandles = Array.from({ length: 80 }, (_, i) => ({
    time: i * 14400,
    open: 94,
    high: 96,
    low: 92,
    close: 94,
    volume: 100,
  }));
  const weeklyCandles = [
    { time: 0, open: 96, high: 101, low: 90.4, close: 95 },
    { time: 604800, open: 95, high: 101, low: 90.1, close: 96 },
  ];
  const dailyCandles = [
    { time: 0, open: 96, high: 99, low: 90.3, close: 95 },
    { time: 86400, open: 95, high: 99, low: 90.2, close: 96 },
  ];
  return { candles, contextCandles, weeklyCandles, dailyCandles };
}

function makeBearishSetup() {
  const candles = Array.from({ length: 80 }, (_, i) => ({
    time: i * 900,
    open: 106,
    high: 108,
    low: 104,
    close: 106,
    volume: 100,
  }));
  candles[40] = { ...candles[40], open: 108, high: 110, low: 106, close: 107 };
  candles[47] = { ...candles[47], open: 103, high: 105, low: 100, close: 102 };
  candles[51] = { ...candles[51], open: 108, high: 109.8, low: 105, close: 107 };
  candles[79] = { ...candles[79], open: 105, high: 105, low: 98, close: 99 };
  const contextCandles = Array.from({ length: 80 }, (_, i) => ({
    time: i * 14400,
    open: 106,
    high: 108,
    low: 104,
    close: 106,
    volume: 100,
  }));
  const weeklyCandles = [
    { time: 0, open: 105, high: 110.2, low: 99, close: 106 },
    { time: 604800, open: 106, high: 110.1, low: 99, close: 105 },
  ];
  const dailyCandles = [
    { time: 0, open: 105, high: 110, low: 98.5, close: 106 },
    { time: 86400, open: 106, high: 110.1, low: 98.5, close: 105 },
  ];
  return { candles, contextCandles, weeklyCandles, dailyCandles };
}

test('recommended defaults are an independent, moderate-confluence preset', () => {
  const cfg = normalizeZonePatternConfig(ZONE_PATTERN_DEFAULTS);
  assert.equal(cfg.setupTf, '15m');
  assert.equal(cfg.contextTf, '4h');
  assert.equal(cfg.minZoneSources, 2);
  assert.equal(cfg.minSignalScore, 60);
  assert.equal(cfg.minRR, 1.2);
  assert.equal(cfg.includeFibLevels, true);
});

test('detects a two-touch support pattern only after a closed local BOS', () => {
  const { candles, contextCandles, weeklyCandles, dailyCandles } = makeBullishSetup();
  const results = runZonePatternStrategy({
    symbol: 'TESTUSDT',
    setupCandles: candles,
    contextCandles,
    weeklyCandles,
    dailyCandles,
    price: 101.1,
  });

  assert.equal(results.length, 1);
  const [signal] = results;
  assert.equal(signal.strategy, 'zone_pattern');
  assert.equal(signal.dir, 'LONG');
  assert.equal(signal.pattern, 'DOUBLE_BOTTOM');
  assert.equal(signal.quality.zoneConfluence, true);
  assert.equal(signal.quality.localStructureBreak, true);
  assert.ok(signal.metadata.zone.sourceCount >= 2);
  assert.ok(+signal.rr >= 1.2);
  const chart = buildChartSvg({
    ...signal,
    direction: signal.dir,
    ob_low: signal.ob.low,
    ob_high: signal.ob.high,
    current_price: 101.1,
    metadata: { ...signal.metadata, ob: signal.ob },
  }, candles, { tf: '15m', htf: '4h' });
  assert.match(chart.svg, /PATTERN BOS/);
  assert.match(chart.svg, /T1/);
  assert.match(chart.svg, /3 SOURCES/);
});

test('detects the mirrored resistance reaction and bearish BOS', () => {
  const { candles, contextCandles, weeklyCandles, dailyCandles } = makeBearishSetup();
  const results = runZonePatternStrategy({
    symbol: 'TESTUSDT',
    setupCandles: candles,
    contextCandles,
    weeklyCandles,
    dailyCandles,
    price: 98.9,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].dir, 'SHORT');
  assert.equal(results[0].pattern, 'DOUBLE_TOP');
  assert.equal(results[0].quality.localStructureBreak, true);
});

test('rejects wick-only breaks and breakouts that are already overextended', () => {
  const wickOnly = makeBullishSetup({ breakout: false });
  assert.deepEqual(
    runZonePatternStrategy({
      symbol: 'TESTUSDT',
      setupCandles: wickOnly.candles,
      contextCandles: wickOnly.contextCandles,
      weeklyCandles: wickOnly.weeklyCandles,
      dailyCandles: wickOnly.dailyCandles,
      price: 99.5,
    }),
    []
  );

  const confirmed = makeBullishSetup();
  assert.deepEqual(
    runZonePatternStrategy({
      symbol: 'TESTUSDT',
      setupCandles: confirmed.candles,
      contextCandles: confirmed.contextCandles,
      weeklyCandles: confirmed.weeklyCandles,
      dailyCandles: confirmed.dailyCandles,
      price: 112,
    }),
    []
  );
});

test('keeps prior global filters out of this strategy config', () => {
  const cfg = normalizeZonePatternConfig({
    minEntryDistanceATR: 50,
    requireHtfAligned: true,
    maxGapPercent: 0.01,
  });
  assert.equal(cfg.minEntryDistanceATR, undefined);
  assert.equal(cfg.requireHtfAligned, undefined);
  assert.equal(cfg.maxGapPercent, undefined);
});