import { NextResponse } from 'next/server';
import { getSession } from '../../../lib/auth/session.js';
import { getUserById } from '../../../lib/database/users.js';
import { getState, setState } from '../../../lib/database/appState.js';

export const dynamic = 'force-dynamic';

const KEY = 'branding';
const MAX_LOGO_CHARS = 1_500_000; // ~1.1 MB data URL — the admin UI resizes well below this
const DATA_URL_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

function publicShape(v) {
  return {
    logoUrl: v?.logoUrl || null,
    appName: v?.appName || 'Signal Desk',
    updatedAt: v?.updatedAt || null,
  };
}

// Public — the login / signup pages need the logo before anyone is signed in.
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

// Admin only
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
    if (typeof body.logoUrl === 'string' && body.logoUrl) {
      const url = body.logoUrl.trim();
      const isHttp = /^https?:\/\/\S+$/i.test(url);
      if (!isHttp && !DATA_URL_RE.test(url)) {
        return NextResponse.json({ error: 'Logo must be a PNG / JPG / WebP / SVG image or an https URL' }, { status: 400 });
      }
      if (url.length > MAX_LOGO_CHARS) {
        return NextResponse.json({ error: 'Logo is too large — use an image under 1 MB' }, { status: 400 });
      }
      next.logoUrl = url;
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
