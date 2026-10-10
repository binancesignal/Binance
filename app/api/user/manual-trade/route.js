import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getUserById, canAutoTrade, getPlan } from '../../../../lib/database/users.js';
import { placeFreeManualTrade } from '../../../../lib/trading/freeManualTrade.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/user/manual-trade
 * Body: { symbol, direction: 'LONG'|'SHORT', leverage, marginUsdt, exchange?: 'binance' }
 *
 * Free-form market order — no signal required.
 * Gated by admin freeManualTradeEnabled + user's Auto/Pro plan + connected keys.
 */
export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const user = await getUserById(session.userId);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const plan = await getPlan(user.plan);
    if (!canAutoTrade(user, plan)) {
      return NextResponse.json(
        { error: 'Upgrade to Auto plan to place manual trades' },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const result = await placeFreeManualTrade({
      userId: session.userId,
      symbol: body.symbol,
      direction: body.direction,
      leverage: body.leverage,
      marginUsdt: body.marginUsdt,
      exchange: body.exchange || 'binance',
    });

    if (result.ok) {
      return NextResponse.json({
        ok: true,
        msg: result.msg || 'Market order placed',
        result,
      });
    }

    return NextResponse.json(
      { ok: false, error: result.reason || 'Trade failed', result },
      { status: 400 }
    );
  } catch (e) {
    console.error('[manual-trade]', e);
    return NextResponse.json({ error: e.message || 'Server error' }, { status: 500 });
  }
}
