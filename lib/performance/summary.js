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
  const filtered = all.filter((s) => inRange(s, from, to));

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

  // TP hits: count signals that ever hit each level (any status that has the flag)
  let tp1 = 0;
  let tp2 = 0;
  let tp3 = 0;
  for (const s of filtered) {
    if (s.tp1_hit) tp1++;
    if (s.tp2_hit) tp2++;
    if (s.tp3_hit) tp3++;
  }

  const winRate =
    completed.length > 0
      ? +((profitTrades.length / completed.length) * 100).toFixed(1)
      : null;

  // PnL from stored fields only
  const profitPcts = profitTrades
    .map((s) => +s.max_profit_percent || +s.current_pnl_percent)
    .filter((n) => Number.isFinite(n));
  const lossPcts = stoppedTrades
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
        tp1: 0,
        tp2: 0,
        tp3: 0,
      };
    }
    const row = byCoin[sym];
    row.signals++;
    const st = String(s.status || '').toUpperCase();
    if (st === SIGNAL_STATUS.COMPLETED_PROFIT) row.profit++;
    if (st === SIGNAL_STATUS.STOPPED) row.sl++;
    if (s.tp1_hit) row.tp1++;
    if (s.tp2_hit) row.tp2++;
    if (s.tp3_hit) row.tp3++;
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
        tp1: 0,
        tp2: 0,
        tp3: 0,
      };
    }
    const row = byPattern[p];
    row.signals++;
    const st = String(s.status || '').toUpperCase();
    if (st === SIGNAL_STATUS.COMPLETED_PROFIT) row.profit++;
    if (st === SIGNAL_STATUS.STOPPED) row.sl++;
    if (s.tp1_hit) row.tp1++;
    if (s.tp2_hit) row.tp2++;
    if (s.tp3_hit) row.tp3++;
  }
  const patternStats = Object.values(byPattern).sort((a, b) => b.signals - a.signals);

  // Direction
  const direction = {
    LONG: { signals: 0, profit: 0, sl: 0 },
    SHORT: { signals: 0, profit: 0, sl: 0 },
  };
  for (const s of filtered) {
    const d = String(s.direction || s.dir || '').toUpperCase();
    if (!direction[d]) continue;
    direction[d].signals++;
    const st = String(s.status || '').toUpperCase();
    if (st === SIGNAL_STATUS.COMPLETED_PROFIT) direction[d].profit++;
    if (st === SIGNAL_STATUS.STOPPED) direction[d].sl++;
  }

  // Timeframe
  const byTf = {};
  for (const s of filtered) {
    const tf = timeframeOf(s);
    if (!byTf[tf]) byTf[tf] = { timeframe: tf, signals: 0, profit: 0, sl: 0 };
    byTf[tf].signals++;
    const st = String(s.status || '').toUpperCase();
    if (st === SIGNAL_STATUS.COMPLETED_PROFIT) byTf[tf].profit++;
    if (st === SIGNAL_STATUS.STOPPED) byTf[tf].sl++;
  }
  const timeframeStats = Object.values(byTf).sort((a, b) => b.signals - a.signals);

  // Recent completed table
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
        result: st === SIGNAL_STATUS.COMPLETED_PROFIT ? 'PROFIT' : 'STOPPED',
        tpHits: hits.join('/') || '—',
        profitPct: pnl,
      };
    });

  return {
    ok: true,
    period,
    from: from ? new Date(from).toISOString() : null,
    to: to ? new Date(to).toISOString() : null,
    performanceTrackingStartedAt: sinceEnabled,
    totals: {
      signals: filtered.length,
      completedTrades: completed.length,
      profitTrades: profitTrades.length,
      stoppedTrades: stoppedTrades.length,
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
