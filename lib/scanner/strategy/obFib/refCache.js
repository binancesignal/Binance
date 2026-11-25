/**
 * Persistent cache of the HTF (Fib reference) candles.
 *
 * The Fib is drawn from the last CLOSED Daily / Weekly / Month / 3-Month / 1-Year candle, which cannot
 * change until the NEXT candle closes. Re-downloading it for every coin on every scan run was ~5 of the
 * ~19 API weight per coin and is what made the all-market scan stop after ~20 coins (rate guard).
 * Entry = { c: [[time,open,high,low,close], ...last `k` closed candles], k, v: validUntil (unix sec) }.
 */
import { candleEnd } from './index.js';

const key = (symbol, refTf) => `${symbol}|${refTf}`;

export function createRefCache(raw) {
  const data = raw && typeof raw === 'object' && raw.v === 1 && raw.e && typeof raw.e === 'object' ? { ...raw.e } : {};
  let dirty = false;
  let hits = 0;
  let misses = 0;
  return {
    get(symbol, refTf, back, nowSec) {
      const e = data[key(symbol, refTf)];
      if (!e || !Array.isArray(e.c) || !e.c.length || !(+e.k >= back) || !(+e.v > nowSec)) {
        misses++;
        return null;
      }
      hits++;
      return e.c.map(([time, open, high, low, close]) => ({ time, open, high, low, close, volume: 0 }));
    },
    /** @param candles raw klines of refTf (may include the forming candle) */
    set(symbol, refTf, candles, back, nowSec) {
      const closed = (candles || []).filter((c) => c && candleEnd(+c.time, refTf) <= nowSec + 5);
      if (!closed.length) return;
      const keep = closed.slice(-Math.max(1, back));
      const last = keep[keep.length - 1];
      const nextOpen = candleEnd(+last.time, refTf);
      data[key(symbol, refTf)] = {
        c: keep.map((c) => [+c.time, +c.open, +c.high, +c.low, +c.close]),
        k: Math.max(1, back),
        v: candleEnd(nextOpen, refTf), // the candle after `last` closes → a newer closed candle exists
      };
      dirty = true;
    },
    get dirty() {
      return dirty;
    },
    stats() {
      return { hits, misses, entries: Object.keys(data).length };
    },
    /** drop expired entries (and symbols no longer in the universe) before saving */
    toJSON(nowSec, activeSymbols) {
      const keepSym = activeSymbols ? new Set(activeSymbols) : null;
      const e = {};
      for (const [k, v] of Object.entries(data)) {
        if (!(+v.v > nowSec)) continue;
        if (keepSym && !keepSym.has(k.split('|')[0])) continue;
        e[k] = v;
      }
      return { v: 1, e };
    },
  };
}
