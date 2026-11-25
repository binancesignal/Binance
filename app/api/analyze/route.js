import { NextResponse } from 'next/server';
import {
  loadExchangeInfo,
  loadTickers,
  getKlines,
} from '../../../lib/exchange/index.js';
import { runChartPatternStrategy } from '../../../lib/scanner/strategy/chartPattern/index.js';
import {
  calcATR,
  calcEMA,
  calcRSI,
  relativeVolume,
  premiumDiscount,
  findSwings,
} from '../../../lib/scanner/indicators.js';
import { detectStructure } from '../../../lib/scanner/structure.js';
import { detectOrderBlocks } from '../../../lib/scanner/orderBlocks.js';
import { detectFVGs } from '../../../lib/scanner/fvg.js';
import { detectLiquidity } from '../../../lib/scanner/liquidity.js';
import { SIGNAL_CONFIG } from '../../../lib/config/signalConfig.js';
import { getState } from '../../../lib/database/appState.js';
import { CHART_PATTERN_CONFIG } from '../../../lib/scanner/strategy/chartPattern/config.js';
import { RECOMMENDED_SCANNER_SETTINGS } from '../../../lib/config/recommendedScannerSettings.js';
import { resolveGateConfig, GATE_DEFS, isHard } from '../../../lib/scanner/strategy/chartPattern/gates.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // single symbol — always fast, well under Hobby's 60s

function normalizeSymbol(raw) {
  if (!raw) return null;
  let s = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  if (!s.endsWith('USDT')) s += 'USDT';
  return s;
}

// GET /api/analyze?symbol=BTC (or BTCUSDT) — runs the exact same strategy
// used by the scanner against one coin, on demand, and returns full detail
// (including setups that scored BELOW the qualifying threshold) so you can
// see exactly why a coin does or doesn't produce a signal right now.
export async function GET(request) {
  const url = new URL(request.url);
  const symbol = normalizeSymbol(url.searchParams.get('symbol'));

  if (!symbol) {
    return NextResponse.json(
      { error: 'Pass a coin symbol, e.g. ?symbol=BTC or ?symbol=BTCUSDT' },
      { status: 400 }
    );
  }

  try {
    const validSymbols = await loadExchangeInfo();
    if (!validSymbols.includes(symbol)) {
      return NextResponse.json(
        { error: `${symbol} is not a live USDT perpetual on Binance Futures.` },
        { status: 404 }
      );
    }

    const tickers = await loadTickers();
    const price = tickers[symbol]?.price;
    if (!price) {
      return NextResponse.json(
        { error: `No live price for ${symbol} right now.` },
        { status: 404 }
      );
    }

    const htf = SIGNAL_CONFIG.htf;
    const obtf = SIGNAL_CONFIG.obTf;
    const entryStyle = SIGNAL_CONFIG.entryStyle;
    const minScore = SIGNAL_CONFIG.minScore;

    const [htfC, obC, c5] = await Promise.all([
      getKlines(symbol, htf, 120),
      getKlines(symbol, obtf, 150),
      getKlines(symbol, '5m', 50),
    ]);
    const atr5m = calcATR(c5, 14);

    // Strategy 1 (SMC) removed — only the Chart Pattern strategy is analysed.
    const setups = [];

    // Use the SAME saved admin settings as the scanner (gate modes, min score, timeframes),
    // otherwise HARD gates (e.g. Elliott Wave) and the min score are silently ignored here.
    let savedCfg = null;
    try {
      const cpc = await getState('chart_pattern_config', null);
      if (cpc && typeof cpc === 'object') savedCfg = cpc;
    } catch (_) {}
    const baseCfg = savedCfg || { ...RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig };
    const effCfg = resolveGateConfig(CHART_PATTERN_CONFIG, baseCfg);
    const gateSummary = GATE_DEFS.map((g) => ({
      key: g.key,
      label: g.label,
      mode: isHard(effCfg, g.key) ? 'hard' : 'soft',
    }));

    // Chart pattern is checked on every timeframe selected in admin
    const chartPattern = { setups: [], near: [], rejected: [] };
    const htfMap = { ...CHART_PATTERN_CONFIG.htfByPatternTf, ...(baseCfg.htfByPatternTf || {}) };
    const ALLOWED_TFS = ['5m', '15m', '30m', '1h', '2h', '4h', '1d'];
    let tfs = (Array.isArray(baseCfg.patternTfs) && baseCfg.patternTfs.length
      ? baseCfg.patternTfs
      : CHART_PATTERN_CONFIG.patternTfs || ['15m']
    ).filter((t) => ALLOWED_TFS.includes(t));
    if (!tfs.length) tfs = ['15m'];
    for (const tf of tfs) {
      try {
        const patternC = await getKlines(symbol, tf, baseCfg.patternKlineLimit || 120);
        const htfTf = htfMap[tf] || '1h';
        const htfCandles = htfTf === '4h' ? htfC : htfTf === '1h' ? obC : await getKlines(symbol, htfTf, 80);
        const r = runChartPatternStrategy({
          symbol,
          patternCandles: patternC,
          htfCandles,
          entryCandles: c5,
          price,
          includeNear: true,
          cfg: { ...baseCfg, patternTf: tf, htf: htfTf },
        });
        chartPattern.setups.push(...(r.setups || []));
        chartPattern.near.push(...(r.near || []));
        for (const x of r.rejected || []) chartPattern.rejected.push({ ...x, reason: `[${tf}] ${x.reason}` });
      } catch (cpe) {
        chartPattern.rejected.push({ reason: `[${tf}] ${cpe.message}` });
      }
    }
    chartPattern.setups.sort((x, y) => y.score - x.score);

    // Broader market context, independent of whether any order block
    // qualified — useful to see WHY nothing (or something) showed up.
    const structure = detectStructure(htfC);
    const obs = detectOrderBlocks(obC);
    const fvgs = detectFVGs(obC);
    const swings = findSwings(obC);
    const liq = detectLiquidity(obC, swings);
    const pd = premiumDiscount(obC);
    const rvol = relativeVolume(obC);
    const ema20 = calcEMA(obC, 20);
    const rsi = calcRSI(obC);

    return NextResponse.json({
      symbol,
      price,
      atr5m,
      timeframes: { htf, obtf, entryTf: SIGNAL_CONFIG.entryTf },
      minScoreThreshold: effCfg.minSignalScore ?? minScore,
      gateModes: gateSummary,
      context: {
        structure,
        premiumDiscount: pd,
        relativeVolume: rvol,
        ema20,
        rsi,
        orderBlocksFound: obs.length,
        fvgsFound: fvgs.length,
        liquidity: liq,
      },
      setups: setups.sort((a, b) => b.score - a.score),
      chartPattern: {
        setups: chartPattern.setups || [],
        near: chartPattern.near || [],
        rejected: (chartPattern.rejected || []).slice(0, 20),
        summary:
          (chartPattern.setups || []).length > 0
            ? chartPattern.setups[0]
            : null,
      },
    });
  } catch (e) {
    console.error('[analyze]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
