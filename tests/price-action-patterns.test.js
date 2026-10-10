import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPriceActionPatterns, validatePriceAction, PRICE_ACTION_TYPES } from '../lib/scanner/strategy/chartPattern/priceAction.js';
import { runChartPatternStrategy } from '../lib/scanner/strategy/chartPattern/index.js';
import { CHART_PATTERN_TYPES } from '../lib/scanner/strategy/chartPattern/config.js';
import { calcATR } from '../lib/scanner/indicators.js';

// piecewise-linear price path through [barIndex, price] corners; small bodies in the travel direction.
// `bars` = hand-made [open, high, low, close] candles appended after the path (wicks, sweeps …).
function build(corners, { lead = 14, leadSlope = 0.3, tail = [], leadDir = 1, bars = [] } = {}) {
  const pts = corners.map(([i, p]) => [i + lead, p]);
  const path = [];
  for (let i = 0; i < pts[0][0]; i++) path.push(pts[0][1] + (pts[0][0] - i) * leadSlope * leadDir);
  for (let k = 0; k < pts.length - 1; k++) {
    const [i0, p0] = pts[k];
    const [i1, p1] = pts[k + 1];
    for (let i = i0; i < i1; i++) path.push(p0 + ((p1 - p0) * (i - i0)) / (i1 - i0));
  }
  path.push(pts[pts.length - 1][1]);
  path.push(...tail);
  const candles = path.map((c, i) => {
    const prev = i ? path[i - 1] : c + 0.1;
    const sign = Math.sign(c - prev) || 1;
    const o = c - sign * 0.1;
    return { time: 1_000_000 + i * 900, open: o, close: c, high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05, volume: 100 };
  });
  for (const [o, h, l, c] of bars) candles.push({ time: 1_000_000 + candles.length * 900, open: o, high: h, low: l, close: c, volume: 100 });
  const last = candles[candles.length - 1].close;
  candles.push({ time: 1_000_000 + candles.length * 900, open: last, high: last + 0.05, low: last - 0.05, close: last, volume: 50 }); // forming bar
  return candles;
}

const L = 9;
const run = (cs) => {
  const atr = calcATR(cs.slice(0, -1), 14);
  return { atr, found: detectPriceActionPatterns(cs, atr) };
};
const pick = (cs, type) => {
  const { atr, found } = run(cs);
  const p = found.find((x) => x.patternType === type);
  return { p, atr, all: found.map((x) => x.patternType) };
};
function expectSignal(cs, type, dir) {
  const { p, atr, all } = pick(cs, type);
  assert.ok(p, `${type} not detected (got: ${all.join(', ') || 'nothing'})`);
  assert.equal(p.direction, dir);
  assert.equal(p.priceAction, true);
  const v = validatePriceAction(p, cs, atr);
  assert.equal(v.ok, true, `${type} validation: ${v.reason}`);
  assert.equal(v.direction, dir);
  return { p, v };
}

