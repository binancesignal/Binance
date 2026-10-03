/**
 * Bybit USDT linear + unified account API (public + private).
 * This application is hard-locked to Bybit TESTNET; environment variables and
 * saved state cannot redirect any request to production.
 */
import crypto from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TESTNET = 'https://api-testnet.bybit.com';
// Public market data (symbols / tickers / klines) comes from MAINNET so signals match real charts
// (TradingView). Private calls + order sizing/instrument rules stay on TESTNET.
const MAINNET = 'https://api.bybit.com';

function numericIfPresent(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class BybitApiError extends Error {
  constructor(data, path) {
    const retCode = data?.retCode ?? null;
    const retMsg = data?.retMsg || 'No response message';
    super(
      retCode == null
        ? `Bybit response missing retCode${path ? ` (${path})` : ''}: ${retMsg}`
        : `Bybit retCode=${retCode} retMsg=${retMsg}`
    );
    this.name = 'BybitApiError';
    this.retCode = retCode;
    this.retMsg = retMsg;
    this.path = path || null;
    this.response = data ?? null;
  }
}

/** Always resolve to Bybit TESTNET. Never trust environment or app-state overrides. */
export async function getBaseUrl() {
  return TESTNET;
}

export async function getMarketDataBaseUrl() {
  return MAINNET;
}

/** Testnet mark/last price for one symbol (public) — used to rebase signal levels before ordering. */
export async function getTestnetPrice(symbol) {
  const data = await fetchJSON(
    `${TESTNET}/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`
  );
  const t = data?.result?.list?.[0];
  if (!t) return null;
  const p = +t.markPrice > 0 ? +t.markPrice : +t.lastPrice;
  return p > 0 ? p : null;
}

export function isTestnetBase(base) {
  return /testnet/i.test(base || '');
}

const INTERVAL_MAP = {
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '2h': '120',
  '4h': '240',
  '6h': '360',
  '12h': '720',
  '1d': 'D',
};

const INTERVAL_SEC = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14400,
  '6h': 21600,
  '12h': 43200,
  '1d': 86400,
};

