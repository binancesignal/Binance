import test from 'node:test';
import assert from 'node:assert/strict';
import { runEmaBumpPair } from '../lib/scanner/strategy/emaBump/index.js';
import { normalizeEmaBumpConfig, EMA_BUMP_DEFAULTS, EMA_BUMP_GATES, ALL_TFS, gateMode } from '../lib/scanner/strategy/emaBump/config.js';

// Candle series built from a close path (each candle opens at the previous close).
function build(path, wick = 0.4) {
  const out = [];
  let prev = path[0];
  path.forEach((close, i) => {
    const open = prev;
    const hi = Math.max(open, close) + wick * (0.6 + (0.4 * ((i * 7) % 5)) / 4);
    const lo = Math.min(open, close) - wick * (0.6 + (0.4 * ((i * 3) % 5)) / 4);
    out.push({ time: 1700000000 + i * 900, open, high: hi, low: lo, close, volume: 1000 + (i % 5) * 50 });
    prev = close;
  });
  return out;
}

/** flat → slow decline → slow base → break-up through both EMAs → top → pullback to EMA 50 */
function setupPath({ pullback = [-0.25, -0.3, -0.35, -0.2, -0.15] } = {}) {
  const path = [];
  for (let i = 0; i < 40; i++) path.push(100 + Math.sin(i / 3) * 0.4);
  for (let i = 0; i < 70; i++) path.push(path[path.length - 1] - 0.07 + Math.sin(i * 1.7) * 0.25);
  for (let i = 0; i < 12; i++) path.push(path[path.length - 1] + 0.03 + Math.sin(i * 1.3) * 0.2);
  for (const r of [0.15, 0.25, 0.3, 0.4, 0.45, 0.5, 0.3]) path.push(path[path.length - 1] + r);
  for (const r of pullback) path.push(path[path.length - 1] + r);
  return path;
}

const ALL_OFF = Object.fromEntries(EMA_BUMP_GATES.map((g) => [g.key, 'off']));
const loose = { minScore: 0, gateModes: ALL_OFF };
const run = (candles, config = loose, extra = {}) =>
  runEmaBumpPair({ symbol: 'TESTUSDT', price: candles[candles.length - 1].close, candles, tf: '15m', config, ...extra });

test('LONG: break-up → top → pullback touching EMA50 is READY, entry = the top high', () => {
  const candles = build(setupPath());
  const [sig] = run(candles);
  assert.ok(sig, 'expected a signal');
  assert.equal(sig.dir, 'LONG');
  assert.equal(sig.strategy, 'ema_bump');
  const top = candles[sig.metadata.emaGeom ? candles.findIndex((c) => c.time === sig.metadata.emaGeom.top.time) : -1];
  assert.equal(sig.entry, +top.high.toFixed(8));
  assert.ok(sig.entry > candles[candles.length - 1].close, 'entry (top high) is still above price');
  assert.ok(sig.sl < sig.entry && sig.tp1 > sig.entry && sig.tp2 > sig.tp1 && sig.tp3 > sig.tp2);
  assert.equal(sig.metadata.patternTf, '15m');
  assert.equal(sig.metadata.htfTf, '1h');
  // SL sits below the pullback low
  assert.ok(sig.sl < sig.metadata.emaGeom.pullLow.price);
});

test('no signal while the pullback has NOT touched EMA 50 yet', () => {
  const candles = build(setupPath({ pullback: [-0.25, -0.3, -0.2] }));
  assert.equal(run(candles).length, 0);
});

test('no signal when a pullback candle closes below the EMA 20 (red broken)', () => {
  const crash = setupPath({ pullback: [-0.3, -0.5, -0.9, -1.2] });
  assert.equal(run(build(crash)).length, 0);
});

test('no signal once the top has already been broken (setup is past READY)', () => {
  const path = setupPath();
  for (const r of [0.4, 0.6, 0.8, 0.6]) path.push(path[path.length - 1] + r);
  assert.equal(run(build(path)).length, 0);
});

test('SHORT: mirrored series gives a SHORT with entry = the bottom low', () => {
  const mirrored = build(setupPath().map((p) => 200 - p));
  const [sig] = run(mirrored);
  assert.ok(sig, 'expected a signal');
  assert.equal(sig.dir, 'SHORT');
  const bottom = mirrored.find((c) => c.time === sig.metadata.emaGeom.top.time);
  assert.equal(sig.entry, +bottom.low.toFixed(8));
  assert.ok(sig.sl > sig.entry && sig.tp1 < sig.entry && sig.tp3 < sig.tp2);
});

