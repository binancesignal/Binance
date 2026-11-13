/** Binance USDⓈ-M Futures account and execution APIs. */
import crypto from 'node:crypto';

const LIVE = 'https://fapi.binance.com';
const TESTNET = 'https://testnet.binancefuture.com';

export function baseUrlForMode(mode) {
  return mode === 'live' ? LIVE : TESTNET;
}

export class BinanceApiError extends Error {
  constructor(status, data, path) {
    const code = data?.code ?? null;
    const msg = data?.msg || `HTTP ${status}`;
    super(`Binance ${code != null ? `code=${code} ` : ''}${msg}`);
    this.name = 'BinanceApiError';
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

function signedQuery(params, apiSecret) {
  const clean = Object.fromEntries(
    Object.entries(params || {})
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, typeof value === 'boolean' ? String(value) : String(value)])
  );
  const query = new URLSearchParams({
    ...clean,
    recvWindow: '5000',
    timestamp: String(Date.now()),
  }).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

export async function signedRequest(method, path, params, apiKey, apiSecret, mode = 'mock') {
  const base = baseUrlForMode(mode);
  const query = signedQuery(params, apiSecret);
  const url = `${base}${path}?${query}`;
  const r = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': apiKey, Accept: 'application/json' },
    cache: 'no-store',
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {}
  if (r.status === 451) {
    throw new Error('Binance is geo-blocking this server region (HTTP 451)');
  }
  if (!r.ok || (data && typeof data === 'object' && data.code && data.code < 0)) {
    throw new BinanceApiError(r.status, data, path);
  }
  return data;
}

export async function signedGet(path, params, apiKey, apiSecret, mode = 'mock') {
  return signedRequest('GET', path, params, apiKey, apiSecret, mode);
}

export async function signedPost(path, params, apiKey, apiSecret, mode = 'mock') {
  return signedRequest('POST', path, params, apiKey, apiSecret, mode);
}

export async function signedDelete(path, params, apiKey, apiSecret, mode = 'mock') {
  return signedRequest('DELETE', path, params, apiKey, apiSecret, mode);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function getAccountSummary(apiKey, apiSecret, mode) {
  const a = await signedGet('/fapi/v2/account', {}, apiKey, apiSecret, mode);
  return {
    totalWalletBalance: num(a.totalWalletBalance),
    totalMarginBalance: num(a.totalMarginBalance),
    availableBalance: num(a.availableBalance),
    unrealisedPnl: num(a.totalUnrealizedProfit),
    usedMargin: num(a.totalPositionInitialMargin) + num(a.totalOpenOrderInitialMargin),
    assets: (a.assets || [])
      .filter((x) => num(x.walletBalance) > 0 || num(x.marginBalance) > 0)
      .map((x) => ({
        coin: x.asset,
        wallet: num(x.walletBalance),
        equity: num(x.marginBalance),
        available: num(x.availableBalance),
        usdValue: num(x.marginBalance),
      })),
  };
}

export async function getPositionRisk(apiKey, apiSecret, mode) {
  const list = await signedGet('/fapi/v2/positionRisk', {}, apiKey, apiSecret, mode);
  return (Array.isArray(list) ? list : [])
    .filter((p) => Math.abs(num(p.positionAmt)) > 0)
    .map((p) => {
      const amt = num(p.positionAmt);
      const positionSide = p.positionSide || 'BOTH';
      const leverage = num(p.leverage) > 0 ? num(p.leverage) : 1;
      const notional = Math.abs(num(p.notional));
      // Prefer exchange-reported margin; notional/leverage is a fallback only.
      const isolated = num(p.isolatedMargin);
      const initial = num(p.positionInitialMargin) || num(p.initialMargin);
      const margin =
        isolated > 0 ? isolated : initial > 0 ? initial : notional > 0 ? notional / leverage : 0;
      return {
        symbol: p.symbol,
        side: positionSide === 'LONG' ? 'Buy' : positionSide === 'SHORT' ? 'Sell' : amt > 0 ? 'Buy' : 'Sell',
        positionSide,
        size: Math.abs(amt),
        avgPrice: num(p.entryPrice),
        markPrice: num(p.markPrice),
        liqPrice: num(p.liquidationPrice) || null,
        unrealisedPnl: num(p.unRealizedProfit),
        leverage,
        positionValue: notional,
        margin,
        takeProfit: null,
        stopLoss: null,
        marginType: p.marginType || null,
      };
    });
}

/** Income ledger (REALIZED_PNL, COMMISSION, FUNDING_FEE...) - the source of truth for a trade's net result. */
export async function getIncomeHistory({ symbol, startTime, endTime, limit = 1000 } = {}, apiKey, apiSecret, mode = 'mock') {
  const params = { limit };
  if (symbol) params.symbol = symbol;
  if (startTime != null) params.startTime = Math.floor(startTime);
  if (endTime != null && Number.isFinite(endTime)) params.endTime = Math.floor(endTime);
  const list = await signedGet('/fapi/v1/income', params, apiKey, apiSecret, mode);
  return (Array.isArray(list) ? list : []).map((r) => ({
    symbol: r.symbol,
    type: r.incomeType,
    income: num(r.income),
    time: num(r.time),
  }));
}

export async function getOpenOrders(apiKey, apiSecret, mode) {
  const list = await signedGet('/fapi/v1/openOrders', {}, apiKey, apiSecret, mode);
  return (Array.isArray(list) ? list : []).map((o) => ({
    orderId: String(o.orderId),
    symbol: o.symbol,
    side: o.side === 'BUY' ? 'Buy' : 'Sell',
    orderType: o.type,
    price: num(o.price) || num(o.stopPrice),
    qty: num(o.origQty),
    cumExecQty: num(o.executedQty),
    orderStatus: o.status,
    reduceOnly: !!o.reduceOnly,
    createdTime: o.time,
  }));
}

/** The Futures premium-index endpoint provides the execution venue's mark price. */
export async function getMarkPrice(symbol, mode = 'mock') {
  const base = baseUrlForMode(mode);
  const response = await fetch(
    `${base}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`,
    { headers: { Accept: 'application/json' }, cache: 'no-store' }
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || !Number(data?.markPrice)) {
    throw new Error(data?.msg || `Binance mark price unavailable (HTTP ${response.status})`);
  }
  return Number(data.markPrice);
}

const exchangeInfoCache = new Map();
export async function getExchangeInfo(mode = 'mock') {
  const cached = exchangeInfoCache.get(mode);
  if (cached && Date.now() - cached.at < 15 * 60 * 1000) return cached.data;
  const response = await fetch(`${baseUrlForMode(mode)}/fapi/v1/exchangeInfo`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data?.symbols)) {
    throw new Error(data?.msg || `Binance exchange info unavailable (HTTP ${response.status})`);
  }
  exchangeInfoCache.set(mode, { at: Date.now(), data });
  return data;
}

export async function getInstrumentInfo(symbol, mode = 'mock') {
  const info = await getExchangeInfo(mode);
  const item = info.symbols.find((entry) => entry.symbol === symbol && entry.status === 'TRADING');
  if (!item) throw new Error(`Binance instrument ${symbol} is not trading`);
  const filters = Object.fromEntries((item.filters || []).map((filter) => [filter.filterType, filter]));
  const lot = filters.MARKET_LOT_SIZE?.stepSize && +filters.MARKET_LOT_SIZE.stepSize > 0
    ? filters.MARKET_LOT_SIZE
    : filters.LOT_SIZE;
  const price = filters.PRICE_FILTER;
  const notional = filters.NOTIONAL || filters.MIN_NOTIONAL;
  const instrument = {
    symbol,
    qtyStep: num(lot?.stepSize) || 0.001,
    minOrderQty: num(lot?.minQty) || 0,
    maxOrderQty: num(lot?.maxQty),
    tickSize: num(price?.tickSize) || 0.01,
    minNotionalValue: num(notional?.minNotional || notional?.notional),
    maxLeverage: 125,
    leverageStep: 1,
  };
  if (!instrument.minOrderQty || !instrument.qtyStep) {
    throw new Error(`Binance quantity filters missing for ${symbol}`);
  }
  return instrument;
}

export async function setLeverage(symbol, leverage, apiKey, apiSecret, mode = 'mock') {
  return signedPost('/fapi/v1/leverage', { symbol, leverage }, apiKey, apiSecret, mode);
}

export async function getPositionMode(apiKey, apiSecret, mode = 'mock') {
  const result = await signedGet('/fapi/v1/positionSide/dual', {}, apiKey, apiSecret, mode);
  return !!result?.dualSidePosition;
}

export async function placeOrder(
  { symbol, side, type = 'MARKET', quantity, price, timeInForce, reduceOnly, ...other },
  apiKey,
  apiSecret,
  mode = 'mock'
) {
  return signedPost(
    '/fapi/v1/order',
    {
      symbol,
      side: String(side).toUpperCase(),
      type: String(type).toUpperCase(),
      quantity,
      price,
      timeInForce: timeInForce || (String(type).toUpperCase() === 'LIMIT' ? 'GTC' : undefined),
      reduceOnly: reduceOnly === undefined ? undefined : String(!!reduceOnly),
      newOrderRespType: 'RESULT',
      ...other,
    },
    apiKey,
    apiSecret,
    mode
  );
}

export async function getOrderRealtime({ symbol, orderId, origClientOrderId }, apiKey, apiSecret, mode = 'mock') {
  const order = await signedGet(
    '/fapi/v1/order',
    { symbol, orderId, origClientOrderId },
    apiKey,
    apiSecret,
    mode
  );
  return {
    ...order,
    orderId: String(order.orderId),
    orderStatus: order.status,
    cumExecQty: num(order.executedQty),
    avgPrice: num(order.avgPrice),
    updatedTime: order.updateTime,
  };
}

/** Cancel a regular order. Use cancelAlgoOrder for conditional stop/TP orders. */
export async function cancelOrder({ symbol, orderId, origClientOrderId }, apiKey, apiSecret, mode = 'mock') {
  return signedDelete(
    '/fapi/v1/order',
    { symbol, orderId, origClientOrderId },
    apiKey,
    apiSecret,
    mode
  );
}

export async function cancelAlgoOrder({ algoId, clientAlgoId }, apiKey, apiSecret, mode = 'mock') {
  return signedDelete(
    '/fapi/v1/algoOrder',
    { algoId, clientAlgoId },
    apiKey,
    apiSecret,
    mode
  );
}

/**
 * Futures protective stops use CONDITIONAL algo orders. One-way mode uses
 * `closePosition=true`; hedge mode specifies the position side and filled quantity.
 */
export async function setStopLossTakeProfit(
  { symbol, positionSide, stopLoss, takeProfit, hedgeMode = false, quantity },
  apiKey,
  apiSecret,
  mode = 'mock'
) {
  const side = String(positionSide).toUpperCase() === 'LONG' ? 'SELL' : 'BUY';
  const orders = { stopLoss: null, takeProfit: null, errors: [] };
  const common = hedgeMode
    ? { positionSide: String(positionSide).toUpperCase(), quantity }
    : { closePosition: 'true' };
  if (stopLoss != null) {
    try {
      orders.stopLoss = await signedPost('/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL',
        symbol,
        side,
        type: 'STOP_MARKET',
        triggerPrice: stopLoss,
        workingType: 'MARK_PRICE',
        ...common,
      }, apiKey, apiSecret, mode);
    } catch (error) {
      orders.errors.push({ type: 'stopLoss', message: error.message });
    }
  }
  if (takeProfit != null) {
    try {
      orders.takeProfit = await signedPost('/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL',
        symbol,
        side,
        type: 'TAKE_PROFIT_MARKET',
        triggerPrice: takeProfit,
        workingType: 'MARK_PRICE',
        ...common,
      }, apiKey, apiSecret, mode);
    } catch (error) {
      orders.errors.push({ type: 'takeProfit', message: error.message });
    }
  }
  return orders;
}

