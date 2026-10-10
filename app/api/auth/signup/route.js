import { NextResponse } from 'next/server';
import { createUser, getUserByEmail } from '../../../../lib/database/users.js';
import { createSessionToken, setSessionCookie } from '../../../../lib/auth/session.js';

export async function POST(req) {
  try {
    const body = await req.json();
    const { email, password } = body || {};
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    // Rate-limit soft check could go here
    const user = await createUser({ email, password, role: 'user' });
    const token = await createSessionToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      plan: user.plan,
    });
    await setSessionCookie(token);

    return NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        plan: user.plan,
        trial_ends_at: user.trial_ends_at,
        subscription_status: user.subscription_status,
      },
      message: 'Account created. Your 7-day free trial has started.',
    });
  } catch (e) {
    const msg = e.message || 'Signup failed';
    const status = msg.includes('already') ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
