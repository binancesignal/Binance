/**
 * SK SYSTEM PRO — persistence (Supabase tables from sql/012_sk_system.sql; in-memory only in development).
 * Setups are never overwritten by a different setup: the id is the 4H structure, events and snapshots are
 * append-only (unique per stage), so history and old charts stay exactly as they were.
 */
import { getDb } from '../database/index.js';
import { SK_STRATEGY, skSetupNo } from './config.js';

const mem = (db) => (db.store.sk ||= { setups: new Map(), events: [], snapshots: [], runs: new Map() });
const isoOr = (v) => (v ? new Date(v).toISOString() : null);

const SUMMARY_COLS =
  'id,symbol,dir,strategy,primary_tf,stage,max_stage,status,outcome,score,quality,a,b,c,d,fib,entry,hits,invalidation,current_price,close_reason,scan_run_id,created_at,updated_at,last_scanned_at,closed_at';

export function toRow(s) {
  return {
    id: s.id,
    symbol: s.symbol,
    dir: s.dir,
    strategy: s.strategy || SK_STRATEGY,
    primary_tf: s.primaryTf || '4h',
    stage: s.stage,
    max_stage: s.maxStage || s.stage,
    status: s.status || 'OPEN',
    outcome: s.outcome ?? null,
    score: Math.round(+s.score || 0),
    quality: s.quality ?? null,
    a: s.A ?? null,
    b: s.B ?? null,
    c: s.C ?? null,
    d: s.D ?? null,
    fib: s.fib ?? null,
    entry: s.entry ?? null,
    hits: s.hits ?? null,
    invalidation: s.invalidation ?? null,
    analysis: s.analysis ?? undefined,
    current_price: Number.isFinite(+s.currentPrice) ? +s.currentPrice : null,
    close_reason: s.closeReason ?? null,
    scan_run_id: s.scanRunId ?? null,
    created_at: isoOr(s.createdAt) || new Date().toISOString(),
    updated_at: isoOr(s.updatedAt) || new Date().toISOString(),
    last_scanned_at: isoOr(s.lastScannedAt),
    closed_at: isoOr(s.closedAt),
  };
}

export function fromRow(r) {
  if (!r) return null;
  const n = (v) => (v == null ? null : +v);
  return {
    id: r.id,
    setup: skSetupNo(r.id), // 1 = original 4H setup · 2 = intraday 1H setup (id prefix sk2_) — no DB column needed
    symbol: r.symbol,
    dir: r.dir,
    strategy: r.strategy,
    strategyName: 'SK SYSTEM PRO',
    primaryTf: r.primary_tf,
    stage: r.stage,
    maxStage: r.max_stage,
    status: r.status,
    outcome: r.outcome,
    score: r.score,
    quality: r.quality,
    A: r.a,
    B: r.b,
    C: r.c,
    D: r.d,
    fib: r.fib,
    entry: r.entry,
    hits: r.hits,
    invalidation: r.invalidation,
    analysis: r.analysis,
    currentPrice: n(r.current_price),
    closeReason: r.close_reason,
    scanRunId: r.scan_run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastScannedAt: r.last_scanned_at,
    closedAt: r.closed_at,
  };
}

function tableError(e) {
  if (e && /sk_(setups|setup_events|setup_snapshots|scan_runs)/.test(String(e.message || '')) && /(does not exist|schema cache|relation)/i.test(String(e.message))) {
    const err = new Error('SK SYSTEM tables are missing — run sql/012_sk_system.sql (supabase/migrations/008_sk_system.sql) in Supabase');
    err.code = 'SK_MIGRATION_MISSING';
    return err;
  }
  return e;
}

// ── setups ───────────────────────────────────────────────────────────────────────────────────
export async function getSetup(id) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('sk_setups').select('*').eq('id', id).maybeSingle();
    if (error) throw tableError(error);
    return fromRow(data);
  }
  return mem(db).setups.get(id) ? { ...mem(db).setups.get(id) } : null;
}

/** insert or update (never touches `createdAt` of an existing row) */
export async function saveSetup(setup) {
  const db = getDb();
  const row = toRow(setup);
  if (db.type === 'supabase') {
    const existing = await getSetup(setup.id);
    if (existing) {
      delete row.created_at;
      if (row.analysis === undefined) delete row.analysis;
      const { error } = await db.client.from('sk_setups').update(row).eq('id', setup.id);
      if (error) throw tableError(error);
    } else {
      if (row.analysis === undefined) row.analysis = null;
      const { error } = await db.client.from('sk_setups').insert(row);
      if (error) throw tableError(error);
    }
    return getSetup(setup.id);
  }
  const m = mem(db);
  const prev = m.setups.get(setup.id);
  const clean = Object.fromEntries(Object.entries(setup).filter(([, v]) => v !== undefined));
  const merged = { ...(prev || {}), ...clean, createdAt: prev?.createdAt || setup.createdAt || new Date().toISOString() };
  m.setups.set(setup.id, merged);
  return { ...merged };
}

