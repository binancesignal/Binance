/**
 * Server-side Harmonic auto scan (phone off OK).
 *
 * Full discovery:
 *   - Starts at admin "start hour" in Asia/Colombo (default 01:00)
 *   - Repeats every intervalHours (default 1 → 01:00, 02:00, …)
 *   - Each full pass is paced in small chunks across many ticks
 *
 * Update pass (active signal coins only):
 *   - After any WATCHING/READY harmonic signal exists, every updateIntervalMinutes
 *     (default 1) those symbols are re-scanned and levels/status refreshed
 *
 * Triggers: /api/cron/harmonic-auto, GitHub Action, or any API piggyback (signals list).
 */
import { getState, setState } from '../database/appState.js';
import * as exchange from '../exchange/index.js';
import { selectUniverse } from '../skSystem/universe.js';
import { HS_SCAN_DEFAULTS, FAMILY_KEYS } from './strategy/harmonicScan/index.js';
import { runHarmonicStrategy } from './strategy/harmonic/index.js';
import {
  createSignal,
  getSignalById,
  updateSignal,
  getActiveSignals,
} from '../database/signals.js';
import { SIGNAL_STATUS } from '../config/signalConfig.js';
import { buildSignalId } from '../signals/signalId.js';

const STATE_ENABLED = 'harmonic_auto_enabled';
const STATE_INTERVAL = 'harmonic_auto_interval_hours';
const STATE_START_HOUR = 'harmonic_auto_start_hour'; // 0–23 Asia/Colombo
const STATE_UPDATE_MIN = 'harmonic_auto_update_minutes';
const STATE_CURSOR = 'harmonic_auto_cursor';
const STATE_LAST_CYCLE = 'harmonic_auto_last_cycle_at';
const STATE_LAST_UPDATE = 'harmonic_auto_last_update_at';
const STATE_STATUS = 'harmonic_auto_status';
const STATE_UI = 'harmonic_ui_config';
const STATE_CFG = 'harmonic_config';
const STATE_LOCK = 'harmonic_auto_lock';

const DEFAULT_INTERVAL_H = 1;
const DEFAULT_START_HOUR = 1; // 1 AM Sri Lanka
const DEFAULT_UPDATE_MIN = 1;
const CHUNK = 2;
const KLINE_LIMIT = 500;
const DEFAULT_TFS = ['1h', '2h', '4h'];
const TZ = 'Asia/Colombo';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Current wall clock in Asia/Colombo */
export function nowColombo(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const y = +parts.year;
  const mo = +parts.month;
  const d = +parts.day;
  const h = +parts.hour;
  const mi = +parts.minute;
  const s = +parts.second;
  // Approximate UTC ms for this Colombo civil time (IST = UTC+5:30)
  const utcMs = Date.UTC(y, mo - 1, d, h, mi, s) - (5 * 60 + 30) * 60 * 1000;
  return { y, mo, d, h, mi, s, utcMs, date };
}

function clampHour(v, fb = DEFAULT_START_HOUR) {
  const n = Math.round(+v);
  if (!Number.isFinite(n)) return fb;
  return Math.min(23, Math.max(0, n));
}

function clampIntervalH(v) {
  let h = +v;
  if (!Number.isFinite(h) || h < 0.25) h = DEFAULT_INTERVAL_H;
  if (h > 168) h = 168;
  return h;
}

function clampUpdateMin(v) {
  let m = Math.round(+v);
  if (!Number.isFinite(m) || m < 1) m = DEFAULT_UPDATE_MIN;
  if (m > 60) m = 60;
  return m;
}

/**
 * Full-scan slots for "today" in Colombo: startHour, startHour+interval, …
 * Returns the latest slot start (as utcMs) that is <= now, or null if none yet today.
 */
function latestDueSlotUtc(now, startHour, intervalHours) {
  const stepH = intervalHours;
  const stepMs = stepH * 3600 * 1000;
  // Build today's start slot in Colombo
  const startUtc =
    Date.UTC(now.y, now.mo - 1, now.d, startHour, 0, 0) - (5 * 60 + 30) * 60 * 1000;
  if (now.utcMs < startUtc) return null; // before first slot today
  const elapsed = now.utcMs - startUtc;
  const n = Math.floor(elapsed / stepMs);
  return startUtc + n * stepMs;
}

