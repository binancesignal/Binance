import { getDb } from './index.js';

function mem() {
  const db = getDb();
  if (db.type === 'memory') {
    if (!db.store.executions) db.store.executions = new Map();
    return db.store.executions;
  }
  return null;
}

function matchesScope(execution, options = {}) {
  if (options.exchange && (execution.exchange || 'bybit') !== options.exchange) return false;
  if (options.userId && execution.user_id !== options.userId) return false;
  return true;
}

function filterQuery(q, options = {}) {
  if (options.exchange) q = q.eq('exchange', options.exchange);
  if (options.userId) q = q.eq('user_id', options.userId);
  return q;
}

export async function getExecutionBySignal(signalId, side, options = {}) {
  const db = getDb();
  if (db.type === 'supabase') {
    let q = filterQuery(db.client
      .from('trade_executions')
      .select('*')
      .eq('signal_id', signalId)
      .not('status', 'in', '("FAILED","CANCELLED","REJECTED","SKIPPED")')
      .order('created_at', { ascending: false })
      .limit(1), options);
    if (side) q = q.eq('side', side);
    const { data, error } = await q;
    if (error) throw error;
    return (data && data[0]) || null;
  }
  const rows = [...mem().values()].filter(
    (e) =>
      e.signal_id === signalId &&
      (!side || e.side === side) &&
      matchesScope(e, options) &&
      !['FAILED', 'CANCELLED', 'REJECTED', 'SKIPPED'].includes(e.status)
  );
  return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
}

/** Any prior attempt (including FAILED / SKIPPED) — used to stop auto-retry spam. */
export async function getAnyExecutionBySignal(signalId, side, options = {}) {
  const db = getDb();
  if (db.type === 'supabase') {
    let q = filterQuery(db.client
      .from('trade_executions')
      .select('*')
      .eq('signal_id', signalId)
      .order('created_at', { ascending: false })
      .limit(1), options);
    if (side) q = q.eq('side', side);
    const { data, error } = await q;
    if (error) throw error;
    return (data && data[0]) || null;
  }
  const rows = [...mem().values()].filter(
    (e) => e.signal_id === signalId && (!side || e.side === side) && matchesScope(e, options)
  );
  return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
}

export async function getOpenExecutions(options = {}) {
  const open = [
    'PENDING',
    'PLACING',
    'PLACED',
    'WAITING_FILL',
    'VERIFY_UNKNOWN',
    'PROTECTING',
    'FILLED',
    'PROTECTED',
    'PARTIALLY_FILLED',
    'UNPROTECTED',
  ];
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await filterQuery(db.client
      .from('trade_executions')
      .select('*')
      .in('status', open)
      .order('created_at', { ascending: false })
      .limit(100), options);
    if (error) throw error;
    return data || [];
  }
  return [...mem().values()]
    .filter((e) => open.includes(e.status) && matchesScope(e, options))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export async function getExecutionsToday(options = {}) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await filterQuery(db.client
      .from('trade_executions')
      .select('*')
      .gte('created_at', start.toISOString())
      .order('created_at', { ascending: false }), options);
    if (error) throw error;
    return data || [];
  }
  return [...mem().values()].filter((e) => new Date(e.created_at) >= start && matchesScope(e, options));
}

export async function getRecentExecutions(limit = 50, options = {}) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await filterQuery(db.client
      .from('trade_executions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit), options);
    if (error) throw error;
    return data || [];
  }
  return [...mem().values()]
    .filter((execution) => matchesScope(execution, options))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
}

export async function createExecution(record) {
  const db = getDb();
  const row = {
    ...record,
    exchange: record.exchange || 'bybit',
    user_id: record.user_id || null,
    mode: record.mode || null,
    created_at: record.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('trade_executions')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  const duplicate = [...mem().values()].find(
    (execution) =>
      execution.signal_id === row.signal_id &&
      execution.side === row.side &&
      (execution.exchange || 'bybit') === row.exchange &&
      (execution.user_id || null) === row.user_id &&
      !['FAILED', 'CANCELLED', 'REJECTED'].includes(execution.status)
  );
  if (duplicate) {
    const error = new Error('Execution already exists for signal and side');
    error.code = 'DUPLICATE_EXECUTION';
    throw error;
  }
  const id = row.id || `ex_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const full = { ...row, id };
  mem().set(id, full);
  return full;
}

export async function updateExecution(id, updates) {
  const db = getDb();
  const patch = { ...updates, updated_at: new Date().toISOString() };
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('trade_executions')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  const cur = mem().get(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  mem().set(id, next);
  return next;
}

export async function getExecutionById(id) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('trade_executions')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  return mem().get(id) || null;
}

/**
 * Every execution for one user/exchange/mode (newest first), optionally only those created
 * at or after `since`. Feeds the capital ledger and the closed-trade PnL sync.
 */
export async function getLedgerExecutions(options = {}, since = null) {
  const db = getDb();
  if (db.type === 'supabase') {
    let q = filterQuery(db.client.from('trade_executions').select('*'), options);
    if (options.mode) q = q.eq('mode', options.mode);
    if (since) q = q.gte('created_at', new Date(since).toISOString());
    const { data, error } = await q.order('created_at', { ascending: false }).limit(5000);
    if (error) throw error;
    return data || [];
  }
  const t = since ? new Date(since).getTime() : null;
  return [...mem().values()]
    .filter((e) => matchesScope(e, options))
    .filter((e) => !options.mode || e.mode === options.mode)
    .filter((e) => t == null || new Date(e.created_at).getTime() >= t)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

const OPEN_STATUSES = [
  'PENDING', 'PLACING', 'PLACED', 'WAITING_FILL', 'VERIFY_UNKNOWN',
  'PROTECTING', 'FILLED', 'PROTECTED', 'PARTIALLY_FILLED', 'UNPROTECTED',
];

/** How many of a user's executions are still live (position or order may exist on the exchange). */
export async function countOpenExecutionsForUser(userId) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { count, error } = await db.client
      .from('trade_executions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', OPEN_STATUSES);
    if (error) throw error;
    return count || 0;
  }
  return [...mem().values()].filter((e) => e.user_id === userId && OPEN_STATUSES.includes(e.status)).length;
}

/** Delete a user's whole trade history (every exchange and mode). Returns the number of rows removed. */
export async function deleteExecutionsForUser(userId) {
  if (!userId) throw new Error('userId required');
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('trade_executions')
      .delete()
      .eq('user_id', userId)
      .select('id');
    if (error) throw error;
    return (data || []).length;
  }
  let n = 0;
  for (const [id, e] of mem().entries()) {
    if (e.user_id === userId) {
      mem().delete(id);
      n += 1;
    }
  }
  return n;
}
