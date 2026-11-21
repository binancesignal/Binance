/**
 * Starting-capital budget + trade ledger (pure functions, no I/O).
 *
 * The futures wallet can hold any amount. The user picks how much of it the
 * bot may trade with: that is the STARTING CAPITAL. From then on the bot's
 * balance is   startingCapital + Σ net PnL of trades closed since the start,
 * so profits compound and losses shrink the next trade automatically.
 *
 * Settings shape (per connection mode, because mock and live are different accounts):
 *   settings.capital = { live: { startingCapital, startedAt }, mock: { ... } }
 */

export const MIN_STARTING_CAPITAL = 5; // USDT

const OPEN_FILLED = ['FILLED', 'PROTECTED', 'UNPROTECTED', 'PARTIALLY_FILLED'];
const OPEN_PENDING = ['PENDING', 'PLACING', 'PLACED', 'WAITING_FILL', 'VERIFY_UNKNOWN', 'PROTECTING'];

const num = (v, d = 0) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
const ts = (v) => {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

/** The capital config for one mode, or null when the user has not set one. */
export function getCapital(settings, mode) {
  const c = settings?.capital?.[mode];
  const start = num(c?.startingCapital);
  if (!(start > 0) || !c?.startedAt) return null;
  return { startingCapital: start, startedAt: c.startedAt };
}

/** Validate a user-entered amount. `walletEquity` (optional) is the real futures wallet. */
export function validateStartingCapital(amount, walletEquity = null) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return { ok: false, error: 'Enter a valid amount' };
  if (a < MIN_STARTING_CAPITAL) return { ok: false, error: `Minimum starting capital is ${MIN_STARTING_CAPITAL} USDT` };
  if (walletEquity != null && Number.isFinite(+walletEquity) && +walletEquity > 0 && a > +walletEquity + 1e-9) {
    return {
      ok: false,
      error: `Your futures wallet only has ${(+walletEquity).toFixed(2)} USDT. Pick an amount at or below that.`,
    };
  }
  return { ok: true, amount: Math.round(a * 100) / 100 };
}

export function setCapital(settings, mode, amount, now = new Date()) {
  return {
    ...(settings || {}),
    capital: {
      ...(settings?.capital || {}),
      [mode]: { startingCapital: Math.round(+amount * 100) / 100, startedAt: now.toISOString() },
    },
  };
}

export function clearCapital(settings, mode) {
  const capital = { ...(settings?.capital || {}) };
  delete capital[mode];
  return { ...(settings || {}), capital };
}

/** Executions that belong to this capital run (same mode, started after the run began). */
function inRun(executions, capital, mode) {
  const since = ts(capital.startedAt);
  return (executions || []).filter((e) => {
    if (mode && e.mode && e.mode !== mode) return false;
    const created = ts(e.created_at);
    return since == null || created == null || created >= since;
  });
}

const isClosed = (e) => e.status === 'CLOSED' && e.realized_pnl != null && Number.isFinite(+e.realized_pnl);

/** Balance the bot may use right now, plus the margin tied up in open trades. */
export function budgetState(capital, executions, mode) {
  if (!capital) return null;
  const rows = inRun(executions, capital, mode);
  const pnl = rows.filter(isClosed).reduce((s, e) => s + +e.realized_pnl, 0);
  const balance = capital.startingCapital + pnl;
  const usedMargin = rows
    .filter((e) => OPEN_FILLED.includes(e.status) || OPEN_PENDING.includes(e.status))
    .reduce((s, e) => s + num(e.margin), 0);
  return {
    balance,
    realizedPnl: pnl,
    usedMargin,
    free: Math.max(0, balance - usedMargin),
  };
}

/**
 * Cap what the sizing code sees so it never trades more than the budget.
 * `equity`/`available` are the real wallet numbers from the exchange.
 */
export function applyBudgetCap({ equity, available }, budget, usedMarginReal = 0) {
  if (!budget) return { equity, available, capped: false, exhausted: false };
  const cappedEquity = Math.min(+equity, Math.max(0, budget.balance));
  const cappedAvail = Math.min(+available, Math.max(0, budget.balance - usedMarginReal));
  return {
    equity: cappedEquity,
    available: cappedAvail,
    capped: cappedEquity < +equity || cappedAvail < +available,
    exhausted: budget.balance < MIN_STARTING_CAPITAL / 2,
  };
}

