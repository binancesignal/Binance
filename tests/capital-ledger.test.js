import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCapital,
  setCapital,
  clearCapital,
  validateStartingCapital,
  budgetState,
  applyBudgetCap,
  buildLedger,
} from '../lib/trading/capital.js';
import { summarizeIncome } from '../lib/trading/incomeSummary.js';

const T0 = '2026-10-01T00:00:00.000Z';
const mk = (id, symbol, createdH, closedH, pnl, margin = 20, extra = {}) => ({
  id,
  symbol,
  side: 'LONG',
  mode: 'mock',
  status: 'CLOSED',
  margin,
  leverage: 10,
  notional: margin * 10,
  realized_pnl: pnl,
  created_at: new Date(Date.parse(T0) + createdH * 3600e3).toISOString(),
  filled_at: new Date(Date.parse(T0) + createdH * 3600e3).toISOString(),
  closed_at: new Date(Date.parse(T0) + closedH * 3600e3).toISOString(),
  ...extra,
});

test('capital is stored per mode and can be cleared', () => {
  const s = setCapital({}, 'mock', 100, new Date(T0));
  assert.deepEqual(getCapital(s, 'mock'), { startingCapital: 100, startedAt: T0 });
  assert.equal(getCapital(s, 'live'), null);
  assert.equal(getCapital(clearCapital(s, 'mock'), 'mock'), null);
});

test('validation: minimum and never above the real wallet', () => {
  assert.equal(validateStartingCapital(5).ok, false);
  assert.equal(validateStartingCapital('abc').ok, false);
  assert.equal(validateStartingCapital(500, 300).ok, false);
  assert.equal(validateStartingCapital(300, 300).ok, true);
  assert.equal(validateStartingCapital(100.456).amount, 100.46);
});

test('balance compounds: start + closed PnL; open margin is reserved', () => {
  const cap = { startingCapital: 100, startedAt: T0 };
  const rows = [
    mk('a', 'BTCUSDT', 1, 2, 10),
    mk('b', 'ETHUSDT', 3, 4, -4),
    mk('c', 'SOLUSDT', 5, null, null, 30, { status: 'PROTECTED', realized_pnl: null, closed_at: null }),
  ];
  const b = budgetState(cap, rows, 'mock');
  assert.equal(b.balance, 106);
  assert.equal(b.usedMargin, 30);
  assert.equal(b.free, 76);
});

test('trades from before the run or from another mode do not count', () => {
  const cap = { startingCapital: 100, startedAt: T0 };
  const rows = [mk('old', 'BTCUSDT', -5, -4, 50), mk('live', 'ETHUSDT', 1, 2, 70, 20, { mode: 'live' }), mk('ok', 'SOLUSDT', 1, 2, 5)];
  assert.equal(budgetState(cap, rows, 'mock').balance, 105);
});

test('sizing is capped to the budget, not the wallet', () => {
  const budget = { balance: 120 };
  const c = applyBudgetCap({ equity: 5000, available: 4900 }, budget, 20);
  assert.equal(c.equity, 120);
  assert.equal(c.available, 100);
  assert.equal(c.capped, true);
  // small wallet below the budget is left alone
  const d = applyBudgetCap({ equity: 80, available: 80 }, budget, 0);
  assert.equal(d.equity, 80);
  assert.equal(d.available, 80);
  assert.equal(applyBudgetCap({ equity: 10, available: 10 }, { balance: 1 }, 0).exhausted, true);
});

test('ledger: balance before, margin, profit, balance after, per trade', () => {
  const cap = { startingCapital: 100, startedAt: T0 };
  const rows = [
    mk('a', 'BTCUSDT', 1, 2, 10, 25),
    mk('b', 'ETHUSDT', 3, 4, -5.5, 22),
    mk('c', 'SOLUSDT', 3.5, 6, 8, 20), // opened while b was still running
  ];
  const l = buildLedger(cap, rows, 'mock');
  assert.equal(l.trades.length, 3);
  const [a, b, c] = l.trades;
  assert.equal(a.coin, 'BTC');
  assert.equal(a.balanceAtEntry, 100);
  assert.equal(a.balanceAfter, 110);
  assert.equal(b.balanceAtEntry, 110);
  assert.equal(b.balanceAfter, 104.5);
  // c opened at 3.5h: only a (closed 2h) had finished, b had not
  assert.equal(c.balanceAtEntry, 110);
  assert.equal(c.balanceAfter, 112.5);
  assert.equal(l.stats.totalPnl, 12.5);
  assert.equal(l.stats.wins, 2);
  assert.equal(l.stats.losses, 1);
  assert.equal(Math.round(l.stats.winRate), 67);
  assert.equal(l.series.length, 4);
  assert.equal(l.series[0].balance, 100);
  assert.ok(l.stats.maxDrawdownPct > 0 && l.stats.maxDrawdownPct < 6);
  assert.equal(Math.round(l.stats.profitFactor * 100) / 100, 3.27);
});

test('income summary books PnL only once Binance reports REALIZED_PNL', () => {
  const rows = [
    { type: 'COMMISSION', income: -0.05, time: 1000 },
    { type: 'REALIZED_PNL', income: 4, time: 5000 },
    { type: 'COMMISSION', income: -0.04, time: 5000 },
    { type: 'FUNDING_FEE', income: -0.01, time: 3000 },
    { type: 'REALIZED_PNL', income: 3, time: 9000 },
    { type: 'REALIZED_PNL', income: 99, time: 99999 }, // belongs to a later trade
  ];
  assert.equal(summarizeIncome([{ type: 'COMMISSION', income: -0.05, time: 1000 }], { fromMs: 0 }), null);
  const s = summarizeIncome(rows, { fromMs: 0, toMs: 20000 });
  assert.equal(s.gross, 7);
  assert.equal(Math.round(s.net * 100) / 100, 6.9);
  assert.equal(s.closedAtMs, 9000);
});
