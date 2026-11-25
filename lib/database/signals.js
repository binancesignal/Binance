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

/**
 * Wipe signals table (Live board). Uses same pattern as /api/admin/reset-signals.
 * Returns { deleted, errors }.
 */
export async function deleteSignalsByStrategy(strategyKey = 'all') {
  const db = getDb();
  let deleted = 0;
  const errors = [];
  const since = '1970-01-01T00:00:00.000Z';

  if (db.type === 'supabase') {
    try {
      const { data: ev, error: e1 } = await db.client
        .from('signal_events')
        .delete()
        .gte('created_at', since)
        .select('id');
      if (e1) errors.push(`signal_events: ${e1.message}`);
    } catch (e) {
      errors.push(String(e.message || e));
    }
    try {
      const { data, error } = await db.client
        .from('signals')
        .delete()
        .gte('created_at', since)
        .select('signal_id');
      if (error) errors.push(`signals: ${error.message}`);
      else deleted = (data || []).length;
    } catch (e) {
      errors.push(String(e.message || e));
    }
  } else if (db.store?.signals) {
    deleted = db.store.signals.size || [...db.store.signals.keys()].length;
    db.store.signals.clear();
    if (Array.isArray(db.store.events)) db.store.events = [];
  }

  dbLog('deleteByStrategy', { strategy: strategyKey, deleted, errors: errors.length, errors });
  return { deleted, errors };
}

function normalizeSignalRow(input = {}) {
  const now = new Date().toISOString();
  const direction = String(input.direction || input.dir || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const status = String(input.status || SIGNAL_STATUS.WATCHING).toUpperCase();
  const signal_id = String(input.signal_id || input.id || '').trim();
  if (!signal_id) throw new Error('signal_id required');
  return {
    signal_id,
    symbol: String(input.symbol || '').toUpperCase(),
    direction,
    status,
    score: input.score != null ? +input.score : null,
    entry: input.entry != null ? +input.entry : null,
    sl: input.sl != null ? +input.sl : null,
    tp1: input.tp1 != null ? +input.tp1 : null,
    tp2: input.tp2 != null ? +input.tp2 : null,
    tp3: input.tp3 != null ? +input.tp3 : null,
    rr: input.rr != null ? +input.rr : null,
    current_price: input.current_price != null ? +input.current_price : input.price != null ? +input.price : null,
    price: input.price != null ? +input.price : input.current_price != null ? +input.current_price : null,
    atr_5m: input.atr_5m != null ? +input.atr_5m : null,
    atr_distance: input.atr_distance != null ? +input.atr_distance : null,
    distance_percent: input.distance_percent != null ? +input.distance_percent : null,
    proximity_score: input.proximity_score != null ? +input.proximity_score : null,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    exchange: input.exchange || getContextExchange?.() || 'binance',
    created_at: input.created_at || now,
    last_updated_at: input.last_updated_at || now,
    last_checked_at: input.last_checked_at || now,
    ready_at: input.ready_at || null,
    entry_hit_at: input.entry_hit_at || null,
    notified_at: input.notified_at || null,
  };
}

export async function createSignal(input) {
  const row = normalizeSignalRow(input);
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('signals').insert(row).select('*').maybeSingle();
    if (error) {
      // race: already exists → treat as ok
      if (String(error.code) === '23505' || /duplicate|unique/i.test(error.message || '')) {
        return getSignalById(row.signal_id);
      }
      dbLog('createSignal fail', { signal_id: row.signal_id, error: error.message });
      throw error;
    }
    dbLog('createSignal', { signal_id: row.signal_id, status: row.status });
    return data || row;
  }
  db.store.signals.set(row.signal_id, { ...row });
  return { ...row };
}

export async function upsertSignal(input) {
  const row = normalizeSignalRow(input);
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('signals')
      .upsert(row, { onConflict: 'signal_id' })
      .select('*')
      .maybeSingle();
    if (error) {
      dbLog('upsertSignal fail', { signal_id: row.signal_id, error: error.message });
      throw error;
    }
    return data || row;
  }
  const prev = db.store.signals.get(row.signal_id) || {};
  const merged = { ...prev, ...row, created_at: prev.created_at || row.created_at };
  db.store.signals.set(row.signal_id, merged);
  return { ...merged };
}

export async function updateSignal(signalId, patch = {}) {
  const id = String(signalId || '').trim();
  if (!id) throw new Error('signalId required');
  const db = getDb();
  const now = new Date().toISOString();
  const body = { ...patch, last_updated_at: patch.last_updated_at || now };
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('signals')
      .update(body)
      .eq('signal_id', id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  const prev = db.store.signals.get(id);
  if (!prev) return null;
  const next = { ...prev, ...body };
  db.store.signals.set(id, next);
  return { ...next };
}

export async function createSignalEvent(event = {}) {
  const db = getDb();
  const row = {
    id: event.id || undefined,
    signal_id: event.signal_id,
    event_type: event.event_type || event.type || 'update',
    old_status: event.old_status || null,
    new_status: event.new_status || null,
    message: event.message || null,
    payload: event.payload || event.meta || null,
    created_at: event.created_at || new Date().toISOString(),
  };
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('signal_events').insert(row).select('*').maybeSingle();
    if (error) {
      dbLog('createSignalEvent fail', { signal_id: row.signal_id, error: error.message });
      return null;
    }
    return data;
  }
  if (!Array.isArray(db.store.events)) db.store.events = [];
  const mem = { ...row, id: row.id || `ev_${db.store.events.length + 1}` };
  db.store.events.push(mem);
  return mem;
}

export async function markNotified(signalId, at = null) {
  return updateSignal(signalId, { notified_at: at || new Date().toISOString() });
}

export async function getClosedTradesSince(sinceIso) {
  const db = getDb();
  const done = ['COMPLETED_PROFIT', 'STOPPED', 'INVALIDATED', 'COMPLETED'];
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('signals')
      .select('*')
      .in('status', done)
      .gte('last_updated_at', sinceIso)
      .order('last_updated_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    return data || [];
  }
  return [...db.store.signals.values()].filter(
    (s) => done.includes(String(s.status || '').toUpperCase()) && String(s.last_updated_at || '') >= sinceIso
  );
}
