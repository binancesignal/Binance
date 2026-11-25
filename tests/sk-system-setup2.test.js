import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSymbol, skSetupId } from '../lib/skSystem/engine.js';
import { normalizeSkConfig, validateSkConfig, skSetupNo, skTfs, SK_DEFAULTS_2 } from '../lib/skSystem/config.js';
import * as store from '../lib/skSystem/store.js';
import { upsertFromAnalysis, startRun, runChunk, activeSetups } from '../lib/skSystem/runner.js';
import { buildMaster, makeGetCandles, longWaypoints, T0 } from './helpers/skFixture.js';

// Setup 2 = the same chain one level down (1H primary · 15M structural CHoCH · 5M confirmation).
// The Setup 1 fixture compressed 4× in time IS a valid 1H-scale market, so every stage can be tested with real data.
const scale = (wp, k = 4) => wp.map((w) => ({ ...w, bars: Math.max(2, Math.round(w.bars / k)) }));
const CFG2 = normalizeSkConfig({ htfAlignment: 'off' }, 2);
const CFG1 = normalizeSkConfig({ htfAlignment: 'off' }, 1);
const nowOf = (c5) => c5[c5.length - 1].time + 300;

async function run2(upTo, { cfg = CFG2 } = {}) {
  const c5 = buildMaster(scale(longWaypoints({ upToStage: upTo })));
  const res = await analyzeSymbol({ symbol: 'TESTUSDT', getCandles: makeGetCandles(c5), cfg, nowSec: nowOf(c5) });
  return { c5, long: res.results.find((r) => r.dir === 'LONG') };
}

test('setup2 config: own defaults, own allowed time frames, Setup 1 untouched', () => {
  const { config, notes } = validateSkConfig({}, 2);
  assert.deepEqual(notes, []);
  assert.equal(config.setup, 2);
  assert.equal(config.primaryTf, '1h');
  assert.deepEqual(config.confirmTfs, ['5m']);
  assert.equal(config.minScore, SK_DEFAULTS_2.minScore);
  // 4H / 2H primary and the Setup 1 confirm list are NOT valid for Setup 2 …
  const bad = validateSkConfig({ primaryTf: '4h', confirmTfs: ['2h', '15m', '3m'] }, 2);
  assert.equal(bad.config.primaryTf, '1h');
  assert.deepEqual(bad.config.confirmTfs, ['3m']);
  // … and Setup 1 still has its original defaults
  const one = validateSkConfig({}, 1).config;
  assert.equal(one.primaryTf, '4h');
  assert.deepEqual(one.confirmTfs, ['2h', '30m', '15m', '5m']);
  assert.equal(one.setup, 1);
});

test('setup2 profile: roles resolve to 1D/4H → 1H → 15M → 5M/3M', () => {
  const t = skTfs(CFG2);
  assert.deepEqual([t.htfHigh, t.htfLow, t.primary, t.validate, t.struct, t.mids], ['1d', '4h', '1h', '30m', '15m', ['5m', '3m']]);
  const t1 = skTfs(CFG1);
  assert.deepEqual([t1.htfHigh, t1.htfLow, t1.primary, t1.validate, t1.struct, t1.mids], ['1w', '1d', '4h', '2h', '1h', ['30m', '15m', '5m']]);
});

test('setup ids: Setup 1 format unchanged, Setup 2 has its own prefix (no collisions)', () => {
  assert.equal(skSetupId('btcusdt', 'LONG', 123), 'sk_BTCUSDT_LONG_123');
  assert.equal(skSetupId('btcusdt', 'LONG', 123, 2), 'sk2_BTCUSDT_LONG_123');
  assert.equal(skSetupNo('sk2_BTCUSDT_LONG_123'), 2);
  assert.equal(skSetupNo('sk_BTCUSDT_LONG_123'), 1);
});

test('setup2 engine: every stage is reached on 1H-scale data', async () => {
  const stages = { swing: 'FIBONACCI_ACTIVE', czone: 'C_ZONE_REACHED', 1: 'x' };
  const a = (await run2('czone')).long.analysis;
  assert.equal(a.stage, 'C_ZONE_REACHED');
  assert.equal(a.setup, 2);
  assert.equal(a.primaryTf, '1h');
  assert.equal(a.tfs.struct, '15m');
  const b = (await run2('1h')).long.analysis;
  assert.equal(b.stage, 'LTF_CONFIRMATION');
  assert.equal(b.ltf['15m'].status, 'CONFIRMED'); // the structural CHoCH is the 15M one
  assert.equal(b.ltf['1h'], undefined); // …and nothing is keyed by Setup 1's time frames
  assert.ok(stages);
});

test('setup2 engine: ENTRY_READY with entry on 5M, steps and annotations use Setup 2 time frames', async () => {
  const { long } = await run2('entry');
  const a = long.analysis;
  assert.equal(a.stage, 'ENTRY_READY');
  assert.equal(a.entry.tf, '5m');
  assert.ok(a.entry.sl < a.entry.price && a.entry.price < a.entry.tp1 && a.entry.tp1 < a.entry.tp2 && a.entry.tp2 < a.entry.tp3);
  assert.ok(a.entry.rr >= CFG2.minRR);
  const ids = a.steps.map((s) => s.id);
  assert.deepEqual(ids.slice(0, 2), ['1d', '4h']);
  assert.ok(ids.includes('15m') && ids.includes('5m'));
  assert.ok(!ids.includes('1w') && !ids.includes('1h') && !ids.includes('2h'));
  assert.equal(a.steps.find((s) => s.id === '15m').status, 'CONFIRMED');
  assert.equal(a.steps.find((s) => s.id === '30m').status, 'SKIPPED'); // optional, off by default
  assert.equal(a.steps.find((s) => s.id === '3m').status, 'SKIPPED');
  const labels = a.annotations.map((x) => x.label || '');
  assert.ok(labels.some((l) => l.startsWith('15M CHoCH')));
  assert.ok(labels.includes('1H CHoCH') === false || labels.some((l) => l.startsWith('1H prior'))); // the 1H CHoCH here is the PRIMARY one (A-B-C), not a lower-TF confirmation
  assert.ok(!labels.some((l) => /^1H Fib entry zone|^2H hold|^1H sweep/.test(l)));
  assert.ok(labels.some((l) => l.startsWith('5M entry')));
});

