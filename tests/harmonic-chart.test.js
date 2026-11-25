import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartSvg } from '../lib/telegram/chartSvg.js';

function makeCandles(count = 100) {
  const start = 1_700_000_000;
  return Array.from({ length: count }, (_, i) => {
    const close = 110 + Math.sin(i / 3) * 4;
    return {
      time: start + i * 900,
      open: close,
      close,
      high: Math.max(close + 2, 122),
      low: Math.min(close - 2, 96),
      volume: 100,
    };
  });
}

test('harmonic chart draws timestamped XABCD markers, connected legs, and projected PRZ', () => {
  const candles = makeCandles();
  const point = (index, price) => ({ time: candles[index].time, price });
  const signal = {
    symbol: 'BTCUSDT',
    direction: 'LONG',
    status: 'READY',
    entry: 104,
    sl: 100,
    tp1: 115,
    tp2: 120,
    tp3: 124,
    strategy: 'harmonic',
    metadata: {
      strategy: 'harmonic',
      pattern: 'GARTLEY_BULL',
      harmonic: {
        family: 'GARTLEY',
        direction: 'LONG',
        X: point(30, 100),
        A: point(40, 120),
        B: point(50, 107),
        C: point(60, 116),
        D: { price: 104, time: null },
        przLow: 103.5,
        przHigh: 104.5,
        anchors: [
          { i: 30, time: candles[30].time, price: 100, label: 'X' },
          { i: 40, time: candles[40].time, price: 120, label: 'A' },
          { i: 50, time: candles[50].time, price: 107, label: 'B' },
          { i: 60, time: candles[60].time, price: 116, label: 'C' },
          { i: null, time: null, price: 104, label: 'D (projected)' },
        ],
      },
    },
  };

  const result = buildChartSvg(signal, candles, { tf: '15m', visible: 90 });
  assert.ok(result?.svg, 'chart SVG should render');
  for (const label of ['X', 'A', 'B', 'C', 'D']) {
    assert.match(result.svg, new RegExp(`data-harmonic-point="${label}"`));
  }
  for (const leg of ['X-A', 'A-B', 'B-C', 'C-D']) {
    assert.match(result.svg, new RegExp(`data-harmonic-leg="${leg}"`));
  }
  assert.match(result.svg, /D \/ PRZ/);
  assert.match(result.svg, /stroke-dasharray="7 5"/, 'unformed C-D projection should be dashed');
});

test('harmonic chart locates a completed D touch on the chart candles', () => {
  const candles = makeCandles();
  candles[85] = { ...candles[85], high: 105, low: 103 };
  const timePoint = (index, price) => ({ time: candles[index].time, price });
  const signal = {
    symbol: 'BTCUSDT',
    direction: 'LONG',
    status: 'ONGOING',
    entry: 104,
    sl: 100,
    tp1: 115,
    strategy: 'harmonic',
    metadata: {
      strategy: 'harmonic',
      harmonic: {
        family: 'GARTLEY',
        X: timePoint(30, 100),
        A: timePoint(40, 120),
        B: timePoint(50, 107),
        C: timePoint(60, 116),
        D: { price: 104, time: null },
        przLow: 103.5,
        przHigh: 104.5,
        anchors: ['X', 'A', 'B', 'C'].map((label, index) => ({
          i: [30, 40, 50, 60][index],
          time: candles[[30, 40, 50, 60][index]].time,
          price: signalPrice(label),
          label,
        })),
      },
    },
  };

  const result = buildChartSvg(signal, candles, { tf: '15m', visible: 90 });
  assert.ok(result?.svg);
  assert.match(result.svg, />D HIT<\/text>/);
});

function signalPrice(label) {
  return ({ X: 100, A: 120, B: 107, C: 116 })[label];
}
