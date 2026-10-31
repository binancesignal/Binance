import { NextResponse } from 'next/server';
import { getSession } from '../../../lib/auth/session.js';
import { getUserById } from '../../../lib/database/users.js';
import { getState, setState } from '../../../lib/database/appState.js';
import { WELCOME_KEY, sanitizeSlides, slidesOrDefault, DEFAULT_SLIDES } from '../../../lib/branding/welcomeSlides.js';

export const dynamic = 'force-dynamic';

function googleEnabled() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// Public — the welcome screen is shown before anyone is signed in.
export async function GET() {
  let saved = null;
  let brand = {};
  try { saved = (await getState(WELCOME_KEY, null))?.slides || null; } catch (_) {}
  try { brand = (await getState('branding', {})) || {}; } catch (_) {}
  return NextResponse.json(
    {
      slides: slidesOrDefault(saved),
      isDefault: !(Array.isArray(saved) && saved.length),
      appName: brand.appName || 'Signal Desk',
      logoUrl: brand.logoUrl || null,
      googleEnabled: googleEnabled(),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

// Admin only. Body: { slides: [{ imageUrl, title, subtitle }] }  |  { reset: true }
export async function POST(req) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const user = await getUserById(session.userId);
    if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    if (body.reset) {
      await setState(WELCOME_KEY, { slides: null, updatedAt: new Date().toISOString() });
      return NextResponse.json({ ok: true, slides: DEFAULT_SLIDES, isDefault: true });
    }
    const slides = sanitizeSlides(body.slides);
    if (!slides.length) return NextResponse.json({ error: 'Add at least one slide (or use Reset to defaults)' }, { status: 400 });
    await setState(WELCOME_KEY, { slides, updatedAt: new Date().toISOString() });
    return NextResponse.json({ ok: true, slides, isDefault: false });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Failed' }, { status: 400 });
  }
}
