import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { createUser, getUserByEmail } from '../../../../../lib/database/users.js';
import { createSessionToken, setSessionCookie } from '../../../../../lib/auth/session.js';
import { attachReferrer, ensureReferralCode } from '../../../../../lib/database/payments.js';

export const dynamic = 'force-dynamic';

function fail(req, code) {
  const res = NextResponse.redirect(new URL(`/login?error=${code}`, req.url));
  res.cookies.set('g_state', '', { path: '/', maxAge: 0 });
  return res;
}

/** GET /api/auth/google/callback — Google redirects here with ?code & ?state. */
export async function GET(req) {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookieState = req.cookies.get('g_state')?.value;
    if (!code || !state || !cookieState || state !== cookieState) return fail(req, 'google_state');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        redirect_uri: `${url.origin}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tok = await tokenRes.json();
    if (!tokenRes.ok || !tok.access_token) return fail(req, 'google_token');

    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const info = await infoRes.json();
    if (!infoRes.ok || !info.email || info.email_verified === false) return fail(req, 'google_email');

    let user = await getUserByEmail(info.email);
    if (user?.is_suspended) return fail(req, 'suspended');
    if (!user) {
      // New account: random password (never used — they sign in with Google)
      user = await createUser({ email: info.email, password: randomBytes(24).toString('hex'), role: 'user' });
      try {
        await ensureReferralCode(user.id);
        const ref = req.cookies.get('g_ref')?.value;
        if (ref) await attachReferrer(user.id, ref);
      } catch (_) {}
    }

    const token = await createSessionToken({ userId: user.id, email: user.email, role: user.role, plan: user.plan });
    await setSessionCookie(token);
    const res = NextResponse.redirect(new URL('/', req.url));
    res.cookies.set('g_state', '', { path: '/', maxAge: 0 });
    res.cookies.set('g_ref', '', { path: '/', maxAge: 0 });
    return res;
  } catch (_) {
    return fail(req, 'google_failed');
  }
}
