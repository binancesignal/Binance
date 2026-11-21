import test from 'node:test';
import assert from 'node:assert/strict';

const client = await import('../lib/binance/client.js');
const { getKlines, clearKlineCache, klineExpiry, _resetGuardForTests } = client;

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
  clearKlineCache();
  _resetGuardForTests();
});

// raw Binance rows: [openTime(ms), o, h, l, c, v]; last row = still-forming bar
function rows(interval, count) {
  const sec = { '5m': 300, '1h': 3600, '4h': 14400, '1w': 604800 }[interval];
  const nowSec = Math.floor(Date.now() / 1000);
  const formingOpen = Math.floor(nowSec / sec) * sec;
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push([(formingOpen - i * sec) * 1000, '1', '2', '0.5', '1.5', '10']);
  return out;
}
const mkRes = (body) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => '', json: async () => body });

test('closed 1h candles are fetched ONCE and reused until the next bar closes', async () => {
  let calls = 0;
  globalThis.fetch = async () => (calls++, mkRes(rows('1h', 81)));
  const a = await getKlines('BTCUSDT', '1h', 80);
  const b = await getKlines('BTCUSDT', '1h', 80);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a.length, 80);
  assert.ok(a.every((c) => c.closed));
});

test('forming-bar requests keep the short TTL (not cached until bar close)', () => {
  const now = Date.now();
  const exp = klineExpiry([{ time: Math.floor(now / 1000) - 7200 }], '1h', now, true, 60000);
  assert.equal(exp, now + 60000);
});

test('expiry = close of the NEXT bar (works for 1w too)', () => {
  const now = 1_760_000_000_000;
  const lastOpen = Math.floor(now / 1000) - 3600 * 2; // an old bar → clamps to minimum recheck
  const stale = klineExpiry([{ time: lastOpen }], '1h', now);
  assert.ok(stale - now <= 5_000 + 1, 'data missing the newest bar is rechecked within ~5s');
  const fresh = klineExpiry([{ time: Math.floor(now / 1000) - 1800 }], '1h', now);
  assert.ok(fresh > now + 60_000 && fresh <= now + 3_605_000);
  const wk = klineExpiry([{ time: Math.floor(now / 1000) - 86400 }], '1w', now);
  assert.ok(wk > now + 3_600_000, '1w series is cached for a long time');
});
