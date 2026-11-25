/**
 * Server-side full-scan (cron) state + settings for the Harmonic strategy.
 * A "pass" walks the whole futures universe in small chunks (one cron tick = one chunk),
 * then rests for `restMin` minutes and starts again. The cursor lives in the database,
 * so nothing depends on a browser being open.
 */
import { getState, setState } from '../database/appState.js';
import { SCAN_DEFAULTS, normalizeScanSettings, planTick } from './scanPlan.js';

export { SCAN_DEFAULTS, normalizeScanSettings, planTick };

export const SCAN_STATE_KEY = 'harmonic_scan_state';
export const SCAN_TICK_LOCK_KEY = 'harmonic_scan_tick_lock';

export async function loadScanState() {
  const raw = (await getState(SCAN_STATE_KEY, null)) || {};
  return { ...raw, ...normalizeScanSettings({ ...SCAN_DEFAULTS, ...raw }) };
}

export async function saveScanState(state) {
  await setState(SCAN_STATE_KEY, state);
  return state;
}

export async function saveScanSettings({ enabled, tfs, restMin, coinsPerTick, restart } = {}) {
  const cur = await loadScanState();
  const merged = normalizeScanSettings({
    enabled: enabled === undefined ? cur.enabled : enabled,
    tfs: tfs === undefined ? cur.tfs : tfs,
    restMin: restMin === undefined ? cur.restMin : restMin,
    coinsPerTick: coinsPerTick === undefined ? cur.coinsPerTick : coinsPerTick,
  });
  const next = { ...cur, ...merged, updatedAt: new Date().toISOString() };
  if (restart || (merged.enabled && !cur.enabled)) {
    // start a fresh pass on the next tick
    next.pass = null;
    next.lastPassEndedAt = 0;
    next.pausedUntil = 0;
    next.lastError = null;
  }
  await saveScanState(next);
  return publicScanState(next);
}

export function publicScanState(s) {
  return {
    enabled: !!s.enabled,
    tfs: s.tfs,
    restMin: s.restMin,
    coinsPerTick: s.coinsPerTick,
    pass: s.pass
      ? { done: s.pass.idx || 0, total: s.pass.symbols?.length || 0, startedAt: s.pass.startedAt, found: s.pass.found || 0 }
      : null,
    lastPassEndedAt: s.lastPassEndedAt || null,
    lastPass: s.lastPass || null,
    lastTickAt: s.lastTickAt || null,
    status: s.status || null,
    lastError: s.lastError || null,
    pausedUntil: s.pausedUntil || 0,
  };
}

export async function getPublicScanState() {
  return publicScanState(await loadScanState());
}

