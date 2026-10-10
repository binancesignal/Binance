import { getState, setState } from '../database/appState.js';
import { HIGH_RISK_DEFAULTS, normalizeHighRiskForSave } from './riskSizing.js';

export const AUTO_TRADE_DEFAULTS = {
  autoTradingEnabled: false,

  /** When true, users may click "Market Entry" on READY signals to place a market order manually. */
  manualEntryEnabled: true,

  /** When true, users may open a free-form manual trade (search coin → leverage → margin USDT → place). */
  freeManualTradeEnabled: true,

  minimumScore: 80,
  marginPercent: 2,
  maximumMarginPercent: 10,
  minMarginUsdt: 1,
  maxMarginUsdt: 500,

  defaultLeverage: 10,
  maximumLeverage: 20,
  minimumLeverage: 2,
  volatilityAwareLeverage: true,
  // ATR% thresholds → leverage
  atrLowPct: 1.0, // <= → defaultLeverage
  atrMidPct: 2.5, // <= → mid leverage
  atrHighPct: 4.0, // <= → high-vol leverage; above → extreme
  leverageLowVol: null, // null = use defaultLeverage
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
  maxPositionsPerSymbol: 1,
  maxDailyTrades: 15,
  maxDailyLossPercent: 5,
  cooldownAfterTradeSec: 60,

  allowLong: true,
  allowShort: true,
  requireEntryHit: true, // trade when status ONGOING (entry hit)
  requireSignalReady: true, // also allow READY if requireEntryHit false
  requireMinimumRR: 1.2,
  requireSl: true,

  // High Risk mode (per-user opt-in on the Trade tab). Parameters are admin-controlled.
  highRisk: { ...HIGH_RISK_DEFAULTS },

  orderType: 'Market', // Market | Limit
  executionOnlyBybit: true,
};

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
        requireEntryHit: true,
      };
    }
  } catch (_) {}
  return { ...AUTO_TRADE_DEFAULTS };
}

export async function setAutoTradingConfig(partial) {
  const current = await getAutoTradingConfig();
  // Discard obsolete execution modes. The sole auto-trading gate is
  // autoTradingEnabled; every exchange request is hard-locked to TESTNET.
  const safePartial = { ...(partial || {}) };
  delete safePartial.dryRun;
  delete safePartial.emergencyStop;
  const next = {
    ...current,
    ...safePartial,
    requireEntryHit: true,
  };
  // validation
  if (next.marginPercent <= 0 || next.marginPercent > 50) {
    throw new Error('marginPercent must be 0–50');
  }
  if (next.maximumMarginPercent < next.marginPercent) {
    next.maximumMarginPercent = next.marginPercent;
  }
  if (next.defaultLeverage < 1 || next.defaultLeverage > 100) {
    throw new Error('defaultLeverage must be 1–100');
  }
  if (next.maximumLeverage < next.minimumLeverage) {
    throw new Error('maximumLeverage must be >= minimumLeverage');
  }
  const tpSum = (+next.tp1Percent || 0) + (+next.tp2Percent || 0) + (+next.tp3Percent || 0);
  if (next.tpEnabled && Math.abs(tpSum - 100) > 0.5 && tpSum > 0) {
    // normalize soft warning — allow but clamp to scale
    const scale = 100 / tpSum;
    next.tp1Percent = +((+next.tp1Percent || 0) * scale).toFixed(2);
    next.tp2Percent = +((+next.tp2Percent || 0) * scale).toFixed(2);
    next.tp3Percent = +((+next.tp3Percent || 0) * scale).toFixed(2);
  }
  next.highRisk = normalizeHighRiskForSave({ ...(current.highRisk || {}), ...(safePartial.highRisk || {}) });
  await setState('auto_trading_config', next);
  return next;
}
