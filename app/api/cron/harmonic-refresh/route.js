/**
 * Harmonic saved signals — STATUS REFRESH (server cron, phone/browser can be off).
 * cron-job.org → GET /api/cron/harmonic-refresh?secret=…  every 1–5 min.
 *
 * ONE run refreshes EVERY live signal together and stamps them all with the same time, so the
 * whole list moves at once (Watching → Entry ready → In trade → TP1/TP2/TP3 hit / SL hit …).
 * It is independent of the full-scan cron, so signals found so far keep updating while a long
 * scan pass is still running.
 *
 * API-friendly: one candle download per symbol+timeframe (shared by all signals on it),
 * the cheap 499-candle request first (Binance weight 2) and the 1000-candle one only when a
 * pattern is older than that window, small parallelism, ban/rate-guard aware.
 */
import { after } from 'next/server';
import { getState, setState } from '../../../../lib/database/appState.js';
import * as exchange from '../../../../lib/exchange/index.js';
import {
  revalidateSavedSignal,
  isFinalHarmonicStatus,
  HS_SCAN_TFS,
} from '../../../../lib/scanner/strategy/harmonicScan/index.js';
import { assertHarmonicCron, cronJson as json } from '../../../../lib/harmonicSaved/cronAuth.js';
import { activeBinanceBan } from '../../../../lib/harmonicSaved/ban.js';
import {
  loadSaved,
  applyRefresh,
  buildScanCfg,
  livePriceFromTickers,
} from '../../../../lib/harmonicSaved/store.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const META_KEY = 'harmonic_refresh_meta';
const BUDGET_MS = 45_000;
const CONCURRENCY = 4;
const STAGGER_MS = 80;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanSymbol = (s) => {
  const x = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return x ? (x.endsWith('USDT') ? x : `${x}USDT`) : '';
};

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async (_, w) => {
    await sleep(w * STAGGER_MS);
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

export async function runRefresh() {
  const started = Date.now();
  const banUntil = await activeBinanceBan();
  if (banUntil) {
    const meta = { at: new Date().toISOString(), skipped: true, banned: true, banUntil, status: 'Binance ban active — no requests sent' };
    try {
      await setState(META_KEY, meta);
    } catch (_) {}
    return meta;
  }

  const cfg = await buildScanCfg();
  const list = await loadSaved();
  // Finished signals (SL / TP3 / invalid / missed) are frozen — no API calls for them
  const live = list.filter((x) => !isFinalHarmonicStatus(x.status));
  const runAt = Math.floor(Date.now() / 1000); // the SAME refresh time for every signal in this run

  let tickers = null;
  try {
    tickers = await exchange.loadTickers();
  } catch (_) {}

  // Group live signals by symbol|tf → a single candle download each
  const groups = new Map();
  for (const item of live) {
    const symbol = cleanSymbol(item.symbol);
    const tf = String(item.tf || '15m');
    if (!symbol || !HS_SCAN_TFS.includes(tf)) continue;
    const k = `${symbol}|${tf}`;
    if (!groups.has(k)) groups.set(k, { symbol, tf, items: [] });
    groups.get(k).items.push(item);
  }
  // Stalest group first, in case the time budget ever runs out
  const order = [...groups.values()].sort(
    (a, b) => Math.min(...a.items.map((x) => x.refreshedAt || 0)) - Math.min(...b.items.map((x) => x.refreshedAt || 0))
  );

  const updates = new Map();
  let ok = 0;
  let fail = 0;
  let banned = false;
  let throttled = false;
  let skippedForTime = 0;

  await pool(order, CONCURRENCY, async (g) => {
    if (banned || throttled) return;
    if (Date.now() - started > BUDGET_MS) {
      skippedForTime += g.items.length;
      return;
    }
    const livePx = livePriceFromTickers(tickers, g.symbol);
    let candles499 = null;
    let candles1000 = null;
    try {
      candles499 = await exchange.getKlines(g.symbol, g.tf, 499);
    } catch (e) {
      if (e?.banned) banned = true;
      else if (e?.throttled) throttled = true;
      fail += g.items.length;
      return;
    }
    for (const item of g.items) {
      try {
        let updated = revalidateSavedSignal(candles499, { ...item, symbol: g.symbol, tf: g.tf }, cfg);
        if (!updated) {
          // pattern older than 499 candles → one bigger download (only when really needed)
          if (!candles1000) candles1000 = await exchange.getKlines(g.symbol, g.tf, 1000);
          updated = revalidateSavedSignal(candles1000, { ...item, symbol: g.symbol, tf: g.tf }, cfg);
        }
        if (updated) {
          updates.set(item.id, {
            ...updated,
            price: livePx?.price ?? updated.price,
            marketPrice: livePx?.price ?? updated.price,
            priceSource: livePx?.priceSource || 'CANDLE',
            priceAt: runAt,
            candleClose: updated.price,
            error: undefined,
            refreshedAt: runAt,
          });
          ok += 1;
        } else {
          // structure no longer in the window — keep status, still move the live price
          updates.set(item.id, {
            price: livePx?.price ?? item.price,
            marketPrice: livePx?.price ?? item.price,
            priceSource: livePx?.priceSource || 'CANDLE',
            priceAt: runAt,
            refreshedAt: runAt,
            error: 'pattern older than candle window — price updated',
          });
          fail += 1;
        }
      } catch (e) {
        if (e?.banned) banned = true;
        else if (e?.throttled) throttled = true;
        fail += 1;
        break;
      }
    }
  });

  // Merge into the CURRENT list (re-read inside) so a scan chunk saved meanwhile is never lost
  let applied = { updated: 0 };
  try {
    applied = await applyRefresh(updates);
  } catch (e) {
    fail += 1;
  }

  const meta = {
    at: new Date(runAt * 1000).toISOString(),
    durationMs: Date.now() - started,
    totalSaved: list.length,
    liveSignals: live.length,
    refreshedThisRun: updates.size,
    totalOk: ok,
    totalFail: fail,
    updated: applied.updated,
    skippedForTime,
    banned,
    throttled,
  };
  try {
    await setState(META_KEY, meta);
  } catch (_) {}
  return meta;
}

export async function GET(request) {
  const auth = await assertHarmonicCron(request);
  if (auth.error) return auth.error;
  const url = new URL(request.url);

  if (url.searchParams.get('ping') === '1') {
    return json({ ok: true, ping: true, meta: (await getState(META_KEY, null)) || {} });
  }
  if (url.searchParams.get('wait') === '1') {
    try {
      const meta = await runRefresh();
      return json({ ok: true, msg: `Refreshed ${meta.totalOk ?? 0} ok / ${meta.totalFail ?? 0} fail`, ...meta });
    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, 500);
    }
  }
  after(async () => {
    try {
      await runRefresh();
    } catch (e) {
      console.error('[cron/harmonic-refresh]', e);
    }
  });
  return json({ ok: true, started: true, job: 'harmonic-refresh' });
}

export const POST = GET;
