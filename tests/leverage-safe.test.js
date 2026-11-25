import test from 'node:test';
import assert from 'node:assert/strict';
import * as binance from '../lib/binance/private.js';

function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const r = responses.shift();
    return { ok: r.ok, status: r.ok ? 200 : 400, text: async () => JSON.stringify(r.body) };
  };
  return calls;
}

test('setLeverageSafe retries a transient -1000 and then succeeds', async () => {
  const orig = globalThis.fetch;
  const calls = mockFetch([
    { ok: false, body: { code: -1000, msg: 'An unknown error occurred' } },
    { ok: true, body: { symbol: 'BIOUSDT', leverage: 20 } },
  ]);
  try {
    const r = await binance.setLeverageSafe('BIOUSDT', 20, 'k', 's', 'mock', { delayMs: 1 });
    assert.equal(r.leverage, 20);
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = orig; }
});

test('setLeverageSafe does not retry a real rejection and names the step', async () => {
  const orig = globalThis.fetch;
  const calls = mockFetch([{ ok: false, body: { code: -4028, msg: 'Leverage 50 is not valid' } }]);
  try {
    await assert.rejects(
      () => binance.setLeverageSafe('BIOUSDT', 50, 'k', 's', 'mock', { delayMs: 1 }),
      (e) => e.step === 'setLeverage' && e.code === -4028 && /BIOUSDT 50x/.test(e.message)
    );
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = orig; }
});

test('getMaxLeverage reads the largest bracket leverage (array or object shape)', async () => {
  const orig = globalThis.fetch;
  try {
    mockFetch([{ ok: true, body: [{ symbol: 'BIOUSDT', brackets: [{ bracket: 1, initialLeverage: 25 }, { bracket: 2, initialLeverage: 10 }] }] }]);
    assert.equal(await binance.getMaxLeverage('BIOUSDT', 'k', 's', 'mock'), 25);
    mockFetch([{ ok: true, body: { symbol: 'BIOUSDT', brackets: [{ bracket: 1, initialLeverage: 20 }] } }]);
    assert.equal(await binance.getMaxLeverage('BIOUSDT', 'k', 's', 'mock'), 20);
  } finally { globalThis.fetch = orig; }
});
