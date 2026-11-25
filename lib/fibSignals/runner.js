/**
 * Fib Signals runner — one cron "pass".
 *   1) track the signals that are already published (entry / TP / SL / invalid / expired)
 *   2) scan the next slice of the Binance USDT-perp universe (highest volume first) from a persisted cursor,
 *      so repeated passes sweep ALL coins, exactly like the chunked cron scanner
 * Triggered by: /api/cron/fib-signals, the existing /api/cron/full-scan tick, and Admin → "Scan all coins now".
 */
import { S } from './state.js';
import { createRefCache } from '../scanner/strategy/obFib/refCache.js';
import { revalidateObFibSignal, candlesNeededForOb } from '../scanner/strategy/obFib/revalidate.js';
import {
  FIB_SIGNALS_CONFIG_KEY,
  FIB_SIGNALS_CURSOR_KEY,
  FIB_SIGNALS_STATUS_KEY,
  FIB_SIGNALS_LOCK_KEY,
  normalizeFibSignalsConfig,
  engineConfigFrom,
} from './config.js';
import { scanCoinFibSignals, fibLevelTouched } from './engine.js';
import { candleEnd } from '../scanner/strategy/obFib/index.js';
import { evaluateFibSignal } from './evaluate.js';
import { refineSignalCandles } from './trackData.js';
import { loadStore, saveStore, loadInvalid, saveInvalid, loadScannerBaseConfig } from './store.js';

const REF_CACHE_KEY = 'ob_fib_ref_cache:binance';
const LOCK_TTL_MS = 4 * 60_000;
const BATCH = 6;
const POOL = 3;

async function pool(items, worker, size = POOL) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await worker(items[i], i);
      }
    })
  );
}

export async function getFibSignalsConfig() {
  try {
    return normalizeFibSignalsConfig(await (await S()).getState(FIB_SIGNALS_CONFIG_KEY, null));
  } catch (_) {
    return normalizeFibSignalsConfig(null);
  }
}

async function acquireLock(force = false) {
  try {
    const cur = await (await S()).getState(FIB_SIGNALS_LOCK_KEY, null);
    if (!force && cur?.at && Date.now() - cur.at < LOCK_TTL_MS) return false;
    await (await S()).setState(FIB_SIGNALS_LOCK_KEY, { at: Date.now() });
    return true;
  } catch (_) {
    return true;
  }
}
async function releaseLock() {
  try {
    await (await S()).setState(FIB_SIGNALS_LOCK_KEY, { at: 0 });
  } catch (_) {}
}

const asObSignal = (s) => ({
  symbol: s.symbol,
  direction: s.dir,
  metadata: { ob: s.ob, patternTf: s.ltf, obFib: { tf: s.ltf, lux: s.lux || undefined } },
});

/**
 * @param {object} o { source, budgetMs, resetCursor, force, deps:{getKlines,loadExchangeInfo,loadTickers} }
 */