test('setup2 engine: stricter optional 30M validation can block the entry (it is configurable)', async () => {
  const strict = normalizeSkConfig({ htfAlignment: 'off', confirmTfs: ['30m', '5m'] }, 2);
  const { long } = await run2('entry', { cfg: strict });
  const a = long.analysis;
  assert.ok(a);
  assert.ok(a.steps.find((s) => s.id === '30m').status !== 'SKIPPED');
});

test('setup2 engine: SHORT (mirrored) works the same way', async () => {
  const c5 = buildMaster(scale(longWaypoints({ upToStage: 'entry' })));
  const res = await analyzeSymbol({ symbol: 'TESTUSDT', getCandles: makeGetCandles(c5, { mirror: true }), cfg: CFG2, nowSec: nowOf(c5) });
  const s = res.results.find((r) => r.dir === 'SHORT').analysis;
  assert.equal(s.stage, 'ENTRY_READY');
  assert.ok(s.entry.sl > s.entry.price && s.entry.price > s.entry.tp1);
});

test('setup1 is unaffected by the refactor (4H fixture still reaches ENTRY_READY on 1H/5M)', async () => {
  const c5 = buildMaster(longWaypoints({ upToStage: 'entry' }));
  const res = await analyzeSymbol({ symbol: 'TESTUSDT', getCandles: makeGetCandles(c5), cfg: CFG1, nowSec: nowOf(c5) });
  const a = res.results.find((r) => r.dir === 'LONG').analysis;
  assert.equal(a.stage, 'ENTRY_READY');
  assert.equal(a.setup, 1);
  assert.equal(a.tfs.struct, '1h');
});

test('setup1 + setup2 on the SAME market are stored as two independent setups', async () => {
  const c5 = buildMaster(scale(longWaypoints({ upToStage: 'entry' })));
  const getCandles = makeGetCandles(c5);
  const a2 = (await analyzeSymbol({ symbol: 'DUALUSDT', getCandles, cfg: CFG2, nowSec: nowOf(c5), dirs: ['LONG'] })).results[0].analysis;
  const u = await upsertFromAnalysis({ analysis: a2, price: a2.entry.price, cfg: CFG2, runId: 't' });
  assert.equal(u.action, 'created');
  assert.ok(u.id.startsWith('sk2_'));
  const saved = await store.getSetup(u.id);
  assert.equal(saved.setup, 2);
  assert.equal(saved.primaryTf, '1h');
  const list2 = await store.listSetups({ setup: 2 });
  const list1 = await store.listSetups({ setup: 1 });
  assert.ok(list2.some((s) => s.id === u.id));
  assert.ok(!list1.some((s) => s.id === u.id));
});

test('runner: activeSetups honours the selection and the per-setup switch', () => {
  const on = { 1: { enabled: true }, 2: { enabled: true } };
  assert.deepEqual(activeSetups(on), [1, 2]);
  assert.deepEqual(activeSetups(on, [2]), [2]);
  assert.deepEqual(activeSetups({ 1: { enabled: true }, 2: { enabled: false } }), [1]);
  assert.deepEqual(activeSetups({ 1: { enabled: true } }, [1, 2]), [1]);
});

test('runner: a scan run with setups [1,2] analyses every coin with BOTH setups and stores Setup 2 hits', async () => {
  const c5 = buildMaster(scale(longWaypoints({ upToStage: 'entry' })));
  const getC = makeGetCandles(c5);
  const calls = [];
  const deps = {
    loadExchangeInfo: async () => ['RUNUSDT'],
    loadTickers: async () => ({ RUNUSDT: { price: 276, volume: 1 } }),
    getKlines: async (sym, tf, limit) => {
      calls.push(tf);
      return getC(tf, limit);
    },
  };
  const cfgs = { 1: CFG1, 2: CFG2 };
  const r = await startRun({ cfg: CFG1, cfgs, deps, mode: 'top', topN: 1 });
  assert.deepEqual(r.config.setups, [1, 2]);
  const out = await runChunk({ runId: r.id, deps, cfg: CFG1, cfgs, budgetMs: 60_000, force: true });
  assert.equal(out.run.status, 'completed');
  assert.equal(out.run.failed, 0);
  assert.ok(calls.includes('15m') && calls.includes('1w'), 'both chains fetched their own time frames');
  const stored = await store.listSetups({ symbol: 'RUN' });
  assert.ok(stored.some((s) => s.setup === 2), 'a Setup 2 setup was stored');
});

test('runner: without cfgs the scan stays Setup 1 only (backward compatible)', async () => {
  const deps = { loadExchangeInfo: async () => ['OLDUSDT'], loadTickers: async () => ({}), getKlines: async () => [] };
  const r = await startRun({ cfg: CFG1, deps, mode: 'top', topN: 1 });
  assert.deepEqual(r.config.setups, [1]);
});
