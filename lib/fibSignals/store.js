import { S } from './state.js';
import { FIB_SIGNALS_STORE_KEY, FIB_SIGNALS_INVALID_KEY } from './config.js';
import { normalizeObFibConfig, OB_FIB_DEFAULTS } from '../scanner/strategy/obFib/config.js';

const MAX_ACTIVE = 600;
const MAX_CLOSED = 400;
const CLOSED_KEEP_DAYS = 14;

export async function loadStore() {
  try {
    const v = await (await S()).getState(FIB_SIGNALS_STORE_KEY, null);
    if (v && typeof v === 'object' && Array.isArray(v.signals)) return { v: 1, signals: v.signals };
  } catch (_) {}
  return { v: 1, signals: [] };
}

export function pruneStore(store, nowMs = Date.now()) {
  const cutoff = nowMs - CLOSED_KEEP_DAYS * 86400_000;
  const active = [];
  const closed = [];
  for (const s of store.signals) {
    if (s.status === 'ACTIVE') active.push(s);
    else if (Date.parse(s.closedAt || s.createdAt) >= cutoff) closed.push(s);
  }
  active.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  closed.sort((a, b) => Date.parse(b.closedAt || b.createdAt) - Date.parse(a.closedAt || a.createdAt));
  return { v: 1, signals: [...active.slice(0, MAX_ACTIVE), ...closed.slice(0, MAX_CLOSED)] };
}

export async function saveStore(store) {
  await (await S()).setState(FIB_SIGNALS_STORE_KEY, pruneStore(store));
}

/** public view: strip internal fields */
export function publicSignal(s) {
  const { _lastCheckedAt, ...rest } = s;
  return rest;
}

/**
 * Invalid list — setups whose OB-middle entry was ALREADY touched before we could publish them
 * (an OB entry only works once). Kept separate from signals, admin-only, short-lived and capped.
 */
const MAX_INVALID = 150;
const INVALID_KEEP_DAYS = 7;

export async function loadInvalid() {
  try {
    const v = await (await S()).getState(FIB_SIGNALS_INVALID_KEY, null);
    if (v && typeof v === 'object' && Array.isArray(v.items)) return { v: 1, items: v.items };
  } catch (_) {}
  return { v: 1, items: [] };
}

export function pruneInvalid(inv, nowMs = Date.now()) {
  const cutoff = nowMs - INVALID_KEEP_DAYS * 86400_000;
  const items = inv.items
    .filter((x) => Date.parse(x.invalidAt || x.createdAt) >= cutoff)
    .sort((a, b) => Date.parse(b.invalidAt || b.createdAt) - Date.parse(a.invalidAt || a.createdAt))
    .slice(0, MAX_INVALID);
  return { v: 1, items };
}

export async function saveInvalid(inv) {
  await (await S()).setState(FIB_SIGNALS_INVALID_KEY, pruneInvalid(inv));
}

/** The admin's OB + Fib scanner settings — the very config Coin Scan (/api/scan/symbol) scans with. */
export async function loadScannerBaseConfig() {
  try {
    const saved = await (await S()).getState('ob_fib_config', null);
    if (saved && typeof saved === 'object') return normalizeObFibConfig(saved);
  } catch (_) {}
  return normalizeObFibConfig(OB_FIB_DEFAULTS);
}
