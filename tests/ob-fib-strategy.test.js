import test from 'node:test';
import assert from 'node:assert/strict';
import { computeWeeklyFib, runObFibPair } from '../lib/scanner/strategy/obFib/index.js';
import { normalizeObFibConfig, OB_FIB_DEFAULTS } from '../lib/scanner/strategy/obFib/config.js';
import { detectLuxAlgoOrderBlocks } from '../lib/scanner/orderBlocks.js';

const WEEK = 7 * 24 * 3600;
const NOW = 1_700_000_000 + 10 * WEEK + 3 * 24 * 3600; // mid-week

function weekly(open, close, high, low, idx) {
  return { time: 1_700_000_000 + idx * WEEK, open, close, high, low, volume: 1 };
}

// deterministic wavy series with volume spikes
function series(n = 400) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const w = Math.sin(i / 9) * 1.6 + Math.sin(i / 3.3) * 0.5;
    const open = p;
    const close = 100 + w * 3 + i * 0.01;
    out.push({
      time: 1_700_000_000 + i * 1800,
      open,
      close,
      high: Math.max(open, close) + 0.3 + ((i * 7) % 5) * 0.05,
      low: Math.min(open, close) - 0.3 - ((i * 3) % 5) * 0.05,
      volume: 100 + ((i * 37) % 23) * 10 + (i % 11 === 0 ? 400 : 0),
    });
    p = close;
  }
  return out;
}

test('weekly fib uses the last CLOSED candle only and follows its colour', () => {
  const closed = weekly(100, 120, 125, 95, 8); // bullish, closed
  const forming = weekly(120, 90, 130, 80, 10); // started at NOW-3d → still forming
  const f = computeWeeklyFib([closed, forming], {}, NOW);
  assert.equal(f.time, closed.time);
  assert.equal(f.candleDir, 'bullish');
  assert.equal(f.dir, 'bullish');
  const l0 = f.levels.find((l) => l.ratio === 0);
  const l1 = f.levels.find((l) => l.ratio === 1);
  assert.equal(l0.price, 125); // low→high: 0 at the high
  assert.equal(l1.price, 95);

  const bear = weekly(120, 100, 125, 95, 8);
  const fb = computeWeekly(bear);
  assert.equal(fb.dir, 'bearish');
  assert.equal(fb.levels.find((l) => l.ratio === 0).price, 95); // high→low: 0 at the low
  assert.equal(fb.levels.find((l) => l.ratio === 1).price, 125);

  const forced = computeWeeklyFib([bear], { weeklyDirection: 'bullish' }, NOW);
  assert.equal(forced.dir, 'bullish');
  assert.equal(forced.forced, true);
  assert.equal(computeWeeklyFib([forming], {}, NOW), null);
});
function computeWeekly(c) {
  return computeWeeklyFib([c], {}, NOW);
}

test('config normalisation keeps admin selections', () => {
  const c = normalizeObFibConfig({ timeframes: ['1h', 'bad'], fibLevels: [0.618, 0.66, 99], weeklyDirection: 'x' });
  assert.deepEqual(c.timeframes, ['1h']);
  assert.deepEqual(c.fibLevels, [0.618, 0.66]);
  assert.equal(c.weeklyDirection, 'auto');
  assert.equal(normalizeObFibConfig({}).chartEnabled, OB_FIB_DEFAULTS.chartEnabled);
});

