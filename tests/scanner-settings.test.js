import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScannerSettings, SCANNER_SETTINGS_DEFAULTS } from '../lib/fibSignals/scannerSettings.js';

test('scanner settings default to ten signals with optional card details enabled', () => {
  assert.deepEqual(normalizeScannerSettings(null), SCANNER_SETTINGS_DEFAULTS);
});

test('scanner settings clamp the visible count and preserve explicit preferences', () => {
  const settings = normalizeScannerSettings({
    maxVisibleSignals: 1000,
    entryProximityRingEnabled: false,
    cardPreferences: {
      showTargetPercentages: false,
      showSignalAge: true,
      showRecentResults: false,
    },
  });

  assert.equal(settings.maxVisibleSignals, 100);
  assert.equal(settings.entryProximityRingEnabled, false);
  assert.deepEqual(settings.cardPreferences, {
    showTargetPercentages: false,
    showSignalAge: true,
    showRecentResults: false,
  });
});

test('scanner settings reject non-integer counts by returning the default', () => {
  assert.equal(normalizeScannerSettings({ maxVisibleSignals: 'many' }).maxVisibleSignals, 10);
  assert.equal(normalizeScannerSettings({ maxVisibleSignals: 2.5 }).maxVisibleSignals, 10);
});
