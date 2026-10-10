/**
 * Free-form manual market trade (no signal required).
 * User picks symbol, direction, leverage, margin USDT → we size qty and place market order.
 */
import * as binance from '../binance/private.js';
import { getExchangeKeys } from '../database/users.js';
import { getAutoTradingConfig } from './autoConfig.js';

function normalizeSymbol(raw) {
  let s = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  if (!s.endsWith('USDT')) s = `${s}USDT`;
  return s;
}

/**
 * @param {{
 *   userId: string,
 *   symbol: string,
 *   direction: 'LONG'|'SHORT',
 *   leverage: number,
 *   marginUsdt: number,
 *   exchange?: string,
 * }} opts
 */
export async function placeFreeManualTrade(opts) {
  const {
    userId,
    direction: rawDir,
    leverage: rawLev,
    marginUsdt: rawMargin,
    exchange = 'binance',
  } = opts;

  if (String(exchange).toLowerCase() !== 'binance') {
    return { ok: false, reason: 'Free manual trade is only available for Binance' };
  }

  const cfg = await getAutoTradingConfig();
  if (cfg.freeManualTradeEnabled === false) {
    return { ok: false, reason: 'Manual trade is disabled by admin' };
  }

  const symbol = normalizeSymbol(opts.symbol);
  if (!symbol) return { ok: false, reason: 'Symbol is required' };

  const direction = String(rawDir || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const leverage = Math.floor(Number(rawLev));
  const marginUsdt = Number(rawMargin);

  if (!Number.isFinite(leverage) || leverage < 1 || leverage > 125) {
    return { ok: false, reason: 'Leverage must be 1–125' };
  }
  if (!Number.isFinite(marginUsdt) || marginUsdt <= 0) {
    return { ok: false, reason: 'Margin (USDT) must be > 0' };
  }

  const minM = Number(cfg.minMarginUsdt) > 0 ? Number(cfg.minMarginUsdt) : 1;
  const maxM = Number(cfg.maxMarginUsdt) > 0 ? Number(cfg.maxMarginUsdt) : 5000;
  if (marginUsdt < minM) return { ok: false, reason: `Minimum margin is ${minM} USDT` };
  if (marginUsdt > maxM) return { ok: false, reason: `Maximum margin is ${maxM} USDT` };

  const maxLevCfg = Number(cfg.maximumLeverage) > 0 ? Number(cfg.maximumLeverage) : 50;
  if (leverage > maxLevCfg) {
    return { ok: false, reason: `Admin max leverage is ${maxLevCfg}x` };
  }

  const keys = await getExchangeKeys(userId, 'binance');
  if (!keys?.apiKey || !keys?.apiSecret) {
    return { ok: false, reason: 'Connect your Binance API keys first' };
  }
  const mode = keys.mode || 'mock';

  let instrument;
  try {
    instrument = await binance.getInstrumentInfo(symbol, mode);
  } catch (e) {
    return { ok: false, reason: e.message || `Symbol ${symbol} not found / not trading` };
  }

  let markPrice;
  try {
    const mp = await binance.getMarkPrice(symbol, mode);
    markPrice = Number(mp?.markPrice || mp?.indexPrice || 0);
  } catch (_) {
    markPrice = 0;
  }
  if (!(markPrice > 0)) {
    return { ok: false, reason: `Could not fetch mark price for ${symbol}` };
  }

  // Cap leverage to exchange max for this symbol
  let lev = leverage;
  try {
    const symMax = await binance.getMaxLeverage(symbol, keys.apiKey, keys.apiSecret, mode);
    if (symMax && lev > symMax) lev = symMax;
  } catch (_) {}

  // notional = margin * leverage; qty = notional / price
  const notional = marginUsdt * lev;
  let qty = notional / markPrice;
  qty = binance.roundToStep(qty, instrument.qtyStep);
  if (!(qty >= instrument.minOrderQty)) {
    return {
      ok: false,
      reason: `Qty ${qty} below min ${instrument.minOrderQty}. Increase margin or leverage.`,
    };
  }

  // Optional: soft check available balance
  try {
    const acct = await binance.getAccountSummary(keys.apiKey, keys.apiSecret, mode);
    const available = Number(acct?.availableBalance ?? acct?.available ?? 0);
    if (available > 0 && marginUsdt > available * 1.02) {
      return {
        ok: false,
        reason: `Insufficient available balance (need ~${marginUsdt.toFixed(2)} USDT, have ${available.toFixed(2)})`,
      };
    }
  } catch (_) {
    // proceed; exchange will reject if truly insufficient
  }

  const hedgeMode = await binance.getPositionMode(keys.apiKey, keys.apiSecret, mode).catch(() => false);
  const orderSide = direction === 'LONG' ? 'BUY' : 'SELL';

  await binance.setLeverageSafe(symbol, lev, keys.apiKey, keys.apiSecret, mode);

  const order = {
    symbol,
    side: orderSide,
    type: 'MARKET',
    quantity: qty,
  };
  if (hedgeMode) order.positionSide = direction;
  else order.reduceOnly = false;

  const placed = await binance.placeOrder(order, keys.apiKey, keys.apiSecret, mode);
  const orderId = placed?.orderId;

  if (!orderId) {
    return {
      ok: false,
      reason: 'Binance returned no order id',
      detail: placed,
    };
  }

  return {
    ok: true,
    orderId: String(orderId),
    symbol,
    direction,
    leverage: lev,
    marginUsdt,
    qty,
    notional,
    markPrice,
    mode,
    msg: `Market ${direction} ${symbol} · ${lev}x · margin ${marginUsdt} USDT`,
  };
}
