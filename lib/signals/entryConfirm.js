/**
 * Entry confirmation + retest watching + breakout quality.
 *
 * Rules (user-requested):
 * 1. Scan: if TP1 already hit → MISSED (do not store / invalidate)
 * 2. Scan: if price is between entry and TP1 (past entry toward profit) → RETEST watching
 * 3. Do NOT enter on mere touch of entry
 * 4. Require pattern-TF CLOSED candle that CLOSES beyond entry (break confirm)
 * 5. Enter on the NEXT candle after that break close
 * 6. If price reaches TP1 before entry fill (break candle runs to TP1) → INVALID (missed / no chase)
 * 7. Extreme chase beyond maxChaseATR AND maxChaseR also blocks entry
 * 8. Breakout must pass quality checks (body, direction, min distance)
 */

import { SIGNAL_CONFIG } from '../config/signalConfig.js';

export const ENTRY_CONFIRM_DEFAULTS = {
  /** Min body/range of the break candle */
  minBreakBodyRatio: 0.35,
  /** Close must be at least this many ATR beyond entry */
  minBreakBeyondATR: 0.05,
  /** Soft quality: prefer close in top/bottom 50% of candle range in trade direction */
  preferCloseInDirectionHalf: true,
  /** Past entry toward TP beyond this ATR at scan → RETEST mode (not normal limit wait) */
  retestTriggerATR: 0.15,
  /** Retest zone around entry (ATR) */
  retestZoneATR: 0.35,
  /** After retest touch, need close back beyond entry by this ATR */
  retestConfirmBeyondATR: 0.05,
  /** Max extension past entry (ATR) still allowed to enter after confirmed break (don't invalidate at TP1) */
  maxChaseATR: 1.25,
  /** Also as fraction of risk (entry→SL). Entry still allowed up to this even if past TP1 path */
  maxChaseR: 1.0,
  /** If price already past TP1 at scan → reject */
  rejectIfTp1HitAtScan: true,
};

function dirOf(signal) {
  return String(signal.direction || signal.dir || '').toUpperCase();
}

function atrOf(signal, atr5m) {
  const a = +(atr5m || signal.atr_5m || 0);
  if (a > 0) return a;
  const entry = +signal.entry;
  const sl = +signal.sl;
  const risk = Math.abs(entry - sl);
  return risk > 0 ? risk * 0.35 : entry * 0.002;
}

/** +progress = price moved from entry toward TP (favourable) */
export function progressFromEntry(signal, price) {
  const entry = +signal.entry;
  const p = +price;
  const dir = dirOf(signal);
  if (!entry || !p) return 0;
  return dir === 'LONG' ? p - entry : entry - p;
}

export function isPastTp1(signal, price, candleRange = null) {
  const dir = dirOf(signal);
  const tp1 = +signal.tp1;
  if (!tp1) return false;
  const p = +price;
  const hi = candleRange?.high != null ? +candleRange.high : p;
  const lo = candleRange?.low != null ? +candleRange.low : p;
  if (dir === 'LONG') return p >= tp1 || hi >= tp1;
  return p <= tp1 || lo <= tp1;
}

/**
 * Classify position of price relative to entry/TP1 at scan (or monitor).
 * @returns {'BEFORE_ENTRY'|'RETEST_ZONE'|'PAST_ENTRY'|'MISSED_TP1'}
 */
export function classifyEntrySide(signal, price, atr5m, cfg = ENTRY_CONFIRM_DEFAULTS) {
  const entry = +signal.entry;
  const p = +price;
  const atr = atrOf(signal, atr5m);
  const prog = progressFromEntry(signal, p);
  if (cfg.rejectIfTp1HitAtScan !== false && isPastTp1(signal, p)) return 'MISSED_TP1';
  if (prog <= 0) return 'BEFORE_ENTRY';
  const trigger = (cfg.retestTriggerATR ?? 0.15) * atr;
  if (prog < trigger) return 'BEFORE_ENTRY'; // tiny noise past entry still normal
  return 'PAST_ENTRY'; // between entry and TP1 → retest watching
}