export async function fetchJSON(url, options = {}, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, {
        ...options,
        headers: {
          Accept: 'application/json',
          ...(options.headers || {}),
        },
        next: { revalidate: 0 },
      });
      if (r.status === 429) {
        await sleep(600 * (i + 1));
        continue;
      }
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status} ${t.slice(0, 160)}`);
      }
      return await r.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(400 * (i + 1));
    }
  }
}

export async function loadExchangeInfo() {
  const data = await fetchJSON(
    `${await getMarketDataBaseUrl()}/v5/market/instruments-info?category=linear&limit=1000`
  );
  const list = data?.result?.list || [];
  return list
    .filter(
      (s) =>
        s.status === 'Trading' &&
        s.quoteCoin === 'USDT' &&
        (s.contractType === 'LinearPerpetual' || !s.contractType)
    )
    .map((s) => s.symbol);
}

export async function loadTickers() {
  const data = await fetchJSON(`${await getMarketDataBaseUrl()}/v5/market/tickers?category=linear`);
  const list = data?.result?.list || [];
  const map = {};
  for (const t of list) {
    if (!t.symbol?.endsWith('USDT')) continue;
    map[t.symbol] = {
      price: +t.lastPrice,
      markPrice: +t.markPrice || null,
      markPriceSource: +t.markPrice > 0 ? 'MARK_PRICE' : 'LAST_PRICE_FALLBACK',
      change: +t.price24hPcnt * 100,
      volume: +t.turnover24h,
      high: +t.highPrice24h,
      low: +t.lowPrice24h,
    };
  }
  return map;
}

const klineCache = new Map();

export async function getKlines(symbol, interval, limit = 150, opts = {}) {
  const includeForming = !!opts.includeForming;
  const key = `bybit_${symbol}_${interval}_${limit}_${includeForming ? 'f' : 'c'}`;
  const now = Date.now();
  const cached = klineCache.get(key);
  if (cached && now - cached.ts < 60000) return cached.data;

  const bybitInterval = INTERVAL_MAP[interval] || '60';
  const fetchLimit = includeForming ? limit : Math.min(limit + 1, 1000);
  const base = await getMarketDataBaseUrl();
  const url = `${base}/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval}&limit=${fetchLimit}`;
  const data = await fetchJSON(url);
  const list = data?.result?.list || [];
  let candles = list
    .map((c) => ({
      time: Math.floor(+c[0] / 1000),
      open: +c[1],
      high: +c[2],
      low: +c[3],
      close: +c[4],
      volume: +c[5],
      closed: true,
    }))
    .reverse();

  if (!includeForming && candles.length) {
    const sec = INTERVAL_SEC[interval] || 300;
    const nowSec = Math.floor(Date.now() / 1000);
    const last = candles[candles.length - 1];
    if (last.time + sec > nowSec) candles = candles.slice(0, -1);
  }
  if (candles.length > limit) candles = candles.slice(candles.length - limit);
  klineCache.set(key, { data: candles, ts: now });
  return candles;
}

export function clearKlineCache() {
  klineCache.clear();
}

/** Signed private request (GET query or POST JSON body) */
export async function signedRequest(method, path, params, apiKey, apiSecret) {
  const base = await getBaseUrl();
  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const p = params || {};
  let query = '';
  let body = '';
  if (method === 'GET') {
    query = Object.keys(p)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]))}`)
      .join('&');
  } else {
    body = JSON.stringify(p);
  }
  const preSign =
    method === 'GET'
      ? `${timestamp}${apiKey}${recvWindow}${query}`
      : `${timestamp}${apiKey}${recvWindow}${body}`;
  const sign = crypto.createHmac('sha256', apiSecret).update(preSign).digest('hex');
  const url = query ? `${base}${path}?${query}` : `${base}${path}`;
  const headers = {
    'X-BAPI-API-KEY': apiKey,
    'X-BAPI-SIGN': sign,
    'X-BAPI-TIMESTAMP': timestamp,
    'X-BAPI-RECV-WINDOW': recvWindow,
    'Content-Type': 'application/json',
  };
  const options =
    method === 'GET'
      ? { method: 'GET', headers }
      : { method, headers, body };
  const data = await fetchJSON(url, options);
  if (!data || Number(data.retCode) !== 0) {
    throw new BybitApiError(data, path);
  }
  return data;
}

async function withKeys(fn, apiKey, apiSecret) {
  if (!apiKey || !apiSecret) throw new Error('Bybit API keys not configured');
  return fn(apiKey, apiSecret);
}

export async function getWalletBalance(apiKey, apiSecret, accountType = 'UNIFIED') {
  const data = await signedRequest(
    'GET',
    '/v5/account/wallet-balance',
    { accountType },
    apiKey,
    apiSecret
  );
  const list = data?.result?.list || [];
  const account = list[0] || {};
  const coins = (account.coin || []).map((c) => {
    const available = [
      c.availableToTrade,
      c.availableBalance,
      c.availableToWithdraw,
      c.availableToConvert,
    ]
      .map(numericIfPresent)
      .find((value) => value != null);
    return {
      coin: c.coin,
      equity: +c.equity || 0,
      // Never substitute wallet balance/equity for tradeable funds.
      available,
      wallet: +c.walletBalance || 0,
      usdValue: +c.usdValue || 0,
    };
  });
  return {
    accountType,
    totalEquity: +account.totalEquity || 0,
    totalWalletBalance: +account.totalWalletBalance || 0,
    totalAvailableBalance: numericIfPresent(account.totalAvailableBalance),
    coins: coins.filter((c) => c.equity > 0 || c.wallet > 0 || c.usdValue > 0 || +c.available > 0),
  };
}

