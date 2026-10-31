import { NextResponse } from 'next/server';
import { getSession } from '../../../../../lib/auth/session.js';
import { getKlines } from '../../../../../lib/binance/client.js';
import { buildChartSvg } from '../../../../../lib/telegram/chartSvg.js';
import { findPivotTouches, buildPivotChartSignal, PIVOT_EMA_TFS, PIVOT_EMA_FIXED } from '../../../../../lib/scanner/strategy/pivotEma/index.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const maxDuration = 30;

/** GET ?symbol=ETHUSDT&tf=2h&time=1790000000  → SVG chart of that historical pivot touch */
export async function GET(request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const sp = new URL(request.url).searchParams;
  const symbol = String(sp.get('symbol') || '').toUpperCase();
  const tf = String(sp.get('tf') || '');
  const time = +sp.get('time');
  if (!/^[A-Z0-9]{3,20}$/.test(symbol) || !PIVOT_EMA_TFS.includes(tf) || !Number.isFinite(time)) {
    return NextResponse.json({ error: 'symbol, tf and time are required' }, { status: 400 });
  }

  // optional SL overrides so the chart matches the backtest settings the admin just used
  const slMode = sp.get('slMode') === 'pivot' ? 'pivot' : (sp.get('slMode') === 'cross' ? 'cross' : PIVOT_EMA_FIXED.slMode);
  const slFromCrossATR = Math.min(3, Math.max(0.1, +(sp.get('slFromCrossATR') || PIVOT_EMA_FIXED.slFromCrossATR)));
  const stopATR = Math.min(5, Math.max(0.2, +(sp.get('stopATR') || PIVOT_EMA_FIXED.stopATR)));
  const targetATR = Math.min(5, Math.max(0.2, +(sp.get('targetATR') || PIVOT_EMA_FIXED.targetATR)));
  const cfg = { ...PIVOT_EMA_FIXED, slMode, slFromCrossATR, stopATR, targetATR };

  try {
    const candles = await getKlines(symbol, tf, 1000);
    const ev = findPivotTouches(candles, tf, cfg).find((e) => e.time === time);
    if (!ev) {
      return NextResponse.json({ error: 'That touch is no longer inside the fetched candles.' }, { status: 404 });
    }
    // show the touch with up to 40 bars of what happened afterwards
    const end = Math.min(candles.length - 1, ev.index + 40);
    const slice = candles.slice(0, end + 1);
    const signal = buildPivotChartSignal(symbol, tf, slice, ev, cfg);
    const built = buildChartSvg(signal, slice, { tf, htf: tf, visible: 100 });
    if (!built?.svg) return NextResponse.json({ error: 'Not enough candles to draw the chart.' }, { status: 422 });
    return new NextResponse(built.svg, {
      headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
