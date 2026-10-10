import { NextResponse } from 'next/server';
import { getSession } from '../../../../../lib/auth/session.js';
import { getExchangeKeys } from '../../../../../lib/database/users.js';
import { closeBinancePositions } from '../../../../../lib/trading/manualClose.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /api/user/positions/close
 *   { exchange: 'binance', symbol: 'BTCUSDT', direction: 'LONG' }   close one position
 *   { exchange: 'binance', all: true }                              close every position
 * Always acts on the signed-in user's own account.
 */
export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const exchange = String(body.exchange || 'binance').toLowerCase();
    if (exchange !== 'binance') {
      return NextResponse.json({ error: 'Manual close is only available for Binance' }, { status: 400 });
    }
    if (!body.all && !body.symbol) {
      return NextResponse.json({ error: 'symbol is required (or all: true)' }, { status: 400 });
    }
    const keys = await getExchangeKeys(session.userId, 'binance');
    if (!keys) return NextResponse.json({ error: 'Connect Binance first' }, { status: 400 });

    const r = await closeBinancePositions({
      userId: session.userId,
      keys,
      target: body.all ? { all: true } : { symbol: body.symbol, direction: body.direction },
    });
    if (r.notFound) {
      return NextResponse.json({ error: 'No open position found (maybe it already closed)' }, { status: 404 });
    }
    const ok = r.closed.length > 0;
    return NextResponse.json(
      { ok, closed: r.closed, failed: r.failed, error: ok ? undefined : r.failed[0]?.error || 'Close failed' },
      { status: ok ? 200 : 502 }
    );
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
