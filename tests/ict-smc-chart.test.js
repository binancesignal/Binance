import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartSvg } from '../lib/telegram/chartSvg.js';

test('ICT annotated chart includes the BOS marker and the sweep → POI analysis', () => {
  const candles = Array.from({ length: 60 }, (_, i) => ({
    time: 1_700_000_000 + i * 900,
    open: 99.8 + (i % 3) * 0.1,
    high: 101 + (i % 4) * 0.15,
    low: 99 + (i % 5) * 0.1,
    close: 100 + (i % 3) * 0.1,
    volume: 100 + i,
  }));
  candles[53] = { ...candles[53], open: 103.5, high: 106, low: 103, close: 105 };
  const signal = {
    symbol: 'BTCUSDT',
    direction: 'LONG',
    score: 86,
    entry: 100,
    sl: 98,
    tp1: 103,
    tp2: 105,
    tp3: 107,
    rr: 1.5,
    current_price: 101,
    ob_low: 99.5,
    ob_high: 100.5,
    metadata: {
      strategy: 'ict_smc',
      patternTf: '15m',
      htf: '1h',
      obTf: '15m',
      ob: { low: 99.5, high: 100.5, type: 'bullish', status: 'FRESH', time: candles[48].time },
      liq: {
        buySide: 105,
        sellSide: 95,
        bullishSweep: true,
        sweepDetail: { side: 'sell', level: 95, sweepLow: 94 },
      },
      ictAnalysis: {
        sweepSide: 'SELL_SIDE',
        sweepLevel: 95,
        sweepExtreme: 94,
        bosLevel: 104,
        bosClose: 105,
        bosTime: candles[52].time,
        poiType: 'OB_FVG_CONFLUENCE',
        poiLow: 99.5,
        poiHigh: 100.5,
        ageBars: 6,
        htfTf: '1h',
        htfBias: 'bullish',
        htfAligned: true,
      },
      fvgs: [{
        low: 100,
        high: 101,
        type: 'bullish',
        status: 'PARTIAL',
        index: 53,
        time: candles[53].time,
      }],
      conf: ['Sell-side liquidity swept', 'Bullish BOS on candle close'],
    },
  };
  const chart = buildChartSvg(signal, candles, { tf: '15m', htf: '1h' });
  assert.ok(chart?.svg);
  assert.match(chart.svg, /BOS .* CLOSE/);
  assert.match(chart.svg, /ICT sequence/);
  assert.match(chart.svg, /OB FVG CONFLUENCE/);
});