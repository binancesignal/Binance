/**
 * Risk sizing for per-user Binance auto-trade (pure functions, no I/O).
 *
 *  High Risk is the only risk mode: a big, fixed slice of the balance (default 25%, never below 25%)
 *  is used as margin for EVERY trade. Leverage is then derived per trade from the SL
 *  distance so the loss at SL stays under a hard cap, plus hard account-level brakes.
 *
 * Why derive leverage instead of picking it: with margin fixed, loss at SL = margin × leverage × SL%.
 * Capping that loss means a tight SL (volatile coin) gets MORE leverage and a wide SL gets LESS,
 * so every trade risks about the same amount of the account.
 */

export const HIGH_RISK_MARGIN_FLOOR = 25; // % — the minimum margin per trade in High Risk mode

export const HIGH_RISK_DEFAULTS = Object.freeze({
  marginPercent: 25, // % of equity used as margin per trade (floor 25)
  maxMarginPercent: 50, // user may raise their own margin % up to this
  maxLossPerTradePercent: 5, // loss at SL, % of equity — leverage is derived from this
  minimumLeverage: 1,
  maximumLeverage: 15,
  minSlDistPct: 0.5, // SL closer than this is market noise → skip
  maxSlDistPct: 8, // SL further than this makes the position too small to matter → skip
  liqBufferMultiple: 1.3, // liquidation must be ≥ SL distance × this
  maintenanceMarginPct: 0.5,
  maxTotalMarginPercent: 75, // all open margin together ≤ this % of equity (this is what limits positions)
  dailyLossLimitPercent: 10, // stop opening trades after losing this % in a day (resets next day)
  drawdownHaltPercent: 20, // stop until re-armed after falling this % from the equity peak
  // Technical floor only (exchange min notional). Starting-capital min is separate (MIN_STARTING_CAPITAL).
  minMarginUsdt: 1,
});

