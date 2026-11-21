/**
 * Performance / trade summary from real signal records.
 * Does NOT invent PnL. Counts only existing statuses and tp*_hit flags.
 */
import { getDb } from '../database/index.js';
import { SIGNAL_STATUS } from '../config/signalConfig.js';
import { getState, setState } from '../database/appState.js';

const DONE = [
  SIGNAL_STATUS.COMPLETED_PROFIT,
  SIGNAL_STATUS.STOPPED,
  SIGNAL_STATUS.INVALIDATED,
];

function parsePeriod(period, customFrom, customTo, sinceEnabled) {
  const now = Date.now();
  let from = null;
  let to = now;
  if (period === '24h') from = now - 24 * 3600 * 1000;
  else if (period === '7d') from = now - 7 * 24 * 3600 * 1000;
  else if (period === '30d') from = now - 30 * 24 * 3600 * 1000;
  else if (period === 'since') from = sinceEnabled ? new Date(sinceEnabled).getTime() : null;
  else if (period === 'custom') {
    from = customFrom ? new Date(customFrom).getTime() : null;
    to = customTo ? new Date(customTo).getTime() : now;
  } else if (period === 'all') from = null;
  else from = sinceEnabled ? new Date(sinceEnabled).getTime() : now - 24 * 3600 * 1000;
  return { from, to };
}

function signalTime(s) {
  return (
    s.completed_at ||
    s.stopped_at ||
    s.invalidated_at ||
    s.entry_hit_at ||
    s.ready_at ||
    s.created_at ||
    s.last_updated_at
  );
}

