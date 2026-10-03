/**
 * Architecture:
 *   JOB A — NEW SIGNAL SCANNER: rotating chunk (top 250 / ~15 per run)
 *   JOB B — ACTIVE SIGNAL MONITOR: all WATCHING/READY/ONGOING every cron
 *
 * NEW signal qualification:
 *   score >= minScore
 *   minEntryDistanceATR <= dist/ATR <= maxEntryDistanceATR
 *   not entry-hit / valid RR
 *
 * Telegram LIMIT ORDER READY only when dist/ATR <= telegramMaxDistanceATR
 * (or later when lifecycle reaches READY). Far WATCHING signals stay silent.
 */
export const SIGNAL_CONFIG = {
  // Active exchange: 'binance' | 'bybit' (override via dashboard app_state)
  defaultExchange: 'binance',

  minScore: 80,

  // Too close → cannot place limit in time
  minEntryDistanceATR: 0.75,
  // Too far → entry may take weeks; clutter dashboard + Telegram
  maxEntryDistanceATR: 4,

  // Only alert Telegram when this close (or closer)
  telegramMaxDistanceATR: 2,

  // Max Market↔Entry gap in % — e.g. 3 means reject if gap > 3%
  // Far setups are NOT stored; later scan can create when gap improves
  maxGapPercent: 3,

  htf: '4h',  // bias — still intraday swings
  obTf: '1h',
  setupTf: '15m',
  entryTf: '5m',
  entryStyle: 'conservative',

  // Quality gates for NEW signals (fewer, higher-odds)
  requireHtfAligned: true,      // HTF bias/BOS/CHOCH must match direction
  requireLiquidityEdge: true,   // near liq pool OR equal H/L OR sweep
  requireSweepOrFvg: true,      // stricter: sweep OR FVG required (fewer SL traps)
  requireDisplacementOrOte: true, // displacement OR Fib OTE OR RSI div
  requireStrongSetup: false,    // if true: only strongSetup quality trades

  // Extra confluence (boost score, not hard gates):
  // Fib OTE 0.618–0.786, RSI divergence, Double Top/Bottom, HH-HL / LH-LL
  confluenceEnabled: true,


  // Intraday: TP1 at least ~2% move; reject tiny OB risk
  minRiskPercent: 1.0,   // Entry↔SL min % — wider than noise
  minRiskATR: 0.6,       // risk must be >= 0.6 × ATR (anti-wick)
  minTp1Percent: 2.0,    // TP1 at least this % from entry
  slBufferPercent: 0.25, // SL beyond OB by at least 0.25% of price
  slBufferATR: 0.35,     // and/or 0.35 × OB-TF ATR
  tp1R: 1.8,
  tp2R: 3.0,
  tp3R: 4.5,

  readyDistanceATR: 0.5,
  entryToleranceATR: 0.15,
  minReadyDistancePct: 0.05,
  maxReadyDistancePct: 1.5,

  maxSignalAgeHours: 24,

  // Entry-time re-validation (lifecycle + auto-trade)
  entryQualityRevalidate: true,
  entryQualityScoreDropTolerance: 15,


  scanIntervalMinutes: 1,
  batchSize: 5,
  batchPauseMs: 60,

  // 'all' = every USDT perpetual on the active exchange (Binance or Bybit, separately).
  // A number (e.g. 250) limits to top-N by 24h volume.
  scanUniverse: 'all',
  scanChunkSize: 15,

  htfKlineLimit: 80,
  obKlineLimit: 100,
  atrKlineLimit: 30,

  persistSignals: true,
  skipLifecycle: false,

  telegramOnLiveClose: true,
  telegramLiveMaxPerScan: 5,
  telegramLiveMaxAtr: 2,

  maxWatchingSignals: 200,
  maxReadySignals: 100,
  maxOngoingSignals: 100,
  maxHistorySignals: 200,

  binanceBaseUrl: process.env.BINANCE_API_BASE_URL || 'https://fapi.binance.com',
  klineCacheMs: 60000,
};

export const SIGNAL_STATUS = {
  WATCHING: 'WATCHING',
  READY: 'READY',
  ONGOING: 'ONGOING',
  COMPLETED_PROFIT: 'COMPLETED_PROFIT',
  STOPPED: 'STOPPED',
  INVALIDATED: 'INVALIDATED',
};

export const ALLOWED_TRANSITIONS = {
  WATCHING: ['READY', 'INVALIDATED'],
  READY: ['ONGOING', 'INVALIDATED'],
  ONGOING: ['COMPLETED_PROFIT', 'STOPPED'],
  COMPLETED_PROFIT: [],
  STOPPED: [],
  INVALIDATED: [],
};

export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}
