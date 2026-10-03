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

    // Chart pattern is checked on every timeframe (5m / 15m / 30m / 1h / 2h)
    const chartPattern = { setups: [], rejected: [] };
    const htfMap = { '5m': '1h', '15m': '1h', '30m': '4h', '1h': '4h', '2h': '4h' };
    for (const tf of ['5m', '15m', '30m', '1h', '2h']) {
      try {
        const patternC = await getKlines(symbol, tf, 120);
        const htfCandles = htfMap[tf] === '4h' ? htfC : obC;
        const r = runChartPatternStrategy({
          symbol,
          patternCandles: patternC,
          htfCandles,
          entryCandles: c5,
          price,
          cfg: { patternTf: tf, htf: htfMap[tf] },
        });
        chartPattern.setups.push(...(r.setups || []));
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
      minScoreThreshold: minScore,
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
