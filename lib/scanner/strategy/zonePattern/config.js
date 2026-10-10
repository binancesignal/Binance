export const ZONE_PATTERN_DEFAULTS = {
  setupTf: '15m',
  contextTf: '4h',
  setupLookback: 160,
  contextLookback: 160,
  weeklyLookback: 12,
  dailyLookback: 20,
  pivotBars: 2,
  zoneToleranceATR: 0.45,
  zoneTouchToleranceATR: 0.35,
  minZoneSources: 2,
  maxZoneDistanceATR: 4,
  maxChaseATR: 0.8,
  patternLookbackBars: 48,
  maxBarsAfterSecondTouch: 28,
  minTouchSpacingBars: 3,
  minBosBodyATR: 0.2,
  minBosBodyRatio: 0.35,
  includeWeeklyLevels: true,
  includeDailyLevels: true,
  includeSwingLevels: true,
  includeFibLevels: true,
  includeOrderBlocks: true,
  includeFvgs: true,
  fibRatios: [0.5, 0.618, 0.705, 0.786],
  fibToleranceATR: 0.3,
  slBufferATR: 0.25,
  minStopATR: 0.2,
  maxStopATR: 3,
  minRR: 1.2,
  targetR: 1.6,
  target2R: 2.5,
  target3R: 3.5,
  minSignalScore: 60,
};

const SETUP_TFS = ['5m', '15m', '30m', '1h'];
const CONTEXT_TFS = ['1h', '2h', '4h', '1d'];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function normalizeZonePatternConfig(input = {}) {
  const supplied = input && typeof input === 'object' ? input : {};
  const cfg = { ...ZONE_PATTERN_DEFAULTS };
  for (const key of Object.keys(ZONE_PATTERN_DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(supplied, key)) cfg[key] = supplied[key];
  }
  cfg.setupTf = SETUP_TFS.includes(cfg.setupTf) ? cfg.setupTf : ZONE_PATTERN_DEFAULTS.setupTf;
  cfg.contextTf = CONTEXT_TFS.includes(cfg.contextTf) ? cfg.contextTf : ZONE_PATTERN_DEFAULTS.contextTf;

  const bounded = [
    ['setupLookback', 60, 500],
    ['contextLookback', 40, 500],
    ['weeklyLookback', 2, 100],
    ['dailyLookback', 2, 100],
    ['pivotBars', 1, 5],
    ['minZoneSources', 2, 5],
    ['patternLookbackBars', 12, 120],
    ['maxBarsAfterSecondTouch', 4, 80],
    ['minTouchSpacingBars', 2, 20],
    ['minSignalScore', 40, 95],
  ];
  for (const [key, min, max] of bounded) {
    const n = Math.round(+cfg[key]);
    cfg[key] = Number.isFinite(n) ? clamp(n, min, max) : ZONE_PATTERN_DEFAULTS[key];
  }

  const decimals = [
    ['zoneToleranceATR', 0.1, 1.5],
    ['zoneTouchToleranceATR', 0.05, 1.5],
    ['maxZoneDistanceATR', 0.5, 8],
    ['maxChaseATR', 0.1, 3],
    ['minBosBodyATR', 0, 2],
    ['minBosBodyRatio', 0.1, 0.9],
    ['fibToleranceATR', 0.05, 1],
    ['slBufferATR', 0.05, 1],
    ['minStopATR', 0.05, 2],
    ['maxStopATR', 0.5, 8],
    ['minRR', 0.8, 5],
    ['targetR', 1.2, 8],
    ['target2R', 1.5, 12],
    ['target3R', 2, 20],
  ];
  for (const [key, min, max] of decimals) {
    const n = +cfg[key];
    cfg[key] = Number.isFinite(n) ? clamp(n, min, max) : ZONE_PATTERN_DEFAULTS[key];
  }
  if (cfg.maxStopATR < cfg.minStopATR) cfg.maxStopATR = cfg.minStopATR;

  for (const key of [
    'includeWeeklyLevels',
    'includeDailyLevels',
    'includeSwingLevels',
    'includeFibLevels',
    'includeOrderBlocks',
    'includeFvgs',
  ]) {
    cfg[key] = typeof cfg[key] === 'boolean' ? cfg[key] : ZONE_PATTERN_DEFAULTS[key];
  }
  cfg.fibRatios = Array.isArray(cfg.fibRatios)
    ? cfg.fibRatios.map(Number).filter((n) => Number.isFinite(n) && n >= 0.3 && n <= 0.9).slice(0, 8)
    : [...ZONE_PATTERN_DEFAULTS.fibRatios];
  if (!cfg.fibRatios.length) cfg.fibRatios = [...ZONE_PATTERN_DEFAULTS.fibRatios];
  return cfg;
}