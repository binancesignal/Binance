import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getReferralStats, ensureReferralCode } from '../../../../lib/database/payments.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    await ensureReferralCode(session.userId);
    const stats = await getReferralStats(session.userId);
    const origin =
      req.headers.get('x-forwarded-host') ||
      req.headers.get('host') ||
      '';
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    const base = origin ? `${proto}://${origin}` : '';
    return NextResponse.json({
      ...stats,
      referral_link: base
        ? `${base}/signup?ref=${stats.referral_code}`
        : stats.referral_link_path,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