export function roundToStep(value, step) {
  const n = Number(value);
  const s = Number(step);
  if (!Number.isFinite(n) || !(s > 0)) return n;
  const precision = Math.max(0, (String(s).split('.')[1] || '').length);
  return Number((Math.floor(n / s + 1e-12) * s).toFixed(precision));
}

export function roundPriceToTick(value, tick) {
  const n = Number(value);
  const s = Number(tick);
  if (!Number.isFinite(n) || !(s > 0)) return n;
  const precision = Math.max(0, (String(s).split('.')[1] || '').length);
  return Number((Math.round(n / s) * s).toFixed(precision));
}

// ─── manual close helpers ────────────────────────────────────────

/** Cancel every regular open order (limit entries, reduce-only orders) on one symbol. */
export async function cancelAllOpenOrders(symbol, apiKey, apiSecret, mode = 'mock') {
  return signedDelete('/fapi/v1/allOpenOrders', { symbol }, apiKey, apiSecret, mode);
}

/** Cancel every conditional (algo) order - the stop-loss / take-profit orders - on one symbol. */
export async function cancelAllAlgoOrders(symbol, apiKey, apiSecret, mode = 'mock') {
  return signedDelete('/fapi/v1/algoOpenOrders', { symbol }, apiKey, apiSecret, mode);
}

