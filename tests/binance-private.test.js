import test from 'node:test';
import assert from 'node:assert/strict';
import * as binance from '../lib/binance/private.js';

test('Binance private APIs keep mock and live requests on their configured hosts', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || 'GET' });
    const data = String(url).includes('premiumIndex')
      ? { markPrice: '123.45' }
      : { algoId: requests.length, orderId: requests.length };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(data),
      json: async () => data,
    };
  };

  try {
    await binance.signedPost('/fapi/v1/order', {
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: '0.01',
    }, 'test-key', 'test-secret', 'mock');
    await binance.getMarkPrice('BTCUSDT', 'mock');
    const stops = await binance.setStopLossTakeProfit({
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      stopLoss: 100,
      takeProfit: 150,
    }, 'test-key', 'test-secret', 'mock');
    await binance.signedPost('/fapi/v1/order', {
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: '0.01',
    }, 'live-key', 'live-secret', 'live');

    assert.equal(binance.baseUrlForMode('mock'), 'https://testnet.binancefuture.com');
    assert.equal(binance.baseUrlForMode('live'), 'https://fapi.binance.com');
    assert.equal(stops.errors.length, 0);
    assert.equal(requests.filter((item) => item.url.includes('testnet.binancefuture.com')).length, 4);
    assert.equal(requests.filter((item) => item.url.includes('fapi.binance.com')).length, 1);
    assert.ok(requests[0].url.includes('signature='));
    assert.ok(requests[2].url.includes('closePosition=true'));
    assert.ok(requests[3].url.includes('closePosition=true'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
