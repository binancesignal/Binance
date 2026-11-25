/**
 * ABCD + SP breaker — standalone scan API (not under Harmonic settings).
 * Reuses: exchange universe, klines, merge into live Scanner board.
 * Strategy logic: findAbcdSpEvents (unchanged).
 */
import { NextResponse } from 'next/server';
import { requireSkAccess } from '../../../lib/skSystem/access.js';
import { getState, setState } from '../../../lib/database/appState.js';
import * as exchange from '../../../lib/exchange/index.js';
import { selectUniverse } from '../../../lib/skSystem/universe.js';
import {
  runAbcdSpStrategy,
  defaultAbcdSpConfig,
  EXTRA_DEFAULTS,
  normalizeExtraConfig,
} from '../../../lib/scanner/strategy/abcdSp/index.js';
import { mergeScanned, loadSaved, stripHeavy } from '../../../lib/harmonicSaved/store.js';
import { HS_SCAN_TFS } from '../../../lib/scanner/strategy/harmonicScan/index.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const CFG_KEY = 'abcd_sp_ui_config';

const cleanSymbol = (s) => {
  const x = String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return x ? (x.endsWith('USDT') ? x : `${x}USDT`) : '';
};

export async function GET() {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  const cfg = (await getState(CFG_KEY, null)) || {};
  return json({
    ok: true,
    defaults: EXTRA_DEFAULTS.abcd,
    config: { ...EXTRA_DEFAULTS.abcd, ...cfg.abcd, ...(cfg || {}) },
    tfs: HS_SCAN_TFS,
  });
}

export async function POST(request) {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({}));
  const action = body.action || 'analyze';

  if (action === 'get_config') {
    const saved = (await getState(CFG_KEY, null)) || {};
    const norm = normalizeExtraConfig({ enableAbcdSp: true, abcd: { ...EXTRA_DEFAULTS.abcd, ...(saved.abcd || saved) } });
    return json({
      ok: true,
      config: { ...norm.abcd, timeframes: saved.timeframes || ['15m', '1h', '4h'] },
    });
  }

  if (action === 'save_config') {
    const abcd = normalizeExtraConfig({
      enableAbcdSp: true,
      abcd: { ...EXTRA_DEFAULTS.abcd, ...(body.config || {}) },
    }).abcd;
    const timeframes = Array.isArray(body.config?.timeframes)
      ? body.config.timeframes
      : body.timeframes || ['15m', '1h', '4h'];
    await setState(CFG_KEY, { abcd, timeframes });
    return json({ ok: true, config: { ...abcd, timeframes } });
  }

  if (action === 'universe') {
    // Identical path to Harmonic Patterns universe
    try {
      const picked = (Array.isArray(body.symbols) ? body.symbols : String(body.symbols || '').split(/[\s,;]+/))
        .map(cleanSymbol)
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
        return json(
          {
            ok: false,
            error: 'No symbols in universe — exchange info empty',
            eligibleCount: eligibleList.length,
          },
          400
        );
      }
      return json({ ok: true, symbols, count: symbols.length, total: symbols.length, tfs: HS_SCAN_TFS });
    } catch (e) {
      return json({ error: e.message || 'Universe failed' }, 500);
    }
  }

  if (action === 'analyze') {
    const symbols = [...new Set((body.symbols || []).map(cleanSymbol).filter(Boolean))].slice(0, 8);
    if (!symbols.length) return json({ error: 'no symbols' }, 400);
    const saved = (await getState(CFG_KEY, null)) || {};
    const abcd = normalizeExtraConfig({
      enableAbcdSp: true,
      abcd: { ...EXTRA_DEFAULTS.abcd, ...(saved.abcd || {}), ...(body.config || {}) },
    }).abcd;
    const tfs = (Array.isArray(body.tfs) ? body.tfs : saved.timeframes || ['15m', '1h', '4h']).filter((t) =>
      HS_SCAN_TFS.includes(t)
    );
    if (!tfs.length) return json({ error: 'pick at least one timeframe' }, 400);

    const out = [];
    let errors = 0;
    const diag = { symbols: 0, tfs: tfs.length, patterns: 0, events: 0, sample: [] };
    const klineLimit = Math.min(500, Math.max(120, Math.round(+body.klineLimit) || 400));

    // Optional deep stats (first symbol only) so admin can see where filters drop setups
    let { abcdPatterns } = {};
    try {
      ({ abcdPatterns } = await import('../../../lib/scanner/strategy/harmonicScan/extraStrategies.js'));
    } catch (_) {}

    for (const symbol of symbols) {
      diag.symbols += 1;
      for (const tf of tfs) {
        try {
          const candles = await exchange.getKlines(symbol, tf, klineLimit);
          if (abcdPatterns && diag.sample.length < 6) {
            try {
              const pats = abcdPatterns(candles.slice(0, -1), abcd) || [];
              diag.patterns += pats.length;
              if (pats.length) {
                diag.sample.push({
                  symbol,
                  tf,
                  patterns: pats.length,
                  forms: pats.slice(0, 3).map((p) => p.form),
                });
              }
            } catch (_) {}
          }
          const events = runAbcdSpStrategy({ symbol, tf, candles, config: abcd });
          for (const e of events) out.push(e);
        } catch (e) {
          errors += 1;
          if (e?.banned) break;
        }
      }
    }
    diag.events = out.length;

    let savedInfo = { added: 0 };
    if (out.length && body.autoSave !== false) {
      try {
        savedInfo = await mergeScanned(out.map(stripHeavy));
      } catch (_) {}
    }

    return json({
      ok: true,
      strategy: 'ABCD_SP',
      count: out.length,
      errors,
      items: out,
      saved: savedInfo,
      diag,
      configUsed: abcd,
    });
  }

  if (action === 'list_saved') {
    const items = (await loadSaved()).filter(
      (x) => x.family === 'ABCD_SP' || x.strategy === 'ABCD_SP' || x.metadata?.strategy === 'abcd_sp'
    );
    return json({ ok: true, items });
  }

  return json({ error: 'Unknown action' }, 400);
}
