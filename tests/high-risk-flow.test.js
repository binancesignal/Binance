import test from 'node:test';
import assert from 'node:assert/strict';

// ── fake Binance Futures (mock/testnet host) ───────────────────────────────
const placed = [];
const state = { positions: [], equity: 1000, available: 1000, leverageSet: [] };
const j = (data, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data), json: async () => data });

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  assert.equal(u.host, 'testnet.binancefuture.com', 'mock mode must only touch the testnet host');
  const p = u.pathname;
  const method = opts.method || 'GET';
  if (p === '/fapi/v1/exchangeInfo') {
    return j({ symbols: [{ symbol: 'SOLUSDT', status: 'TRADING', filters: [
      { filterType: 'LOT_SIZE', stepSize: '0.01', minQty: '0.01', maxQty: '100000' },
      { filterType: 'PRICE_FILTER', tickSize: '0.001' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ] }] });
  }
  if (p === '/fapi/v1/premiumIndex') return j({ markPrice: '100' });
  if (p === '/fapi/v2/account') return j({ totalWalletBalance: String(state.equity), totalMarginBalance: String(state.equity), availableBalance: String(state.available), totalUnrealizedProfit: '0', assets: [] });
  if (p === '/fapi/v2/positionRisk') return j(state.positions);
  if (p === '/fapi/v1/positionSide/dual') return j({ dualSidePosition: false });
  if (p === '/fapi/v1/leverage') { state.leverageSet.push(+u.searchParams.get('leverage')); return j({ leverage: +u.searchParams.get('leverage') }); }
  if (p === '/fapi/v1/order' && method === 'POST') {
    const q = Object.fromEntries(u.searchParams.entries());
    placed.push(q);
    state.positions = [{ symbol: q.symbol, positionAmt: q.quantity, entryPrice: '100', markPrice: '100', liquidationPrice: '50', unRealizedProfit: '0', leverage: String(state.leverageSet.at(-1)), notional: String(+q.quantity * 100), marginType: 'isolated' }];
    return j({ orderId: 777, status: 'FILLED', executedQty: q.quantity, avgPrice: '100', updateTime: Date.now() });
  }
  if (p === '/fapi/v1/order' && method === 'GET') return j({ orderId: 777, status: 'FILLED', executedQty: placed.at(-1)?.quantity, avgPrice: '100', updateTime: Date.now() });
  if (p === '/fapi/v1/algoOrder') return j({ algoId: 900 + Math.floor(Math.random() * 100) });
  if (p === '/fapi/v1/openAlgoOrders') return j([]);
  return j({ code: -1, msg: `unmocked ${method} ${p}` }, 404);
};

const U = await import('../lib/database/users.js');
const { upsertSignal } = await import('../lib/database/signals.js');
const { setAutoTradingConfig } = await import('../lib/trading/autoConfig.js');
const { setState } = await import('../lib/database/appState.js');
const { processBinanceUserAutoTrades } = await import('../lib/trading/binanceAutoTrader.js');
const { getRecentExecutions } = await import('../lib/database/executions.js');

const created = [];
async function setupUser(email, settings) {
  // only the user under test may be armed (every armed user is processed on each cron pass)
  for (const id of created) {
    await U.setUserTradingSettings(id, { ...(await U.getUserTradingSettings(id)), autoTradingEnabled: false });
  }
  const user = await U.createUser({ email, password: 'password123' });
  await U.updateUser(user.id, { plan: 'auto', subscription_status: 'active' });
  await U.saveExchangeKeys(user.id, 'binance', { apiKey: 'KEYKEYKEYKEY', apiSecret: 'sec', mode: 'mock' });
  created.push(user.id);
  await U.setUserTradingSettings(user.id, {
    ...(await U.getUserTradingSettings(user.id)),
    autoTradingEnabled: true,
    autoTradeExchange: 'binance',
    ...settings,
  });
  return user;
}

