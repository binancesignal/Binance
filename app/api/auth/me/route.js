import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import {
  getUserById,
  sanitizeUser,
  getTrialDaysLeft,
  hasActiveAccess,
  canAutoTrade,
  getUserKeyStatus,
  getUserTradingSettings,
  getSubscription,
  getPlan,
} from '../../../../lib/database/users.js';

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ user: null }, { status: 401 });
    }
    const user = await getUserById(session.userId);
    if (!user) {
      return NextResponse.json({ user: null }, { status: 401 });
    }
    const plan = await getPlan(user.plan);
    const keyStatus = await getUserKeyStatus(user.id);
    const settings = await getUserTradingSettings(user.id);
    const sub = await getSubscription(user.id);

    return NextResponse.json({
      user: {
        ...sanitizeUser(user),
        trial_days_left: getTrialDaysLeft(user),
        has_access: hasActiveAccess(user),
        can_auto_trade: canAutoTrade(user, plan),
      },
      plan,
      key_status: keyStatus,
      settings,
      subscription: sub,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
