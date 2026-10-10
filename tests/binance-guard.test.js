import test from 'node:test';
import assert from 'node:assert/strict';

process.env.BINANCE_GUARD_MAX_WAIT_MS = '60';
const client = await import('../lib/binance/client.js');
const { fetchJSON, parseBanUntil, getBanUntil, isRateGuardTripped, _resetGuardForTests } = client;

const realFetch = globalThis.fetch;
const mkRes = (status, body = '{}', headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
  json: async () => JSON.parse(body),
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
  _resetGuardForTests();
});

test('parseBanUntil reads ms and seconds timestamps', () => {
  assert.equal(parseBanUntil('Way too many requests; IP banned until 1760000000000. Please use WebSocket'), 1760000000000);
  assert.equal(parseBanUntil('banned until 1760000000'), 1760000000000);
  assert.equal(parseBanUntil('nothing'), 0);
});

test('HTTP 418 stops at once, remembers the ban and later calls never touch the network', async () => {
  let calls = 0;
  const until = Date.now() + 120_000;
  globalThis.fetch = async () => {
    calls++;
    return mkRes(418, `IP banned until ${until}`);
  };
  await assert.rejects(() => fetchJSON('https://x/a'), (e) => e.banned === true && e.banUntil === until);
  assert.equal(calls, 1, '418 is not retried');
  assert.equal(getBanUntil(), until);
  await assert.rejects(() => fetchJSON('https://x/b'), (e) => e.banned === true);
  assert.equal(calls, 1, 'no request while banned');
});

test('429 is retried once, then treated as a ban window instead of hammering', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return mkRes(429, '{}', { 'retry-after': '0' });
  };
  await assert.rejects(() => fetchJSON('https://x/c'), (e) => e.banned === true);
  assert.equal(calls, 2);
  assert.ok(getBanUntil() > Date.now() + 30_000);
});

test('high used-weight header makes the next call pause and trip the guard', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return mkRes(200, '[1]', { 'x-mbx-used-weight-1m': '2000' });
  };
  assert.deepEqual(await fetchJSON('https://x/d'), [1]);
  await assert.rejects(() => fetchJSON('https://x/e'), (e) => e.throttled === true);
  assert.equal(calls, 1);
  assert.equal(isRateGuardTripped(), true);
});

test('normal 200 responses are untouched', async () => {
  globalThis.fetch = async () => mkRes(200, '{"ok":1}', { 'x-mbx-used-weight-1m': '40' });
  assert.deepEqual(await fetchJSON('https://x/f'), { ok: 1 });
});
