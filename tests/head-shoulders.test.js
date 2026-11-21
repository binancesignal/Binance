import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findHeadShoulders,
  buildHsChartSvg,
  normalizeHsConfig,
} from '../lib/scanner/strategy/headShoulders/index.js';

/** Synthetic classic H&S on an uptrend then three peaks. */
function classicHsSeries() {
  const closes = [];
  // warmup flat-ish so EMA exists
  for (let i = 0; i < 220; i++) closes.push(100 + Math.sin(i / 11) * 0.4);
  // left shoulder ~108
  for (let i = 0; i < 8; i++) closes.push(100 + i * 1.0);
  for (let i = 0; i < 6; i++) closes.push(108 - i * 0.9); // trough ~102.6
  // head ~114
  for (let i = 0; i < 10; i++) closes.push(102.6 + i * 1.15);
  for (let i = 0; i < 7; i++) closes.push(114 - i * 1.1); // trough ~106.3
  // right shoulder ~108.5
  for (let i = 0; i < 7; i++) closes.push(106.3 + i * 0.35);
  for (let i = 0; i < 5; i++) closes.push(108.5 - i * 0.4);
  // drift
  for (let i = 0; i < 15; i++) closes.push(106.5 - i * 0.15);

  return closes.map((c, i) => ({
    time: 1_700_000_000 + i * 180,
    open: c + 0.05,
    high: c + 0.45,
    low: c - 0.45,
    close: c,
    volume: 1,
  }));
}

test('detects classic HEAD_AND_SHOULDERS', () => {
  const c = classicHsSeries();
  const ev = findHeadShoulders(c, {
    minHeightAtr: 0.3,
    swingLeft: 2,
    swingRight: 2,
    maxAgeBars: 200,
    requireAboveEma: false,
  });
  const hs = ev.filter((e) => e.patternType === 'HEAD_AND_SHOULDERS');
  assert.ok(hs.length >= 1, `expected H&S, got ${ev.map((e) => e.patternType).join(',')}`);
  const e = hs[0];
  assert.equal(e.direction, 'SHORT');
  assert.ok(e.head.price > e.ls.price);
  assert.ok(e.head.price > e.rs.price);
  assert.ok(e.neckline);
  assert.ok(e.confidence >= 50);
});

test('chart svg includes LS HEAD RS labels', () => {
  const c = classicHsSeries();
  const ev = findHeadShoulders(c, { minHeightAtr: 0.3, swingLeft: 2, swingRight: 2, maxAgeBars: 200 });
  const hs = ev.find((e) => e.patternType === 'HEAD_AND_SHOULDERS');
  assert.ok(hs);
  const svg = buildHsChartSvg(c, hs, { symbol: 'TEST', tf: '15m', tzMin: 330 });
  assert.ok(svg && svg.startsWith('<svg'));
  assert.ok(svg.includes('HEAD'));
  assert.ok(svg.includes('LS'));
  assert.ok(svg.includes('RS'));
});

test('normalizeHsConfig clamps values', () => {
  const cfg = normalizeHsConfig({ minHeightAtr: 99, requireAboveEma: 'true' });
  assert.ok(cfg.minHeightAtr <= 5);
  assert.equal(cfg.requireAboveEma, true);
});
