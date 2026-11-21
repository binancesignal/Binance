/**
 * Harmonic saved signals — ONE canonical list in the database (app_state key below).
 * Used by: admin scan (auto-save), server full-scan cron, server refresh cron, public Scanner feed.
 *
 * Writes are read-modify-write on one JSON document, so they go through a small DB lock
 * (best effort) and always RE-READ right before writing — a scan chunk never wipes a
 * status refresh and vice-versa.
 */
import { getState, setState } from '../database/appState.js';
import { normalizeHsScanConfig, isFinalHarmonicStatus } from '../scanner/strategy/harmonicScan/index.js';

import { tpLevelOf } from '../scanner/strategy/harmonicScan/categories.js';
export { tpLevelOf };

export const HARMONIC_LIVE_KEY = 'harmonic_saved_live';
const LOCK_KEY = 'harmonic_saved_lock';
const LEGACY_KEYS_REGISTRY = 'harmonic_saved_keys';
const MAX_ITEMS = 500;
const FINAL_KEEP_DAYS = 14;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stripHeavy(item) {
  if (!item || typeof item !== 'object') return item;
  const { chartSvg, annotations, allBreakers, ...rest } = item;
  return rest;
}

export function itemId(item) {
  return item.id || [item.symbol, item.tf, item.family, item.kind, item.C?.time || item.time, item.direction].join('|');
}

/** Admin UI config → config object understood by findHarmonicEvents / revalidateSavedSignal. */
export function uiConfigToScanCfg(ui = {}) {
  return normalizeHsScanConfig({
    ...ui,
    preferEma200InDzone: ui.preferEma200InDzone ?? ui.preferEma200,
    requireEma200InDzone: ui.requireEma200InDzone ?? ui.requireEma200,
    preferBreakerInDzone: ui.preferBreakerInDzone ?? ui.preferBreaker,
    requireBreakerInDzone: ui.requireBreakerInDzone ?? ui.requireBreaker,
  });
}

/** Scan/refresh config = admin UI config + the auto-trade proximity % (Watching / Entry ready). */
export async function buildScanCfg() {
  const ui = (await getState('harmonic_ui_config', null)) || {};
  const cfg = uiConfigToScanCfg(ui);
  try {
    const { getAutoTradingConfig } = await import('../trading/autoConfig.js');
    const at = await getAutoTradingConfig();
    cfg.proximityPercent = {
      watchingProximityPercent: at.watchingProximityPercent,
      entryReadyProximityPercent: at.entryReadyProximityPercent,
    };
  } catch (_) {}
  return cfg;
}

/** Live mark/last price from the ticker map. */
export function livePriceFromTickers(tickers, symbol) {
  const t = tickers?.[symbol];
  if (!t) return null;
  const mark = +t.markPrice;
  const last = +t.price;
  if (Number.isFinite(mark) && mark > 0) return { price: mark, priceSource: 'MARK' };
  if (Number.isFinite(last) && last > 0) return { price: last, priceSource: 'LAST' };
  return null;
}

async function withLock(fn, { waitMs = 8000, holdMs = 12000 } = {}) {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const start = Date.now();
  let got = false;
  while (!got) {
    let cur = null;
    try {
      cur = await getState(LOCK_KEY, null);
    } catch (_) {}
    if (!cur || +cur.until < Date.now()) {
      try {
        await setState(LOCK_KEY, { until: Date.now() + holdMs, token });
        await sleep(50);
        const chk = await getState(LOCK_KEY, null);
        if (chk?.token === token) got = true;
      } catch (_) {
        got = true; // lock storage failing must never block saving
      }
    }
    if (!got) {
      if (Date.now() - start > waitMs) break; // best effort: proceed (fresh re-read still protects data)
      await sleep(120 + Math.random() * 180);
    }
  }
  try {
    return await fn();
  } finally {
    if (got) {
      try {
        const chk = await getState(LOCK_KEY, null);
        if (chk?.token === token) await setState(LOCK_KEY, { until: 0, token: null });
      } catch (_) {}
    }
  }
}

function toItems(data) {
  return Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
}

/** Drop old finished signals and cap the size so the JSON stays small. */
export function pruneItems(items, now = Date.now()) {
  const cutoff = Math.floor(now / 1000) - FINAL_KEEP_DAYS * 86400;
  const kept = items.filter((x) => !(isFinalHarmonicStatus(x.status) && (x.refreshedAt || x.savedAt || 0) < cutoff));
  kept.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return kept.slice(0, MAX_ITEMS);
}

async function migrateLegacy(doc) {
  // Older builds kept one list per admin user — fold them into the canonical list once.
  const byId = new Map(toItems(doc).map((x) => [x.id, x]));
  let keys = [];
  try {
    const reg = await getState(LEGACY_KEYS_REGISTRY, []);
    keys = Array.isArray(reg) ? reg.map(String) : [];
  } catch (_) {}
  for (const key of keys) {
    if (key === HARMONIC_LIVE_KEY) continue;
    try {
      const d = await getState(key, null);
      for (const it of toItems(d)) if (it?.id && !byId.has(it.id)) byId.set(it.id, it);
      if (toItems(d).length) await setState(key, { items: [], migratedTo: HARMONIC_LIVE_KEY, at: new Date().toISOString() });
    } catch (_) {}
  }
  return { items: pruneItems([...byId.values()]), updatedAt: new Date().toISOString(), migrated: true };
}