export async function getHarmonicAutoConfig() {
  const enabled = !!(await getState(STATE_ENABLED, false));
  const intervalHours = clampIntervalH(await getState(STATE_INTERVAL, DEFAULT_INTERVAL_H));
  const startHour = clampHour(await getState(STATE_START_HOUR, DEFAULT_START_HOUR));
  const updateMinutes = clampUpdateMin(await getState(STATE_UPDATE_MIN, DEFAULT_UPDATE_MIN));
  const cursor = (await getState(STATE_CURSOR, null)) || { offset: 0, total: 0 };
  const lastCycleAt = (await getState(STATE_LAST_CYCLE, null)) || null;
  const lastUpdateAt = (await getState(STATE_LAST_UPDATE, null)) || null;
  const status = (await getState(STATE_STATUS, null)) || null;
  const now = nowColombo();
  return {
    enabled,
    intervalHours,
    startHour,
    updateMinutes,
    timezone: TZ,
    colomboNow: `${String(now.h).padStart(2, '0')}:${String(now.mi).padStart(2, '0')}`,
    cursor,
    lastCycleAt,
    lastUpdateAt,
    status,
    chunk: CHUNK,
  };
}

export async function setHarmonicAutoConfig(patch = {}) {
  if (patch.enabled != null) await setState(STATE_ENABLED, !!patch.enabled);
  if (patch.intervalHours != null) await setState(STATE_INTERVAL, clampIntervalH(patch.intervalHours));
  if (patch.startHour != null) await setState(STATE_START_HOUR, clampHour(patch.startHour));
  if (patch.updateMinutes != null) await setState(STATE_UPDATE_MIN, clampUpdateMin(patch.updateMinutes));
  return getHarmonicAutoConfig();
}

async function loadScanConfig() {
  const ui = (await getState(STATE_UI, null)) || {};
  const cfg = (await getState(STATE_CFG, null)) || {};
  const tfs =
    Array.isArray(ui.tfs) && ui.tfs.length
      ? ui.tfs
      : Array.isArray(cfg.patternTfs) && cfg.patternTfs.length
        ? cfg.patternTfs
        : DEFAULT_TFS;
  const enabledFamilies =
    Array.isArray(ui.enabledFamilies) && ui.enabledFamilies.length
      ? ui.enabledFamilies
      : Array.isArray(cfg.enabledFamilies) && cfg.enabledFamilies.length
        ? cfg.enabledFamilies
        : [...FAMILY_KEYS];
  return {
    tfs,
    enabledFamilies,
    minScore: Number.isFinite(+ui.minScore)
      ? +ui.minScore
      : Number.isFinite(+cfg.minSignalScore)
        ? +cfg.minSignalScore
        : HS_SCAN_DEFAULTS.minScore,
    ratioRules: ui.ratioRules || undefined,
    preferEma200: !!ui.preferEma200,
    requireEma200: !!ui.requireEma200,
    preferBreaker: !!ui.preferBreaker,
    requireBreaker: !!ui.requireBreaker,
    enableBreakers: ui.enableBreakers !== false,
    includeProjected: ui.includeProjected !== false,
  };
}

async function loadUniverse() {
  const [eligible, tickers] = await Promise.all([
    exchange.loadExchangeInfo(),
    exchange.loadTickers(),
  ]);
  return selectUniverse({
    mode: 'all',
    ranking: 'volume',
    eligible,
    tickers,
    symbols: [],
  });
}

