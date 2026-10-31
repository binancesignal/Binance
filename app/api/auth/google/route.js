import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';

export const dynamic = 'force-dynamic';

/** GET /api/auth/google → redirect to Google's consent screen. */
export async function GET(req) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
    return NextResponse.redirect(new URL('/login?error=google_not_configured', req.url));
  }
  const origin = new URL(req.url).origin;
  const state = randomBytes(16).toString('hex');
  const ref = new URL(req.url).searchParams.get('ref') || '';
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  const res = NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  const opts = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 600 };
  res.cookies.set('g_state', state, opts);
  if (ref) res.cookies.set('g_ref', ref.slice(0, 64), opts);
  return res;
}
