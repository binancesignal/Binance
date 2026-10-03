/**
 * Exchange switch: binance | bybit
 * Scanner imports from here so market data follows active exchange.
 */
import { getState } from '../database/appState.js';
import * as binance from '../binance/client.js';
import * as bybit from '../bybit/client.js';
import { SIGNAL_CONFIG } from '../config/signalConfig.js';

export async function getActiveExchange() {
  try {
    const ex = await getState('active_exchange', null);
    if (ex === 'bybit' || ex === 'binance') return ex;
  } catch (_) {}
  return SIGNAL_CONFIG.defaultExchange || 'binance';
}

function client(ex) {
  return ex === 'bybit' ? bybit : binance;
}

export async function loadExchangeInfo() {
  const ex = await getActiveExchange();
  return client(ex).loadExchangeInfo();
}

export async function loadTickers() {
  const ex = await getActiveExchange();
  return client(ex).loadTickers();
}

export async function getKlines(symbol, interval, limit, opts) {
  const ex = await getActiveExchange();
  return client(ex).getKlines(symbol, interval, limit, opts);
}

export async function clearKlineCache() {
  binance.clearKlineCache?.();
  bybit.clearKlineCache?.();
}

export { getActiveExchange as resolveExchange };
