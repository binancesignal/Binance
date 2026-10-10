import test from 'node:test';
import assert from 'node:assert/strict';
import { RECOMMENDED_SCANNER_SETTINGS } from '../lib/config/recommendedScannerSettings.js';
import { CHART_PATTERN_CONFIG } from '../lib/scanner/strategy/chartPattern/config.js';
import { resolveGateConfig } from '../lib/scanner/strategy/chartPattern/gates.js';

test('recommended default scans ICT and chart patterns independently', () => {
  assert.equal(RECOMMENDED_SCANNER_SETTINGS.strategyMode, 'hybrid');
  assert.deepEqual(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.patternTfs, ['15m', '30m', '1h']);
});

test('balanced chart defaults soften secondary filters and retain breakout and risk checks', () => {
  const cfg = resolveGateConfig(CHART_PATTERN_CONFIG);
  assert.equal(cfg.requireVolumeConfirmation, false);
  assert.equal(cfg.requireHtfAlign, false);
  assert.equal(cfg.requireRejectionZone, false);
  assert.equal(cfg.requireRejection, false);
  assert.equal(cfg.minConfluencePillars, 1);
  assert.equal(cfg.requireCandleClose, true);
  assert.equal(cfg.requireFreshBreakout, true);
  assert.equal(cfg.minTp1RR, 1);
  assert.equal(cfg.minRR, 1.2);
  assert.equal(cfg.gateModes.pillars, 'soft');
  assert.equal(cfg.gateModes.tp1rr, 'hard');
  assert.equal(cfg.gateModes.tp2rr, 'hard');
});