export async function getPositions(apiKey, apiSecret, settleCoin = 'USDT') {
  const data = await signedRequest(
    'GET',
    '/v5/position/list',
    { category: 'linear', settleCoin },
    apiKey,
    apiSecret
  );
  const list = data?.result?.list || [];
  return list
    .filter((p) => Math.abs(+p.size) > 0)
    .map((p) => ({
      symbol: p.symbol,
      side: p.side,
      size: +p.size,
      avgPrice: +p.avgPrice,
      positionIdx: Number(p.positionIdx ?? 0),
      positionStatus: p.positionStatus || null,
      markPrice: +p.markPrice,
      liqPrice: +p.liqPrice || null,
      unrealisedPnl: +p.unrealisedPnl,
      leverage: +p.leverage,
      positionValue: +p.positionValue,
      takeProfit: p.takeProfit || null,
      stopLoss: p.stopLoss || null,
      createdTime: p.createdTime,
    }));
}

export async function getOpenOrders(apiKey, apiSecret, settleCoin = 'USDT') {
  const data = await signedRequest(
    'GET',
    '/v5/order/realtime',
    { category: 'linear', settleCoin, limit: 50 },
    apiKey,
    apiSecret
  );
  const list = data?.result?.list || [];
  return list.map((o) => ({
    orderId: o.orderId,
    symbol: o.symbol,
    side: o.side,
    orderType: o.orderType,
    price: +o.price || 0,
    qty: +o.qty,
    cumExecQty: +o.cumExecQty,
    orderStatus: o.orderStatus,
    reduceOnly: o.reduceOnly === true || o.reduceOnly === '1',
    createdTime: o.createdTime,
    takeProfit: o.takeProfit || null,
    stopLoss: o.stopLoss || null,
  }));
}

export async function getOrderHistory(apiKey, apiSecret, settleCoin = 'USDT') {
  const data = await signedRequest(
    'GET',
    '/v5/order/history',
    { category: 'linear', settleCoin, limit: 30 },
    apiKey,
    apiSecret
  );
  const list = data?.result?.list || [];
  return list.map((o) => ({
    orderId: o.orderId,
    symbol: o.symbol,
    side: o.side,
    orderType: o.orderType,
    price: +o.price || 0,
    qty: +o.qty,
    cumExecQty: +o.cumExecQty,
    avgPrice: +o.avgPrice || 0,
    orderStatus: o.orderStatus,
    createdTime: o.createdTime,
    updatedTime: o.updatedTime,
  }));
}

/**
 * Place linear order.
 * body: { symbol, side: Buy|Sell, orderType: Market|Limit, qty, price?, reduceOnly?, takeProfit?, stopLoss? }
 */
export async function placeOrder(apiKey, apiSecret, body) {
  const payload = {
    category: 'linear',
    symbol: body.symbol,
    side: body.side,
    orderType: body.orderType || 'Limit',
    qty: String(body.qty),
    timeInForce: body.orderType === 'Market' ? 'IOC' : body.timeInForce || 'GTC',
    reduceOnly: !!body.reduceOnly,
  };
  if (body.orderType !== 'Market' && body.price != null) {
    payload.price = String(body.price);
  }
  if (body.takeProfit) payload.takeProfit = String(body.takeProfit);
  if (body.stopLoss) payload.stopLoss = String(body.stopLoss);
  if (body.positionIdx != null) payload.positionIdx = body.positionIdx;
  if (body.orderLinkId) payload.orderLinkId = String(body.orderLinkId);
  const data = await signedRequest('POST', '/v5/order/create', payload, apiKey, apiSecret);
  return {
    ...(data?.result || {}),
    retCode: data.retCode,
    retMsg: data.retMsg,
  };
}

export async function cancelOrder(apiKey, apiSecret, { symbol, orderId }) {
  const data = await signedRequest(
    'POST',
    '/v5/order/cancel',
    { category: 'linear', symbol, orderId },
    apiKey,
    apiSecret
  );
  return data?.result || data;
}

export async function setTradingStop(apiKey, apiSecret, body) {
  const payload = {
    category: 'linear',
    symbol: body.symbol,
    tpslMode: body.tpslMode || 'Full',
    positionIdx: body.positionIdx ?? 0,
  };
  if (body.takeProfit != null) payload.takeProfit = String(body.takeProfit);
  if (body.stopLoss != null) payload.stopLoss = String(body.stopLoss);
  const data = await signedRequest(
    'POST',
    '/v5/position/trading-stop',
    payload,
    apiKey,
    apiSecret
  );
  return {
    ...(data?.result || {}),
    retCode: data.retCode,
    retMsg: data.retMsg,
  };
}

