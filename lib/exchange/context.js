/**
 * Per-scan exchange context (AsyncLocalStorage).
 * Inside runWithExchange('binance', fn) every getKlines/loadTickers/loadExchangeInfo call —
 * including the ones fired from Promise.all — resolves to that exchange, and every signal row
 * written is stamped with it. Outside a context the admin's `active_exchange` is used (legacy).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const EXCHANGES = ['bybit', 'binance'];
export const DEFAULT_SIGNAL_EXCHANGE = 'bybit'; // existing rows / site default

const als = new AsyncLocalStorage();

export function isExchange(x) {
  return EXCHANGES.includes(x);
}

export function runWithExchange(exchange, fn) {
  if (!isExchange(exchange)) throw new Error(`Unknown exchange: ${exchange}`);
  return als.run({ exchange }, fn);
}

export function getContextExchange() {
  return als.getStore()?.exchange || null;
}

/** Signals created before multi-exchange support belong to Bybit. */
export function signalExchange(s) {
  return isExchange(s?.exchange) ? s.exchange : DEFAULT_SIGNAL_EXCHANGE;
}

/**
 * Same coin exists on both exchanges, so non-default exchanges get an id prefix
 * (Bybit keeps the legacy format so existing signals are never duplicated).
 */
export function withExchangeId(signalId, exchange) {
  const id = String(signalId || '');
  if (!exchange || exchange === DEFAULT_SIGNAL_EXCHANGE) return id;
  const prefix = `${exchange.slice(0, 3)}_`; // bin_
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}
