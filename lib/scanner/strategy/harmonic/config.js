export const HARMONIC_FAMILIES = [
  { key: 'ABCD', label: 'AB=CD' },
  { key: 'BAT', label: 'Bat' },
  { key: 'THREE_DRIVES', label: 'Three Drives' },
  { key: 'ALT_BAT', label: 'Alternate Bat' },
  { key: 'GARTLEY', label: 'Gartley' },
  { key: 'DEEP_BAT', label: 'Deep Bat' },
  { key: 'BUTTERFLY', label: 'Butterfly' },
  { key: 'CRAB', label: 'Crab' },
  { key: 'CYPHER', label: 'Cypher' },
  { key: 'DEEP_CRAB', label: 'Deep Crab' },
  { key: 'SHARK', label: 'Shark' },
];

export const HARMONIC_PATTERNS = HARMONIC_FAMILIES.flatMap((family) => [
  { key: `${family.key}_BULL`, family: family.key, direction: 'LONG', label: `Bullish ${family.label}` },
  { key: `${family.key}_BEAR`, family: family.key, direction: 'SHORT', label: `Bearish ${family.label}` },
]);

export const HARMONIC_TFS = ['5m', '15m', '30m', '1h', '2h', '4h', '1d'];

export const HARMONIC_DEFAULTS = {
  patternTfs: ['15m', '30m', '1h'],
  enabledFamilies: HARMONIC_FAMILIES.map((family) => family.key),
  enabledPatterns: HARMONIC_PATTERNS.map((pattern) => pattern.key),
  minSignalScore: 50,
  maxPointAgeBars: 24,
  maxPatternSpanBars: 120,
  dZoneATR: 0.15,
  readyDistanceATR: 0.5,
  stopBufferATR: 0.35,
  // When true: require the first EMA20/EMA50 cross (from the left / earliest in time)
  // that occurs near the PRZ / entry zone. Directional cross preferred (golden for LONG).
  emaCrossConfirm: false,
  emaFast: 20,
  emaSlow: 50,
  emaCrossNearAtr: 1.5,
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function normalizeHarmonicConfig(input = {}) {
  const supplied = input && typeof input === 'object' ? input : {};
  const cfg = { ...HARMONIC_DEFAULTS, ...supplied };
  const tfs = Array.isArray(cfg.patternTfs)
    ? cfg.patternTfs.filter((tf) => HARMONIC_TFS.includes(tf))
    : [];
  cfg.patternTfs = tfs.length ? [...new Set(tfs)] : [...HARMONIC_DEFAULTS.patternTfs];

  const allowedFamilies = new Set(HARMONIC_FAMILIES.map((family) => family.key));
  const allowedPatterns = new Set(HARMONIC_PATTERNS.map((pattern) => pattern.key));
  const familyInput = Array.isArray(supplied.enabledFamilies)
    ? [...new Set(supplied.enabledFamilies.map((family) => String(family).toUpperCase()).filter((family) => allowedFamilies.has(family)))]
    : [...HARMONIC_DEFAULTS.enabledFamilies];
  const patternInput = Array.isArray(supplied.enabledPatterns)
    ? supplied.enabledPatterns.map((pattern) => String(pattern).toUpperCase()).filter((pattern) => allowedPatterns.has(pattern))
    : HARMONIC_PATTERNS.filter((pattern) => familyInput.includes(pattern.family)).map((pattern) => pattern.key);
  cfg.enabledPatterns = [...new Set(patternInput)];
  cfg.enabledFamilies = [...new Set(
    HARMONIC_PATTERNS.filter((pattern) => cfg.enabledPatterns.includes(pattern.key)).map((pattern) => pattern.family)
  )];

  for (const [key, min, max, integer] of [
    ['minSignalScore', 30, 95, true],
    ['maxPointAgeBars', 3, 100, true],
    ['maxPatternSpanBars', 20, 300, true],
    ['emaFast', 5, 50, true],
    ['emaSlow', 10, 200, true],
  ]) {
    const value = Number(cfg[key]);
    cfg[key] = Number.isFinite(value)
      ? clamp(integer ? Math.round(value) : value, min, max)
      : HARMONIC_DEFAULTS[key];
  }
  if (cfg.emaFast >= cfg.emaSlow) {
    cfg.emaFast = Math.min(cfg.emaFast, cfg.emaSlow - 1);
  }
  for (const [key, min, max] of [
    ['dZoneATR', 0.03, 0.75],
    ['readyDistanceATR', 0.1, 3],
    ['stopBufferATR', 0.1, 2],
    ['emaCrossNearAtr', 0.3, 5],
  ]) {
    const value = Number(cfg[key]);
    cfg[key] = Number.isFinite(value) ? clamp(value, min, max) : HARMONIC_DEFAULTS[key];
  }
  // Deprecated: replaced by the global "EMA cross in entry zone" filter (all strategies).
  cfg.emaCrossConfirm = false;
  return cfg;
}
