import { getDb } from './index.js';

const LOCK_KEY = 'scan_lock';
// Vercel Hobby hard-caps functions at 60s regardless of maxDuration set in
// code, so any scan still "RUNNING" past that was killed mid-flight and
// never released its lock. Keep this just above the real cap so a dead
// scan self-clears fast instead of blocking the button for minutes.
const LOCK_TTL_MS = 70 * 1000; // 70s (Hobby kill is ~60s)

export async function createScanRun(meta = {}) {
  const db = getDb();
  const row = {
    started_at: new Date().toISOString(),
    status: 'RUNNING',
    symbols_scanned: 0,
    signals_created: 0,
    signals_updated: 0,
    ready_count: 0,
    ongoing_count: 0,
    watching_count: 0,
    error_count: 0,
    metadata: meta,
  };
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('scan_runs')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  row.id = `scan_${Date.now()}`;
  db.store.scanRuns.push(row);
  return row;
}

export async function completeScanRun(id, updates) {
  const db = getDb();
  const patch = {
    ...updates,
    completed_at: new Date().toISOString(),
    status: updates.status || 'COMPLETED',
  };
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('scan_runs')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  const idx = db.store.scanRuns.findIndex((r) => r.id === id);
  if (idx >= 0) {
    db.store.scanRuns[idx] = { ...db.store.scanRuns[idx], ...patch };
    return db.store.scanRuns[idx];
  }
  return null;
}