test('allowLong / allowShort switches are respected', () => {
  assert.equal(run(build(setupPath()), { ...loose, allowLong: false }).length, 0);
  assert.equal(run(build(setupPath().map((p) => 200 - p)), { ...loose, allowShort: false }).length, 0);
});

test('no signal in a plain up-trend (no dip under the EMAs)', () => {
  const path = [];
  for (let i = 0; i < 140; i++) path.push(100 + i * 0.1 + Math.sin(i / 2) * 0.2);
  assert.equal(run(build(path)).length, 0);
});

test('HARD gate rejects, SOFT gate only costs score, OFF gate is ignored', () => {
  const candles = build(setupPath());
  // volume threshold impossible → HARD rejects
  assert.equal(run(candles, { ...loose, gateModes: { ...ALL_OFF, volume: 'hard' }, volumeMinRvol: 9 }).length, 0);
  // same gate SOFT → still produced, but score is lower and the failure is recorded
  const base = run(candles)[0];
  const soft = run(candles, { ...loose, gateModes: { ...ALL_OFF, volume: 'soft' }, volumeMinRvol: 9 })[0];
  assert.ok(soft, 'soft gate must not reject');
  assert.ok(soft.score < base.score);
  assert.deepEqual(soft.metadata.softFails, ['volume']);
  assert.equal(soft.metadata.gates.find((g) => g.key === 'volume').pass, false);
  // OFF gates do not appear in the checklist
  assert.equal(base.metadata.gates.length, 0);
});

test('reportAll returns a gate-rejected setup for the chart preview', () => {
  const candles = build(setupPath());
  const [r] = run(candles, { ...loose, gateModes: { ...ALL_OFF, volume: 'hard' }, volumeMinRvol: 9 }, { reportAll: true });
  assert.ok(r);
  assert.equal(r.metadata.gateRejected, true);
  assert.ok(r.metadata.rejectReasons.some((x) => /Bump volume/.test(x)));
});

test('HTF gate: HTF clearly trending against the trade rejects (when hard)', () => {
  const candles = build(setupPath());
  const htfDown = build(Array.from({ length: 120 }, (_, i) => 200 - i * 0.8));
  const cfg = { ...loose, gateModes: { ...ALL_OFF, htf: 'hard' } };
  assert.equal(run(candles, cfg, { htfCandles: htfDown }).length, 0);
  const htfUp = build(Array.from({ length: 120 }, (_, i) => 100 + i * 0.8));
  assert.equal(run(candles, cfg, { htfCandles: htfUp }).length, 1);
  // not supplied → not evaluated, never rejects
  assert.equal(run(candles, cfg).length, 1);
});

test('min score gate filters weak setups', () => {
  assert.equal(run(build(setupPath()), { ...loose, minScore: 100 }).length, 0);
});

test('live price far from the entry is not actionable', () => {
  const candles = build(setupPath());
  const far = runEmaBumpPair({
    symbol: 'TESTUSDT', price: candles[candles.length - 1].close * 1.2, candles, tf: '15m',
    config: { ...loose, maxEntryDistanceATR: 1 },
  });
  assert.equal(far.length, 0);
});

test('config normaliser clamps values, keeps valid time frames and valid gate modes only', () => {
  const cfg = normalizeEmaBumpConfig({
    timeframes: ['5m', '1h', 'bogus', '5m'], fastPeriod: 50, slowPeriod: 20, minScore: 5,
    gateModes: { htf: 'off', volume: 'weird', chop: 'soft', nope: 'hard' },
  });
  assert.deepEqual(cfg.timeframes, ['5m', '1h']);
  assert.ok(cfg.slowPeriod > cfg.fastPeriod);
  assert.equal(cfg.minScore, 30);
  assert.deepEqual(cfg.gateModes, { htf: 'off', chop: 'soft' });
  assert.equal(gateMode(cfg, 'volume'), 'hard'); // falls back to the gate default
  assert.equal(gateMode(cfg, 'htf'), 'off');
  assert.deepEqual(normalizeEmaBumpConfig({ timeframes: [] }).timeframes, EMA_BUMP_DEFAULTS.timeframes);
  assert.ok(ALL_TFS.includes('1m') && ALL_TFS.includes('1d'));
});
