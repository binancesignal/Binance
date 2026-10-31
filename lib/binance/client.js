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
  '1w': 604800,
  '1M': 30 * 86400, // approximate for forming-check / expiry
  '3M': 90 * 86400,
  '1Y': 365 * 86400,
};

// ─────────────────────────────────────────────────────────────────────────────
// Ban / rate-limit guard
//  - HTTP 418 = this IP is banned by Binance. Stop immediately, remember "banned until", and let
//    every later call (this run AND later cron runs, via app_state) skip the network entirely —
//    hammering a banned IP only lengthens the ban.
//  - Binance reports the IP's used weight in `x-mbx-used-weight-1m`. On a shared Vercel IP other
//    tenants use the same 2400/min budget, so we slow down BEFORE reaching the limit.
// ─────────────────────────────────────────────────────────────────────────────
const WEIGHT_SOFT_LIMIT = +process.env.BINANCE_WEIGHT_SOFT_LIMIT || 1400; // of 2400 / min
const GUARD_MAX_WAIT_MS = +process.env.BINANCE_GUARD_MAX_WAIT_MS || 20_000;
const DEFAULT_418_BAN_MS = 5 * 60_000;

let banUntil = 0;
let weightSeen = { used: 0, at: 0 };
let guardTripped = false;

export const BAN_STATE_KEY = 'exchange_ban_until:binance';
export const getBanUntil = () => banUntil;
export const isRateGuardTripped = () => guardTripped;
export function resetRateGuard() {
  guardTripped = false;
}
export function setBanUntil(ts) {
  if (+ts > banUntil) banUntil = +ts;
}
/** test hook */
export function _resetGuardForTests() {
  banUntil = 0;
  weightSeen = { used: 0, at: 0 };
  guardTripped = false;
}

function banError(until, why) {
  const e = new Error(`HTTP 418: Binance banned this IP until ${new Date(until).toISOString()}${why ? ` (${why})` : ''}`);
  e.banned = true;
  e.banUntil = until;
  return e;
}

async function persistBan(until, reason) {
  try {
    const { setState } = await import('../database/appState.js');
    await setState(BAN_STATE_KEY, { until, reason, at: new Date().toISOString() });
  } catch (_) {}
}

/** Parse "banned until 1700000000000" out of Binance's 418/429 body. */
export function parseBanUntil(text) {
  const m = /banned until (\d{10,13})/i.exec(String(text || ''));
  if (!m) return 0;
  const n = +m[1];
  return n < 1e12 ? n * 1000 : n;
}

async function respectWeightBudget() {
  const waitStart = Date.now();
  while (weightSeen.used >= WEIGHT_SOFT_LIMIT) {
    const age = Date.now() - weightSeen.at;
    if (age >= 60_000) {
      weightSeen = { used: 0, at: 0 }; // the 1-minute window has rolled over
      return;
    }
    if (Date.now() - waitStart >= GUARD_MAX_WAIT_MS) {
      guardTripped = true;
      const e = new Error(`RATE_GUARD: Binance used weight ${weightSeen.used}/2400 — pausing scan to avoid a ban`);
      e.throttled = true;
      throw e;
    }
    await sleep(Math.min(1000, 60_000 - age));
  }
}