const charts = {
  qmBear: () => build([[0, 100], [L, 110], [2 * L, 103], [3 * L, 116], [4 * L, 98], [5 * L, 109.6]], { tail: [109.3, 109.0] }),
  qmBull: () => build([[0, 120], [L, 110], [2 * L, 117], [3 * L, 104], [4 * L, 122], [5 * L, 110.4]], { leadDir: -1, tail: [110.7, 111.0] }),
  oneTwoThreeBull: () => build([[0, 130], [2 * L, 100], [3 * L, 112], [4 * L, 104], [5 * L, 112.6]], { leadDir: -1, tail: [113.0] }),
  oneTwoThreeBear: () => build([[0, 70], [2 * L, 100], [3 * L, 88], [4 * L, 96], [5 * L, 87.4]], { leadDir: 1, tail: [87.0] }),
  abcBull: () => build([[0, 100], [L, 130], [2 * L, 112], [3 * L, 124], [4 * L, 106], [4 * L + 3, 107.2]], { leadDir: 1, tail: [107.9] }),
  abcBear: () => build([[0, 130], [L, 100], [2 * L, 118], [3 * L, 106], [4 * L, 124], [4 * L + 3, 122.8]], { leadDir: -1, tail: [122.1] }),
  ewBull: () => build([[0, 100], [L, 115], [2 * L, 106], [3 * L, 140], [4 * L, 126], [4 * L + 3, 127.2]], { leadDir: 1, tail: [127.9] }),
  ewBear: () => build([[0, 140], [L, 125], [2 * L, 134], [3 * L, 100], [4 * L, 114], [4 * L + 3, 112.8]], { leadDir: -1, tail: [112.1] }),
  spring: () => build([[0, 105], [6, 100], [14, 110], [22, 100.2], [30, 110], [36, 104]], { leadDir: 0.0001, bars: [[104, 104.4, 103, 103.6], [103.6, 103.8, 98.6, 101.2], [101.2, 102.6, 101.0, 102.4]] }),
  upthrust: () => build([[0, 105], [6, 110], [14, 100], [22, 109.8], [30, 100], [36, 106]], { leadDir: 0.0001, bars: [[106, 107, 105.6, 106.6], [106.6, 111.4, 106.4, 108.8], [108.8, 108.9, 107.4, 107.6]] }),
  sweepBull: () => build([[0, 130], [18, 100], [30, 120], [42, 104], [48, 101.5]], { leadDir: -1, bars: [[101.5, 101.8, 98.8, 100.9], [100.9, 101.6, 100.7, 101.4]] }),
  sweepBear: () => build([[0, 70], [18, 100], [30, 80], [42, 96], [48, 98.5]], { leadDir: 1, bars: [[98.5, 101.2, 98.2, 99.1], [99.1, 99.2, 98.4, 98.6]] }),
  brkRetestBull: () => build([[0, 100], [9, 110], [16, 102], [24, 110.1], [30, 103], [38, 118], [46, 110.3]], { leadDir: 1, tail: [111.0, 112.2] }),
  brkRetestBear: () => build([[0, 120], [9, 110], [16, 118], [24, 109.9], [30, 117], [38, 102], [46, 109.7]], { leadDir: -1, tail: [109.0, 107.8] }),
};

test('Quasimodo (QM): bearish + bullish retest of the left-shoulder level', () => {
  expectSignal(charts.qmBear(), 'QUASIMODO_BEAR', 'SHORT');
  expectSignal(charts.qmBull(), 'QUASIMODO_BULL', 'LONG');
});

test('1-2-3 reversal: bullish + bearish break of point 2', () => {
  expectSignal(charts.oneTwoThreeBull(), 'ONE_TWO_THREE_BULL', 'LONG');
  expectSignal(charts.oneTwoThreeBear(), 'ONE_TWO_THREE_BEAR', 'SHORT');
});

test('Corrective ABC: zig-zag correction ends at C in both directions', () => {
  expectSignal(charts.abcBull(), 'CORRECTIVE_ABC_BULL', 'LONG');
  expectSignal(charts.abcBear(), 'CORRECTIVE_ABC_BEAR', 'SHORT');
});

test('Elliott Wave: wave-5 launch after a rule-valid 1-2-3-4', () => {
  expectSignal(charts.ewBull(), 'ELLIOTT_WAVE_BULL', 'LONG');
  expectSignal(charts.ewBear(), 'ELLIOTT_WAVE_BEAR', 'SHORT');
});

test('Wyckoff Spring (bullish) and Upthrust (bearish) are told apart from a plain sweep', () => {
  expectSignal(charts.spring(), 'WYCKOFF_SPRING_BULL', 'LONG');
  expectSignal(charts.upthrust(), 'WYCKOFF_UPTHRUST_BEAR', 'SHORT');
  assert.ok(!run(charts.spring()).found.some((p) => p.patternType === 'LIQUIDITY_SWEEP_BULL'));
});

test('Liquidity sweep / reversal: swing low and swing high sweeps', () => {
  expectSignal(charts.sweepBull(), 'LIQUIDITY_SWEEP_BULL', 'LONG');
  expectSignal(charts.sweepBear(), 'LIQUIDITY_SWEEP_BEAR', 'SHORT');
});

test('Breakout + Retest: broken resistance held as support, broken support held as resistance', () => {
  expectSignal(charts.brkRetestBull(), 'BREAKOUT_RETEST_BULL', 'LONG');
  expectSignal(charts.brkRetestBear(), 'BREAKOUT_RETEST_BEAR', 'SHORT');
});

