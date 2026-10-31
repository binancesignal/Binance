/**
 * Manual "Close now" for a running Binance position.
 *
 * Order matters: the position is closed FIRST. If that fails nothing else is touched, so the
 * trade keeps its stop-loss / take-profit. Only after the position is flat are the leftover
 * SL/TP orders cancelled.
 */
import * as binance from '../binance/private.js';
import { getLedgerExecutions, updateExecution } from '../database/executions.js';
import { syncClosedTrades } from './pnlSync.js';
import { selectPositions, dirOf } from './positionSelect.js';

const LIVE_STATUSES = ['FILLED', 'PROTECTED', 'UNPROTECTED', 'PARTIALLY_FILLED'];

export async function closeBinancePositions({ userId, keys, target }) {
  const { apiKey, apiSecret, mode } = keys;
  const positions = await binance.getPositionRisk(apiKey, apiSecret, mode);
  const picked = selectPositions(positions, target);
  if (!picked.length) {
    return { closed: [], failed: [], notFound: true };
  }

  const closed = [];
  const failed = [];
  for (const p of picked) {
    try {
      const res = await binance.closePositionMarket(p, apiKey, apiSecret, mode);
      const cleanup = [];
      // leftover protective orders; only safe to cancel when no other position uses the symbol
      const sameSymbolStillOpen = positions.some(
        (x) => x.symbol === p.symbol && !picked.includes(x)
      );
      if (!sameSymbolStillOpen) {
        for (const fn of [binance.cancelAllOpenOrders, binance.cancelAllAlgoOrders]) {
          try {
            await fn(p.symbol, apiKey, apiSecret, mode);
          } catch (e) {
            cleanup.push(e.message);
          }
        }
      }
      closed.push({
        symbol: p.symbol,
        direction: dirOf(p),
        size: p.size,
        avgClosePrice: res?.avgPrice != null ? Number(res.avgPrice) : null,
        orderId: res?.orderId != null ? String(res.orderId) : null,
        cleanupWarnings: cleanup,
      });
    } catch (e) {
      failed.push({ symbol: p.symbol, direction: dirOf(p), error: e.message });
    }
  }

  // tag our own execution records so the history shows it was closed by hand
  try {
    if (closed.length) {
      const rows = await getLedgerExecutions({ userId, exchange: 'binance', mode });
      for (const c of closed) {
        for (const e of rows.filter(
          (x) => x.symbol === c.symbol && x.side === c.direction && LIVE_STATUSES.includes(x.status)
        )) {
          await updateExecution(e.id, {
            metadata: { ...(e.metadata || {}), manual_close: { at: new Date().toISOString(), orderId: c.orderId } },
          });
        }
      }
      // Binance books the PnL a moment later; if it is not there yet the next sync picks it up
      await new Promise((r) => setTimeout(r, 1500));
      await syncClosedTrades({ userId, keys });
    }
  } catch (_) {
    /* bookkeeping must never turn a successful close into an error */
  }

  return { closed, failed, notFound: false };
}
