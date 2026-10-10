import { NextResponse } from 'next/server';
import { getSession } from '../../../lib/auth/session.js';
import { getLastScanRun } from '../../../lib/database/scanRuns.js';
import { getActiveSignals } from '../../../lib/database/signals.js';
import { SIGNAL_STATUS, SIGNAL_CONFIG } from '../../../lib/config/signalConfig.js';
import { RECOMMENDED_SCANNER_SETTINGS } from '../../../lib/config/recommendedScannerSettings.js';
import { isProductionDbReady } from '../../../lib/database/index.js';
import { runFullScan } from '../../../lib/scanner/scanner.js';
import { getState, setState } from '../../../lib/database/appState.js';
import { signalExchange, isExchange, EXCHANGES } from '../../../lib/exchange/context.js';
import { getScanExchanges } from '../../../lib/exchange/index.js';
import {
  ZONE_PATTERN_DEFAULTS,
  normalizeZonePatternConfig,
} from '../../../lib/scanner/strategy/zonePattern/config.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' };
// Hobby plan max is 60s — do not raise above this on free tier
export const maxDuration = 60;

export async function GET(request) {
  try {
    const qEx = String(new URL(request.url).searchParams.get('exchange') || '').toLowerCase();
    const [lastScan, activeAll] = await Promise.all([
      getLastScanRun(),
      getActiveSignals(),
    ]);
    const active = isExchange(qEx) ? activeAll.filter((s) => signalExchange(s) === qEx) : activeAll;

    const counts = {
      watching: active.filter((s) => s.status === SIGNAL_STATUS.WATCHING)
        .length,
      ready: active.filter((s) => s.status === SIGNAL_STATUS.READY).length,
      ongoing: active.filter((s) => s.status === SIGNAL_STATUS.ONGOING)
        .length,
    };

    let nextScan = null;
    if (lastScan?.completed_at || lastScan?.started_at) {
      const base = new Date(lastScan.completed_at || lastScan.started_at);
      nextScan = new Date(
        base.getTime() + SIGNAL_CONFIG.scanIntervalMinutes * 60 * 1000
      ).toISOString();
    }

    let autoScan = false;
    let fullScanIntervalMinutes = 5;
    let lastFullScanAt = null;
    let nextFullScanAt = null;
    let lastFullScanSummary = null;
    let scanExchanges = ['binance'];
    let fullScanParts = 3;
    let fullScanBudgetSeconds = +process.env.FULL_SCAN_BUDGET_SECONDS > 0 ? +process.env.FULL_SCAN_BUDGET_SECONDS : 40;
    let activeExchange = 'binance';
    let minScore = SIGNAL_CONFIG.minScore;
    let minEntryATR = SIGNAL_CONFIG.minEntryDistanceATR ?? 0.75;
    let maxEntryATR = SIGNAL_CONFIG.maxEntryDistanceATR ?? 4;
    let telegramMaxATR = SIGNAL_CONFIG.telegramMaxDistanceATR ?? 2;
    let maxGapPercent = SIGNAL_CONFIG.maxGapPercent ?? 3;
    let requireHtfAligned = SIGNAL_CONFIG.requireHtfAligned !== false;
    let requireLiquidityEdge = SIGNAL_CONFIG.requireLiquidityEdge !== false;
    let requireSweepOrFvg = !!SIGNAL_CONFIG.requireSweepOrFvg;
    let strategyMode = 'zone_pattern';
    let chartPatternConfig = { ...RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig };
    let smcConfig = { ...RECOMMENDED_SCANNER_SETTINGS.smcConfig };
    let zonePatternConfig = normalizeZonePatternConfig(ZONE_PATTERN_DEFAULTS);
    try {
      autoScan = !!(await getState('auto_scan_enabled', false));
      // full-scan schedule (5-min discovery cron)
      fullScanIntervalMinutes = +(await getState('full_scan_interval_minutes', 5));
      if (!Number.isFinite(fullScanIntervalMinutes) || fullScanIntervalMinutes < 1) fullScanIntervalMinutes = 5;
      lastFullScanAt = await getState('last_full_scan_at', null);
      nextFullScanAt = await getState('next_full_scan_at', null);
      lastFullScanSummary = await getState('last_full_scan_summary', null);
      scanExchanges = await getScanExchanges();
      const sp = +(await getState('full_scan_parts', null));
      if (Number.isFinite(sp) && sp >= 1) fullScanParts = Math.min(10, Math.round(sp));
      const bs = +(await getState('full_scan_budget_seconds', null));
      if (Number.isFinite(bs) && bs > 0) fullScanBudgetSeconds = bs;
      const intervalMs = fullScanIntervalMinutes * 60000;
      if (!nextFullScanAt && lastFullScanAt) {
        nextFullScanAt = new Date(new Date(lastFullScanAt).getTime() + intervalMs).toISOString();
      }
      // If next is overdue, roll forward and persist so countdown never sticks at 00:00
      if (nextFullScanAt) {
        let nextMs = new Date(nextFullScanAt).getTime();
        const nowMs = Date.now();
        if (Number.isFinite(nextMs) && nextMs <= nowMs) {
          const steps = Math.floor((nowMs - nextMs) / intervalMs) + 1;
          nextMs = nextMs + steps * intervalMs;
          nextFullScanAt = new Date(nextMs).toISOString();
          try {
            await setState('next_full_scan_at', nextFullScanAt);
          } catch (_) {}
        }
      }
      const ex = await getState('active_exchange', null);
      if (ex === 'bybit' || ex === 'binance') activeExchange = ex;
      const stored = await getState('min_score', null);
      if (stored != null && Number.isFinite(+stored)) {
        const n = Math.round(+stored);
        if (n >= 50 && n <= 100) minScore = n;
      }
      const storedAtr = await getState('min_entry_atr', null);
      if (storedAtr != null && Number.isFinite(+storedAtr)) {
        const a = +storedAtr;
        if (a >= 0 && a <= 5) minEntryATR = a;
      }
      const storedMax = await getState('max_entry_atr', null);
      if (storedMax != null && Number.isFinite(+storedMax)) {
        const a = +storedMax;
        if (a > 0 && a <= 20) maxEntryATR = a;
      }
      const storedTg = await getState('telegram_max_atr', null);
      if (storedTg != null && Number.isFinite(+storedTg)) {
        const a = +storedTg;
        if (a > 0 && a <= 20) telegramMaxATR = a;
      }
      const storedGap = await getState('max_gap_percent', null);
      if (storedGap != null && Number.isFinite(+storedGap)) {
        const g = +storedGap;
        if (g > 0 && g <= 50) maxGapPercent = g;
      }
      const sHtf = await getState('require_htf_aligned', null);
      if (sHtf === true || sHtf === false) requireHtfAligned = sHtf;
      const sLiq = await getState('require_liquidity_edge', null);
      if (sLiq === true || sLiq === false) requireLiquidityEdge = sLiq;
      const sSw = await getState('require_sweep_or_fvg', null);
      if (sSw === true || sSw === false) requireSweepOrFvg = sSw;
      const cpc = await getState('chart_pattern_config', null);
      if (cpc && typeof cpc === 'object') chartPatternConfig = cpc;
      const savedMode = await getState('strategy_mode', null);
       if (['chart_pattern', 'smc', 'hybrid', 'ict_confluence', 'zone_pattern'].includes(savedMode)) strategyMode = savedMode;
      const savedSmc = await getState('smc_config', null);
      if (savedSmc && typeof savedSmc === 'object') smcConfig = savedSmc;
       const savedZonePattern = await getState('zone_pattern_config', null);
       if (savedZonePattern && typeof savedZonePattern === 'object') {
         zonePatternConfig = normalizeZonePatternConfig(savedZonePattern);
       }
    } catch (_) {}

    return NextResponse.json({
      dbReady: isProductionDbReady() || process.env.NODE_ENV !== 'production',
      lastScan,
      nextScan,
      counts,
      auto_scan_enabled: autoScan,
      full_scan_interval_minutes: fullScanIntervalMinutes,
      last_full_scan_at: lastFullScanAt,
      next_full_scan_at: nextFullScanAt,
      last_full_scan_summary: lastFullScanSummary,
      full_scan_budget_seconds: fullScanBudgetSeconds,
      full_scan_parts: fullScanParts,
      scan_exchanges: scanExchanges,
      // true while a full sweep is executing right now (UI shows "Scanning…")
      full_scan_running:
        lastScan?.status === 'RUNNING' && !!lastScan?.metadata?.full &&
        Date.now() - new Date(lastScan.started_at).getTime() < (+lastScan.metadata?.ttlMs || 70000),

      exchange: activeExchange,
      config: {
        exchange: activeExchange,
        minScore,
        minEntryATR,
        maxEntryATR,
        telegramMaxATR,
        maxGapPercent,
        requireHtfAligned,
        requireLiquidityEdge,
        requireSweepOrFvg,
        strategyMode,
        chartPatternConfig,
        smcConfig,
        zonePatternConfig,
        htf: SIGNAL_CONFIG.htf,
        obTf: SIGNAL_CONFIG.obTf,
        entryStyle: SIGNAL_CONFIG.entryStyle,
        scanIntervalMinutes: SIGNAL_CONFIG.scanIntervalMinutes,
        scanUniverse: SIGNAL_CONFIG.scanUniverse,
        scanChunkSize: SIGNAL_CONFIG.scanChunkSize,
      },
    }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * Manual Scan Now
 * Body (optional JSON):
 *   { universe: 200, chunkSize: 30, resetCursor: true }
 * universe = top N by volume (or "all")
 * chunkSize = symbols per request (keep ≤35 on Hobby)
 */
export async function POST(request) {
  if (process.env.NODE_ENV === 'production' && !isProductionDbReady()) {
    return NextResponse.json(
      {
        error:
          'Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
      },
      { status: 503 }
    );
  }

  let options = {};
  try {
    const body = await request.json();
    if (body && typeof body === 'object') {
      options = {
        universe: body.universe,
        chunkSize: body.chunkSize,
        exchange: isExchange(String(body.exchange || '').toLowerCase()) ? String(body.exchange).toLowerCase() : undefined,
        resetCursor: !!body.resetCursor,
        lifecycle: body.lifecycle === 'skip' || body.lifecycle === 'only' ? body.lifecycle : undefined,
      };
    }
  } catch (_) {
    // empty body is fine
  }

  try {
    const result = await runFullScan('manual', options);
    // Strip heavy nested objects from liveSignals for client safety
    // (auto-trade is NOT run on manual scan — use Enter now / cron / Test button)
    const slim = (arr) =>
      (arr || []).map((s) => ({
        signal_id: s.signal_id,
        symbol: s.symbol,
        direction: s.direction || s.dir,
        status: s.status,
        score: s.score,
        entry: s.entry,
        sl: s.sl,
        tp1: s.tp1,
        tp2: s.tp2,
        tp3: s.tp3,
        rr: s.rr,
        current_price: s.current_price ?? s.price,
        price: s.price ?? s.current_price,
        distance_percent: s.distance_percent,
        atr_distance: s.atr_distance,
        proximity_score: s.proximity_score,
        ready_threshold_atr: s.ready_threshold_atr,
        is_close: s.is_close,
        close_label: s.close_label,
        last_updated_at: s.last_updated_at,
        persisted: s.persisted,
        persist_operation: s.persist_operation,
        persist_error: s.persist_error,
        conf: Array.isArray(s.conf)
          ? s.conf.map((c) => (typeof c === 'string' ? c : String(c?.label || c || '')))
          : [],
        metadata: {
          conf: Array.isArray(s.metadata?.conf)
            ? s.metadata.conf.map((c) =>
                typeof c === 'string' ? c : String(c?.label || c || '')
              )
            : Array.isArray(s.conf)
              ? s.conf.map((c) => (typeof c === 'string' ? c : String(c || '')))
              : [],
        },
      }));
    const payload = {
      ...result,
      created: slim(result.created),
      liveSignals: slim(result.liveSignals || result.created),
      nearBreakouts: (result.nearBreakouts || []).map((n) => ({
        signal_id: n.signal_id,
        symbol: n.symbol,
        direction: n.direction,
        pattern: n.pattern,
        patternTf: n.patternTf,
        htf: n.htf,
        state: n.state,
        score: n.score,
        price: n.price,
        trigger: n.trigger,
        entry: n.entry,
        sl: n.sl,
        tp1: n.tp1,
        tp2: n.tp2,
        tp3: n.tp3,
        rr: n.rr,
        rrMeasured: n.rrMeasured,
        gapAtr: n.gapAtr,
        gapPct: n.gapPct,
        approaching: n.approaching,
        volBuild: n.volBuild,
        htfAligned: n.htfAligned,
        touches: n.touches,
        conf: (n.conf || []).map((c) => String(c)),
        blockers: n.blockers || [],
      })),
    };
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (e) {
    console.error('[scan/manual]', e);
    return NextResponse.json(
      { ok: false, error: e.message, code: e?.code },
      { status: e?.code === 'DB_NOT_CONFIGURED' ? 503 : 500, headers: NO_STORE }
    );
  }
}


/** Update full-scan schedule (admin) */
export async function PATCH(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const out = { ok: true };
    // New admin-only settings (which exchanges the cron scans, time budget) require an admin session.
    if (Array.isArray(body.scan_exchanges) || body.full_scan_budget_seconds != null || body.full_scan_parts != null) {
      const session = await getSession();
      if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    let interval = +(await getState('full_scan_interval_minutes', 5)) || 5;
    if (body.full_scan_interval_minutes != null) {
      const n = Math.round(+body.full_scan_interval_minutes);
      interval = Number.isFinite(n) ? Math.min(60, Math.max(1, n)) : 5;
      await setState('full_scan_interval_minutes', interval);
      out.full_scan_interval_minutes = interval;
      out.msg = `Full scan every ${interval} min`;
    }
    if (Array.isArray(body.scan_exchanges)) {
      const list = EXCHANGES.filter((e) => body.scan_exchanges.includes(e));
      if (!list.length) throw new Error('Select at least one exchange to scan');
      await setState('scan_exchanges', list);
      out.scan_exchanges = list;
      out.msg = (out.msg ? out.msg + ' · ' : '') + `Scanning: ${list.join(' + ')}`;
    }
    if (body.full_scan_budget_seconds != null) {
      const n = Math.round(+body.full_scan_budget_seconds);
      const sec = Number.isFinite(n) ? Math.min(280, Math.max(15, n)) : 40;
      await setState('full_scan_budget_seconds', sec);
      out.full_scan_budget_seconds = sec;
      out.msg = (out.msg ? out.msg + ' · ' : '') + `Full scan time budget ${sec}s`;
    }
    if (body.full_scan_parts != null) {
      const n = Math.round(+body.full_scan_parts);
      const parts = Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 3;
      await setState('full_scan_parts', parts);
      await setState('scan_cursor_full:binance', { offset: 0, universe: null });
      await setState('scan_cursor_full:bybit', { offset: 0, universe: null });
      out.full_scan_parts = parts;
      out.msg = (out.msg ? out.msg + ' · ' : '') + (parts > 1 ? `Full scan split into ${parts} parts (one part per tick)` : 'Full scan: whole universe each tick');
    }
    if (body.mark_full_scan_done) {
      const nowIso = new Date().toISOString();
      await setState('last_full_scan_at', nowIso);
      await setState('next_full_scan_at', new Date(Date.now() + interval * 60000).toISOString());
      await setState('pending_full_scan', null);
      out.last_full_scan_at = nowIso;
      out.next_full_scan_at = new Date(Date.now() + interval * 60000).toISOString();
      out.msg = (out.msg ? out.msg + ' · ' : '') + 'First full scan marked complete';
    } else if (body.full_scan_interval_minutes != null) {
      const last = await getState('last_full_scan_at', null);
      const next = last
        ? new Date(new Date(last).getTime() + interval * 60000).toISOString()
        : new Date(Date.now() + interval * 60000).toISOString();
      await setState('next_full_scan_at', next);
      out.next_full_scan_at = next;
      out.last_full_scan_at = last;
    }
    return NextResponse.json(out, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