export async function fetchJSON(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    if (Date.now() < banUntil) throw banError(banUntil, 'cached');
    await respectWeightBudget();
    try {
      const r = await fetch(url, {
        headers: { Accept: 'application/json' },
        next: { revalidate: 0 },
      });
      const used = +r.headers?.get?.('x-mbx-used-weight-1m');
      if (Number.isFinite(used) && used > 0) weightSeen = { used, at: Date.now() };
      if (r.status === 418) {
        const body = await r.text().catch(() => '');
        const until = parseBanUntil(body) || Date.now() + DEFAULT_418_BAN_MS;
        setBanUntil(until);
        await persistBan(until, 'HTTP 418');
        throw banError(until);
      }
      if (r.status === 429) {
        const retryAfter = +r.headers?.get?.('retry-after') || 0;
        if (i < retries - 1) {
          await sleep(Math.min(Math.max(retryAfter * 1000, 800 * (i + 1)), 5000));
          continue;
        }
        // still 429 after the retry: back off hard BEFORE Binance escalates to a 418 ban
        const until = Date.now() + Math.max(retryAfter * 1000, 60_000);
        setBanUntil(until);
        await persistBan(until, 'HTTP 429');
        throw banError(until, 'rate limited');
      }
      if (r.status === 451) {
        throw new Error(
          'HTTP 451: Binance is geo-blocking this server\'s region. Set "regions" in vercel.json to a non-US region (e.g. sin1) and redeploy.'
        );
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (e.banned || e.throttled || i === retries - 1 || e.message.startsWith('HTTP 451')) throw e;
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

/**
 * In-memory kline cache (lives as long as the warm serverless instance).
 *
 * CLOSED-candle data cannot change until the next bar closes, so re-downloading a 1h/4h/1d/1w
 * series every minute is pure wasted API weight. Closed-only entries therefore stay valid until
 * the next bar close (derived from the data itself, so it works for 1w too). Entries that include
 * the forming bar keep the short `klineCacheMs` TTL. Strategies see exactly the same candles.
 */
const klineCache = new Map();
const KLINE_CACHE_MAX = +process.env.KLINE_CACHE_MAX || 2500;
const KLINE_STALE_RECHECK_MS = 5_000; // data missing the newest closed bar → look again soon

/** When should a cached CLOSED-candle series expire? (ms epoch) */
export function klineExpiry(candles, interval, now = Date.now(), includeForming = false, baseMs = SIGNAL_CONFIG.klineCacheMs) {
  const sec = INTERVAL_SEC[interval];
  if (includeForming || !sec || !candles?.length) return now + baseMs;
  const lastOpen = candles[candles.length - 1].time; // open time (s) of the newest CLOSED bar
  const nextClose = (lastOpen + 2 * sec) * 1000 + 1500; // the following bar closes at open+2*sec
  const capped = Math.min(nextClose, now + (sec + 5) * 1000); // sanity cap
  return Math.max(capped, now + KLINE_STALE_RECHECK_MS);
}

function pruneKlineCache(now = Date.now()) {
  if (klineCache.size <= KLINE_CACHE_MAX) return;
  for (const [k, v] of klineCache) if (v.expires <= now) klineCache.delete(k);
  for (const k of klineCache.keys()) {
    if (klineCache.size <= KLINE_CACHE_MAX) break;
    klineCache.delete(k); // Map keeps insertion order → oldest first
  }
}

/**
 * Fetch klines. By default returns CLOSED candles only (drops the
 * currently-forming bar) so TA uses completed structure only.
 * Pass { includeForming: true } when you need the live bar for lifecycle.
 */

/** Exact close time (unix sec) of a bar that opened at `time` — calendar-aware for 1M / 3M / 1Y. */
export function barEndSec(time, interval) {
  const d = new Date(+time * 1000);
  if (interval === '1M') return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
  if (interval === '3M') return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (d.getUTCMonth() % 3) + 3, 1) / 1000);
  if (interval === '1Y') return Math.floor(Date.UTC(d.getUTCFullYear() + 1, 0, 1) / 1000);
  return +time + (INTERVAL_SEC[interval] || 300);
}

/** Aggregate monthly candles into 3M or 1Y bars. */
export function aggregateFromMonthly(monthly, groupMonths) {
  if (!monthly?.length) return [];
  const groups = new Map();
  for (const c of monthly) {
    const d = new Date(+c.time * 1000);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth(); // 0-11
    let key, openTime;
    if (groupMonths === 3) {
      const q = Math.floor(m / 3); // 0,1,2,3
      key = `${y}-Q${q}`;
      openTime = Math.floor(Date.UTC(y, q * 3, 1) / 1000);
    } else {
      key = `${y}`;
      openTime = Math.floor(Date.UTC(y, 0, 1) / 1000);
    }
    let g = groups.get(key);
    if (!g) {
      g = { time: openTime, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume, closed: true };
      groups.set(key, g);
    } else {
      g.high = Math.max(g.high, +c.high);
      g.low = Math.min(g.low, +c.low);
      g.close = +c.close;
      g.volume += +c.volume;
    }
  }
  return [...groups.values()].sort((a, b) => a.time - b.time);
}

/**
 * Fetch klines. By default returns CLOSED candles only (drops the
 * currently-forming bar) so TA uses completed structure only.
 * Pass { includeForming: true } when you need the live bar for lifecycle.
 * Supports native Binance intervals plus synthetic '3M' and '1Y' (built from 1M).
 */
export async function getKlines(symbol, interval, limit = 150, opts = {}) {
  const includeForming = !!opts.includeForming;
  // optional historical window (ms epoch) — used to re-check old trades candle by candle
  const startTime = Number.isFinite(+opts.startTime) && +opts.startTime > 0 ? Math.floor(+opts.startTime) : null;
  const endTime = Number.isFinite(+opts.endTime) && +opts.endTime > 0 ? Math.floor(+opts.endTime) : null;
  const key = `${symbol}_${interval}_${limit}_${includeForming ? 'f' : 'c'}${startTime ? `_s${startTime}` : ''}${endTime ? `_e${endTime}` : ''}`;
  const now = Date.now();
  const cached = klineCache.get(key);
  if (cached && now < cached.expires) {
    return cached.data;
  }

  // Synthetic higher TFs built from monthly
  if (interval === '3M' || interval === '1Y') {
    const monthsNeeded = Math.min(1500, Math.max(limit * (interval === '3M' ? 3 : 12) + 12, 36));
    const monthly = await getKlines(symbol, '1M', monthsNeeded, { ...opts, includeForming: true });
    let candles = aggregateFromMonthly(monthly, interval === '3M' ? 3 : 12);
    if (!includeForming && candles.length) {
      const nowSec = Math.floor(Date.now() / 1000);
      const last = candles[candles.length - 1];
      if (barEndSec(last.time, interval) > nowSec) {
        candles = candles.slice(0, -1);
      }
    }
    if (candles.length > limit) {
      candles = startTime ? candles.slice(0, limit) : candles.slice(candles.length - limit);
    }
    klineCache.set(key, { data: candles, ts: now, expires: klineExpiry(candles, interval, now, includeForming) });
    pruneKlineCache(now);
    return candles;
  }

  const base = SIGNAL_CONFIG.binanceBaseUrl;
  // fetch one extra so after dropping forming we still have `limit` closed
  const fetchLimit = includeForming ? limit : Math.min(limit + 1, 1500);
  const url = `${base}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${fetchLimit}${startTime ? `&startTime=${startTime}` : ''}${endTime ? `&endTime=${endTime}` : ''}`;
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
    const nowSec = Math.floor(Date.now() / 1000);
    const last = candles[candles.length - 1];
    // still forming if bar close (calendar-aware for 1M) > now
    if (barEndSec(last.time, interval) > nowSec) {
      candles = candles.slice(0, -1);
    }
  }

  if (candles.length > limit) {
    candles = startTime ? candles.slice(0, limit) : candles.slice(candles.length - limit);
  }

  klineCache.set(key, { data: candles, ts: now, expires: klineExpiry(candles, interval, now, includeForming) });
  pruneKlineCache(now);
  return candles;
}

export function clearKlineCache() {
  klineCache.clear();
}
