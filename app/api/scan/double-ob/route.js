import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getKlines, loadExchangeInfo, loadTickers } from '../../../../lib/binance/client.js';
import { getKlines as getKlinesAny } from '../../../../lib/exchange/index.js';
import { DOUBLE_OB_TFS, findDoubleObs } from '../../../../lib/doubleOb/detect.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const maxDuration = 60;

const POOL = 3;
const MAX_LIMIT = 10;
const CANDLES = 400;

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

const pickTfs = (raw) => {
  const t = DOUBLE_OB_TFS.filter((x) => Array.isArray(raw) && raw.includes(x));
  return t.length ? t : ['15m', '1h', '4h'];
};
const slim = (c) => ({ time: +c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close });

function cleanSymbol(raw) {
  let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  if (!s.endsWith('USDT')) s += 'USDT';
  return s;
}

/**
 * POST /api/scan/double-ob
 *
 * A) one coin:   { symbol, timeframes }
 *    → { symbol, price, groups: [{ tf, candles, setups }] }   (candles included so the chart opens instantly)
 *
 * B) all coins (called repeatedly by the client, like /api/scan/market):
 *    { timeframes, offset = 0, limit = 8, symbols?, total?, topN? }
 *    → { total, offset, nextOffset, done, scanned, setups[], errors[], throttled?, banned? }
 *
 * C) chart for one result: { symbol, timeframes: [tf], candlesOnly: true } → same shape as A.
 */
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const timeframes = pickTfs(body.timeframes);

  // ── A / C : a single coin ─────────────────────────────────────────────
  if (body.symbol) {
    try {
      const symbol = cleanSymbol(body.symbol);
      if (symbol.length < 5) return NextResponse.json({ error: 'Coin එකක් ගහන්න, උදා: BTC' }, { status: 400 });
      const errors = [];
      const groups = await Promise.all(
        timeframes.map(async (tf) => {
          try {
            const raw = await getKlinesAny(symbol, tf, CANDLES);
            const candles = (raw || []).map((c) => ({ ...slim(c), volume: +c.volume || 0 }));
            if (candles.length < 40) throw new Error('not enough candles');
            const setups = findDoubleObs(candles, { symbol, tf });
            return { tf, candles: candles.map(slim), setups };
          } catch (e) {
            errors.push(`${tf}: ${e.message}`);
            return { tf, candles: [], setups: [], error: e.message };
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
      return NextResponse.json({ error: e.message || 'Double OB scan failed' }, { status: 500 });
    }
  }

  // ── B : slice of the whole market ─────────────────────────────────────
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const offset = Math.max(0, Math.round(+body.offset) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.round(+body.limit) || 8));
  const topN = Math.max(0, Math.round(+body.topN) || 0); // 0 = every coin

  try {
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
      if (topN) ranked = ranked.slice(0, topN);
      total = ranked.length;
      slice = ranked.slice(offset, offset + limit);
    }

    const setups = [];
    const errors = [];
    let scanned = 0;
    let stopped = null;

    await pool(slice, async (symbol) => {
      if (stopped) return;
      try {
        const p1 = await getKlines(symbol, '1m', 2, { includeForming: true });
        const price = p1?.length ? +p1[p1.length - 1].close : NaN;
        if (!Number.isFinite(price) || price <= 0) return;
        for (const tf of timeframes) {
          if (stopped) break;
          const raw = await getKlines(symbol, tf, 300);
          const candles = (raw || []).map((c) => ({ ...slim(c), volume: +c.volume || 0 }));
          if (candles.length < 40) continue;
          for (const s of findDoubleObs(candles, { symbol, tf, price, lookback: 300 })) setups.push(s);
        }
        scanned++;
      } catch (e) {
        if (e?.banned) stopped = 'banned';
        else if (e?.throttled) stopped = 'throttled';
        errors.push(`${symbol}: ${e.message}`);
      }
    });

    const nextOffset = stopped ? offset : offset + slice.length;
    return NextResponse.json({
      ok: true,
      total,
      offset,
      nextOffset,
      symbols: ranked || undefined,
      done: !stopped && nextOffset >= total,
      scanned,
      setups,
      errors: errors.slice(0, 10),
      throttled: stopped === 'throttled' || undefined,
      banned: stopped === 'banned' || undefined,
      retryAfterMs: stopped === 'throttled' ? 20_000 : undefined,
    });
  } catch (e) {
    const banned = !!e?.banned;
    return NextResponse.json({ error: e.message, banned: banned || undefined, throttled: !!e?.throttled || undefined }, { status: banned ? 429 : 500 });
  }
}
