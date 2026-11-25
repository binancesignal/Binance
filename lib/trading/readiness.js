/**
 * Why the bot would NOT trade for this user right now (shown in the Portfolio, DB only).
 * Every item is something that makes processBinanceUserAutoTrades skip the user silently.
 */
import { getAutoTradingConfig } from './autoConfig.js';
import { canAutoTrade, getExchangeKeys, getPlan, getUserById, getUserTradingSettings } from '../database/users.js';
import { getScanExchanges } from '../exchange/index.js';

export async function checkAutoTradeReadiness(userId, debug = null) {
  const out = [];
  try {
    const cfg = await getAutoTradingConfig();
    if (!cfg.autoTradingEnabled) out.push('Auto-trading is switched OFF by the admin (global switch).');
    if (String(cfg.orderType || 'Limit').toUpperCase() !== 'LIMIT') {
      out.push('Admin order type is MARKET — orders are placed only after the entry is hit, not as limits.');
    }
    try {
      if (!(await getScanExchanges()).includes('binance')) out.push('Binance is switched off in the admin scan exchanges.');
    } catch (_) {}
    const [user, settings] = await Promise.all([getUserById(userId), getUserTradingSettings(userId)]);
    if (debug) {
      Object.assign(debug, {
        account: user?.email || user?.username || String(userId).slice(0, 8),
        stored: { autoTradingEnabled: settings?.autoTradingEnabled ?? null, autoTradeExchange: settings?.autoTradeExchange ?? null, riskMode: settings?.riskMode ?? null },
      });
    }
    if (settings?.autoTradingEnabled !== true || settings?.autoTradeExchange !== 'binance') {
      out.push('Auto-trade is not armed for Binance on your account (Trade tab → Auto-trade exchange = Binance, switch ON).');
    }
    if (settings?.riskMode !== 'high') out.push('High Risk mode is not confirmed (Trade tab → Risk mode).');
    if (user) {
      const plan = await getPlan(user.plan).catch(() => null);
      if (!canAutoTrade(user, plan)) out.push('Your plan / trial does not include auto-trading.');
    }
    const keys = await getExchangeKeys(userId, 'binance').catch(() => null);
    if (!keys?.apiKey || !keys?.apiSecret) out.push('No verified Binance API keys are connected.');
  } catch (e) {
    out.push(`Could not check settings: ${e.message || e}`);
  }
  return out;
}
