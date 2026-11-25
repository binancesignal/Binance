import { NextResponse } from 'next/server';
import { requireSkAccess } from '../../../lib/skSystem/access.js';
import { getState, setState } from '../../../lib/database/appState.js';
import * as exchange from '../../../lib/exchange/index.js';
import { selectUniverse } from '../../../lib/skSystem/universe.js';
import { analyzePoiSymbol } from '../../../lib/poiSystem/engine.js';
import { replayBacktest } from '../../../lib/poiSystem/backtest.js';
import { POI_CONFIG_KEY, POI_DEFAULTS, POI_WEIGHTS_DEFAULT, POI_STRATEGY_NAME, validatePoiConfig } from '../../../lib/poiSystem/config.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function loadPoiConfig() {
  try {
    return validatePoiConfig(await getState(POI_CONFIG_KEY, null)).config;
  } catch (_) {
    return validatePoiConfig(null).config;
  }
}

const cleanSymbol = (s) => {
  const x = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return x ? (x.endsWith('USDT') ? x : `${x}USDT`) : '';
};

/** one coin → every analysis result (diagnostics included). A data / ban failure is reported, never hidden as "no setup". */
async function analyzeOne(symbol, cfg, { full = false } = {}) {
  try {
    const res = await analyzePoiSymbol({ symbol, cfg, getCandles: (tf, limit) => exchange.getKlines(symbol, tf, limit) });
    return {
      symbol,
      ok: true,
      results: res.results.map((r) => ({
        dir: r.dir,
        reason: r.reason || null,
        diagnostics: r.diagnostics || r.analysis?.diagnostics || [],
        analysis: r.analysis ? (full ? r.analysis : { ...r.analysis, annotations: undefined }) : null,
      })),
    };
  } catch (e) {
    return { symbol, ok: false, error: e?.message || String(e), banned: !!e?.banned, throttled: !!e?.throttled };
  }
}

/** GET — settings (admin only) */
export async function GET() {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  return json({ strategy: POI_STRATEGY_NAME, config: await loadPoiConfig(), defaults: POI_DEFAULTS, weightsDefault: POI_WEIGHTS_DEFAULT });
}

/** PUT { config } — validated + saved (admin only) */
export async function PUT(request) {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  try {
    const body = await request.json().catch(() => ({}));
    const { config, notes } = validatePoiConfig({ ...(await loadPoiConfig()), ...(body.config || {}) });
    await setState(POI_CONFIG_KEY, config);
    return json({ ok: true, config, notes });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

/**
 * POST (admin only)
 *   { action:'universe', mode:'all'|'top', topN, ranking, symbols? }  → the coin list to scan (the client scans it in small chunks)
 *   { action:'analyze', symbols:[…≤ 4], full? }                       → analysis + diagnostics for those coins
 *   { action:'backtest', symbol, days?, step? }                       → walk-forward paper replay with fees + slippage
 */
export async function POST(request) {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  try {
    const body = await request.json().catch(() => ({}));
    const cfg = await loadPoiConfig();
    if (!cfg.enabled) return json({ error: 'ICT / SMC POI strategy is disabled in Admin → Strategy settings' }, 409);

    if (body.action === 'universe') {
      const picked = (Array.isArray(body.symbols) ? body.symbols : String(body.symbols || '').split(/[\s,;]+/)).map(cleanSymbol).filter(Boolean);
      const [eligible, tickers] = await Promise.all([exchange.loadExchangeInfo(), exchange.loadTickers()]);
      const symbols = selectUniverse({ mode: body.mode === 'all' ? 'all' : 'top', topN: Math.max(1, Math.round(+body.topN) || 50), ranking: body.ranking || 'volume', eligible, tickers, symbols: picked });
      return json({ ok: true, symbols, total: symbols.length, maxSignals: cfg.maxSignals, skipped: picked.filter((s) => !symbols.includes(s)) });
    }

    if (body.action === 'analyze') {
      const symbols = [...new Set((body.symbols || []).map(cleanSymbol).filter(Boolean))].slice(0, 4); // chunk size cap = rate-limit protection
      if (!symbols.length) return json({ error: 'no symbols' }, 400);
      const out = [];
      for (const s of symbols) {
        const r = await analyzeOne(s, cfg, { full: !!body.full || symbols.length === 1 });
        out.push(r);
        if (r.banned || r.throttled) break; // stop at once: hammering a banned IP only lengthens the ban
      }
      const stopped = out.find((r) => r.banned || r.throttled);
      return json({ ok: true, results: out, stopped: stopped ? (stopped.banned ? 'banned' : 'throttled') : null, stoppedError: stopped?.error || null });
    }

    if (body.action === 'backtest') {
      const symbol = cleanSymbol(body.symbol);
      if (!symbol) return json({ error: 'symbol required' }, 400);
      const lim = { '1d': 400, '4h': 1000, '1h': 1500, '30m': 1500, '15m': 1500 };
      const candles = {};
      for (const tf of Object.keys(lim)) candles[tf] = (await exchange.getKlines(symbol, tf, lim[tf])).map((c) => ({ time: +c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume || 0 }));
      const m15 = candles['15m'];
      // the engine needs ~700 × 15M bars of history before the first replayed step
      const firstOk = m15[Math.min(m15.length - 1, 720)]?.time;
      const days = Math.max(1, Math.min(8, +body.days || 5));
      const toSec = m15[m15.length - 1].time;
      const fromSec = Math.max(firstOk, toSec - days * 86400);
      const res = await replayBacktest({ symbol, candles, cfg, fromSec, toSec, stepSec: Math.max(900, Math.round((+body.step || 7200) / 900) * 900) });
      return json({ ok: true, ...res, from: fromSec, to: toSec, signals: res.signals.slice(-50), trades: res.trades.slice(-50) });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: e?.message || String(e), banned: !!e?.banned, throttled: !!e?.throttled }, e?.banned || e?.throttled ? 429 : 500);
  }
}
