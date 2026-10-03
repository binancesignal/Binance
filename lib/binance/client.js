/**
 * Binance Futures public API client with retries & rate-limit handling.
 */
import { SIGNAL_CONFIG } from '../config/signalConfig.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export async function fetchJSON(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, {
        headers: { Accept: 'application/json' },
        next: { revalidate: 0 },
      });
      if (r.status === 429) {
        await sleep(600 * (i + 1));
        continue;
      }
      if (r.status === 451) {
        throw new Error(
          'HTTP 451: Binance is geo-blocking this server\'s region. Set "regions" in vercel.json to a non-US region (e.g. sin1) and redeploy.'
        );
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === retries - 1 || e.message.startsWith('HTTP 451')) throw e;
      await sleep(400 * (i + 1));
    }
  }
}

export async function loadExchangeInfo() {
  const base = SIGNAL_CONFIG.binanceBaseUrl;
  const data = await fetchJSON(`${base}/fapi/v1/exchangeInfo`);
  return data.symbols
    .filter(
      (s) =>
        s.contractType === 'PERPETUAL' &&
        s.quoteAsset === 'USDT' &&
        s.status === 'TRADING'
    )
    .map((s) => s.symbol);
}

export async function loadTickers() {
  const base = SIGNAL_CONFIG.binanceBaseUrl;
  const [tickerResult, markResult] = await Promise.allSettled([
    fetchJSON(`${base}/fapi/v1/ticker/24hr`),
    fetchJSON(`${base}/fapi/v1/premiumIndex`),
  ]);
  if (tickerResult.status === 'rejected') throw tickerResult.reason;
  const data = tickerResult.value;
  const marks = markResult.status === 'fulfilled' ? markResult.value : [];
  if (markResult.status === 'rejected') {
    console.warn('[binance] mark-price feed unavailable; active signals will use fresh last price', markResult.reason?.message);
  }
  const markBySymbol = new Map(
    (Array.isArray(marks) ? marks : [])
      .filter((item) => item?.symbol && +item.markPrice > 0)
      .map((item) => [item.symbol, +item.markPrice])
  );
  const map = {};
  for (const t of data) {
    if (t.symbol?.endsWith('USDT')) {
      const markPrice = markBySymbol.get(t.symbol) || null;
      map[t.symbol] = {
        price: +t.lastPrice,
        markPrice,
        markPriceSource: markPrice ? 'MARK_PRICE' : 'LAST_PRICE_FALLBACK',
        change: +t.priceChangePercent,
        volume: +t.quoteVolume,
        high: +t.highPrice,
        low: +t.lowPrice,
      };
    }
  }
  return map;
}

/** Simple in-memory cache for klines (per serverless invocation) */
const klineCache = new Map();

/**
 * Fetch klines. By default returns CLOSED candles only (drops the
 * currently-forming bar) so TA uses completed structure only.
 * Pass { includeForming: true } when you need the live bar for lifecycle.
 */
export async function getKlines(symbol, interval, limit = 150, opts = {}) {
  const includeForming = !!opts.includeForming;
  const key = `${symbol}_${interval}_${limit}_${includeForming ? 'f' : 'c'}`;
  const now = Date.now();
  const cached = klineCache.get(key);
  if (cached && now - cached.ts < SIGNAL_CONFIG.klineCacheMs) {
    return cached.data;
  }
  const base = SIGNAL_CONFIG.binanceBaseUrl;
  // fetch one extra so after dropping forming we still have `limit` closed
  const fetchLimit = includeForming ? limit : Math.min(limit + 1, 1500);
  const url = `${base}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${fetchLimit}`;
  const raw = await fetchJSON(url);
  let candles = raw.map((c) => ({
    time: Math.floor(c[0] / 1000),
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4],
    volume: +c[5],
    closed: true,
  }));

  if (!includeForming && candles.length) {
    const sec = INTERVAL_SEC[interval] || 300;
    const nowSec = Math.floor(Date.now() / 1000);
    const last = candles[candles.length - 1];
    // still forming if bar open + interval > now
    if (last.time + sec > nowSec) {
      candles = candles.slice(0, -1);
    }
  }

  if (candles.length > limit) {
    candles = candles.slice(candles.length - limit);
  }

  klineCache.set(key, { data: candles, ts: now });
  return candles;
}

export function clearKlineCache() {
  klineCache.clear();
}
