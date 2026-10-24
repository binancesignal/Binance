import { NextResponse } from 'next/server';
import { getSession } from '../../../../../lib/auth/session.js';
import { getExchangeKeys } from '../../../../../lib/database/users.js';
import { changeBinanceTakeProfit } from '../../../../../lib/trading/changeTp.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /api/user/positions/tp
 *   { exchange: 'binance', symbol, direction: 'LONG'|'SHORT', tpLevel: 1|2|3 }
 *   or { ..., tpPrice: number }
 * Changes take-profit on the user's open position (and keeps SL).
 */
export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const exchange = String(body.exchange || 'binance').toLowerCase();
    if (exchange !== 'binance') {
      return NextResponse.json({ error: 'TP change is only available for Binance' }, { status: 400 });
    }
    if (!body.symbol) {
      return NextResponse.json({ error: 'symbol is required' }, { status: 400 });
    }
    if (body.tpLevel == null && body.tpPrice == null) {
      return NextResponse.json({ error: 'tpLevel (1–3) or tpPrice required' }, { status: 400 });
    }
    const keys = await getExchangeKeys(session.userId, 'binance');
    if (!keys) return NextResponse.json({ error: 'Connect Binance first' }, { status: 400 });

    const r = await changeBinanceTakeProfit({
      userId: session.userId,
      keys,
      symbol: body.symbol,
      direction: body.direction || body.side,
      tpLevel: body.tpLevel,
      tpPrice: body.tpPrice,
    });
    if (r.notFound) {
      return NextResponse.json({ error: r.reason || 'Position not found' }, { status: 404 });
    }
    if (!r.ok) {
      return NextResponse.json({ error: r.reason || 'Failed to change TP', result: r }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