function inRange(s, from, to) {
  const t = new Date(signalTime(s) || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return false;
  if (from != null && t < from) return false;
  if (to != null && t > to) return false;
  return true;
}

/** Highest TP level a signal reached before it closed (0 = none). */
function tpLevelHit(s) {
  if (s.tp3_hit || String(s.status || '').toUpperCase() === SIGNAL_STATUS.COMPLETED_PROFIT) return 3;
  if (s.tp2_hit) return 2;
  if (s.tp1_hit) return 1;
  return 0;
}

/** STOPPED signal that never touched any TP = a pure SL. */
function isPureSl(s) {
  return String(s.status || '').toUpperCase() === SIGNAL_STATUS.STOPPED && tpLevelHit(s) === 0;
}

/** STOPPED signal that hit TP1/TP2 first. Counted as a TP (by highest level), never as an SL. */
function isTpThenSl(s) {
  return String(s.status || '').toUpperCase() === SIGNAL_STATUS.STOPPED && tpLevelHit(s) > 0;
}

function patternName(s) {
  return (
    s.pattern ||
    s.metadata?.pattern ||
    s.metadata?.patternType ||
    s.strategy ||
    s.metadata?.strategy ||
    'Unknown'
  );
}

function timeframeOf(s) {
  return (
    s.metadata?.patternTf ||
    s.metadata?.obTf ||
    s.metadata?.htf ||
    s.ob_tf ||
    '—'
  );
}

async function loadSignals() {
  const db = getDb();
  if (db.type === 'supabase') {
    const rows = [];
    const page = 500;
    for (let offset = 0; ; offset += page) {
      const { data, error } = await db.client
        .from('signals')
        .select('*')
        .order('created_at', { ascending: false })
        .range(offset, offset + page - 1);
      if (error) throw error;
      const chunk = data || [];
      rows.push(...chunk);
      if (chunk.length < page) break;
      if (rows.length >= 5000) break;
    }
    return rows;
  }
  return [...(db.store.signals?.values?.() || [])];
}

export async function getPerformanceSummary(options = {}) {
  const period = options.period || '24h';
  const sinceEnabled = await getState('performance_tracking_started_at', null);
  const { from, to } = parsePeriod(period, options.from, options.to, sinceEnabled);

  const all = await loadSignals();
  const dirOpt = String(options.direction || 'ALL').toUpperCase();
  const dirFilter = dirOpt === 'LONG' || dirOpt === 'SHORT' ? dirOpt : 'ALL';
  const filtered = all.filter(
    (s) =>
      inRange(s, from, to) &&
      (dirFilter === 'ALL' ||
        String(s.direction || s.dir || s.side || '').toUpperCase() === dirFilter)
  );

  const statusCounts = {
    WATCHING: 0,
    READY: 0,
    ONGOING: 0,
    COMPLETED_PROFIT: 0,
    STOPPED: 0,
    INVALIDATED: 0,
  };
  for (const s of filtered) {
    const st = String(s.status || '').toUpperCase();
    if (statusCounts[st] != null) statusCounts[st]++;
  }

  const completed = filtered.filter((s) =>
    [SIGNAL_STATUS.COMPLETED_PROFIT, SIGNAL_STATUS.STOPPED].includes(
      String(s.status || '').toUpperCase()
    )
  );
  const profitTrades = completed.filter(
    (s) => String(s.status).toUpperCase() === SIGNAL_STATUS.COMPLETED_PROFIT
  );
  const stoppedTrades = completed.filter(
    (s) => String(s.status).toUpperCase() === SIGNAL_STATUS.STOPPED
  );
  // Split STOPPED: pure SL (no TP touched) vs TP→SL (TP1/TP2 hit, then stopped)
  const pureSlTrades = stoppedTrades.filter(isPureSl);
  const tpThenSlTrades = stoppedTrades.filter(isTpThenSl);
  const tp1ThenSl = tpThenSlTrades.filter((s) => tpLevelHit(s) === 1).length;
  const tp2ThenSl = tpThenSlTrades.filter((s) => tpLevelHit(s) >= 2).length;

  // TP hits: exclusive highest level reached.
  // A trade that touched TP1/TP2 and was stopped afterwards COUNTS AS THAT TP (not as SL).
  let tp1 = 0;
  let tp2 = 0;
  let tp3 = 0;
  for (const s of filtered) {
    const lvl = tpLevelHit(s);
    if (lvl === 1) tp1++;
    else if (lvl === 2) tp2++;
    else if (lvl === 3) tp3++;
  }

  // Win rate: every trade that reached a TP (TP3 profit OR TP1/TP2 then SL) is a win;
  // only a stop-out that never touched any TP is a loss.
  const winTrades = profitTrades.length + tpThenSlTrades.length;
  const ranked = winTrades + pureSlTrades.length;
  const winRate =
    ranked > 0
      ? +((winTrades / ranked) * 100).toFixed(1)
      : null;

  // PnL from stored fields only
  const profitPcts = profitTrades
    .map((s) => +s.max_profit_percent || +s.current_pnl_percent)
    .filter((n) => Number.isFinite(n));
  const lossPcts = pureSlTrades
    .map((s) => +s.max_loss_percent || +s.current_pnl_percent)
    .filter((n) => Number.isFinite(n));

  const avg = (arr) =>
    arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;

  // By coin
  const byCoin = {};
  for (const s of filtered) {
    const sym = s.symbol || 'UNKNOWN';
    if (!byCoin[sym]) {
      byCoin[sym] = {
        symbol: sym,
        signals: 0,
        profit: 0,
        sl: 0,
        tpSl: 0,
        tp1: 0,
        tp2: 0,
        tp3: 0,
      };
    }
    const row = byCoin[sym];
    row.signals++;
    const st = String(s.status || '').toUpperCase();
    if (st === SIGNAL_STATUS.COMPLETED_PROFIT) row.profit++;
    if (isPureSl(s)) row.sl++;
    if (isTpThenSl(s)) row.tpSl++;
    {
      const lvl = tpLevelHit(s);
      if (lvl === 1) row.tp1++;
      else if (lvl === 2) row.tp2++;
      else if (lvl === 3) row.tp3++;
    }
  }
  const coinStats = Object.values(byCoin).sort((a, b) => b.signals - a.signals);

  // By pattern
  const byPattern = {};
  for (const s of filtered) {
    const p = patternName(s);
    if (!byPattern[p]) {
      byPattern[p] = {
        pattern: p,
        signals: 0,
        profit: 0,
        sl: 0,
        tpSl: 0,
        tp1: 0,
        tp2: 0,
        tp3: 0,
      };
    }
    const row = byPattern[p];
    row.signals++;
    const st = String(s.status || '').toUpperCase();
    if (st === SIGNAL_STATUS.COMPLETED_PROFIT) row.profit++;
    if (isPureSl(s)) row.sl++;
    if (isTpThenSl(s)) row.tpSl++;
    {
      const lvl = tpLevelHit(s);
      if (lvl === 1) row.tp1++;
      else if (lvl === 2) row.tp2++;
      else if (lvl === 3) row.tp3++;
    }
  }
  const patternStats = Object.values(byPattern).sort((a, b) => b.signals - a.signals);

  // Direction
  const direction = {
    LONG: { signals: 0, profit: 0, sl: 0, tpSl: 0 },
    SHORT: { signals: 0, profit: 0, sl: 0, tpSl: 0 },
  };
  for (const s of filtered) {
    const d = String(s.direction || s.dir || '').toUpperCase();
    if (!direction[d]) continue;
    direction[d].signals++;
    const st = String(s.status || '').toUpperCase();
    if (st === SIGNAL_STATUS.COMPLETED_PROFIT) direction[d].profit++;
    if (isPureSl(s)) direction[d].sl++;
    if (isTpThenSl(s)) direction[d].tpSl++;
  }

  // Timeframe
  const byTf = {};
  for (const s of filtered) {
    const tf = timeframeOf(s);
    if (!byTf[tf]) byTf[tf] = { timeframe: tf, signals: 0, profit: 0, sl: 0, tpSl: 0 };
    byTf[tf].signals++;
    const st = String(s.status || '').toUpperCase();
    if (st === SIGNAL_STATUS.COMPLETED_PROFIT) byTf[tf].profit++;
    if (isPureSl(s)) byTf[tf].sl++;
    if (isTpThenSl(s)) byTf[tf].tpSl++;
  }
  const timeframeStats = Object.values(byTf).sort((a, b) => b.signals - a.signals);

  // Recent completed table (TP→SL trades are listed as TP results, not SL)
  const recentCompleted = completed
    .slice()
    .sort(
      (a, b) =>
        new Date(signalTime(b) || 0).getTime() - new Date(signalTime(a) || 0).getTime()
    )
    .slice(0, 50)
    .map((s) => {
      const st = String(s.status || '').toUpperCase();
      const hits = [];
      if (s.tp1_hit) hits.push('TP1');
      if (s.tp2_hit) hits.push('TP2');
      if (s.tp3_hit) hits.push('TP3');
      if (st === SIGNAL_STATUS.STOPPED) hits.push('SL');
      const lvl = tpLevelHit(s);
      let pnl = null;
      if (st === SIGNAL_STATUS.COMPLETED_PROFIT) {
        pnl = Number.isFinite(+s.max_profit_percent)
          ? +s.max_profit_percent
          : Number.isFinite(+s.current_pnl_percent)
            ? +s.current_pnl_percent
            : null;
      } else if (st === SIGNAL_STATUS.STOPPED) {
        pnl = Number.isFinite(+s.max_loss_percent)
          ? +s.max_loss_percent
          : Number.isFinite(+s.current_pnl_percent)
            ? +s.current_pnl_percent
            : null;
      }
      return {
        time: signalTime(s),
        symbol: s.symbol,
        direction: s.direction || s.dir,
        pattern: patternName(s),
        timeframe: timeframeOf(s),
        entry: s.entry,
        sl: s.sl,
        tp1: s.tp1,
        tp2: s.tp2,
        tp3: s.tp3,
        result:
          st === SIGNAL_STATUS.COMPLETED_PROFIT
            ? 'PROFIT'
            : lvl >= 3
              ? 'TP3'
              : lvl === 2
                ? 'TP2'
                : lvl === 1
                  ? 'TP1'
                  : 'SL',
        tpHits: hits.join('/') || '—',
        profitPct: pnl,
      };
    });

  return {
    ok: true,
    period,
    direction: dirFilter,
    from: from ? new Date(from).toISOString() : null,
    to: to ? new Date(to).toISOString() : null,
    performanceTrackingStartedAt: sinceEnabled,
    totals: {
      signals: filtered.length,
      completedTrades: completed.length,
      profitTrades: profitTrades.length,
      stoppedTrades: stoppedTrades.length, // all STOPPED (pure SL + TP→SL)
      slHit: pureSlTrades.length, // pure SL, no TP touched
      tpThenSl: tpThenSlTrades.length, // TP1/TP2 hit then SL — already counted inside the TP tiles
      winTrades, // TP3 profit + TP→SL
      tp1ThenSl,
      tp2ThenSl,
      winRate,
      tp1,
      tp2,
      tp3,
    },
    statusCounts,
    profit: {
      totalProfitPct: profitPcts.length
        ? +profitPcts.reduce((a, b) => a + b, 0).toFixed(2)
        : null,
      avgProfitPct: avg(profitPcts),
      avgLossPct: avg(lossPcts),
      maxProfitPct: profitPcts.length ? +Math.max(...profitPcts).toFixed(2) : null,
      maxLossPct: lossPcts.length ? +Math.min(...lossPcts).toFixed(2) : null,
      recordedProfitSamples: profitPcts.length,
      recordedLossSamples: lossPcts.length,
    },
    coinStats,
    patternStats,
    direction,
    timeframeStats,
    recentCompleted,
  };
}

export async function startPerformancePeriod() {
  const iso = new Date().toISOString();
  await setState('performance_tracking_started_at', iso);
  return { ok: true, performanceTrackingStartedAt: iso };
}

export async function resetPerformancePeriod() {
  return startPerformancePeriod();
}
