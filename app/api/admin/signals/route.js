import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import {
  getActiveSignals,
  getSignalById,
  updateSignal,
  createSignalEvent,
} from '../../../../lib/database/signals.js';
import { SIGNAL_STATUS, canTransition, ALLOWED_TRANSITIONS } from '../../../../lib/config/signalConfig.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function requireAdmin() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.role !== 'admin') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { session };
}

/**
 * GET /api/admin/signals
 * List active signals (WATCHING / READY / ONGOING) for admin dashboard.
 */
export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  try {
    const active = await getActiveSignals();
    const norm = (s) => String(s?.status || '').trim().toUpperCase();
    const watching = (active || []).filter((s) => norm(s) === SIGNAL_STATUS.WATCHING);
    const ready = (active || []).filter((s) => norm(s) === SIGNAL_STATUS.READY);
    const ongoing = (active || []).filter((s) => norm(s) === SIGNAL_STATUS.ONGOING);
    return NextResponse.json({
      watching,
      ready,
      ongoing,
      counts: {
        watching: watching.length,
        ready: ready.length,
        ongoing: ongoing.length,
        total: (active || []).length,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Failed to load signals' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/signals
 * Manually change signal status (admin only).
 *
 * Body: { signalId, action }  or  { signalId, status }
 *
 * Actions:
 *   - promote_ready  : WATCHING → READY  (sets ready_at)
 *   - promote_ongoing: READY → ONGOING   (sets entry_hit_at, entry_hit_price — triggers Bybit auto-trade on next cron)
 *   - set_status     : any allowed transition via `status` field
 *
 * When READY → ONGOING, entry_hit_at / entry_hit_price are set so auto-trader
 * treats it as a real entry hit (Bybit trade will fire if auto-trading is on).
 */
export async function PATCH(req) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  try {
    const body = await req.json();
    const { signalId, action, status: targetStatus } = body || {};
    if (!signalId) {
      return NextResponse.json({ error: 'signalId required' }, { status: 400 });
    }

    const signal = await getSignalById(signalId);
    if (!signal) {
      return NextResponse.json({ error: 'Signal not found' }, { status: 404 });
    }

    const from = String(signal.status || '').trim().toUpperCase();
    let to = null;
    let updates = {};
    const now = new Date().toISOString();
    const price = +(signal.current_price || signal.entry || signal.entry_hit_price || 0) || null;

    if (action === 'promote_ready') {
      to = SIGNAL_STATUS.READY;
      if (from !== SIGNAL_STATUS.WATCHING) {
        return NextResponse.json(
          { error: `promote_ready only from WATCHING (current: ${from})` },
          { status: 400 }
        );
      }
      updates = {
        status: SIGNAL_STATUS.READY,
        ready_at: signal.ready_at || now,
        last_updated_at: now,
      };
    } else if (action === 'promote_ongoing') {
      to = SIGNAL_STATUS.ONGOING;
      if (from !== SIGNAL_STATUS.READY) {
        return NextResponse.json(
          { error: `promote_ongoing only from READY (current: ${from})` },
          { status: 400 }
        );
      }
      updates = {
        status: SIGNAL_STATUS.ONGOING,
        entry_hit_at: now,
        entry_hit_price: price,
        ready_at: signal.ready_at || signal.created_at || now,
        last_updated_at: now,
        metadata: {
          ...(signal.metadata || {}),
          adminForcedEntry: true,
          adminForcedAt: now,
          adminUserId: session.userId,
        },
      };
    } else if (action === 'set_status' || targetStatus) {
      to = String(targetStatus || '').trim().toUpperCase();
      if (!Object.values(SIGNAL_STATUS).includes(to)) {
        return NextResponse.json(
          { error: `Invalid status. Allowed: ${Object.values(SIGNAL_STATUS).join(', ')}` },
          { status: 400 }
        );
      }
      if (!canTransition(from, to) && from !== to) {
        return NextResponse.json(
          {
            error: `Transition ${from} → ${to} not allowed. Allowed from ${from}: ${(ALLOWED_TRANSITIONS[from] || []).join(', ') || 'none'}`,
          },
          { status: 400 }
        );
      }
      updates = {
        status: to,
        last_updated_at: now,
      };
      if (to === SIGNAL_STATUS.READY && !signal.ready_at) {
        updates.ready_at = now;
      }
      if (to === SIGNAL_STATUS.ONGOING) {
        updates.entry_hit_at = signal.entry_hit_at || now;
        updates.entry_hit_price = signal.entry_hit_price || price;
        if (!signal.ready_at) updates.ready_at = signal.created_at || now;
        updates.metadata = {
          ...(signal.metadata || {}),
          adminForcedEntry: true,
          adminForcedAt: now,
          adminUserId: session.userId,
        };
      }
      if (to === SIGNAL_STATUS.INVALIDATED) {
        updates.invalidated_at = now;
      }
      if (to === SIGNAL_STATUS.COMPLETED_PROFIT || to === SIGNAL_STATUS.STOPPED) {
        updates.completed_at = now;
      }
    } else {
      return NextResponse.json(
        { error: 'Provide action (promote_ready | promote_ongoing | set_status) or status' },
        { status: 400 }
      );
    }

    if (from === to) {
      return NextResponse.json({ ok: true, signal, message: 'Already in target status' });
    }

    const updated = await updateSignal(signalId, updates);
    if (!updated) {
      return NextResponse.json({ error: 'Update failed (signal may have been deleted)' }, { status: 500 });
    }

    // Record lifecycle event for audit / live board
    try {
      await createSignalEvent({
        signal_id: signalId,
        event_type: to === SIGNAL_STATUS.ONGOING ? 'ENTRY_HIT' : `ADMIN_${to}`,
        old_status: from,
        new_status: to,
        price,
        message: `Admin manual status change: ${from} → ${to}`,
        metadata: {
          admin: true,
          adminUserId: session.userId,
          action: action || 'set_status',
        },
      });
    } catch (evtErr) {
      // non-fatal
      console.warn('[admin/signals] event create failed', evtErr?.message);
    }

    let tradeResult = null;
    if (to === SIGNAL_STATUS.ONGOING) {
      try {
        const { getAutoTradingConfig } = await import('../../../../lib/trading/autoConfig.js');
        const { processSignal } = await import('../../../../lib/trading/autoTrader.js');
        const { getState } = await import('../../../../lib/database/appState.js');
        const cfg = await getAutoTradingConfig();
        if (cfg?.autoTradingEnabled) {
          const apiKey = await getState('bybit_api_key', null);
          const apiSecret = await getState('bybit_api_secret', null);
          if (apiKey && apiSecret) {
            tradeResult = await processSignal(updated, cfg, { apiKey, apiSecret });
          } else {
            tradeResult = { ok: false, reason: 'Bybit keys not configured (global)' };
          }
        } else {
          tradeResult = { ok: false, reason: 'Auto-trading is disabled' };
        }
      } catch (tradeErr) {
        console.warn('[admin/signals] immediate trade attempt failed', tradeErr?.message);
        tradeResult = { ok: false, reason: tradeErr?.message || 'trade error' };
      }
    }

    return NextResponse.json({
      ok: true,
      signal: updated,
      from,
      to,
      trade: tradeResult,
      message:
        to === SIGNAL_STATUS.ONGOING
          ? tradeResult?.ok
            ? `ONGOING + Bybit trade attempted: ${tradeResult.status || tradeResult.reason || 'ok'}`
            : `Status ONGOING. Auto-trade: ${tradeResult?.reason || 'pending next cron'}`
          : `Status changed ${from} → ${to}`,
    });
  } catch (e) {
    console.error('[admin/signals] PATCH error', e);
    return NextResponse.json({ error: e.message || 'Update failed' }, { status: 500 });
  }
}
