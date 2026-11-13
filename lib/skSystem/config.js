/**
 * SK SYSTEM PRO — configuration (admin-editable, validated on the server).
 * Stored in app_state under SK_CONFIG_KEY. Completely separate from every other strategy's settings.
 */
export const SK_CONFIG_KEY = 'sk_system_config';
export const SK_CONFIG2_KEY = 'sk_system_config_2'; // Setup 2 (intraday) — its own settings, separate from Setup 1
export const SK_RUN_KEY = 'sk_system_active_run';
export const SK_LOCK_KEY = 'sk_system_lock';
export const SK_STATUS_KEY = 'sk_system_status';
export const SK_STRATEGY = 'sk_system_pro';
export const SK_STRATEGY_NAME = 'SK SYSTEM PRO';

export const SK_ALL_TFS = ['1w', '1d', '4h', '2h', '1h', '30m', '15m', '5m', '3m'];
export const SK_PRIMARY_TFS = ['4h', '2h']; // Setup 1
export const SK_CONFIRM_TFS = ['2h', '30m', '15m', '5m']; // Setup 1 optional steps (1H CHoCH is always mandatory)
// Setup 2 (intraday): 1D bias + 4H direction → 1H structure → 15M mandatory CHoCH → optional 30M / 5M / 3M
export const SK_PRIMARY_TFS_2 = ['1h'];
export const SK_CONFIRM_TFS_2 = ['30m', '5m', '3m'];

/**
 * Time-frame roles of a setup. The engine is written against ROLES, so Setup 1 and Setup 2 run the same code:
 *   htfHigh / htfLow = direction + bias · primary = A-B-C structure + C zone · validate = optional "swing low holding"
 *   struct = mandatory CHoCH + Fib entry zone inside the C zone · mids = optional CHoCH confirmations (high → low)
 */
export const SK_TF_PROFILES = {
  1: { htfHigh: '1w', htfLow: '1d', validate: '2h', struct: '1h', mids: ['30m', '15m', '5m'], volTfs: ['15m', '5m'], label: 'Setup 1 · 4H' },
  2: { htfHigh: '1d', htfLow: '4h', validate: '30m', struct: '15m', mids: ['5m', '3m'], volTfs: ['5m', '3m'], label: 'Setup 2 · 1H' },
};
export const skSetupNo = (x) => {
  if (x === 2 || x === '2') return 2;
  if (typeof x === 'string') return x.startsWith('sk2_') ? 2 : 1; // a setup id
  if (x && typeof x === 'object') return +x.setup === 2 || String(x.id || '').startsWith('sk2_') ? 2 : 1; // a config / setup record
  return 1;
};
/** the role → time-frame map of a (validated) config; `primary` follows the config */
export function skTfs(cfg) {
  const p = SK_TF_PROFILES[skSetupNo(cfg?.setup)];
  return { ...p, primary: cfg?.primaryTf || (skSetupNo(cfg?.setup) === 2 ? '1h' : '4h') };
}
export const SK_FIB_LEVELS = [0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 0.886];
export const SK_RANKINGS = ['volume', 'gainers', 'losers', 'volatility'];
export const SK_TOP_PRESETS = [10, 20, 30, 50, 100];

export const SK_STAGES = [
  'TREND_DETECTED',
  'CHOCH_CONFIRMED',
  'SWING_CONFIRMED',
  'FIBONACCI_ACTIVE',
  'ABCD_DEVELOPING',
  'C_ZONE_REACHED',
  'LTF_CONFIRMATION',
  'ENTRY_READY',
  'ENTRY_ONGOING',
  'TP1_HIT',
  'TP2_HIT',
  'TP3_HIT',
  'D_TARGET_REACHED',
  'STOP_LOSS_HIT',
  'INVALIDATED',
  'EXPIRED',
];
export const SK_TERMINAL = new Set(['D_TARGET_REACHED', 'STOP_LOSS_HIT', 'INVALIDATED', 'EXPIRED']);
export const stageRank = (s) => SK_STAGES.indexOf(s);

