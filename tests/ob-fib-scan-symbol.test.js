import test from 'node:test';
import assert from 'node:assert/strict';
import { scanObFibSymbol, scanObFibCore, pickTfs } from '../lib/scanner/strategy/obFib/scanSymbol.js';
import { barEndSec, aggregateFromMonthly } from '../lib/binance/client.js';

const NOW = Math.floor(Date.UTC(2026, 9, 30, 12) / 1000); // 30 Oct 2026

function monthStart(y, m) {
  return Math.floor(Date.UTC(y, m, 1) / 1000);
}
function ltfSeries(n = 400, step = 900) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const close = 100 + Math.sin(i / 9) * 4.8 + i * 0.01;
    out.push({
      time: NOW - (n - i) * step,
      open: p,
      close,
      high: Math.max(p, close) + 0.4,
      low: Math.min(p, close) - 0.4,
      volume: 100 + ((i * 37) % 23) * 10 + (i % 11 === 0 ? 400 : 0),
    });
    p = close;
  }
  return out;
}

function fakeKlines(calls) {
  return async (symbol, tf, limit) => {
    calls.push(`${tf}`);
    if (tf === '1m') return [{ time: NOW - 60, open: 100, high: 100, low: 100, close: 100, volume: 1 }];
    if (['1d', '1w', '1M', '3M', '1Y'].includes(tf)) {
      // realistic: the newest candle in the list is the last CLOSED one (+ nothing forming)
      const starts = {
        '1d': [NOW - 3 * 86400, NOW - 1.5 * 86400],
        '1w': [NOW - 17 * 86400, NOW - 10 * 86400],
        '1M': [monthStart(2026, 7), monthStart(2026, 8)],
        '3M': [monthStart(2026, 1), monthStart(2026, 4)],
        '1Y': [monthStart(2024, 0), monthStart(2025, 0)],
      }[tf];
      return [
        { time: starts[0], open: 90, close: 120, high: 125, low: 85, volume: 1 },
        { time: starts[1], open: 120, close: 95, high: 130, low: 90, volume: 1 },
      ];
    }
    return ltfSeries(400);
  };
}

test('pickTfs keeps only valid timeframes in canonical order, falls back when empty', () => {
  assert.deepEqual(pickTfs(['1Y', 'bad', '1w'], ['1d', '1w', '1M', '3M', '1Y'], ['1w']), ['1w', '1Y']);
  assert.deepEqual(pickTfs(['x'], ['1w'], ['1w']), ['1w']);
  assert.deepEqual(pickTfs(undefined, ['1w'], ['1w']), ['1w']);
});

test('scan reports every HTF x LTF pair separately and downloads each LTF once', async () => {
  const calls = [];
  const r = await scanObFibSymbol({
    symbol: 'LTCUSDT',
    getKlines: fakeKlines(calls),
    config: { refTimeframes: ['1w'], timeframes: ['15m'] },
    refTimeframes: ['1M', '3M', '1Y'],
    timeframes: ['15m', '1h'],
    nowSec: NOW,
  });
  assert.deepEqual(r.refTimeframes, ['1M', '3M', '1Y']);
  assert.equal(r.groups.length, 3);
  for (const g of r.groups) {
    assert.ok(g.fib, `${g.refTf} has fib`);
    assert.deepEqual(g.ltf.map((x) => x.tf), ['15m', '1h']);
    assert.ok(g.ltf.every((x) => x.checked));
  }
  // each LTF fetched once even though 3 HTFs use it
  assert.equal(calls.filter((c) => c === '15m').length, 1);
  assert.equal(calls.filter((c) => c === '1h').length, 1);
  // every signal is tagged with its own HTF/LTF and has a timestamp
  for (const s of r.signals) {
    assert.ok(['1M', '3M', '1Y'].includes(s.refTf));
    assert.ok(['15m', '1h'].includes(s.ltf));
    assert.ok(s.obTimeIso);
    assert.equal(s.metadata.obFib.refTf, s.refTf);
  }
});

