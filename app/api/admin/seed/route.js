/**
 * One-time bootstrap: create first admin.
 * POST { email, password, secret } where secret === process.env.CRON_SECRET
 */
import { NextResponse } from 'next/server';
import { createUser, getUserByEmail, updateUser } from '../../../../lib/database/users.js';

export async function POST(req) {
  try {
    const body = await req.json();
    const { email, password, secret } = body || {};
    if (!secret || secret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (!email || !password) {
      return NextResponse.json({ error: 'email and password required' }, { status: 400 });
    }

    let user = await getUserByEmail(email);
    if (!user) {
      user = await createUser({ email, password, role: 'admin' });
    } else {
      await updateUser(user.id, { role: 'admin' });
    }
    return NextResponse.json({
      ok: true,
      message: 'Admin ready. Sign in with that email.',
      email,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
