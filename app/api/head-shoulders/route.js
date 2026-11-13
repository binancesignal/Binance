import { NextResponse } from 'next/server';
import { requireSkAccess } from '../../../lib/skSystem/access.js';
import * as exchange from '../../../lib/exchange/index.js';
import { selectUniverse } from '../../../lib/skSystem/universe.js';
import {
  findHeadShoulders,
  normalizeHsConfig,
  HS_TFS,
  buildHsChartSvg,
  HS_DEFAULTS,
} from '../../../lib/scanner/strategy/headShoulders/index.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

const cleanSymbol = (s) => {
  const x = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return x ? (x.endsWith('USDT') ? x : `${x}USDT`) : '';
};

export async function GET() {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  return json({ strategy: 'Head & Shoulders', tfs: HS_TFS, defaults: HS_DEFAULTS });
}

/**
 * POST
 *   { action:'universe', mode:'all'|'top'|'pick', topN, ranking, symbols? }
 *   { action:'analyze', symbols:[≤3], tfs?, requireAboveEma?, includeInverse?, ...cfg }
 */
export async function POST(request) {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;

  try {
    const body = await request.json().catch(() => ({}));

    if (body.action === 'universe') {
      const picked = (Array.isArray(body.symbols) ? body.symbols : String(body.symbols || '').split(/[\s,;]+/))
        .map(cleanSymbol)
        .filter(Boolean);
      const [eligible, tickers] = await Promise.all([exchange.loadExchangeInfo(), exchange.loadTickers()]);
      const symbols = selectUniverse({
        mode: body.mode === 'all' ? 'all' : 'top',
        topN: Math.max(1, Math.round(+body.topN) || 50),
        ranking: body.ranking || 'volume',
        eligible,
        tickers,
        symbols: picked,
      });
      return json({ ok: true, symbols, total: symbols.length, tfs: HS_TFS });
    }

    if (body.action === 'analyze') {
      const symbols = [...new Set((body.symbols || []).map(cleanSymbol).filter(Boolean))].slice(0, 3);
      if (!symbols.length) return json({ error: 'no symbols' }, 400);

      const tfs = (Array.isArray(body.tfs) ? body.tfs : ['15m', '30m', '1h']).filter((t) => HS_TFS.includes(t));
      if (!tfs.length) return json({ error: 'pick at least one timeframe' }, 400);

      const cfg = normalizeHsConfig(body);
      const includeCharts = body.includeCharts !== false;
      const tzMin = Number.isFinite(+body.tzMin) ? +body.tzMin : -new Date().getTimezoneOffset();
      const out = [];
      let banned = false;

      for (const symbol of symbols) {
        if (banned) break;
        const perTf = [];
        for (const tf of tfs) {
          try {
            const candles = await exchange.getKlines(symbol, tf, 1000);
            const events = findHeadShoulders(candles, cfg);
            for (const e of events.slice(0, 6)) {
              let chartSvg = null;
              if (includeCharts) {
                try {
                  chartSvg = buildHsChartSvg(candles, e, {
                    symbol,
                    tf,
                    tzMin,
                    emaPeriod: cfg.emaPeriod,
                    before: 50,
                    after: 35,
                  });
                } catch (_) {}
              }
              perTf.push({
                tf,
                ...e,
                bucket:
                  e.status === 'BREAKOUT' ? 'entry_ready' : e.status === 'AT_NECK' ? 'waiting' : 'formed',
                chartSvg,
              });
            }
          } catch (err) {
            if (err?.banned || err?.throttled) {
              banned = true;
              perTf.push({ tf, error: err.message, banned: !!err.banned, throttled: !!err.throttled });
              break;
            }
            perTf.push({ tf, error: err.message || String(err) });
          }
        }
        out.push({ symbol, ok: true, results: perTf });
      }

      const stopped = out.flatMap((r) => r.results || []).find((x) => x.banned || x.throttled);
      return json({
        ok: true,
        results: out,
        stopped: stopped ? (stopped.banned ? 'banned' : 'throttled') : null,
        stoppedError: stopped?.error || null,
        cfg,
      });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}
