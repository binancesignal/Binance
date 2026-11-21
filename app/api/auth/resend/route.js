import { NextResponse } from 'next/server';
import { getUserByEmail } from '../../../../lib/database/users.js';
import { sendVerificationEmail } from '../../../../lib/auth/emailVerify.js';

const recent = new Map(); // email -> last send (ms) — simple per-instance throttle

/** POST { email } — re-send the verification email. Always answers ok (no account enumeration). */
export async function POST(req) {
  try {
    const { email } = (await req.json().catch(() => ({}))) || {};
    const key = String(email || '').trim().toLowerCase();
    if (!key) return NextResponse.json({ error: 'Email required' }, { status: 400 });
    const last = recent.get(key) || 0;
    if (Date.now() - last < 30_000) {
      return NextResponse.json({ error: 'Please wait a moment before requesting another email.' }, { status: 429 });
    }
    recent.set(key, Date.now());
    const user = await getUserByEmail(key);
    if (user && user.email_verified === false) {
      await sendVerificationEmail(user, req);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: 'Could not send the email. Try again later.' }, { status: 502 });
  }
}
