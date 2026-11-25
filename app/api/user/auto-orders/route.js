import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getRecentExecutions } from '../../../../lib/database/executions.js';
import { getState } from '../../../../lib/database/appState.js';
import { getAutoTradingConfig } from '../../../../lib/trading/autoConfig.js';
import { loadSaved, toPublicItem } from '../../../../lib/harmonicSaved/store.js';
import { checkAutoTradeReadiness } from '../../../../lib/trading/readiness.js';
import { toOrderView, sortOrderViews } from '../../../../lib/trading/orderView.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

const RECENT_MS = 48 * 3600_000; // problems / cancelled orders stay visible for 2 days

/**
 * GET /api/user/auto-orders — DATABASE ONLY (never calls Binance), so the Portfolio can poll it
 * every few seconds: pending limit orders, running trades, orders that failed (with the reason),
 * the ENTRY READY queue and the live state of each order's signal.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  try {
    const debug = {};
    const [blockers, execs, saved, cfg, last] = await Promise.all([
      checkAutoTradeReadiness(session.userId, debug),
      getRecentExecutions(120, { userId: session.userId, exchange: 'binance' }),
      loadSaved().catch(() => []),
      getAutoTradingConfig(),
      getState(`binance_auto_trade_last:${session.userId}`, null).catch(() => null),
    ]);
    const liveById = new Map();
    for (const it of saved) {
      const pub = toPublicItem(it);
      liveById.set(String(it.id), pub);
    }
    const cutoff = Date.now() - RECENT_MS;
    const orders = sortOrderViews(
      execs
        .map((e) => toOrderView(e, liveById))
        .filter((o) => o.group !== 'closed')
        .filter((o) => o.group === 'pending' || o.group === 'running' || Date.parse(o.updatedAt || o.createdAt || 0) >= cutoff)
    ).slice(0, 40);
    return NextResponse.json(
      {
        ok: true,
        at: Date.now(),
        orders,
        blockers,
        blockerDebug: blockers.length ? debug : null,
        queue: Array.isArray(last?.queue) ? last.queue : [],
        lastRun: last
          ? {
              at: last.at,
              mode: last.mode,
              slots: last.slots,
              readyCount: last.readyCount ?? null,
              cancelled: last.cancelled || [],
              outcomes: last.outcomes || [],
              sync: last.sync || null,
              blocked: last.blocked || null,
            }
          : null,
        config: {
          autoTradingEnabled: !!cfg.autoTradingEnabled,
          orderType: cfg.orderType,
          maxPendingLimitOrders: cfg.maxPendingLimitOrders,
          entryReadyProximityPercent: cfg.entryReadyProximityPercent,
        },
      },
      { headers: NO_STORE }
    );
  } catch (e) {
    return NextResponse.json({ error: e.message || String(e) }, { status: 500, headers: NO_STORE });
  }
}
