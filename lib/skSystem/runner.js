/**
 * SK SYSTEM PRO — runner: setup upsert (no duplicates, forward-only), lifecycle tracking and the resumable,
 * chunked market scan. The scan state lives in sk_scan_runs, so it survives restarts / serverless timeouts:
 * a run is "completed" only when EVERY selected symbol has been attempted.
 */
import { getState, setState } from '../database/appState.js';
import { SK_CONFIG_KEY, SK_CONFIG2_KEY, SK_LOCK_KEY, SK_STATUS_KEY, SK_STRATEGY, SK_STRATEGY_NAME, normalizeSkConfig, stageRank, SK_TERMINAL, TF_SEC, skSetupNo, skTfs } from './config.js';
import { analyzeSymbol, skSetupId } from './engine.js';
import { evaluateSetup, trackingTf } from './lifecycle.js';
import { selectUniverse } from './universe.js';
import * as store from './store.js';

const LOCK_TTL_MS = 3 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

// fields that belong to the SCAN itself (universe, speed, auto-scan, history) — always taken from Setup 1's settings
const SHARED_KEYS = ['scanUniverse', 'topN', 'rankingMethod', 'maxConcurrent', 'batchSize', 'retryCount', 'retryDelayMs', 'userScanMax', 'autoScan', 'autoScanIntervalMin', 'maxHistory'];

/** Setup 1 (default) — or Setup 2: its own strategy settings + the scan settings shared with Setup 1 */
export async function getSkConfig(setup = 1) {
  const no = skSetupNo(setup);
  let c1;
  try {
    c1 = normalizeSkConfig(await getState(SK_CONFIG_KEY, null), 1);
  } catch (_) {
    c1 = normalizeSkConfig(null, 1);
  }
  if (no === 1) return c1;
  let c2;
  try {
    c2 = normalizeSkConfig(await getState(SK_CONFIG2_KEY, null), 2);
  } catch (_) {
    c2 = normalizeSkConfig(null, 2);
  }
  for (const k of SHARED_KEYS) c2[k] = c1[k];
  c2.enabled = c1.enabled && c2.enabled; // the master switch (Setup 1's "enabled") switches the whole SK System
  return c2;
}

/** both setups' configs (Setup 2 is skipped when it is switched off) */
export async function getSkConfigs() {
  const [c1, c2] = await Promise.all([getSkConfig(1), getSkConfig(2)]);
  return { 1: c1, 2: c2 };
}

/** which setups a run covers: an explicit list from the caller, else every enabled setup */
export function activeSetups(cfgs, wanted) {
  const list = (Array.isArray(wanted) && wanted.length ? wanted : [1, 2]).map(skSetupNo).filter((n, i, a) => a.indexOf(n) === i);
  return list.filter((n) => cfgs[n]?.enabled);
}

async function defaultDeps() {
  return import('../exchange/index.js');
}

async function pool(items, worker, size) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, size), items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await worker(items[i], i);
      }
    })
  );
}

// one chunk at a time PER RUN (different users' scans do not block each other; the exchange client shares its kline cache)
const lockKey = (runId) => `${SK_LOCK_KEY}:${runId}`;
async function acquireLock(runId, force) {
  try {
    const cur = await getState(lockKey(runId), null);
    if (!force && cur?.at && Date.now() - cur.at < LOCK_TTL_MS) return false;
    await setState(lockKey(runId), { at: Date.now() });
  } catch (_) {}
  return true;
}
const releaseLock = async (runId) => {
  try {
    await setState(lockKey(runId), { at: 0 });
  } catch (_) {}
};


