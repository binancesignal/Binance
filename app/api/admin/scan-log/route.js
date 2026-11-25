import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getState, setState } from '../../../../lib/database/appState.js';
import { BAN_STATE_KEY } from '../../../../lib/binance/client.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' };

async function requireAdmin() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { session };
}

const safe = async (key, fallback) => {
  try {
    return (await getState(key, fallback)) ?? fallback;
  } catch (_) {
    return fallback;
  }
};

/**
 * GET /api/admin/scan-log?exchange=binance
 */
export async function GET(request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const qEx = String(new URL(request.url).searchParams.get('exchange') || 'binance').toLowerCase();
  const exchange = qEx === 'bybit' ? 'bybit' : 'binance';
  const [live, lastFull, lastCron, histFull, histCron, coinStatus, interval, parts, budget, autoScan, nextFull, ban] =
    await Promise.all([
      safe('scan_live', null),
      safe(`scan_last_run:full:${exchange}`, null),
      safe(`scan_last_run:cron:${exchange}`, null),
      safe(`scan_run_history:full:${exchange}`, []),
      safe(`scan_run_history:cron:${exchange}`, []),
      safe(`coin_scan_status:${exchange}`, {}),
      safe('full_scan_interval_minutes', 5),
      safe('full_scan_parts', 3),
      safe('full_scan_budget_seconds', null),
      safe('auto_scan_enabled', false),
      safe('next_full_scan_at', null),
      safe(BAN_STATE_KEY, null),
    ]);
  return NextResponse.json(
    {
      now: new Date().toISOString(),
      exchange,
      autoScanEnabled: !!autoScan,
      intervalMinutes: +interval || 5,
      parts: +parts || 3,
      budgetSeconds: budget != null ? +budget : null,
      nextFullScanAt: nextFull,
      ban: ban && +ban.until > Date.now() ? ban : null,
      live,
      lastFull,
      lastCron,
      historyFull: histFull,
      historyCron: histCron,
      coinStatus,
    },
    { headers: NO_STORE }
  );
}

/**
 * POST — reset scan progress (cursors + logs) so the next run starts from the beginning.
 * Does NOT delete trading signals.
 */
export async function POST(request) {
  const { error } = await requireAdmin();
  if (error) return error;
  try {
    const body = await request.json().catch(() => ({}));
    const action = body.action || 'reset_progress';
    const exchange = String(body.exchange || 'binance').toLowerCase() === 'bybit' ? 'bybit' : 'binance';

    if (action !== 'reset_progress') {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }

    const keys = [
      `scan_cursor:${exchange}`,
      `scan_cursor_full:${exchange}`,
      `scan_last_run:full:${exchange}`,
      `scan_last_run:cron:${exchange}`,
      `scan_run_history:full:${exchange}`,
      `scan_run_history:cron:${exchange}`,
      `coin_scan_status:${exchange}`,
      'scan_live',
      // legacy / shared
      'scan_cursor',
    ];

    for (const key of keys) {
      try {
        await setState(key, key.includes('history') ? [] : key === 'scan_live' ? { status: 'idle', resetAt: new Date().toISOString() } : null);
      } catch (_) {}
    }

    // Next full scan as soon as cron allows
    try {
      await setState('next_full_scan_at', new Date().toISOString());
    } catch (_) {}

    return NextResponse.json({
      ok: true,
      msg: `Scan progress cleared for ${exchange}. Next run starts from the beginning (signals kept).`,
      cleared: keys,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
