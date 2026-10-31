import { NextResponse } from 'next/server';
import { getState, setState } from '../../../lib/database/appState.js';
import { getSession } from '../../../lib/auth/session.js';
import { getUserById } from '../../../lib/database/users.js';

export const dynamic = 'force-dynamic';

const KEY = 'branding';
const MAX_LOGO_CHARS = 1400000;
const MAX_BANNER_CHARS = 2800000;
const DATA_URL_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

function publicShape(v) {
  return {
    logoUrl: v?.logoUrl || null,
    registerBannerUrl: v?.registerBannerUrl || null,
    appName: v?.appName || 'Signal Desk',
    updatedAt: v?.updatedAt || null,
  };
}

function acceptImage(url, maxChars, label) {
  const isHttp = /^https?:\/\/\S+$/i.test(url);
  if (!isHttp && !DATA_URL_RE.test(url)) {
    return label + ' must be a PNG / JPG / WebP / SVG image or an https URL';
  }
  if (url.length > maxChars) {
    return label + ' is too large — use a smaller image';
  }
  return null;
}

export async function GET() {
  try {
    const v = await getState(KEY, {});
    return NextResponse.json(publicShape(v), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return NextResponse.json(publicShape({}));
  }
}

export async function POST(req) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const user = await getUserById(session.userId);
    if (!user || user.role !== 'admin') {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const current = (await getState(KEY, {})) || {};
    const next = { ...current };

    if (body.removeLogo) next.logoUrl = null;
    if (body.removeRegisterBanner) next.registerBannerUrl = null;

    if (typeof body.logoUrl === 'string' && body.logoUrl) {
      const url = body.logoUrl.trim();
      const err = acceptImage(url, MAX_LOGO_CHARS, 'Logo');
      if (err) return NextResponse.json({ error: err }, { status: 400 });
      next.logoUrl = url;
    }
    if (typeof body.registerBannerUrl === 'string' && body.registerBannerUrl) {
      const url = body.registerBannerUrl.trim();
      const err = acceptImage(url, MAX_BANNER_CHARS, 'Register banner');
      if (err) return NextResponse.json({ error: err }, { status: 400 });
      next.registerBannerUrl = url;
    }
    if (typeof body.appName === 'string') {
      next.appName = body.appName.trim().slice(0, 40) || 'Signal Desk';
    }
    next.updatedAt = new Date().toISOString();

    await setState(KEY, next);
    return NextResponse.json({ ok: true, ...publicShape(next) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
