/** Chart Pattern Breakout — independent of SMC strategy config */
export const CHART_PATTERN_CONFIG = {
  enabled: true,

  htf: '1h',
  patternTf: '15m', // fallback single TF
  // Timeframes scanned for patterns (each symbol is checked on every TF listed).
  // Allowed: 5m, 15m, 30m, 1h, 2h, 4h, 1d. Changeable from the dashboard.
  patternTfs: ['15m', '30m', '1h'],
  // Higher-timeframe bias used for each pattern TF
  htfByPatternTf: {
    '5m': '1h',
    '15m': '1h',
    '30m': '4h',
    '1h': '4h',
    '2h': '4h',
    '4h': '1d',
    '1d': '1w',
  },
  entryTf: '5m',

  // Which pattern types to evaluate. 'ALL' or string[] of patternType keys.
  // Dashboard multi-select writes this; empty / missing = ALL.
  enabledPatterns: 'ALL',

  // Harmonic completion
  harmonicMaxAgeBars: 8,
  harmonicPrzATR: 0.35,

  // Price-action / wave patterns (QM, 1-2-3, Wyckoff, liquidity sweep, breakout+retest, ABC, Elliott)
  paMaxAgeBars: 8, // bars since the pattern's trigger point
  paBreakMaxAgeBars: 2, // 1-2-3: the break of point 2 must be this fresh
  paZoneATR: 0.35, // retest-zone padding

  htfKlineLimit: 80,
  patternKlineLimit: 120,
  entryKlineLimit: 40,

  requireCandleClose: true,
  breakoutAtrMin: 0.15,
  maxBreakoutDistanceATR: 1.8,
  requireVolumeConfirmation: false,
  minRelativeVolume: 1.2, // contributes to score without blocking by itself
  requireRetest: false,
  breakoutConfirmationCandles: 1,
  requireFreshBreakout: true, // first close beyond the level only (no stale / repeat signals)
  minBodyRatio: 0.45,

  minPatternScore: 40,
  minSignalScore: 55,
  minRR: 1.2, // measured-move reward/risk floor
  // TP1 reward:risk floor. TP1 = entry ± max(height*0.5, risk), so TP1 RR is never below 1.0.
  // Pattern signals use this (1.0) — NOT the 1.2 SMC entry-quality floor.
  minTp1RR: 1.0,
  // Keep confirmations measurable, but avoid requiring every confluence source.
  // Soft gates reduce score; TP/RR and the pillar floor remain hard checks.
  gateModes: {
    htf: 'soft',
    volume: 'soft',
    retest: 'soft',
    pillars: 'soft',
    smc: 'soft',
    fib: 'soft',
    rejectionZone: 'soft',
    rejection: 'soft',
    location: 'soft',
    midRange: 'soft',
    wave: 'soft',
    blockedPath: 'soft',
    tp1rr: 'hard',
    tp2rr: 'hard',
    rsiDiv: 'soft',
    ema: 'soft',
  },
  // RSI divergence gate (period 14 on pattern TF)
  requireRsiDivergence: false,
  rsiPeriod: 14,
  // EMA trend gate: EMA(fast) vs EMA(slow) + price side
  requireEmaAlign: false,
  emaFast: 21,
  emaSlow: 50,
  // Near-breakout signals: go ONGOING + market order the moment LIVE price crosses entry
  // (SHORT: price <= entry, LONG: price >= entry). false = wait for candle-close confirmation.
  nearEntryOnLivePrice: false,
  // When a WATCHING near-setup already CLOSED beyond the level but failed strict breakout
  // filters (min ATR distance, body, RVOL…), promote to READY instead of "Breakout missed".
  // Still invalidates: opposite-side failure, already chased past weakBreakoutMaxChaseR.
  // Pair with nearEntryOnLivePrice for touch-entry after promote.
  weakBreakoutPromote: false,
  /** Max R already moved past entry before we refuse the weak promote (0.35 = 0.35R) */
  weakBreakoutMaxChaseR: 0.35,
  // Confirmed breakout (READY): invalidate when a CLOSED candle closes back inside the pattern
  failedBreakoutInvalidate: true,
  // "ATR line": ONE close this many ATR back inside the level = clear fake → invalidate.
  failedBreakoutBufferATR: 0.5,
  // Shallower closes (retest noise) only invalidate after this many CONSECUTIVE closes back inside.
  failedBreakoutConfirmCandles: 2,

  requireFibConfluence: false,
  fibTolerancePercent: 0.5,
  fibScoreBoost: 10,

  requireHtfAlign: false,
  requireSmcConfluence: false, // hard-require SMC confluence (sweep / OB at base / FVG)
  // Quality gate: pillars = HTF aligned + SMC confluence + Fib confluence. Need at least N of 3.
  minConfluencePillars: 1,
  rejectBlockedPath: false, // true = drop setups with an opposing OB / swing extreme before TP1

  // Stop loss: structural stop, capped so a wide pattern does not wreck R:R
  slAtrBuffer: 0.35,
  maxSlATR: 1.8, // max distance entry → SL in ATR
  slBelowLevelATR: 0.5, // SL always at least this far behind the broken level
  minPatternHeightATR: 0.8,
  minTouches: 2,
  maxLineDeviationATR: 0.45, // swing points must sit this close to the fitted trendline

  // ---- Pre-breakout radar ("about to break") — used by MANUAL Scan Now only ----
  // Patterns that are fully formed and price is sitting right at the boundary,
  // but no valid breakout candle has CLOSED yet. Not stored, no Telegram, no auto-trade.
  nearBreakoutEnabled: true,
  nearMaxGapATR: 0.6, // price must be within this many ATR of the boundary (still inside pattern)
  nearLivePastATR: 0.5, // forming candle already this far beyond level → 'BREAKING NOW' (awaiting close)
  nearMaxPatternAge: 30, // pattern must have ended within this many candles
  // ---- Stale rescue (admin ON/OFF) ----
  // The age limit above is a blunt clock: a still-valid setup sitting right at its level got killed
  // as "Near setup stale" and often broke out in profit afterwards. With rescue ON, an ALREADY
  // TRACKED (WATCHING) setup is only declared stale when it is really dead:
  //   • older than nearStaleRescueMaxAge candles (hard cap, 0 = no cap), OR
  //   • older than nearMaxPatternAge AND price drifted > nearStaleRescueMaxGapATR from the level.
  // Opposite-side failure / "already closed beyond level" still invalidate immediately.
  // New radar detections keep the strict nearMaxPatternAge. OFF = old behaviour.
  nearStaleRescue: true,
  nearStaleRescueMaxAge: 150,
  nearStaleRescueMaxGapATR: 1.5,
  nearMinScore: 45, // readiness score floor (breakout-candle points are not included)
  nearRequireHtfAlign: false,
  nearMinPillars: 1, // confluence pillars needed (real signals need minConfluencePillars)

  // Scoring weights (sum ~100 max conceptual)
  weights: {
    patternQuality: 20,
    cleanLevels: 6,
    touches: 10,
    breakoutCandle: 10,
    volume: 15,
    htf: 10,
    smc: 16, // sweep 6 · OB at base 5 · FVG 3 · LTF BOS 2 (blockers subtract)
    fib: 10, // retracement match 5-7 · extension target 3
    retest: 3,
  },

  // ---- Universal Pattern + Confluence + Elliott Wave Engine ----
  // When enabled, every pattern is evaluated through the full context pipeline
  // (location → confluence cluster → liquidity → rejection → structure → EW → risk).
  // Existing breakout + SMC + Fib path is preserved; this layer adds quality gates.
  universalEngineEnabled: true,

  // Minimum scores (0-100) for the universal engine quality gates
  minFinalScore: 55,
  minPatternScore: 40,
  minLocationScore: 40,
  minRejectionScore: 25,
  minWaveScore: 0,           // 0 = optional; raise to require reliable EW context
  minIndependentCategories: 2,

  // Hard requirements (false = soft boost only)
  requireLiquiditySweep: false,
  requireHtfZone: false,
  requireLtfConfirmation: false,
  requireFibConfluenceUniversal: false,
  requireElliottWave: false,
  alternativeWavePenalty: true,

  // ===== REVERSAL patterns: rejection zone is MANDATORY =====
  // Double Top / Triple Top / H&S / Rising Wedge etc. MUST sit at a
  // meaningful confluence zone (OB + Fib + S/R / liquidity). Bare geometry = reject.
  requireRejectionZone: true,          // hard gate for all REVERSAL setups
  requireStructuralZone: true,         // zone must include OB or Fib or equal H/L / swing
  minReversalZoneScore: 35,
  minReversalLocationScore: 45,
  requireRejection: true,              // rejection event score gate

  // Location / zone filters
  maxZoneDistanceATR: 1.5,
  maxZoneRetests: 3,
  zoneFreshnessRequired: false,
  midRangeRejectionFilter: true,   // penalize / reject mid-range patterns
  breakoutRetestRequirement: false,
  fakeoutConfirmationRequirement: true,
  sequenceConfirmationRequirement: false,

  // Elliott Wave
  waveAnalysisEnabled: false,
  waveAnalysisTimeframe: 'pattern', // 'pattern' | 'htf'

  // Universal score weights (used by evaluateUniversalSetup)
  universalWeights: {
    pattern: 15,
    location: 20,
    liquidity: 15,
    rejection: 15,
    structure: 15,
    wave: 10,
    momentum: 5,
    risk: 3,
    path: 2,
  },
};

