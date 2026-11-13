import { NextResponse } from 'next/server';
import { requireSkAccess } from '../../../../lib/skSystem/access.js';
import { getKlines } from '../../../../lib/exchange/index.js';
import { SK_ALL_TFS, TF_SEC } from '../../../../lib/skSystem/config.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// tiny per-instance cache so many viewers / timeframe switches never re-download the same candles
const cache = new Map();
const TTL = { '5m': 8, '15m': 15, '30m': 30, '1h': 45, '2h': 60, '4h': 90, '1d': 180, '1w': 600 };
function cached(key, tf) {
  const c = cache.get(key);
  return c && Date.now() < c.exp ? c.data : null;
}
function put(key, tf, data) {
  cache.set(key, { data, exp: Date.now() + (TTL[tf] || 30) * 1000 });
  if (cache.size > 400) for (const [k, v] of cache) if (Date.now() > v.exp) cache.delete(k);
}
const slim = (c) => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume || 0 });

/**
 * GET /api/sk-system/candles?symbol=BTCUSDT&tf=1h[&limit=500][&since=<unix>][&around=<unix>]
 *   real exchange candles (the last one is the live forming candle)
 *   since  → incremental update: only candles with time ≥ since (chart merges them)
 *   around → historical window around a setup time (old setups open on their own period)
 */
export async function GET(request) {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  try {
    const q = new URL(request.url).searchParams;
    const symbol = String(q.get('symbol') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const tf = q.get('tf');
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol) || !SK_ALL_TFS.includes(tf)) return NextResponse.json({ error: 'symbol / tf required' }, { status: 400 });
    const limit = Math.min(1000, Math.max(20, Math.round(+q.get('limit')) || 500));
    const since = Math.round(+q.get('since')) || 0;
    const around = Math.round(+q.get('around')) || 0;
    const sec = TF_SEC[tf];

    if (since) {
      const key = `${symbol}|${tf}|inc`;
      let data = cached(key, tf);
      if (!data) {
        data = await getKlines(symbol, tf, 6, { includeForming: true });
        put(key, tf, data);
      }
      return NextResponse.json({ ok: true, symbol, tf, incremental: true, candles: data.filter((c) => c.time >= since).map(slim) });
    }
    const opts = { includeForming: true };
    let key = `${symbol}|${tf}|${limit}`;
    if (around) {
      const nowS = Math.floor(Date.now() / 1000);
      opts.startTime = Math.max(0, (around - 350 * sec)) * 1000;
      opts.endTime = Math.min(nowS, around + 650 * sec) * 1000;
      key += `|a${Math.floor(around / sec)}`;
    }
    let data = cached(key, tf);
    if (!data) {
      data = await getKlines(symbol, tf, limit, opts);
      put(key, tf, data);
    }
    if (!data?.length) return NextResponse.json({ error: `no candles for ${symbol} ${tf}` }, { status: 404 });
    return NextResponse.json({ ok: true, symbol, tf, candles: data.map(slim) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.banned || e.throttled ? 429 : 500 });
  }
}
