import { NextResponse } from 'next/server';
import { getUserByEmail, verifyPassword, sanitizeUser } from '../../../../lib/database/users.js';
import { createSessionToken, setSessionCookie } from '../../../../lib/auth/session.js';

export async function POST(req) {
  try {
    const body = await req.json();
    const { email, password } = body || {};
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }
    if (user.is_suspended) {
      return NextResponse.json({ error: 'Account suspended. Contact support.' }, { status: 403 });
    }
    const ok = await verifyPassword(user, password);
    if (!ok) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    const token = await createSessionToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      plan: user.plan,
    });
    await setSessionCookie(token);

    return NextResponse.json({
      ok: true,
      user: sanitizeUser(user),
    });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Login failed' }, { status: 500 });
  }
}
