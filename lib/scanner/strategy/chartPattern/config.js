/** Chart Pattern Breakout — independent of SMC strategy config */
export const CHART_PATTERN_CONFIG = {
  enabled: true,

  htf: '1h',
  patternTf: '15m', // fallback single TF
  // Timeframes scanned for patterns (each symbol is checked on every TF listed).
  // Allowed: 5m, 15m, 30m, 1h, 2h. Changeable from the dashboard.
  patternTfs: ['5m', '15m', '30m', '1h', '2h'],
  // Higher-timeframe bias used for each pattern TF
  htfByPatternTf: { '5m': '1h', '15m': '1h', '30m': '4h', '1h': '4h', '2h': '4h' },
  entryTf: '5m',

  htfKlineLimit: 80,
  patternKlineLimit: 120,
  entryKlineLimit: 40,

  requireCandleClose: true,
  breakoutAtrMin: 0.2,
  maxBreakoutDistanceATR: 1.5, // was 2.0 — late/extended breakouts have poor R:R
  requireVolumeConfirmation: true,
  minRelativeVolume: 1.3, // breakout CANDLE volume vs its 20-bar average
  requireRetest: false,
  breakoutConfirmationCandles: 1,
  requireFreshBreakout: true, // first close beyond the level only (no stale / repeat signals)
  minBodyRatio: 0.5,

  minPatternScore: 55,
  minSignalScore: 70,
  minRR: 1.5, // measured-move (TP2) reward vs risk — real filter now
  // TP1 reward:risk floor. TP1 = entry ± max(height*0.5, risk), so TP1 RR is never below 1.0.
  // Pattern signals use this (1.0) — NOT the 1.2 SMC entry-quality floor.
  minTp1RR: 1.0,
  // Per-gate HARD (reject) / SOFT (score penalty only). Empty = legacy booleans below decide.
  // Edited from the dashboard → Strategy 2 → Gates.
  gateModes: {},
  // Near-breakout signals: go ONGOING + market order the moment LIVE price crosses entry
  // (SHORT: price <= entry, LONG: price >= entry). false = wait for candle-close confirmation.
  nearEntryOnLivePrice: true,
  // Confirmed breakout (READY): invalidate when a CLOSED candle closes back inside the pattern
  failedBreakoutInvalidate: true,
  failedBreakoutBufferATR: 0.1, // close must be this many ATR back inside (filters tiny wick-ish closes)

  requireFibConfluence: false,
  fibTolerancePercent: 0.5,
  fibScoreBoost: 10,

  requireHtfAlign: true,
  requireSmcConfluence: false, // hard-require SMC confluence (sweep / OB at base / FVG)
  // Quality gate: pillars = HTF aligned + SMC confluence + Fib confluence. Need at least N of 3.
  minConfluencePillars: 2,
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
  nearMinScore: 45, // readiness score floor (breakout-candle points are not included)
  nearRequireHtfAlign: true, // same HTF rule as real signals
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
  minFinalScore: 70,
  minPatternScore: 45,
  minLocationScore: 50,      // raised — weak location setups filtered
  minRejectionScore: 30,     // raised — need real rejection event
  minWaveScore: 0,           // 0 = optional; raise to require reliable EW context
  minIndependentCategories: 3,

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
  minReversalZoneScore: 45,            // minimum cluster confluence score
  minReversalLocationScore: 55,        // higher location bar for reversals (premium/discount + HTF)
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
  waveAnalysisEnabled: true,
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
