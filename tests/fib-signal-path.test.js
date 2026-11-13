import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFibSignal } from '../lib/fibSignals/evaluate.js';
import { refineSignalCandles } from '../lib/fibSignals/trackData.js';

const START = Math.floor(Date.now() / 60_000) * 60;

test('runner refinement uses minute candles and trade timestamps to resolve entry and TP/SL order', async () => {
  const signal = {
    symbol: 'BTCUSDT',
    side: 'BUY',
    dir: 'LONG',
    ltf: '15m',
    status: 'ACTIVE',
    entry: 100,
    sl: 98,
    tp1: 102,
    tp2: 104,
    tp3: 106,
    createdAt: new Date((START - 60) * 1000).toISOString(),
    evalFrom: START,
    entryHit: false,
  };
  const source = [{ time: START, open: 101, high: 107, low: 97, close: 100 }];
  const minuteCandles = [
    { time: START, open: 100.2, high: 100.5, low: 99.8, close: 99.9 },
    { time: START + 60, open: 100.1, high: 107, low: 97, close: 99 },
  ];

  const refined = await refineSignalCandles(signal, source, {
    getKlines: async (_symbol, interval, limit, options) => {
      assert.equal(interval, '1m');
      assert.equal(limit, 16);
      assert.equal(options.startTime, START * 1000);
      return minuteCandles;
    },
    getAggTrades: async (_symbol, startTime) => {
      if (startTime === START * 1000) {
        return {
          complete: true,
          trades: [
            { price: 100.2, time: startTime + 100 },
            { price: 99.9, time: startTime + 200 },
          ],
        };
      }
      return {
        complete: true,
        trades: [
          { price: 101, time: startTime + 100 },
          { price: 103, time: startTime + 200 },
          { price: 97, time: startTime + 300 },
        ],
      };
    },
  });

  assert.equal(refined.length, 2);
  assert.equal(refined[0].tradesComplete, true);
  assert.equal(refined[0].trades[1].time, START * 1000 + 200);
  const result = evaluateFibSignal(signal, refined, START + 120);
  assert.equal(result.patch.entryHit, true);
  assert.equal(result.patch.entryTime, START * 1000 + 200);
  assert.equal(result.patch.entryTimeExact, true);
  assert.equal(result.patch.tp1Hit, true);
  assert.equal(result.patch.closeReason, 'SL');
  assert.equal(result.patch.slHit, true);
});