function setupToSignal(setup, price) {
  if (!setup?.symbol || !(+setup.entry > 0)) return null;
  const dir = String(setup.dir || setup.direction || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const pattern = setup.pattern || setup.metadata?.pattern || 'HARMONIC';
  const tf = setup.metadata?.patternTf || '1h';
  const family = setup.metadata?.harmonic?.family || pattern.split('_')[0];
  const cTime = setup.metadata?.harmonic?.C?.time || setup.ob?.time || 0;
  const signal_id = buildSignalId(setup.symbol, dir, cTime || `${tf}_${family}`, setup.entry);
  const status =
    setup.suggestedStatus === 'READY' || setup.suggestedStatus === 'ONGOING'
      ? setup.suggestedStatus
      : SIGNAL_STATUS.WATCHING;
  const now = new Date().toISOString();
  return {
    signal_id: String(signal_id).slice(0, 120),
    symbol: setup.symbol,
    direction: dir,
    status,
    score: Math.round(+setup.score || 0),
    entry: +setup.entry,
    sl: +setup.sl,
    tp1: +setup.tp1,
    tp2: +setup.tp2 || +setup.tp1,
    tp3: +setup.tp3 || +setup.tp2 || +setup.tp1,
    rr: setup.rr != null ? +setup.rr : null,
    current_price: +price || +setup.price || null,
    price: +price || +setup.price || null,
    metadata: {
      ...(setup.metadata || {}),
      strategy: 'harmonic',
      pattern,
      patternTf: tf,
      fromHarmonicAuto: true,
      firstSeenAt: now,
    },
    ready_at: status === 'READY' ? now : null,
    last_updated_at: now,
    last_checked_at: now,
  };
}

async function persistSetup(setup, price) {
  const row = setupToSignal(setup, price);
  if (!row) return { ok: false, reason: 'bad setup' };
  const existing = await getSignalById(row.signal_id);
  if (existing) {
    const st = String(existing.status || '').toUpperCase();
    if (['ONGOING', 'COMPLETED_PROFIT', 'STOPPED', 'INVALIDATED', 'COMPLETED'].includes(st)) {
      return { ok: false, reason: 'terminal', signal_id: row.signal_id };
    }
    await updateSignal(row.signal_id, {
      score: row.score,
      entry: row.entry,
      sl: row.sl,
      tp1: row.tp1,
      tp2: row.tp2,
      tp3: row.tp3,
      rr: row.rr,
      current_price: row.current_price,
      metadata: {
        ...(existing.metadata || {}),
        ...row.metadata,
        firstSeenAt: existing.metadata?.firstSeenAt || existing.created_at || row.metadata.firstSeenAt,
      },
      status: row.status === 'READY' && st === 'WATCHING' ? 'READY' : existing.status,
      ready_at: row.status === 'READY' ? row.ready_at || existing.ready_at : existing.ready_at,
      last_checked_at: row.last_checked_at,
    });
    return { ok: true, updated: true, signal_id: row.signal_id, status: row.status };
  }
  await createSignal(row);
  return { ok: true, created: true, signal_id: row.signal_id, status: row.status };
}

async function scanSymbols(symbols, scanCfg, budgetMs, started) {
  let created = 0;
  let updated = 0;
  let errors = 0;
  let processed = 0;
  let banned = false;
  for (const symbol of symbols) {
    if (Date.now() - started >= budgetMs - 1200) break;
    try {
      for (const tf of scanCfg.tfs) {
        if (Date.now() - started >= budgetMs - 800) break;
        try {
          const candles = await exchange.getKlines(symbol, tf, KLINE_LIMIT);
          if (!candles?.length) continue;
          const price = +candles[candles.length - 1].close;
          const setups = runHarmonicStrategy({
            symbol,
            candles,
            price,
            cfg: {
              patternTf: tf,
              patternTfs: scanCfg.tfs,
              enabledFamilies: scanCfg.enabledFamilies,
              minSignalScore: scanCfg.minScore,
              minScore: scanCfg.minScore,
              ratioRules: scanCfg.ratioRules,
              preferEma200: scanCfg.preferEma200,
              requireEma200: scanCfg.requireEma200,
              preferBreaker: scanCfg.preferBreaker,
              requireBreaker: scanCfg.requireBreaker,
              enableBreakers: scanCfg.enableBreakers,
              includeProjected: scanCfg.includeProjected,
            },
          });
          for (const setup of setups) {
            const res = await persistSetup(setup, price);
            if (res.created) created += 1;
            else if (res.updated) updated += 1;
          }
        } catch (tfErr) {
          if (tfErr?.banned || tfErr?.throttled) {
            banned = true;
            break;
          }
          errors += 1;
        }
        await sleep(200);
      }
    } catch (e) {
      if (e?.banned || e?.throttled) banned = true;
      errors += 1;
    }
    processed += 1;
    if (banned) break;
    await sleep(300);
  }
  return { created, updated, errors, processed, banned };
}

async function tryLock(ttlMs = 55_000) {
  const now = Date.now();
  const lock = (await getState(STATE_LOCK, null)) || null;
  if (lock?.until && new Date(lock.until).getTime() > now) {
    return false;
  }
  await setState(STATE_LOCK, { until: new Date(now + ttlMs).toISOString(), at: new Date().toISOString() });
  return true;
}

/**
 * One tick — decide full discovery vs update-active.
 */
export async function runHarmonicAutoTick({ budgetMs = 45_000 } = {}) {
  const started = Date.now();
  const cfg = await getHarmonicAutoConfig();
  if (!cfg.enabled) {
    return { ok: true, skipped: true, reason: 'harmonic auto scan is OFF' };
  }

  if (!(await tryLock(Math.min(budgetMs + 5_000, 55_000)))) {
    return { ok: true, skipped: true, reason: 'another tick still running' };
  }

  const scanCfg = await loadScanConfig();
  const now = nowColombo();
  let cursor = cfg.cursor && typeof cfg.cursor === 'object' ? { ...cfg.cursor } : { offset: 0, total: 0 };

  // —— Continue an in-progress full pass ——
  const fullInProgress = cursor.symbols && cursor.offset > 0 && cursor.offset < (cursor.total || 0);

  // —— Is a new full slot due? ——
  const dueSlot = latestDueSlotUtc(now, cfg.startHour, cfg.intervalHours);
  const lastCycleMs = cfg.lastCycleAt ? new Date(cfg.lastCycleAt).getTime() : 0;
  const slotNeedsRun =
    dueSlot != null &&
    (!lastCycleMs || lastCycleMs < dueSlot) &&
    !fullInProgress &&
    !(cursor.slotUtc === dueSlot && cursor.cycleCompletedAt);

  // Start new full cycle if slot due
  if (slotNeedsRun || (fullInProgress && cursor.symbols)) {
    if (slotNeedsRun) {
      const symbols = await loadUniverse();
      cursor = {
        offset: 0,
        total: symbols.length,
        symbols,
        cycleStartedAt: new Date().toISOString(),
        slotUtc: dueSlot,
        mode: 'full',
      };
      await setState(STATE_CURSOR, cursor);
    }

    const symbols = Array.isArray(cursor.symbols) ? cursor.symbols : await loadUniverse();
    const total = symbols.length;
    let offset = Math.max(0, Math.min(+cursor.offset || 0, total));
    const chunk = symbols.slice(offset, offset + CHUNK);
    const result = await scanSymbols(chunk, scanCfg, budgetMs, started);
    offset += chunk.length;
    const cycleDone = offset >= total || result.banned;

    const nextCursor = cycleDone
      ? {
          offset: 0,
          total,
          cycleCompletedAt: new Date().toISOString(),
          slotUtc: cursor.slotUtc || dueSlot,
          mode: 'idle',
        }
      : {
          offset,
          total,
          symbols,
          cycleStartedAt: cursor.cycleStartedAt,
          slotUtc: cursor.slotUtc || dueSlot,
          mode: 'full',
        };

    await setState(STATE_CURSOR, nextCursor);
    if (cycleDone && !result.banned) {
      await setState(STATE_LAST_CYCLE, new Date().toISOString());
    }

    const status = {
      phase: result.banned ? 'backoff' : cycleDone ? 'cycle_complete' : 'full_scanning',
      mode: 'full',
      done: offset,
      total,
      created: result.created,
      updated: result.updated,
      errors: result.errors,
      banned: result.banned,
      startHour: cfg.startHour,
      intervalHours: cfg.intervalHours,
      updateMinutes: cfg.updateMinutes,
      colomboNow: cfg.colomboNow,
      updatedAt: new Date().toISOString(),
    };
    await setState(STATE_STATUS, status);
    return { ok: true, ...status, elapsedMs: Date.now() - started };
  }

  // —— Update pass: only coins that already have active harmonic signals ——
  const lastUp = cfg.lastUpdateAt ? new Date(cfg.lastUpdateAt).getTime() : 0;
  const updateDue = !lastUp || Date.now() - lastUp >= cfg.updateMinutes * 60 * 1000;

  if (!updateDue) {
    const waitSec = Math.ceil((cfg.updateMinutes * 60 * 1000 - (Date.now() - lastUp)) / 1000);
    const status = {
      phase: 'waiting_update',
      mode: 'update',
      nextUpdateInSec: waitSec,
      startHour: cfg.startHour,
      intervalHours: cfg.intervalHours,
      updateMinutes: cfg.updateMinutes,
      colomboNow: cfg.colomboNow,
      updatedAt: new Date().toISOString(),
    };
    await setState(STATE_STATUS, status);
    return { ok: true, skipped: true, reason: `next update in ${waitSec}s`, ...status };
  }

  let active = [];
  try {
    active = await getActiveSignals();
  } catch (_) {
    active = [];
  }
  const harmonicSyms = [
    ...new Set(
      active
        .filter((s) => {
          const st = String(s.status || '').toUpperCase();
          if (st !== 'WATCHING' && st !== 'READY') return false;
          const strat = s.metadata?.strategy || s.strategy || '';
          return String(strat).toLowerCase() === 'harmonic' || s.metadata?.fromHarmonicAuto;
        })
        .map((s) => String(s.symbol || '').toUpperCase())
        .filter(Boolean)
    ),
  ];

  if (!harmonicSyms.length) {
    const status = {
      phase: 'idle_no_signals',
      mode: 'update',
      startHour: cfg.startHour,
      intervalHours: cfg.intervalHours,
      updateMinutes: cfg.updateMinutes,
      colomboNow: cfg.colomboNow,
      updatedAt: new Date().toISOString(),
    };
    await setState(STATE_STATUS, status);
    await setState(STATE_LAST_UPDATE, new Date().toISOString());
    return { ok: true, skipped: true, reason: 'no active harmonic signals to update', ...status };
  }

  // Pace updates too — only a slice per tick if many
  const upCursor = +(await getState('harmonic_auto_update_offset', 0)) || 0;
  const slice = harmonicSyms.slice(upCursor, upCursor + Math.max(CHUNK * 2, 4));
  const nextUp = upCursor + slice.length >= harmonicSyms.length ? 0 : upCursor + slice.length;
  await setState('harmonic_auto_update_offset', nextUp);

  const result = await scanSymbols(slice, scanCfg, budgetMs, started);
  await setState(STATE_LAST_UPDATE, new Date().toISOString());

  const status = {
    phase: result.banned ? 'backoff' : 'updating',
    mode: 'update',
    symbols: slice,
    activeCount: harmonicSyms.length,
    created: result.created,
    updated: result.updated,
    errors: result.errors,
    banned: result.banned,
    startHour: cfg.startHour,
    intervalHours: cfg.intervalHours,
    updateMinutes: cfg.updateMinutes,
    colomboNow: cfg.colomboNow,
    updatedAt: new Date().toISOString(),
  };
  await setState(STATE_STATUS, status);
  return { ok: true, ...status, elapsedMs: Date.now() - started };
}

/** Fire-and-forget safe entry for piggyback (ignores errors). */
export async function maybeRunHarmonicAutoBackground() {
  try {
    const cfg = await getHarmonicAutoConfig();
    if (!cfg.enabled) return;
    await runHarmonicAutoTick({ budgetMs: 40_000 });
  } catch (e) {
    console.error('[harmonicAuto] piggyback', e?.message || e);
  }
}
