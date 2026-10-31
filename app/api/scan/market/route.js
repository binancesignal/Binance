import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getKlines, loadExchangeInfo, loadTickers } from '../../../../lib/binance/client.js';
import { calcATR } from '../../../../lib/scanner/indicators.js';
import { scanObFibCore } from '../../../../lib/scanner/strategy/obFib/scanSymbol.js';
import { createRefCache } from '../../../../lib/scanner/strategy/obFib/refCache.js';
import { normalizeObFibConfig, OB_FIB_DEFAULTS } from '../../../../lib/scanner/strategy/obFib/config.js';
import { getState, setState } from '../../../../lib/database/appState.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const maxDuration = 60;

const POOL = 3;
const MAX_LIMIT = 12;
const REF_CACHE_KEY = 'ob_fib_ref_cache:binance';

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
 * POST /api/scan/market   (logged-in users)
 * Scans a slice of ALL Binance USDT perpetuals (highest 24h volume first) with the OB + HTF Fib logic:
 * every selected Fib TF draws its own Fib, checked against every selected LTF, only for the selected fib lines.
 *
 * Body: { refTimeframes?, timeframes?, fibLevels?, offset = 0, limit = 8, symbols?, total? }
 * Resp: { total, offset, nextOffset, done, scanned, signals[], errors[], throttled?, banned? }
 * The client calls it repeatedly (offset → nextOffset) until done.
 */
export async function POST(request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const offset = Math.max(0, Math.round(+body.offset) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.round(+body.limit) || 8));

  let cfg = normalizeObFibConfig(OB_FIB_DEFAULTS);
  try {
    const saved = await getState('ob_fib_config', null);
    if (saved) cfg = normalizeObFibConfig(saved);
  } catch (_) {}

  try {
    // 1st request (offset 0, no `symbols`): rank ALL USDT perpetuals by 24h volume and return the list.
    // Later requests send their own slice in `symbols` so no ticker/exchange-info weight is spent per chunk.
    const reqSymbols = Array.isArray(body.symbols)
      ? [...new Set(body.symbols.map((x) => String(x).toUpperCase()).filter((x) => /^[A-Z0-9]{2,20}USDT$/.test(x)))].slice(0, MAX_LIMIT)
      : [];
    let ranked = null;
    let total;
    let slice;
    if (reqSymbols.length) {
      slice = reqSymbols;
      total = Math.max(0, Math.round(+body.total) || 0);
    } else {
      const [symbols, tickers] = await Promise.all([loadExchangeInfo(), loadTickers()]);
      ranked = Object.entries(tickers)
        .filter(([s]) => symbols.includes(s))
        .sort((a, b) => b[1].volume - a[1].volume)
        .map((e) => e[0]);
      total = ranked.length;
      slice = ranked.slice(offset, offset + limit);
    }

    let refCache;
    try {
      refCache = createRefCache(await getState(REF_CACHE_KEY, null));
    } catch (_) {
      refCache = createRefCache(null);
    }

    const signals = [];
    const errors = [];
    let scanned = 0;
    let stopped = null; // 'banned' | 'throttled'

    await pool(slice, async (symbol) => {
      if (stopped) return;
      try {
        // live price = close of the forming 5m candle; ATR from the closed ones
        const c5 = await getKlines(symbol, '5m', 31, { includeForming: true });
        const price = c5?.length ? +c5[c5.length - 1].close : NaN;
        if (!Number.isFinite(price) || price <= 0) return;
        const atr5m = calcATR(c5.slice(0, -1), 14);
        const res = await scanObFibCore({
          symbol,
          price,
          getKlines,
          config: cfg,
          refTimeframes: Array.isArray(body.refTimeframes) ? body.refTimeframes : undefined,
          timeframes: Array.isArray(body.timeframes) ? body.timeframes : undefined,
          fibLevels: Array.isArray(body.fibLevels) ? body.fibLevels : undefined,
          refCache,
          atr5m,
          pruneLtf: true,
        });
        scanned++;
        for (const h of res.signals) {
          const dist = Math.abs(+h.entry - price);
          signals.push({
            symbol,
            dir: h.dir,
            refTf: h.metadata?.obFib?.refTf,
            refLabel: h.metadata?.obFib?.refLabel,
            ltf: h.metadata?.obFib?.tf || h.metadata?.patternTf,
            fibRatio: h.metadata?.obFib?.hitRatio,
            fibPrice: h.metadata?.obFib?.hitPrice,
            entry: h.entry,
            sl: h.sl,
            tp1: h.tp1,
            tp2: h.tp2,
            rr: h.rr,
            score: h.score,
            price,
            distPct: price ? +((dist / price) * 100).toFixed(3) : null,
            distAtr: +h.atr > 0 ? +(dist / +h.atr).toFixed(2) : null,
            obTime: h.ob?.time ?? null,
            obTimeIso: h.ob?.time ? new Date(+h.ob.time * 1000).toISOString() : null,
          });
        }
        for (const e of res.errors) errors.push(`${symbol} ${e}`);
      } catch (e) {
        if (e?.banned) stopped = 'banned';
        else if (e?.throttled) stopped = 'throttled';
        errors.push(`${symbol}: ${e.message}`);
      }
    });

    if (refCache.dirty) {
      try {
        await setState(REF_CACHE_KEY, refCache.toJSON(Math.floor(Date.now() / 1000), ranked || null));
      } catch (_) {}
    }

    // when the rate guard stopped us, the client retries the SAME slice after a pause (results are de-duplicated there)
    const nextOffset = stopped ? offset : offset + slice.length;
    return NextResponse.json({
      ok: true,
      total,
      offset,
      nextOffset,
      symbols: ranked || undefined,
      done: !stopped && nextOffset >= total,
      scanned,
      signals,
      errors: errors.slice(0, 10),
      throttled: stopped === 'throttled' || undefined,
      banned: stopped === 'banned' || undefined,
      retryAfterMs: stopped === 'throttled' ? 20_000 : undefined,
    });
  } catch (e) {
    const banned = !!e?.banned;
    return NextResponse.json(
      { error: e.message, banned: banned || undefined, throttled: !!e?.throttled || undefined },
      { status: banned ? 429 : 500 }
    );
  }
}
