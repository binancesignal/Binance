import { NextResponse, after } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireSkAccess } from '../../../lib/skSystem/access.js';
import { getState, setState } from '../../../lib/database/appState.js';
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
  revalidateSavedSignal,
} from '../../../lib/scanner/strategy/harmonicScan/index.js';
import { calcEMASeries } from '../../../lib/scanner/indicators.js';
import { pickBestPerCoin } from '../../../lib/scanner/strategy/harmonicScan/categories.js';
import {
  loadSaved,
  mergeScanned,
  removeSaved,
  clearSaved,
  applyRefresh,
  stripHeavy,
  itemId,
  setAdminStatus,
  releaseAdminStatus,
  ADMIN_STATUS_OPTIONS,
} from '../../../lib/harmonicSaved/store.js';
import { triggerAutoTrade } from '../../../lib/trading/triggerAutoTrade.js';
import { getPublicScanState, saveScanSettings } from '../../../lib/harmonicSaved/scanState.js';

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

/** Live mark/last price from ticker map. */
function livePriceFromTickers(tickers, symbol) {
  const t = tickers?.[symbol];
  if (!t) return null;
  const mark = +t.markPrice;
  const last = +t.price;
  if (Number.isFinite(mark) && mark > 0) return { price: mark, priceSource: 'MARK' };
  if (Number.isFinite(last) && last > 0) return { price: last, priceSource: 'LAST' };
  return null;
}