/**
 * Breakout quality on a single closed candle vs entry.
 */
export function scoreBreakCandle(candle, signal, atr, cfg = ENTRY_CONFIRM_DEFAULTS) {
  const reasons = [];
  const entry = +signal.entry;
  const dir = dirOf(signal);
  if (!candle || !entry) return { ok: false, score: 0, reasons: ['no candle/entry'] };

  const range = Math.max(1e-12, +candle.high - +candle.low);
  const body = Math.abs(+candle.close - +candle.open);
  const bodyRatio = body / range;
  const beyond =
    dir === 'LONG' ? +candle.close - entry : entry - +candle.close;
  const beyondAtr = atr > 0 ? beyond / atr : 0;

  if (dir === 'LONG' && !(+candle.close > entry)) {
    reasons.push('close not above entry');
  }
  if (dir === 'SHORT' && !(+candle.close < entry)) {
    reasons.push('close not below entry');
  }
  if (dir === 'LONG' && +candle.close <= +candle.open) {
    reasons.push('break candle not bullish');
  }
  if (dir === 'SHORT' && +candle.close >= +candle.open) {
    reasons.push('break candle not bearish');
  }
  if (bodyRatio < (cfg.minBreakBodyRatio ?? 0.35)) {
    reasons.push(`body ratio ${bodyRatio.toFixed(2)} < min`);
  }
  if (beyondAtr < (cfg.minBreakBeyondATR ?? 0.05)) {
    reasons.push(`beyond entry ${beyondAtr.toFixed(2)} ATR < min`);
  }

  // Close location in candle (directional)
  let closeLoc = 0.5;
  if (dir === 'LONG') closeLoc = (+candle.close - +candle.low) / range;
  else closeLoc = (+candle.high - +candle.close) / range;
  if (cfg.preferCloseInDirectionHalf && closeLoc < 0.45) {
    reasons.push('close not in directional half of range');
  }

  let score = 50;
  score += Math.min(25, bodyRatio * 40);
  score += Math.min(15, beyondAtr * 20);
  score += Math.min(10, closeLoc * 12);
  if (reasons.some((r) => r.includes('not bullish') || r.includes('not bearish') || r.includes('not above') || r.includes('not below'))) {
    score = Math.min(score, 30);
  }

  // Hard fails: must close beyond + correct direction candle
  const hardFail = reasons.some(
    (r) =>
      r.includes('not above') ||
      r.includes('not below') ||
      r.includes('not bullish') ||
      r.includes('not bearish') ||
      r.includes('beyond entry')
  );

  return {
    ok: !hardFail && bodyRatio >= (cfg.minBreakBodyRatio ?? 0.35) * 0.85,
    score: Math.round(Math.max(0, Math.min(100, score))),
    reasons,
    bodyRatio: +bodyRatio.toFixed(3),
    beyondAtr: +beyondAtr.toFixed(3),
    closeLoc: +closeLoc.toFixed(3),
  };
}

/**
 * Given closed candles (oldest→newest, no forming bar), find break + next-candle entry.
 *
 * @returns {{
 *   breakConfirmed: boolean,
 *   canEnter: boolean,
 *   breakCandle: object|null,
 *   entryCandle: object|null,
 *   quality: object|null,
 *   retestTouched: boolean,
 *   chaseAtr: number,
 *   chaseBlocked: boolean,
 *   reason: string
 * }}
 */
