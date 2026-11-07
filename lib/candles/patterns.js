/**
 * Candlestick REVERSAL pattern scanner (pure functions — no network).
 *
 * 9 bullish + 9 bearish patterns, the ones that are traded most and that hold up best:
 *   1 candle : Hammer, Inverted Hammer / Hanging Man, Shooting Star, Dragonfly / Gravestone Doji
 *   2 candles: Engulfing, Piercing Line / Dark Cloud Cover, Harami, Tweezer Bottom / Top
 *   3 candles: Morning Star / Evening Star, Three White Soldiers / Three Black Crows
 *
 * Every size rule is relative to the coin's own ATR, so the same pattern means the same thing on
 * BTC and on a tiny altcoin. A reversal pattern only counts after a move in the opposite direction
 * (bullish needs a prior down-move, bearish a prior up-move) — switchable with `requireTrend`.
 * Candles must be CLOSED candles, oldest → newest: { time, open, high, low, close }.
 */

export const PATTERNS = [
  // ── bullish ──────────────────────────────────────────────
  { id: 'hammer', dir: 'BULLISH', name: 'Hammer', n: 1, hint: 'Long lower wick after a drop — sellers rejected' },
  { id: 'inverted_hammer', dir: 'BULLISH', name: 'Inverted Hammer', n: 1, hint: 'Long upper wick after a drop — buyers testing' },
  { id: 'bullish_engulfing', dir: 'BULLISH', name: 'Bullish Engulfing', n: 2, hint: 'Green candle swallows the red one before it' },
  { id: 'piercing_line', dir: 'BULLISH', name: 'Piercing Line', n: 2, hint: 'Green candle closes above the middle of the red one' },
  { id: 'morning_star', dir: 'BULLISH', name: 'Morning Star', n: 3, hint: 'Red · small indecision · strong green' },
  { id: 'three_white_soldiers', dir: 'BULLISH', name: 'Three White Soldiers', n: 3, hint: 'Three strong green candles in a row' },
  { id: 'bullish_harami', dir: 'BULLISH', name: 'Bullish Harami', n: 2, hint: 'Small green candle inside a big red one' },
  { id: 'tweezer_bottom', dir: 'BULLISH', name: 'Tweezer Bottom', n: 2, hint: 'Two candles with the same low — support held' },
  { id: 'dragonfly_doji', dir: 'BULLISH', name: 'Dragonfly Doji', n: 1, hint: 'Open = close at the top, long lower wick' },
  // ── bearish ──────────────────────────────────────────────
  { id: 'hanging_man', dir: 'BEARISH', name: 'Hanging Man', n: 1, hint: 'Hammer shape after a rise — buyers weakening' },
  { id: 'shooting_star', dir: 'BEARISH', name: 'Shooting Star', n: 1, hint: 'Long upper wick after a rise — buyers rejected' },
  { id: 'bearish_engulfing', dir: 'BEARISH', name: 'Bearish Engulfing', n: 2, hint: 'Red candle swallows the green one before it' },
  { id: 'dark_cloud_cover', dir: 'BEARISH', name: 'Dark Cloud Cover', n: 2, hint: 'Red candle closes below the middle of the green one' },
  { id: 'evening_star', dir: 'BEARISH', name: 'Evening Star', n: 3, hint: 'Green · small indecision · strong red' },
  { id: 'three_black_crows', dir: 'BEARISH', name: 'Three Black Crows', n: 3, hint: 'Three strong red candles in a row' },
  { id: 'bearish_harami', dir: 'BEARISH', name: 'Bearish Harami', n: 2, hint: 'Small red candle inside a big green one' },
  { id: 'tweezer_top', dir: 'BEARISH', name: 'Tweezer Top', n: 2, hint: 'Two candles with the same high — resistance held' },
  { id: 'gravestone_doji', dir: 'BEARISH', name: 'Gravestone Doji', n: 1, hint: 'Open = close at the bottom, long upper wick' },
];

export const PATTERN_IDS = PATTERNS.map((p) => p.id);
const META = Object.fromEntries(PATTERNS.map((p) => [p.id, p]));

// ── candle helpers ───────────────────────────────────────────
const body = (c) => Math.abs(c.close - c.open);
const range = (c) => c.high - c.low;
const top = (c) => Math.max(c.open, c.close);
const bot = (c) => Math.min(c.open, c.close);
const upper = (c) => c.high - top(c);
const lower = (c) => bot(c) - c.low;
const bull = (c) => c.close > c.open;
const bear = (c) => c.close < c.open;
const mid = (c) => (c.open + c.close) / 2;