const secIso = (sec) => new Date((Number.isFinite(+sec) && +sec > 0 ? +sec : Date.now() / 1000) * 1000).toISOString();
/** lifecycle events for every stage the structure itself proves, stamped with the time that stage happened */
export function stageEvents(analysis, id, fromRankExclusive = -1) {
  const h = analysis.h4;
  const at = {
    TREND_DETECTED: h.priorLegs?.[0]?.time,
    CHOCH_CONFIRMED: h.choch?.breakTime,
    SWING_CONFIRMED: h.B?.time,
    FIBONACCI_ACTIVE: h.C?.time,
    ABCD_DEVELOPING: h.C?.time,
    C_ZONE_REACHED: h.czone?.reachedTime,
    LTF_CONFIRMATION: analysis.ltf?.[analysis.tfs?.struct || '1h']?.choch ? analysis.ltf[analysis.tfs?.struct || '1h'].choch.breakTime + (TF_SEC[analysis.tfs?.struct || '1h'] || 3600) : null,
    ENTRY_READY: analysis.entry?.armedAt,
  };
  const out = [];
  for (const stage of Object.keys(at)) {
    const r = stageRank(stage);
    if (r <= fromRankExclusive || r > stageRank(analysis.stage)) continue;
    out.push({ setupId: id, type: 'STAGE', stage, at: secIso(at[stage]), note: stage === analysis.stage ? null : 'reached on the way (from the stored structure)' });
  }
  return out;
}

/** build the persisted setup record from an analysis */
function recordFrom(analysis, price, runId, prev) {
  const locked = analysis.stage === 'ENTRY_READY' && analysis.entry ? { ...analysis.entry, locked: true } : prev?.entry || null;
  return {
    id: skSetupId(analysis.symbol, analysis.dir, analysis.h4.A.time, analysis.setup),
    setup: analysis.setup || 1,
    symbol: analysis.symbol,
    dir: analysis.dir,
    strategy: SK_STRATEGY,
    strategyName: SK_STRATEGY_NAME,
    primaryTf: analysis.primaryTf,
    stage: analysis.stage,
    maxStage: analysis.stage,
    status: 'OPEN',
    score: analysis.score,
    quality: analysis.quality,
    A: analysis.h4.A,
    B: analysis.h4.B,
    C: analysis.h4.C,
    D: analysis.h4.D,
    fib: analysis.h4.fib,
    entry: locked,
    analysis,
    currentPrice: price ?? prev?.currentPrice ?? null,
    scanRunId: runId || prev?.scanRunId || null,
    updatedAt: nowIso(),
    lastScannedAt: nowIso(),
  };
}

/**
 * Store a detected analysis. Never creates a second setup for the same 4H structure, never moves a setup
 * backwards, never re-prices an armed entry.
 * @returns {{action:'created'|'advanced'|'refreshed'|'ignored'|'below-threshold', id?:string}}
 */
export async function upsertFromAnalysis({ analysis, price, cfg, runId }) {
  if (!analysis || stageRank(analysis.stage) < stageRank(cfg.storeFromStage)) return { action: 'below-threshold' };
  const id = skSetupId(analysis.symbol, analysis.dir, analysis.h4.A.time, analysis.setup);
  const existing = await store.getSetup(id);
  if (!existing) {
    const rec = recordFrom(analysis, price, runId, null);
    rec.createdAt = nowIso();
    await store.saveSetup(rec);
    await store.addSnapshot(id, analysis.stage, analysis);
    for (const e of stageEvents(analysis, id)) await store.addEvent({ ...e, price: e.stage === analysis.stage ? price : null, note: e.stage === analysis.stage ? `${SK_STRATEGY_NAME} setup detected` : e.note });
    return { action: 'created', id };
  }
  if (existing.status === 'CLOSED') return { action: 'ignored', id };
  const locked = !!existing.entry?.locked;
  const forward = stageRank(analysis.stage) > stageRank(existing.maxStage || existing.stage);
  const sameEarly = !forward && analysis.stage === existing.stage && stageRank(existing.stage) < stageRank('C_ZONE_REACHED');
  if (locked || (!forward && !sameEarly)) {
    // keep the original analysis & levels; only note that it was seen again
    await store.saveSetup({ ...existing, analysis: undefined, currentPrice: price ?? existing.currentPrice, lastScannedAt: nowIso() });
    return { action: 'ignored', id };
  }
  const rec = recordFrom(analysis, price, runId, existing);
  rec.createdAt = existing.createdAt;
  rec.hits = existing.hits || null;
  rec.maxStage = forward ? analysis.stage : existing.maxStage;
  await store.saveSetup(rec);
  if (forward) {
    await store.addSnapshot(id, analysis.stage, analysis);
    for (const e of stageEvents(analysis, id, stageRank(existing.maxStage || existing.stage))) await store.addEvent({ ...e, price: e.stage === analysis.stage ? price : null, note: e.stage === analysis.stage ? `stage ${existing.stage} → ${analysis.stage}` : e.note });
  }
  return { action: forward ? 'advanced' : 'refreshed', id };
}

