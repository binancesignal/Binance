import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProjectedHarmonicSetups } from '../lib/scanner/strategy/harmonic/index.js';
import { normalizeHarmonicConfig } from '../lib/scanner/strategy/harmonic/config.js';
import { applyLifecycle } from '../lib/signals/signalLifecycle.js';
import { getEntryProximity } from '../lib/signals/proximity.js';

function makeCandles(corners, tailBars = 18) {
  const lead = 12;
  const points = corners.map(([i, price]) => [i + lead, price]);
  const path = [];
  const [firstIndex, firstPrice] = points[0];
  const leadDirection = points[1][1] > firstPrice ? 1 : -1;
  for (let i = 0; i < firstIndex; i++) path.push(firstPrice + leadDirection * (firstIndex - i) * 0.3);
  for (let k = 0; k < points.length - 1; k++) {
    const [fromIndex, fromPrice] = points[k];
    const [toIndex, toPrice] = points[k + 1];
    for (let i = fromIndex; i < toIndex; i++) {
      path.push(fromPrice + ((toPrice - fromPrice) * (i - fromIndex)) / (toIndex - fromIndex));
    }
  }
  const last = points[points.length - 1];
  const prior = points[points.length - 2];
  for (let j = 0; j <= tailBars; j++) {
    path.push(last[1] + (prior[1] > last[1] ? 1 : -1) * j * 0.15);
  }
  return path.map((close, i) => ({
    time: 1_700_000_000 + i * 900,
    open: close,
    close,
    high: close + 0.05,
    low: close - 0.05,
    volume: 100,
  }));
}

test('projects a bullish Gartley D from X-A-B-C before price reaches D', () => {
  const candles = makeCandles([[0, 100], [10, 120], [20, 107.64], [30, 117.36]]);
  const setups = detectProjectedHarmonicSetups(candles, 116, {
    enabledFamilies: ['GARTLEY'],
    maxPointAgeBars: 30,
  });
  const gartley = setups.find((setup) => setup.pattern === 'GARTLEY_BULL');
  assert.ok(gartley, JSON.stringify(setups.map((setup) => setup.pattern)));
  assert.equal(gartley.strategy, 'harmonic');
  assert.equal(gartley.direction, 'LONG');
  assert.ok(Math.abs(gartley.entry - 104.28) < 0.5, `projected D=${gartley.entry}`);
  assert.equal(gartley.metadata.harmonic.family, 'GARTLEY');
});

test('projects the mirrored bearish Gartley and rejects a setup after D is reached', () => {
  const candles = makeCandles([[0, 120], [10, 100], [20, 112.36], [30, 102.64]]);
  const beforeD = detectProjectedHarmonicSetups(candles, 107, {
    enabledFamilies: ['GARTLEY'],
    maxPointAgeBars: 30,
  });
  const gartley = beforeD.find((setup) => setup.pattern === 'GARTLEY_BEAR');
  assert.ok(gartley, JSON.stringify(beforeD.map((setup) => setup.pattern)));
  assert.equal(gartley.direction, 'SHORT');
  const afterD = detectProjectedHarmonicSetups(candles, gartley.entry, {
    enabledFamilies: ['GARTLEY'],
    maxPointAgeBars: 30,
  });
  assert.equal(afterD.length, 0);
});

test('does not create a signal after D was touched by the active candle wick', () => {
  const candles = makeCandles([[0, 100], [10, 120], [20, 107.64], [30, 117.36]]);
  const config = { enabledFamilies: ['GARTLEY'], maxPointAgeBars: 30 };
  const setup = detectProjectedHarmonicSetups(candles, 116, config)
    .find((candidate) => candidate.pattern === 'GARTLEY_BULL');
  assert.ok(setup);
  candles[candles.length - 1] = {
    ...candles.at(-1),
    open: 116,
    close: 116,
    high: 116.1,
    low: setup.entry,
  };
  const afterTouch = detectProjectedHarmonicSetups(candles, 116, config);
  assert.equal(afterTouch.some((candidate) => candidate.pattern === 'GARTLEY_BULL'), false);
});

test('family toggles disable matching harmonic setups', () => {
  const config = normalizeHarmonicConfig({ enabledFamilies: ['GARTLEY'], patternTfs: ['1h'] });
  assert.deepEqual(config.enabledFamilies, ['GARTLEY']);
  assert.deepEqual(config.enabledPatterns, ['GARTLEY_BULL', 'GARTLEY_BEAR']);
  assert.deepEqual(config.patternTfs, ['1h']);
  const candles = makeCandles([[0, 100], [10, 120], [20, 107.64], [30, 117.36]]);
  assert.equal(detectProjectedHarmonicSetups(candles, 116, { enabledFamilies: [] }).length, 0);
});

test('bullish and bearish variants can be switched independently', () => {
  const bearishCandles = makeCandles([[0, 120], [10, 100], [20, 112.36], [30, 102.64]]);
  const setups = detectProjectedHarmonicSetups(bearishCandles, 107, {
    enabledPatterns: ['GARTLEY_BULL'],
    maxPointAgeBars: 30,
  });
  assert.equal(setups.some((setup) => setup.pattern === 'GARTLEY_BEAR'), false);
});

test('harmonic proximity advances WATCHING → READY near D', () => {
  const signal = {
    status: 'WATCHING',
    direction: 'LONG',
    entry: 100,
    sl: 98,
    tp1: 106,
    tp2: 108,
    tp3: 110,
    created_at: new Date().toISOString(),
    metadata: {
      strategy: 'harmonic',
      harmonic: { D: { price: 100 }, przLow: 99.85, przHigh: 100.15, readyDistanceATR: 0.5 },
    },
  };
  assert.equal(getEntryProximity(signal, 100.4, 1).isReady, true);
  const ready = applyLifecycle(signal, 100.4, 1, new Date(), null);
  assert.equal(ready.nextStatus, 'READY');
  assert.ok(ready.events.some((event) => event.event_type === 'READY'));
});

test('touching the projected D zone advances harmonic signal to ONGOING', () => {
  const signal = {
    status: 'READY',
    direction: 'LONG',
    entry: 100,
    sl: 98,
    tp1: 106,
    tp2: 108,
    tp3: 110,
    created_at: new Date().toISOString(),
    metadata: {
      strategy: 'harmonic',
      harmonic: { D: { price: 100 }, przLow: 99.85, przHigh: 100.15, readyDistanceATR: 0.5 },
    },
  };
  const ongoing = applyLifecycle(signal, 100, 1, new Date(), { low: 99.95, high: 100.05 });
  assert.equal(ongoing.nextStatus, 'ONGOING');
  assert.equal(ongoing.updates.metadata.harmonicDHit, true);
  assert.ok(ongoing.events.some((event) => event.event_type === 'ENTRY_HIT'));
});
