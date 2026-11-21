import { NextResponse } from 'next/server';
import { getSession } from '../../../lib/auth/session.js';
import { getState } from '../../../lib/database/appState.js';
import { getScannerSettings } from '../../../lib/fibSignals/scannerSettings.js';
import { FIB_SIGNALS_STATUS_KEY } from '../../../lib/fibSignals/config.js';
import { getFibSignalsConfig } from '../../../lib/fibSignals/runner.js';
import { loadStore, loadInvalid, publicSignal } from '../../../lib/fibSignals/store.js';
import { outcomeLabel } from '../../../lib/fibSignals/evaluate.js';
import { toPublicSignal, isPublicVisible } from '../../../lib/fibSignals/publicView.js';
import { loadTickers } from '../../../lib/binance/client.js';
import { entryProximity } from '../../../lib/fibSignals/proximity.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' };

function withLivePrice(signals, tickers) {
  return signals.map((raw) => {
    const { _atr, ...s } = raw;
    const sym = String(s.symbol || '').toUpperCase();
    const t = tickers?.[sym];
    const lastPrice = t?.markPrice || t?.price || null;
    const waiting = s.status === 'ACTIVE' && !s.entryHit;
    const { pct, distAtr, distPct } = entryProximity({ price: lastPrice, entry: s.entry, atr: _atr ?? s.atr, sl: s.sl });
    return {
      ...s,
      lastPrice: lastPrice != null ? +lastPrice : null,
      // waiting → how close to the entry (ATR-normalised); running → 100 (entry already reached)
      proximityPct: s.entryHit ? 100 : pct,
      entryDistanceAtr: waiting ? distAtr : null,
      entryDistancePct: waiting ? distPct : null,
    };
  });
}

/**
 * Feed order: 1) waiting signals, the one whose price is CLOSEST to its entry first,
 * 2) signals already running (entry reached), newest first, 3) finished results, newest first.
 */
function byClosestToEntry(a, b) {
  const rank = (s) => (s.status !== 'ACTIVE' ? 2 : s.entryHit ? 1 : 0);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) {
    const da = Number.isFinite(a.entryDistanceAtr) ? a.entryDistanceAtr : Infinity;
    const db = Number.isFinite(b.entryDistanceAtr) ? b.entryDistanceAtr : Infinity;
    if (da !== db) return da - db;
  }
  return Date.parse(b.closedAt || b.createdAt) - Date.parse(a.closedAt || a.createdAt);
}

export async function GET() {
  try {
    const session = await getSession().catch(() => null);
    const isAdmin = session?.role === 'admin';
    const [store, status, tickers, settings, invalidStore] = await Promise.all([
      loadStore(),
      getState(FIB_SIGNALS_STATUS_KEY, null).catch(() => null),
      loadTickers().catch(() => ({})),
      getScannerSettings(),
      isAdmin ? loadInvalid() : Promise.resolve({ items: [] }),
    ]);
    const byNewest = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

    if (!isAdmin) {
      const signals = withLivePrice(
        store.signals.filter(isPublicVisible).map((x) => ({ ...toPublicSignal(x), _atr: x.atr })).sort(byNewest),
        tickers
      ).sort(byClosestToEntry);
      const visibleSignals = settings.cardPreferences.showRecentResults
        ? signals
        : signals.filter((signal) => signal.status === 'ACTIVE');
      return NextResponse.json(
        { ok: true, admin: false, lastRunAt: status?.at || null, settings, signals: visibleSignals },
        { headers: NO_STORE }
      );
    }

    const cfg = await getFibSignalsConfig();
    const signals = withLivePrice(
      store.signals
        .map(publicSignal)
        .map((s) => ({ ...s, id: s.signal_id, trackingPaused: !!s.trackingIssue, outcome: outcomeLabel(s) }))
        .sort(byNewest),
      tickers
    ).sort(byClosestToEntry);
    return NextResponse.json(
      {
        ok: true,
        admin: true,
        enabled: cfg.enabled,
        config: {
          refTimeframes: cfg.refTimeframes,
          timeframes: cfg.timeframes,
          fibLevels: cfg.fibLevels,
          firstTouchOnly: cfg.firstTouchOnly,
        },
        lastRunAt: status?.at || null,
        scanned: status?.scanned ?? null,
        total: status?.total ?? null,
        settings,
        signals,
        invalid: invalidStore.items
          .slice()
          .sort((a, b) => Date.parse(b.invalidAt || b.createdAt) - Date.parse(a.invalidAt || a.createdAt))
          .slice(0, 100)
          .map((x) => ({ ...x, id: x.signal_id, lastPrice: tickers?.[String(x.symbol).toUpperCase()]?.markPrice || tickers?.[String(x.symbol).toUpperCase()]?.price || null })),
      },
      { headers: NO_STORE }
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500, headers: NO_STORE });
  }
}
