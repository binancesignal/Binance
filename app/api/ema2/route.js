import { NextResponse } from 'next/server';
import { requireSkAccess } from '../../../lib/skSystem/access.js';
import * as exchange from '../../../lib/exchange/index.js';
import { selectUniverse } from '../../../lib/skSystem/universe.js';
import {
  findEma2Events,
  normalizeEma2Config,
  EMA2_TFS,
  computeEmas,
  buildEma2ChartSvg,
} from '../../../lib/scanner/strategy/ema2/index.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

const cleanSymbol = (s) => {
  const x = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return x ? (x.endsWith('USDT') ? x : `${x}USDT`) : '';
};

const DEFAULT_CFG = {
  windowBars: 5,
  mode: 'fast',
  direction: 'BOTH',
  forwardBars: 20,
  maxTouchBars: 120,
  requireApproachSide: true,
  minBarsAfterCross: 1,
};

/**
 * GET — available timeframes + defaults
 * POST
 *   { action:'universe', mode:'all'|'top'|'pick', topN, ranking, symbols? }
 *   { action:'analyze', symbols:[≤3], tfs?, cfg?, includeCharts? }
 */
export async function GET() {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  return json({
    strategy: 'EMA 2 Strategy',
    tfs: EMA2_TFS,
    defaults: DEFAULT_CFG,
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
      return json({ ok: true, symbols, total: symbols.length, tfs: EMA2_TFS });
    }

    if (body.action === 'analyze') {
      const symbols = [...new Set((body.symbols || []).map(cleanSymbol).filter(Boolean))].slice(0, 3);
      if (!symbols.length) return json({ error: 'no symbols' }, 400);

      const tfs = (Array.isArray(body.tfs) ? body.tfs : ['15m', '30m', '1h']).filter((t) => EMA2_TFS.includes(t));
      if (!tfs.length) return json({ error: 'pick at least one timeframe' }, 400);

      const cfg = normalizeEma2Config({ ...DEFAULT_CFG, ...(body.cfg || body) });
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
            const events = findEma2Events(candles, cfg);
            const emas = computeEmas(candles, cfg);
            // Prefer recent events; keep both TOUCHED and PENDING
            const recent = events
              .slice()
              .sort((a, b) => b.time - a.time)
              .slice(0, 8);

            for (const e of recent) {
              let chartSvg = null;
              if (includeCharts) {
                try {
                  chartSvg = buildEma2ChartSvg(candles, e, emas, {
                    symbol,
                    tf,
                    tzMin,
                    before: 90,
                    after: 45,
                  });
                } catch (_) {}
              }
              perTf.push({
                tf,
                dir: e.dir,
                status: e.status,
                bucket: e.status === 'TOUCHED' ? 'entry_ready' : 'waiting',
                time: e.time,
                crossTime: e.crossTime || e.time,
                crossPrice: e.crossPrice ?? e.price,
                price: e.price,
                pairsCrossed: e.pairsCrossed,
                crosses: e.crosses,
                touch: e.touch,
                barsAfterCross: e.barsAfterCross,
                outcome: e.outcome,
                retPct: e.retPct,
                mfePct: e.mfePct,
                maePct: e.maePct,
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
