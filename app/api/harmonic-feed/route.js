/**
 * Public Harmonic feed for the Scanner tab (every user with an active trial / plan, plus admin).
 * READ ONLY and database-only: it never calls Binance for the list, so many users can poll it
 * without any API-ban risk. The server crons keep the data fresh:
 *   /api/cron/harmonic-scan     → finds new signals (chunked full scan)
 *   /api/cron/harmonic-refresh  → updates status / TP / SL / live price of every live signal
 */
import { NextResponse } from 'next/server';
import { requireSkReadAccess } from '../../../lib/skSystem/access.js';
import { getState } from '../../../lib/database/appState.js';
import * as exchange from '../../../lib/exchange/index.js';
import {
  buildHarmonicChartSvg,
  buildHarmonicAnnotations,
  normalizeHsScanConfig,
  HS_SCAN_TFS,
} from '../../../lib/scanner/strategy/harmonicScan/index.js';
import { calcEMASeries } from '../../../lib/scanner/indicators.js';
import { loadSavedDoc, toPublicItem } from '../../../lib/harmonicSaved/store.js';
import { getPublicScanState } from '../../../lib/harmonicSaved/scanState.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

const MAX_ITEMS = 400;
const CHART_TTL_MS = 120_000;
const chartCache = new Map(); // id|refreshedAt → { at, data }  (protects Binance from many users opening charts)

export async function POST(request) {
  const auth = await requireSkReadAccess();
  if (auth.error) return auth.error;

  try {
    const body = await request.json().catch(() => ({}));

    if (body.action === 'render_chart') {
      const id = String(body.id || '');
      if (!id) return json({ error: 'id required' }, 400);
      const doc = await loadSavedDoc();
      const item = (doc.items || []).find((x) => x.id === id);
      if (!item) return json({ ok: false, error: 'Signal not found (it may have been cleared)' }, 404);

      const ck = `${id}|${item.refreshedAt || 0}`;
      const hit = chartCache.get(ck);
      if (hit && Date.now() - hit.at < CHART_TTL_MS) return json({ ok: true, ...hit.data, cached: true });

      const tf = String(item.tf);
      if (!HS_SCAN_TFS.includes(tf)) return json({ ok: false, error: 'bad timeframe' }, 400);
      const ui = (await getState('harmonic_ui_config', null)) || {};
      const cfg = normalizeHsScanConfig({ ...ui });
      const tzMin = Number.isFinite(+body.tzMin) ? +body.tzMin : 0;
      try {
        const candles = await exchange.getKlines(item.symbol, tf, 500);
        const emaSeries = calcEMASeries(candles, cfg.emaPeriod || 200);
        const chartSvg = buildHarmonicChartSvg(candles, item, {
          symbol: item.symbol,
          tf,
          tzMin,
          before: 40,
          after: 30,
          emaSeries,
        });
        const annotations = buildHarmonicAnnotations(item, candles, { tf });
        const data = { chartSvg, annotations };
        chartCache.set(ck, { at: Date.now(), data });
        if (chartCache.size > 120) chartCache.delete(chartCache.keys().next().value);
        return json({ ok: true, ...data });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e).slice(0, 160) }, 502);
      }
    }

    // default: list
    const doc = await loadSavedDoc();
    const stamp = doc.updatedAt || null;
    let scan = null;
    let refreshAt = null;
    try {
      const st = await getPublicScanState();
      scan = { enabled: st.enabled, status: st.status, pass: st.pass, lastPass: st.lastPass, lastTickAt: st.lastTickAt };
    } catch (_) {}
    try {
      refreshAt = ((await getState('harmonic_refresh_meta', null)) || {}).at || null;
    } catch (_) {}
    if (body.since && stamp && body.since === stamp && !body.force) {
      return json({ ok: true, notModified: true, updatedAt: stamp, scan, refreshAt });
    }
    const ui = (await getState('harmonic_ui_config', null)) || {};
    const items = (doc.items || [])
      .filter((e) => e && e.symbol && e.tf)
      .slice(0, MAX_ITEMS)
      .map(toPublicItem);
    return json({
      ok: true,
      items,
      updatedAt: stamp,
      onePerCoin: ui.onePerCoin !== false,
      chartMode: ['svg', 'live', 'both'].includes(ui.chartMode) ? ui.chartMode : 'both',
      isAdmin: !!auth.isAdmin,
      scan,
      refreshAt,
    });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}
