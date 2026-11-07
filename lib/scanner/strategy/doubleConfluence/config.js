/**
 * Double Top / Double Bottom Confluence Strategy — config & presets.
 * Pattern + HTF structure + Liquidity + SMC + Fib + Breakout + Retest + LTF confirm.
 */

export const TF_PRESETS = [
  { id: 'p1', label: '4H → 1H', htf: '4h', entry: '1h' },
  { id: 'p2', label: '2H → 30M', htf: '2h', entry: '30m' },
  { id: 'p3', label: '1H → 15M', htf: '1h', entry: '15m' },
  { id: 'p4', label: '30M → 5M', htf: '30m', entry: '5m' },
  { id: 'p5', label: '15M → 3M', htf: '15m', entry: '3m' },
  { id: 'p6', label: '15M → 5M', htf: '15m', entry: '5m' },
  { id: 'p7', label: '5M → 1M', htf: '5m', entry: '1m' },
];

export const ALL_TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h'];

export const DOUBLE_CONFLUENCE_DEFAULTS = {
  enabled: true,

  // Multi-preset: scan all enabled presets
  presets: ['p3', 'p4', 'p6'], // default selectable set
  customHtf: null,
  customEntry: null,
  useCustom: false,

  // Pattern
  lowSimilarityPercent: 1.0, // max % difference between the two lows/highs
  minPatternHeightATR: 1.0,
  minSwingSeparationBars: 5,
  maxSwingSeparationBars: 80,
  maxBarsAfterSecond: 30,
  maxPatternAgeBars: 60,

  // Confluence
  confluenceMode: 'balanced', // flexible | balanced | strict
  minScore: 8, // 0-14 scale
  fibEnabled: true,
  strictFibMode: false,
  requireLiquidity: false,
  requireSmc: false,
  requireBos: false,
  requireChoch: false,
  requireOb: false,
  requireFvg: false,
  requireRetest: false,
  breakoutConfirmType: 'close', // close | strong_body | multi_candle

  // Risk
  minRR: 1.2,
  tp1R: 1.0,
  tp2R: 2.0,
  tp3R: 3.0,
  slBufferATR: 0.25,
  minStopATR: 0.4,
  maxStopATR: 4.0,
  maxEntryDistanceATR: 3.5,
  atrPeriod: 14,

  htfLookback: 100,
  entryLookback: 150,
};

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export function normalizeDoubleConfluenceConfig(input = {}) {
  const supplied = input && typeof input === 'object' ? input : {};
  const cfg = { ...DOUBLE_CONFLUENCE_DEFAULTS };

  for (const key of Object.keys(DOUBLE_CONFLUENCE_DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(supplied, key)) {
      cfg[key] = supplied[key];
    }
  }

  // Presets list
  const validIds = new Set(TF_PRESETS.map((p) => p.id));
  if (Array.isArray(cfg.presets)) {
    cfg.presets = [...new Set(cfg.presets.map(String).filter((id) => validIds.has(id)))];
  } else {
    cfg.presets = [...DOUBLE_CONFLUENCE_DEFAULTS.presets];
  }
  if (!cfg.presets.length && !cfg.useCustom) cfg.presets = ['p3'];

  if (cfg.customHtf && !ALL_TFS.includes(cfg.customHtf)) cfg.customHtf = null;
  if (cfg.customEntry && !ALL_TFS.includes(cfg.customEntry)) cfg.customEntry = null;
  cfg.useCustom = !!cfg.useCustom && !!cfg.customHtf && !!cfg.customEntry;

  const floats = [
    ['lowSimilarityPercent', 0.2, 5],
    ['minPatternHeightATR', 0.4, 5],
    ['minRR', 0.8, 5],
    ['tp1R', 0.5, 5],
    ['tp2R', 1, 10],
    ['tp3R', 1.5, 15],
    ['slBufferATR', 0.05, 1.5],
    ['minStopATR', 0.2, 3],
    ['maxStopATR', 1, 10],
    ['maxEntryDistanceATR', 0.5, 10],
  ];
  for (const [k, min, max] of floats) {
    const n = +cfg[k];
    cfg[k] = Number.isFinite(n) ? clamp(n, min, max) : DOUBLE_CONFLUENCE_DEFAULTS[k];
  }

  const ints = [
    ['minSwingSeparationBars', 3, 40],
    ['maxSwingSeparationBars', 15, 150],
    ['maxBarsAfterSecond', 5, 80],
    ['maxPatternAgeBars', 10, 150],
    ['minScore', 4, 14],
    ['atrPeriod', 7, 28],
    ['htfLookback', 40, 250],
    ['entryLookback', 60, 300],
  ];
  for (const [k, min, max] of ints) {
    const n = Math.round(+cfg[k]);
    cfg[k] = Number.isFinite(n) ? clamp(n, min, max) : DOUBLE_CONFLUENCE_DEFAULTS[k];
  }

  if (!['flexible', 'balanced', 'strict'].includes(cfg.confluenceMode)) {
    cfg.confluenceMode = 'balanced';
  }
  if (!['close', 'strong_body', 'multi_candle'].includes(cfg.breakoutConfirmType)) {
    cfg.breakoutConfirmType = 'close';
  }

  for (const key of [
    'enabled', 'useCustom', 'fibEnabled', 'strictFibMode',
    'requireLiquidity', 'requireSmc', 'requireBos', 'requireChoch',
    'requireOb', 'requireFvg', 'requireRetest',
  ]) {
    cfg[key] = typeof cfg[key] === 'boolean' ? cfg[key] : DOUBLE_CONFLUENCE_DEFAULTS[key];
  }

  // Mode adjusts effective min score
  if (cfg.confluenceMode === 'flexible' && cfg.minScore > 7) {
    // leave user minScore but flexible allows lower soft floor in runner
  }
  if (cfg.confluenceMode === 'strict' && cfg.minScore < 10) {
    // strict can raise floor in runner
  }

  if (cfg.maxStopATR < cfg.minStopATR) cfg.maxStopATR = cfg.minStopATR;
  return cfg;
}

/** Expand config into concrete { htf, entry } pairs to scan */
export function resolveTfPairs(cfg) {
  const pairs = [];
  const seen = new Set();
  for (const id of cfg.presets || []) {
    const p = TF_PRESETS.find((x) => x.id === id);
    if (!p) continue;
    const key = `${p.htf}|${p.entry}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ htf: p.htf, entry: p.entry, presetId: p.id, label: p.label });
  }
  if (cfg.useCustom && cfg.customHtf && cfg.customEntry) {
    const key = `${cfg.customHtf}|${cfg.customEntry}`;
    if (!seen.has(key)) {
      pairs.push({
        htf: cfg.customHtf,
        entry: cfg.customEntry,
        presetId: 'custom',
        label: `${cfg.customHtf.toUpperCase()} → ${cfg.customEntry.toUpperCase()}`,
      });
    }
  }
  if (!pairs.length) {
    pairs.push({ htf: '1h', entry: '15m', presetId: 'p3', label: '1H → 15M' });
  }
  return pairs;
}