export async function runFibSignalsPass(o = {}) {
  const started = Date.now();
  const budgetMs = Math.max(8_000, Math.min(270_000, +o.budgetMs || 40_000));
  const timeLeft = () => budgetMs - (Date.now() - started);
  const cfg = await getFibSignalsConfig();
  if (!cfg.enabled && !o.force) return { ok: true, skipped: true, reason: 'Fib Signals is OFF' };

  const deps = o.deps || (await import('../binance/client.js'));
  const { getKlines, loadExchangeInfo, loadTickers, getAggTrades } = deps;

  if (!(await acquireLock(!!o.force))) return { ok: true, skipped: true, reason: 'another Fib Signals pass is running' };

  const summary = { ok: true, source: o.source || 'cron', created: 0, invalid: 0, closed: 0, tracked: 0, scanned: 0, total: 0, errors: [] };
  try {
    const nowSec = () => Math.floor(Date.now() / 1000);
    const store = await loadStore();
    const invalidStore = await loadInvalid();
    const baseCfg = await loadScannerBaseConfig(); // same settings Coin Scan uses
    const engineCfg = engineConfigFrom(cfg);

    // ── 1) track published signals (oldest-checked first, max ~35 % of the budget) ────────────────
    const trackUntil = Date.now() + budgetMs * 0.35;
    const open = store.signals
      .filter((s) => s.status === 'ACTIVE')
      .sort((a, b) => (a._lastCheckedAt || 0) - (b._lastCheckedAt || 0));
    let stopped = null;
    await pool(open.slice(0, 60), async (sig) => {
      if (stopped || Date.now() > trackUntil) return;
      try {
        const need = candlesNeededForOb(asObSignal(sig), engineCfg, nowSec());
        const candles = await getKlines(sig.symbol, sig.ltf, need);
        const trackingCandles = await refineSignalCandles(sig, candles, { getKlines, getAggTrades });
        const { patch } = evaluateFibSignal(sig, trackingCandles, nowSec(), { expireDays: cfg.expireDays });
        Object.assign(sig, patch);
        if (sig.status === 'ACTIVE' && !sig.entryHit) {
          const rv = revalidateObFibSignal(asObSignal(sig), candles, engineCfg);
          if (rv.ok === false) {
            sig.status = 'CLOSED';
            sig.closeReason = 'INVALID';
            sig.closeNote = rv.reason;
            sig.closedAt = new Date().toISOString();
          }
        }
        // First-touch only: a signal that is still waiting for its entry is dropped as soon as price
        // has traded through its Fib line (the first reaction is gone). Also cleans signals that were
        // published before the switch was turned ON.
        if (cfg.firstTouchOnly && sig.status === 'ACTIVE' && !sig.entryHit && sig.fib?.price && sig.fib?.candleTime) {
          try {
            const since = candleEnd(+sig.fib.candleTime, sig.fib.refTf);
            const days = Math.min(1000, Math.max(5, Math.ceil((nowSec() - since) / 86400) + 3));
            const daily = await getKlines(sig.symbol, '1d', days, { includeForming: true });
            if (fibLevelTouched(+sig.fib.price, since, daily)) {
              sig.status = 'CLOSED';
              sig.closeReason = 'TOUCHED';
              sig.closeNote = 'Fib line already touched (first-touch only)';
              sig.closedAt = new Date().toISOString();
            }
          } catch (e) {
            if (e?.banned) stopped = 'banned';
            else if (e?.throttled) stopped = 'throttled';
            // a failed check never retires a signal — it is simply retried next pass
          }
        }
        summary.tracked++;
        if (sig.status === 'CLOSED') summary.closed++;
      } catch (e) {
        if (e?.banned) stopped = 'banned';
        else if (e?.throttled) stopped = 'throttled';
        summary.errors.push(`track ${sig.symbol}: ${e.message}`);
      }
    }, 3);

    // ── 2) scan the next slice of the market ──────────────────────────────────────────────────────
    if (!stopped && timeLeft() > 8_000) {
      const [symbols, tickers] = await Promise.all([loadExchangeInfo(), loadTickers()]);
      const ranked = Object.entries(tickers)
        .filter(([s]) => symbols.includes(s))
        .sort((a, b) => b[1].volume - a[1].volume)
        .map((e) => e[0]);
      summary.total = ranked.length;

      let cursor = (await (await S()).getState(FIB_SIGNALS_CURSOR_KEY, null)) || {};
      let offset = o.resetCursor ? 0 : Math.max(0, +cursor.offset || 0);
      let cycles = +cursor.cycles || 0;
      if (offset >= ranked.length) offset = 0;

      let refCache;
      try {
        refCache = createRefCache(await (await S()).getState(REF_CACHE_KEY, null));
      } catch (_) {
        refCache = createRefCache(null);
      }
      const known = new Set(store.signals.map((s) => s.signal_id));
      const knownInvalid = new Set(invalidStore.items.map((s) => s.signal_id));

      while (!stopped && offset < ranked.length && timeLeft() > 7_000) {
        const batch = ranked.slice(offset, offset + BATCH);
        await pool(batch, async (symbol) => {
          if (stopped) return;
          try {
            // live price = forming 5m close
            const c5 = await getKlines(symbol, '5m', 3, { includeForming: true });
            const price = c5?.length ? +c5[c5.length - 1].close : NaN;
            if (!Number.isFinite(price) || price <= 0) return;
            const res = await scanCoinFibSignals({ symbol, price, getKlines, cfg, baseCfg, refCache, nowSec: nowSec() });
            summary.scanned++;
            for (const sg of res.signals) {
              if (known.has(sg.signal_id)) continue;
              known.add(sg.signal_id);
              store.signals.push(sg);
              summary.created++;
            }
            for (const iv of res.invalid || []) {
              if (known.has(iv.signal_id) || knownInvalid.has(iv.signal_id)) continue;
              knownInvalid.add(iv.signal_id);
              invalidStore.items.push(iv);
              summary.invalid++;
            }
            for (const e of res.errors) summary.errors.push(`${symbol} ${e}`);
          } catch (e) {
            if (e?.banned) stopped = 'banned';
            else if (e?.throttled) stopped = 'throttled';
            summary.errors.push(`${symbol}: ${e.message}`);
          }
        });
        if (stopped) break; // retry this batch next pass
        offset += batch.length;
      }

      let sweepDone = false;
      if (offset >= ranked.length) {
        offset = 0;
        cycles++;
        sweepDone = true;
      }
      summary.sweepDone = sweepDone;
      summary.offset = offset;
      summary.cycles = cycles;
      await (await S()).setState(FIB_SIGNALS_CURSOR_KEY, { offset, cycles, at: new Date().toISOString() });
      if (refCache.dirty) {
        try {
          await (await S()).setState(REF_CACHE_KEY, refCache.toJSON(nowSec(), ranked));
        } catch (_) {}
      }
    }

    summary.stopped = stopped || undefined;
    await saveStore(store);
    if (summary.invalid > 0) {
      try { await saveInvalid(invalidStore); } catch (_) {}
    }
    summary.active = store.signals.filter((s) => s.status === 'ACTIVE').length;
    summary.errors = summary.errors.slice(0, 10);
    summary.durationMs = Date.now() - started;
    try {
      await (await S()).setState(FIB_SIGNALS_STATUS_KEY, { ...summary, at: new Date().toISOString() });
    } catch (_) {}
    return summary;
  } finally {
    await releaseLock();
  }
}
