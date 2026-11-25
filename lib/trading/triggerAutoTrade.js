/**
 * Run the Binance auto-trader right now (best effort). Called after anything that can change which
 * signals are ENTRY READY: the refresh cron, a scan chunk, an admin status change. Overlapping runs are
 * skipped (short DB lock) so two triggers never place the same order twice.
 */
import { getState, setState } from '../database/appState.js';

const LOCK = 'binance_auto_trade_lock';

export async function triggerAutoTrade(reason = 'trigger') {
  try {
    const cur = await getState(LOCK, null);
    if (cur && +cur.until > Date.now()) return { skipped: true, reason: 'auto-trade already running' };
    await setState(LOCK, { until: Date.now() + 50_000, reason });
  } catch (_) {}
  try {
    const { processBinanceUserAutoTrades } = await import('./binanceAutoTrader.js');
    return await processBinanceUserAutoTrades();
  } catch (e) {
    console.error('[auto-trade] trigger failed', reason, e);
    return { error: e.message || String(e) };
  } finally {
    try {
      await setState(LOCK, { until: 0 });
    } catch (_) {}
  }
}