export async function listSetups(f = {}) {
  const limit = Math.min(1000, Math.max(1, Math.round(+f.limit) || 200));
  const db = getDb();
  let rows;
  if (db.type === 'supabase') {
    let q = db.client.from('sk_setups').select(SUMMARY_COLS).order('created_at', { ascending: false }).limit(limit + 1000);
    if (f.dir) q = q.eq('dir', f.dir);
    if (f.status) q = q.eq('status', f.status);
    if (f.stage) q = q.eq('stage', f.stage);
    if (f.symbol) q = q.ilike('symbol', `%${String(f.symbol).replace(/[%_]/g, '')}%`);
    if (f.from) q = q.gte('created_at', isoOr(f.from));
    if (f.to) q = q.lte('created_at', isoOr(f.to));
    if (f.minScore) q = q.gte('score', Math.round(+f.minScore));
    if (f.tf) q = q.eq('primary_tf', f.tf);
    if (+f.setup === 2) q = q.like('id', 'sk2_%');
    else if (+f.setup === 1) q = q.not('id', 'like', 'sk2_%');
    const { data, error } = await q;
    if (error) throw tableError(error);
    rows = (data || []).map(fromRow);
  } else {
    rows = [...mem(db).setups.values()].map((s) => {
      const { analysis, ...rest } = s;
      return rest;
    });
    rows = rows
      .filter((s) => (!f.dir || s.dir === f.dir) && (!f.status || s.status === f.status) && (!f.stage || s.stage === f.stage) && (!f.symbol || s.symbol.includes(String(f.symbol).toUpperCase())))
      .filter((s) => (!f.from || Date.parse(s.createdAt) >= Date.parse(f.from)) && (!f.to || Date.parse(s.createdAt) <= Date.parse(f.to)))
      .filter((s) => (!f.minScore || s.score >= +f.minScore) && (!f.tf || s.primaryTf === f.tf))
      .filter((s) => !f.setup || skSetupNo(s.id) === +f.setup)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  return rows.slice(0, limit);
}

export async function listOpenSetups(limit = 300) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('sk_setups').select(SUMMARY_COLS).eq('status', 'OPEN').order('updated_at', { ascending: true }).limit(limit);
    if (error) throw tableError(error);
    return (data || []).map(fromRow);
  }
  return [...mem(db).setups.values()].filter((s) => s.status === 'OPEN').slice(0, limit).map((s) => ({ ...s }));
}

// ── events ───────────────────────────────────────────────────────────────────────────────────
/** idempotent: the same (setup, type, stage) is stored once */
export async function addEvent(ev) {
  const db = getDb();
  const row = { setup_id: ev.setupId, type: ev.type || 'STAGE', stage: ev.stage, price: ev.price ?? null, note: ev.note ?? null, at: isoOr(ev.at) || new Date().toISOString() };
  if (db.type === 'supabase') {
    const { error } = await db.client.from('sk_setup_events').upsert(row, { onConflict: 'setup_id,type,stage', ignoreDuplicates: true });
    if (error) throw tableError(error);
    return true;
  }
  const m = mem(db);
  if (m.events.some((e) => e.setup_id === row.setup_id && e.type === row.type && e.stage === row.stage)) return false;
  m.events.push(row);
  return true;
}

export async function listEvents(setupId) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('sk_setup_events').select('type,stage,price,note,at').eq('setup_id', setupId).order('at', { ascending: true });
    if (error) throw tableError(error);
    return data || [];
  }
  return mem(db).events.filter((e) => e.setup_id === setupId).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map(({ setup_id, ...r }) => r);
}

// ── snapshots (first analysis seen at each stage; never overwritten) ─────────────────────────
export async function addSnapshot(setupId, stage, analysis) {
  const db = getDb();
  const row = { setup_id: setupId, stage, score: analysis?.score ?? null, analysis, created_at: new Date().toISOString() };
  if (db.type === 'supabase') {
    const { error } = await db.client.from('sk_setup_snapshots').upsert(row, { onConflict: 'setup_id,stage', ignoreDuplicates: true });
    if (error) throw tableError(error);
    return true;
  }
  const m = mem(db);
  if (m.snapshots.some((s) => s.setup_id === setupId && s.stage === stage)) return false;
  m.snapshots.push(row);
  return true;
}

export async function listSnapshots(setupId) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('sk_setup_snapshots').select('stage,score,created_at').eq('setup_id', setupId).order('created_at', { ascending: true });
    if (error) throw tableError(error);
    return data || [];
  }
  return mem(db).snapshots.filter((s) => s.setup_id === setupId).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).map(({ analysis, setup_id, ...r }) => r);
}

