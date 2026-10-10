/**
 * EMA Bump strategy — config & normaliser.
 *
 * Setup (LONG; SHORT is the exact mirror), EMA 20 = red, EMA 50 = orange:
 *   1. Price comes from BELOW both EMAs (real down-move, dip under them).
 *   2. It breaks UP through the red EMA 20 and then the orange EMA 50 and pushes a little higher.
 *   3. That push forms a TOP (swing high). The top's HIGH is the entry level.
 *   4. Price reverses and PULLS BACK to touch the orange EMA 50. It may also touch the red EMA 20,
 *      but no candle may BREAK and CLOSE below the red EMA 20 on this time frame.
 *   5. -> signal is READY. When price later breaks the top's high -> ONGOING (entry).
 *
 * The admin picks which time frames are scanned; every selected TF is scanned independently.
 */

export const ALL_TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];

export const EMA_BUMP_DEFAULTS = {
  enabled: true,

  // Time frames to scan (admin selects). Each is evaluated on its own candles.
  timeframes: ['15m'],
  lookback: 160, // candles fetched per TF

  // EMAs
  fastPeriod: 20,
  slowPeriod: 50,

  // Prior trend (the move that preceded the bump)
  minTrendBars: 8, // bars with fast < slow (LONG) inside trendWindow, before the break-up
  trendWindow: 40,
  slowSlopeBars: 10, // EMA slow must be falling / flat over this many bars at the break-up
  slowFlatTolATR: 0.15, // "flat" tolerance: slow may have risen by at most this many ATR

  // The dip + break-up
  minDepthATR: 1.5, // deepest low must be this far below the slow EMA
  depthWindow: 45, // dip -> now must fit in this many bars

  // The top (bump high) and the pullback
  minBumpATR: 0.3, // top must reach at least this far above EMA 50
  maxBumpATR: 4.0, // ...but "only a little" - not a huge rally
  minPullBars: 2, // bars between the top and now (a real reversal)
  maxTopAgeBars: 40, // top must be at most this old
  touchTolATR: 0.1, // wick within this of the EMA counts as a touch
  maxTouchAgeBars: 15, // the EMA 50 touch must have happened within this many bars
  allowCloseBelowFast: false, // false = ANY close beyond EMA 20 after the top kills the setup

  // EMA shape (right now)
  maxGapATR: 2.0, // |slow - fast| must be within this many ATR
  allowRecentCross: true, // fast may have already crossed above slow...
  maxBarsSinceCross: 10, // ...but not longer ago than this

  // Entry / risk
  entryBufferATR: 0, // extra ATR added beyond the top high (0 = exactly the high)
  slBufferATR: 0.2, // SL = pullback low - this
  minStopATR: 0.5,
  maxStopATR: 5.0,
  tp1R: 1.2,
  tp2R: 2.0,
  tp3R: 3.0,
  minRR: 1.0,
  maxEntryDistanceATR: 3.0, // live price may be at most this far from the entry (TF ATR)

  // Direction filter
  allowLong: true,
  allowShort: true,

  minScore: 70,
  atrPeriod: 14,

  // ---- GATES (each: 'off' | 'soft' | 'hard'; unset = the gate's default below) ----
  // hard = setup REJECTED when the check fails · soft = only costs SOFT_PENALTY score points
  gateModes: {},
  volumeMinRvol: 1.2, // volume gate: trigger-candle RVOL
  rsiMax: 70, // rsi gate: bull-side RSI must not be above this (no chasing an overbought bump)
  rsiMin: 30, // rsi gate: ... and not below this
  locationMaxPos: 0.6, // location gate: price position in the last-50 range (0 = bottom, 1 = top)
  chopWindow: 30, // chop gate: look-back bars
  chopMaxCrosses: 2, // chop gate: max fast/slow EMA crosses inside the window
  pullbackVolMax: 1.0, // pullback-volume gate: pullback avg volume must be <= this x the bump avg volume
  riskMinPercent: 0.25, // risk gate: stop distance in % of entry (fees eat tiny stops)
  riskMaxPercent: 8,
};

export const SOFT_PENALTY = 6;

/** Gates that fit this strategy (modes: off | soft | hard). */
export const EMA_BUMP_GATES = [
  { key: 'htf', label: 'HTF trend', hint: 'Higher TF must not be in a clear trend against the trade', def: 'hard' },
  { key: 'volume', label: 'Bump volume (RVOL)', hint: 'Volume of the bump leg (up to the top) ≥ RVOL threshold', def: 'hard' },
  { key: 'chop', label: 'No chop', hint: 'EMA 20/50 crossed too many times lately = sideways noise', def: 'hard' },
  { key: 'reaction', label: 'EMA 50 reaction', hint: 'Last closed candle already closed back above the EMA 50 (bounce started)', def: 'soft' },
  { key: 'pullbackVol', label: 'Quiet pullback', hint: 'Pullback volume lower than the bump volume (healthy retrace)', def: 'soft' },
  { key: 'rsi', label: 'RSI turn', hint: 'RSI turning up off the pullback low, not overbought/oversold', def: 'soft' },
  { key: 'rsiDiv', label: 'RSI divergence', hint: 'Divergence at the dip (bullish for LONG, bearish for SHORT)', def: 'off' },
  { key: 'smc', label: 'Liquidity sweep / FVG', hint: 'Dip swept a prior swing extreme, or a fresh FVG formed', def: 'soft' },
  { key: 'location', label: 'Location', hint: 'Not buying at the top of the range / not shorting at the bottom', def: 'soft' },
  { key: 'blockedPath', label: 'Blocked path to TP1', hint: 'Opposing swing between entry and TP1', def: 'soft' },
  { key: 'risk', label: 'Stop size (%)', hint: 'Stop distance between min and max % of entry', def: 'soft' },
];

