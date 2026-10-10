import { NextResponse } from 'next/server';
import {
  getActiveSignals,
  getHistorySignals,
  getRecentSignals,
  getInvalidationCatalog,
  getInvalidationEvents,
} from '../../../lib/database/signals.js';
import { getLastScanRun } from '../../../lib/database/scanRuns.js';
import { SIGNAL_STATUS } from '../../../lib/config/signalConfig.js';
import { signalExchange, isExchange } from '../../../lib/exchange/context.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};
const json = (body, init = {}) =>
  NextResponse.json(body, { ...init, headers: { ...NO_STORE, ...(init.headers || {}) } });

export async function GET(request) {
  try {
    // ?exchange=bybit|binance → only that exchange's signals (default: bybit = legacy feed)
    const q = String(new URL(request.url).searchParams.get('exchange') || 'bybit').toLowerCase();
    const exchange = isExchange(q) ? q : 'bybit';
    const only = (arr) => (arr || []).filter((s) => signalExchange(s) === exchange);
    const [activeAll, historyAll, lastScan, recentAll, invalidatedAll] = await Promise.all([
      getActiveSignals(),
      getHistorySignals(250),
      getLastScanRun(),
      getRecentSignals(100),
      getInvalidationCatalog(),
    ]);
    const active = only(activeAll);
    const history = only(historyAll).slice(0, 100);
    const recent = only(recentAll).slice(0, 40);
    const invalidated = only(invalidatedAll);
    const invalidationEvents = await getInvalidationEvents((invalidated || []).map((s) => s.signal_id));
    const eventBySignal = new Map();
    for (const event of invalidationEvents) {
      if (!eventBySignal.has(event.signal_id)) eventBySignal.set(event.signal_id, event);
    }
    const invalidationCatalog = (invalidated || []).map((signal) => {
      const event = eventBySignal.get(signal.signal_id);
      const stored = signal.metadata?.invalidation || event?.metadata?.invalidation;
      const invalidation = stored || {
        category: signal.metadata?.invalidateReason === 'stale' ? 'Expired' : 'Entry Quality',
        reason:
          signal.metadata?.entryQualityFail ||
          event?.message ||
          'Reason not recorded (signal predates detailed invalidation tracking)',
        reasons: [],
        previousStatus: event?.old_status || 'Unknown (not recorded)',
        actual: null,
        required: null,
        price: event?.price ?? signal.current_price ?? null,
        time: event?.created_at || signal.invalidated_at || signal.last_updated_at || null,
      };
      return {
        ...signal,
        metadata: { ...(signal.metadata || {}), invalidation },
      };
    });

    const norm = (s) => String(s?.status || '').trim().toUpperCase();
    // Database is the only source: no fallback / substitute data.
    const pool = active || [];
    const ongoing = pool
      .filter((s) => norm(s) === SIGNAL_STATUS.ONGOING)
      .sort(
        (a, b) =>
          new Date(b.last_updated_at || b.created_at || 0) -
          new Date(a.last_updated_at || a.created_at || 0)
      );
    const ready = pool
      .filter((s) => norm(s) === SIGNAL_STATUS.READY)
      .sort(
        (a, b) =>
          (a.distance_percent ?? 999) - (b.distance_percent ?? 999)
      );
    const watching = pool
      .filter((s) => norm(s) === SIGNAL_STATUS.WATCHING)
      .sort((a, b) => {
        const aNear = a.metadata?.nearBreakout ? 0 : 1;
        const bNear = b.metadata?.nearBreakout ? 0 : 1;
        if (aNear !== bNear) return aNear - bNear;
        const ga = a.atr_distance ?? a.metadata?.gapAtr ?? 999;
        const gb = b.atr_distance ?? b.metadata?.gapAtr ?? 999;
        if (aNear === 0 && Math.abs(ga - gb) > 0.02) return ga - gb;
        const dp = (a.distance_percent ?? 999) - (b.distance_percent ?? 999);
        if (Math.abs(dp) > 0.01) return dp;
        return (b.score || 0) - (a.score || 0);
      });

    const nearFromDb = watching
      .filter((s) => s?.metadata?.nearBreakout || s?.metadata?.kind === 'NEAR_BREAKOUT')
      .map((s) => ({
        signal_id: s.signal_id,
        symbol: s.symbol,
        pattern: s.metadata?.pattern || s.metadata?.patternType,
        patternTf: s.metadata?.patternTf,
        direction: s.direction,
        dir: s.direction,
        state: s.metadata?.nearState || 'NEAR',
        score: s.score,
        price: s.current_price ?? s.last_price,
        entry: s.entry,
        sl: s.sl,
        tp1: s.tp1,
        tp2: s.tp2,
        tp3: s.tp3,
        rr: s.rr,
        gapAtr: s.atr_distance ?? s.metadata?.gapAtr,
        gapPct: s.distance_percent ?? s.metadata?.gapPct,
        conf: s.metadata?.conf,
        htfAligned: s.metadata?.htfAligned,
        trigger: s.metadata?.trigger || s.metadata?.breakoutLevel,
        fromDb: true,
      }));

    console.log(
      '[api/signals] db rows',
      JSON.stringify({ ongoing: ongoing.length, ready: ready.length, watching: watching.length, history: (history || []).length })
    );
    return json({
      ok: true,
      exchange,
      ongoing,
      ready,
      watching,
      nearBreakouts: nearFromDb,
      history,
      invalidationCatalog,
      recent,
      lastScan,
      counts: {
        ongoing: ongoing.length,
        ready: ready.length,
        watching: watching.length,
        near: nearFromDb.length,
        history: history.length,
        invalidated: invalidationCatalog.length,
        recent: (recent || []).length,
        activeTotal: active.length,
      },
    });
  } catch (e) {
    console.error('[api/signals] Supabase/DB error:', e?.message || e);
    const notConfigured = e?.code === 'DB_NOT_CONFIGURED';
    // Clear error — NOT a silent empty result. Client keeps its last good data.
    return json(
      {
        ok: false,
        error: e?.message || 'Failed to load signals',
        code: notConfigured ? 'DB_NOT_CONFIGURED' : 'DB_QUERY_FAILED',
      },
      { status: notConfigured ? 503 : 500 }
    );
  }
}
