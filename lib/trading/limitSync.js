/**
 * Keeps the bot's pending LIMIT orders in step with Binance.
 *  - order FILLED          → read the position, place SL / TP, mark the execution PROTECTED (= "in trade")
 *  - order half filled     → cancel the rest, protect what is filled
 *  - order cancelled/expired outside the bot → mark CANCELLED (with the reason)
 *  - safe cancel (rotation): never cancels an order that already filled
 *
 * `api` is the Binance private client (injectable for tests).
 */
import * as defaultApi from '../binance/private.js';
import { normalizeTpLevel, resolveTpPrice } from './tpSelect.js';
import { PENDING_LIMIT_STATUSES, pushEvent } from './limitRotation.js';

const up = (v) => String(v ?? '').trim().toUpperCase();
const missingOrder = (e) => /unknown order|does not exist|order does not exist|-2013/i.test(String(e?.message || e || ''));

async function readOrder(api, ex, keys) {
  const orderId = ex.entry_order_id || ex.order_id || ex.metadata?.orderId;
  if (!orderId) return null;
  return api.getOrderRealtime({ symbol: ex.symbol, orderId }, keys.apiKey, keys.apiSecret, keys.mode);
}

/** Cancel a waiting limit — unless it has (partly) filled in the meantime. */
export async function safeCancelLimit(ex, keys, reason, { api = defaultApi, repo, kind = 'CANCELLED' } = {}) {
  let order = null;
  try {
    order = await readOrder(api, ex, keys);
  } catch (e) {
    if (!missingOrder(e)) return { ok: false, error: e.message || String(e) };
  }
  const executed = +order?.executedQty || 0;
  if (executed > 0) return { ok: false, filled: true, order };
  if (order && !['CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(up(order.status))) {
    try {
      await api.cancelOrder(
        { symbol: ex.symbol, orderId: ex.entry_order_id || ex.order_id || ex.metadata?.orderId || undefined },
        keys.apiKey,
        keys.apiSecret,
        keys.mode
      );
    } catch (e) {
      if (!missingOrder(e)) return { ok: false, error: e.message || String(e) };
      // "unknown order" right after we read NEW → it just filled or was cancelled: let the next sync decide
      return { ok: false, retry: true, error: e.message || String(e) };
    }
  }
  await repo.updateExecution(ex.id, {
    status: 'CANCELLED',
    error: reason,
    metadata: pushEvent(
      { ...(ex.metadata || {}), cancelReason: kind, cancelledAt: new Date().toISOString() },
      'cancelled',
      reason
    ),
  });
  return { ok: true };
}

async function protectFilled(ex, order, keys, cfg, repo, api) {
  const dir = up(ex.side) === 'SHORT' ? 'SHORT' : 'LONG';
  const executed = +order.executedQty || +order.cumExecQty || 0;
  const positions = await api.getPositionRisk(keys.apiKey, keys.apiSecret, keys.mode);
  const expectedSide = dir === 'LONG' ? 'Buy' : 'Sell';
  const position = positions.find((p) => p.symbol === ex.symbol && p.side === expectedSide && +p.size > 0) || null;
  const fillPrice = +order.avgPrice || +position?.avgPrice || null;
  const filledQty = +position?.size || executed;
  const filledAt = order.updateTime ? new Date(+order.updateTime).toISOString() : new Date().toISOString();

  const instrument = await api.getInstrumentInfo(ex.symbol, keys.mode);
  const hedgeMode = ex.metadata?.hedgeMode ?? (await api.getPositionMode(keys.apiKey, keys.apiSecret, keys.mode));
  const stopLoss = cfg.slEnabled !== false && ex.sl != null ? api.roundPriceToTick(+ex.sl, instrument.tickSize) : null;
  const tpLevel = normalizeTpLevel(ex.metadata?.activeTpLevel ?? ex.metadata?.preferredTpLevel ?? 1, 1);
  const tpPick = resolveTpPrice({ tp1: ex.tp1, tp2: ex.tp2, tp3: ex.tp3 }, tpLevel);
  const takeProfit = cfg.tpEnabled !== false && tpPick.price != null ? api.roundPriceToTick(tpPick.price, instrument.tickSize) : null;
  const shouldProtect = stopLoss != null || takeProfit != null;

  await repo.updateExecution(ex.id, {
    status: shouldProtect ? 'PROTECTING' : 'FILLED',
    actual_entry: fillPrice,
    quantity: filledQty,
    filled_at: filledAt,
    error: null,
    metadata: pushEvent(
      { ...(ex.metadata || {}), orderStatus: up(order.status), verificationStatus: 'VERIFIED', filledQuantity: executed },
      'filled',
      `Limit filled @ ${fillPrice ?? '—'} · qty ${filledQty}`
    ),
  });
  if (!shouldProtect) return { status: 'FILLED' };

  const protection = await api.setStopLossTakeProfit(
    { symbol: ex.symbol, positionSide: dir, stopLoss, takeProfit, hedgeMode, quantity: filledQty },
    keys.apiKey,
    keys.apiSecret,
    keys.mode
  );
  const ok =
    (!stopLoss || protection.stopLoss?.algoId) && (!takeProfit || protection.takeProfit?.algoId) && !(protection.errors || []).length;
  const errText = (protection.errors || []).map((x) => x.message).join('; ') || null;
  await repo.updateExecution(ex.id, {
    status: ok ? 'PROTECTED' : 'UNPROTECTED',
    protected_at: ok ? new Date().toISOString() : null,
    sl_order_id: protection.stopLoss?.algoId ? String(protection.stopLoss.algoId) : null,
    tp1_order_id: protection.takeProfit?.algoId ? String(protection.takeProfit.algoId) : null,
    error: errText,
    metadata: pushEvent(
      {
        ...(ex.metadata || {}),
        orderStatus: up(order.status),
        verificationStatus: 'VERIFIED',
        protectionStatus: ok ? 'PROTECTED' : 'PROTECTION_FAILED',
        protectionOrderIds: { stopLoss: protection.stopLoss?.algoId || null, takeProfit: protection.takeProfit?.algoId || null },
        protectionError: errText,
        filledQuantity: executed,
      },
      ok ? 'protected' : 'protection_failed',
      ok ? `SL ${stopLoss ?? '—'} · TP ${takeProfit ?? '—'} placed` : `Protection failed: ${errText}`
    ),
  });
  return { status: ok ? 'PROTECTED' : 'UNPROTECTED', error: errText };
}

/**
 * @returns {{checked:number, filled:number, cancelled:number, errors:string[], events:Array}}
 */
export async function syncPendingLimits({ executions = [], keys, cfg = {}, repo, api = defaultApi }) {
  const out = { checked: 0, filled: 0, cancelled: 0, errors: [], events: [] };
  for (const ex of executions) {
    if (!PENDING_LIMIT_STATUSES.includes(up(ex.status))) continue;
    if (up(ex.status) === 'PENDING' || up(ex.status) === 'PLACING') {
      // being placed right now by another run — only look at it if it is clearly stuck (> 3 min)
      if (Date.now() - new Date(ex.updated_at || ex.created_at).getTime() < 180_000) continue;
    }
    out.checked += 1;
    try {
      let order = null;
      try {
        order = await readOrder(api, ex, keys);
      } catch (e) {
        if (!missingOrder(e)) throw e;
        await repo.updateExecution(ex.id, {
          status: 'CANCELLED',
          error: 'Order no longer exists on Binance (cancelled outside the bot or expired)',
          metadata: pushEvent(ex.metadata, 'cancelled', 'Order no longer exists on Binance'),
        });
        out.cancelled += 1;
        out.events.push({ symbol: ex.symbol, type: 'cancelled', text: 'order no longer exists' });
        continue;
      }
      if (!order) {
        out.errors.push(`${ex.symbol}: no order id stored`);
        continue;
      }
      const st = up(order.status);
      const executed = +order.executedQty || 0;
      if (st === 'FILLED' || (executed > 0 && ['CANCELED', 'CANCELLED', 'EXPIRED'].includes(st))) {
        const r = await protectFilled(ex, order, keys, cfg, repo, api);
        out.filled += 1;
        out.events.push({ symbol: ex.symbol, type: 'filled', text: r.status });
      } else if (st === 'PARTIALLY_FILLED' && executed > 0) {
        try {
          await api.cancelOrder({ symbol: ex.symbol, orderId: order.orderId }, keys.apiKey, keys.apiSecret, keys.mode);
        } catch (_) {}
        const r = await protectFilled(ex, { ...order, executedQty: executed }, keys, cfg, repo, api);
        out.filled += 1;
        out.events.push({ symbol: ex.symbol, type: 'partial', text: r.status });
      } else if (['CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(st)) {
        const reason = `Binance order ${st.toLowerCase()} (cancelled outside the bot or expired) — nothing was filled`;
        await repo.updateExecution(ex.id, {
          status: st === 'REJECTED' ? 'REJECTED' : 'CANCELLED',
          error: reason,
          metadata: pushEvent(ex.metadata, 'cancelled', reason),
        });
        out.cancelled += 1;
        out.events.push({ symbol: ex.symbol, type: 'cancelled', text: st });
      }
    } catch (e) {
      out.errors.push(`${ex.symbol}: ${e.message || e}`);
    }
  }
  return out;
}
