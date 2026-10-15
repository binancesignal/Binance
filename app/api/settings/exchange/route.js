import { NextResponse } from 'next/server';
import { getState, setState } from '../../../../lib/database/appState.js';
import { SIGNAL_CONFIG } from '../../../../lib/config/signalConfig.js';
import { clearKlineCache } from '../../../../lib/exchange/index.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const stored = await getState('active_exchange', null);
    const exchange =
      stored === 'bybit' || stored === 'binance'
        ? stored
        : SIGNAL_CONFIG.defaultExchange || 'binance';
    return NextResponse.json({
      ok: true,
      exchange,
      available: ['binance', 'bybit'],
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** Body: { exchange: 'binance' | 'bybit' } */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const ex = String(body.exchange || '').toLowerCase();
    if (ex !== 'binance' && ex !== 'bybit') {
      return NextResponse.json(
        { error: 'exchange must be binance or bybit' },
        { status: 400 }
      );
    }
    await setState('active_exchange', ex);
    try {
      await clearKlineCache();
    } catch (_) {}
    return NextResponse.json({
      ok: true,
      exchange: ex,
      msg: `Active exchange → ${ex.toUpperCase()}. Scans now use ${ex} markets.`,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
