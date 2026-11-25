/**
 * Harmonic FULL SCAN — server-side, in chunks, no browser needed.
 *
 * cron-job.org → GET /api/cron/harmonic-scan?secret=…  every 1 minute.
 * Each call checks the next `coinsPerTick` coins of the futures universe, saves what it finds
 * straight into the saved-signals database (so it shows up in the admin panel + public Scanner
 * while the pass is still running) and moves a cursor forward. When the whole universe is done
 * it rests `restMin` minutes and starts a new pass.
 *
 * Ban safety:
 *  - the Binance client tracks used weight and stops before the limit; HTTP 418/429 persist a ban
 *  - while a ban / backoff is active this route sends NO request at all
 *  - small pause between candle requests, small chunk per call, overlapping calls are blocked by a lock
 *  - the status-refresh cron is separate, so signals found so far keep updating during a long pass
 */
import { after } from 'next/server';
import { getState, setState } from '../../../../lib/database/appState.js';
import * as exchange from '../../../../lib/exchange/index.js';
import { selectUniverse } from '../../../../lib/skSystem/universe.js';
import { findHarmonicEvents } from '../../../../lib/scanner/strategy/harmonicScan/index.js';
import { assertHarmonicCron, cronJson as json } from '../../../../lib/harmonicSaved/cronAuth.js';
import { activeBinanceBan } from '../../../../lib/harmonicSaved/ban.js';
import { triggerAutoTrade } from '../../../../lib/trading/triggerAutoTrade.js';
import { mergeScanned, buildScanCfg } from '../../../../lib/harmonicSaved/store.js';
import {
  loadScanState,
  saveScanState,
  planTick,
  publicScanState,
  SCAN_TICK_LOCK_KEY,
} from '../../../../lib/harmonicSaved/scanState.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TICK_BUDGET_MS = 40_000; // leave headroom under maxDuration
const GAP_MS = 250; // pause between candle requests
const SAVE_EVERY = 6; // save to DB every N coins (progress survives a crash/timeout)
const MAX_EVENTS_PER_TF = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireTickLock() {
  const cur = await getState(SCAN_TICK_LOCK_KEY, null).catch(() => null);
  if (cur && +cur.until > Date.now()) return null;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await setState(SCAN_TICK_LOCK_KEY, { until: Date.now() + 58_000, token });
  await sleep(40);
  const chk = await getState(SCAN_TICK_LOCK_KEY, null).catch(() => null);
  return chk?.token === token ? token : null;
}
async function releaseTickLock(token) {
  try {
    const chk = await getState(SCAN_TICK_LOCK_KEY, null);
    if (chk?.token === token) await setState(SCAN_TICK_LOCK_KEY, { until: 0, token: null });
  } catch (_) {}
}

async function loadUniverse() {
  const [eligible, tickers] = await Promise.all([exchange.loadExchangeInfo(), exchange.loadTickers()]);
  return selectUniverse({ mode: 'all', ranking: 'volume', eligible, tickers, symbols: [] });
}

