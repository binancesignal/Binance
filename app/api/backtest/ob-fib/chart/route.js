import { NextResponse } from 'next/server';
import { getSession } from '../../../../../lib/auth/session.js';
import { getKlines } from '../../../../../lib/binance/client.js';
import {
  findObFibEvents,
  buildObFibChartSvg,
  normalizeObFibConfig,
} from '../../../../../lib/scanner/strategy/obFib/index.js';
import { OB_FIB_REF_TFS, OB_FIB_TFS } from '../../../../../lib/scanner/strategy/obFib/config.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const maxDuration = 30;

function refLimit(refTf) {
  return refTf === '1Y' || refTf === '3M' ? 36 : 24;
}

/**
 * GET ?symbol=LTCUSDT&tf=30m&refTf=1w&time=1730000000&tz=330
 * → SVG of that historical OB+Fib trade (OB zone + entry/SL/TP1).
 */
export async function GET(request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = new URL(request.url).searchParams;
  const symbol = String(sp.get('symbol') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tf = String(sp.get('tf') || '');
  const refTf = String(sp.get('refTf') || '1w');
  const time = +sp.get('time');
  if (!/^[A-Z0-9]{3,20}$/.test(symbol) || !OB_FIB_TFS.includes(tf) || !OB_FIB_REF_TFS.includes(refTf) || !Number.isFinite(time)) {
    return NextResponse.json({ error: 'symbol, tf, refTf and time are required' }, { status: 400 });
  }
  const tzMin = Math.max(-840, Math.min(840, Math.round(+sp.get('tz')) || 0));
  const maxBars = Math.min(200, Math.max(10, Math.round(+sp.get('maxBars')) || 80));
  const cfg = normalizeObFibConfig({
    entryMode: sp.get('entryMode') === 'fib' ? 'fib' : 'mid',
    timeframes: [tf],
    refTimeframes: [refTf],
  });

  try {
    const [candles, weekly] = await Promise.all([
      getKlines(symbol, tf, 1000),
      getKlines(symbol, refTf, refLimit(refTf)),
    ]);
    const events = findObFibEvents({
      candles,
      weeklyCandles: weekly,
      refTf,
      tf,
      config: cfg,
      maxBars,
      entryFromOb: true,
    });
    const ev = events.find((e) => +e.time === time);
    if (!ev) {
      return NextResponse.json({ error: 'That trade is no longer inside the fetched candles.' }, { status: 404 });
    }
    const svg = buildObFibChartSvg(candles, { ...ev, symbol }, { symbol, tf, tzMin });
    if (!svg) return NextResponse.json({ error: 'Not enough candles to draw the chart.' }, { status: 422 });
    return new NextResponse(svg, {
      headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
