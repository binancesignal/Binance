import { NextResponse, after } from 'next/server';
import { runHarmonicAutoTick } from '../../../../lib/scanner/harmonicAuto.js';
import { isProductionDbReady } from '../../../../lib/database/index.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Paced Harmonic auto-scan tick.
 * Call every 1–2 minutes (cron-job.org / Vercel Cron).
 * Scans a few coins per tick; after a full universe pass, waits intervalHours
 * (admin setting, default 1h) before the next pass. Phone not required.
 *
 * GET/POST /api/cron/harmonic-auto?secret=CRON_SECRET
 * Optional: &wait=1 to run inline (debug).
 */
async function handle(request) {
  const authHeader = request.headers.get('authorization') || '';
  const cronSecret = process.env.CRON_SECRET;
  const url = new URL(request.url);
  const querySecret = url.searchParams.get('secret');

  if (cronSecret) {
    const token = authHeader.replace(/^Bearer\s+/i, '') || querySecret;
    if (token !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }

  if (process.env.NODE_ENV === 'production' && !isProductionDbReady()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }

  const wait = url.searchParams.get('wait') === '1';
  if (wait) {
    try {
      const result = await runHarmonicAutoTick({ budgetMs: 50_000 });
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json({ error: e.message || String(e) }, { status: 500 });
    }
  }

  after(async () => {
    try {
      await runHarmonicAutoTick({ budgetMs: 50_000 });
    } catch (e) {
      console.error('[cron/harmonic-auto]', e);
    }
  });
  return NextResponse.json({ ok: true, started: true, job: 'harmonic-auto' });
}

export const GET = handle;
export const POST = handle;
