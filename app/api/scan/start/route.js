import { NextResponse } from 'next/server';
import { setState, getState } from '../../../../lib/database/appState.js';
import { SIGNAL_CONFIG } from '../../../../lib/config/signalConfig.js';

export const dynamic = 'force-dynamic';

/**
 * Turn auto-scan ON and reset cursor so the next cron starts from top volume.
 */
export async function POST() {
  try {
    await setState('auto_scan_enabled', true);
    // First enable → start from the beginning of the universe
    await setState('scan_cursor', {
      offset: 0,
      universe: SIGNAL_CONFIG.scanUniverse,
    });
    const enabled = await getState('auto_scan_enabled', false);
    return NextResponse.json({
      ok: true,
      auto_scan_enabled: !!enabled,
      cursorReset: true,
      msg: 'Auto-scan ON — next cron starts from top of market',
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
