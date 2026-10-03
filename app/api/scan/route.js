import { NextResponse } from 'next/server';
import { getLastScanRun } from '../../../lib/database/scanRuns.js';
import { getActiveSignals } from '../../../lib/database/signals.js';
import { SIGNAL_STATUS, SIGNAL_CONFIG } from '../../../lib/config/signalConfig.js';
import { isProductionDbReady } from '../../../lib/database/index.js';
import { runFullScan } from '../../../lib/scanner/scanner.js';
import { getState } from '../../../lib/database/appState.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' };
// Hobby plan max is 60s — do not raise above this on free tier
export const maxDuration = 60;

export async function GET() {
  try {
    const [lastScan, active] = await Promise.all([
      getLastScanRun(),
      getActiveSignals(),
    ]);

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
    let activeExchange = 'binance';
    let minScore = SIGNAL_CONFIG.minScore;
    let minEntryATR = SIGNAL_CONFIG.minEntryDistanceATR ?? 0.75;
    let maxEntryATR = SIGNAL_CONFIG.maxEntryDistanceATR ?? 4;
    let telegramMaxATR = SIGNAL_CONFIG.telegramMaxDistanceATR ?? 2;
    let maxGapPercent = SIGNAL_CONFIG.maxGapPercent ?? 3;
    let requireHtfAligned = SIGNAL_CONFIG.requireHtfAligned !== false;
    let requireLiquidityEdge = SIGNAL_CONFIG.requireLiquidityEdge !== false;
    let requireSweepOrFvg = !!SIGNAL_CONFIG.requireSweepOrFvg;
    const strategyMode = 'chart_pattern'; // Strategy 1 removed
    let chartPatternConfig = {};
    try {
      autoScan = !!(await getState('auto_scan_enabled', false));
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
    } catch (_) {}

    return NextResponse.json({
      dbReady: isProductionDbReady() || process.env.NODE_ENV !== 'production',
      lastScan,
      nextScan,
      counts,
      auto_scan_enabled: autoScan,
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
