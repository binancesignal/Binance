import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { manualEnterBinanceSignal } from '../../../../lib/trading/binanceAutoTrader.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/user/manual-entry
 *   { signal: <signal object>, marketPrice?: number, exchange?: 'binance' }
 *
 * Places a market order for a READY signal on the signed-in user's Binance account.
 * Gated by admin `manualEntryEnabled` and the user's Auto/Pro + High Risk + keys.
 */
export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await req.json().catch(() => ({}));
    const exchange = String(body.exchange || 'binance').toLowerCase();
    if (exchange !== 'binance') {
      return NextResponse.json({ error: 'Manual entry is only available for Binance' }, { status: 400 });
    }

    const signal = body.signal;
    if (!signal?.symbol) {
      return NextResponse.json({ error: 'signal.symbol is required' }, { status: 400 });
    }

    const result = await manualEnterBinanceSignal({
      userId: session.userId,
      signal,
      marketPrice: body.marketPrice,
    });

    if (result.ok) {
      return NextResponse.json({
        ok: true,
        msg: 'Market order placed',
        result,
      });
    }
    if (result.skipped) {
      return NextResponse.json(
        { ok: false, error: result.reason || 'Skipped', result },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { ok: false, error: result.reason || 'Entry failed', result },
      { status: 400 }
    );
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
