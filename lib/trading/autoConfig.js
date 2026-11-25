import { getState, setState } from '../database/appState.js';
import { HIGH_RISK_DEFAULTS, normalizeHighRiskForSave } from './riskSizing.js';

/**
 * Admin-controlled auto-trade config (applies to every user the same way).
 * Harmonic strategy: LIMIT orders near entry → fill → ONGOING.
 */
export const AUTO_TRADE_DEFAULTS = {
  autoTradingEnabled: false,

  /** Strategy id — harmonic is the live path for Binance users. */
  strategy: 'harmonic',

  /** Users may click Manual Entry on signal cards (admin can disable). */
  manualEntryEnabled: true,

  /**
   * LIMIT | MARKET
   * Harmonic default: LIMIT at signal entry when price is close enough.
   */
  orderType: 'Limit',

  /**
   * When |price-entry|/entry*100 <= this → signal is WATCHING (near entry).
   * Admin configurable.
   */
  watchingProximityPercent: 4,

  /**
   * When |price-entry|/entry*100 <= this → ENTRY_READY / READY and
   * auto places the LIMIT order (at entry price). Admin configurable.
   */
  entryReadyProximityPercent: 2,

  /**
   * Limit price vs entry: 0 = exact entry.
   * Positive = slightly better for maker (LONG: entry*(1-pct/100), SHORT: entry*(1+pct/100)).
   */
  limitOrderOffsetPercent: 0,

  /** % of available USDT balance used as margin per trade (admin). 1–100. */
  marginPercent: 25,
  maximumMarginPercent: 100,
  minMarginUsdt: 1,
  maxMarginUsdt: 50000,

  /**
   * Leverage = floor(symbolMaxLeverage * leverageFractionOfMax).
   * Default 0.5 = half of Binance max for that coin. Admin can change 0.1–1.
   */
  leverageFractionOfMax: 0.5,
  minimumLeverage: 1,
  maximumLeverage: 125,
  /** Fallback if bracket API fails */
  defaultLeverage: 10,
  volatilityAwareLeverage: false,

  atrLowPct: 1.0,
  atrMidPct: 2.5,
  atrHighPct: 4.0,
  leverageLowVol: null,
  leverageMidVol: 8,
  leverageHighVol: 5,
  leverageExtremeVol: 2,
  rejectExtremeVol: false,

  tpEnabled: true,
  slEnabled: true,
  tp1Percent: 40,
  tp2Percent: 30,
  tp3Percent: 30,
  moveSLToBreakevenAfterTP1: true,

  maxOpenPositions: 5,
  /**
   * How many LIMIT orders may wait for a fill at the same time (not yet "in trade").
   * 1 = only the best-score ENTRY READY signal has an order; a better one replaces it.
   */
  maxPendingLimitOrders: 1,
  maxPositionsPerSymbol: 1,
  maxDailyTrades: 15,
  maxDailyLossPercent: 5,
  cooldownAfterTradeSec: 60,

  allowLong: true,
  allowShort: true,

  /**
   * LIMIT harmonic path: place when READY/ENTRY_READY (not wait for ONGOING fill).
   * MARKET legacy path waited for ONGOING entry hit.
   */
  requireEntryHit: false,
  requireSignalReady: true,
  requireMinimumRR: 1.0,
  requireSl: true,

  highRisk: { ...HIGH_RISK_DEFAULTS },

  /** Prefer Binance user keys over Bybit desk. */
  executionOnlyBybit: false,

  minimumScore: 50,
};

function clamp(n, lo, hi, fb) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fb;
  return Math.min(hi, Math.max(lo, x));
}

export async function getAutoTradingConfig() {
  try {
    const stored = await getState('auto_trading_config', null);
    if (stored && typeof stored === 'object') {
      const config = { ...stored };
      delete config.dryRun;
      delete config.emergencyStop;
      return {
        ...AUTO_TRADE_DEFAULTS,
        ...config,
        // Keep requireEntryHit from stored if set; else default (false for limit harmonic)
        requireEntryHit:
          config.requireEntryHit != null
            ? !!config.requireEntryHit
            : AUTO_TRADE_DEFAULTS.requireEntryHit,
      };
    }
  } catch (_) {}
  return { ...AUTO_TRADE_DEFAULTS };
}

