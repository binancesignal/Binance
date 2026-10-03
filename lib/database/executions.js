import { getDb } from './index.js';

function mem() {
  const db = getDb();
  if (db.type === 'memory') {
    if (!db.store.executions) db.store.executions = new Map();
    return db.store.executions;
  }
  return null;
}

export async function getExecutionBySignal(signalId, side) {
  const db = getDb();
  if (db.type === 'supabase') {
    let q = db.client
      .from('trade_executions')
      .select('*')
      .eq('signal_id', signalId)
      .not('status', 'in', '("FAILED","CANCELLED","REJECTED","SKIPPED")')
      .order('created_at', { ascending: false })
      .limit(1);
    if (side) q = q.eq('side', side);
    const { data, error } = await q;
    if (error) throw error;
    return (data && data[0]) || null;
  }
  const rows = [...mem().values()].filter(
    (e) =>
      e.signal_id === signalId &&
      (!side || e.side === side) &&
      !['FAILED', 'CANCELLED', 'REJECTED', 'SKIPPED'].includes(e.status)
  );
  return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
}

/** Any prior attempt (including FAILED / SKIPPED) — used to stop auto-retry spam. */
export async function getAnyExecutionBySignal(signalId, side) {
  const db = getDb();
  if (db.type === 'supabase') {
    let q = db.client
      .from('trade_executions')
      .select('*')
      .eq('signal_id', signalId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (side) q = q.eq('side', side);
    const { data, error } = await q;
    if (error) throw error;
    return (data && data[0]) || null;
  }
  const rows = [...mem().values()].filter(
    (e) => e.signal_id === signalId && (!side || e.side === side)
  );
  return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
}

export async function getOpenExecutions() {
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
    const { data, error } = await db.client
      .from('trade_executions')
      .select('*')
      .in('status', open)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    return data || [];
  }
  return [...mem().values()]
    .filter((e) => open.includes(e.status))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export async function getExecutionsToday() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('trade_executions')
      .select('*')
      .gte('created_at', start.toISOString())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }
  return [...mem().values()].filter((e) => new Date(e.created_at) >= start);
}

export async function getRecentExecutions(limit = 50) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('trade_executions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }
  return [...mem().values()]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
}

export async function createExecution(record) {
  const db = getDb();
  const row = {
    ...record,
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