async function enrichItemsWithLivePrices(items) {
  if (!items?.length) return items || [];
  let tickers = null;
  try {
    tickers = await exchange.loadTickers();
  } catch (_) {
    return items;
  }
  const now = Math.floor(Date.now() / 1000);
  return items.map((it) => {
    const sym = cleanSymbol(it.symbol);
    const live = livePriceFromTickers(tickers, sym);
    if (!live) return it;
    return {
      ...it,
      price: live.price,
      marketPrice: live.price,
      priceSource: live.priceSource,
      priceAt: now,
    };
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
      // Cap per-request load (client paces with CHUNK=2) to reduce Binance weight bans
      const symbols = [...new Set((body.symbols || []).map(cleanSymbol).filter(Boolean))].slice(0, 2);
      if (!symbols.length) return json({ error: 'no symbols' }, 400);

      const tfs = (Array.isArray(body.tfs) ? body.tfs : ['15m', '1h']).filter((t) => HS_SCAN_TFS.includes(t));
      if (!tfs.length) return json({ error: 'pick at least one timeframe' }, 400);

      const cfg = normalizeHsScanConfig(body);
      const includeCharts = body.includeCharts !== false;
      const tzMin = Number.isFinite(+body.tzMin) ? +body.tzMin : -new Date().getTimezoneOffset();
      const out = [];
      let banned = false;
      const klineLimit = Math.min(500, Math.max(120, Math.round(+body.klineLimit) || 500));

      for (const symbol of symbols) {
        if (banned) break;
        const perTf = [];
        for (const tf of tfs) {
          try {
            const candles = await exchange.getKlines(symbol, tf, klineLimit);
            const events = findHarmonicEvents(candles, cfg);
            const emaSeries = calcEMASeries(candles, cfg.emaPeriod || 200);
        const ema100Series = calcEMASeries(candles, 100);
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
          ema100Series,
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
              perTf.push({ ...e, symbol, tf, patternTf: tf, bucket, chartSvg, annotations });
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
      // Auto-save every chunk to the database (no manual Save; survives page refresh mid-scan)
      let autoSaved = null;
      if (body.autoSave !== false) {
        try {
          const found = out.flatMap((r) => (r.results || []).filter((x) => !x.error && x.family));
          if (found.length) autoSaved = await mergeScanned(found);
        } catch (e) {
          autoSaved = { error: e.message || String(e) };
        }
      }
      return json({
        ok: true,
        autoSaved,
        results: out,
        stopped: stopped ? (stopped.banned ? 'banned' : 'throttled') : null,
        stoppedError: stopped?.error || null,
        cfg,
      });
    }

    if (body.action === 'list_saved') {
      let items = await loadSaved();
      items = await enrichItemsWithLivePrices(items);
      return json({ ok: true, items, pricesLive: true });
    }

    if (body.action === 'list_live') {
      // Same list the admin "Saved" panel uses — Scanner tab mirrors it
      let items = (await loadSaved()).filter((e) => e && e.symbol && !e.error);
      const ui = (await getState('harmonic_ui_config', null)) || {};
      if (ui.onePerCoin !== false) items = pickBestPerCoin(items);
      items = await enrichItemsWithLivePrices(items);
      const chartMode = ['svg', 'live', 'both'].includes(ui.chartMode) ? ui.chartMode : 'both';
      return json({ ok: true, items, chartMode, pricesLive: true });
    }

    if (body.action === 'render_chart') {
      // Rebuild full harmonic chart (XABCD, D zone, breakers, TP/SL, EMA200) — same as Signals Chart
      const item = body.item && typeof body.item === 'object' ? body.item : null;
      if (!item?.symbol || !item?.tf) return json({ error: 'item.symbol and item.tf required' }, 400);
      const symbol = cleanSymbol(item.symbol);
      const tf = String(item.tf);
      if (!HS_SCAN_TFS.includes(tf)) return json({ error: 'bad timeframe' }, 400);
      let uiCfg = {};
      try {
        uiCfg = (await getState('harmonic_ui_config', null)) || {};
      } catch (_) {}
      const cfg = normalizeHsScanConfig({
        ...uiCfg,
        tfs: uiCfg.tfs,
        enabledFamilies: uiCfg.enabledFamilies,
        ratioRules: uiCfg.ratioRules,
      });
      const tzMin = Number.isFinite(+body.tzMin) ? +body.tzMin : -new Date().getTimezoneOffset();
      try {
        const candles = await exchange.getKlines(symbol, tf, 500);
        const emaSeries = calcEMASeries(candles, cfg.emaPeriod || 200);
        const ema100Series = calcEMASeries(candles, 100);
        const chartSvg = buildHarmonicChartSvg(candles, item, {
          symbol,
          tf,
          tzMin,
          before: 40,
          after: 30,
          emaSeries,
          ema100Series,
        });
        const annotations = buildHarmonicAnnotations(item, candles, { tf });
        return json({
          ok: true,
          symbol,
          tf,
          chartSvg,
          annotations,
          price: candles.length ? +candles[candles.length - 1].close : null,
        });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e).slice(0, 200) }, 500);
      }
    }

    if (body.action === 'save') {
      const item = stripHeavy(body.item);
      if (!item?.symbol || !item?.tf) return json({ error: 'invalid item' }, 400);
      const r = await mergeScanned([item]);
      return json({ ok: true, items: await loadSaved(), id: itemId(item), ...r });
    }

    if (body.action === 'save_batch') {
      const incoming = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      const r = await mergeScanned(incoming);
      return json({ ok: true, items: await loadSaved(), added: r.added, total: r.total });
    }


    if (body.action === 'set_status') {
      // Admin only — change Scanner / live board signal status (WATCHING → IN_TRADE, etc.)
      if (auth.session?.role !== 'admin' && auth.user?.role !== 'admin') {
        return json({ error: 'Admin only' }, 403);
      }
      const id = body.id || body.signalId;
      const status = body.status;
      if (!id || !status) return json({ error: 'id and status required' }, 400);
      try {
        const item = await setAdminStatus(id, status, { outcome: body.outcome });
        // Entry ready ⇄ anything else changes what the bot should hold → run the trader now.
        // For ENTRY_READY wait (max ~25 s) so the admin sees at once WHY an order was or was not placed.
        let trade = null;
        if (item.status === 'ENTRY_READY') {
          trade = await Promise.race([
            triggerAutoTrade('admin-status'),
            new Promise((r) => setTimeout(() => r({ timeout: true }), 25_000)),
          ]);
        } else {
          after(async () => {
            await triggerAutoTrade('admin-status');
          });
        }
        return json({
          ok: true,
          item,
          trade: trade
            ? {
                placed: trade.autoTradesPlaced ?? 0,
                skipped: trade.autoTradesSkipped ?? 0,
                failed: trade.autoTradesFailed ?? 0,
                reasons: (trade.reasons || []).slice(0, 6),
                timeout: !!trade.timeout,
                already: trade.skipped ? trade.reason : null,
                error: trade.error || null,
              }
            : null,
          status: item.status,
          options: ADMIN_STATUS_OPTIONS,
        });
      } catch (e) {
        return json({ error: e.message || 'Failed to set status' }, 400);
      }
    }

    if (body.action === 'release_status') {
      if (auth.session?.role !== 'admin' && auth.user?.role !== 'admin') {
        return json({ error: 'Admin only' }, 403);
      }
      const id = body.id || body.signalId;
      if (!id) return json({ error: 'id required' }, 400);
      try {
        const item = await releaseAdminStatus(id);
        return json({ ok: true, item, status: item.status });
      } catch (e) {
        return json({ error: e.message || 'Failed to release status' }, 400);
      }
    }

    if (body.action === 'unsave') {
      const id = body.id;
      if (!id) return json({ error: 'id required' }, 400);
      return json({ ok: true, items: await removeSaved(id) });
    }

    if (body.action === 'clear_saved') {
      const before = (await loadSaved()).length;
      await clearSaved();
      return json({ ok: true, items: [], cleared: before });
    }

    if (body.action === 'scan_cron_get') {
      return json({ ok: true, state: await getPublicScanState() });
    }

    if (body.action === 'scan_cron_set') {
      const state = await saveScanSettings({
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        tfs: Array.isArray(body.tfs) ? body.tfs.filter((t) => HS_SCAN_TFS.includes(t)) : undefined,
        restMin: body.restMin,
        coinsPerTick: body.coinsPerTick,
        restart: !!body.restart,
      });
      return json({ ok: true, state });
    }

    if (body.action === 'revalidate') {
      const items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
      if (!items.length) return json({ error: 'no items' }, 400);
      const cfg = normalizeHsScanConfig(body);
      let tickers = null;
      try {
        tickers = await exchange.loadTickers();
      } catch (_) {}
      const out = [];
      const now = Math.floor(Date.now() / 1000);
      for (const item of items) {
        const symbol = cleanSymbol(item.symbol);
        const tf = String(item.tf || '15m');
        if (!symbol || !HS_SCAN_TFS.includes(tf)) {
          out.push({ ...item, error: 'bad symbol/tf' });
          continue;
        }
        const live = livePriceFromTickers(tickers, symbol);
        try {
          const candles = await exchange.getKlines(symbol, tf, 1000);
          let updated = revalidateSavedSignal(candles, { ...item, symbol, tf }, cfg);
          if (!updated) {
            // Still push live mark price even if structure remap failed
            updated = {
              ...item,
              symbol,
              tf,
              price: live?.price ?? item.price,
              marketPrice: live?.price ?? item.price,
              priceSource: live?.priceSource || 'CANDLE',
              priceAt: now,
              refreshedAt: now,
              error: 'pattern older than candle window — price updated only',
            };
          } else if (live) {
            updated = {
              ...updated,
              price: live.price,
              marketPrice: live.price,
              priceSource: live.priceSource,
              priceAt: now,
              candleClose: updated.price,
            };
          }
          out.push(updated);
        } catch (err) {
          out.push({
            ...item,
            symbol,
            tf,
            price: live?.price ?? item.price,
            marketPrice: live?.price ?? item.price,
            priceSource: live?.priceSource,
            priceAt: now,
            error: err.message || String(err),
            banned: !!err?.banned,
          });
        }
      }
      // Persist refreshed status fields (no SVG) — merged into the CURRENT list so nothing saved meanwhile is lost
      try {
        const updates = new Map();
        for (const r of out) if (r?.id && !r.error) updates.set(r.id, stripHeavy(r));
        await applyRefresh(updates);
      } catch (_) {}

      return json({ ok: true, results: out });
    }

    if (body.action === 'set_view_prefs') {
      // Lightweight view setting (no side effects on scanner config)
      const prev = (await getState('harmonic_ui_config', null)) || {};
      const next = { ...prev };
      if (typeof body.onePerCoin === 'boolean') next.onePerCoin = body.onePerCoin;
      next.updatedAt = new Date().toISOString();
      await setState('harmonic_ui_config', next);
      return json({ ok: true, onePerCoin: !!next.onePerCoin });
    }

    if (body.action === 'get_cron_secret') {
      const secret = String((await getState('cron_secret', null)) || '').trim();
      return json({ ok: true, secret, set: !!secret });
    }

    if (body.action === 'set_cron_secret') {
      // body.generate = true → random URL-safe secret; otherwise body.secret (admin typed)
      let secret = body.generate ? randomBytes(18).toString('hex') : String(body.secret || '').trim();
      if (secret.length < 12) return json({ error: 'Secret must be at least 12 characters' }, 400);
      if (/\s/.test(secret)) return json({ error: 'Secret cannot contain spaces' }, 400);
      if (!/^[A-Za-z0-9_.~-]+$/.test(secret)) {
        return json({ error: 'Use only letters, numbers and _ . ~ - (so it works safely in a URL)' }, 400);
      }
      await setState('cron_secret', secret);
      return json({ ok: true, secret, set: true });
    }

    if (body.action === 'refresh_meta') {
      const meta = (await getState('harmonic_refresh_meta', null)) || null;
      return json({ ok: true, meta });
    }

    if (body.action === 'get_config') {
      const stored = await getState('harmonic_ui_config', null);
      return json({
        ok: true,
        config: stored && typeof stored === 'object' ? stored : null,
        defaults: HS_SCAN_DEFAULTS,
      });
    }

    if (body.action === 'save_config') {
      const cfg = body.config && typeof body.config === 'object' ? body.config : {};
      const prevUi = (await getState('harmonic_ui_config', null)) || {};
      const clean = {
        tfs: Array.isArray(cfg.tfs) ? cfg.tfs.filter((t) => HS_SCAN_TFS.includes(t)) : ['1h', '4h'],
        enabledFamilies: Array.isArray(cfg.enabledFamilies) ? cfg.enabledFamilies : FAMILY_KEYS,
        ratioRules: cfg.ratioRules && typeof cfg.ratioRules === 'object' ? cfg.ratioRules : DEFAULT_RATIO_RULES,
        includeProjected: cfg.includeProjected !== false,
        includeCompleted: cfg.includeCompleted !== false,
        minScore: Number.isFinite(+cfg.minScore) ? Math.max(30, Math.min(95, Math.round(+cfg.minScore))) : 55,
        preferEma200: !!cfg.preferEma200,
        requireEma200: !!cfg.requireEma200,
        preferBreaker: !!cfg.preferBreaker,
        requireBreaker: !!cfg.requireBreaker,
        requireVolumeNode: cfg.requireVolumeNode === undefined ? !!prevUi.requireVolumeNode : !!cfg.requireVolumeNode,
        enableBreakers: cfg.enableBreakers !== false,
        // X = extreme of the leg filter (a partial save_config call must never silently reset it)
        requireLegX: cfg.requireLegX === undefined ? !!prevUi.requireLegX : !!cfg.requireLegX,
        legLookbackBars: Number.isFinite(+(cfg.legLookbackBars ?? prevUi.legLookbackBars)) ? Math.max(10, Math.min(200, Math.round(+(cfg.legLookbackBars ?? prevUi.legLookbackBars)))) : 40,
        legMinAtr: Number.isFinite(+(cfg.legMinAtr ?? prevUi.legMinAtr)) ? Math.max(0.5, Math.min(20, +(cfg.legMinAtr ?? prevUi.legMinAtr))) : 3,
        onePerCoin: !!cfg.onePerCoin,
        chartMode: ['svg', 'live', 'both'].includes(cfg.chartMode) ? cfg.chartMode : 'both',
        updatedAt: new Date().toISOString(),
      };
      if (!clean.tfs.length) clean.tfs = ['1h'];
      await setState('harmonic_ui_config', clean);
      // Also lock main scanner strategy to harmonic so Start Bot / cron use it
      await setState('strategy_mode', 'harmonic');
      try {
        const prev = (await getState('harmonic_auto', null)) || {};
        await setState('harmonic_auto', { ...prev, enabled: false, updatedAt: new Date().toISOString() });
        await setState('harmonic_auto_enabled', false);
      } catch (_) {}
      // Map UI config → scanner harmonic_config (used by Scan now / cron)
      await setState('harmonic_config', {
        patternTfs: clean.tfs,
        enabledFamilies: clean.enabledFamilies,
        enabledPatterns: Array.isArray(clean.enabledFamilies)
          ? clean.enabledFamilies.flatMap((f) => [`${f}_BULL`, `${f}_BEAR`])
          : undefined,
        minSignalScore: clean.minScore,
        emaCrossConfirm: !!(clean.requireEma200 || clean.preferEma200),
      });
      return json({ ok: true, config: clean, msg: 'Harmonic settings saved to database' });
    }

    if (body.action === 'clear_signals') {
      const { deleteSignalsByStrategy } = await import('../../../lib/database/signals.js');
      const before = (await loadSaved()).length;
      await clearSaved();
      const result = await deleteSignalsByStrategy('all');
      return json({
        ok: true,
        cleared: before,
        deleted: result.deleted,
        errors: result.errors,
        msg: `Cleared ${before} harmonic signal(s) · live board: ${result.deleted} removed`,
      });
    }

    if (body.action === 'get_auto') {
      const { getHarmonicAutoConfig } = await import('../../../lib/scanner/harmonicAuto.js');
      const auto = await getHarmonicAutoConfig();
      return json({ ok: true, auto });
    }

    if (body.action === 'set_auto') {
      const { setHarmonicAutoConfig } = await import('../../../lib/scanner/harmonicAuto.js');
      const auto = await setHarmonicAutoConfig({
        enabled: body.enabled,
        intervalHours: body.intervalHours,
        startHour: body.startHour,
        updateMinutes: body.updateMinutes,
      });
      return json({
        ok: true,
        auto,
        msg: auto.enabled
          ? `Auto ON · SL ${String(auto.startHour).padStart(2, '0')}:00 then every ${auto.intervalHours}h full · update ${auto.updateMinutes}m`
          : 'Auto Scan OFF',
      });
    }

    if (body.action === 'run_auto_tick') {
      // Admin manual kick of one server tick (same as cron)
      const { runHarmonicAutoTick } = await import('../../../lib/scanner/harmonicAuto.js');
      const result = await runHarmonicAutoTick({ budgetMs: 50_000 });
      return json({ ok: true, ...result });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}
