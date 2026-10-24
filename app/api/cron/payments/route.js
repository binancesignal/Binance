/**
 * Auto deposit + auto withdraw processor.
 * Call every 1–5 minutes from Vercel Cron or external cron:
 *   GET /api/cron/payments?secret=CRON_SECRET
 */
import { NextResponse } from 'next/server';
import { processAutoDeposits, processAutoWithdrawals } from '../../../../lib/database/payments.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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

  try {
    const [deposits, withdrawals] = await Promise.all([
      processAutoDeposits(),
      processAutoWithdrawals(),
    ]);
    return NextResponse.json({
      ok: true,
      at: new Date().toISOString(),
      deposits,
      withdrawals,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(request) {
  return handle(request);
}

export async function POST(request) {
  return handle(request);
}