const num = (v, d) => (Number.isFinite(+v) && v !== '' && v !== null ? +v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Merge admin config + (optional) user override, clamped to safe ranges. */
export function resolveHighRiskConfig(stored = {}, userSettings = {}) {
  const s = { ...HIGH_RISK_DEFAULTS, ...(stored || {}) };
  const maxMargin = clamp(num(s.maxMarginPercent, 50), HIGH_RISK_MARGIN_FLOOR, 60);
  const userPct = Number(userSettings?.highRiskMarginPercent);
  const wanted = Number.isFinite(userPct) && userPct > 0 ? userPct : num(s.marginPercent, 25);
  // Old default was $5; that blocked small starting-capital accounts. Migrate silently to $1.
  let minMargin = num(s.minMarginUsdt, 1);
  if (minMargin >= 5) minMargin = 1;
  return {
    marginPercent: clamp(wanted, HIGH_RISK_MARGIN_FLOOR, maxMargin),
    maxMarginPercent: maxMargin,
    maxLossPerTradePercent: clamp(num(s.maxLossPerTradePercent, 5), 0.5, 10),
    minimumLeverage: clamp(Math.floor(num(s.minimumLeverage, 1)), 1, 50),
    maximumLeverage: clamp(Math.floor(num(s.maximumLeverage, 15)), 1, 50),
    minSlDistPct: clamp(num(s.minSlDistPct, 0.5), 0.1, 5),
    maxSlDistPct: clamp(num(s.maxSlDistPct, 8), 1, 30),
    liqBufferMultiple: clamp(num(s.liqBufferMultiple, 1.3), 1, 10),
    maintenanceMarginPct: clamp(num(s.maintenanceMarginPct, 0.5), 0, 5),
    maxTotalMarginPercent: clamp(num(s.maxTotalMarginPercent, 75), HIGH_RISK_MARGIN_FLOOR, 90),
    dailyLossLimitPercent: clamp(num(s.dailyLossLimitPercent, 10), 1, 50),
    drawdownHaltPercent: clamp(num(s.drawdownHaltPercent, 20), 5, 80),
    minMarginUsdt: clamp(minMargin, 0.5, 1000),
  };
}

/** Validate/normalise what the admin saves (never stores out-of-range values). */
export function normalizeHighRiskForSave(input = {}) {
  const r = resolveHighRiskConfig(input, {});
  return { ...r };
}

/**
 * Size one High Risk trade.
 * @param {{equity:number, available:number, usedMargin?:number, entry:number, sl:number,
 *          instrument?:{maxLeverage?:number, leverageStep?:number}, cfg:object}} p
 * @returns {{reject:true, reason:string} | {reject:false, margin:number, marginPercent:number,
 *          leverage:number, notional:number, slDistPct:number, lossAtSl:number,
 *          lossAtSlPct:number, limitedBy:string, totalMarginAfterPct:number}}
 */
export function sizeHighRiskTrade({ equity, available, usedMargin = 0, entry, sl, instrument = {}, cfg }) {
  const eq = +equity;
  const av = +available;
  const e = +entry;
  const s = +sl;
  if (!(eq > 0)) return { reject: true, reason: 'Equity unavailable' };
  if (!(e > 0) || !(s > 0)) return { reject: true, reason: 'Missing entry or SL' };

  const slDistPct = (Math.abs(e - s) / e) * 100;
  if (slDistPct < cfg.minSlDistPct) {
    return { reject: true, reason: `SL too tight (${slDistPct.toFixed(2)}% < min ${cfg.minSlDistPct}%) — market noise` };
  }
  if (slDistPct > cfg.maxSlDistPct) {
    return { reject: true, reason: `SL too wide (${slDistPct.toFixed(2)}% > max ${cfg.maxSlDistPct}%)` };
  }
  const slFrac = slDistPct / 100;

  const margin = (eq * cfg.marginPercent) / 100;
  if (margin < cfg.minMarginUsdt) {
    return { reject: true, reason: `Margin $${margin.toFixed(2)} < minimum $${cfg.minMarginUsdt}` };
  }
  const safeUsed = Number.isFinite(+usedMargin) && +usedMargin > 0 ? +usedMargin : 0;
  const capUsdt = (eq * cfg.maxTotalMarginPercent) / 100;
  if (safeUsed + margin > capUsdt + 1e-9) {
    const usedPct = Math.min(999, (safeUsed / eq) * 100);
    return {
      reject: true,
      reason: `Total margin cap: ${usedPct.toFixed(0)}% in use + ${cfg.marginPercent}% > ${cfg.maxTotalMarginPercent}%`,
    };
  }
  // Never silently shrink below the configured margin: that would break the 25% promise.
  if (margin > av * 0.98) {
    return { reject: true, reason: `Insufficient available balance for ${cfg.marginPercent}% margin ($${margin.toFixed(2)} needed, $${av.toFixed(2)} free)` };
  }

  const marginFrac = margin / eq;
  const byLossCap = cfg.maxLossPerTradePercent / 100 / (marginFrac * slFrac);
  const byLiq = 1 / (slFrac * cfg.liqBufferMultiple + cfg.maintenanceMarginPct / 100);
  const symMax = +instrument.maxLeverage > 0 ? +instrument.maxLeverage : Infinity;
  const byMax = Math.min(cfg.maximumLeverage, symMax);

  const lim = Math.min(byLossCap, byLiq, byMax);
  let limitedBy = 'loss-cap';
  if (lim === byMax) limitedBy = 'max-leverage';
  if (lim === byLiq && byLiq < byLossCap && byLiq < byMax) limitedBy = 'liquidation-safety';

  let leverage = Math.floor(lim + 1e-9);
  const step = +instrument.leverageStep > 0 ? +instrument.leverageStep : 1;
  if (step > 1) leverage = Math.floor(leverage / step) * step;
  if (leverage < cfg.minimumLeverage) {
    return { reject: true, reason: `Safe leverage ${lim.toFixed(2)}x is below minimum ${cfg.minimumLeverage}x` };
  }

  const notional = margin * leverage;
  const lossAtSl = notional * slFrac;
  return {
    reject: false,
    margin,
    marginPercent: cfg.marginPercent,
    leverage,
    notional,
    slDistPct,
    lossAtSl,
    lossAtSlPct: (lossAtSl / eq) * 100,
    limitedBy,
    totalMarginAfterPct: ((safeUsed + margin) / eq) * 100,
  };
}

/** Day key in Sri Lanka time (UTC+5:30) so "daily" loss resets at local midnight. */
export function dayKeyLK(now = new Date()) {
  return new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Account-level brakes. Pure: takes the previous saved state, returns the next one.
 *  - daily loss: (dayStartEquity - equity) / dayStartEquity ≥ limit → no new trades until tomorrow
 *  - drawdown : (peak - equity) / peak ≥ limit → no new trades until the user re-arms auto-trade
 */
export function evaluateGuard(prev, equity, now, cfg) {
  const eq = +equity;
  const today = dayKeyLK(now);
  const st = {
    day: prev?.day || today,
    dayStartEquity: +prev?.dayStartEquity > 0 ? +prev.dayStartEquity : eq,
    peakEquity: +prev?.peakEquity > 0 ? +prev.peakEquity : eq,
    halted: prev?.halted || null, // null | 'daily' | 'drawdown'
    haltReason: prev?.haltReason || null,
  };
  if (!(eq > 0)) return { ok: true, state: st, justHalted: false };

  if (st.day !== today) {
    st.day = today;
    st.dayStartEquity = eq;
    if (st.halted === 'daily') {
      st.halted = null;
      st.haltReason = null;
    }
  }
  if (eq > st.peakEquity) st.peakEquity = eq;

  const wasHalted = !!st.halted;
  const dd = ((st.peakEquity - eq) / st.peakEquity) * 100;
  const dayLoss = ((st.dayStartEquity - eq) / st.dayStartEquity) * 100;

  if (!st.halted || st.halted === 'daily') {
    if (dd >= cfg.drawdownHaltPercent) {
      st.halted = 'drawdown';
      st.haltReason = `Drawdown ${dd.toFixed(1)}% from peak ≥ ${cfg.drawdownHaltPercent}% — auto-trade halted. Re-arm auto-trade to resume.`;
    } else if (dayLoss >= cfg.dailyLossLimitPercent) {
      st.halted = 'daily';
      st.haltReason = `Daily loss ${dayLoss.toFixed(1)}% ≥ ${cfg.dailyLossLimitPercent}% — no new trades until tomorrow.`;
    }
  }
  return { ok: !st.halted, reason: st.haltReason, state: st, justHalted: !!st.halted && !wasHalted };
}
