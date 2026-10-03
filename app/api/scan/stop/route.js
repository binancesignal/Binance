import { NextResponse } from 'next/server';
import { setState, getState } from '../../../../lib/database/appState.js';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    await setState('auto_scan_enabled', false);
    const enabled = await getState('auto_scan_enabled', false);
    return NextResponse.json({ ok: true, auto_scan_enabled: !!enabled });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
