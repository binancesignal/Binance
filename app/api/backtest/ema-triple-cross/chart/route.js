import { NextResponse } from 'next/server';
import { getSession } from '../../../../../lib/auth/session.js';
import { getKlines } from '../../../../../lib/binance/client.js';
import {
  computeEmas,
  findTripleCrosses,
  buildTripleChartSvg,
  normalizeTripleConfig,
  TRIPLE_TFS,
} from '../../../../../lib/scanner/strategy/emaTripleCross/index.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const maxDuration = 30;

/**
 * GET ?symbol=ETHUSDT&tf=1h&time=1790000000&windowBars=5&mode=fast&tz=330
 * → SVG chart (candles + EMA 20/50/200) of that historical triple cross.
 * `tz` = viewer's UTC offset in minutes (e.g. 330 for Sri Lanka) so labels show local time.
 */
export async function GET(request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const sp = new URL(request.url).searchParams;
  const symbol = String(sp.get('symbol') || '').toUpperCase();
  const tf = String(sp.get('tf') || '');
  const time = +sp.get('time');
  if (!/^[A-Z0-9]{3,20}$/.test(symbol) || !TRIPLE_TFS.includes(tf) || !Number.isFinite(time)) {
    return NextResponse.json({ error: 'symbol, tf and time are required' }, { status: 400 });
  }
  const tzMin = Math.max(-840, Math.min(840, Math.round(+sp.get('tz')) || 0));
  const cfg = normalizeTripleConfig({
    windowBars: sp.get('windowBars'),
    mode: sp.get('mode'),
    forwardBars: sp.get('forwardBars'),
    requireAbcd: sp.get('requireAbcd'),
    direction: 'BOTH',
  });
  // When drawing a known event, always attach AB=CD if present (even if filter was off during scan)
  const cfgForFind = { ...cfg, requireAbcd: false };

  try {
    const candles = await getKlines(symbol, tf, 1000);
    const emas = computeEmas(candles, cfgForFind);
    const ev = findTripleCrosses(candles, cfgForFind, emas).find((e) => e.time === time);
    if (!ev) {
      return NextResponse.json({ error: 'That event is no longer inside the fetched candles.' }, { status: 404 });
    }
    const svg = buildTripleChartSvg(candles, ev, emas, { symbol, tf, tzMin });
    if (!svg) return NextResponse.json({ error: 'Not enough candles to draw the chart.' }, { status: 422 });
    return new NextResponse(svg, {
      headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
