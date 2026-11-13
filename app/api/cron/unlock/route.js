import { NextResponse } from 'next/server';
import { forceUnlockAll } from '../../../../lib/database/scanRuns.js';

export const dynamic = 'force-dynamic';

/**
 * Force-clear stuck scan locks.
 * GET /api/cron/unlock?secret=YOUR_CRON_SECRET
 */
export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET;
  const url = new URL(request.url);
  const querySecret = url.searchParams.get('secret');
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '') || querySecret;

  if (cronSecret && token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await forceUnlockAll();
    return NextResponse.json({
      ok: true,
      cleared: result.cleared,
      msg: `Cleared ${result.cleared} stuck RUNNING scan(s)`,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e.message || e).slice(0, 200) },
      { status: 500 }
    );
  }
}
