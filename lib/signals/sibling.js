/**
 * "Same setup, moved levels" matching.
 *
 * signal_id embeds the entry price, so when a rescan produces slightly different
 * entry / SL / TP for the same coin the id changes and a duplicate row would be
 * inserted. Instead, WATCHING / READY signals (never ONGOING or closed ones) are
 * matched here by symbol + direction + strategy + pattern + timeframe and updated in place.
 */

import { signalExchange } from '../exchange/context.js';

const UPDATABLE = new Set(['WATCHING', 'READY']);

export function isUpdatableStatus(status) {
  return UPDATABLE.has(String(status || '').toUpperCase());
}

function patternName(s) {
  const m = s?.metadata || {};
  const p = s?.pattern ?? m.pattern;
  if (p && typeof p === 'object') return String(p.type || p.name || '');
  return p ? String(p) : '';
}

/** Identity of a "setup slot" independent of its price levels. */
export function siblingKey(s) {
  const m = s?.metadata || {};
  const dir = String(s?.direction || s?.dir || '').toUpperCase();
  const strategy = s?.strategy || m.strategy || 'existing_smc';
  const tf = m.patternTf || m.setupTf || m.entryTf || '';
  return [signalExchange(s), s?.symbol, dir, strategy, patternName(s), tf].join('|');
}

/**
 * Choose which existing WATCHING/READY signal a freshly detected setup should update.
 * @param {object} record  newly detected signal (signal_id, entry, ...)
 * @param {object[]} pool  known active signals
 * @param {Set<string>} excludeIds ids already claimed this run / reserved for exact matches
 * @returns {object|null} closest-entry sibling, or null
 */
export function pickSibling(record, pool, excludeIds = new Set()) {
  if (!record || !Array.isArray(pool)) return null;
  const key = siblingKey(record);
  const entry = +record.entry;
  let best = null;
  let bestDist = Infinity;
  for (const s of pool) {
    if (!s || s.signal_id === record.signal_id) continue;
    if (excludeIds.has(s.signal_id)) continue;
    if (!isUpdatableStatus(s.status)) continue;
    if (siblingKey(s) !== key) continue;
    const d = Math.abs((+s.entry || 0) - entry);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/** Human-readable diff of setup levels, or null when nothing meaningfully changed. */
export function describeLevelChange(before, after) {
  const fields = ['entry', 'sl', 'tp1', 'tp2', 'tp3'];
  const parts = [];
  for (const f of fields) {
    const a = +before?.[f];
    const b = +after?.[f];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const tol = Math.max(Math.abs(a) * 1e-9, 1e-12);
    if (Math.abs(a - b) > tol) parts.push(`${f.toUpperCase()} ${a} → ${b}`);
  }
  return parts.length ? parts.join(', ') : null;
}
