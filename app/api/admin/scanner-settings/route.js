import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getScannerSettings, saveScannerSettings } from '../../../../lib/fibSignals/scannerSettings.js';

export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' };

async function requireAdmin() {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE });
  return null;
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    return NextResponse.json({ ok: true, settings: await getScannerSettings() }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error.message || 'Unable to load scanner settings' }, { status: 500, headers: NO_STORE });
  }
}

export async function PUT(request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const body = await request.json();
    const settings = await saveScannerSettings(body.settings || body);
    return NextResponse.json({ ok: true, settings, saved: true }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error.message || 'Unable to save scanner settings' }, { status: 400, headers: NO_STORE });
  }
}
