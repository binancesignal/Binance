import { NextResponse } from 'next/server';
import { clearSessionCookie } from '../../../../lib/auth/session.js';

export async function POST() {
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
