import { NextResponse } from 'next/server';
import { getKlines } from '../../../../lib/exchange/index.js';
import { PATTERNS, PATTERN_IDS, scanCandlePatterns } from '../../../../lib/candles/patterns.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TFS = ['5m', '15m', '30m', '1h', '2h', '4h', '1d'];
const FETCH = 220; // candles per timeframe (chart shows all of them)

const hits = new Map();
function limited(key, max = 20, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 2000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  return arr.length > max;
}

function cleanSymbol(raw) {
  let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  if (!s.endsWith('USDT')) s += 'USDT';
  return s;
}

/** GET → the pattern catalogue (for the UI) */
export async function GET() {
  return NextResponse.json({ patterns: PATTERNS, timeframes: TFS });
}

/**
 * POST /api/scan/candles
 * Body: { symbol, timeframes?: ["15m","1h",…], patterns?: ["hammer",…], requireTrend?: boolean }
 * Response: { symbol, price, scannedAt, groups: [{ tf, candles: [{time,open,high,low,close}], detections: [...] }] }
 */
export async function POST(request) {
  try {
    const ip = (request.headers?.get?.('x-forwarded-for') || 'local').split(',')[0].trim();
    if (limited(ip)) return NextResponse.json({ error: 'Too many scans — wait a minute and try again.' }, { status: 429 });

    const body = await request.json().catch(() => ({}));
    const symbol = cleanSymbol(body.symbol || body.coin);
    if (!symbol || symbol.length < 5) return NextResponse.json({ error: 'Coin එකක් ගහන්න, උදා: BTC' }, { status: 400 });

    const tfs = TFS.filter((t) => Array.isArray(body.timeframes) && body.timeframes.includes(t));
    const timeframes = tfs.length ? tfs : ['15m', '1h', '4h'];
    const patterns = Array.isArray(body.patterns) ? body.patterns.filter((p) => PATTERN_IDS.includes(p)) : PATTERN_IDS;
    if (!patterns.length) return NextResponse.json({ error: 'Pattern එකක් හරි select කරන්න' }, { status: 400 });
    const requireTrend = body.requireTrend !== false;

    const errors = [];
    const groups = await Promise.all(
      timeframes.map(async (tf) => {
        try {
          const raw = await getKlines(symbol, tf, FETCH);
          const candles = (raw || []).map((c) => ({
            time: +c.time,
            open: +c.open,
            high: +c.high,
            low: +c.low,
            close: +c.close,
          }));
          if (candles.length < 20) throw new Error('not enough candles');
          return { tf, candles, detections: scanCandlePatterns(candles, { patterns, requireTrend }) };
        } catch (e) {
          errors.push(`${tf}: ${e.message}`);
          return { tf, candles: [], detections: [], error: e.message };
        }
      })
    );

    if (groups.every((g) => !g.candles.length)) {
      return NextResponse.json({ error: `${symbol} data ගන්න බැරි වුණා (${errors[0] || 'unknown'})` }, { status: 404 });
    }
    const first = groups.find((g) => g.candles.length);
    const price = first.candles[first.candles.length - 1].close;
    return NextResponse.json({ symbol, price, scannedAt: new Date().toISOString(), groups, errors });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Candle scan failed' }, { status: 500 });
  }
}
