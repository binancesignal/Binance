/**
 * Change the take-profit level (TP1 / TP2 / TP3) on an open Binance position.
 */
import * as binance from '../binance/private.js';
import { getOpenExecutions, updateExecution } from '../database/executions.js';
import { getSignalById } from '../database/signals.js';
import { normalizeTpLevel, resolveTpPrice, listTpOptions } from './tpSelect.js';

function sideFromDirection(direction) {
  const d = String(direction || '').toUpperCase();
  if (d === 'LONG' || d === 'BUY') return 'LONG';
  return 'SHORT';
}

/**
 * @param {{ userId: string, keys: object, symbol: string, direction: string,
 *           tpLevel?: number, tpPrice?: number }} p
 */
export async function changeBinanceTakeProfit({ userId, keys, symbol, direction, tpLevel, tpPrice }) {
  const mode = keys.mode === 'live' ? 'live' : 'mock';
  const sym = String(symbol || '').toUpperCase();
  const dir = sideFromDirection(direction);

  const positions = await binance.getPositionRisk(keys.apiKey, keys.apiSecret, mode);
  const pos = positions.find((p) => {
    if (p.symbol !== sym) return false;
    const pDir = p.side === 'Buy' ? 'LONG' : 'SHORT';
    return pDir === dir;
  });
  if (!pos || !(+pos.size > 0)) {
    return { ok: false, notFound: true, reason: 'No open position for this symbol/side' };
  }

  // Find matching bot execution for TP1/2/3 levels + SL
  const open = await getOpenExecutions({ userId, exchange: 'binance' });
  const exec =
    open.find(
      (e) =>
        String(e.symbol).toUpperCase() === sym &&
        String(e.side || '').toUpperCase() === dir &&
        !['CLOSED', 'FAILED', 'CANCELLED', 'REJECTED', 'SKIPPED'].includes(String(e.status || '').toUpperCase())
    ) || null;

  let levels = {
    tp1: exec?.tp1 ?? exec?.metadata?.tp1 ?? null,
    tp2: exec?.tp2 ?? exec?.metadata?.tp2 ?? null,
    tp3: exec?.tp3 ?? exec?.metadata?.tp3 ?? null,
    sl: exec?.sl ?? exec?.metadata?.sl ?? null,
  };

  if (exec?.signal_id) {
    try {
      const sig = await getSignalById(exec.signal_id);
      if (sig) {
        levels = {
          tp1: levels.tp1 ?? sig.tp1,
          tp2: levels.tp2 ?? sig.tp2,
          tp3: levels.tp3 ?? sig.tp3,
          sl: levels.sl ?? sig.sl,
        };
      }
    } catch (_) {}
  }

  let targetPrice = tpPrice != null && Number.isFinite(+tpPrice) ? +tpPrice : null;
  let level = tpLevel != null ? normalizeTpLevel(tpLevel, null) : null;
  let label = level ? `TP${level}` : 'Custom TP';

  if (targetPrice == null && level != null) {
    const resolved = resolveTpPrice(levels, level);
    if (!resolved.price) {
      return {
        ok: false,
        reason: `No ${label} price on this trade. Available: ${listTpOptions(levels)
          .map((o) => o.label)
          .join(', ') || 'none'}`,
      };
    }
    targetPrice = resolved.price;
    level = resolved.level;
    label = resolved.label;
  }

  if (!(targetPrice > 0)) {
    return { ok: false, reason: 'Valid tpLevel (1–3) or tpPrice required' };
  }

  // Direction sanity: LONG TP above entry, SHORT TP below
  const entry = +pos.avgPrice || +exec?.actual_entry || +exec?.entry;
  if (entry > 0) {
    if (dir === 'LONG' && targetPrice <= entry) {
      return { ok: false, reason: `LONG TP must be above entry (${entry})` };
    }
    if (dir === 'SHORT' && targetPrice >= entry) {
      return { ok: false, reason: `SHORT TP must be below entry (${entry})` };
    }
  }

  const instrument = await binance.getInstrumentInfo(sym, mode);
  const tickTp = binance.roundPriceToTick(targetPrice, instrument.tickSize);
  const slRaw = levels.sl != null ? +levels.sl : null;
  const tickSl = slRaw != null && Number.isFinite(slRaw) ? binance.roundPriceToTick(slRaw, instrument.tickSize) : null;

  const hedgeMode = await binance.getPositionMode(keys.apiKey, keys.apiSecret, mode);

  // Replace protective orders: cancel existing algo (SL+TP), re-place SL + new TP
  try {
    await binance.cancelAllAlgoOrders(sym, keys.apiKey, keys.apiSecret, mode);
  } catch (_) {
    // may be empty
  }

  const protection = await binance.setStopLossTakeProfit(
    {
      symbol: sym,
      positionSide: dir,
      stopLoss: tickSl,
      takeProfit: tickTp,
      hedgeMode,
      quantity: +pos.size,
    },
    keys.apiKey,
    keys.apiSecret,
    mode
  );

  const tpOk = !!protection.takeProfit?.algoId;
  const errors = (protection.errors || []).map((e) => e.message).join('; ');

  if (exec?.id) {
    try {
      await updateExecution(exec.id, {
        tp1_order_id: protection.takeProfit?.algoId ? String(protection.takeProfit.algoId) : exec.tp1_order_id,
        sl_order_id: protection.stopLoss?.algoId ? String(protection.stopLoss.algoId) : exec.sl_order_id,
        metadata: {
          ...(exec.metadata || {}),
          preferredTpLevel: level,
          activeTpLevel: level,
          activeTpPrice: tickTp,
          activeTpLabel: label,
          tpChangedAt: new Date().toISOString(),
          protectionOrderIds: {
            stopLoss: protection.stopLoss?.algoId || null,
            takeProfit: protection.takeProfit?.algoId || null,
          },
        },
      });
    } catch (_) {}
  }

  if (!tpOk) {
    return { ok: false, reason: errors || 'Failed to place new take-profit on exchange', protection };
  }

  return {
    ok: true,
    symbol: sym,
    direction: dir,
    tpLevel: level,
    tpPrice: tickTp,
    label,
    sl: tickSl,
    options: listTpOptions(levels),
  };
}