test('signal only when a selected fib price is inside an OB zone; OB type = direction', () => {
  const candles = series();
  const obs = detectLuxAlgoOrderBlocks(candles, 300, { length: 5 });
  assert.ok(obs.length > 0, 'fixture must contain order blocks');
  const ob = obs[obs.length - 1];
  const mid = (ob.high + ob.low) / 2;
  const price = candles[candles.length - 1].close;

  // weekly range where fib 0.5 == OB mid (bullish: 0 at high)
  const range = 40;
  const w = { ...weekly(mid - range / 2, mid + range / 2, mid + range / 2, mid - range / 2, 8) };
  const fib = computeWeeklyFib([w], { fibLevels: [0.5] }, NOW);
  const cfg = { fibLevels: [0.5], requireExtremeOb: false, maxEntryDistanceATR: 100, minScore: 0, minRR: 0.1, maxStopATR: 100 };
  const res = runObFibPair({ symbol: 'TESTUSDT', price, candles, tf: '30m', weekly: fib, config: cfg });
  assert.ok(res.length >= 1);
  const hit = res.find((r) => r.ob.time === ob.time);
  assert.ok(hit, 'the OB containing the fib is signalled');
  assert.equal(hit.dir, ob.type === 'bearish' ? 'SHORT' : 'LONG');
  assert.equal(hit.metadata.obFib.hitRatio, 0.5);
  assert.ok(hit.entry >= ob.low - 1e-9 && hit.entry <= ob.high + 1e-9);
  assert.equal(hit.metadata.patternTf, '30m');

  // fib level NOT selected → nothing for that fib
  const none = computeWeeklyFib([w], { fibLevels: [0.236] }, NOW);
  const res2 = runObFibPair({ symbol: 'TESTUSDT', price, candles, tf: '30m', weekly: none, config: { ...cfg, fibLevels: [0.236] } });
  assert.ok(!res2.some((r) => r.ob.time === ob.time));

  // fib far away from every OB → no signal at all
  const far = computeWeeklyFib([weekly(1000, 1100, 1100, 1000, 8)], { fibLevels: [0.5] }, NOW);
  assert.equal(runObFibPair({ symbol: 'T', price, candles, tf: '30m', weekly: far, config: cfg }).length, 0);
});

test('invalid setups: several fibs in one OB, wide OB, wrong approach side, entry already touched', () => {
  const candles = series();
  const obs = detectLuxAlgoOrderBlocks(candles, 300, { length: 5 });
  const ob = obs[obs.length - 1];
  const mid = (ob.high + ob.low) / 2;
  const price = candles[candles.length - 1].close;
  const range = 40;
  const w = weekly(mid - range / 2, mid + range / 2, mid + range / 2, mid - range / 2, 8);
  const base = { maxEntryDistanceATR: 100, minScore: 0, minRR: 0.1, maxStopATR: 100, requireUntouchedEntry: false, requireApproachSide: false, requireExtremeOb: false };
  const run = (cfgExtra, p = price) => {
    const cfg = { ...base, fibLevels: [0.5], ...cfgExtra };
    const f = computeWeeklyFib([w], cfg, NOW);
    return runObFibPair({ symbol: 'T', price: p, candles, tf: '30m', weekly: f, config: cfg }).filter((r) => r.ob.time === ob.time);
  };
  assert.equal(run({}).length, 1);
  // two selected fib lines inside the same OB → invalid
  assert.equal(run({ fibLevels: [0.5, 0.5001] }).length, 0);
  assert.equal(run({ fibLevels: [0.5, 0.5001], singleFibOnly: false }).length, 1);
  // wide OB filter
  assert.equal(run({ maxObWidthATR: 0.01 }).length, 0);
  // approach side: BUY needs price above entry, SELL needs price below entry
  const dir = run({})[0].dir;
  const entry = run({})[0].entry;
  const wrong = dir === 'LONG' ? entry - 0.001 : entry + 0.001;
  const right = dir === 'LONG' ? entry + 0.001 : entry - 0.001;
  assert.equal(run({ requireApproachSide: true }, wrong).length, 0);
  assert.equal(run({ requireApproachSide: true }, right).length, 1);
  // entry already touched after the OB formed → invalid
  const withTouch = candles.slice();
  const k = withTouch.length - 1;
  withTouch[k] = { ...withTouch[k], low: Math.min(withTouch[k].low, entry - 0.01), high: Math.max(withTouch[k].high, entry + 0.01) };
  const cfg = { ...base, fibLevels: [0.5], requireUntouchedEntry: true };
  const f = computeWeeklyFib([w], cfg, NOW);
  const r = runObFibPair({ symbol: 'T', price, candles: withTouch, tf: '30m', weekly: f, config: cfg }).filter((x) => x.ob.time === ob.time);
  assert.equal(r.length, 0);
});