/** simple ATR(14) per candle (index i uses candles up to i) */
export function atrSeries(candles, period = 14) {
  const out = new Array(candles.length).fill(0);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr = i === 0 ? range(c) : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
    if (i < period) {
      sum += tr;
      out[i] = sum / (i + 1);
    } else {
      out[i] = (out[i - 1] * (period - 1) + tr) / period;
    }
  }
  return out;
}

const TREND_BARS = 5; // how far back the "prior move" is measured
const TREND_MIN_ATR = 1.0; // the prior move must be at least this many ATR

/** net move over the TREND_BARS candles before `start`, in ATR units (+ = rose, − = fell) */
function priorMove(candles, start, atr) {
  if (start < 1 || !(atr > 0)) return 0;
  const from = Math.max(0, start - TREND_BARS);
  return (candles[start - 1].close - candles[from].open) / atr;
}

// ── shape tests (single candle) ──────────────────────────────
function isHammerShape(c, atr) {
  const b = body(c);
  const r = range(c);
  return r >= 0.5 * atr && b > 0 && lower(c) >= 2 * b && upper(c) <= Math.max(0.35 * b, 0.1 * r) && bot(c) >= c.low + 0.6 * r;
}
function isInvertedShape(c, atr) {
  const b = body(c);
  const r = range(c);
  return r >= 0.5 * atr && b > 0 && upper(c) >= 2 * b && lower(c) <= Math.max(0.35 * b, 0.1 * r) && top(c) <= c.high - 0.6 * r;
}
const isDoji = (c) => range(c) > 0 && body(c) <= 0.1 * range(c);
const isLong = (c, atr) => body(c) >= 0.6 * atr && body(c) >= 0.5 * range(c);
const isSmall = (c, ref) => body(c) <= 0.4 * ref;

/**
 * Does `id` end on candle index `i`? → null | { start }
 * (`atr` = ATR at i, `down` / `up` = whether a prior down / up move exists before the pattern start)
 */
