/**
 * SP Breaker + AB=CD — standalone scan API (not Harmonic).
 * Reuses: exchange klines, universe selection, harmonic live board merge (family SP_ABCD).
 */
import { NextResponse } from 'next/server';
import { requireSkAccess } from '../../../lib/skSystem/access.js';
import { getState, setState } from '../../../lib/database/appState.js';
import * as exchange from '../../../lib/exchange/index.js';
import { selectUniverse } from '../../../lib/skSystem/universe.js';
// loadExchangeInfo + loadTickers via exchange
import { runSpAbcdStrategy, normalizeSpAbcdConfig, SP_ABCD_DEFAULTS } from '../../../lib/scanner/strategy/spAbcd/index.js';
import { mergeScanned, loadSaved, stripHeavy } from '../../../lib/harmonicSaved/store.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const CFG_KEY = 'sp_abcd_ui_config';

export async function GET() {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  const cfg = (await getState(CFG_KEY, null)) || {};
  return json({ ok: true, defaults: SP_ABCD_DEFAULTS, config: { ...SP_ABCD_DEFAULTS, ...cfg } });
}

export async function POST(request) {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({}));
  const action = body.action || 'analyze';

  if (action === 'get_config') {
    const cfg = (await getState(CFG_KEY, null)) || {};
    return json({ ok: true, config: normalizeSpAbcdConfig({ ...SP_ABCD_DEFAULTS, ...cfg, enabled: true }) });
  }

  if (action === 'save_config') {
    const next = normalizeSpAbcdConfig({ ...(body.config || {}), enabled: true });
    await setState(CFG_KEY, next);
    return json({ ok: true, config: next });
  }

  if (action === 'universe') {
    // Same path as Harmonic: eligible USDT perps from exchange info + volume rank
    try {
      const clean = (s) => {
        const x = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        return x ? (x.endsWith('USDT') ? x : `${x}USDT`) : '';
      };
      const picked = (Array.isArray(body.symbols) ? body.symbols : String(body.symbols || '').split(/[\s,;]+/))
        .map(clean)
        .filter(Boolean);
      const [eligible, tickers] = await Promise.all([
        exchange.loadExchangeInfo(),
        exchange.loadTickers(),
      ]);
      const eligibleList = Array.isArray(eligible)
        ? eligible
        : Array.isArray(eligible?.symbols)
          ? eligible.symbols
          : [];
      const symbols = selectUniverse({
        mode: body.mode === 'top' ? 'top' : 'all',
        topN: Math.max(1, Math.round(+body.topN || body.limit) || 400),
        ranking: body.ranking || 'volume',
        eligible: eligibleList,
        tickers: tickers || {},
        symbols: picked,
      });
      if (!symbols.length) {
        return json({
          ok: false,
          error: 'No symbols in universe — exchange info empty or filtered out',
          eligibleCount: eligibleList.length,
        }, 400);
      }
      return json({ ok: true, symbols, count: symbols.length, total: symbols.length });
    } catch (e) {
      return json({ error: e.message || 'Universe failed' }, 500);
    }
  }

  if (action === 'analyze') {
    const symbols = Array.isArray(body.symbols)
      ? body.symbols.map((s) => String(s).toUpperCase()).filter(Boolean)
      : [];
    if (!symbols.length) return json({ error: 'symbols required' }, 400);
    const saved = (await getState(CFG_KEY, null)) || {};
    const cfg = normalizeSpAbcdConfig({
      ...SP_ABCD_DEFAULTS,
      ...saved,
      ...(body.config || {}),
      enabled: true,
      timeframes: body.tfs || body.timeframes || saved.timeframes || SP_ABCD_DEFAULTS.timeframes,
    });
    const tfs = cfg.timeframes;
    const out = [];
    let errors = 0;
    const klineLimit = Math.min(500, Math.max(120, Math.round(+body.klineLimit) || 400));

    for (const symbol of symbols.slice(0, 40)) {
      for (const tf of tfs) {
        try {
          const candles = await exchange.getKlines(symbol, tf, klineLimit);
          const events = runSpAbcdStrategy({ symbol, tf, candles, config: cfg });
          for (const e of events) out.push(e);
        } catch (e) {
          errors += 1;
          if (e?.banned) break;
        }
      }
    }

    // Auto-save to live board so Scanner shows them
    let savedInfo = { added: 0 };
    if (out.length && body.autoSave !== false) {
      try {
        savedInfo = await mergeScanned(out.map(stripHeavy));
      } catch (_) {}
    }

    return json({
      ok: true,
      strategy: 'sp_abcd',
      count: out.length,
      errors,
      items: out,
      saved: savedInfo,
      config: cfg,
    });
  }

  if (action === 'list_saved') {
    const items = (await loadSaved()).filter((x) => x.family === 'SP_ABCD' || x.metadata?.strategy === 'sp_abcd');
    return json({ ok: true, items });
  }

  return json({ error: 'Unknown action' }, 400);
}
