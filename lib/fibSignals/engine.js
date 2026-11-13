/**
 * Fib Signals engine — one coin → plain signals.
 * Uses the shared OB+Fib core, then (optionally) keeps only fib lines that were never touched
 * since their HTF candle closed, judged on DAILY candles (a daily high/low range covers every intraday touch).
 */
import { scanObFibCore } from '../scanner/strategy/obFib/scanSymbol.js';
import { candleEnd } from '../scanner/strategy/obFib/index.js';
import { engineConfigFrom } from './config.js';

const TOUCH_TOL = 0.0003; // 0.03 % band around the fib price counts as a touch
const r8 = (x) => (Number.isFinite(+x) ? +(+x).toFixed(8) : null);

export function fibSignalId(h) {
  const f = h.metadata?.obFib || {};
  return ['FS', h.symbol, h.dir, f.refTf, f.weekly?.time, f.hitRatio, f.tf, h.ob?.time].join('_').replace(/[^A-Za-z0-9_.-]/g, '');
}

/** has `level` traded since the fib's reference candle closed? (daily candles, forming day included) */
export function fibLevelTouched(level, sinceSec, dailyCandles) {
  const lo = level * (1 - TOUCH_TOL);
  const hi = level * (1 + TOUCH_TOL);
  for (const c of dailyCandles || []) {
    if (+c.time + 86400 <= sinceSec) continue; // candle ended before the fib candle closed
    if (+c.low <= hi && +c.high >= lo) return true;
  }
  return false;
}

/** a setup whose entry was already used → goes to the Invalid list, never to the signal feed */
export function toInvalidRecord(h, { price, nowIso }) {
  const base = toStoredSignal(h, { price, nowIso });
  return {
    ...base,
    status: 'INVALID',
    closeReason: 'ENTRY_USED',
    closeNote: 'Entry level was already touched after the order block formed',
    entryUsedAt: new Date(+h.entryUsedAt * 1000).toISOString(),
    invalidAt: nowIso,
  };
}

export function toStoredSignal(h, { price, nowIso }) {
  const f = h.metadata?.obFib || {};
  const isLong = h.dir === 'LONG';
  const entry = +h.entry;
  const risk = Math.abs(entry - +h.sl);
  const pct = (v) => (entry > 0 ? +((Math.abs(+v - entry) / entry) * 100).toFixed(2) : null);
  return {
    signal_id: fibSignalId(h),
    exchange: 'binance',
    symbol: h.symbol,
    dir: h.dir,
    side: isLong ? 'BUY' : 'SELL',
    status: 'ACTIVE',
    createdAt: nowIso,
    priceAtIssue: r8(price),
    entry: r8(entry),
    entryZone: { low: r8(Math.min(h.ob.low, h.ob.high)), high: r8(Math.max(h.ob.low, h.ob.high)) },
    sl: r8(h.sl),
    tp1: r8(h.tp1),
    tp2: r8(h.tp2),
    tp3: r8(h.tp3),
    rr: h.rr,
    riskPct: pct(h.sl),
    tpPct: [pct(h.tp1), pct(h.tp2), pct(h.tp3)],
    score: h.score,
    atr: h.atr,
    ltf: f.tf,
    fib: {
      refTf: f.refTf,
      refLabel: f.refLabel,
      ratio: f.hitRatio,
      price: r8(f.hitPrice),
      candleTime: f.weekly?.time,
      candleDir: f.weekly?.candleDir,
      dir: f.weekly?.dir,
      high: r8(f.weekly?.high),
      low: r8(f.weekly?.low),
    },
    ob: { time: h.ob.time, type: h.ob.type, high: r8(h.ob.high), low: r8(h.ob.low), status: h.ob.status },
    lux: f.lux || null,
    firstTouch: false,
    entryHit: false,
    tp1Hit: false,
    tp2Hit: false,
    tp3Hit: false,
    slHit: false,
    evalFrom: Math.floor(Date.parse(nowIso) / 1000),
  };
}

/**
 * @returns {Promise<{signals: object[], errors: string[]}>} stored-signal objects (not yet de-duplicated)
 */
export async function scanCoinFibSignals({ symbol, price, getKlines, cfg, baseCfg, refCache, nowSec = Math.floor(Date.now() / 1000) }) {
  const engineCfg = engineConfigFrom(cfg, baseCfg);
  const core = await scanObFibCore({
    symbol,
    price,
    getKlines,
    config: engineCfg,
    refTimeframes: cfg.refTimeframes,
    timeframes: cfg.timeframes,
    fibLevels: cfg.fibLevels,
    refCache,
    nowSec,
  });
  let hits = core.signals;
  const errors = [...core.errors];

  if (cfg.firstTouchOnly && hits.length) {
    try {
      const sinceOf = (h) => candleEnd(+h.metadata.obFib.weekly.time, h.metadata.obFib.refTf);
      const oldest = Math.min(...hits.map(sinceOf));
      const days = Math.ceil((nowSec - oldest) / 86400) + 3;
      const daily = await getKlines(symbol, '1d', Math.min(1000, Math.max(5, days)), { includeForming: true });
      hits = hits.filter((h) => !fibLevelTouched(+h.metadata.obFib.hitPrice, sinceOf(h), daily));
    } catch (e) {
      errors.push(`first-touch check: ${e.message}`);
      hits = []; // never publish a "first touch" signal we could not verify
    }
  }

  const nowIso = new Date(nowSec * 1000).toISOString();
  const fresh = hits.filter((h) => h.entryUsedAt == null);
  const used = hits.filter((h) => h.entryUsedAt != null);
  const signals = fresh.map((h) => {
    const s = toStoredSignal(h, { price, nowIso });
    s.firstTouch = !!cfg.firstTouchOnly;
    return s;
  });
  const invalid = used.map((h) => toInvalidRecord(h, { price, nowIso }));
  return { signals, invalid, errors };
}
