import { NextResponse } from 'next/server';
import { requireSkAccess } from '../../../lib/skSystem/access.js';
import { getState, setState } from '../../../lib/database/appState.js';
import * as exchange from '../../../lib/exchange/index.js';
import { selectUniverse } from '../../../lib/skSystem/universe.js';
import { analyzeFibBreaker } from '../../../lib/fibBreaker/engine.js';
import { FB_CONFIG_KEY, FB_DEFAULTS, FB_STRATEGY_NAME, FB_TFS, validateFbConfig } from '../../../lib/fibBreaker/config.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

async function loadConfig() {
  try {
    return validateFbConfig(await getState(FB_CONFIG_KEY, null)).config;
  } catch (_) {
    return validateFbConfig(null).config;
  }
}
const cleanSymbol = (s) => {
  const x = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return x ? (x.endsWith('USDT') ? x : `${x}USDT`) : '';
};

/** GET — settings · PUT { config } — save (admin only) */
export async function GET() {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  return json({ strategy: FB_STRATEGY_NAME, config: await loadConfig(), defaults: FB_DEFAULTS, tfs: FB_TFS });
}
export async function PUT(request) {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  try {
    const body = await request.json().catch(() => ({}));
    const { config, notes } = validateFbConfig({ ...(await loadConfig()), ...(body.config || {}) });
    await setState(FB_CONFIG_KEY, config);
    return json({ ok: true, config, notes });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

/**
 * POST (admin only)
 *   { action:'universe', mode:'all'|'top'|'pick', topN, ranking, symbols? } → coin list (scanned in small chunks by the client)
 *   { action:'analyze', symbols:[≤3], tfs?, full? }                          → setups + step diagnostics per coin / time frame / direction
 */
export async function POST(request) {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  try {
    const body = await request.json().catch(() => ({}));
    const cfg = await loadConfig();
    if (!cfg.enabled) return json({ error: 'FIB BREAKER is disabled in its settings' }, 409);

    if (body.action === 'universe') {
      const picked = (Array.isArray(body.symbols) ? body.symbols : String(body.symbols || '').split(/[\s,;]+/)).map(cleanSymbol).filter(Boolean);
      const [eligible, tickers] = await Promise.all([exchange.loadExchangeInfo(), exchange.loadTickers()]);
      const symbols = selectUniverse({ mode: body.mode === 'all' ? 'all' : 'top', topN: Math.max(1, Math.round(+body.topN) || 50), ranking: body.ranking || 'volume', eligible, tickers, symbols: picked });
      return json({ ok: true, symbols, total: symbols.length, maxSignals: cfg.maxSignals, tfs: cfg.tfs });
    }

    if (body.action === 'analyze') {
      const symbols = [...new Set((body.symbols || []).map(cleanSymbol).filter(Boolean))].slice(0, 3); // chunk cap = rate-limit protection
      if (!symbols.length) return json({ error: 'no symbols' }, 400);
      const tfs = (Array.isArray(body.tfs) ? body.tfs : cfg.tfs).filter((t) => FB_TFS.includes(t));
      const out = [];
      for (const symbol of symbols) {
        try {
          const res = await analyzeFibBreaker({ symbol, cfg, tfs, getCandles: (tf, limit) => exchange.getKlines(symbol, tf, limit) });
          out.push({ symbol, ok: true, results: res.results.map((r) => ({ tf: r.tf, dir: r.dir, reason: r.reason || null, steps: r.steps || [], analysis: r.analysis ? (body.full || symbols.length === 1 ? r.analysis : { ...r.analysis, annotations: undefined }) : null })) });
        } catch (e) {
          out.push({ symbol, ok: false, error: e?.message || String(e), banned: !!e?.banned, throttled: !!e?.throttled });
          if (e?.banned || e?.throttled) break; // hammering a banned IP only lengthens the ban
        }
      }
      const stopped = out.find((r) => r.banned || r.throttled);
      return json({ ok: true, results: out, stopped: stopped ? (stopped.banned ? 'banned' : 'throttled') : null, stoppedError: stopped?.error || null });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: e?.message || String(e) }, e?.banned || e?.throttled ? 429 : 500);
  }
}
