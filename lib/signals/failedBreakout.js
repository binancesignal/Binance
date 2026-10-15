/**
 * Failed-breakout detection — ONE generic rule for every chart pattern.
 *
 * A confirmed breakout is "failed" when a CLOSED candle (after the breakout candle) closes
 * back on the wrong side of the broken boundary:
 *   SHORT: close > level   (price climbed back above the broken support/neckline)
 *   LONG : close < level   (price fell back below the broken resistance/neckline)
 *
 * "ATR line": a single close back inside only counts as a CLEAR fake when it is deeper than
 * `bufferAtr` × ATR behind the broken level. Shallower closes are normal retest noise, so they
 * only invalidate after `confirmCandles` CONSECUTIVE closed candles stay back inside.
 * Harmonic patterns are reversals at a PRZ (no broken boundary) → never checked here;
 * their stop-loss is the invalidation.
 *
 * The boundary comes from the stored pattern geometry (works for horizontal necklines AND
 * sloped wedge/triangle/channel lines, via linear interpolation on time). Falls back to
 * the static breakoutLevel when no geometry is stored.
 */

const TF_SEC = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200, '1d': 86400,
};
export const tfSeconds = (tf) => TF_SEC[String(tf || '').toLowerCase()] || 3600;

const dirOf = (sig) => String(sig.direction || sig.dir || '').toUpperCase();

/** Broken-boundary price at time tSec (unix seconds). null if unknown. */
export function breakoutLevelAt(sig, tSec) {
  const meta = sig.metadata || {};
  const dir = dirOf(sig);
  const kind = dir === 'LONG' ? 'upper' : dir === 'SHORT' ? 'lower' : null;
  const ln = kind ? (meta.patternGeom?.lines || []).find((l) => l.kind === kind) : null;
  if (ln && ln.t2 != null && ln.t1 != null && ln.t2 !== ln.t1 && Number.isFinite(+ln.p1) && Number.isFinite(+ln.p2)) {
    return +ln.p1 + ((+ln.p2 - +ln.p1) * (tSec - +ln.t1)) / (+ln.t2 - +ln.t1);
  }
  const lvl = +(meta.breakoutLevel ?? meta.patternGeom?.level);
  return Number.isFinite(lvl) && lvl > 0 ? lvl : null;
}

/** Is a confirmed chart-pattern signal currently a breakout (not near/pending)? */
export function isConfirmedPatternBreakout(sig) {
  const meta = sig.metadata || {};
  return (
    (meta.strategy || sig.strategy) === 'chart_pattern' &&
    meta.breakoutConfirmed === true &&
    meta.nearBreakout !== true &&
    !meta.patternGeom?.harmonic
  );
}

/**
 * Closed-candle check. `candles` = pattern-TF candles (time = open, unix sec).
 * Returns { failed, level, close, time } — failed=false if nothing wrong / not enough data.
 */
export function checkFailedBreakout(
  sig,
  candles,
  { atr = 0, bufferAtr = 0.5, confirmCandles = 2, nowSec = Math.floor(Date.now() / 1000) } = {}
) {
  if (!isConfirmedPatternBreakout(sig) || !Array.isArray(candles) || !candles.length) return { failed: false };
  const dir = dirOf(sig);
  if (dir !== 'LONG' && dir !== 'SHORT') return { failed: false };
  const meta = sig.metadata || {};
  const sec = tfSeconds(meta.patternTf);

  // candles that closed AFTER the breakout candle
  const baseline =
    +meta.breakoutCandleTime ||
    (sig.ready_at ? Math.floor(new Date(sig.ready_at).getTime() / 1000) - sec : 0) ||
    (sig.created_at ? Math.floor(new Date(sig.created_at).getTime() / 1000) - sec : 0);
  if (!baseline) return { failed: false };

  const need = Math.max(1, Math.round(+confirmCandles || 1));
  const deep = Math.max(0, +bufferAtr || 0);
  let run = 0;
  for (const c of candles) {
    if (!(c.time > baseline)) continue; // the breakout candle itself / older
    if (c.time + sec > nowSec) continue; // still forming
    const lvl = breakoutLevelAt(sig, c.time + sec);
    if (lvl == null) continue;
    const depth = dir === 'SHORT' ? c.close - lvl : lvl - c.close; // >0 = back inside
    if (depth <= 0) {
      run = 0; // closed outside again → it was just a retest
      continue;
    }
    run++;
    const depthAtr = atr > 0 ? depth / atr : 0;
    // 1) one close deeper than the ATR line = clear fake
    if (atr > 0 && depthAtr >= deep) {
      return { failed: true, kind: 'deep', level: lvl, close: c.close, time: c.time, depthAtr, atrLine: deep };
    }
    // 2) several consecutive closes back inside = breakout did not hold
    if (run >= need) {
      return { failed: true, kind: 'held_inside', level: lvl, close: c.close, time: c.time, depthAtr, atrLine: deep, closes: run };
    }
  }
  return { failed: false };
}

/** Live-price guard (used by auto-trader): price is already back inside the pattern. */
export function priceBackInside(sig, price, nowSec = Math.floor(Date.now() / 1000)) {
  if (!isConfirmedPatternBreakout(sig)) return false;
  const p = +price;
  if (!(p > 0)) return false;
  const lvl = breakoutLevelAt(sig, nowSec);
  if (lvl == null) return false;
  return dirOf(sig) === 'SHORT' ? p > lvl : dirOf(sig) === 'LONG' ? p < lvl : false;
}
