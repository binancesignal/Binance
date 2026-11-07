import { NextResponse } from 'next/server';
import { getUserById, updateUser } from '../../../../lib/database/users.js';
import { createSessionToken, setSessionCookie } from '../../../../lib/auth/session.js';
import { readVerifyToken, baseUrlFromRequest } from '../../../../lib/auth/emailVerify.js';

export const dynamic = 'force-dynamic';

/** GET /api/auth/verify?token=… — marks the email verified, signs the person in, opens the app. */
export async function GET(req) {
  const base = baseUrlFromRequest(req);
  const token = new URL(req.url).searchParams.get('token') || '';
  const parsed = await readVerifyToken(token);
  if (!parsed) return NextResponse.redirect(`${base}/login?verify=invalid`);
  try {
    const user = await getUserById(parsed.userId);
    if (!user || user.email !== parsed.email) return NextResponse.redirect(`${base}/login?verify=invalid`);
    if (user.email_verified === false) await updateUser(user.id, { email_verified: true });
    if (user.is_suspended) return NextResponse.redirect(`${base}/login`);
    const session = await createSessionToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      plan: user.plan,
    });
    await setSessionCookie(session);
    return NextResponse.redirect(`${base}/`);
  } catch (_) {
    return NextResponse.redirect(`${base}/login?verify=invalid`);
  }
}
