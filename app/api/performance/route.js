import { NextResponse } from 'next/server';
import {
  getPerformanceSummary,
  startPerformancePeriod,
  resetPerformancePeriod,
} from '../../../lib/performance/summary.js';
import { getState } from '../../../lib/database/appState.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const period = url.searchParams.get('period') || '24h';
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const summary = await getPerformanceSummary({ period, from, to });
    return NextResponse.json(summary);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = body.action || '';
    if (action === 'start' || action === 'reset') {
      const r =
        action === 'start'
          ? await startPerformancePeriod()
          : await resetPerformancePeriod();
      return NextResponse.json(r);
    }
    if (action === 'status') {
      const started = await getState('performance_tracking_started_at', null);
      return NextResponse.json({ ok: true, performanceTrackingStartedAt: started });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
