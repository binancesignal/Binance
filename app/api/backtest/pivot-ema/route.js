import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getKlines, loadExchangeInfo, loadTickers } from '../../../../lib/binance/client.js';
import { backtestPivotEma, PIVOT_EMA_TFS, PIVOT_EMA_FIXED } from '../../../../lib/scanner/strategy/pivotEma/index.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const maxDuration = 60;

const KLINES = 1000; // candles per coin per TF (backtest depth)
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
 * POST { timeframes:['2h'], universe:100, offset:0, limit:8 }
 * Backtests one SLICE of the universe (top-N by 24h volume) so the admin page can loop
 * through the whole list without hitting the serverless time limit.
 */
export async function POST(request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const tfs = [...new Set((Array.isArray(body.timeframes) ? body.timeframes : []).filter((t) => PIVOT_EMA_TFS.includes(t)))];
  if (!tfs.length) return NextResponse.json({ error: 'Pick at least one time frame' }, { status: 400 });
  const universe = Math.min(300, Math.max(5, Math.round(+body.universe) || 100));
  const offset = Math.max(0, Math.round(+body.offset) || 0);
  // cross↔pivot max distance (allow tight values from 0.05 ATR)
  const maxCrossDist = Math.min(10, Math.max(0.05, +body.maxCrossDist || PIVOT_EMA_FIXED.maxCrossDistATR));
  const slMode = body.slMode === 'pivot' ? 'pivot' : body.slMode === 'cross' ? 'cross' : 'swing';
  const slFromCrossATR = Math.min(3, Math.max(0.1, +body.slFromCrossATR || PIVOT_EMA_FIXED.slFromCrossATR));
  const stopATR = Math.min(5, Math.max(0.2, +body.stopATR || PIVOT_EMA_FIXED.stopATR));
  const targetATR = Math.min(5, Math.max(0.2, +body.targetATR || PIVOT_EMA_FIXED.targetATR));
  const requireNoRecross = body.requireNoRecross === false ? false : true;
  const requireBothSidePivotCross = body.requireBothSidePivotCross === true;
  const rejectChop = body.rejectChop === false ? false : true;
  const maxEmaCrossesInWindow = Math.min(20, Math.max(1, Math.round(+body.maxEmaCrossesInWindow || PIVOT_EMA_FIXED.maxEmaCrossesInWindow || 3)));
  const maxBarsBetweenFirstSecondCross = Math.min(100, Math.max(3, Math.round(+body.maxBarsBetweenFirstSecondCross || PIVOT_EMA_FIXED.maxBarsBetweenFirstSecondCross || 18)));
  const breakMode = body.breakMode === 'close' ? 'close' : 'wick';
  const useLegPatterns = body.useLegPatterns === false ? false : true;
  const breakBeyondATR = Math.min(1, Math.max(0, +body.breakBeyondATR >= 0 ? +body.breakBeyondATR : (PIVOT_EMA_FIXED.breakBeyondATR ?? 0.02)));
  const minRunATR = Math.min(3, Math.max(0, +body.minRunATR >= 0 ? +body.minRunATR : PIVOT_EMA_FIXED.minRunATR));
  const minCrossBarsAgo = Math.min(20, Math.max(0, Math.round(+body.minCrossBarsAgo >= 0 ? +body.minCrossBarsAgo : PIVOT_EMA_FIXED.minCrossBarsAgo)));
  const crossBars = Math.min(48, Math.max(3, Math.round(+body.crossBars || PIVOT_EMA_FIXED.crossBars)));
  const cfg = {
    ...PIVOT_EMA_FIXED,
    maxCrossDistATR: maxCrossDist,
    slMode,
    slFromCrossATR,
    stopATR,
    targetATR,
    requireNoRecross,
    requireBothSidePivotCross,
    rejectChop,
    maxEmaCrossesInWindow,
    maxBarsBetweenFirstSecondCross,
    breakMode,
    breakBeyondATR,
    useLegPatterns,
    minRunATR,
    minCrossBarsAgo,
    crossBars,
  };
  const limit = Math.min(15, Math.max(1, Math.round(+body.limit) || 8));
  // optional single-coin check: { symbol: 'JCTUSDT' } — skips universe scan
  const onlySymbol = String(body.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

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
    const baseline = {};
    const errors = [];
    let banned = false;
    let touches = 0;

    await pool(slice, async (symbol) => {
      for (const tf of tfs) {
        if (banned) return;
        try {
          const candles = await getKlines(symbol, tf, KLINES);
          const bt = backtestPivotEma(candles, tf, cfg);
          touches += bt.totalTouches;
          for (const e of bt.events) events.push({ symbol, tf, ...e });
          const b = (baseline[tf] ||= { total: 0, win: 0, loss: 0, timeout: 0, open: 0 });
          b.total += bt.baselineTally.total;
          b.win += bt.baselineTally.win;
          b.loss += bt.baselineTally.loss;
          b.timeout += bt.baselineTally.timeout;
          b.open += bt.baselineTally.open;
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
        touches,
        events,
        baseline,
        errors,
        cfg: { maxCrossDistATR: maxCrossDist, slMode, slFromCrossATR, stopATR, targetATR, requireNoRecross, minRunATR, minCrossBarsAgo, crossBars },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
