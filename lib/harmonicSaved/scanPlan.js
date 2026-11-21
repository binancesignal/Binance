/** Pure helpers for the server full scan (no database imports → unit-testable). */
import { HS_SCAN_TFS } from '../scanner/strategy/harmonicScan/index.js';

export const SCAN_DEFAULTS = Object.freeze({
  enabled: false,
  tfs: ['15m', '1h'],
  restMin: 5, // pause between two full passes
  coinsPerTick: 30, // coins checked per cron call (keeps Binance weight far below the limit)
});

const clamp = (v, lo, hi, fb) => {
  const n = Math.round(+v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
};

export function normalizeScanSettings(raw = {}) {
  const tfs = Array.isArray(raw.tfs) ? raw.tfs.filter((t) => HS_SCAN_TFS.includes(t)) : [];
  return {
    enabled: raw.enabled === true,
    tfs: tfs.length ? tfs : [...SCAN_DEFAULTS.tfs],
    restMin: clamp(raw.restMin, 0, 240, SCAN_DEFAULTS.restMin),
    coinsPerTick: clamp(raw.coinsPerTick, 5, 60, SCAN_DEFAULTS.coinsPerTick),
  };
}


/**
 * Pure decision for one cron tick.
 * @returns {{action:'skip'|'start'|'continue', reason?:string}}
 */
export function planTick(state, now = Date.now()) {
  if (!state.enabled) return { action: 'skip', reason: 'disabled' };
  if (+state.pausedUntil > now) return { action: 'skip', reason: 'paused (rate limit / ban backoff)' };
  if (state.pass && state.pass.symbols?.length && state.pass.idx < state.pass.symbols.length) {
    return { action: 'continue' };
  }
  const restMs = (state.restMin || 0) * 60_000;
  if (state.lastPassEndedAt && now - state.lastPassEndedAt < restMs) {
    return { action: 'skip', reason: 'resting between passes' };
  }
  return { action: 'start' };
}