export function gateMode(cfg, key) {
  const m = cfg?.gateModes?.[key];
  if (m === 'off' || m === 'soft' || m === 'hard') return m;
  return EMA_BUMP_GATES.find((g) => g.key === key)?.def || 'off';
}

/** Higher time frame used by the HTF gate. */
export const HTF_BY_TF = {
  '1m': '5m', '3m': '15m', '5m': '30m', '15m': '1h', '30m': '2h', '1h': '4h',
  '2h': '4h', '4h': '1d', '6h': '1d', '12h': '1d', '1d': '1w',
};
export const htfFor = (tf) => HTF_BY_TF[tf] || '1h';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export function normalizeEmaBumpConfig(input = {}) {
  const supplied = input && typeof input === 'object' ? input : {};
  const cfg = { ...EMA_BUMP_DEFAULTS };
  for (const key of Object.keys(EMA_BUMP_DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(supplied, key)) cfg[key] = supplied[key];
  }

  cfg.timeframes = Array.isArray(cfg.timeframes)
    ? [...new Set(cfg.timeframes.map(String).filter((tf) => ALL_TFS.includes(tf)))]
    : [...EMA_BUMP_DEFAULTS.timeframes];
  if (!cfg.timeframes.length) cfg.timeframes = [...EMA_BUMP_DEFAULTS.timeframes];

  const floats = [
    ['slowFlatTolATR', 0, 2],
    ['minDepthATR', 0, 10],
    ['minBumpATR', 0, 5],
    ['maxBumpATR', 0.5, 15],
    ['touchTolATR', 0, 1],
    ['pullbackVolMax', 0.1, 5],
    ['maxGapATR', 0.1, 8],
    ['volumeMinRvol', 0, 10],
    ['rsiMax', 50, 100],
    ['rsiMin', 0, 50],
    ['locationMaxPos', 0.1, 1],
    ['riskMinPercent', 0, 10],
    ['riskMaxPercent', 0.5, 50],
    ['entryBufferATR', 0, 1],
    ['slBufferATR', 0, 2],
    ['minStopATR', 0.1, 5],
    ['maxStopATR', 0.5, 15],
    ['tp1R', 0.5, 10],
    ['tp2R', 1, 15],
    ['tp3R', 1.5, 25],
    ['minRR', 0.5, 5],
    ['maxEntryDistanceATR', 0.2, 10],
  ];
  for (const [k, min, max] of floats) {
    const n = +cfg[k];
    cfg[k] = Number.isFinite(n) ? clamp(n, min, max) : EMA_BUMP_DEFAULTS[k];
  }

  const ints = [
    ['lookback', 100, 400],
    ['fastPeriod', 5, 60],
    ['slowPeriod', 10, 200],
    ['minTrendBars', 2, 40],
    ['trendWindow', 10, 120],
    ['slowSlopeBars', 3, 40],
    ['depthWindow', 10, 120],
    ['minPullBars', 1, 20],
    ['maxTopAgeBars', 5, 150],
    ['maxTouchAgeBars', 1, 60],
    ['maxBarsSinceCross', 1, 30],
    ['minScore', 30, 100],
    ['chopWindow', 10, 100],
    ['chopMaxCrosses', 0, 20],
    ['atrPeriod', 7, 28],
  ];
  for (const [k, min, max] of ints) {
    const n = Math.round(+cfg[k]);
    cfg[k] = Number.isFinite(n) ? clamp(n, min, max) : EMA_BUMP_DEFAULTS[k];
  }

  for (const key of ['enabled', 'allowRecentCross', 'allowCloseBelowFast', 'allowLong', 'allowShort']) {
    cfg[key] = typeof cfg[key] === 'boolean' ? cfg[key] : EMA_BUMP_DEFAULTS[key];
  }

  const modes = {};
  for (const g of EMA_BUMP_GATES) {
    const v = cfg.gateModes && typeof cfg.gateModes === 'object' ? cfg.gateModes[g.key] : undefined;
    if (v === 'off' || v === 'soft' || v === 'hard') modes[g.key] = v;
  }
  cfg.gateModes = modes;
  if (cfg.riskMaxPercent < cfg.riskMinPercent) cfg.riskMaxPercent = cfg.riskMinPercent;

  if (cfg.slowPeriod <= cfg.fastPeriod) cfg.slowPeriod = cfg.fastPeriod + 10;
  if (cfg.maxBumpATR < cfg.minBumpATR) cfg.maxBumpATR = cfg.minBumpATR;
  if (cfg.maxStopATR < cfg.minStopATR) cfg.maxStopATR = cfg.minStopATR;
  if (cfg.tp2R < cfg.tp1R) cfg.tp2R = cfg.tp1R;
  if (cfg.tp3R < cfg.tp2R) cfg.tp3R = cfg.tp2R;
  return cfg;
}
