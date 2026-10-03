import { NextResponse } from 'next/server';
import { getKlines, loadTickers } from '../../../lib/exchange/index.js';
import { scoreSetup } from '../../../lib/scanner/scoreSetup.js';
import { calcATR } from '../../../lib/scanner/indicators.js';
import { SIGNAL_CONFIG } from '../../../lib/config/signalConfig.js';
import { generateSignalChartImage } from '../../../lib/telegram/chart.js';
import { buildChartSvg } from '../../../lib/telegram/chartSvg.js';
import { sendReadyNotification } from '../../../lib/telegram/telegram.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function normalizeSymbol(raw) {
  if (!raw) return null;
  let s = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  if (!s.endsWith('USDT')) s += 'USDT';
  return s;
}

/**
 * GET /api/chart?symbol=BTC
 *   → PNG of the analysis chart exactly as Telegram gets it
 *     (uses the best setup for that coin right now, even if below min score)
 * Optional:
 *   &dir=LONG|SHORT   pick the best setup in that direction
 *   &send=1           also send it to Telegram (same message as LIMIT ORDER READY)
 *   &format=svg       return the raw SVG (debug)
 */
export async function GET(request) {
  const url = new URL(request.url);
  const symbol = normalizeSymbol(url.searchParams.get('symbol'));
  const dirWanted = (url.searchParams.get('dir') || '').toUpperCase();
  if (!symbol) {
    return NextResponse.json(
      { error: 'Pass a coin, e.g. /api/chart?symbol=BTC' },
      { status: 400 }
    );
  }

  try {
    const htf = SIGNAL_CONFIG.htf;
    const obtf = SIGNAL_CONFIG.obTf;
    const [htfC, obC, c5, tick] = await Promise.all([
      getKlines(symbol, htf, SIGNAL_CONFIG.htfKlineLimit || 80),
      getKlines(symbol, obtf, SIGNAL_CONFIG.obKlineLimit || 100),
      getKlines(symbol, '5m', SIGNAL_CONFIG.atrKlineLimit || 30),
      loadTickers(),
    ]);
    const price = +tick?.[symbol]?.price || obC[obC.length - 1]?.close;
    if (!obC?.length || !price) {
      return NextResponse.json({ error: `No market data for ${symbol}` }, { status: 404 });
    }

    const results = scoreSetup(
      symbol,
      htfC,
      obC,
      SIGNAL_CONFIG.entryStyle,
      0,
      price,
      { includeAll: true }
    )
      .filter((r) => !dirWanted || r.dir === dirWanted)
      .sort((a, b) => b.score - a.score);

    const r = results[0];
    if (!r) {
      return NextResponse.json(
        { error: `${symbol}: no order-block setup found right now${dirWanted ? ` (${dirWanted})` : ''}.` },
        { status: 404 }
      );
    }

    const atr5m = calcATR(c5, 14);
    const distAbs = Math.abs(price - r.entry);
    const signal = {
      signal_id: `preview_${symbol}`,
      symbol,
      direction: r.dir,
      status: 'PREVIEW',
      score: r.score,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      tp2: r.tp2,
      tp3: r.tp3,
      rr: r.rr,
      current_price: price,
      price,
      conf: r.conf,
      structure: r.structure,
      pd: r.pd,
      rvol: r.rvol,
      fvgs: r.fvgs,
      liq: r.liq,
      ob_low: r.ob?.low,
      ob_high: r.ob?.high,
      atr_5m: atr5m,
      distance_to_entry: distAbs,
      distance_percent: (distAbs / price) * 100,
      atr_distance: atr5m > 0 ? distAbs / atr5m : null,
      metadata: {
        conf: r.conf,
        structure: r.structure,
        ob: r.ob,
        pd: r.pd,
        rvol: r.rvol,
        fvgs: r.fvgs,
        liq: r.liq,
        htf,
        obTf: obtf,
        entryStyle: SIGNAL_CONFIG.entryStyle,
      },
    };

    if (url.searchParams.get('format') === 'svg') {
      const built = buildChartSvg(signal, obC, { tf: obtf, htf, visible: 60 });
      return new NextResponse(built?.svg || '', {
        headers: { 'Content-Type': 'image/svg+xml' },
      });
    }

    if (url.searchParams.get('send') === '1') {
      const sent = await sendReadyNotification(signal);
      return NextResponse.json({ ok: !!sent?.ok, sent });
    }

    const png = await generateSignalChartImage(signal, obC);
    if (!png) {
      return NextResponse.json(
        { error: 'Chart render failed — check the server log for "[chart] failed". Try &format=svg to see if the drawing itself works.' },
        { status: 500 }
      );
    }
    return new NextResponse(png, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
