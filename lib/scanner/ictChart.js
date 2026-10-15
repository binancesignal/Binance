import { SIGNAL_CONFIG } from '../config/signalConfig.js';
import { getKlines, loadExchangeInfo, loadTickers } from '../exchange/index.js';
import { getState } from '../database/appState.js';
import {
  calcATR,
  calcEMA,
  calcRSI,
  findSwings,
  premiumDiscount,
  relativeVolume,
} from './indicators.js';
import { detectFVGs } from './fvg.js';
import { detectLiquidity } from './liquidity.js';
import { detectOrderBlocks } from './orderBlocks.js';
import { detectStructure } from './structure.js';
import { runIctSmcStrategy } from './strategy/ictSmc/index.js';

const TIMEFRAME_SECONDS = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14400,
  '6h': 21600,
  '12h': 43200,
  '1d': 86400,
};

function defaultHigherTimeframe(timeframe) {
  if (timeframe === '5m') return '1h';
  if (timeframe === '15m') return '1h';
  if (timeframe === '30m') return '2h';
  if (timeframe === '1h') return '4h';
  if (timeframe === '2h') return '4h';
  return '1d';
}

function validHigherTimeframe(timeframe, config) {
  const configured = String(config?.htfTf || '');
  if (
    ['1h', '2h', '4h'].includes(configured) &&
    TIMEFRAME_SECONDS[configured] > TIMEFRAME_SECONDS[timeframe]
  ) {
    return configured;
  }
  return defaultHigherTimeframe(timeframe);
}

export async function buildIctChartPreview(symbol, timeframe = '15m', direction = '') {
  const supportedTimeframes = ['5m', '15m', '30m', '1h', '2h', '4h'];
  if (!supportedTimeframes.includes(timeframe)) {
    throw Object.assign(new Error('Timeframe must be 5m, 15m, 30m, 1h, 2h, or 4h.'), {
      status: 400,
    });
  }

  const validSymbols = await loadExchangeInfo();
  if (!validSymbols.includes(symbol)) {
    throw Object.assign(new Error(`${symbol} is not a live USDT perpetual on the active exchange.`), {
      status: 404,
    });
  }

  let config = {};
  try {
    config = (await getState('smc_config', null)) || {};
  } catch (_) {}

  const higherTimeframe = validHigherTimeframe(timeframe, config);
  const [candles, higherCandles, fiveMinuteCandles, tickers] = await Promise.all([
    getKlines(symbol, timeframe, 150),
    getKlines(symbol, higherTimeframe, 100),
    getKlines(symbol, '5m', 50),
    loadTickers(),
  ]);
  const price = +tickers?.[symbol]?.price || candles[candles.length - 1]?.close;
  if (!candles?.length || !price) {
    throw Object.assign(new Error(`No market data is available for ${symbol}.`), {
      status: 404,
    });
  }

  const setups = runIctSmcStrategy({
    symbol,
    setupCandles: candles,
    htfCandles: higherCandles,
    price,
    cfg: config,
    setupTf: timeframe,
    htfTf: higherTimeframe,
  });
  const matchingSetups = setups
    .filter((candidate) => !direction || candidate.dir === direction)
    .sort((a, b) => b.score - a.score);
  const setup = matchingSetups[0] || null;

  const structure = detectStructure(higherCandles);
  const swings = findSwings(candles, 2, 2);
  const contextualOrderBlocks = detectOrderBlocks(candles);
  const contextualFvgs = detectFVGs(candles);
  const contextualLiquidity = detectLiquidity(candles, swings);
  const premiumDiscountContext = premiumDiscount(candles);
  const atr5m = calcATR(fiveMinuteCandles, 14);
  const higherBias = structure.bias || 'neutral';

  const signal = {
    signal_id: `preview_${symbol}_${timeframe}`,
    symbol,
    direction: setup?.dir || (higherBias === 'bearish' ? 'SHORT' : 'LONG'),
    status: setup ? 'PREVIEW' : 'NO_SETUP',
    score: setup?.score ?? null,
    entry: setup?.entry ?? null,
    sl: setup?.sl ?? null,
    tp1: setup?.tp1 ?? null,
    tp2: setup?.tp2 ?? null,
    tp3: setup?.tp3 ?? null,
    rr: setup?.rr ?? null,
    current_price: price,
    price,
    conf: setup?.conf || [],
    structure: setup?.structure || structure,
    pd: setup?.pd || premiumDiscountContext,
    rvol: setup?.rvol ?? relativeVolume(candles),
    fvgs: setup?.fvgs || contextualFvgs,
    liq: setup?.liq || contextualLiquidity,
    ob_low: setup?.ob?.low ?? contextualOrderBlocks[0]?.low ?? null,
    ob_high: setup?.ob?.high ?? contextualOrderBlocks[0]?.high ?? null,
    atr_5m: atr5m,
    metadata: {
      ...(setup?.metadata || {}),
      strategy: 'ict_smc',
      patternTf: timeframe,
      htf: higherTimeframe,
      obTf: timeframe,
      entryStyle: SIGNAL_CONFIG.entryStyle,
      conf: setup?.conf || [],
      structure: setup?.structure || structure,
      ob: setup?.ob || contextualOrderBlocks[0] || null,
      pd: setup?.pd || premiumDiscountContext,
      rvol: setup?.rvol ?? relativeVolume(candles),
      fvgs: setup?.fvgs || contextualFvgs,
      liq: setup?.liq || contextualLiquidity,
      ictAnalysis: setup?.metadata?.ictAnalysis || null,
    },
  };

  return {
    symbol,
    timeframe,
    higherTimeframe,
    price,
    atr5m,
    candles,
    setups,
    setup,
    signal,
    context: {
      structure,
      premiumDiscount: premiumDiscountContext,
      relativeVolume: relativeVolume(candles),
      ema20: calcEMA(candles, 20),
      rsi: calcRSI(candles),
      orderBlocks: contextualOrderBlocks,
      fvgs: contextualFvgs,
      liquidity: contextualLiquidity,
    },
  };
}