/** All patternType keys produced by detectPatterns() — used by UI multi-select */
export const CHART_PATTERN_TYPES = [
  'DOUBLE_TOP', 'DOUBLE_BOTTOM', 'TRIPLE_TOP', 'TRIPLE_BOTTOM',
  'HEAD_AND_SHOULDERS', 'INVERSE_HEAD_AND_SHOULDERS',
  'RECTANGLE',
  'ASCENDING_TRIANGLE', 'DESCENDING_TRIANGLE', 'SYMMETRICAL_TRIANGLE',
  'RISING_WEDGE', 'FALLING_WEDGE',
  'BULL_FLAG', 'BEAR_FLAG',
  'CUP_AND_HANDLE', 'INVERSE_CUP_AND_HANDLE',
  'ROUNDING_BOTTOM', 'ROUNDING_TOP',
  'BROADENING', 'ASCENDING_BROADENING_WEDGE', 'DESCENDING_BROADENING_WEDGE',
  'BULL_PENNANT', 'BEAR_PENNANT',
  'HORIZONTAL_CHANNEL', 'ASCENDING_CHANNEL', 'DESCENDING_CHANNEL',
  'DIAMOND_TOP', 'DIAMOND_BOTTOM',
  // Harmonics (bull + bear)
  'GARTLEY_BULL', 'GARTLEY_BEAR',
  'BAT_BULL', 'BAT_BEAR',
  'ALT_BAT_BULL', 'ALT_BAT_BEAR',
  'BUTTERFLY_BULL', 'BUTTERFLY_BEAR',
  'CRAB_BULL', 'CRAB_BEAR',
  'DEEP_CRAB_BULL', 'DEEP_CRAB_BEAR',
  'CYPHER_BULL', 'CYPHER_BEAR',
  'SHARK_BULL', 'SHARK_BEAR',
  'ABCD_BULL', 'ABCD_BEAR',
  'FIVE_O_BULL', 'FIVE_O_BEAR',
  // Reversal families added later
  'THREE_DRIVES_BULL', 'THREE_DRIVES_BEAR',
  'WOLFE_WAVE_BULL', 'WOLFE_WAVE_BEAR',
  // Price-action & wave patterns
  'QUASIMODO_BULL', 'QUASIMODO_BEAR',
  'ONE_TWO_THREE_BULL', 'ONE_TWO_THREE_BEAR',
  'WYCKOFF_SPRING_BULL', 'WYCKOFF_UPTHRUST_BEAR',
  'LIQUIDITY_SWEEP_BULL', 'LIQUIDITY_SWEEP_BEAR',
  'BREAKOUT_RETEST_BULL', 'BREAKOUT_RETEST_BEAR',
  'CORRECTIVE_ABC_BULL', 'CORRECTIVE_ABC_BEAR',
  'ELLIOTT_WAVE_BULL', 'ELLIOTT_WAVE_BEAR',
];

/** Allowed pattern scan timeframes */
export const CHART_PATTERN_TFS = ['5m', '15m', '30m', '1h', '2h', '4h', '1d'];