export const SK_DEFAULTS = {
  enabled: true,
  // multi-timeframe chain
  primaryTf: '4h',
  confirmTfs: ['2h', '30m', '15m', '5m'],
  htfAlignment: 'standard', // 'strict' (1W + 1D agree) · 'standard' (1D agrees, 1W not opposed) · 'off'
  // swings
  swingSensitivity: 'medium', // 'low' (5 bars) · 'medium' (3) · 'high' (2)
  // CHoCH
  chochMode: 'close', // 'close' = candle CLOSE beyond the level · 'close_atr' = close beyond by chochAtrBuffer × ATR
  chochAtrBuffer: 0.1,
  chochMaxAgeBars: 150, // 4H CHoCH older than this many bars is stale
  // Fibonacci / ABCD
  fibLevels: [0.382, 0.5, 0.618, 0.786],
  fibTolerance: 0.03, // ratio units
  abcdMinRetrace: 0.382,
  abcdMaxRetrace: 0.886,
  abcdTolerance: 0.03,
  minAbAtr: 3, // AB leg must be at least this many 4H ATR
  cZoneFrom: 0.5,
  cZoneTo: 0.786,
  dExtension: 1, // D = C + AB × this
  // lower-timeframe entry
  entryFibFrom: 0.5,
  entryFibTo: 0.786,
  entryMode: 'retest', // 'retest' = limit at the broken level · 'close' = at the confirmation close
  volumeConfirm: 'prefer', // 'off' | 'prefer' (adds score) | 'require'
  volumeMult: 1.2,
  // trade
  slBufferAtr: 0.25,
  slAnchor: 'ltf', // 'ltf' = pullback low · 'c' = the 4H C low
  maxRiskAtr: 8,
  tpMethod: 'structure', // 'structure' (1H high → 4H B → D) · 'rr' (R multiples)
  tp1R: 1,
  tp2R: 2,
  tp3R: 3,
  minRR: 1.5,
  minRRTarget: 'tp2',
  minScore: 60,
  storeFromStage: 'ABCD_DEVELOPING',
  // which buckets the public Scanner shows (admin can change)
  visibleBuckets: ['waiting', 'entry_ready', 'ongoing', 'active'],
  // scanning
  scanUniverse: 'top', // 'all' | 'top'
  topN: 50,
  rankingMethod: 'volume',
  maxConcurrent: 3,
  batchSize: 6,
  retryCount: 2,
  retryDelayMs: 800,
  maxCandles: 500,
  userScanMax: 100, // largest Top N a normal (non-admin) user may scan · 0 = users cannot scan · 600+ = they may scan ALL coins
  autoScan: false,
  autoScanIntervalMin: 5,
  // housekeeping
  setupExpiryHours: 240,
  entryExpiryHours: 72,
  maxHistory: 500,
};

/** Setup 2 overrides (everything else = Setup 1 defaults). Faster cycle, shorter chain → more signals. */
export const SK_DEFAULTS_2 = {
  ...SK_DEFAULTS,
  setup: 2,
  primaryTf: '1h',
  confirmTfs: ['5m'], // 15M CHoCH is always required; add 30M / 3M in Admin to make it stricter
  htfAlignment: 'standard', // 1D agrees, 4H not opposed
  chochMaxAgeBars: 120, // 1H bars (≈ 5 days)
  minAbAtr: 2.5,
  minScore: 55,
  setupExpiryHours: 72,
  entryExpiryHours: 24,
};
SK_DEFAULTS.setup = 1;

export const SENSITIVITY_BARS = { low: 5, medium: 3, high: 2 };

const pick = (v, allowed, def) => (allowed.includes(v) ? v : def);
const pickList = (v, allowed, def) => {
  if (!Array.isArray(v)) return def;
  const out = allowed.filter((x) => v.map(String).includes(x));
  return out;
};