const sig = (id, symbol, entry, sl, tp1) => ({
  signal_id: id, symbol, direction: 'LONG', exchange: 'binance', status: 'ONGOING', strategy: 'chart_pattern',
  score: 90, entry, sl, tp1, tp2: tp1 * 1.02, tp3: tp1 * 1.04, rr: (tp1 - entry) / (entry - sl),
  entry_hit_at: new Date().toISOString(), entry_hit_price: entry, current_price: entry,
  metadata: { strategy: 'chart_pattern' },
});

test('High Risk mode: margin = 25% of balance, leverage derived from the SL distance', async () => {
  await setAutoTradingConfig({ autoTradingEnabled: true });
  await setState('scan_exchanges', ['binance']);
  const user = await setupUser('hr@example.com', { riskMode: 'high' });
  await upsertSignal(sig('bin_SOL_1', 'SOLUSDT', 100, 98, 106)); // 2% SL, RR 3

  const s = await processBinanceUserAutoTrades();
  assert.equal(s.autoTradesPlaced, 1, JSON.stringify(s.reasons));
  assert.equal(state.leverageSet.at(-1), 10, '2% SL, 25% margin, 5% loss cap -> 10x');

  const ex = (await getRecentExecutions(10)).find((e) => e.signal_id === 'bin_SOL_1');
  assert.equal(ex.metadata.riskMode, 'high');
  assert.ok(Math.abs(ex.margin - 250) < 1, `margin ${ex.margin}`);
  assert.ok(Math.abs(ex.metadata.sizing.lossAtSlPct - 5) < 0.2);
  assert.equal(Number(placed.at(-1).quantity), 25); // 250 margin * 10x / 100 price
});

test('High Risk mode: ignores the old 3-position default; the total-margin cap limits trades', async () => {
  placed.length = 0;
  state.positions = [];
  state.leverageSet.length = 0;
  const user = await setupUser('hr2@example.com', { riskMode: 'high', maxOpenPositions: 3 });
  // 3 existing positions already use 75% margin -> a 4th must be refused by the margin cap
  state.positions = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'].map((s) => ({
    symbol: s, positionAmt: '25', entryPrice: '100', markPrice: '100', liquidationPrice: '50', unRealizedProfit: '0',
    leverage: '10', notional: '2500', marginType: 'isolated',
  }));
  await upsertSignal(sig('bin_SOL_2', 'SOLUSDT', 100, 98, 106));
  const s = await processBinanceUserAutoTrades();
  assert.equal(placed.length, 0);
  const ex = (await getRecentExecutions(20)).find((e) => e.signal_id === 'bin_SOL_2' && e.user_id === user.id);
  assert.match(ex.error, /Total margin cap/);
});

test('High Risk mode: daily-loss brake blocks new trades', async () => {
  placed.length = 0;
  state.positions = [];
  const user = await setupUser('hr3@example.com', { riskMode: 'high' });
  // day started at 1000, account is now 850 (-15%) -> brake engages
  const { dayKeyLK } = await import('../lib/trading/riskSizing.js');
  await setState(`risk_guard:${user.id}`, { day: dayKeyLK(), dayStartEquity: 1000, peakEquity: 1000, halted: null, haltReason: null });
  state.equity = 850; state.available = 850;
  await upsertSignal(sig('bin_SOL_3', 'SOLUSDT', 100, 98, 106));
  await processBinanceUserAutoTrades();
  assert.equal(placed.length, 0);
  const ex = (await getRecentExecutions(30)).find((e) => e.signal_id === 'bin_SOL_3' && e.user_id === user.id);
  assert.match(ex.error, /Daily loss|Drawdown/);
  state.equity = 1000; state.available = 1000;
});

test('Users who have not confirmed High Risk mode are not traded (no Standard fallback)', async () => {
  placed.length = 0;
  state.positions = [];
  state.leverageSet.length = 0;
  const user = await setupUser('std@example.com', { riskMode: 'standard' });
  await upsertSignal(sig('bin_SOL_4', 'SOLUSDT', 100, 98, 106));
  const s = await processBinanceUserAutoTrades();
  assert.equal(placed.length, 0, 'nothing may be ordered');
  assert.equal(s.autoTradesPlaced, 0);
  assert.ok(s.reasons.some((r) => r.includes(user.id) && /High Risk mode not confirmed/.test(r)), JSON.stringify(s.reasons));
});