export async function setAutoTradingConfig(partial) {
  const current = await getAutoTradingConfig();
  const safePartial = { ...(partial || {}) };
  delete safePartial.dryRun;
  delete safePartial.emergencyStop;

  const next = {
    ...current,
    ...safePartial,
  };

  next.strategy = String(next.strategy || 'harmonic').toLowerCase();
  next.orderType = String(next.orderType || 'Limit');
  if (!/^limit$/i.test(next.orderType) && !/^market$/i.test(next.orderType)) {
    next.orderType = 'Limit';
  }

  next.watchingProximityPercent = clamp(next.watchingProximityPercent, 0.1, 50, 4);
  next.entryReadyProximityPercent = clamp(next.entryReadyProximityPercent, 0.05, 50, 2);
  if (next.entryReadyProximityPercent > next.watchingProximityPercent) {
    next.watchingProximityPercent = next.entryReadyProximityPercent;
  }
  next.limitOrderOffsetPercent = clamp(next.limitOrderOffsetPercent, 0, 5, 0);

  next.marginPercent = clamp(next.marginPercent, 1, 100, 25);
  next.maximumMarginPercent = clamp(next.maximumMarginPercent, next.marginPercent, 100, 100);
  next.minMarginUsdt = clamp(next.minMarginUsdt, 0.1, 1e6, 1);
  next.maxMarginUsdt = clamp(next.maxMarginUsdt, next.minMarginUsdt, 1e7, 50000);

  next.leverageFractionOfMax = clamp(next.leverageFractionOfMax, 0.1, 1, 0.5);
  next.minimumLeverage = clamp(next.minimumLeverage, 1, 125, 1);
  next.maximumLeverage = clamp(next.maximumLeverage, next.minimumLeverage, 125, 125);
  next.defaultLeverage = clamp(next.defaultLeverage, 1, next.maximumLeverage, 10);

  next.maxPendingLimitOrders = Math.round(clamp(next.maxPendingLimitOrders, 1, 10, 1));
  next.manualEntryEnabled = next.manualEntryEnabled !== false;
  next.requireEntryHit = !!next.requireEntryHit;
  next.requireSignalReady = next.requireSignalReady !== false;
  next.requireSl = next.requireSl !== false;

  // LIMIT harmonic: do not force requireEntryHit
  if (/^limit$/i.test(next.orderType) && next.strategy === 'harmonic') {
    if (safePartial.requireEntryHit == null) next.requireEntryHit = false;
  }

  const tpSum = (+next.tp1Percent || 0) + (+next.tp2Percent || 0) + (+next.tp3Percent || 0);
  if (next.tpEnabled && Math.abs(tpSum - 100) > 0.5 && tpSum > 0) {
    const scale = 100 / tpSum;
    next.tp1Percent = +((+next.tp1Percent || 0) * scale).toFixed(2);
    next.tp2Percent = +((+next.tp2Percent || 0) * scale).toFixed(2);
    next.tp3Percent = +((+next.tp3Percent || 0) * scale).toFixed(2);
  }

  next.highRisk = normalizeHighRiskForSave({
    ...(current.highRisk || {}),
    ...(safePartial.highRisk || {}),
    // Align high-risk margin default with admin margin when not explicitly set
    marginPercent:
      safePartial.highRisk?.marginPercent != null
        ? safePartial.highRisk.marginPercent
        : safePartial.marginPercent != null
          ? next.marginPercent
          : (current.highRisk?.marginPercent ?? next.marginPercent),
  });

  await setState('auto_trading_config', next);
  return next;
}

/** Distance of live price to entry as percent of entry. */
export function entryDistancePercent(price, entry) {
  const p = +price;
  const e = +entry;
  if (!(p > 0) || !(e > 0)) return null;
  return (Math.abs(p - e) / e) * 100;
}

/**
 * Map price distance → lifecycle for harmonic boards / auto-trade gates.
 * WAITING (far) → WATCHING (within watching %) → ENTRY_READY (within ready %)
 */
export function classifyEntryProximity(price, entry, cfg = {}) {
  const dist = entryDistancePercent(price, entry);
  if (dist == null) return 'WAITING';
  const ready = clamp(cfg.entryReadyProximityPercent, 0.05, 50, 2);
  const watch = clamp(cfg.watchingProximityPercent, ready, 50, 4);
  if (dist <= ready) return 'ENTRY_READY';
  if (dist <= watch) return 'WATCHING';
  return 'WAITING';
}

/** Limit order price at/near entry (LONG slightly below if offset > 0). */
export function limitPriceFromEntry(entry, direction, offsetPercent = 0) {
  const e = +entry;
  if (!(e > 0)) return null;
  const off = clamp(offsetPercent, 0, 5, 0) / 100;
  const isLong = String(direction || '').toUpperCase() !== 'SHORT';
  if (off <= 0) return e;
  return isLong ? e * (1 - off) : e * (1 + off);
}

/** Leverage from exchange max × admin fraction. */
export function leverageFromMax(symbolMaxLev, cfg = {}) {
  const maxLev = Math.max(1, Math.floor(+symbolMaxLev || cfg.defaultLeverage || 10));
  const frac = clamp(cfg.leverageFractionOfMax, 0.1, 1, 0.5);
  let lev = Math.floor(maxLev * frac);
  lev = Math.max(cfg.minimumLeverage || 1, lev);
  lev = Math.min(cfg.maximumLeverage || 125, lev, maxLev);
  return Math.max(1, lev);
}

/** Margin USDT from available balance × marginPercent. */
export function marginFromBalance(availableUsdt, cfg = {}) {
  const avail = Math.max(0, +availableUsdt || 0);
  const pct = clamp(cfg.marginPercent, 1, 100, 25) / 100;
  let margin = avail * pct;
  const minM = +cfg.minMarginUsdt || 1;
  const maxM = +cfg.maxMarginUsdt || 50000;
  if (margin < minM) {
    if (avail < minM) return { reject: true, reason: `Available $${avail.toFixed(2)} < min margin $${minM}` };
    margin = minM;
  }
  margin = Math.min(margin, maxM, avail);
  if (!(margin > 0)) return { reject: true, reason: 'Margin is 0' };
  return { reject: false, margin, marginPercent: pct * 100 };
}
