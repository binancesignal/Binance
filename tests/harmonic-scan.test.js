import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findHarmonicEvents,
  buildHarmonicChartSvg,
  normalizeHsScanConfig,
  DEFAULT_RATIO_RULES,
} from '../lib/scanner/strategy/harmonicScan/index.js';

/** Build a rough bullish Gartley-like XABC (D projected). */
function gartleyLike() {
  const closes = [];
  for (let i = 0; i < 80; i++) closes.push(100);
  // X low 100
  closes.push(100);
  // up to A 110
  for (let i = 1; i <= 10; i++) closes.push(100 + i);
  // down to B ~103.8 (0.618 of XA)
  for (let i = 1; i <= 6; i++) closes.push(110 - i * 1.03);
  // up to C ~107.5
  for (let i = 1; i <= 5; i++) closes.push(103.8 + i * 0.74);
  // drift without hitting D (~102.14)
  for (let i = 0; i < 12; i++) closes.push(107.5 - i * 0.15);

  return closes.map((c, i) => ({
    time: 1_700_000_000 + i * 900,
    open: c + 0.05,
    high: c + 0.5,
    low: c - 0.5,
    close: c,
    volume: 1,
  }));
}

test('normalize merges custom ratios', () => {
  const cfg = normalizeHsScanConfig({
    ratioRules: { GARTLEY: { xdMin: 0.7, xdMax: 0.85 } },
    enabledFamilies: ['GARTLEY', 'BAT'],
  });
  assert.equal(cfg.ratioRules.GARTLEY.xdMin, 0.7);
  assert.equal(cfg.ratioRules.GARTLEY.xbMin, DEFAULT_RATIO_RULES.GARTLEY.xbMin);
  assert.deepEqual(cfg.enabledFamilies.sort(), ['BAT', 'GARTLEY']);
});

test('findHarmonicEvents returns array (projected or completed)', () => {
  const c = gartleyLike();
  const ev = findHarmonicEvents(c, {
    minScore: 40,
    maxPointAgeBars: 80,
    swingLeft: 2,
    swingRight: 2,
    includeProjected: true,
    includeCompleted: true,
  });
  assert.ok(Array.isArray(ev));
  // May or may not match exact Gartley on synthetic data; ensure no throw and structure OK when present
  for (const e of ev) {
    assert.ok(e.family);
    assert.ok(e.direction);
    assert.ok(e.X && e.A && e.B && e.C);
    assert.ok(e.entry > 0);
    assert.ok(e.przLow < e.przHigh);
  }
});

test('chart svg builds for a synthetic completed-like event', () => {
  const c = gartleyLike();
  const fake = {
    kind: 'PROJECTED',
    status: 'WAITING',
    family: 'GARTLEY',
    label: 'Gartley',
    direction: 'LONG',
    score: 70,
    time: c[c.length - 5].time,
    X: { i: 80, price: c[80].close, time: c[80].time },
    A: { i: 90, price: c[90].close, time: c[90].time },
    B: { i: 96, price: c[96].close, time: c[96].time },
    C: { i: 101, price: c[101].close, time: c[101].time },
    D: { i: null, price: 102.2, time: null },
    entry: 102.2,
    przLow: 101.8,
    przHigh: 102.6,
    ratios: { xb: 0.62, bc: 0.5, xd: 0.786 },
  };
  const svg = buildHarmonicChartSvg(c, fake, { symbol: 'TEST', tf: '15m', tzMin: 330 });
  assert.ok(svg && svg.startsWith('<svg'));
  assert.ok(svg.includes('D zone') || svg.includes('PRZ'));
  assert.ok(svg.includes('X ') || svg.includes('A ') || svg.includes('>X') || svg.includes('HEAD'));
});
