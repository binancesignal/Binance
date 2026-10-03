import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import {
  getUserById,
  getUserTradingSettings,
  setUserTradingSettings,
  canAutoTrade,
  getPlan,
} from '../../../../lib/database/users.js';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const settings = await getUserTradingSettings(session.userId);
  return NextResponse.json(settings);
}

export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await req.json();
    const user = await getUserById(session.userId);
    const plan = await getPlan(user.plan);
    const current = await getUserTradingSettings(session.userId);

    if (body.autoTradingEnabled && !canAutoTrade(user, plan)) {
      return NextResponse.json(
        { error: 'Auto-trade requires an active Auto or Pro plan' },
        { status: 403 }
      );
    }

    const next = {
      ...current,
      ...body,
    };

    // clamp by plan
    if (plan?.max_positions) {
      next.maxOpenPositions = Math.min(next.maxOpenPositions || 3, plan.max_positions);
    }

    await setUserTradingSettings(session.userId, next);
    return NextResponse.json(next);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