export async function getLastScanRun() {
  const db = getDb();
  if (db.type === 'supabase') {
    const { data, error } = await db.client
      .from('scan_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  const runs = db.store.scanRuns;
  return runs.length ? runs[runs.length - 1] : null;
}

/**
 * Try once to acquire the scan lock (non-blocking).
 * @param {{ mode?: 'normal'|'full' }} opts
 */
export async function tryAcquireScanLock(opts = {}) {
  const db = getDb();
  const now = Date.now();
  const mode = opts.mode === 'full' ? 'full' : 'normal';

  if (db.type === 'memory') {
    if (db.store.lock && now - db.store.lock < (db.store.lockTtl || LOCK_TTL_MS)) {
      return {
        acquired: false,
        reason: 'Scan already running (memory lock)',
        mode,
      };
    }
    db.store.lock = now;
    db.store.lockMode = mode;
    db.store.lockTtl = opts.ttlMs > 0 ? +opts.ttlMs : LOCK_TTL_MS;
    return { acquired: true, mode };
  }

  // Supabase: use scan_runs with status RUNNING as soft lock
  const { data: runningList } = await db.client
    .from('scan_runs')
    .select('id, started_at, metadata')
    .eq('status', 'RUNNING')
    .order('started_at', { ascending: false })
    .limit(20);

  // Each run stores its own TTL (a full-scan legitimately runs longer than a 1-min scan),
  // so a long full-scan is never mistaken for a dead run by the 1-min cron.
  const ttlOf = (r) => (+r?.metadata?.ttlMs > 0 ? +r.metadata.ttlMs : LOCK_TTL_MS);
  const running = (runningList || []).find(
    (r) => now - new Date(r.started_at).getTime() < ttlOf(r)
  );
  if (running) {
    return {
      acquired: false,
      reason: 'Previous scan still RUNNING',
      mode,
      runningAgeMs: now - new Date(running.started_at).getTime(),
      runningSource: running.metadata?.source || null,
    };
  }

  // Clear ALL stale RUNNING rows (Hobby kills leave them stuck)
  if (runningList?.length) {
    const staleIds = runningList
      .filter((r) => now - new Date(r.started_at).getTime() >= ttlOf(r))
      .map((r) => r.id);
    if (staleIds.length) {
      await db.client
        .from('scan_runs')
        .update({
          status: 'FAILED',
          error_message: 'Stale lock timeout',
          completed_at: new Date().toISOString(),
        })
        .in('id', staleIds);
    }
  }
  return { acquired: true, mode };
}

/**
 * Acquire lock. Full-scan mode waits/retries so it is NOT silently skipped
 * when it collides with the 1-min lifecycle cron.
 *
 * @param {{ mode?: 'normal'|'full', waitMs?: number, retryMs?: number }} opts
 */
export async function acquireScanLock(opts = {}) {
  const mode = opts.mode === 'full' ? 'full' : 'normal';
  // Full scan may wait for a concurrent 1-min scan to finish (Hobby ~60s).
  const waitMs = mode === 'full'
    ? (opts.waitMs != null ? +opts.waitMs : 55_000)
    : (opts.waitMs != null ? +opts.waitMs : 0);
  const retryMs = opts.retryMs != null ? +opts.retryMs : 2_000;

  const started = Date.now();
  let last = await tryAcquireScanLock({ mode });
  if (last.acquired) return last;

  if (waitMs <= 0) return last;

  while (Date.now() - started < waitMs) {
    await new Promise((r) => setTimeout(r, retryMs));
    last = await tryAcquireScanLock({ mode });
    if (last.acquired) {
      return { ...last, waitedMs: Date.now() - started };
    }
  }
  return {
    ...last,
    acquired: false,
    waitedMs: Date.now() - started,
    reason: last.reason || 'Lock busy after wait',
  };
}

/**
 * Atomically take the scan lock AND create the RUNNING scan_runs row.
 *
 * With migration 005 (unique partial index on scan_runs WHERE status='RUNNING') two crons that
 * fire in the same millisecond (e.g. the 1-min and 5-min cron at hh:05:00) cannot both win:
 * the second insert hits a unique violation and is treated as "busy". Without the migration this
 * degrades to the previous soft-lock behaviour.
 *
 * @param {object} meta   scan_runs.metadata (a ttlMs here overrides the default lock TTL)
 * @param {{ mode?: 'normal'|'full', waitMs?: number, retryMs?: number, ttlMs?: number }} opts
 * @returns {Promise<{acquired:boolean, run?:object, reason?:string, waitedMs?:number}>}
 */
export async function acquireScanRun(meta = {}, opts = {}) {
  const mode = opts.mode === 'full' ? 'full' : 'normal';
  const waitMs = Math.max(0, +opts.waitMs || 0);
  const retryMs = opts.retryMs != null ? +opts.retryMs : 2_000;
  const ttlMs = +opts.ttlMs > 0 ? +opts.ttlMs : LOCK_TTL_MS;
  const started = Date.now();
  let last = { acquired: false, reason: 'Lock busy' };

  for (;;) {
    const lock = await tryAcquireScanLock({ mode, ttlMs });
    if (lock.acquired) {
      try {
        const run = await createScanRun({ ...meta, ttlMs });
        return { acquired: true, run, mode, waitedMs: Date.now() - started };
      } catch (e) {
        if (e?.code !== '23505') throw e; // real error
        last = { acquired: false, reason: 'Another scan won the lock (concurrent start)', mode };
      }
    } else {
      last = lock;
    }
    if (Date.now() - started >= waitMs) break;
    await new Promise((r) => setTimeout(r, retryMs));
  }
  return { ...last, acquired: false, waitedMs: Date.now() - started };
}

/** Force-clear every RUNNING scan (for stuck locks). */
export async function forceUnlockAll() {
  const db = getDb();
  if (db.type === 'memory') {
    db.store.lock = null;
    return { cleared: 0 };
  }
  const { data } = await db.client
    .from('scan_runs')
    .update({
      status: 'FAILED',
      error_message: 'Force unlock',
      completed_at: new Date().toISOString(),
    })
    .eq('status', 'RUNNING')
    .select('id');
  return { cleared: data?.length ?? 0 };
}

export async function releaseScanLock() {
  const db = getDb();
  if (db.type === 'memory') {
    db.store.lock = null;
  }
  // Supabase lock is released by completing the scan_run
}


/**
 * Queue a full discovery scan if the lock could not be taken in time.
 * The next 1-min cron (or next full-scan) will consume this and run with resetCursor.
 */
export async function markPendingFullScan(reason = 'lock_busy') {
  const { setState } = await import('./appState.js');
  await setState('pending_full_scan', {
    at: new Date().toISOString(),
    reason: String(reason || 'lock_busy').slice(0, 200),
  });
  return true;
}

/** @returns {Promise<object|null>} pending payload if any */
export async function getPendingFullScan() {
  const { getState } = await import('./appState.js');
  const v = await getState('pending_full_scan', null);
  return v && typeof v === 'object' ? v : null;
}

/** Clear pending flag; returns previous value */
export async function consumePendingFullScan() {
  const { getState, setState } = await import('./appState.js');
  const prev = await getState('pending_full_scan', null);
  await setState('pending_full_scan', null);
  return prev && typeof prev === 'object' ? prev : null;
}
