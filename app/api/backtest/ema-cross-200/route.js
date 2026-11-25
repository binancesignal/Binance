import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getKlines, loadExchangeInfo, loadTickers } from '../../../../lib/binance/client.js';
import { findCrossTouches, normalizeEcConfig, advanceOffset, EC_TFS } from '../../../../lib/scanner/strategy/emaCross200/index.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const maxDuration = 60;

const KLINES = 1000; // enough for EMA200 + 300+ bars of history
const POOL = 2; // gentle: 2 coins in parallel
const GAP_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, worker, size = POOL) {
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
      await sleep(GAP_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

/**
 * POST { timeframes:['15m','1h'], offset:0, limit:8, symbol?:'BTCUSDT',
 *        direction:'BOTH'|'UP'|'DOWN', touchTolerancePct:0, maxAgeBars:300, maxPerCoin:6, forwardBars:20 }
 * Scans one SLICE of ALL USDT-perp coins (highest 24h volume first) for
 *   "EMA20/50 cross where the candle on the cross line touched the same-timeframe EMA200".
 * The client calls it repeatedly (offset → nextOffset) so the scan is chunked and API-ban friendly.
 */
export async function POST(request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const tfs = [...new Set((Array.isArray(body.timeframes) ? body.timeframes : []).filter((t) => EC_TFS.includes(t)))];
  if (!tfs.length) return NextResponse.json({ error: 'Pick at least one time frame' }, { status: 400 });

  const offset = Math.max(0, Math.round(+body.offset) || 0);
  const limit = Math.min(12, Math.max(1, Math.round(+body.limit) || 6));
  const onlySymbol = String(body.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cfg = normalizeEcConfig(body);

  try {
    const [symbols, tickers] = await Promise.all([loadExchangeInfo(), loadTickers()]);
    let ranked;
    if (onlySymbol) {
      if (!symbols.includes(onlySymbol)) {
        return NextResponse.json({ error: `Unknown symbol: ${onlySymbol}` }, { status: 404 });
      }
      ranked = [onlySymbol];
    } else {
      // ALL coins, most liquid first
      ranked = Object.entries(tickers)
        .filter(([s]) => symbols.includes(s))
        .sort((a, b) => b[1].volume - a[1].volume)
        .map((e) => e[0]);
    }
    const slice = onlySymbol ? ranked : ranked.slice(offset, offset + limit);

    const events = [];
    const errors = [];
    let banned = false;
    let throttled = false;
    const doneIdx = new Array(slice.length).fill(false);

    await pool(slice, async (symbol, idx) => {
      for (const tf of tfs) {
        if (banned || throttled) return;
        try {
          const candles = await getKlines(symbol, tf, KLINES);
          // the last candle may still be forming → only CLOSED candles
          const closed = candles.length > 1 ? candles.slice(0, -1) : candles;
          for (const e of findCrossTouches(closed, cfg)) events.push({ symbol, tf, ...e });
        } catch (e) {
          if (e?.banned) banned = true;
          else if (e?.throttled) throttled = true;
          else errors.push(`${symbol} ${tf}: ${String(e.message || e).slice(0, 80)}`);
          if (banned || throttled) return;
        }
      }
      doneIdx[idx] = true;
    });

    // Only advance over the leading coins that were FULLY handled; a coin that hit the rate guard is retried.
    // (The client de-duplicates events by symbol|tf|time, so a retried coin never shows twice.)
    const advance = advanceOffset(doneIdx, banned || throttled);
    const nextOffset = offset + advance;
    return NextResponse.json(
      {
        ok: true,
        total: ranked.length,
        offset,
        nextOffset,
        done: onlySymbol ? true : banned ? false : nextOffset >= ranked.length && !throttled,
        banned,
        throttled,
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
