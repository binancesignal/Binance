import { calcATR } from '../../indicators.js';
import { CHART_PATTERN_CONFIG as CFG } from './config.js';
import { lineAt } from './patterns.js';

const avgVol = (cs) => (cs.length ? cs.reduce((a, c) => a + (c.volume || 0), 0) / cs.length : 0);

/** level of the pattern boundary at candle index i (sloped trendlines supported) */
function boundary(pattern, side, i) {
  const ln = side === 'up' ? pattern.upperLine : pattern.lowerLine;
  const v = ln ? lineAt(ln, i) : null;
  if (v != null) return v;
  return side === 'up' ? pattern.resistance : pattern.support;
}

/**
 * Validate breakout for a pattern against the latest CLOSED candle.
 * `candles` = pattern TF candles incl. the forming last candle.
 * Returns { ok, direction, entry, reason, rvol, level, breakoutIndex, distAtr, bodyRatio, ... }
 */
export function validateBreakout(pattern, candles, atr, cfg = CFG) {
  if (!candles?.length) return { ok: false, reason: 'No candles' };
  const atrVal = atr > 0 ? atr : calcATR(candles, 14) || 0;
  const closed = candles.slice(0, -1);
  if (closed.length < 25) return { ok: false, reason: 'Not enough closed candles' };

  const bi = closed.length - 1; // breakout candle index
  const lastClosed = closed[bi];
  const isNeutral = pattern.direction === 'NEUTRAL';

  // ----- direction + level at the breakout candle (sloped lines) -----
  const upAt = (i) => boundary(pattern, 'up', i);
  const dnAt = (i) => boundary(pattern, 'dn', i);
  let direction = pattern.direction;
  if (isNeutral) {
    const brokeUp = lastClosed.close > upAt(bi);
    const brokeDn = lastClosed.close < dnAt(bi);
    if (brokeUp && !brokeDn) direction = 'LONG';
    else if (brokeDn && !brokeUp) direction = 'SHORT';
    else return { ok: false, reason: 'No clear directional breakout' };
  }
  const levelAt = (i) => (direction === 'LONG' ? upAt(i) : dnAt(i));
  // double top/bottom & flags break the neckline / flag edge
  const level = levelAt(bi);
  if (level == null || !Number.isFinite(level)) return { ok: false, reason: 'No breakout level' };

  const beyond = (c, lvl) => (direction === 'LONG' ? c.close > lvl : c.close < lvl);

  if (cfg.requireCandleClose && !beyond(lastClosed, level)) {
    return { ok: false, reason: direction === 'LONG' ? 'No candle close above breakout level' : 'No candle close below breakout level' };
  }
  if (!cfg.requireCandleClose) {
    const wick = direction === 'LONG' ? lastClosed.high > level : lastClosed.low < level;
    if (!wick) return { ok: false, reason: 'No wick/close beyond level' };
  }

  // ----- freshness: this must be the FIRST close beyond the boundary since the pattern ended -----
  if (cfg.requireFreshBreakout !== false) {
    const from = Math.max((pattern.endIndex ?? 0) + 1, 0);
    for (let i = from; i < bi; i++) {
      const lv = levelAt(i);
      if (lv != null && beyond(closed[i], lv)) {
        return { ok: false, reason: 'Stale breakout (already closed beyond level earlier)' };
      }
    }
  }

  // ----- breakout distance vs ATR -----
  const dist = direction === 'LONG' ? lastClosed.close - level : level - lastClosed.close;
  let distAtr = 0;
  if (atrVal > 0) {
    distAtr = dist / atrVal;
    if (distAtr < (cfg.breakoutAtrMin ?? 0.2)) return { ok: false, reason: `Breakout distance ${distAtr.toFixed(2)} ATR < min` };
    if (distAtr > (cfg.maxBreakoutDistanceATR ?? 1.5)) return { ok: false, reason: `Breakout too extended ${distAtr.toFixed(2)} ATR` };
  }

  // ----- candle quality -----
  const range = lastClosed.high - lastClosed.low || 1e-9;
  const bodyRatio = Math.abs(lastClosed.close - lastClosed.open) / range;
  if (bodyRatio < (cfg.minBodyRatio ?? 0.5)) return { ok: false, reason: 'Breakout candle mostly wick' };
  if (direction === 'LONG' && lastClosed.close <= lastClosed.open) return { ok: false, reason: 'Breakout candle not bullish' };
  if (direction === 'SHORT' && lastClosed.close >= lastClosed.open) return { ok: false, reason: 'Breakout candle not bearish' };

  // ----- volume: breakout candle vs its own 20-bar average -----
  const base = avgVol(closed.slice(-21, -1));
  const rvol = base > 0 ? (lastClosed.volume || 0) / base : 1;
  if (cfg.requireVolumeConfirmation && rvol < (cfg.minRelativeVolume ?? 1.3)) {
    return { ok: false, reason: `RVOL ${rvol.toFixed(2)} < min ${cfg.minRelativeVolume}`, rvol };
  }

  // ----- optional retest -----
  let retestOk = !cfg.requireRetest;
  if (cfg.requireRetest) {
    const win = closed.slice(-10);
    let broke = false;
    let retested = false;
    for (const c of win) {
      if (direction === 'LONG') {
        if (c.close > level) broke = true;
        if (broke && c.low <= level * 1.002 && c.close > level) retested = true;
      } else {
        if (c.close < level) broke = true;
        if (broke && c.high >= level * 0.998 && c.close < level) retested = true;
      }
    }
    retestOk = retested;
    if (!retestOk) return { ok: false, reason: 'Retest not confirmed', rvol };
  }

  const confN = Math.max(1, cfg.breakoutConfirmationCandles || 1);
  if (confN > 1) {
    const ok = closed.slice(-confN).every((c, k) => beyond(c, levelAt(bi - (confN - 1 - k))));
    if (!ok) return { ok: false, reason: `Need ${confN} confirmation closes`, rvol };
  }

  return {
    ok: true,
    direction,
    entry: lastClosed.close,
    level,
    rvol,
    distAtr,
    bodyRatio,
    breakoutIndex: bi,
    breakoutCandle: lastClosed,
    retestOk,
    reason: 'Breakout confirmed',
  };
}

