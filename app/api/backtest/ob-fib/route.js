import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getKlines, loadExchangeInfo, loadTickers } from '../../../../lib/binance/client.js';
import {
  backtestObFib,
  normalizeObFibConfig,
} from '../../../../lib/scanner/strategy/obFib/index.js';
import { OB_FIB_REF_TFS, OB_FIB_TFS } from '../../../../lib/scanner/strategy/obFib/config.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const maxDuration = 60;

const KLINES_LTF = 1000;
const POOL = 3;

function refLimit(refTf) {
  return refTf === '1Y' || refTf === '3M' ? 36 : 24;
}

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
 * POST {
 *   timeframes: ['15m','1h'],
 *   refTimeframes: ['1w','1M'],
 *   universe: 50, offset: 0, limit: 5,
 *   symbol?: 'BTCUSDT',
 *   maxBars: 80,
 *   direction?: 'BOTH'|'LONG'|'SHORT',
 *   ...ob_fib config overrides
 * }
 */
export async function POST(request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // allow any logged-in user (Signals tab backtest)

  const body = await request.json().catch(() => ({}));
  const tfs = [...new Set((Array.isArray(body.timeframes) ? body.timeframes : []).filter((t) => OB_FIB_TFS.includes(t)))];
  const refTfs = [...new Set((Array.isArray(body.refTimeframes) ? body.refTimeframes : ['1w']).filter((t) => OB_FIB_REF_TFS.includes(t)))];
  if (!tfs.length) return NextResponse.json({ error: 'Pick at least one LTF' }, { status: 400 });
  if (!refTfs.length) return NextResponse.json({ error: 'Pick at least one Fib TF' }, { status: 400 });

  const universe = Math.min(200, Math.max(5, Math.round(+body.universe) || 50));
  const offset = Math.max(0, Math.round(+body.offset) || 0);
  const limit = Math.min(10, Math.max(1, Math.round(+body.limit) || 5));
  const onlySymbol = String(body.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const maxBars = Math.min(200, Math.max(10, Math.round(+body.maxBars) || 80));
  const direction = ['LONG', 'SHORT', 'BOTH'].includes(body.direction) ? body.direction : 'BOTH';

  const cfg = normalizeObFibConfig({
    ...body,
    timeframes: tfs,
    refTimeframes: refTfs,
    allowLong: direction !== 'SHORT',
    allowShort: direction !== 'LONG',
    // entry from OB zone mid; SL just beyond the band (defaults already do this)
    entryMode: body.entryMode === 'fib' ? 'fib' : 'mid',
  });

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

    // cache HTF candles per symbol
    await pool(slice, async (symbol) => {
      if (banned) return;
      const refCandles = {};
      try {
        await Promise.all(
          refTfs.map(async (refTf) => {
            try {
              refCandles[refTf] = await getKlines(symbol, refTf, refLimit(refTf));
            } catch (e) {
              if (e?.banned) banned = true;
              errors.push(`${symbol} ${refTf}: ${e.message}`);
              refCandles[refTf] = null;
            }
          })
        );
      } catch (e) {
        if (e?.banned) banned = true;
        errors.push(`${symbol} ref: ${e.message}`);
        return;
      }

      for (const tf of tfs) {
        if (banned) return;
        try {
          const candles = await getKlines(symbol, tf, KLINES_LTF);
          for (const refTf of refTfs) {
            const weekly = refCandles[refTf];
            if (!weekly?.length) continue;
            const bt = backtestObFib({
              candles,
              weeklyCandles: weekly,
              refTf,
              tf,
              config: cfg,
              maxBars,
              entryFromOb: true,
            });
            for (const e of bt.events) {
              events.push({ symbol, ...e });
            }
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
        cfg: {
          timeframes: tfs,
          refTimeframes: refTfs,
          maxBars,
          direction,
          entryMode: cfg.entryMode,
          slBufferATR: cfg.slBufferATR,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
