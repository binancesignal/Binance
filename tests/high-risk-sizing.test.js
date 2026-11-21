import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HIGH_RISK_DEFAULTS,
  resolveHighRiskConfig,
  sizeHighRiskTrade,
  evaluateGuard,
  dayKeyLK,
} from '../lib/trading/riskSizing.js';

const cfg = resolveHighRiskConfig({}, {});
const base = { equity: 1000, available: 1000, usedMargin: 0, entry: 100, instrument: { maxLeverage: 125 }, cfg };

test('margin is never below 25% and never above the admin max', () => {
  assert.equal(resolveHighRiskConfig({}, { highRiskMarginPercent: 10 }).marginPercent, 25);
  assert.equal(resolveHighRiskConfig({ marginPercent: 5 }, {}).marginPercent, 25);
  assert.equal(resolveHighRiskConfig({}, { highRiskMarginPercent: 80 }).marginPercent, 50);
  assert.equal(resolveHighRiskConfig({}, { highRiskMarginPercent: 30 }).marginPercent, 30);
});

test('leverage is derived from SL distance: loss at SL stays at the cap', () => {
  const r2 = sizeHighRiskTrade({ ...base, sl: 98 }); // 2% SL
  assert.equal(r2.reject, false);
  assert.equal(r2.margin, 250);
  assert.equal(r2.leverage, 10);
  assert.ok(Math.abs(r2.lossAtSlPct - 5) < 1e-6);

  const r5 = sizeHighRiskTrade({ ...base, sl: 95 }); // 5% SL -> lower leverage, same loss
  assert.equal(r5.leverage, 4);
  assert.ok(Math.abs(r5.lossAtSlPct - 5) < 1e-6);

  const r1 = sizeHighRiskTrade({ ...base, sl: 99 }); // 1% SL -> would be 20x, capped at 15x
  assert.equal(r1.leverage, 15);
  assert.equal(r1.limitedBy, 'max-leverage');
  assert.ok(r1.lossAtSlPct < 5);
});

test('SL too tight / too wide is skipped', () => {
  assert.match(sizeHighRiskTrade({ ...base, sl: 99.7 }).reason, /too tight/);
  assert.match(sizeHighRiskTrade({ ...base, sl: 90 }).reason, /too wide/);
});

test('total margin cap decides how many positions fit (75% / 25% = 3)', () => {
  assert.equal(sizeHighRiskTrade({ ...base, sl: 98, usedMargin: 500 }).reject, false); // 3rd fits
  const r = sizeHighRiskTrade({ ...base, sl: 98, usedMargin: 600 });
  assert.equal(r.reject, true);
  assert.match(r.reason, /Total margin cap/);
});

test('insufficient free balance rejects instead of shrinking the margin', () => {
  const r = sizeHighRiskTrade({ ...base, sl: 98, available: 100 });
  assert.equal(r.reject, true);
  assert.match(r.reason, /Insufficient available/);
});

test('liquidation safety can bind the leverage', () => {
  const strict = resolveHighRiskConfig({ liqBufferMultiple: 10 }, {});
  const r = sizeHighRiskTrade({ ...base, cfg: strict, sl: 98 });
  assert.equal(r.reject, false);
  assert.equal(r.limitedBy, 'liquidation-safety');
  assert.ok(r.leverage < 10);
});

test('symbol max leverage is respected', () => {
  const r = sizeHighRiskTrade({ ...base, sl: 99, instrument: { maxLeverage: 8 } });
  assert.equal(r.leverage, 8);
});

test('guard: daily loss halts for the day, then resets tomorrow', () => {
  const d1 = new Date('2026-10-06T06:00:00Z');
  let g = evaluateGuard(null, 1000, d1, cfg);
  assert.equal(g.ok, true);
  g = evaluateGuard(g.state, 880, d1, cfg); // -12%
  assert.equal(g.ok, false);
  assert.equal(g.state.halted, 'daily');
  assert.equal(g.justHalted, true);
  assert.equal(evaluateGuard(g.state, 880, d1, cfg).justHalted, false); // no repeat alerts
  const d2 = new Date('2026-10-07T06:00:00Z');
  g = evaluateGuard(g.state, 880, d2, cfg);
  assert.equal(g.ok, true); // new day, baseline = 880
  assert.equal(g.state.dayStartEquity, 880);
});

test('guard: drawdown from peak halts until the state is reset', () => {
  const d = new Date('2026-10-06T06:00:00Z');
  let g = evaluateGuard(null, 1000, d, cfg);
  g = evaluateGuard(g.state, 1200, d, cfg); // peak 1200
  g = evaluateGuard(g.state, 940, new Date('2026-10-07T06:00:00Z'), cfg); // -21.7% from peak, only -2.4% day
  assert.equal(g.ok, false);
  assert.equal(g.state.halted, 'drawdown');
  const later = evaluateGuard(g.state, 1000, new Date('2026-10-08T06:00:00Z'), cfg);
  assert.equal(later.ok, false, 'drawdown halt survives day rollover');
  assert.equal(evaluateGuard(null, 940, d, cfg).ok, true, 're-arming (state reset) starts fresh');
});

test('Sri Lanka day key rolls at local midnight', () => {
  assert.equal(dayKeyLK(new Date('2026-10-06T18:29:00Z')), '2026-10-06');
  assert.equal(dayKeyLK(new Date('2026-10-06T18:31:00Z')), '2026-10-07');
});

test('defaults are frozen', () => {
  assert.throws(() => { 'use strict'; HIGH_RISK_DEFAULTS.marginPercent = 1; });
});
