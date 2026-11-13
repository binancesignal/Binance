import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getKlines, loadExchangeInfo, loadTickers } from '../../../../lib/binance/client.js';
import {
  backtestEma2,
  normalizeEma2Config,
  EMA2_TFS,
  computeEmas,
  buildEma2ChartSvg,
} from '../../../../lib/scanner/strategy/ema2/index.js';

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
 * POST {
 *   timeframes: ['15m','1h'], universe:100, offset:0, limit:8,
 *   symbol?: 'BTCUSDT',
 *   windowBars, mode, direction, forwardBars, maxTouchBars, requireApproachSide
 * }
 * Optional chart request: { chart: true, symbol, tf, eventIndex } or include charts for returned events.
 */
export async function POST(request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const tfs = [...new Set((Array.isArray(body.timeframes) ? body.timeframes : []).filter((t) => EMA2_TFS.includes(t)))];
  if (!tfs.length) return NextResponse.json({ error: 'Pick at least one time frame' }, { status: 400 });

  const universe = Math.min(300, Math.max(5, Math.round(+body.universe) || 100));
  const offset = Math.max(0, Math.round(+body.offset) || 0);
  const limit = Math.min(15, Math.max(1, Math.round(+body.limit) || 8));
  const onlySymbol = String(body.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cfg = normalizeEma2Config(body);
  const wantChart = !!body.chart;
  const tzMin = Number.isFinite(+body.tzMin) ? +body.tzMin : -new Date().getTimezoneOffset();

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
          const bt = backtestEma2(candles, cfg);
          const emas = computeEmas(candles, cfg);
          for (const e of bt.events) {
            const row = { symbol, tf, ...e };
            if (wantChart || body.includeCharts) {
              try {
                row.chartSvg = buildEma2ChartSvg(candles, e, emas, {
                  symbol,
                  tf,
                  tzMin,
                  before: 90,
                  after: 45,
                });
              } catch (_) {
                row.chartSvg = null;
              }
            }
            events.push(row);
          }
        } catch (err) {
          if (err?.banned) banned = true;
          errors.push(`${symbol} ${tf}: ${err.message || String(err)}`);
        }
      }
    });

    const nextOffset = offset + limit;
    const done = onlySymbol || nextOffset >= ranked.length;

    return NextResponse.json({
      events,
      errors,
      total: ranked.length,
      nextOffset: done ? ranked.length : nextOffset,
      done,
      banned,
      cfg,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message || String(e) }, { status: 500 });
  }
}
