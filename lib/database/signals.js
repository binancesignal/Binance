import { getDb } from './index.js';
import { pickSibling, isUpdatableStatus, describeLevelChange } from '../signals/sibling.js';
import { getContextExchange } from '../exchange/context.js';
import { SIGNAL_STATUS } from '../config/signalConfig.js';

function dbLog(tag, fields = {}) {
  // Never log secrets — only ids / status / operation / error messages.
  try {
    console.log(`[SIGNAL_DB] ${tag}`, JSON.stringify(fields));
  } catch (_) {
    console.log(`[SIGNAL_DB] ${tag}`);
  }
}

const ACTIVE = [
  SIGNAL_STATUS.WATCHING,
  SIGNAL_STATUS.READY,
  SIGNAL_STATUS.ONGOING,
];
const ACTIVE_PAGE_SIZE = 500;

export async function getSignalById(signalId) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('signals')
      .select('*')
      .eq('signal_id', signalId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  return db.store.signals.get(signalId) || null;
}

export async function getActiveSignals() {
  const db = getDb();
  if (db.type === 'supabase') {
    // Query each status separately and page through the complete result set.
    // Fixed per-status caps made persisted signals vanish from the dashboard
    // once a scan produced more rows than the cap.
    const parts = await Promise.all(
      ACTIVE.map(async (status) => {
        const rows = [];
        for (let offset = 0; ; offset += ACTIVE_PAGE_SIZE) {
          const { data, error } = await db.client
            .from('signals')
            .select('*')
            .eq('status', status)
            .order('created_at', { ascending: false })
            .order('signal_id', { ascending: true })
            .range(offset, offset + ACTIVE_PAGE_SIZE - 1);
          if (error) {
            console.error('[SIGNAL_DB] active query failed', JSON.stringify({
              db: db.type,
              status,
              offset,
              operation: 'select',
              error: error.message,
            }));
            throw error;
          }
          const page = data || [];
          rows.push(...page);
          if (page.length < ACTIVE_PAGE_SIZE) break;
        }
        console.log('[SIGNAL_DB] active query complete', JSON.stringify({
          db: db.type,
          status,
          count: rows.length,
          operation: 'select',
        }));
        return rows;
      })
    );
    return parts.flat();
  }
  return [...db.store.signals.values()].filter((s) =>
    ACTIVE.includes(String(s.status || '').trim().toUpperCase())
  );
}

export async function getSignalsByStatus(status) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('signals')
      .select('*')
      .eq('status', status)
      .order('last_updated_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }
  return [...db.store.signals.values()].filter((s) => s.status === status);
}


export async function getRecentSignals(limit = 30) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('signals')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }
  return [...db.store.signals.values()]
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, limit);
}

export async function getHistorySignals(limit = 100, statuses = null) {
  const db = getDb();
  const allDone = [
    SIGNAL_STATUS.COMPLETED_PROFIT,
    SIGNAL_STATUS.STOPPED,
    SIGNAL_STATUS.INVALIDATED,
  ];
  const done = Array.isArray(statuses)
    ? allDone.filter((status) => statuses.includes(status))
    : allDone;
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('signals')
      .select('*')
      .in('status', done)
      .order('completed_at', { ascending: false, nullsFirst: false })
      .order('invalidated_at', { ascending: false, nullsFirst: false })
      .order('last_updated_at', { ascending: false, nullsFirst: false })
      .order('signal_id', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }
  return [...db.store.signals.values()]
    .filter((s) => done.includes(s.status))
    .sort(
      (a, b) =>
        new Date(b.completed_at || b.invalidated_at || b.last_updated_at) -
        new Date(a.completed_at || a.invalidated_at || a.last_updated_at)
    )
    .slice(0, limit);
}