export async function getSnapshot(setupId, stage) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('sk_setup_snapshots').select('stage,score,created_at,analysis').eq('setup_id', setupId).eq('stage', stage).maybeSingle();
    if (error) throw tableError(error);
    return data || null;
  }
  const s = mem(db).snapshots.find((x) => x.setup_id === setupId && x.stage === stage);
  return s ? { stage: s.stage, score: s.score, created_at: s.created_at, analysis: s.analysis } : null;
}

// ── scan runs ────────────────────────────────────────────────────────────────────────────────
const runToRow = (r) => ({
  id: r.id,
  status: r.status,
  universe: r.universe,
  top_n: r.topN ?? null,
  ranking: r.ranking ?? null,
  total: r.total,
  next_offset: r.offset,
  analyzed: r.analyzed,
  ok_count: r.ok,
  failed_count: r.failed,
  setups_found: r.setupsFound,
  current_symbol: r.currentSymbol ?? null,
  paused_reason: r.pausedReason ?? null,
  symbols: r.symbols || [],
  failed_symbols: r.failedSymbols || [],
  config: r.config ?? null,
  owner_id: r.owner ?? null,
  started_at: isoOr(r.startedAt) || new Date().toISOString(),
  updated_at: new Date().toISOString(),
  finished_at: isoOr(r.finishedAt),
});
const runFromRow = (r) =>
  r && {
    id: r.id,
    status: r.status,
    universe: r.universe,
    topN: r.top_n,
    ranking: r.ranking,
    total: r.total,
    offset: r.next_offset,
    analyzed: r.analyzed,
    ok: r.ok_count,
    failed: r.failed_count,
    setupsFound: r.setups_found,
    currentSymbol: r.current_symbol,
    pausedReason: r.paused_reason,
    symbols: r.symbols || [],
    failedSymbols: r.failed_symbols || [],
    config: r.config,
    owner: r.owner_id ?? null,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  };

export async function saveRun(run) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { error } = await db.client.from('sk_scan_runs').upsert(runToRow(run));
    if (error) throw tableError(error);
    return run;
  }
  mem(db).runs.set(run.id, { ...run, updatedAt: new Date().toISOString() });
  return run;
}

export async function getRun(id) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('sk_scan_runs').select('*').eq('id', id).maybeSingle();
    if (error) throw tableError(error);
    return runFromRow(data);
  }
  const r = mem(db).runs.get(id);
  return r ? { ...r } : null;
}

/**
 * newest run that is running or paused (resumable) — otherwise the newest run of any state.
 * owner: a user id → only that user's runs · undefined → any run (cron / admin overview)
 */
export async function getLatestRun(owner) {
  const db = getDb();
  const mine = (r) => owner === undefined || (r.owner ?? null) === owner;
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('sk_scan_runs').select('*').order('started_at', { ascending: false }).limit(30);
    if (error) throw tableError(error);
    const list = (data || []).map(runFromRow).filter(mine);
    return list.find((r) => r.status === 'running' || r.status === 'paused') || list[0] || null;
  }
  const list = [...mem(db).runs.values()].filter(mine).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const r = list.find((x) => x.status === 'running' || x.status === 'paused') || list[0] || null;
  return r ? { ...r } : null;
}

/** keep only the newest `maxHistory` CLOSED setups (events + snapshots cascade) */
export async function pruneHistory(maxHistory) {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client.from('sk_setups').select('id').eq('status', 'CLOSED').order('closed_at', { ascending: false, nullsFirst: false }).range(maxHistory, maxHistory + 500);
    if (error) throw tableError(error);
    const ids = (data || []).map((r) => r.id);
    if (ids.length) await db.client.from('sk_setups').delete().in('id', ids);
    return ids.length;
  }
  const m = mem(db);
  const closed = [...m.setups.values()].filter((s) => s.status === 'CLOSED').sort((a, b) => Date.parse(b.closedAt || b.createdAt) - Date.parse(a.closedAt || a.createdAt));
  const drop = closed.slice(maxHistory).map((s) => s.id);
  for (const id of drop) m.setups.delete(id);
  m.events = m.events.filter((e) => !drop.includes(e.setup_id));
  m.snapshots = m.snapshots.filter((e) => !drop.includes(e.setup_id));
  return drop.length;
}

export async function clearAll() {
  const db = getDb();
  if (db.type === 'supabase') {
    // children first (also cascade on delete)
    for (const t of ['sk_setup_events', 'sk_setup_snapshots']) {
      const { error } = await db.client.from(t).delete().gt('id', 0);
      if (error) throw tableError(error);
    }
    for (const t of ['sk_setups', 'sk_scan_runs']) {
      const { error } = await db.client.from(t).delete().not('id', 'is', null);
      if (error) throw tableError(error);
    }
    return;
  }
  db.store.sk = { setups: new Map(), events: [], snapshots: [], runs: new Map() };
}
