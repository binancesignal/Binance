/**
 * FIBONACCI BREAKER BLOCK CONFLUENCE STRATEGY
 * Structure (HH/HL) → BOS → Breaker Block → Fib 0.618 → Trendline → Confluence → Entry → 1:4 RR
 * Paper / analysis only. Stored in app_state under FB_CONFIG_KEY.
 */
export const FB_STRATEGY = 'fib_breaker';
export const FB_STRATEGY_NAME = 'FIBONACCI BREAKER BLOCK CONFLUENCE';
export const FB_CONFIG_KEY = 'fib_breaker_config';

export const FB_TFS = ['1d', '4h', '1h', '30m', '15m', '5m'];
export const FB_BUCKETS = ['waiting', 'confluence', 'entry_ready', 'ongoing', 'completed', 'invalidated'];
export const FB_BUCKET_LABEL = {
  waiting: 'Waiting',
  confluence: 'Confluence',
  entry_ready: 'Entry ready',
  ongoing: 'Active',
  completed: 'Completed',
  invalidated: 'Invalidated',
};

/** Full lifecycle stages (prompt §10) mapped onto engine stages */
export const FB_STAGES = [
  'SCANNING',
  'STRUCTURE_CONFIRMED',
  'BOS_CONFIRMED',
  'BREAKER_FOUND',
  'FIBONACCI_READY',
  'CONFLUENCE_FOUND',
  'WAITING_RETRACE',
  'ZONE_TOUCHED',
  'WAITING_CONFIRM',
  'ENTRY_READY',
  'TRADE_ACTIVE',
  'COMPLETED',
  'INVALIDATED',
  'EXPIRED',
];

export const FB_DEFAULTS = {
  enabled: true,
  tfs: ['4h', '1h'],
  swingBars: 3,
  maxAgeBars: 150,
  historyDepth: 3,
  maxSetupAgeBars: 120,
  // Golden Pocket zone 0.618–0.65 (user update). Changeable on settings page.
  entryFibFrom: 0.618,
  entryFibTo: 0.65,
  focusFib: 0.618,
  requireBreaker: true,
  requireTrendline: true, // trendline must SUPPORT (touch) the fib∩breaker zone — not a break signal
  confluenceTolAtr: 0.35,
  slBufferAtr: 0.15,
  minRR: 1.5, // minimum to TP1 (structure)
  targetRR: 4, // 1:4 final target (TP4)
  ext1: 1.272,
  ext2: 1.618,
  minScore: 55,
  maxSignals: 40,
  // scoring weights (sum ≈ 100)
  scoreStructure: 15,
  scoreBos: 15,
  scoreBreaker: 25,
  scoreFib618: 20,
  scoreTrendline: 15,
  scoreEntry: 10,
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, d, lo, hi, int = false) => {
  const n = +v;
  if (!Number.isFinite(n)) return d;
  return int ? Math.round(clamp(n, lo, hi)) : +clamp(n, lo, hi).toFixed(4);
};
const bool = (v, d) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d);

export function validateFbConfig(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = FB_DEFAULTS;
  const notes = [];
  const tfs = (Array.isArray(r.tfs) ? r.tfs : d.tfs).filter((t, i, a) => FB_TFS.includes(t) && a.indexOf(t) === i);
  const cfg = {
    enabled: bool(r.enabled, d.enabled),
    tfs: tfs.length ? tfs : d.tfs,
    swingBars: num(r.swingBars, d.swingBars, 2, 8, true),
    maxAgeBars: num(r.maxAgeBars, d.maxAgeBars, 20, 400, true),
    historyDepth: num(r.historyDepth, d.historyDepth, 1, 6, true),
    maxSetupAgeBars: num(r.maxSetupAgeBars, d.maxSetupAgeBars, 10, 400, true),
    entryFibFrom: num(r.entryFibFrom, d.entryFibFrom, 0.3, 0.9),
    entryFibTo: num(r.entryFibTo, d.entryFibTo, 0.3, 0.95),
    focusFib: num(r.focusFib, d.focusFib, 0.382, 0.886),
    requireBreaker: bool(r.requireBreaker, d.requireBreaker),
    requireTrendline: bool(r.requireTrendline, d.requireTrendline),
    confluenceTolAtr: num(r.confluenceTolAtr, d.confluenceTolAtr, 0.1, 1.5),
    slBufferAtr: num(r.slBufferAtr, d.slBufferAtr, 0, 2),
    minRR: num(r.minRR, d.minRR, 0.5, 10),
    targetRR: num(r.targetRR, d.targetRR, 2, 8),
    ext1: num(r.ext1, d.ext1, 1.05, 3),
    ext2: num(r.ext2, d.ext2, 1.1, 4),
    minScore: num(r.minScore, d.minScore, 0, 100, true),
    maxSignals: num(r.maxSignals, d.maxSignals, 1, 200, true),
    scoreStructure: num(r.scoreStructure, d.scoreStructure, 0, 40, true),
    scoreBos: num(r.scoreBos, d.scoreBos, 0, 40, true),
    scoreBreaker: num(r.scoreBreaker, d.scoreBreaker, 0, 40, true),
    scoreFib618: num(r.scoreFib618, d.scoreFib618, 0, 40, true),
    scoreTrendline: num(r.scoreTrendline, d.scoreTrendline, 0, 40, true),
    scoreEntry: num(r.scoreEntry, d.scoreEntry, 0, 40, true),
  };
  if (cfg.entryFibFrom >= cfg.entryFibTo) {
    notes.push('Entry fib band invalid — defaults restored.');
    cfg.entryFibFrom = d.entryFibFrom;
    cfg.entryFibTo = d.entryFibTo;
  }
  if (cfg.ext2 <= cfg.ext1) cfg.ext2 = +(cfg.ext1 + 0.346).toFixed(3);
  return { config: cfg, notes };
}
export const normalizeFbConfig = (raw) => validateFbConfig(raw).config;