/** analyse ONE symbol (with retries) and store what it finds */
export async function scanSymbol({ symbol, deps, cfg, runId, price }) {
  const getCandles = (tf, limit) => deps.getKlines(symbol, tf, limit);
  let lastErr;
  for (let attempt = 0; attempt <= cfg.retryCount; attempt++) {
    try {
      const res = await analyzeSymbol({ symbol, getCandles, cfg, price });
      const stored = [];
      for (const r of res.results) {
        if (!r.analysis) continue;
        const u = await upsertFromAnalysis({ analysis: r.analysis, price, cfg, runId });
        if (u.action !== 'below-threshold') stored.push({ dir: r.dir, ...u, stage: r.analysis.stage });
      }
      return { ok: true, stored, results: res.results.map((r) => ({ dir: r.dir, stage: r.analysis?.stage || null, reason: r.reason })) };
    } catch (e) {
      if (e?.banned || e?.throttled) throw e;
      lastErr = e;
      if (attempt < cfg.retryCount) await sleep(cfg.retryDelayMs * (attempt + 1));
    }
  }
  return { ok: false, error: lastErr?.message || 'failed' };
}

/** replay lifecycle for the open setups (oldest-checked first) */
export async function trackOpenSetups({ deps, cfg, cfgs, budgetMs = 20_000, nowSec = Math.floor(Date.now() / 1000) }) {
  const t0 = Date.now();
  // every open setup is tracked with the settings of ITS OWN setup (expiry hours differ), whether or not that setup is still scanning
  if (!cfgs) cfgs = cfg ? { 1: cfg } : await getSkConfigs();
  cfg = cfg || cfgs[1];
  const cfgOf = (id) => cfgs[skSetupNo(id)] || cfgs[1] || cfg;
  const open = await store.listOpenSetups(300);
  const out = { tracked: 0, closed: 0, events: 0, errors: [] };
  let stopped = null;
  await pool(open, async (s) => {
    if (stopped || Date.now() - t0 > budgetMs) return;
    try {
      const full = await store.getSetup(s.id);
      if (!full || full.status === 'CLOSED') return;
      const ctx = {};
      if (full.entry?.locked) {
        const age = Math.max(60, nowSec - full.entry.armedAt);
        const tf = trackingTf(age);
        const limit = Math.min(1500, Math.ceil(age / TF_SEC[tf]) + 6);
        const candles = await deps.getKlines(full.symbol, tf, limit);
        ctx.candles = candles;
        ctx.price = candles.length ? candles[candles.length - 1].close : null;
      } else {
        const c4h = await deps.getKlines(full.symbol, full.primaryTf || '4h', 120);
        ctx.c4h = c4h;
        ctx.price = c4h.length ? c4h[c4h.length - 1].close : null;
      }
      const events = await store.listEvents(full.id);
      full.eventKeys = events.map((e) => e.stage);
      const { patch, events: evs } = evaluateSetup(full, ctx, nowSec, cfgOf(full.id));
      for (const e of evs) if (await store.addEvent(e)) out.events++;
      const changed = Object.keys(patch).length > 0;
      if (changed) {
        const next = { ...full, ...patch, analysis: undefined, updatedAt: nowIso(), lastScannedAt: nowIso() };
        if (patch.stage && stageRank(patch.stage) > stageRank(full.maxStage || full.stage)) next.maxStage = patch.stage;
        delete next.eventKeys;
        await store.saveSetup(next);
        if (patch.status === 'CLOSED') out.closed++;
      }
      out.tracked++;
    } catch (e) {
      if (e?.banned || e?.throttled) stopped = e.banned ? 'banned' : 'throttled';
      out.errors.push(`${s.symbol}: ${e.message}`);
    }
  }, cfg.maxConcurrent);
  out.stopped = stopped || undefined;
  return out;
}

