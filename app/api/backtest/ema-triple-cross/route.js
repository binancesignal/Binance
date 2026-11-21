import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getKlines, loadExchangeInfo, loadTickers } from '../../../../lib/binance/client.js';
import {
  backtestTripleCross,
  normalizeTripleConfig,
  TRIPLE_TFS,
} from '../../../../lib/scanner/strategy/emaTripleCross/index.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const maxDuration = 60;

const KLINES = 1000;
const POOL = 4;

async function pool(items, worker, size = POOL) {
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

/**
 * POST { timeframes:['15m','1h'], universe:100, offset:0, limit:8, symbol?:'BTCUSDT',
 *        windowBars:5, mode:'fast'|'all3'|'any2', direction:'BOTH'|'UP'|'DOWN', forwardBars:20 }
 * Scans one SLICE of the universe (top-N by 24h volume) for EMA 20/50/200 triple crosses.
 */
export async function POST(request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const tfs = [...new Set((Array.isArray(body.timeframes) ? body.timeframes : []).filter((t) => TRIPLE_TFS.includes(t)))];
  if (!tfs.length) return NextResponse.json({ error: 'Pick at least one time frame' }, { status: 400 });

  const universe = Math.min(300, Math.max(5, Math.round(+body.universe) || 100));
  const offset = Math.max(0, Math.round(+body.offset) || 0);
  const limit = Math.min(15, Math.max(1, Math.round(+body.limit) || 8));
  const onlySymbol = String(body.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cfg = normalizeTripleConfig(body);

  try {
    const [symbols, tickers] = await Promise.all([loadExchangeInfo(), loadTickers()]);
    let ranked;
    if (onlySymbol) {
      if (!symbols.includes(onlySymbol)) {
        return NextResponse.json({ error: `Unknown symbol: ${onlySymbol}` }, { status: 404 });
      }
      ranked = [onlySymbol];
    } else {
      ranked = Object.entries(tickers)
        .filter(([s]) => symbols.includes(s))
        .sort((a, b) => b[1].volume - a[1].volume)
        .map((e) => e[0])
        .slice(0, universe);
    }
    const slice = onlySymbol ? ranked : ranked.slice(offset, offset + limit);

    const events = [];
    const errors = [];
    let banned = false;

    await pool(slice, async (symbol) => {
      for (const tf of tfs) {
        if (banned) return;
        try {
          const candles = await getKlines(symbol, tf, KLINES);
          const bt = backtestTripleCross(candles, cfg);
          for (const e of bt.events) {
            events.push({ symbol, tf, ...e });
          }
        } catch (e) {
          if (e?.banned) banned = true;
          errors.push(`${symbol} ${tf}: ${e.message}`);
        }
      }
    });

    const nextOffset = offset + slice.length;
    return NextResponse.json(
      {
        ok: true,
        total: ranked.length,
        offset,
        nextOffset,
        done: onlySymbol ? true : banned ? false : nextOffset >= ranked.length,
        banned,
        symbols: slice,
        symbol: onlySymbol || null,
        events,
        errors,
        cfg,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
