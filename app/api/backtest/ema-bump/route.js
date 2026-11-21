import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getKlines, loadExchangeInfo, loadTickers } from '../../../../lib/binance/client.js';
import {
  backtestEmaBump,
  normalizeEmaBumpConfig,
  ALL_TFS,
  EMA_BUMP_DEFAULTS,
} from '../../../../lib/scanner/strategy/emaBump/index.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const maxDuration = 60;

const KLINES = 1000;
const POOL = 4;

async function pool(items, worker, size = POOL) {
  const out = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return out;
}

/**
 * POST {
 *   timeframes: ['15m'],
 *   universe: 100,
 *   offset: 0,
 *   limit: 8,
 *   symbol?: 'BTCUSDT',
 *   // optional emaBump config overrides:
 *   requirePriorSlowCross, minScore, allowLong, allowShort, ...
 * }
 */
export async function POST(request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const tfs = [...new Set((Array.isArray(body.timeframes) ? body.timeframes : []).filter((t) => ALL_TFS.includes(t)))];
  if (!tfs.length) return NextResponse.json({ error: 'Pick at least one time frame' }, { status: 400 });

  const universe = Math.min(300, Math.max(5, Math.round(+body.universe) || 100));
  const offset = Math.max(0, Math.round(+body.offset) || 0);
  const limit = Math.min(15, Math.max(1, Math.round(+body.limit) || 8));
  const onlySymbol = String(body.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // Build config from body overrides + defaults
  const cfg = normalizeEmaBumpConfig({
    ...EMA_BUMP_DEFAULTS,
    timeframes: tfs,
    enabled: true,
    requirePriorSlowCross: body.requirePriorSlowCross === true,
    priorSlowCrossMaxBars: body.priorSlowCrossMaxBars,
    priorSlowCrossMaxLevelATR: body.priorSlowCrossMaxLevelATR,
    useHarmonicEntry: body.useHarmonicEntry === true,
    requireHarmonic: body.requireHarmonic === true,
    harmonicBcMin: body.harmonicBcMin,
    harmonicBcMax: body.harmonicBcMax,
    harmonicXLookback: body.harmonicXLookback,
    harmonicPatterns: body.harmonicPatterns,
    allowLong: body.allowLong !== false,
    allowShort: body.allowShort !== false,
    minScore: body.minScore,
    minDepthATR: body.minDepthATR,
    maxTouchAgeBars: body.maxTouchAgeBars,
    maxTopAgeBars: body.maxTopAgeBars,
    minBumpATR: body.minBumpATR,
    maxBumpATR: body.maxBumpATR,
    tp1R: body.tp1R,
    minRR: body.minRR,
    allowRecentCross: body.allowRecentCross !== false,
    // gates off for pure structural backtest (score/gates filter live only)
    gateModes: Object.fromEntries(
      (body.gateModes && typeof body.gateModes === 'object'
        ? Object.entries(body.gateModes)
        : []
      )
    ),
  });
  // Soften gates for backtest unless admin explicitly set them
  if (!body.gateModes) {
    cfg.gateModes = {};
    cfg.minScore = 0; // structural setups only; score filter not applied in backtest path
  }

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
    let setups = 0;

    await pool(slice, async (symbol) => {
      for (const tf of tfs) {
        if (banned) return;
        try {
          const candles = await getKlines(symbol, tf, KLINES);
          const bt = backtestEmaBump(candles, tf, cfg);
          setups += bt.events.length;
          for (const e of bt.events) events.push({ symbol, tf, ...e });
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
        setups,
        events,
        errors,
        cfg: {
          requirePriorSlowCross: cfg.requirePriorSlowCross,
          priorSlowCrossMaxBars: cfg.priorSlowCrossMaxBars,
          priorSlowCrossMaxLevelATR: cfg.priorSlowCrossMaxLevelATR,
          allowLong: cfg.allowLong,
          allowShort: cfg.allowShort,
          tp1R: cfg.tp1R,
          minDepthATR: cfg.minDepthATR,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
