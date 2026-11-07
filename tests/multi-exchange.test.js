import test from 'node:test';
import assert from 'node:assert/strict';

// ---- fake exchanges -------------------------------------------------------
const calls = { bybit: 0, binance: 0 };
function candles(n, step) {
  const out = []; const now = Date.now(); let p = 100;
  for (let i = n - 1; i >= 0; i--) {
    const t = now - i * step * 1000; p += Math.sin(i / 3) * 0.4;
    out.push([t, p, p + 0.5, p - 0.5, p + 0.1, 1000 + i]);
  }
  return out;
}
globalThis.fetch = async (url) => {
  url = String(url);
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (url.includes('bybit.com')) {
    calls.bybit++;
    if (url.includes('instruments-info')) return ok({ retCode: 0, result: { list: ['BTCUSDT','ETHUSDT'].map((s) => ({ symbol: s, status: 'Trading', quoteCoin: 'USDT', contractType: 'LinearPerpetual' })) } });
    if (url.includes('/tickers')) return ok({ retCode: 0, result: { list: ['BTCUSDT','ETHUSDT'].map((s, i) => ({ symbol: s, lastPrice: '100', markPrice: '100', price24hPcnt: '0.01', turnover24h: String(1e9 - i), highPrice24h: '110', lowPrice24h: '90' })) } });
    if (url.includes('/kline')) return ok({ retCode: 0, result: { list: candles(130, 900).map((c) => c.map(String)).reverse() } });
  }
  if (url.includes('binance') || url.includes('fapi')) {
    calls.binance++;
    if (url.includes('exchangeInfo')) return ok({ symbols: ['SOLUSDT','XRPUSDT','DOGEUSDT'].map((s) => ({ symbol: s, contractType: 'PERPETUAL', quoteAsset: 'USDT', status: 'TRADING' })) });
    if (url.includes('ticker/24hr')) return ok(['SOLUSDT','XRPUSDT','DOGEUSDT'].map((s, i) => ({ symbol: s, lastPrice: '100', priceChangePercent: '1', quoteVolume: String(1e9 - i), highPrice: '110', lowPrice: '90' })));
    if (url.includes('premiumIndex')) return ok([]);
    if (url.includes('klines')) return ok(candles(130, 900));
  }
  throw new Error('unmocked ' + url);
};


test('multi-exchange scanner + per-user connections', async () => {
  const { runFullScan } = await import('../lib/scanner/scanner.js');
  const { setState, getState } = await import('../lib/database/appState.js');
  const { upsertSignal, getActiveSignals } = await import('../lib/database/signals.js');
  const { runWithExchange, withExchangeId, signalExchange } = await import('../lib/exchange/context.js');
  const { getScanExchanges } = await import('../lib/exchange/index.js');
  const { buildSignalId } = await import('../lib/signals/signalId.js');

  // ids: bybit legacy, binance prefixed
  assert.equal(buildSignalId('BTCUSDT','LONG','x',100), buildSignalId('BTCUSDT','LONG','x',100,'bybit'));
  assert.match(buildSignalId('BTCUSDT','LONG','x',100,'binance'), /^bin_BTCUSDT_LONG/);
  assert.equal(withExchangeId('bin_A','binance'), 'bin_A');

  // rows get stamped from context; legacy rows (no exchange) count as bybit
  const base = (o) => ({ signal_id: 'S1', symbol: 'BTCUSDT', direction: 'LONG', status: 'WATCHING', entry: 100, sl: 95, tp1: 110, score: 80, metadata: {}, ...o });
  await runWithExchange('binance', () => upsertSignal(base({ signal_id: 'bin_S1', symbol: 'SOLUSDT' })));
  await upsertSignal(base({ signal_id: 'S2', symbol: 'ETHUSDT' }));
  const act = await getActiveSignals();
  assert.equal(act.find((s) => s.signal_id === 'bin_S1').exchange, 'binance');
  assert.equal(signalExchange(act.find((s) => s.signal_id === 'S2')), 'bybit');

  // Missing/invalid scan_exchanges is Binance-only, then admins can re-enable Bybit.
  assert.deepEqual(await getScanExchanges(), ['binance']);
  calls.bybit = 0; calls.binance = 0;
  const defaultScan = await runFullScan('cron', {});
  assert.deepEqual(Object.keys(defaultScan.byExchange), ['binance']);
  assert.equal(calls.bybit, 0);
  assert.ok(calls.binance > 0);

  // full multi-exchange scan: both exchanges run, isolated, with their own coins/cursors
  await setState('scan_exchanges', ['binance', 'bybit']);
  const r = await runFullScan('cron-full', { mode: 'full', fullScan: true, budgetMs: 30000, lockWaitMs: 500 });
  console.log('byExchange', JSON.stringify(r.byExchange));
  assert.equal(r.ok, true);
  assert.ok(r.byExchange.bybit.ok && r.byExchange.binance.ok, 'both passes ran');
  assert.equal(r.byExchange.bybit.total, 2); assert.equal(r.byExchange.binance.total, 3);
  assert.ok(calls.bybit > 0 && calls.binance > 0);
  assert.ok(await getState('scan_cursor:bybit') && await getState('scan_cursor:binance'), 'separate cursors');

  // only one exchange when asked (user's Scan Now)
  calls.bybit = 0; calls.binance = 0;
  const r2 = await runFullScan('manual', { exchange: 'binance' });
  assert.equal(calls.bybit, 0); assert.ok(calls.binance > 0);
  assert.deepEqual(Object.keys(r2.byExchange), ['binance']);

  // admin can restrict scanned exchanges
  await setState('scan_exchanges', ['bybit']);
  calls.bybit = 0; calls.binance = 0;
  await runFullScan('cron', {});
  assert.equal(calls.binance, 0); assert.ok(calls.bybit > 0);
  calls.bybit = 0; calls.binance = 0;
  const disabledBybitManual = await runFullScan('manual', { exchange: 'binance' });
  assert.equal(disabledBybitManual.skipped, true);
  assert.equal(calls.bybit, 0); assert.equal(calls.binance, 0);
  await setState('scan_exchanges', []);
  assert.deepEqual(await getScanExchanges(), ['binance']);
  await setState('scan_exchanges', ['unknown']);
  assert.deepEqual(await getScanExchanges(), ['binance']);
  console.log('ok: multi-exchange scanner');

  // ---- users: connections, selection ----------------------------------------
  const U = await import('../lib/database/users.js');
  await U.saveExchangeKeys('u1', 'bybit', { apiKey: 'AAAAAAAAAAAA', apiSecret: 'sec1', mode: 'mock' });
  await U.saveExchangeKeys('u1', 'binance', { apiKey: 'BBBBBBBBBBBB', apiSecret: 'sec2', mode: 'live' });
  const list = await U.listExchangeConnections('u1');
  assert.equal(list.length, 2);
  assert.equal(list.find((c) => c.exchange === 'binance').mode, 'live');
  assert.ok(!JSON.stringify(list).includes('sec'), 'no secrets in list');
  const k = await U.getExchangeKeys('u1', 'binance');
  assert.equal(k.apiSecret, 'sec2'); assert.equal(k.mode, 'live');
  await U.deleteExchangeKeys('u1', 'bybit');
  assert.equal((await U.listExchangeConnections('u1')).length, 1);
  const st = await U.getUserTradingSettings('u1');
  assert.equal(st.autoTradeExchange, null); assert.equal(st.selectedExchange, 'bybit');
  console.log('ok: user connections');
});