export function computeFibConfluence(pattern, entry, direction, tolerancePct = 0.5) {
  const hi = pattern.resistance;
  const lo = pattern.support;
  if (!hi || !lo || hi <= lo) return { ok: false, level: null };
  const range = hi - lo;
  const levels = [0.382, 0.5, 0.618, 0.786, 1.0, 1.272, 1.618];
  const tol = (tolerancePct / 100) * entry;
  for (const r of levels) {
    const lvl = direction === 'LONG' ? lo + range * r : hi - range * r;
    if (Math.abs(entry - lvl) <= tol) return { ok: true, level: r, price: lvl };
  }
  return { ok: false, level: null };
}

/**
 * PRE-BREAKOUT check: pattern is valid, price is pressing on the boundary,
 * but no qualifying breakout candle has closed yet.
 *
 *  gapAtr > 0  → price still inside the pattern, that many ATR from the boundary
 *  gapAtr <= 0 → the still-forming candle is already beyond the boundary (waiting for the close)
 *
 * Returns { ok, direction, level, gapAtr, gapPct, state, approaching, volBuild, age, ... }
 */
export function evaluateNearBreakout(pattern, candles, atr, price, cfg = CFG) {
  if (!candles?.length) return { ok: false, reason: 'No candles' };
  const closed = candles.slice(0, -1);
  if (closed.length < 25) return { ok: false, reason: 'Not enough closed candles' };
  const atrVal = atr > 0 ? atr : calcATR(candles, 14) || 0;
  if (!(atrVal > 0)) return { ok: false, reason: 'No ATR' };

  const bi = closed.length - 1; // last CLOSED candle
  const fi = candles.length - 1; // forming candle (level is projected here for sloped lines)
  const px = Number.isFinite(+price) && +price > 0 ? +price : candles[fi].close;

  const age = bi - (pattern.endIndex ?? bi);
  // nearMaxPatternAge: 0 = disable age-based rejection
  // Stale rescue (rechecks of already-tracked setups only): the hard cap replaces the strict age limit;
  // the "old AND far from level" rule is applied by recheckNearBreakout.
  const rescue = cfg.nearRecheck === true && cfg.nearStaleRescue === true;
  const maxPatternAge = rescue ? (cfg.nearStaleRescueMaxAge ?? 150) : (cfg.nearMaxPatternAge ?? 30);
  if (maxPatternAge > 0 && age > maxPatternAge) {
    return { ok: false, reason: `Pattern too old (${age} candles)`, code: 'too_old', age };
  }

  const upAt = (i) => boundary(pattern, 'up', i);
  const dnAt = (i) => boundary(pattern, 'dn', i);
  const dirs = pattern.direction === 'NEUTRAL' ? ['LONG', 'SHORT'] : [pattern.direction];

  const maxGap = cfg.nearMaxGapATR ?? 0.6;
  const maxPast = cfg.nearLivePastATR ?? 0.5;
  let best = null;
  let lastReason = 'Not near boundary';
  let lastGapAtr = null;
  let lastCode = 'not_near'; // not_near | no_level | already_beyond | opposite_side | extended_forming

  for (const direction of dirs) {
    const levelAt = (i) => (direction === 'LONG' ? upAt(i) : dnAt(i));
    const oppAt = (i) => (direction === 'LONG' ? dnAt(i) : upAt(i));
    const beyond = (c, lvl) => (direction === 'LONG' ? c.close > lvl : c.close < lvl);
    const level = levelAt(fi);
    if (level == null || !Number.isFinite(level)) { lastReason = 'No breakout level'; lastCode = 'no_level'; continue; }

    // a close already beyond the boundary = real breakout (handled elsewhere) or a stale one
    const from = Math.max((pattern.endIndex ?? 0) + 1, 0);
    let already = false;
    for (let i = from; i <= bi; i++) {
      const lv = levelAt(i);
      if (lv != null && beyond(closed[i], lv)) { already = true; break; }
    }
    if (already) { lastReason = 'Already closed beyond level'; lastCode = 'already_beyond'; continue; }

    // pattern must not have failed through the opposite side
    const opp = oppAt(fi);
    if (opp != null) {
      const failed = direction === 'LONG' ? px < opp - 0.1 * atrVal : px > opp + 0.1 * atrVal;
      if (failed) { lastReason = 'Price left pattern through opposite side'; lastCode = 'opposite_side'; continue; }
    }

    const gap = direction === 'LONG' ? level - px : px - level; // >0 = still inside
    const gapAtr = gap / atrVal;
    lastGapAtr = gapAtr;
    if (gapAtr > maxGap) { lastReason = `Too far from level (${gapAtr.toFixed(2)} ATR)`; lastCode = 'not_near'; continue; }
    if (gapAtr < -maxPast) { lastReason = 'Forming candle already extended past level'; lastCode = 'extended_forming'; continue; }

    // is price actually pressing toward the level? (closer than 3 candles ago)
    const ref = closed[Math.max(0, bi - 3)].close;
    const gapBefore = direction === 'LONG' ? level - ref : ref - level;
    const approaching = gap <= gapBefore;

    // volume build-up: last 3 closed candles vs the 20 before them
    const volBuild = (() => {
      const base = avgVol(closed.slice(-23, -3));
      const recent = avgVol(closed.slice(-3));
      return base > 0 ? recent / base : 1;
    })();

    const cand = {
      ok: true,
      direction,
      level,
      gapAtr,
      gapPct: (Math.abs(gap) / px) * 100,
      state: gapAtr <= 0 ? 'BREAKING_NOW' : gapAtr <= 0.25 ? 'AT_LEVEL' : 'APPROACHING',
      approaching,
      volBuild,
      age,
      atrVal,
      breakoutIndex: bi,
      reason: 'Near breakout',
    };
    if (!best || Math.abs(cand.gapAtr) < Math.abs(best.gapAtr)) best = cand;
  }

  return best || { ok: false, reason: lastReason, code: lastCode, age, gapAtr: lastGapAtr };
}