/**
 * Build the full ledger for the chart.
 * Rows are ordered by close time; every row carries the balance when the trade was
 * taken (counting only trades already closed by then), the margin used, the net PnL
 * and the balance after it closed.
 */
export function buildLedger(capital, executions, mode) {
  if (!capital) return null;
  const rows = inRun(executions, capital, mode);
  const start = capital.startingCapital;

  const closed = rows
    .filter(isClosed)
    .map((e) => ({ e, opened: ts(e.filled_at) ?? ts(e.created_at), closed: ts(e.closed_at) ?? ts(e.updated_at) }))
    .sort((a, b) => (a.closed ?? 0) - (b.closed ?? 0));

  const trades = [];
  let balance = start;
  let peak = start;
  let maxDd = 0;
  let grossWin = 0;
  let grossLoss = 0;
  const series = [{ i: 0, label: 'Start', balance: start, time: capital.startedAt, pnl: 0 }];

  closed.forEach(({ e, opened, closed: closedAt }, idx) => {
    const pnl = +e.realized_pnl;
    // balance the bot had when this trade was opened = start + PnL of trades closed before that
    const before = start + closed.filter((c) => c.closed != null && opened != null && c.closed <= opened).reduce((s, c) => s + +c.e.realized_pnl, 0);
    balance += pnl;
    peak = Math.max(peak, balance);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - balance) / peak) * 100);
    if (pnl >= 0) grossWin += pnl;
    else grossLoss += -pnl;
    const margin = num(e.margin);
    const trade = {
      n: idx + 1,
      id: e.id,
      symbol: e.symbol,
      coin: String(e.symbol || '').replace(/USDT$/, ''),
      side: e.side,
      leverage: num(e.leverage),
      margin,
      notional: num(e.notional),
      entry: e.actual_entry != null ? +e.actual_entry : e.signal_entry != null ? +e.signal_entry : null,
      openedAt: e.filled_at || e.created_at || null,
      closedAt: e.closed_at || e.updated_at || null,
      balanceAtEntry: before,
      marginPctOfBalance: before > 0 ? (margin / before) * 100 : null,
      pnl,
      fees: num(e.metadata?.pnl?.commission) + num(e.metadata?.pnl?.funding),
      pnlPctOfBalance: before > 0 ? (pnl / before) * 100 : null,
      roiOnMargin: margin > 0 ? (pnl / margin) * 100 : null,
      balanceAfter: balance,
      win: pnl > 0,
    };
    trades.push(trade);
    series.push({ i: idx + 1, label: trade.coin, balance, time: trade.closedAt, pnl, win: trade.win });
  });

  const open = rows
    .filter((e) => OPEN_FILLED.includes(e.status) || OPEN_PENDING.includes(e.status))
    .map((e) => ({
      id: e.id,
      symbol: e.symbol,
      coin: String(e.symbol || '').replace(/USDT$/, ''),
      side: e.side,
      leverage: num(e.leverage),
      margin: num(e.margin),
      status: e.status,
      openedAt: e.filled_at || e.created_at,
    }));

  const wins = trades.filter((t) => t.win).length;
  const losses = trades.length - wins;
  const totalPnl = balance - start;
  const usedMargin = open.reduce((s, o) => s + o.margin, 0);
  const best = trades.reduce((m, t) => (!m || t.pnl > m.pnl ? t : m), null);
  const worst = trades.reduce((m, t) => (!m || t.pnl < m.pnl ? t : m), null);

  return {
    startingCapital: start,
    startedAt: capital.startedAt,
    trades,
    open,
    series,
    stats: {
      trades: trades.length,
      wins,
      losses,
      winRate: trades.length ? (wins / trades.length) * 100 : null,
      totalPnl,
      roiPct: start > 0 ? (totalPnl / start) * 100 : null,
      balanceNow: balance,
      usedMargin,
      free: Math.max(0, balance - usedMargin),
      peak,
      maxDrawdownPct: maxDd,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : null,
      best: best ? { coin: best.coin, pnl: best.pnl } : null,
      worst: worst ? { coin: worst.coin, pnl: worst.pnl } : null,
    },
  };
}