export async function loadSavedDoc() {
  let doc = await getState(HARMONIC_LIVE_KEY, null);
  if (!doc || !doc.migrated) {
    doc = await withLock(async () => {
      const fresh = await getState(HARMONIC_LIVE_KEY, null);
      if (fresh?.migrated) return fresh;
      const migrated = await migrateLegacy(fresh);
      await setState(HARMONIC_LIVE_KEY, migrated);
      return migrated;
    });
  }
  return doc || { items: [] };
}

export async function loadSaved() {
  return toItems(await loadSavedDoc());
}

async function writeItems(items, extra = {}) {
  const prev = (await getState(HARMONIC_LIVE_KEY, null)) || {};
  await setState(HARMONIC_LIVE_KEY, {
    ...prev,
    ...extra,
    migrated: true,
    items: pruneItems(items),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Add freshly scanned setups. Existing ones are refreshed, but a FINISHED signal
 * (SL / TP3 / invalid / missed) is never overwritten by a re-scan.
 */
export async function mergeScanned(incoming = []) {
  const list = incoming.map(stripHeavy).filter((x) => x?.symbol && x?.tf && !x.error);
  if (!list.length) return { added: 0, total: (await loadSaved()).length };
  await loadSavedDoc(); // makes sure legacy lists were folded in first
  return withLock(async () => {
    const doc = await getState(HARMONIC_LIVE_KEY, null);
    const byId = new Map(toItems(doc).map((x) => [x.id, x]));
    let added = 0;
    const now = Math.floor(Date.now() / 1000);
    for (const item of list) {
      const id = itemId(item);
      const old = byId.get(id);
      if (old && isFinalHarmonicStatus(old.status)) continue;
      if (!old) added += 1;
      byId.set(id, { ...(old || {}), ...item, id, savedAt: old?.savedAt || now });
    }
    const items = [...byId.values()];
    await writeItems(items);
    return { added, total: Math.min(items.length, MAX_ITEMS) };
  });
}

/** Apply status updates from a refresh (Map id → updated item). Never downgrades a final status. */
export async function applyRefresh(updates) {
  if (!updates || !updates.size) return { updated: 0 };
  await loadSavedDoc();
  return withLock(async () => {
    const doc = await getState(HARMONIC_LIVE_KEY, null);
    let updated = 0;
    const items = toItems(doc).map((it) => {
      const upd = updates.get(it.id);
      if (!upd) return it;
      if (isFinalHarmonicStatus(it.status) && !isFinalHarmonicStatus(upd.status)) return it;
      updated += 1;
      return { ...it, ...stripHeavy(upd), id: it.id, savedAt: it.savedAt };
    });
    await writeItems(items, { lastCronRefreshAt: new Date().toISOString() });
    return { updated };
  });
}

export async function removeSaved(id) {
  await loadSavedDoc();
  return withLock(async () => {
    const doc = await getState(HARMONIC_LIVE_KEY, null);
    const items = toItems(doc).filter((x) => x.id !== id);
    await writeItems(items);
    return items;
  });
}

export async function clearSaved() {
  await loadSavedDoc();
  return withLock(async () => {
    await writeItems([]);
    return [];
  });
}

/** Keep the public feed light + safe: only what a card needs. */
export function toPublicItem(it) {
  const p = it.plan || {};
  return {
    id: it.id,
    symbol: it.symbol,
    tf: it.tf,
    family: it.family,
    label: it.label || it.name || it.family,
    kind: it.kind,
    direction: it.direction,
    status: it.status,
    outcome: it.outcome || null,
    entryTouched: !!it.entryTouched,
    score: it.score ?? null,
    price: it.marketPrice ?? it.price ?? null,
    priceAt: it.priceAt || null,
    tpLevel: tpLevelOf(it),
    entry: p.entry ?? it.entry ?? null,
    sl: p.sl ?? null,
    tp1: p.tp1 ?? null,
    tp2: p.tp2 ?? null,
    tp3: p.tp3 ?? null,
    rr1: p.rr1 ?? null,
    rr2: p.rr2 ?? null,
    przLow: it.przLow ?? null,
    przHigh: it.przHigh ?? null,
    X: it.X ? { price: it.X.price } : null,
    A: it.A ? { price: it.A.price } : null,
    B: it.B ? { price: it.B.price } : null,
    C: it.C ? { price: it.C.price } : null,
    D: it.D ? { price: it.D.price } : null,
    ema200: it.ema200 ?? null,
    savedAt: it.savedAt || null,
    refreshedAt: it.refreshedAt || null,
    marketTime: it.marketTime || null,
    time: it.time || it.C?.time || null,
  };
}
