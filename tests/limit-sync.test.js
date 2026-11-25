import test from 'node:test';
import assert from 'node:assert/strict';
import { syncPendingLimits, safeCancelLimit } from '../lib/trading/limitSync.js';

const keys = { apiKey: 'k', apiSecret: 's', mode: 'mock' };
const mkRepo = () => {
  const rows = new Map();
  return { rows, updateExecution: async (id, patch) => { rows.set(id, { ...(rows.get(id) || {}), ...patch }); return rows.get(id); } };
};
const ex = (over = {}) => ({
  id: 'e1', symbol: 'ABCUSDT', side: 'LONG', status: 'WAITING_FILL', entry_order_id: '77', sl: 95, tp1: 105, tp2: 110, tp3: 120,
  metadata: { activeTpLevel: 1 }, updated_at: new Date(Date.now() - 600000).toISOString(), ...over,
});
const mkApi = (order, extra = {}) => {
  const calls = [];
  return {
    calls,
    getOrderRealtime: async () => { if (order instanceof Error) throw order; return order; },
    cancelOrder: async (a) => { calls.push(['cancel', a]); },
    getPositionRisk: async () => [{ symbol: 'ABCUSDT', side: 'Buy', size: 3, avgPrice: 100 }],
    getInstrumentInfo: async () => ({ tickSize: 0.01 }),
    getPositionMode: async () => false,
    roundPriceToTick: (v) => +v,
    setStopLossTakeProfit: async (a) => { calls.push(['protect', a]); return { stopLoss: { algoId: 1 }, takeProfit: { algoId: 2 }, errors: [] }; },
    ...extra,
  };
};

test('filled limit → position found → SL/TP placed → PROTECTED (in trade)', async () => {
  const repo = mkRepo();
  const api = mkApi({ orderId: '77', status: 'FILLED', executedQty: 3, avgPrice: 100, updateTime: Date.now() });
  const r = await syncPendingLimits({ executions: [ex()], keys, cfg: { slEnabled: true, tpEnabled: true }, repo, api });
  assert.equal(r.filled, 1);
  assert.equal(repo.rows.get('e1').status, 'PROTECTED');
  assert.equal(repo.rows.get('e1').actual_entry, 100);
  const protect = api.calls.find((c) => c[0] === 'protect')[1];
  assert.equal(protect.stopLoss, 95);
  assert.equal(protect.takeProfit, 105);
});

test('a limit that is still NEW stays waiting and nothing is touched', async () => {
  const repo = mkRepo();
  const api = mkApi({ orderId: '77', status: 'NEW', executedQty: 0 });
  const r = await syncPendingLimits({ executions: [ex()], keys, cfg: {}, repo, api });
  assert.equal(r.filled + r.cancelled, 0);
  assert.equal(repo.rows.size, 0);
});

test('order cancelled / expired on Binance is closed with the reason', async () => {
  const repo = mkRepo();
  const api = mkApi({ orderId: '77', status: 'CANCELED', executedQty: 0 });
  const r = await syncPendingLimits({ executions: [ex()], keys, cfg: {}, repo, api });
  assert.equal(r.cancelled, 1);
  assert.equal(repo.rows.get('e1').status, 'CANCELLED');
  assert.match(repo.rows.get('e1').error, /cancelled outside the bot|expired/);
});

test('unknown order id → cancelled; other API errors keep the order and report', async () => {
  let repo = mkRepo();
  await syncPendingLimits({ executions: [ex()], keys, cfg: {}, repo, api: mkApi(new Error('Order does not exist.')) });
  assert.equal(repo.rows.get('e1').status, 'CANCELLED');
  repo = mkRepo();
  const r = await syncPendingLimits({ executions: [ex()], keys, cfg: {}, repo, api: mkApi(new Error('HTTP 429')) });
  assert.equal(repo.rows.size, 0);
  assert.equal(r.errors.length, 1);
});

test('rotation cancel never cancels an order that already filled', async () => {
  const repo = mkRepo();
  const api = mkApi({ orderId: '77', status: 'FILLED', executedQty: 3 });
  const r = await safeCancelLimit(ex(), keys, 'replaced', { api, repo });
  assert.equal(r.ok, false);
  assert.equal(r.filled, true);
  assert.equal(api.calls.length, 0);
  assert.equal(repo.rows.size, 0);
});

test('rotation cancel cancels a NEW order on Binance and records the reason + history', async () => {
  const repo = mkRepo();
  const api = mkApi({ orderId: '77', status: 'NEW', executedQty: 0 });
  const r = await safeCancelLimit(ex(), keys, 'Replaced by B score 85 > A score 70', { api, repo, kind: 'OUTRANKED' });
  assert.equal(r.ok, true);
  assert.equal(api.calls[0][0], 'cancel');
  const row = repo.rows.get('e1');
  assert.equal(row.status, 'CANCELLED');
  assert.equal(row.error, 'Replaced by B score 85 > A score 70');
  assert.equal(row.metadata.events.at(-1).type, 'cancelled');
});