/** Internal transfer (requires Wallet transfer permission) */
export async function createInternalTransfer(apiKey, apiSecret, body) {
  const payload = {
    transferId: body.transferId || crypto.randomUUID(),
    coin: body.coin || 'USDT',
    amount: String(body.amount),
    fromAccountType: body.fromAccountType,
    toAccountType: body.toAccountType,
  };
  const data = await signedRequest(
    'POST',
    '/v5/asset/transfer/inter-transfer',
    payload,
    apiKey,
    apiSecret
  );
  return data?.result || data;
}

/** Instrument info for one linear symbol (qty/price filters + leverage) */
export async function getInstrumentInfo(symbol) {
  const data = await fetchJSON(
    `${await getBaseUrl()}/v5/market/instruments-info?category=linear&symbol=${encodeURIComponent(symbol)}`
  );
  const item = data?.result?.list?.[0];
  if (!item) throw new Error(`Instrument not found: ${symbol}`);
  const lot = item.lotSizeFilter || {};
  const price = item.priceFilter || {};
  const lev = item.leverageFilter || {};
  return {
    symbol: item.symbol,
    status: item.status,
    qtyStep: +lot.qtyStep || 0.001,
    minOrderQty: +lot.minOrderQty || 0,
    maxOrderQty: +lot.maxOrderQty || 0,
    minNotionalValue: +lot.minNotionalValue || 0,
    tickSize: +price.tickSize || 0.01,
    minLeverage: +lev.minLeverage || 1,
    maxLeverage: +lev.maxLeverage || 50,
    leverageStep: +lev.leverageStep || 1,
  };
}

export async function setLeverage(apiKey, apiSecret, symbol, leverage) {
  const lev = String(leverage);
  try {
    const data = await signedRequest(
      'POST',
      '/v5/position/set-leverage',
      {
        category: 'linear',
        symbol,
        buyLeverage: lev,
        sellLeverage: lev,
      },
      apiKey,
      apiSecret
    );
    return data?.result || data;
  } catch (e) {
    // Bybit returns error if leverage unchanged — treat as ok
    if (/not modified|same leverage/i.test(e.message)) return { ok: true };
    throw e;
  }
}

export async function getOrderRealtime(apiKey, apiSecret, { symbol, orderId, orderLinkId }) {
  const identifier = orderId
    ? { orderId }
    : orderLinkId
      ? { orderLinkId }
      : null;
  if (!identifier) throw new Error('orderId or orderLinkId is required for order verification');

  const params = { category: 'linear', symbol, ...identifier };
  const realtime = await signedRequest(
    'GET',
    '/v5/order/realtime',
    params,
    apiKey,
    apiSecret
  );
  const liveOrder = realtime?.result?.list?.[0];
  if (liveOrder) return liveOrder;

  const history = await signedRequest(
    'GET',
    '/v5/order/history',
    params,
    apiKey,
    apiSecret
  );
  return history?.result?.list?.[0] || null;
}

/** Close position with market reduce-only */
export async function closePosition(apiKey, apiSecret, { symbol, side, qty }) {
  // side of position: Buy = long → close with Sell
  const closeSide = side === 'Buy' || side === 'LONG' ? 'Sell' : 'Buy';
  return placeOrder(apiKey, apiSecret, {
    symbol,
    side: closeSide,
    orderType: 'Market',
    qty,
    reduceOnly: true,
  });
}

export function roundToStep(value, step) {
  if (!step || step <= 0) return value;
  const stepText = String(Number(step));
  const precision = stepText.includes('e-')
    ? (stepText.split('e-')[0].split('.')[1] || '').length + Number(stepText.split('e-')[1])
    : Math.max(0, (stepText.split('.')[1] || '').length);
  const rounded = Math.floor(+value / step + 1e-12) * step;
  return +rounded.toFixed(precision);
}

export function roundPriceToTick(price, tickSize) {
  return roundToStep(price, tickSize);
}
