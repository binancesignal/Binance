import { getState } from '../database/appState.js';
import { BAN_STATE_KEY, setBanUntil } from '../binance/client.js';

/** Binance IP-ban circuit breaker shared by every harmonic cron: while banned we send NO requests. */
export async function activeBinanceBan() {
  try {
    const ban = await getState(BAN_STATE_KEY, null);
    const until = +ban?.until || 0;
    if (until > Date.now()) {
      setBanUntil(until);
      return until;
    }
  } catch (_) {}
  return 0;
}
