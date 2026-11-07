import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { healTpBeforeSl, HEAL_STATE_KEY } from '../../../../lib/signals/healTpBeforeSl.js';
import { getState } from '../../../../lib/database/appState.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' };

async function authorized(request) {
  const cronSecret = process.env.CRON_SECRET || '';
  const url = new URL(request.url);
  const token = (
    (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
    url.searchParams.get('secret') ||
    ''
  ).trim();
  if (cronSecret && token === cronSecret.trim()) return true;
  const session = await getSession();
  return !!session && session.role === 'admin';
}

/** GET → heal status. */
export async function GET(request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }
  const state = await getState(HEAL_STATE_KEY, null);
  return NextResponse.json({ ok: true, state }, { headers: NO_STORE });
}

/**
 * POST /api/admin/heal-tp  (admin session or ?secret=CRON_SECRET)
 * Re-checks old STOPPED trades with candle history; trades that touched TP1/TP2/TP3 before
 * the SL are flagged so they count as TP, not SL.
 * Body/query: days (default 30), limit (default 40)
 */
export async function POST(request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }
  const url = new URL(request.url);
  let body = {};
  try { body = await request.json(); } catch (_) {}
  const days = Math.max(1, Math.min(90, +(body.days ?? url.searchParams.get('days')) || 30));
  const limit = Math.max(1, Math.min(120, +(body.limit ?? url.searchParams.get('limit')) || 40));
  try {
    const result = await healTpBeforeSl({ days, limit, budgetMs: 90_000, force: true });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500, headers: NO_STORE });
  }
}