test('monthly / quarterly / yearly bar ends are calendar aware', () => {
  assert.equal(barEndSec(monthStart(2026, 0), '1M'), monthStart(2026, 1)); // 31-day month
  assert.equal(barEndSec(monthStart(2026, 1), '1M'), monthStart(2026, 2)); // 28-day month
  assert.equal(barEndSec(monthStart(2026, 6), '3M'), monthStart(2026, 9));
  assert.equal(barEndSec(monthStart(2026, 0), '1Y'), monthStart(2027, 0));
});

test('3M and 1Y aggregation builds correct OHLC from monthly candles', () => {
  const m = [];
  for (let i = 0; i < 12; i++) m.push({ time: monthStart(2025, i), open: 100 + i, close: 101 + i, high: 110 + i, low: 90 - i, volume: 1 });
  const q = aggregateFromMonthly(m, 3);
  assert.equal(q.length, 4);
  assert.equal(q[0].open, 100);
  assert.equal(q[0].close, 103);
  assert.equal(q[0].high, 112);
  assert.equal(q[0].low, 88);
  const y = aggregateFromMonthly(m, 12);
  assert.equal(y.length, 1);
  assert.equal(y[0].open, 100);
  assert.equal(y[0].close, 112);
  assert.equal(y[0].high, 121);
  assert.equal(y[0].low, 79);
});

import { createRefCache } from '../lib/scanner/strategy/obFib/refCache.js';
import { cleanFibLevels } from '../lib/scanner/strategy/obFib/scanSymbol.js';

test('fib-line filter: only the chosen ratios are used', async () => {
  const calls = [];
  const r = await scanObFibSymbol({
    symbol: 'LTCUSDT',
    getKlines: fakeKlines(calls),
    config: { refTimeframes: ['1M'], timeframes: ['15m'] },
    fibLevels: [0.618],
    nowSec: NOW,
  });
  const sel = r.groups[0].fib.levels.filter((l) => l.selected).map((l) => l.ratio);
  assert.deepEqual(sel, [0.618]);
  for (const s of r.signals) assert.equal(s.metadata.obFib.hitRatio, 0.618);
  assert.deepEqual(cleanFibLevels(['x', 99, 0.5, 0.5, '0.786']), [0.5, 0.786]);
  assert.equal(cleanFibLevels([]), null);
});

test('HTF cache: second scan downloads no Fib candles; LTF pruning skips far-away timeframes', async () => {
  const cache = createRefCache(null);
  const calls1 = [];
  await scanObFibCore({ symbol: 'LTCUSDT', price: 100, getKlines: fakeKlines(calls1), config: { refTimeframes: ['1M', '1Y'], timeframes: ['15m'] }, refCache: cache, nowSec: NOW });
  assert.ok(calls1.includes('1M') && calls1.includes('1Y'));
  assert.ok(cache.dirty);

  const persisted = JSON.parse(JSON.stringify(cache.toJSON(NOW, ['LTCUSDT']))); // survives a DB round-trip
  const calls2 = [];
  const r2 = await scanObFibCore({ symbol: 'LTCUSDT', price: 100, getKlines: fakeKlines(calls2), config: { refTimeframes: ['1M', '1Y'], timeframes: ['15m'] }, refCache: createRefCache(persisted), nowSec: NOW });
  assert.ok(!calls2.includes('1M') && !calls2.includes('1Y'), 'fib candles come from cache');
  assert.ok(r2.groups.every((g) => g.fib));

  // cache entry expires once the next HTF candle has closed
  const later = NOW + 40 * 86400;
  assert.equal(createRefCache(persisted).get('LTCUSDT', '1M', 1, later), null);

  // pruning: tiny ATR + fib lines far from price → LTF is not even downloaded
  const calls3 = [];
  const r3 = await scanObFibCore({ symbol: 'LTCUSDT', price: 100000, getKlines: fakeKlines(calls3), config: { refTimeframes: ['1M'], timeframes: ['15m', '1h'] }, atr5m: 0.01, pruneLtf: true, nowSec: NOW });
  assert.ok(!calls3.includes('15m') && !calls3.includes('1h'));
  assert.deepEqual(r3.skippedLtf.sort(), ['15m', '1h']);
});
