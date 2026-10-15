import { NextResponse } from 'next/server';
import { getKlines, loadTickers } from '../../../lib/exchange/index.js';
import { scoreSetup } from '../../../lib/scanner/scoreSetup.js';
import { calcATR } from '../../../lib/scanner/indicators.js';
import { SIGNAL_CONFIG } from '../../../lib/config/signalConfig.js';
import { generateSignalChartImage } from '../../../lib/telegram/chart.js';
import { buildChartSvg } from '../../../lib/telegram/chartSvg.js';
import { sendReadyNotification } from '../../../lib/telegram/telegram.js';
import { buildIctChartPreview } from '../../../lib/scanner/ictChart.js';
import { getSignalById } from '../../../lib/database/signals.js';
import { runChartPatternStrategy } from '../../../lib/scanner/strategy/chartPattern/index.js';
import { CHART_PATTERN_CONFIG } from '../../../lib/scanner/strategy/chartPattern/config.js';
import { getState } from '../../../lib/database/appState.js';
import { runZonePatternStrategy } from '../../../lib/scanner/strategy/zonePattern/index.js';
import {
  ZONE_PATTERN_DEFAULTS,
  normalizeZonePatternConfig,
} from '../../../lib/scanner/strategy/zonePattern/config.js';
import { runDoubleConfluencePair } from '../../../lib/scanner/strategy/doubleConfluence/index.js';
import { runEmaBumpPair } from '../../../lib/scanner/strategy/emaBump/index.js';
import { EMA_BUMP_DEFAULTS, normalizeEmaBumpConfig, htfFor } from '../../../lib/scanner/strategy/emaBump/config.js';
import {
  DOUBLE_CONFLUENCE_DEFAULTS,
  normalizeDoubleConfluenceConfig,
} from '../../../lib/scanner/strategy/doubleConfluence/config.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function normalizeSymbol(raw) {
  if (!raw) return null;
  let s = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  if (!s.endsWith('USDT')) s += 'USDT';
  return s;
}

