import { NextResponse } from 'next/server';
import { requireSkAccess } from '../../../lib/skSystem/access.js';
import * as exchange from '../../../lib/exchange/index.js';
import { selectUniverse } from '../../../lib/skSystem/universe.js';
import {
  findHarmonicEvents,
  normalizeHsScanConfig,
  HS_SCAN_TFS,
  HS_SCAN_DEFAULTS,
  DEFAULT_RATIO_RULES,
  FAMILY_KEYS,
  buildHarmonicChartSvg,
  buildHarmonicAnnotations,
} from '../../../lib/scanner/strategy/harmonicScan/index.js';
import { calcEMASeries } from '../../../lib/scanner/indicators.js';

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
  return json({
    strategy: 'Harmonic Patterns',
    tfs: HS_SCAN_TFS,
    defaults: HS_SCAN_DEFAULTS,
    ratioRules: DEFAULT_RATIO_RULES,
    families: FAMILY_KEYS,
  });
}

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
      return json({ ok: true, symbols, total: symbols.length, tfs: HS_SCAN_TFS });
    }

    if (body.action === 'analyze') {
      const symbols = [...new Set((body.symbols || []).map(cleanSymbol).filter(Boolean))].slice(0, 3);
      if (!symbols.length) return json({ error: 'no symbols' }, 400);

      const tfs = (Array.isArray(body.tfs) ? body.tfs : ['15m', '1h']).filter((t) => HS_SCAN_TFS.includes(t));
      if (!tfs.length) return json({ error: 'pick at least one timeframe' }, 400);

      const cfg = normalizeHsScanConfig(body);
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
            const events = findHarmonicEvents(candles, cfg);
            const emaSeries = calcEMASeries(candles, cfg.emaPeriod || 200);
            for (const e of events.slice(0, 10)) {
              let chartSvg = null;
              let annotations = [];
              if (includeCharts) {
                try {
                  chartSvg = buildHarmonicChartSvg(candles, e, {
                    symbol,
                    tf,
                    tzMin,
                    before: 40,
                    after: 30,
                    emaSeries,
                  });
                } catch (_) {}
                try {
                  annotations = buildHarmonicAnnotations(e, candles, { tf });
                } catch (_) {}
              }
              const bucket =
                e.status === 'ENTRY_READY'
                  ? 'entry_ready'
                  : e.status === 'WAITING'
                    ? 'waiting'
                    : e.status === 'FORMED'
                      ? 'formed'
                      : 'all';
              perTf.push({ tf, ...e, bucket, chartSvg, annotations });
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
