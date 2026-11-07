/** Stateless email-verification links (signed JWT, valid 24h). */
import { SignJWT, jwtVerify } from 'jose';
import { getJwtSecret } from './session.js';
import { getState } from '../database/appState.js';
import { sendMail } from '../mail/mailer.js';
import { verifyEmailTemplate } from '../mail/templates.js';

export async function createVerifyToken(user) {
  return new SignJWT({ email: user.email, purpose: 'verify-email' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(getJwtSecret());
}

export async function readVerifyToken(token) {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (payload.purpose !== 'verify-email' || !payload.sub) return null;
    return { userId: payload.sub, email: payload.email };
  } catch (_) {
    return null;
  }
}

export function baseUrlFromRequest(req) {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  return `${proto}://${host}`;
}

export async function sendVerificationEmail(user, req) {
  const brand = (await getState('branding', {})) || {};
  const appName = brand.appName || 'Signal Desk';
  const token = await createVerifyToken(user);
  const link = `${baseUrlFromRequest(req)}/api/auth/verify?token=${encodeURIComponent(token)}`;
  const mail = verifyEmailTemplate({ appName, logoUrl: brand.logoUrl, link });
  await sendMail({ to: user.email, appName, ...mail });
}