export async function runScanTick() {
  const startedAt = Date.now();
  let state = await loadScanState();
  const plan = planTick(state, startedAt);
  if (plan.action === 'skip') {
    await saveScanState({ ...state, lastTickAt: new Date().toISOString(), status: plan.reason });
    return { ok: true, skipped: true, reason: plan.reason };
  }

  const banUntil = await activeBinanceBan();
  if (banUntil) {
    await saveScanState({
      ...state,
      lastTickAt: new Date().toISOString(),
      pausedUntil: banUntil,
      status: `Binance ban active until ${new Date(banUntil).toISOString()} — no requests sent`,
    });
    return { ok: true, skipped: true, banned: true, banUntil };
  }

  const token = await acquireTickLock();
  if (!token) return { ok: true, skipped: true, reason: 'previous tick still running' };

  try {
    state = await loadScanState(); // fresh copy after the lock

    if (plan.action === 'start' || !state.pass) {
      const symbols = await loadUniverse();
      if (!symbols.length) {
        await saveScanState({ ...state, lastTickAt: new Date().toISOString(), status: 'universe empty', lastError: 'universe empty' });
        return { ok: false, error: 'universe empty' };
      }
      state.pass = { startedAt: new Date().toISOString(), symbols, idx: 0, found: 0, errors: 0 };
    }

    const cfg = await buildScanCfg();
    const tfs = state.tfs;
    const pass = state.pass;
    const maxCoins = state.coinsPerTick;

    let processed = 0;
    let foundThisTick = 0;
    let pending = [];
    let stopReason = null;
    let pausedUntil = 0;

    const flush = async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      const r = await mergeScanned(batch);
      foundThisTick += r.added || 0;
    };

    while (pass.idx < pass.symbols.length && processed < maxCoins) {
      if (Date.now() - startedAt > TICK_BUDGET_MS) {
        stopReason = 'time budget';
        break;
      }
      const symbol = pass.symbols[pass.idx];
      let coinOk = true;
      for (const tf of tfs) {
        try {
          const candles = await exchange.getKlines(symbol, tf, 500);
          const events = findHarmonicEvents(candles, cfg);
          for (const e of events.slice(0, MAX_EVENTS_PER_TF)) {
            const bucket =
              e.status === 'ENTRY_READY' ? 'entry_ready' : e.status === 'WAITING' ? 'waiting' : e.status === 'FORMED' ? 'formed' : 'all';
            pending.push({ ...e, symbol, tf, patternTf: tf, bucket });
          }
        } catch (err) {
          if (err?.banned) {
            pausedUntil = +err.banUntil || Date.now() + 5 * 60_000;
            stopReason = 'binance ban';
            coinOk = false;
            break;
          }
          if (err?.throttled) {
            pausedUntil = Date.now() + 90_000;
            stopReason = 'rate guard (weight) — backing off 90s';
            coinOk = false;
            break;
          }
          pass.errors += 1; // one coin failing (delisted, bad data) must not stop the pass
        }
        await sleep(GAP_MS);
      }
      if (!coinOk) break; // do NOT advance: this coin is retried after the pause
      pass.idx += 1;
      processed += 1;
      if (processed % SAVE_EVERY === 0) await flush();
    }
    await flush();
    pass.found += foundThisTick;

    const finished = pass.idx >= pass.symbols.length;
    const next = {
      ...state,
      lastTickAt: new Date().toISOString(),
      lastError: stopReason && stopReason !== 'time budget' ? stopReason : null,
      pausedUntil,
    };
    if (finished) {
      next.lastPass = {
        coins: pass.symbols.length,
        found: pass.found,
        errors: pass.errors,
        startedAt: pass.startedAt,
        endedAt: new Date().toISOString(),
      };
      next.lastPassEndedAt = Date.now();
      next.pass = null;
      next.status = `Pass complete: ${pass.symbols.length} coins, ${pass.found} new signals`;
    } else {
      next.pass = pass;
      next.status = `Scanning ${pass.idx}/${pass.symbols.length}${stopReason ? ` · paused: ${stopReason}` : ''}`;
    }
    await saveScanState(next);
    return {
      ok: true,
      processed,
      newSignals: foundThisTick,
      finishedPass: finished,
      stopReason,
      state: publicScanState(next),
    };
  } catch (e) {
    try {
      const cur = await loadScanState();
      await saveScanState({ ...cur, lastTickAt: new Date().toISOString(), lastError: String(e.message || e).slice(0, 200) });
    } catch (_) {}
    return { ok: false, error: e.message || String(e) };
  } finally {
    await releaseTickLock(token);
  }
}

export async function GET(request) {
  const auth = await assertHarmonicCron(request);
  if (auth.error) return auth.error;
  const url = new URL(request.url);

  if (url.searchParams.get('ping') === '1') {
    return json({ ok: true, ping: true, state: publicScanState(await loadScanState()) });
  }
  if (url.searchParams.get('wait') === '1') {
    const r = await runScanTick();
    return json(r, r.ok === false ? 500 : 200);
  }
  // Normal cron call: answer at once (cron-job.org waits only 30s), do the work in the background
  after(async () => {
    try {
      const r = await runScanTick();
      // a new setup can already be ENTRY READY → let the trader look at once (no waiting for the refresh cron)
      if (r?.newSignals > 0) await triggerAutoTrade('harmonic-scan');
    } catch (e) {
      console.error('[cron/harmonic-scan]', e);
    }
  });
  return json({ ok: true, started: true, job: 'harmonic-scan' });
}

export const POST = GET;
