import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { forceUnlockAll } from '../../../../lib/database/scanRuns.js';

export const dynamic = 'force-dynamic';

/**
 * Admin: clear stuck RUNNING scan lock so Scan Now can start.
 * POST /api/scan/unlock
 */
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const result = await forceUnlockAll();
    return NextResponse.json({
      ok: true,
      cleared: result.cleared ?? 0,
      msg: `Cleared ${result.cleared ?? 0} stuck lock(s)`,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
