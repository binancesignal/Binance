import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getLedgerExecutions } from '../../../../lib/database/executions.js';
import { levelFromVolume, sumTradedVolume } from '../../../../lib/trading/userLevel.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

/** GET /api/user/level — level + trading volume for the My Profile screen. */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let volume = 0;
  try {
    const rows = await getLedgerExecutions({ userId: session.userId });
    volume = sumTradedVolume(rows);
  } catch (_) {
    volume = 0;
  }
  return NextResponse.json({ ok: true, ...levelFromVolume(volume) }, { headers: { 'Cache-Control': 'no-store' } });
}
