/**
 * Telegram notification + Live Board preferences (persisted in app_state).
 */
import { getState, setState } from '../database/appState.js';

export const TELEGRAM_NOTIFY_DEFAULTS = {
  masterEnabled: true,
  // Per-event (used when notificationMode is every_event or live_board_plus)
  watching: true,
  ready: true,
  breakout: true,
  ongoing: true,
  tp1: true,
  tp2: true,
  tp3: true,
  stopLoss: true,
  completed: true,
  invalidated: true,
  scanSummary: true,
  // Charts with individual event messages
  chartWatching: false,
  chartReady: true,
  chartBreakout: true,
  chartOngoing: false,
  chartTpSl: false,
  // Mode: every_event | live_board | live_board_plus
  notificationMode: 'live_board',
  // Live board
  maxWatchingInBoard: 10,
  recentEventsLimit: 10,
  liveBoardChartMode: 'off', // off | primary | separate
};

export async function getTelegramNotifyConfig() {
  try {
    const stored = await getState('telegram_notify_config', null);
    if (stored && typeof stored === 'object') {
      return { ...TELEGRAM_NOTIFY_DEFAULTS, ...stored };
    }
  } catch (_) {}
  return { ...TELEGRAM_NOTIFY_DEFAULTS };
}

export async function setTelegramNotifyConfig(partial) {
  const current = await getTelegramNotifyConfig();
  const next = { ...current, ...(partial || {}) };
  // clamp
  next.maxWatchingInBoard = Math.min(
    100,
    Math.max(0, Math.round(+next.maxWatchingInBoard || 10))
  );
  next.recentEventsLimit = Math.min(
    30,
    Math.max(0, Math.round(+next.recentEventsLimit || 10))
  );
  const modes = ['every_event', 'live_board', 'live_board_plus'];
  if (!modes.includes(next.notificationMode)) next.notificationMode = 'live_board';
  const charts = ['off', 'primary', 'separate'];
  if (!charts.includes(next.liveBoardChartMode)) next.liveBoardChartMode = 'off';
  await setState('telegram_notify_config', next);
  return next;
}

/** Map lifecycle notification type → config key */
export function eventAllowed(cfg, type) {
  if (!cfg?.masterEnabled) return false;
  const map = {
    READY: 'ready',
    NEAR_BREAKOUT: 'breakout',
    ENTRY_HIT: 'ongoing',
    TP1: 'tp1',
    TP2: 'tp2',
    TP3: 'tp3',
    SL: 'stopLoss',
    INVALIDATED: 'invalidated',
    WATCHING: 'watching',
  };
  const key = map[type];
  if (!key) return true;
  return !!cfg[key];
}

export function chartAllowed(cfg, type) {
  if (!cfg?.masterEnabled) return false;
  if (type === 'READY') return !!cfg.chartReady;
  if (type === 'NEAR_BREAKOUT') return !!cfg.chartBreakout;
  if (type === 'ENTRY_HIT') return !!cfg.chartOngoing;
  if (type === 'TP1' || type === 'TP2' || type === 'TP3' || type === 'SL') {
    return !!cfg.chartTpSl;
  }
  if (type === 'WATCHING') return !!cfg.chartWatching;
  return false;
}