/**
 * Close a whole position at market price.
 * `position` comes from getPositionRisk(). One-way mode uses reduceOnly; hedge mode names the
 * position side instead (Binance rejects reduceOnly there).
 */
export async function closePositionMarket(position, apiKey, apiSecret, mode = 'mock') {
  const hedge = position.positionSide === 'LONG' || position.positionSide === 'SHORT';
  const closeSide = position.side === 'Buy' ? 'SELL' : 'BUY';
  const order = { symbol: position.symbol, side: closeSide, type: 'MARKET', quantity: position.size };
  if (hedge) order.positionSide = position.positionSide;
  else order.reduceOnly = true;
  return placeOrder(order, apiKey, apiSecret, mode);
}

// ─── leverage safety ─────────────────────────────────────────────

/** The highest leverage Binance allows on this symbol (from its leverage brackets), or null if unknown. */
export async function getMaxLeverage(symbol, apiKey, apiSecret, mode = 'mock') {
  const data = await signedGet('/fapi/v1/leverageBracket', { symbol }, apiKey, apiSecret, mode);
  const entry = Array.isArray(data) ? data.find((d) => d.symbol === symbol) || data[0] : data;
  const levs = (entry?.brackets || []).map((b) => Number(b.initialLeverage)).filter((n) => n > 0);
  return levs.length ? Math.max(...levs) : null;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Set leverage, retrying the transient "-1000 unknown error" Binance (especially the testnet) sometimes
 * returns. Setting the same leverage twice is harmless, so retrying is safe - unlike placing an order.
 * The error message names the step so a failure in the alert is easy to diagnose.
 */
export async function setLeverageSafe(symbol, leverage, apiKey, apiSecret, mode = 'mock', { retries = 2, delayMs = 600 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await setLeverage(symbol, leverage, apiKey, apiSecret, mode);
    } catch (e) {
      lastError = e;
      const transient = e?.code === -1000 || e?.code === -1001 || e?.code === -1007 || !e?.code;
      if (!transient || attempt === retries) break;
      await sleepMs(delayMs * (attempt + 1));
    }
  }
  const wrapped = new Error(`setLeverage ${symbol} ${leverage}x failed: ${lastError.message}`);
  wrapped.code = lastError.code;
  wrapped.step = 'setLeverage';
  throw wrapped;
}
