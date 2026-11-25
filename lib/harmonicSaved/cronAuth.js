import { NextResponse } from 'next/server';
import { getState } from '../database/appState.js';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/** Shared cron auth: env CRON_SECRET / CRON_JOB_SECRET, or the secret saved in the database (admin panel). */
export async function assertHarmonicCron(request) {
  const url = new URL(request.url);
  const authHeader = request.headers.get('authorization') || '';
  const rawQuery = (url.search.match(/[?&]secret=([^&]*)/) || [])[1] || '';
  let rawDecoded = rawQuery;
  try {
    rawDecoded = decodeURIComponent(rawQuery);
  } catch (_) {}
  const token = (authHeader.replace(/^Bearer\s+/i, '') || url.searchParams.get('secret') || '').trim();
  const candidates = [...new Set([token, token.replace(/ /g, '+'), rawDecoded.trim(), rawQuery.trim()].filter(Boolean))];

  const accepted = [];
  const cronEnv = String(process.env.CRON_SECRET || process.env.CRON_JOB_SECRET || '').trim();
  if (cronEnv) accepted.push(cronEnv);
  try {
    const dbSecret = String((await getState('cron_secret', null)) || '').trim();
    if (dbSecret) accepted.push(dbSecret);
  } catch (_) {}
  if (!accepted.length) {
    const jwtFallback = String(process.env.JWT_SECRET || process.env.SESSION_SECRET || '').trim();
    if (jwtFallback) accepted.push(jwtFallback);
  }
  if (!accepted.length) return { error: json({ ok: false, error: 'CRON_SECRET not configured on the server' }, 500) };
  if (!candidates.some((c) => accepted.includes(c))) {
    return {
      error: json(
        {
          ok: false,
          error: 'Unauthorized',
          hint: !token
            ? 'No secret received. Use ?secret=YOUR_CRON_SECRET or header Authorization: Bearer YOUR_CRON_SECRET'
            : 'Secret does not match the server secret (check typos, spaces, or special characters like + & # in the URL)',
          received: { length: token.length },
        },
        401
      ),
    };
  }
  return { ok: true };
}

export { json as cronJson };