// ── scan runs ────────────────────────────────────────────────────────────────────────────────
export async function startRun({ cfg, cfgs, setups, deps, mode, topN, ranking, symbols, owner = null } = {}) {
  deps = deps || (await defaultDeps());
  cfgs = cfgs || { 1: cfg };
  const sets = activeSetups(cfgs, setups);
  const m = mode === 'all' || mode === 'top' ? mode : cfg.scanUniverse;
  const rk = ranking || cfg.rankingMethod;
  const n = Math.max(1, Math.round(+topN) || cfg.topN);
  const [eligible, tickers] = await Promise.all([deps.loadExchangeInfo(), deps.loadTickers()]);
  const list = selectUniverse({ mode: m, topN: n, ranking: rk, eligible, tickers, symbols });
  const run = {
    id: `skrun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    status: list.length ? 'running' : 'completed',
    universe: m,
    topN: m === 'top' ? n : null,
    ranking: rk,
    total: list.length,
    offset: 0,
    analyzed: 0,
    ok: 0,
    failed: 0,
    setupsFound: 0,
    currentSymbol: null,
    pausedReason: null,
    symbols: list,
    failedSymbols: [],
    owner,
    config: { batchSize: cfg.batchSize, maxConcurrent: cfg.maxConcurrent, retryCount: cfg.retryCount, eligible: eligible.length, setups: sets.length ? sets : [1] },
    startedAt: nowIso(),
    finishedAt: list.length ? null : nowIso(),
  };
  await store.saveRun(run);
  return run;
}

export async function setRunStatus(id, status, reason = null) {
  const run = await store.getRun(id);
  if (!run) return null;
  if (run.status === 'completed') return run;
  run.status = status;
  run.pausedReason = reason;
  await store.saveRun(run);
  return run;
}

/** process as many batches as the time budget allows; safe to call repeatedly (client loop / cron) */
export async function runChunk({ runId, deps, cfg, cfgs, budgetMs = 40_000, force = false } = {}) {
  deps = deps || (await defaultDeps());
  if (!cfgs) cfgs = cfg ? { 1: cfg } : await getSkConfigs(); // an explicit single `cfg` = Setup 1 only (as before)
  cfg = cfg || cfgs[1];
  const t0 = Date.now();
  const left = () => budgetMs - (Date.now() - t0);
  let run = await store.getRun(runId);
  if (!run) return { ok: false, error: 'run not found' };
  if (run.status !== 'running') return { ok: true, run, skipped: `run is ${run.status}` };
  if (!(await acquireLock(runId, force))) return { ok: true, run, skipped: 'another SK scan chunk is running' };
  try {
    let tickers = {};
    try {
      tickers = await deps.loadTickers();
    } catch (_) {}
    // lifecycle first (cheap) — once per run, at its start
    if (run.offset === 0 && !run.trackedAt) {
      try {
        await trackOpenSetups({ deps, cfg, cfgs: cfgs[2] ? cfgs : { ...cfgs, 2: await getSkConfig(2) }, budgetMs: Math.min(15_000, budgetMs * 0.3) });
      } catch (_) {}
      run.trackedAt = nowIso();
    }
    while (run.offset < run.total && left() > 6_000) {
      const batch = run.symbols.slice(run.offset, run.offset + cfg.batchSize);
      let stopped = null;
      const batchOk = [];
      const batchFail = [];
      let found = 0;
      await pool(batch, async (symbol) => {
        if (stopped) return;
        run.currentSymbol = symbol;
        try {
          const t = tickers[symbol];
          const price = t ? +(t.markPrice || t.price) || undefined : undefined;
          // one pass per selected setup (Setup 1 and/or Setup 2); the exchange client shares the candles they have in common
          let bad = null;
          for (const n of run.config?.setups?.length ? run.config.setups : [1]) {
            const c = cfgs[n] || (n === 1 ? cfg : await getSkConfig(n));
            const r = await scanSymbol({ symbol, deps, cfg: c, runId: run.id, price });
            if (r.ok) found += r.stored.filter((x) => x.action === 'created' || x.action === 'advanced').length;
            else bad = bad || `${r.error}${n === 2 ? ' (Setup 2)' : ''}`;
          }
          if (!bad) batchOk.push(symbol);
          else batchFail.push({ symbol, error: bad });
        } catch (e) {
          if (e?.banned || e?.throttled) stopped = e.banned ? `Binance banned this IP: ${e.message}` : `rate limited: ${e.message}`;
          else batchFail.push({ symbol, error: e.message });
        }
      }, cfg.maxConcurrent);
      if (stopped) {
        // do not advance: the whole batch is retried on resume (dedupe makes that safe)
        run.status = 'paused';
        run.pausedReason = stopped;
        break;
      }
      run.offset += batch.length;
      run.analyzed += batch.length;
      run.ok += batchOk.length;
      run.failed += batchFail.length;
      run.setupsFound += found;
      run.failedSymbols = [...run.failedSymbols, ...batchFail].slice(-200);
      await store.saveRun(run);
    }
    if (run.status === 'running' && run.offset >= run.total) {
      run.status = 'completed';
      run.currentSymbol = null;
      run.finishedAt = nowIso();
      try {
        await store.pruneHistory(cfg.maxHistory);
      } catch (_) {}
    }
    await store.saveRun(run);
    try {
      await setState(SK_STATUS_KEY, { runId: run.id, status: run.status, at: nowIso(), analyzed: run.analyzed, total: run.total });
    } catch (_) {}
    return { ok: true, run, durationMs: Date.now() - t0 };
  } finally {
    await releaseLock(runId);
  }
}

/** cron tick: advance a running scan, or (auto-scan ON) start a fresh one when the interval has passed */
export async function runCronPass({ deps, budgetMs = 45_000, source = 'cron' } = {}) {
  const cfgs = await getSkConfigs();
  const cfg = cfgs[1];
  if (!cfg.enabled) return { ok: true, skipped: 'SK SYSTEM is disabled' };
  deps = deps || (await defaultDeps());
  let run = await store.getLatestRun();
  if (run && run.status === 'running') return runChunk({ runId: run.id, deps, cfg, cfgs, budgetMs });
  if (!cfg.autoScan) {
    const tr = await trackOpenSetups({ deps, cfg, cfgs, budgetMs: Math.min(20_000, budgetMs) });
    return { ok: true, tracked: tr, skipped: 'auto-scan is OFF' };
  }
  const last = run?.finishedAt || run?.startedAt;
  if (last && Date.now() - Date.parse(last) < cfg.autoScanIntervalMin * 60_000 && run.status !== 'paused') {
    const tr = await trackOpenSetups({ deps, cfg, cfgs, budgetMs: Math.min(20_000, budgetMs) });
    return { ok: true, tracked: tr, skipped: 'interval not reached' };
  }
  if (run && run.status === 'paused') {
    run = await setRunStatus(run.id, 'running');
    return runChunk({ runId: run.id, deps, cfg, cfgs, budgetMs });
  }
  run = await startRun({ cfg, cfgs, deps });
  return runChunk({ runId: run.id, deps, cfg, cfgs, budgetMs, source });
}

export { SK_TERMINAL };
