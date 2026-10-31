import { NextResponse } from 'next/server';
import { getKlines } from '../../../../lib/exchange/index.js';
import { scanObFibSymbol } from '../../../../lib/scanner/strategy/obFib/scanSymbol.js';
import { normalizeObFibConfig, OB_FIB_DEFAULTS, OB_FIB_REF_TFS, OB_FIB_TFS } from '../../../../lib/scanner/strategy/obFib/config.js';
import { getState } from '../../../../lib/database/appState.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// tiny in-memory limiter (per warm instance) so one visitor can't hammer the exchange API
const hits = new Map();
function limited(key, max = 12, windowMs = 60_000) {
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

/**
 * POST /api/scan/symbol
 * Body: { symbol: "LTC" | "LTCUSDT", refTimeframes?: ["1w","1M","3M","1Y","1d"], timeframes?: ["15m","1h", ...] }
 *
 * Open to every signed-in/anonymous visitor of the app. Runs OB + HTF Fib for ONE coin:
 * every selected HTF draws its own Fib and is checked against every selected LTF.
 * Response: groups[] (per HTF → per LTF rows, with signals) + flat signals[].
 */
export async function POST(request) {
  try {
    const ip = (request.headers?.get?.('x-forwarded-for') || 'local').split(',')[0].trim();
    if (limited(ip)) {
      return NextResponse.json({ error: 'Too many scans — wait a minute and try again.' }, { status: 429 });
    }

    const body = await request.json().catch(() => ({}));
    const symbol = cleanSymbol(body.symbol || body.coin);
    if (!symbol || symbol.length < 5) {
      return NextResponse.json({ error: 'symbol required, e.g. LTC or LTCUSDT' }, { status: 400 });
    }

    let cfg = normalizeObFibConfig(OB_FIB_DEFAULTS);
    try {
      const saved = await getState('ob_fib_config', null);
      if (saved) cfg = normalizeObFibConfig(saved);
    } catch (_) {}
    if (!cfg.enabled) {
      return NextResponse.json({ error: 'OB + Fib scan is disabled by the admin' }, { status: 400 });
    }

    const result = await scanObFibSymbol({
      symbol,
      getKlines,
      config: cfg,
      refTimeframes: Array.isArray(body.refTimeframes) ? body.refTimeframes : undefined,
      timeframes: Array.isArray(body.timeframes) ? body.timeframes : undefined,
      fibLevels: Array.isArray(body.fibLevels) ? body.fibLevels : undefined,
    });

    return NextResponse.json({
      ok: true,
      ...result,
      signalCount: result.signals.length,
      availableRefTimeframes: OB_FIB_REF_TFS,
      availableTimeframes: OB_FIB_TFS,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.status || 500 });
  }
}

export async function GET(request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get('symbol') || url.searchParams.get('coin');
  if (!symbol) {
    return NextResponse.json({
      usage: 'POST { "symbol": "LTC", "refTimeframes": ["1w","1M","3M","1Y"], "timeframes": ["15m","1h"], "fibLevels": [0.618, 0.786] }',
      refTimeframes: OB_FIB_REF_TFS,
      timeframes: OB_FIB_TFS,
    });
  }
  const list = (k) => (url.searchParams.get(k) || '').split(',').map((x) => x.trim()).filter(Boolean);
  return POST({
    json: async () => ({
      symbol,
      refTimeframes: list('ref').length ? list('ref') : undefined,
      timeframes: list('tf').length ? list('tf') : undefined,
    }),
    headers: request.headers,
  });
}
