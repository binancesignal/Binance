import { getState, setState } from '../database/appState.js';

export const SCANNER_SETTINGS_KEY = 'scanner_feed_settings';

export const SCANNER_SETTINGS_DEFAULTS = Object.freeze({
  maxVisibleSignals: 10,
  entryProximityRingEnabled: true,
  cardPreferences: {
    showTargetPercentages: true,
    showSignalAge: true,
    showRecentResults: true,
  },
});

export function normalizeScannerSettings(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const card = input.cardPreferences && typeof input.cardPreferences === 'object'
    ? input.cardPreferences
    : {};
  const count = Number(input.maxVisibleSignals);

  return {
    maxVisibleSignals: Number.isInteger(count)
      ? Math.min(100, Math.max(1, count))
      : SCANNER_SETTINGS_DEFAULTS.maxVisibleSignals,
    entryProximityRingEnabled: input.entryProximityRingEnabled !== false,
    cardPreferences: {
      showTargetPercentages: card.showTargetPercentages !== false,
      showSignalAge: card.showSignalAge !== false,
      showRecentResults: card.showRecentResults !== false,
    },
  };
}

export async function getScannerSettings() {
  return normalizeScannerSettings(await getState(SCANNER_SETTINGS_KEY, null));
}

export async function saveScannerSettings(value) {
  const settings = normalizeScannerSettings(value);
  await setState(SCANNER_SETTINGS_KEY, settings);
  return settings;
}
