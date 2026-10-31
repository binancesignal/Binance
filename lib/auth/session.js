/**
 * JWT session helpers (jose).
 * Cookie name: tm_session
 */
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

const COOKIE = 'tm_session';
const MAX_AGE = 60 * 60 * 24 * 14; // 14 days

function getSecret() {
  const s = process.env.JWT_SECRET || process.env.CRON_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
      throw new Error('JWT_SECRET (or CRON_SECRET) required');
    }
    return new TextEncoder().encode('dev-jwt-secret-change-me');
  }
  return new TextEncoder().encode(s);
}

export async function createSessionToken(payload) {
  const secret = getSecret();
  return new SignJWT({
    sub: payload.userId,
    email: payload.email,
    role: payload.role || 'user',
    plan: payload.plan || 'trial',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret);
}

export async function verifySessionToken(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role || 'user',
      plan: payload.plan || 'trial',
    };
  } catch {
    return null;
  }
}

export async function setSessionCookie(token) {
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.set(COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export async function getSession() {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  return verifySessionToken(token);
}

/** For API routes that receive Request */
export async function getSessionFromRequest(req) {
  const cookieHeader = req.headers.get('cookie') || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE}=([^;]+)`));
  const token = match ? decodeURIComponent(match[1]) : null;
  // Also accept Bearer for API clients
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return verifySessionToken(token || bearer);
}

export { COOKIE as SESSION_COOKIE };
