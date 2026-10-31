/**
 * Per-coin OB + HTF Fib scan (used by /api/scan/symbol and the live chart route).
 *
 * For EVERY selected reference timeframe (Daily / Weekly / Monthly / 3-Month / Yearly):
 *   1. draw that HTF's own Fib from its last CLOSED candle
 *   2. check it against EVERY selected lower timeframe (LTF)
 * Each (HTF × LTF) pair is reported separately — also when it has no signal — so the
 * UI can show exactly what was checked.
 *
 * LTF candles are downloaded once and re-used for every HTF (cheap on API weight).
 */
import { computeWeeklyFib, runObFibPair } from './index.js';
import { normalizeObFibConfig, OB_FIB_REF_TFS, OB_FIB_TFS } from './config.js';

const TF_MIN = { '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240 };

/** Clean a user supplied list of fib ratios (e.g. from the Coin Scan chips). */
export function cleanFibLevels(list) {
  if (!Array.isArray(list)) return null;
  const out = [...new Set(list.map((x) => +(+x).toFixed(4)).filter((x) => Number.isFinite(x) && x >= -5 && x <= 10))]
    .sort((a, b) => a - b)
    .slice(0, 20);
  return out.length ? out : null;
}

const iso = (sec) => (Number.isFinite(+sec) && +sec > 0 ? new Date(+sec * 1000).toISOString() : null);

/** Keep only valid, de-duplicated, ordered values of `allowed` */
export function pickTfs(requested, allowed, fallback) {
  if (!Array.isArray(requested)) return fallback;
  const set = new Set(requested.map(String));
  const out = allowed.filter((t) => set.has(t));
  return out.length ? out : fallback;
}

export function refLimitFor(refTf) {
  return refTf === '1Y' || refTf === '3M' ? 24 : 8;
}

/**
 * CORE — one coin, every selected HTF × every selected LTF.
 * Shared by the all-market chunked scanner, the per-coin Coin Scan and the live chart,
 * so all three always use exactly the same logic.
 *
 * @param {object} o { symbol, price, getKlines, config, refTimeframes?, timeframes?, nowSec? }
 * @returns {Promise<{refTimeframes, timeframes, groups, signals, errors}>}
 *   signals = raw runObFibPair() results (strongest first), nothing added to them.
 */
export async function scanObFibCore(o = {}) {
  const { symbol, price, getKlines, refCache } = o;
  // optional per-call fib-line filter (Coin Scan chips) — otherwise the admin's fibLevels
  const fibOverride = cleanFibLevels(o.fibLevels);
  const cfg = normalizeObFibConfig({ ...(o.config || {}), ...(fibOverride ? { fibLevels: fibOverride } : {}) });
  const refTfs = pickTfs(o.refTimeframes, OB_FIB_REF_TFS, cfg.refTimeframes);
  const ltfs = pickTfs(o.timeframes, OB_FIB_TFS, cfg.timeframes);
  const nowSec = Number.isFinite(+o.nowSec) ? +o.nowSec : Math.floor(Date.now() / 1000);
  const errors = [];

  // reference (Fib) candles — once per HTF; served from the persistent cache when still valid
  const refCandles = {};
  await Promise.all(
    refTfs.map(async (refTf) => {
      try {
        const cached = refCache?.get(symbol, refTf, cfg.refCandleBack, nowSec);
        if (cached) {
          refCandles[refTf] = cached;
          return;
        }
        const raw = await getKlines(symbol, refTf, refLimitFor(refTf));
        refCandles[refTf] = raw;
        refCache?.set(symbol, refTf, raw, cfg.refCandleBack, nowSec);
      } catch (err) {
        errors.push(`${refTf}: ${err.message}`);
        refCandles[refTf] = null;
      }
    })
  );
  const fibs = {};
  for (const refTf of refTfs) fibs[refTf] = refCandles[refTf] ? computeWeeklyFib(refCandles[refTf], cfg, nowSec, refTf) : null;

  // Skip LTFs that cannot give a signal: no selected fib line is within reach of the price.
  // (only used by the all-market scan, which passes atr5m — Coin Scan always checks every LTF)
  const skippedLtf = [];
  let ltfToFetch = ltfs;
  const atr5m = +o.atr5m;
  if (o.pruneLtf && atr5m > 0 && cfg.maxEntryDistanceATR > 0) {
    const levelPrices = [];
    for (const refTf of refTfs) {
      for (const l of fibs[refTf]?.levels || []) if (l.selected) levelPrices.push(+l.price);
    }
    if (levelPrices.length) {
      ltfToFetch = ltfs.filter((tf) => {
        const estAtr = atr5m * Math.sqrt((TF_MIN[tf] || 15) / 5) * 1.6; // generous upper bound of the LTF ATR
        const reach = (cfg.maxEntryDistanceATR + 3) * estAtr; // +3 ATR: OB zone thickness / fib band
        const keep = levelPrices.some((lp) => Math.abs(lp - price) <= reach);
        if (!keep) skippedLtf.push(tf);
        return keep;
      });
    }
  }

  // LTF candles — once per timeframe (re-used by every HTF fib)
  const ltfCandles = {};
  await Promise.all(
    ltfToFetch.map(async (tf) => {
      try {
        ltfCandles[tf] = await getKlines(symbol, tf, cfg.lookback);
      } catch (err) {
        errors.push(`${tf}: ${err.message}`);
        ltfCandles[tf] = null;
      }
    })
  );

  const groups = [];
  const signals = [];
  for (const refTf of refTfs) {
    const raw = refCandles[refTf];
    const fib = fibs[refTf];
    const group = {
      refTf,
      refLabel: fib?.refLabel || refTf,
      fib: fib
        ? {
            candleTime: fib.time,
            candleTimeIso: iso(fib.time),
            candleDir: fib.candleDir,
            dir: fib.dir,
            high: fib.high,
            low: fib.low,
            levels: fib.levels,
          }
        : null,
      note: fib ? undefined : raw ? 'no closed candle' : 'data unavailable',
      ltf: [],
    };
    for (const tf of ltfs) {
      const candles = ltfCandles[tf];
      const row = { tf, signals: [], checked: false };
      if (fib && Array.isArray(candles)) {
        row.checked = true;
        try {
          row.signals = runObFibPair({ symbol, price, candles, tf, weekly: fib, config: cfg });
        } catch (err) {
          errors.push(`${refTf}/${tf}: ${err.message}`);
        }
      }
      group.ltf.push(row);
      signals.push(...row.signals);
    }
    groups.push(group);
  }
  signals.sort((a, b) => (b.score || 0) - (a.score || 0));
  return { refTimeframes: refTfs, timeframes: ltfs, groups, signals, errors, skippedLtf };
}

/**
 * Per-coin scan for the UI (/api/scan/symbol): fetches the live price, runs the core,
 * and decorates every signal with its HTF / LTF / OB time / scan time.
 */
export async function scanObFibSymbol(o = {}) {
  const { symbol, getKlines } = o;
  const last1m = await getKlines(symbol, '1m', 2, { includeForming: true });
  const price = last1m?.length ? +last1m[last1m.length - 1].close : NaN;
  if (!Number.isFinite(price)) {
    const e = new Error(`no price for ${symbol}`);
    e.status = 404;
    throw e;
  }
  const core = await scanObFibCore({ ...o, price });
  const scannedAt = new Date().toISOString();
  const decorate = (h, refTf, tf) => ({
    ...h,
    refTf,
    ltf: tf,
    obTime: h.ob?.time ?? null,
    obTimeIso: iso(h.ob?.time),
    scannedAt,
    priceAtScan: price,
  });
  for (const g of core.groups) {
    for (const row of g.ltf) row.signals = row.signals.map((h) => decorate(h, g.refTf, row.tf));
  }
  const signals = core.groups.flatMap((g) => g.ltf.flatMap((r) => r.signals));
  signals.sort((a, b) => (b.score || 0) - (a.score || 0));
  return { symbol, price, scannedAt, ...core, signals };
}