/**
 * Validate + clamp. Returns the clean config; `notes` lists every field that was invalid or adjusted
 * (the admin API shows them so a wrong value is never silently accepted).
 */
export function validateSkConfig(raw = {}, setup = 1) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const no = skSetupNo(setup);
  const d = no === 2 ? SK_DEFAULTS_2 : SK_DEFAULTS;
  const primaryAllowed = no === 2 ? SK_PRIMARY_TFS_2 : SK_PRIMARY_TFS;
  const confirmAllowed = no === 2 ? SK_CONFIRM_TFS_2 : SK_CONFIRM_TFS;
  const notes = [];
  const num = (k, lo, hi, int = false) => {
    if (r[k] === undefined) return d[k];
    let n = +r[k];
    if (!Number.isFinite(n)) {
      notes.push(`${k}: not a number — default used`);
      return d[k];
    }
    if (int) n = Math.round(n);
    const c = Math.min(hi, Math.max(lo, n));
    if (c !== n) notes.push(`${k}: ${n} clamped to ${c} (allowed ${lo}–${hi})`);
    return c;
  };
  const bool = (k) => (r[k] === undefined ? d[k] : r[k] === true || r[k] === 'true' || r[k] === 1 || r[k] === '1');
  const sel = (k, allowed) => {
    if (r[k] === undefined) return d[k];
    if (!allowed.includes(r[k])) {
      notes.push(`${k}: "${r[k]}" not allowed — default used`);
      return d[k];
    }
    return r[k];
  };

  const levelsIn = Array.isArray(r.fibLevels)
    ? [...new Set(r.fibLevels.map((x) => +(+x).toFixed(4)).filter((x) => Number.isFinite(x) && x > 0 && x < 1))].sort((a, b) => a - b)
    : null;
  if (Array.isArray(r.fibLevels) && !levelsIn.length) notes.push('fibLevels: no valid level (0–1) — default used');

  const confirmTfs = r.confirmTfs === undefined ? d.confirmTfs : pickList(r.confirmTfs, confirmAllowed, d.confirmTfs);

  const cfg = {
    setup: no,
    enabled: bool('enabled'),
    primaryTf: sel('primaryTf', primaryAllowed),
    confirmTfs,
    htfAlignment: sel('htfAlignment', ['strict', 'standard', 'off']),
    swingSensitivity: sel('swingSensitivity', ['low', 'medium', 'high']),
    chochMode: sel('chochMode', ['close', 'close_atr']),
    chochAtrBuffer: num('chochAtrBuffer', 0, 2),
    chochMaxAgeBars: num('chochMaxAgeBars', 10, 1000, true),
    fibLevels: levelsIn?.length ? levelsIn.slice(0, 12) : d.fibLevels,
    fibTolerance: num('fibTolerance', 0, 0.2),
    abcdMinRetrace: num('abcdMinRetrace', 0.1, 0.9),
    abcdMaxRetrace: num('abcdMaxRetrace', 0.5, 0.99),
    abcdTolerance: num('abcdTolerance', 0, 0.2),
    minAbAtr: num('minAbAtr', 0, 50),
    cZoneFrom: num('cZoneFrom', 0.2, 0.9),
    cZoneTo: num('cZoneTo', 0.3, 0.99),
    dExtension: (() => {
      if (r.dExtension === undefined) return d.dExtension;
      if ([1, 1.272, 1.618].includes(+r.dExtension)) return +r.dExtension;
      notes.push(`dExtension: "${r.dExtension}" not allowed (1 / 1.272 / 1.618) — default used`);
      return d.dExtension;
    })(),
    entryFibFrom: num('entryFibFrom', 0.2, 0.9),
    entryFibTo: num('entryFibTo', 0.3, 0.99),
    entryMode: sel('entryMode', ['retest', 'close']),
    volumeConfirm: sel('volumeConfirm', ['off', 'prefer', 'require']),
    volumeMult: num('volumeMult', 0.5, 5),
    slBufferAtr: num('slBufferAtr', 0, 3),
    slAnchor: sel('slAnchor', ['ltf', 'c']),
    maxRiskAtr: num('maxRiskAtr', 0.5, 50),
    tpMethod: sel('tpMethod', ['structure', 'rr']),
    tp1R: num('tp1R', 0.3, 10),
    tp2R: num('tp2R', 0.5, 15),
    tp3R: num('tp3R', 0.8, 25),
    minRR: num('minRR', 0.3, 10),
    minRRTarget: sel('minRRTarget', ['tp1', 'tp2', 'tp3']),
    minScore: num('minScore', 0, 100, true),
    storeFromStage: sel('storeFromStage', SK_STAGES.slice(0, 8)),
    visibleBuckets: Array.isArray(r.visibleBuckets)
      ? [...new Set(r.visibleBuckets.map(String).filter((b) => ['new','active','waiting','entry_ready','ongoing','completed','invalidated','history'].includes(b)))]
      : d.visibleBuckets,
    scanUniverse: sel('scanUniverse', ['all', 'top']),
    topN: num('topN', 1, 600, true),
    rankingMethod: sel('rankingMethod', SK_RANKINGS),
    maxConcurrent: num('maxConcurrent', 1, 8, true),
    batchSize: num('batchSize', 1, 20, true),
    retryCount: num('retryCount', 0, 5, true),
    retryDelayMs: num('retryDelayMs', 0, 10000, true),
    maxCandles: num('maxCandles', 200, 1500, true),
    userScanMax: num('userScanMax', 0, 700, true),
    autoScan: bool('autoScan'),
    autoScanIntervalMin: num('autoScanIntervalMin', 5, 1440, true),
    setupExpiryHours: num('setupExpiryHours', 1, 24 * 60, true),
    entryExpiryHours: num('entryExpiryHours', 1, 24 * 30, true),
    maxHistory: num('maxHistory', 20, 5000, true),
  };

  // cross-field rules
  if (cfg.abcdMinRetrace >= cfg.abcdMaxRetrace) {
    notes.push('abcdMinRetrace must be below abcdMaxRetrace — defaults restored');
    cfg.abcdMinRetrace = d.abcdMinRetrace;
    cfg.abcdMaxRetrace = d.abcdMaxRetrace;
  }
  if (cfg.cZoneFrom >= cfg.cZoneTo) {
    notes.push('cZoneFrom must be below cZoneTo — defaults restored');
    cfg.cZoneFrom = d.cZoneFrom;
    cfg.cZoneTo = d.cZoneTo;
  }
  if (cfg.entryFibFrom >= cfg.entryFibTo) {
    notes.push('entryFibFrom must be below entryFibTo — defaults restored');
    cfg.entryFibFrom = d.entryFibFrom;
    cfg.entryFibTo = d.entryFibTo;
  }
  if (!(cfg.tp1R < cfg.tp2R && cfg.tp2R < cfg.tp3R)) {
    notes.push('tp1R < tp2R < tp3R required — defaults restored');
    cfg.tp1R = d.tp1R;
    cfg.tp2R = d.tp2R;
    cfg.tp3R = d.tp3R;
  }
  if (no === 1 && cfg.primaryTf === '2h') cfg.confirmTfs = cfg.confirmTfs.filter((t) => t !== '2h');
  return { config: cfg, notes };
}

export function normalizeSkConfig(raw, setup = 1) {
  return validateSkConfig(raw, setup).config;
}

/** pivot bars (left = right) from the swing-sensitivity setting */
export const swingBars = (cfg) => SENSITIVITY_BARS[cfg?.swingSensitivity] || SENSITIVITY_BARS.medium;

/** TF → seconds */
export const TF_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800 };