test('no QM signal without the retest (chart ends at the break of structure)', () => {
  const cs = build([[0, 100], [L, 110], [2 * L, 103], [3 * L, 116], [4 * L, 98]], { tail: [98.3, 98.6] });
  assert.ok(!run(cs).found.some((p) => p.paFamily === 'QUASIMODO'));
});

test('a "spring" that never reclaims the level is not a pattern', () => {
  const cs = build([[0, 105], [6, 100], [14, 110], [22, 100.2], [30, 110], [36, 104]], {
    leadDir: 0.0001,
    bars: [[104, 104.4, 103, 103.6], [103.6, 103.8, 98.6, 99.0], [99.0, 99.3, 97.8, 98.1], [98.1, 98.4, 97.0, 97.4]],
  });
  assert.ok(!run(cs).found.some((p) => p.direction === 'LONG' && (p.paFamily === 'WYCKOFF_SPRING' || p.paFamily === 'LIQUIDITY_SWEEP')));
});

test('stale / over-extended setups are rejected by the validator', () => {
  const stale = build([[0, 100], [L, 130], [2 * L, 112], [3 * L, 124], [4 * L, 106], [5 * L, 108]], { leadDir: 1, tail: [109.5] });
  const { p, atr } = pick(stale, 'CORRECTIVE_ABC_BULL');
  assert.ok(p);
  assert.equal(validatePriceAction(p, stale, atr).ok, false);
});

test('detector never throws on junk input', () => {
  assert.deepEqual(detectPriceActionPatterns([], 1), []);
  assert.deepEqual(detectPriceActionPatterns(null, 1), []);
  const junk = Array.from({ length: 60 }, (_, i) => ({ time: i, open: NaN, high: NaN, low: NaN, close: NaN, volume: 0 }));
  assert.doesNotThrow(() => detectPriceActionPatterns(junk, 1));
});

test('new types are selectable (config list) and every detector output is covered by it', () => {
  for (const t of PRICE_ACTION_TYPES) assert.ok(CHART_PATTERN_TYPES.includes(t), `${t} missing from CHART_PATTERN_TYPES`);
  for (const make of Object.values(charts)) {
    for (const p of run(make()).found) assert.ok(PRICE_ACTION_TYPES.includes(p.patternType), p.patternType);
  }
});

test('full strategy pipeline turns a price-action pattern into a trade with sane levels', () => {
  const relaxed = { minFinalScore: 0, minSignalScore: 0, minLocationScore: 0, minRejectionScore: 0, requireRejectionZone: false };
  for (const [name, type, dir] of [
    ['spring', 'WYCKOFF_SPRING_BULL', 'LONG'],
    ['qmBear', 'QUASIMODO_BEAR', 'SHORT'],
    ['brkRetestBull', 'BREAKOUT_RETEST_BULL', 'LONG'],
  ]) {
    const cs = charts[name]();
    const price = cs[cs.length - 1].close;
    const r = runChartPatternStrategy({ symbol: 'TESTUSDT', patternCandles: cs, htfCandles: cs, entryCandles: cs, price, cfg: relaxed });
    const s = r.setups.find((x) => x.pattern === type);
    assert.ok(s, `${type} produced no setup: ${JSON.stringify(r.rejected)}`);
    assert.equal(s.direction, dir);
    if (dir === 'LONG') assert.ok(s.sl < s.entry && s.entry < s.tp1 && s.tp1 < s.tp2, `${type} long levels`);
    else assert.ok(s.sl > s.entry && s.entry > s.tp1 && s.tp1 > s.tp2, `${type} short levels`);
  }
});

test('enabledPatterns filter works for the new types', () => {
  const cs = charts.spring();
  const price = cs[cs.length - 1].close;
  const relaxed = { minFinalScore: 0, minSignalScore: 0, minLocationScore: 0, minRejectionScore: 0, requireRejectionZone: false };
  const only = runChartPatternStrategy({ symbol: 'T', patternCandles: cs, htfCandles: cs, entryCandles: cs, price, cfg: { ...relaxed, enabledPatterns: ['QUASIMODO_BEAR'] } });
  assert.equal(only.setups.length, 0);
  const on = runChartPatternStrategy({ symbol: 'T', patternCandles: cs, htfCandles: cs, entryCandles: cs, price, cfg: { ...relaxed, enabledPatterns: ['WYCKOFF_SPRING_BULL'] } });
  assert.equal(on.setups.length, 1);
});
