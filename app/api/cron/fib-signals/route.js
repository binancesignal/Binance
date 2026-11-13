import { NextResponse, after } from 'next/server';
import { runFibSignalsPass, getFibSignalsConfig } from '../../../../lib/fibSignals/runner.js';
import { isProductionDbReady } from '../../../../lib/database/index.js';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Fib Signals cron tick — GET/POST /api/cron/fib-signals?secret=CRON_SECRET[&budget=45][&wait=1]
 * Same auth + background style as /api/cron/full-scan. Does nothing while Fib Signals is OFF in Admin.
 * (The existing /api/cron/full-scan tick also runs this, so a separate cron job is optional.)
 */
async function handle(request) {
  const url = new URL(request.url);
  const cronSecret = process.env.CRON_SECRET;
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('secret');
  if (cronSecret) {
    if (token !== cronSecret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  } else if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (process.env.NODE_ENV === 'production' && !isProductionDbReady()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  const cfg = await getFibSignalsConfig();
  if (!cfg.enabled) return NextResponse.json({ ok: true, skipped: true, reason: 'Fib Signals is OFF — enable it in Admin → Fib Signals' });

  const budgetMs = Math.min(240, Math.max(15, +url.searchParams.get('budget') || 45)) * 1000;
  const job = () => runFibSignalsPass({ source: 'cron', budgetMs });
  if (url.searchParams.get('wait') === '1') return NextResponse.json(await job());
  after(async () => {
    try {
      await job();
    } catch (e) {
      console.error('[cron/fib-signals]', e);
    }
  });
  return NextResponse.json({ ok: true, started: true, background: true });
}

export async function GET(request) {
  return handle(request);
}
export async function POST(request) {
  return handle(request);
}