async function respondChart(signal, candles, opts = {}, url) {
  const tf = opts.tf || '15m';
  const htf = opts.htf || '1h';
  if (url.searchParams.get('format') === 'svg') {
    const built = buildChartSvg(signal, candles, { tf, htf, visible: opts.visible || 80 });
    if (!built?.svg) {
      return NextResponse.json(
        { error: 'Not enough closed candles to draw chart.' },
        { status: 422 }
      );
    }
    return new NextResponse(built.svg, {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
  if (url.searchParams.get('format') === 'json') {
    return NextResponse.json(
      {
        status: signal?.status || 'PREVIEW',
        symbol: signal?.symbol,
        strategy: signal?.metadata?.strategy || signal?.strategy,
        price: signal?.current_price ?? signal?.price,
        setup: signal,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }
  if (url.searchParams.get('send') === '1') {
    const sent = await sendReadyNotification(signal);
    return NextResponse.json({ ok: !!sent?.ok, sent });
  }
  const png = await generateSignalChartImage(signal, candles);
  if (!png) {
    return NextResponse.json(
      { error: 'Chart render failed. Try &format=svg to debug drawing.' },
      { status: 500 }
    );
  }
  return new NextResponse(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
  });
}

/**
 * GET /api/chart?symbol=BTC
 * Optional:
 *   &dir=LONG|SHORT
 *   &strategy=ict_smc|chart_pattern|zone_pattern|double_confluence|ema_bump
 *   &timeframe=15m
 *   &signal_id=...  → render stored signal with its own strategy geometry
 *   &format=svg|json
 *   &send=1
 */
export async function GET(request) {
  const url = new URL(request.url);
  const signalId = url.searchParams.get('signal_id');
  const symbol = normalizeSymbol(url.searchParams.get('symbol'));
  const dirWanted = (url.searchParams.get('dir') || '').toUpperCase();
  const strategyWanted = (url.searchParams.get('strategy') || '').toLowerCase();
  const timeframe = (url.searchParams.get('timeframe') || '15m').toLowerCase();

  try {
    // ---- Render from existing signal (correct strategy chart) ----
    if (signalId) {
      const signal = await getSignalById(signalId);
      if (!signal) {
        return NextResponse.json({ error: `Signal ${signalId} not found.` }, { status: 404 });
      }
      const meta = signal.metadata || {};
      const strat = (meta.strategy || signal.strategy || strategyWanted || '').toLowerCase();
      const tf =
        meta.patternTf ||
        meta.setupTf ||
        meta.entryTf ||
        meta.obTf ||
        timeframe ||
        '15m';
      const htf = meta.htf || meta.htfTf || meta.contextTf || '1h';
      const candles = await getKlines(signal.symbol, tf, strat === 'chart_pattern' ? 120 : 100);
      // Ensure strategy on metadata for buildChartSvg
      signal.metadata = { ...meta, strategy: strat || meta.strategy };
      return respondChart(signal, candles, { tf, htf, visible: 90 }, url);
    }

    if (!symbol) {
      return NextResponse.json(
        { error: 'Pass a coin, e.g. /api/chart?symbol=BTC' },
        { status: 400 }
      );
    }

    // ---- Chart Pattern strategy live preview ----
    if (strategyWanted === 'chart_pattern') {
      let chartPatternCfg = { ...CHART_PATTERN_CONFIG };
      try {
        const saved = await getState('chart_pattern_config', null);
        if (saved && typeof saved === 'object') chartPatternCfg = { ...chartPatternCfg, ...saved };
      } catch (_) {}

      const patternTf = ['5m', '15m', '30m', '1h', '2h'].includes(timeframe)
        ? timeframe
        : chartPatternCfg.patternTf || '15m';
      const htfMap = { ...CHART_PATTERN_CONFIG.htfByPatternTf, ...(chartPatternCfg.htfByPatternTf || {}) };
      const htfTf = htfMap[patternTf] || chartPatternCfg.htf || '1h';
      const limit = chartPatternCfg.patternKlineLimit || 120;

      const [patternCandles, htfCandles] = await Promise.all([
        getKlines(symbol, patternTf, limit),
        getKlines(symbol, htfTf, chartPatternCfg.htfKlineLimit || 80),
      ]);
      const tickers = await loadTickers();
      const price = tickers[symbol]?.price || patternCandles[patternCandles.length - 1]?.close;

      const { setups } = runChartPatternStrategy({
        symbol,
        patternCandles,
        htfCandles,
        price,
        cfg: { ...chartPatternCfg, patternTf: patternTf, htf: htfTf },
        includeNear: true,
      });

      let setup = setups?.[0];
      if (dirWanted) {
        setup = (setups || []).find((s) => String(s.dir || s.direction).toUpperCase() === dirWanted) || setup;
      }
      if (!setup) {
        return NextResponse.json(
          { error: `${symbol}: no chart pattern setup on ${patternTf}${dirWanted ? ` (${dirWanted})` : ''}.` },
          { status: 404 }
        );
      }

      const signal = {
        signal_id: `preview_cp_${symbol}`,
        symbol,
        direction: setup.dir || setup.direction,
        status: 'PREVIEW',
        score: setup.score,
        entry: setup.entry,
        sl: setup.sl,
        tp1: setup.tp1,
        tp2: setup.tp2,
        tp3: setup.tp3,
        rr: setup.rr,
        current_price: price,
        price,
        pattern: setup.pattern,
        metadata: {
          ...(setup.metadata || {}),
          strategy: 'chart_pattern',
          patternTf,
          patternGeom: setup.metadata?.patternGeom || setup.patternGeom,
        },
        strategy: 'chart_pattern',
      };
      return respondChart(signal, patternCandles, { tf: patternTf, htf: htfTf, visible: 90 }, url);
    }

    // ---- Zone pattern ----
    if (strategyWanted === 'zone_pattern') {
      let zoneCfg = normalizeZonePatternConfig(ZONE_PATTERN_DEFAULTS);
      try {
        const saved = await getState('zone_pattern_config', null);
        if (saved) zoneCfg = normalizeZonePatternConfig(saved);
      } catch (_) {}
      const setupTf = zoneCfg.setupTf || timeframe || '15m';
      const contextTf = zoneCfg.contextTf || '4h';
      const [setupCandles, contextCandles, weeklyCandles, dailyCandles] = await Promise.all([
        getKlines(symbol, setupTf, zoneCfg.setupLookback || 160),
        getKlines(symbol, contextTf, zoneCfg.contextLookback || 80),
        getKlines(symbol, '1w', zoneCfg.weeklyLookback || 8),
        getKlines(symbol, '1d', zoneCfg.dailyLookback || 30),
      ]);
      const tickers = await loadTickers();
      const price = tickers[symbol]?.price || setupCandles[setupCandles.length - 1]?.close;
      const results = runZonePatternStrategy({
        symbol,
        setupCandles,
        contextCandles,
        weeklyCandles,
        dailyCandles,
        price,
        cfg: zoneCfg,
      });
      let setup = results?.[0];
      if (dirWanted) {
        setup = (results || []).find((s) => String(s.dir).toUpperCase() === dirWanted) || setup;
      }
      if (!setup) {
        return NextResponse.json(
          { error: `${symbol}: no zone+pattern setup right now.` },
          { status: 404 }
        );
      }
      const signal = {
        ...setup,
        signal_id: `preview_zp_${symbol}`,
        status: 'PREVIEW',
        current_price: price,
        price,
        metadata: { ...(setup.metadata || {}), strategy: 'zone_pattern' },
        strategy: 'zone_pattern',
      };
      return respondChart(signal, setupCandles, { tf: setupTf, htf: contextTf, visible: 80 }, url);
    }

    // ---- EMA Bump (live preview) ----
    if (strategyWanted === 'ema_bump') {
      let ebCfg = normalizeEmaBumpConfig(EMA_BUMP_DEFAULTS);
      try {
        const saved = await getState('ema_bump_config', null);
        if (saved) ebCfg = normalizeEmaBumpConfig(saved);
      } catch (_) {}
      const tf = ebCfg.timeframes.includes(timeframe) ? timeframe : ebCfg.timeframes[0] || '15m';
      const candles = await getKlines(symbol, tf, ebCfg.lookback);
      const tickers = await loadTickers();
      const price = tickers[symbol]?.price || candles[candles.length - 1]?.close;
      let htfCandles = null;
      try {
        htfCandles = await getKlines(symbol, htfFor(tf), 120);
      } catch (_) {}
      // reportAll: show the setup even if a HARD gate / score rejects it, so the GATES panel explains why
      const results = runEmaBumpPair({ symbol, price, candles, tf, config: ebCfg, htfCandles, reportAll: true });
      let setup = results?.[0];
      if (dirWanted) setup = (results || []).find((s) => String(s.dir).toUpperCase() === dirWanted) || setup;
      if (!setup) {
        return NextResponse.json({ error: `${symbol}: no EMA bump setup on ${tf} (needs break-up → top → pullback to EMA 50).` }, { status: 404 });
      }
      const signal = {
        ...setup,
        signal_id: `preview_eb_${symbol}`,
        status: 'PREVIEW',
        current_price: price,
        price,
      };
      return respondChart(signal, candles, { tf, htf: tf, visible: 90 }, url);
    }

    // ---- Double confluence ----
    if (strategyWanted === 'double_confluence') {
      let dcCfg = normalizeDoubleConfluenceConfig(DOUBLE_CONFLUENCE_DEFAULTS);
      try {
        const saved = await getState('double_confluence_config', null);
        if (saved) dcCfg = normalizeDoubleConfluenceConfig(saved);
      } catch (_) {}
      const entryTf = timeframe || '15m';
      const htfTf = entryTf === '5m' ? '30m' : entryTf === '15m' ? '1h' : entryTf === '30m' ? '2h' : '4h';
      const [entryCandles, htfCandles] = await Promise.all([
        getKlines(symbol, entryTf, dcCfg.entryLookback || 150),
        getKlines(symbol, htfTf, dcCfg.htfLookback || 100),
      ]);
      const tickers = await loadTickers();
      const price = tickers[symbol]?.price || entryCandles[entryCandles.length - 1]?.close;
      const results = runDoubleConfluencePair({
        symbol,
        price,
        htfCandles,
        entryCandles,
        htf: htfTf,
        entryTf,
        presetLabel: `${htfTf}→${entryTf}`,
        config: dcCfg,
      });
      let setup = results?.[0];
      if (dirWanted) {
        setup = (results || []).find((s) => String(s.dir).toUpperCase() === dirWanted) || setup;
      }
      if (!setup) {
        return NextResponse.json(
          { error: `${symbol}: no double top/bottom confluence on ${entryTf}.` },
          { status: 404 }
        );
      }
      const signal = {
        ...setup,
        signal_id: `preview_dc_${symbol}`,
        status: 'PREVIEW',
        current_price: price,
        price,
      };
      return respondChart(signal, entryCandles, { tf: entryTf, htf: htfTf, visible: 90 }, url);
    }

    // ---- ICT SMC (explicit or default legacy) ----
    if (strategyWanted === 'ict_smc' || strategyWanted === 'smc') {
      if (dirWanted && !['LONG', 'SHORT'].includes(dirWanted)) {
        return NextResponse.json(
          { error: 'Direction must be LONG or SHORT.' },
          { status: 400 }
        );
      }
      const analysis = await buildIctChartPreview(symbol, timeframe, dirWanted);
      if (url.searchParams.get('format') === 'json') {
        return NextResponse.json(
          {
            status: analysis.setup ? 'READY' : 'NO_SETUP',
            symbol: analysis.symbol,
            timeframe: analysis.timeframe,
            higherTimeframe: analysis.higherTimeframe,
            price: analysis.price,
            setup: analysis.setup,
            setups: analysis.setups,
            context: analysis.context,
            candles: analysis.candles,
          },
          { headers: { 'Cache-Control': 'no-store' } }
        );
      }
      if (url.searchParams.get('format') === 'svg') {
        const built = buildChartSvg(analysis.signal, analysis.candles, {
          tf: analysis.timeframe,
          htf: analysis.higherTimeframe,
          visible: 80,
        });
        if (!built?.svg) {
          return NextResponse.json(
            { error: `Not enough closed candles to draw ${symbol}.` },
            { status: 422 }
          );
        }
        return new NextResponse(built.svg, {
          headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-ICT-Status': analysis.setup ? 'READY' : 'NO_SETUP',
            'X-ICT-Price': String(analysis.price),
          },
        });
      }
      if (url.searchParams.get('send') === '1') {
        if (!analysis.setup) {
          return NextResponse.json(
            { error: `${symbol} has no active ICT setup to send right now.` },
            { status: 409 }
          );
        }
        const sent = await sendReadyNotification(analysis.signal);
        return NextResponse.json({ ok: !!sent?.ok, sent });
      }
      const png = await generateSignalChartImage(analysis.signal, analysis.candles);
      if (!png) {
        return NextResponse.json({ error: 'Chart render failed.' }, { status: 500 });
      }
      return new NextResponse(png, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
      });
    }

    // ---- Default: legacy SMC scoreSetup preview ----
    const htf = SIGNAL_CONFIG.htf || '4h';
    const obtf = SIGNAL_CONFIG.obTf || '1h';
    const [htfC, obC, c5] = await Promise.all([
      getKlines(symbol, htf, 80),
      getKlines(symbol, obtf, 100),
      getKlines(symbol, '5m', 40),
    ]);
    const tickers = await loadTickers();
    const price = tickers[symbol]?.price;
    if (!price) {
      return NextResponse.json({ error: `No market data for ${symbol}` }, { status: 404 });
    }
    const results = scoreSetup(symbol, htfC, obC, SIGNAL_CONFIG.entryStyle, 0, price, {
      includeAll: true,
    })
      .filter((r) => !dirWanted || r.dir === dirWanted)
      .sort((a, b) => b.score - a.score);
    const r = results[0];
    if (!r) {
      return NextResponse.json(
        {
          error: `${symbol}: no order-block setup found right now${dirWanted ? ` (${dirWanted})` : ''}.`,
        },
        { status: 404 }
      );
    }
    const atr5m = calcATR(c5, 14);
    const distAbs = Math.abs(price - r.entry);
    const signal = {
      signal_id: `preview_${symbol}`,
      symbol,
      direction: r.dir,
      status: 'PREVIEW',
      score: r.score,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      tp2: r.tp2,
      tp3: r.tp3,
      rr: r.rr,
      current_price: price,
      price,
      conf: r.conf,
      structure: r.structure,
      pd: r.pd,
      rvol: r.rvol,
      fvgs: r.fvgs,
      liq: r.liq,
      ob_low: r.ob?.low,
      ob_high: r.ob?.high,
      atr_5m: atr5m,
      distance_to_entry: distAbs,
      distance_percent: (distAbs / price) * 100,
      atr_distance: atr5m > 0 ? distAbs / atr5m : null,
      metadata: {
        conf: r.conf,
        structure: r.structure,
        ob: r.ob,
        pd: r.pd,
        rvol: r.rvol,
        fvgs: r.fvgs,
        liq: r.liq,
        htf,
        obTf: obtf,
        entryStyle: SIGNAL_CONFIG.entryStyle,
      },
    };
    return respondChart(signal, obC, { tf: obtf, htf, visible: 60 }, url);
  } catch (e) {
    return NextResponse.json(
      { error: e.message },
      { status: Number.isInteger(e?.status) ? e.status : 500 }
    );
  }
}
