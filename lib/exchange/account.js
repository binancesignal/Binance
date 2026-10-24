/**
 * One shape for "what does this user's exchange account look like right now",
 * whichever exchange it is. Used by the dashboard and by key verification.
 */
import * as bybit from '../bybit/client.js';
import * as binancePriv from '../binance/private.js';

export const CONNECTION_MODES = ['mock', 'live'];

const n = (v) => (Number.isFinite(+v) ? +v : 0);

function decoratePosition(p) {
  const entry = n(p.avgPrice);
  const mark = n(p.markPrice);
  const isLong = p.side === 'Buy';
  const lev = n(p.leverage) || 1;
  const priceMovePct = entry > 0 && mark > 0 ? ((mark - entry) / entry) * 100 * (isLong ? 1 : -1) : 0;
  const margin = n(p.positionIM) || (n(p.positionValue) / lev);
  const pnl = n(p.unrealisedPnl);
  return {
    symbol: p.symbol,
    direction: isLong ? 'LONG' : 'SHORT',
    size: n(p.size),
    entry,
    mark,
    liq: p.liqPrice ? n(p.liqPrice) : null,
    pnl,
    // return on margin (what the exchange app shows as ROE)
    pnlPct: margin > 0 ? (pnl / margin) * 100 : priceMovePct * lev,
    leverage: lev,
    value: n(p.positionValue),
    margin,
    tp: p.takeProfit && +p.takeProfit > 0 ? +p.takeProfit : null,
    sl: p.stopLoss && +p.stopLoss > 0 ? +p.stopLoss : null,
  };
}

function decorateOrder(o) {
  return {
    id: o.orderId,
    symbol: o.symbol,
    direction: o.side === 'Buy' ? 'LONG' : 'SHORT',
    type: o.orderType,
    price: n(o.price),
    qty: n(o.qty),
    filled: n(o.cumExecQty),
    status: o.orderStatus,
    reduceOnly: !!o.reduceOnly,
    time: o.createdTime ? +o.createdTime : null,
  };
}

async function bybitOverview(apiKey, apiSecret, mode) {
  const base = bybit.baseUrlForMode(mode);
  let bal;
  try {
    bal = await bybit.getWalletBalance(apiKey, apiSecret, 'UNIFIED', base);
  } catch (e) {
    // classic (non-unified) accounts
    try {
      bal = await bybit.getWalletBalance(apiKey, apiSecret, 'CONTRACT', base);
    } catch (_) {
      throw e;
    }
  }
  const [positions, orders] = await Promise.all([
    bybit.getPositions(apiKey, apiSecret, 'USDT', base).catch(() => []),
    bybit.getOpenOrders(apiKey, apiSecret, 'USDT', base).catch(() => []),
  ]);
  const usdt = bal.coins.find((c) => c.coin === 'USDT');
  const pos = positions.map(decoratePosition);
  const upnl = pos.reduce((a, p) => a + p.pnl, 0);
  const equity = bal.totalEquity || usdt?.equity || 0;
  const available = bal.totalAvailableBalance ?? usdt?.available ?? null;
  return {
    balance: {
      equity,
      wallet: bal.totalWalletBalance || usdt?.wallet || 0,
      available,
      unrealizedPnl: upnl,
      usedMargin: pos.reduce((a, p) => a + p.margin, 0),
      currency: 'USDT',
      coins: bal.coins.map((c) => ({ coin: c.coin, equity: c.equity, usd: c.usdValue })),
    },
    positions: pos,
    orders: orders.map(decorateOrder),
  };
}

async function binanceOverview(apiKey, apiSecret, mode) {
  const [acc, positions, orders] = await Promise.all([
    binancePriv.getAccountSummary(apiKey, apiSecret, mode),
    binancePriv.getPositionRisk(apiKey, apiSecret, mode).catch(() => []),
    binancePriv.getOpenOrders(apiKey, apiSecret, mode).catch(() => []),
  ]);
  const pos = positions.map(decoratePosition);
  return {
    balance: {
      equity: acc.totalMarginBalance,
      wallet: acc.totalWalletBalance,
      available: acc.availableBalance,
      unrealizedPnl: acc.unrealisedPnl,
      usedMargin: acc.usedMargin,
      currency: 'USDT',
      coins: acc.assets.map((a) => ({ coin: a.coin, equity: a.equity, usd: a.usdValue })),
    },
    positions: pos,
    orders: orders.map(decorateOrder),
  };
}

/** @returns {Promise<{balance, positions, orders}>}  Throws on bad keys / network errors. */
export async function getAccountOverview(exchange, mode, apiKey, apiSecret) {
  const m = mode === 'live' ? 'live' : 'mock';
  if (exchange === 'bybit') return bybitOverview(apiKey, apiSecret, m);
  if (exchange === 'binance') return binanceOverview(apiKey, apiSecret, m);
  throw new Error(`Unsupported exchange: ${exchange}`);
}

/** Friendly message for the typical key mistakes. */
export function explainKeyError(exchange, mode, err) {
  const msg = String(err?.message || err || '');
  if (/10003|10004|invalid api|api key is invalid|-2014|-2015|invalid api-key/i.test(msg)) {
    return `${exchange === 'bybit' ? 'Bybit' : 'Binance'} rejected these keys. Check that they are ${mode === 'live' ? 'LIVE' : 'MOCK/TESTNET'} keys, copied fully, with Read permission${mode === 'live' ? '' : ' (and Trade for auto-trade)'}.`;
  }
  if (/10005|permission/i.test(msg)) return 'These keys do not have the required permission (enable Read + Trade, never Withdraw).';
  if (/10010|ip|whitelist/i.test(msg)) return 'The key has an IP restriction that blocks this server. Remove the IP restriction or add our server IP.';
  if (/451|geo/i.test(msg)) return 'The exchange is blocking this server region. Try again later or contact support.';
  return msg.slice(0, 200) || 'Could not verify the keys';
}