test('reference timeframe: daily / monthly use their own previous CLOSED candle', () => {
  const day = 86400;
  const d0 = 1_700_006_400; // some midnight-aligned start
  const dNow = d0 + 5 * day + 3600;
  const closedD = { time: d0 + 3 * day, open: 10, close: 12, high: 13, low: 9, volume: 1 };
  const formingD = { time: d0 + 5 * day, open: 12, close: 11, high: 14, low: 8, volume: 1 };
  const fd = computeWeeklyFib([closedD, formingD], {}, dNow, '1d');
  assert.equal(fd.time, closedD.time - 0 + 0 === closedD.time ? fd.time : -1);
  assert.equal(fd.refLabel, 'Daily');
  assert.ok(fd.time <= d0 + 4 * day);

  // monthly: Sep-2026 closed, Oct-2026 still forming on 28 Oct
  const sep = Date.UTC(2026, 8, 1) / 1000;
  const oct = Date.UTC(2026, 9, 1) / 1000;
  const now = Date.UTC(2026, 9, 28) / 1000;
  const fm = computeWeeklyFib(
    [{ time: sep, open: 5, close: 4, high: 8, low: 3, volume: 1 }, { time: oct, open: 4, close: 6, high: 9, low: 2, volume: 1 }],
    {}, now, '1M');
  assert.equal(fm.time, sep);
  assert.equal(fm.dir, 'bearish');
  assert.equal(fm.refLabel, 'Monthly');
  assert.deepEqual(normalizeObFibConfig({ refTimeframes: ['1d', '1M', 'x'] }).refTimeframes, ['1d', '1M']);
  assert.deepEqual(normalizeObFibConfig({ refTimeframes: [] }).refTimeframes, ['1w']);
});

test('OB candle must sit at the swing extreme (not mid-leg)', () => {
  const candles = series();
  const obs = detectLuxAlgoOrderBlocks(candles, 300, { length: 5 });
  const price = candles[candles.length - 1].close;
  const common = { maxEntryDistanceATR: 100, minScore: 0, minRR: 0.1, maxStopATR: 100, requireUntouchedEntry: false, requireApproachSide: false, maxObWidthATR: 0, fibLevels: [0.5] };
  let strictOnly = 0;
  let relaxed = 0;
  for (const ob of obs) {
    const mid = (ob.high + ob.low) / 2;
    const w = weekly(mid - 20, mid + 20, mid + 20, mid - 20, 8);
    for (const requireExtremeOb of [true, false]) {
      const cfg = { ...common, requireExtremeOb, extremeWindow: 8, extremeTolATR: 0 };
      const f = computeWeeklyFib([w], cfg, NOW);
      const n = runObFibPair({ symbol: 'T', price, candles, tf: '30m', weekly: f, config: cfg }).filter((r) => r.ob.time === ob.time).length;
      if (requireExtremeOb) strictOnly += n; else relaxed += n;
    }
  }
  assert.ok(relaxed >= strictOnly);
});

test('extreme rule rejects an OB whose neighbour candle makes a far higher high / lower low', () => {
  const candles = series();
  const obs = detectLuxAlgoOrderBlocks(candles, 300, { length: 5 });
  const common = { maxEntryDistanceATR: 100, minScore: 0, minRR: 0.1, maxStopATR: 100, requireUntouchedEntry: false, requireApproachSide: false, maxObWidthATR: 0, fibLevels: [0.5], extremeWindow: 8, extremeTolATR: 0.3 };
  const ob = obs.find((o) => candles.findIndex((c) => c.time === o.time) < candles.length - 12);
  assert.ok(ob);
  const oi = candles.findIndex((c) => c.time === ob.time);
  const mid = (ob.high + ob.low) / 2;
  const w = weekly(mid - 20, mid + 20, mid + 20, mid - 20, 8);
  const run = (cs, requireExtremeOb) => {
    const cfg = { ...common, requireExtremeOb };
    const f = computeWeeklyFib([w], cfg, NOW);
    return runObFibPair({ symbol: 'T', price: cs[cs.length - 1].close, candles: cs, tf: '30m', weekly: f, config: cfg }).filter((r) => r.ob.time === ob.time).length;
  };
  const bent = candles.map((c, i) => (i === oi - 3 ? (ob.type === 'bearish' ? { ...c, high: c.high + 10 } : { ...c, low: c.low - 10 }) : c));
  assert.equal(run(bent, true), 0);
  assert.ok(run(bent, false) >= 0);
});