export async function getInvalidationCatalog() {
  const db = getDb();
  if (db.type === 'supabase') {
    const rows = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await db.client
        .from('signals')
        .select('*')
        .eq('status', SIGNAL_STATUS.INVALIDATED)
        .order('invalidated_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .order('signal_id', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows;
  }
  return [...db.store.signals.values()]
    .filter((s) => String(s.status || '').toUpperCase() === SIGNAL_STATUS.INVALIDATED)
    .sort(
      (a, b) =>
        new Date(b.invalidated_at || b.last_updated_at || b.created_at || 0) -
        new Date(a.invalidated_at || a.last_updated_at || a.created_at || 0)
    );
}

export async function getInvalidationEvents(signalIds = []) {
  const ids = [...new Set(signalIds.filter(Boolean))];
  if (!ids.length) return [];
  const db = getDb();
  if (db.type === 'supabase') {
    const events = [];
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await db.client
        .from('signal_events')
        .select('signal_id,event_type,price,old_status,new_status,message,created_at,metadata')
        .in('signal_id', ids.slice(i, i + 100))
        .eq('event_type', 'INVALIDATED')
        .order('created_at', { ascending: false });
      if (error) throw error;
      events.push(...(data || []));
    }
    return events;
  }
  return db.store.events
    .filter((event) => ids.includes(event.signal_id) && event.event_type === 'INVALIDATED')
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

function sanitizeSignalRecord(record) {
  const r = { ...record };
  // numeric columns — never send em-dash or NaN
  for (const k of [
    'score', 'entry', 'entry_hit_price', 'sl', 'tp1', 'tp2', 'tp3', 'rr',
    'current_price', 'current_pnl_percent', 'atr_5m', 'distance_to_entry',
    'distance_percent', 'atr_distance', 'proximity_score', 'ready_threshold',
    'ob_low', 'ob_high', 'last_price', 'max_profit_percent', 'max_loss_percent',
  ]) {
    if (r[k] === '—' || r[k] === '' || r[k] === undefined) r[k] = null;
    else if (r[k] != null && !Number.isNaN(+r[k])) r[k] = +r[k];
  }
  if (!r.status) r.status = 'WATCHING';
  if (!r.direction) r.direction = 'LONG';
  // Stamp the exchange of the scan that produced this row (see lib/exchange/context.js)
  if (!r.exchange) {
    const ex = getContextExchange();
    if (ex) r.exchange = ex;
  }
  // metadata must be plain JSON
  if (r.metadata && typeof r.metadata === 'object') {
    try {
      r.metadata = JSON.parse(JSON.stringify(r.metadata));
    } catch {
      r.metadata = {};
    }
  }
  return r;
}

// Fields a repeated scan may always refresh on an EXISTING signal.
// Lifecycle fields (status, *_at, *_hit, *_notified, entry_hit_price, created_at) are never touched.
const SAFE_REFRESH_FIELDS = [
  'current_price', 'last_price', 'last_checked_at', 'atr_5m',
  'distance_to_entry', 'distance_percent', 'atr_distance',
  'proximity_score', 'ready_threshold',
];

// WATCHING / READY only — rediscovery may refresh setup levels (not ONGOING trades)
const SETUP_REFRESH_FIELDS = [
  'entry', 'sl', 'tp1', 'tp2', 'tp3', 'rr', 'score',
  'ob_low', 'ob_high', 'direction',
];

function getSafeRefreshPatch(record, existingStatus) {
  const patch = {};
  for (const key of SAFE_REFRESH_FIELDS) {
    if (record[key] !== undefined) patch[key] = record[key];
  }
  const st = String(existingStatus || '').toUpperCase();
  if (st === 'WATCHING' || st === 'READY') {
    for (const key of SETUP_REFRESH_FIELDS) {
      if (record[key] !== undefined && record[key] !== null) patch[key] = record[key];
    }
  }
  return patch;
}

async function refreshExistingSignal(signalId, clean, existing, meta) {
  const patch = getSafeRefreshPatch(clean, existing.status);
  // Proper metadata merge when refreshing setup
  const st = String(existing.status || '').toUpperCase();
  if ((st === 'WATCHING' || st === 'READY') && clean.metadata && existing.metadata) {
    patch.metadata = {
      ...(existing.metadata || {}),
      ...(clean.metadata || {}),
      // preserve entry-mode / invalidation from live monitor if newer
      invalidation: existing.metadata?.invalidation || clean.metadata?.invalidation,
      entryMode: clean.metadata?.entryMode || existing.metadata?.entryMode,
      retestWatching: clean.metadata?.retestWatching ?? existing.metadata?.retestWatching,
    };
  }
  dbLog('updating', {
    ...meta,
    status: existing.status,
    operation: 'update',
    setupRefresh: st === 'WATCHING' || st === 'READY',
  });
  const updated = await updateSignal(signalId, patch);
  dbLog('updated', {
    ...meta,
    status: existing.status,
    operation: 'update',
    ok: !!updated,
  });
  return updated || existing;
}

/**
 * Reliable, duplicate-safe persistence.
 * - not existing -> insert (on unique violation, falls back to update path)
 * - existing     -> refresh non-lifecycle fields only, never overwrite status
 * Returns { operation: 'inserted'|'updated', data }. Throws on real DB errors.
 */
export async function upsertSignal(record, opts = {}) {
  const db = getDb();
  const clean = sanitizeSignalRecord(record);
  const id = clean.signal_id;
  const meta = { signal_id: id, symbol: clean.symbol, status: clean.status, db: db.type };

  dbLog('checking existing', { ...meta, operation: 'check' });
  const existing = await getSignalById(id);

  if (existing) {
    const updated = await refreshExistingSignal(id, clean, existing, meta);
    return { operation: 'updated', data: updated };
  }

  // Same setup, moved levels: update the existing WATCHING/READY signal in place
  // instead of inserting a duplicate (signal_id embeds the entry price).
  // ONGOING / TP / SL / INVALIDATED rows are never touched here.
  if (Array.isArray(opts.siblingPool) && opts.siblingPool.length) {
    const cand = pickSibling(clean, opts.siblingPool, opts.excludeIds || new Set());
    if (cand) {
      // Re-read: the lifecycle monitor may have moved it to ONGOING during this run.
      const fresh = await getSignalById(cand.signal_id);
      if (fresh && isUpdatableStatus(fresh.status)) {
        const change = describeLevelChange(fresh, clean);
        const updated = await refreshExistingSignal(fresh.signal_id, clean, fresh, {
          ...meta,
          signal_id: fresh.signal_id,
          status: fresh.status,
        });
        if (change) {
          try {
            await createSignalEvent({
              signal_id: fresh.signal_id,
              event_type: 'LEVELS_UPDATED',
              price: clean.current_price ?? null,
              old_status: fresh.status,
              new_status: updated?.status || fresh.status,
              message: `Rescan updated levels: ${change}`,
            });
          } catch (_) {}
        }
        return {
          operation: 'updated',
          data: updated,
          replacedSignalId: fresh.signal_id,
          levelsChanged: !!change,
        };
      }
    }
  }

  dbLog('inserting', { ...meta, operation: 'insert' });
  if (db.type === 'supabase') {
    let { data, error } = await db.client
      .from('signals')
      .insert(clean)
      .select()
      .single();
    if (error && /exchange/i.test(error.message || '') && /column/i.test(error.message || '')) {
      // Migration 006 not applied yet. Bybit rows can still be saved (legacy shape);
      // anything else would be mislabelled, so fail loudly.
      if (clean.exchange && clean.exchange !== 'bybit') {
        throw new Error('signals.exchange column missing — run supabase/migrations/006_multi_exchange.sql');
      }
      const { exchange: _drop, ...legacy } = clean;
      ({ data, error } = await db.client.from('signals').insert(legacy).select().single());
    }
    if (error) {
      // Race with a concurrent scan: row now exists -> treat as update, never duplicate.
      if (error.code === '23505') {
        dbLog('insert conflict -> update', { ...meta, operation: 'update' });
        const ex = await getSignalById(id);
        if (ex) {
          const updated = await refreshExistingSignal(id, clean, ex, meta);
          return { operation: 'updated', data: updated };
        }
      }
      dbLog('Supabase error', { ...meta, operation: 'insert', error: error.message, code: error.code });
      throw error;
    }
    dbLog('inserted', { ...meta, operation: 'insert', row_id: data?.id });
    return { operation: 'inserted', data };
  }
  db.store.signals.set(id, { ...clean, id });
  dbLog('inserted', { ...meta, operation: 'insert' });
  return { operation: 'inserted', data: db.store.signals.get(id) };
}

// Kept for existing callers (near-breakout persistence). Same safety as upsert insert path.
export async function createSignal(record) {
  const db = getDb();
  const clean = sanitizeSignalRecord(record);
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('signals')
      .insert(clean)
      .select()
      .single();
    if (error) {
      if (error.code === '23505') {
        // duplicate signal_id: return the existing row instead of failing/duplicating
        const ex = await getSignalById(clean.signal_id);
        if (ex) return ex;
      }
      dbLog('Supabase error', { signal_id: clean.signal_id, symbol: clean.symbol, operation: 'insert', error: error.message });
      throw error;
    }
    return data;
  }
  const id = clean.signal_id;
  db.store.signals.set(id, { ...clean, id });
  return db.store.signals.get(id);
}

export async function updateSignal(signalId, updates) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('signals')
      .update({ ...updates, last_updated_at: new Date().toISOString() })
      .eq('signal_id', signalId)
      .select()
      .maybeSingle(); // row may have been deleted by Reset meanwhile -> null, not a crash
    if (error) {
      dbLog('Supabase error', { signal_id: signalId, operation: 'update', error: error.message });
      throw error;
    }
    return data;
  }
  const existing = db.store.signals.get(signalId);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...updates,
    last_updated_at: new Date().toISOString(),
  };
  db.store.signals.set(signalId, merged);
  return merged;
}

export async function createSignalEvent(event) {
  const db = getDb();
  const row = {
    ...event,
    created_at: event.created_at || new Date().toISOString(),
  };
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('signal_events')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  row.id = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.store.events.push(row);
  return row;
}

export async function getSignalEvents(signalId) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('signal_events')
      .select('*')
      .eq('signal_id', signalId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }
  return db.store.events.filter((e) => e.signal_id === signalId);
}

export async function markNotified(signalId, flag) {
  return updateSignal(signalId, { [flag]: true });
}