function test(id, cs, i, atr, ctx) {
  const c = cs[i];
  const p = cs[i - 1];
  const pp = cs[i - 2];
  switch (id) {
    case 'hammer':
      return isHammerShape(c, atr) && ctx.down(i) ? { start: i } : null;
    case 'inverted_hammer':
      return isInvertedShape(c, atr) && ctx.down(i) ? { start: i } : null;
    case 'hanging_man':
      return isHammerShape(c, atr) && ctx.up(i) ? { start: i } : null;
    case 'shooting_star':
      return isInvertedShape(c, atr) && ctx.up(i) ? { start: i } : null;
    case 'dragonfly_doji':
      return range(c) >= 0.5 * atr && isDoji(c) && lower(c) >= 0.65 * range(c) && upper(c) <= 0.1 * range(c) && ctx.down(i) ? { start: i } : null;
    case 'gravestone_doji':
      return range(c) >= 0.5 * atr && isDoji(c) && upper(c) >= 0.65 * range(c) && lower(c) <= 0.1 * range(c) && ctx.up(i) ? { start: i } : null;

    case 'bullish_engulfing':
      return p && bear(p) && bull(c) && c.open <= p.close && c.close >= p.open && body(c) > body(p) && body(p) >= 0.25 * atr && ctx.down(i - 1) ? { start: i - 1 } : null;
    case 'bearish_engulfing':
      return p && bull(p) && bear(c) && c.open >= p.close && c.close <= p.open && body(c) > body(p) && body(p) >= 0.25 * atr && ctx.up(i - 1) ? { start: i - 1 } : null;

    case 'piercing_line':
      return p && bear(p) && isLong(p, atr) && bull(c) && c.open <= p.close && c.close > mid(p) && c.close < p.open && ctx.down(i - 1) ? { start: i - 1 } : null;
    case 'dark_cloud_cover':
      return p && bull(p) && isLong(p, atr) && bear(c) && c.open >= p.close && c.close < mid(p) && c.close > p.open && ctx.up(i - 1) ? { start: i - 1 } : null;

    case 'bullish_harami':
      return p && bear(p) && isLong(p, atr) && bull(c) && c.open >= p.close && c.close <= p.open && body(c) <= 0.6 * body(p) && body(c) > 0 && ctx.down(i - 1) ? { start: i - 1 } : null;
    case 'bearish_harami':
      return p && bull(p) && isLong(p, atr) && bear(c) && c.open <= p.close && c.close >= p.open && body(c) <= 0.6 * body(p) && body(c) > 0 && ctx.up(i - 1) ? { start: i - 1 } : null;

    case 'tweezer_bottom':
      return p && bear(p) && bull(c) && Math.abs(c.low - p.low) <= 0.1 * atr && body(p) >= 0.3 * atr && body(c) >= 0.2 * atr && ctx.down(i - 1) ? { start: i - 1 } : null;
    case 'tweezer_top':
      return p && bull(p) && bear(c) && Math.abs(c.high - p.high) <= 0.1 * atr && body(p) >= 0.3 * atr && body(c) >= 0.2 * atr && ctx.up(i - 1) ? { start: i - 1 } : null;

    case 'morning_star':
      return pp && bear(pp) && isLong(pp, atr) && isSmall(p, body(pp)) && top(p) <= pp.close + 0.1 * body(pp) && bull(c) && c.close > mid(pp) && body(c) >= 0.5 * atr && ctx.down(i - 2) ? { start: i - 2 } : null;
    case 'evening_star':
      return pp && bull(pp) && isLong(pp, atr) && isSmall(p, body(pp)) && bot(p) >= pp.close - 0.1 * body(pp) && bear(c) && c.close < mid(pp) && body(c) >= 0.5 * atr && ctx.up(i - 2) ? { start: i - 2 } : null;

    case 'three_white_soldiers':
      return pp && [pp, p, c].every((x) => bull(x) && body(x) >= 0.5 * atr && body(x) >= 0.5 * range(x) && upper(x) <= 0.35 * body(x)) &&
        p.close > pp.close && c.close > p.close && p.open >= pp.open && p.open <= pp.close && c.open >= p.open && c.open <= p.close && ctx.down(i - 2) ? { start: i - 2 } : null;
    case 'three_black_crows':
      return pp && [pp, p, c].every((x) => bear(x) && body(x) >= 0.5 * atr && body(x) >= 0.5 * range(x) && lower(x) <= 0.35 * body(x)) &&
        p.close < pp.close && c.close < p.close && p.open <= pp.open && p.open >= pp.close && c.open <= p.open && c.open >= p.close && ctx.up(i - 2) ? { start: i - 2 } : null;
    default:
      return null;
  }
}

/**
 * Scan candles for the chosen patterns.
 * @param {object[]} candles closed candles, oldest → newest
 * @param {{patterns?: string[], requireTrend?: boolean, warmup?: number}} opts
 * @returns {object[]} detections, newest first
 */
export function scanCandlePatterns(candles, opts = {}) {
  const ids = (Array.isArray(opts.patterns) && opts.patterns.length ? opts.patterns : PATTERN_IDS).filter((x) => META[x]);
  const requireTrend = opts.requireTrend !== false;
  const warmup = Number.isFinite(+opts.warmup) ? +opts.warmup : 15;
  const out = [];
  if (!Array.isArray(candles) || candles.length < 4) return out;
  const atr = atrSeries(candles);

  for (let i = Math.max(2, warmup); i < candles.length; i++) {
    const a = atr[i - 1] || atr[i]; // ATR known BEFORE the pattern's last candle
    if (!(a > 0)) continue;
    const ctx = {
      down: (start) => !requireTrend || priorMove(candles, start, atr[Math.max(0, start - 1)] || a) <= -TREND_MIN_ATR,
      up: (start) => !requireTrend || priorMove(candles, start, atr[Math.max(0, start - 1)] || a) >= TREND_MIN_ATR,
    };
    for (const id of ids) {
      const hit = test(id, candles, i, a, ctx);
      if (!hit) continue;
      const meta = META[id];
      const seg = candles.slice(hit.start, i + 1);
      out.push({
        id,
        name: meta.name,
        dir: meta.dir,
        candles: meta.n,
        startIndex: hit.start,
        index: i,
        startTime: candles[hit.start].time,
        time: candles[i].time,
        high: Math.max(...seg.map((x) => x.high)),
        low: Math.min(...seg.map((x) => x.low)),
        close: candles[i].close,
        priorMoveAtr: +Math.abs(priorMove(candles, hit.start, a)).toFixed(2),
      });
    }
  }
  return out.sort((x, y) => y.index - x.index || x.name.localeCompare(y.name));
}