export function evaluateEntryConfirmation(signal, closedCandles, atr5m, cfg = ENTRY_CONFIRM_DEFAULTS) {
  const entry = +signal.entry;
  const dir = dirOf(signal);
  const atr = atrOf(signal, atr5m);
  const empty = {
    breakConfirmed: false,
    canEnter: false,
    breakCandle: null,
    entryCandle: null,
    quality: null,
    retestTouched: false,
    chaseAtr: 0,
    chaseBlocked: false,
    tp1Missed: false,
    reason: 'insufficient candles',
  };
  if (!entry || !closedCandles?.length || closedCandles.length < 2) return empty;

  const meta = signal.metadata || {};
  const isRetest = meta.entryMode === 'RETEST' || meta.retestWatching === true;

  // Price progress on last close
  const last = closedCandles[closedCandles.length - 1];
  const chase = progressFromEntry(signal, last.close);
  const chaseAtr = atr > 0 ? chase / atr : 0;
  const risk = Math.abs(entry - +signal.sl) || atr;
  const chaseR = risk > 0 ? chase / risk : 0;
  const maxChaseAtr = cfg.maxChaseATR ?? 1.25;
  const maxChaseR = cfg.maxChaseR ?? 1.0;
  // TP1 reached before fill → always missed (user rule: invalidate, do not enter)
  const tp1Missed = isPastTp1(
    signal,
    last.close,
    { high: last.high, low: last.low },
  );
  // Extreme chase OR TP1 already tagged on the break/confirm path
  const chaseBlocked =
    tp1Missed ||
    (chase > 0 && chaseAtr > maxChaseAtr && chaseR > maxChaseR);

  // --- RETEST path ---
  // Need: (1) a pullback touch into retest zone near entry, then (2) close beyond entry again
  if (isRetest) {
    const zone = (cfg.retestZoneATR ?? 0.35) * atr;
    let retestTouched = !!meta.retestTouched;
    // scan recent candles for touch of entry zone from the profit side
    for (let i = Math.max(0, closedCandles.length - 12); i < closedCandles.length; i++) {
      const c = closedCandles[i];
      const touch =
        dir === 'LONG'
          ? +c.low <= entry + zone && +c.high >= entry - zone
          : +c.high >= entry - zone && +c.low <= entry + zone;
      if (touch) retestTouched = true;
    }
    if (!retestTouched) {
      return {
        ...empty,
        retestTouched: false,
        chaseAtr,
        reason: 'waiting for retest touch of entry zone',
      };
    }

    // After touch, need a close beyond entry with quality
    const q = scoreBreakCandle(last, signal, atr, cfg);
    if (!q.ok) {
      return {
        ...empty,
        retestTouched: true,
        quality: q,
        chaseAtr,
        reason: `retest touched; waiting quality close beyond entry (${q.reasons[0] || 'pending'})`,
      };
    }
    // Need previous candle to be the first break after retest — enter on this candle if prior was not beyond
    const prev = closedCandles[closedCandles.length - 2];
    const prevBeyond =
      dir === 'LONG' ? +prev.close > entry : +prev.close < entry;
    // If prev already beyond and last beyond → this is "next candle" after break
    // If only last beyond → break just confirmed; wait next candle unless prev was retest wick only
    const breakJustHappened = q.ok && !prevBeyond;
    const nextAfterBreak = q.ok && prevBeyond;

    if (breakJustHappened) {
      return {
        breakConfirmed: true,
        canEnter: false,
        breakCandle: last,
        entryCandle: null,
        quality: q,
        retestTouched: true,
        chaseAtr,
        chaseBlocked,
        reason: 'retest break close confirmed — wait next candle to enter',
      };
    }
    if (nextAfterBreak || (q.ok && retestTouched && prevBeyond)) {
      if (chaseBlocked) {
        return {
          breakConfirmed: true,
          canEnter: false,
          breakCandle: prev,
          entryCandle: last,
          quality: q,
          retestTouched: true,
          chaseAtr,
          chaseBlocked: true,
          tp1Missed: !!tp1Missed,
          reason: `chase too far (${chaseAtr.toFixed(2)} ATR / ${chaseR.toFixed(2)}R)`,
        };
      }
      return {
        breakConfirmed: true,
        canEnter: true,
        breakCandle: prev,
        entryCandle: last,
        quality: q,
        retestTouched: true,
        chaseAtr,
        chaseBlocked: false,
        tp1Missed: false,
        reason: 'retest confirmed — enter on next candle',
      };
    }
    return {
      ...empty,
      retestTouched: true,
      quality: q,
      chaseAtr,
      reason: 'retest in progress',
    };
  }

  // --- NORMAL path: break close → enter next candle ---
  // Look for most recent candle that quality-closes beyond entry
  let breakIdx = -1;
  let quality = null;
  for (let i = closedCandles.length - 1; i >= Math.max(0, closedCandles.length - 8); i--) {
    const q = scoreBreakCandle(closedCandles[i], signal, atr, cfg);
    if (q.ok) {
      breakIdx = i;
      quality = q;
      break;
    }
  }
  if (breakIdx < 0) {
    return {
      ...empty,
      chaseAtr,
      reason: 'waiting for candle close beyond entry',
    };
  }

  const breakCandle = closedCandles[breakIdx];
  // Enter on the NEXT candle after break close:
  // - if break is the latest closed bar → allowed once a newer forming bar exists (opts.hasForming)
  // - or when a later closed bar exists after the break bar
  if (breakIdx >= closedCandles.length - 1) {
    // break is last closed — enter only if we are already into the next (forming) candle
    // Caller sets cfg.allowEnterOnFormingNext = true when forming bar is present after last close
    if (cfg.allowEnterOnFormingNext) {
      if (chaseBlocked) {
        return {
          breakConfirmed: true,
          canEnter: false,
          breakCandle,
          entryCandle: null,
          quality,
          retestTouched: false,
          chaseAtr,
          chaseBlocked: true,
          tp1Missed: !!tp1Missed,
          reason: `chase too far (${chaseAtr.toFixed(2)} ATR)`,
        };
      }
      return {
        breakConfirmed: true,
        canEnter: true,
        breakCandle,
        entryCandle: null,
        quality,
        retestTouched: false,
        chaseAtr,
        chaseBlocked: false,
        tp1Missed: false,
        reason: 'next candle after break close — enter',
      };
    }
    return {
      breakConfirmed: true,
      canEnter: false,
      breakCandle,
      entryCandle: null,
      quality,
      retestTouched: false,
      chaseAtr,
      chaseBlocked,
      tp1Missed: !!tp1Missed,
      reason: 'break close confirmed — wait next candle to enter',
    };
  }

  const entryCandle = closedCandles[closedCandles.length - 1];
  // entry candle must still be on the correct side (not full reverse)
  const stillValid =
    dir === 'LONG' ? +entryCandle.close >= entry : +entryCandle.close <= entry;
  if (!stillValid) {
    return {
      breakConfirmed: true,
      canEnter: false,
      breakCandle,
      entryCandle,
      quality,
      retestTouched: false,
      chaseAtr,
      chaseBlocked,
      tp1Missed: !!tp1Missed,
      reason: 'broke entry then reversed before next-candle entry',
    };
  }
  if (chaseBlocked) {
    return {
      breakConfirmed: true,
      canEnter: false,
      breakCandle,
      entryCandle,
      quality,
      retestTouched: false,
      chaseAtr,
      chaseBlocked: true,
      reason: `chase too far (${chaseAtr.toFixed(2)} ATR)`,
    };
  }

  return {
    breakConfirmed: true,
    canEnter: true,
    breakCandle,
    entryCandle,
    quality,
    retestTouched: false,
    chaseAtr,
    chaseBlocked: false,
    tp1Missed: false,
    reason: 'next candle after break — enter',
  };
}

/**
 * Scan-time helper: should we skip, mark retest, or accept normal watching?
 */
export function classifyNewSignalEntry(signalLike, price, atr5m, cfg = ENTRY_CONFIRM_DEFAULTS) {
  const side = classifyEntrySide(signalLike, price, atr5m, cfg);
  if (side === 'MISSED_TP1') {
    return { accept: false, entryMode: null, reason: 'TP1 already hit at scan — invalid' };
  }
  if (side === 'PAST_ENTRY') {
    return {
      accept: true,
      entryMode: 'RETEST',
      retestWatching: true,
      reason: 'price between entry and TP1 — retest watching',
    };
  }
  return { accept: true, entryMode: 'NORMAL', retestWatching: false, reason: 'before entry — normal watching' };
}

export function mergeEntryConfirmCfg(overrides) {
  return { ...ENTRY_CONFIRM_DEFAULTS, ...(overrides || {}), ...(SIGNAL_CONFIG.entryConfirm || {}) };
}
