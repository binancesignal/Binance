/**
 * Turns "position is gone" into a CLOSED execution with the real net PnL.
 * Until now Binance executions stayed FILLED/PROTECTED forever and realized_pnl was never saved,
 * so there was no way to know balance after a trade. Source of truth = Binance /fapi/v1/income.
 */
import { getLedgerExecutions, updateExecution } from '../database/executions.js';
import * as binance from '../binance/private.js';
import { summarizeIncome } from './incomeSummary.js';

const LIVE_STATUSES = ['FILLED', 'PROTECTED', 'UNPROTECTED', 'PARTIALLY_FILLED'];
const MIN_AGE_MS = 20_000; // let the fill settle before judging "no position"

const posKey = (symbol, side) => `${symbol}:${side}`;

export async function syncClosedTrades({ userId, keys, now = Date.now() }) {
  const out = { checked: 0, closed: 0, errors: [] };
  const all = await getLedgerExecutions({ userId, exchange: 'binance', mode: keys.mode });
  const live = all.filter((e) => LIVE_STATUSES.includes(e.status));
  if (!live.length) return out;

  const positions = await binance.getPositionRisk(keys.apiKey, keys.apiSecret, keys.mode);
  const open = new Set(positions.map((p) => posKey(p.symbol, p.side === 'Buy' ? 'LONG' : 'SHORT')));

  for (const e of live) {
    out.checked += 1;
    try {
      if (open.has(posKey(e.symbol, e.side))) continue; // still running
      const startedMs = new Date(e.created_at).getTime();
      if (!(now - startedMs > MIN_AGE_MS)) continue;

      // a later trade on the same coin must not steal this trade's income
      const nextSame = all
        .filter((x) => x.id !== e.id && x.symbol === e.symbol && new Date(x.created_at).getTime() > startedMs)
        .map((x) => new Date(x.created_at).getTime())
        .sort((a, b) => a - b)[0];
      const toMs = nextSame ?? now;

      const rows = await binance.getIncomeHistory(
        { symbol: e.symbol, startTime: startedMs - 1000, endTime: toMs },
        keys.apiKey,
        keys.apiSecret,
        keys.mode
      );
      const s = summarizeIncome(rows, { fromMs: startedMs - 1000, toMs });
      if (!s) continue; // Binance has not booked the PnL yet - try next run

      await updateExecution(e.id, {
        status: 'CLOSED',
        realized_pnl: s.net,
        closed_at: new Date(s.closedAtMs).toISOString(),
        metadata: {
          ...(e.metadata || {}),
          pnl: { gross: s.gross, commission: s.commission, funding: s.funding, net: s.net, source: 'binance_income' },
        },
      });
      out.closed += 1;
    } catch (err) {
      out.errors.push(`${e.symbol}: ${err.message}`);
    }
  }
  return out;
}
