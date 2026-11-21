import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSymbol, skSetupId, buildAnnotations } from '../lib/skSystem/engine.js';
import { SK_DEFAULTS, normalizeSkConfig, validateSkConfig, SK_STAGES, stageRank } from '../lib/skSystem/config.js';
import { findPivots, alternatePivots, findBullishChoch, swings, trendOf, mirrorCandles } from '../lib/skSystem/structure.js';
import { evaluateSetup, bucketOf, trackingTf } from '../lib/skSystem/lifecycle.js';
import { selectUniverse, resolveScanRequest } from '../lib/skSystem/universe.js';
import * as store from '../lib/skSystem/store.js';
import { upsertFromAnalysis, startRun, runChunk, setRunStatus, trackOpenSetups, scanSymbol } from '../lib/skSystem/runner.js';
import { buildMaster, makeGetCandles, longWaypoints, aggregate, MIRROR_K, mirrorMaster } from './helpers/skFixture.js';

const CFG = normalizeSkConfig({ htfAlignment: 'off' });
const nowOf = (c5) => c5[c5.length - 1].time + 300;
const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

async function run(upTo, { mirror = false, cfg = CFG, wp } = {}) {
  const c5 = buildMaster(wp || longWaypoints({ upToStage: upTo }));
  const res = await analyzeSymbol({ symbol: 'TESTUSDT', getCandles: makeGetCandles(c5, { mirror }), cfg, nowSec: nowOf(c5) });
  return { c5, res, long: res.results.find((r) => r.dir === 'LONG'), short: res.results.find((r) => r.dir === 'SHORT') };
}

// ── config ─────────────────────────────────────────────────────────────────────────────────────
test('config: defaults are valid and untouched by normalisation', () => {
  const { config, notes } = validateSkConfig({});
  assert.deepEqual(notes, []);
  assert.equal(config.primaryTf, '4h');
  assert.deepEqual(config.fibLevels, [0.382, 0.5, 0.618, 0.786]);
  assert.equal(SK_STAGES.length, 16);
});

test('config: server validation clamps, rejects and reports bad values', () => {
  const { config, notes } = validateSkConfig({ minScore: 500, topN: -4, primaryTf: '7d', dExtension: 9, fibLevels: [2, -1, 'x'], tp1R: 5, tp2R: 2, tp3R: 1, maxConcurrent: 99, cZoneFrom: 0.9, cZoneTo: 0.5 });
  assert.equal(config.minScore, 100);
  assert.equal(config.topN, 1);
  assert.equal(config.primaryTf, '4h');
  assert.equal(config.dExtension, 1);
  assert.deepEqual(config.fibLevels, SK_DEFAULTS.fibLevels);
  assert.equal(config.maxConcurrent, 8);
  assert.ok(config.tp1R < config.tp2R && config.tp2R < config.tp3R);
  assert.ok(config.cZoneFrom < config.cZoneTo);
  assert.ok(notes.length >= 6);
});

test('config: admin values are applied (and stay inside their own keys)', () => {
  const c = normalizeSkConfig({ minScore: 75, scanUniverse: 'all', rankingMethod: 'gainers', fibLevels: [0.5, 0.705], confirmTfs: ['15m'], htfAlignment: 'strict' });
  assert.equal(c.minScore, 75);
  assert.equal(c.scanUniverse, 'all');
  assert.equal(c.rankingMethod, 'gainers');
  assert.deepEqual(c.fibLevels, [0.5, 0.705]);
  assert.deepEqual(c.confirmTfs, ['15m']);
  assert.equal(c.htfAlignment, 'strict');
});

// ── structure ──────────────────────────────────────────────────────────────────────────────────
test('structure: pivots are confirmed only (need `right` later bars) and alternate', () => {
  const mk = (h, l, i) => ({ time: i * 60, open: l, close: h, high: h, low: l, volume: 1 });
  const cs = [5, 6, 7, 9, 7, 6, 5, 4, 3, 5, 6, 7, 8].map((h, i) => mk(h, h - 1, i));
  const raw = findPivots(cs, 2, 2);
  assert.ok(raw.some((p) => p.type === 'high' && p.price === 9));
  assert.ok(!raw.some((p) => p.i > cs.length - 3), 'the last bars cannot be pivots yet');
  const alt = alternatePivots(raw);
  for (let i = 1; i < alt.length; i++) assert.notEqual(alt[i].type, alt[i - 1].type);
});

test('structure: a result never repaints when later candles are appended', async () => {
  const c5 = buildMaster(longWaypoints({ upToStage: 'czone' }));
  const c4 = aggregate(c5, '4h');
  const cut = c4.length - 14;
  const early = findBullishChoch(c4.slice(0, cut), swings(c4.slice(0, cut), 3), { maxAgeBars: 400 });
  const late = findBullishChoch(c4, swings(c4, 3), { maxAgeBars: 400 });
  assert.ok(early && late);
  assert.equal(early.A.time, late.A.time);
  assert.equal(early.level, late.level);
  assert.equal(early.breakTime, late.breakTime);
});

test('structure: trendOf', () => {
  const p = (price, type, i) => ({ price, type, i });
  assert.equal(trendOf([p(10, 'low', 0), p(20, 'high', 1), p(12, 'low', 2), p(25, 'high', 3)]), 'UP');
  assert.equal(trendOf([p(30, 'high', 0), p(20, 'low', 1), p(25, 'high', 2), p(15, 'low', 3)]), 'DOWN');
  assert.equal(trendOf([p(30, 'high', 0)]), 'RANGE');
});

// ── LONG ───────────────────────────────────────────────────────────────────────────────────────
test('LONG: full 1W→5M chain reaches ENTRY_READY with a valid trade plan', async () => {
  const { long } = await run('entry');
  const a = long.analysis;
  assert.ok(a, long.reason);
  assert.equal(a.dir, 'LONG');
  assert.equal(a.stage, 'ENTRY_READY');
  const e = a.entry;
  assert.ok(e.sl < e.price && e.price < e.tp1 && e.tp1 < e.tp2 && e.tp2 < e.tp3, 'LONG levels ordered SL < entry < TP1 < TP2 < TP3');
  assert.ok(e.rr >= CFG.minRR);
  assert.ok(a.score >= CFG.minScore);
  assert.ok(e.zone.top >= e.price && e.zone.bottom <= e.price && e.zone.top > e.zone.bottom, 'entry sits inside its zone (top = higher price)');
  for (const id of ['trend', 'choch', 'swings', 'fib', 'abcd', 'czone', '2h', '1h', '30m', '15m', '5m', 'entry']) {
    assert.equal(a.steps.find((s) => s.id === id).status, 'CONFIRMED', id);
  }
});

test('LONG: Fibonacci anchor orientation (low → high) and ABCD points', async () => {
  const { long } = await run('entry');
  const { A, B, C, D, fib, abcd } = long.analysis.h4;
  assert.ok(A.price < C.price && C.price < B.price, 'A < C < B for a LONG ABCD');
  const AB = B.price - A.price;
  for (const l of fib.levels) approx(l.price, B.price - AB * l.ratio); // 0 = B (high) … 1 = A (low)
  approx(fib.levels.find((l) => l.ratio === 0).price, B.price);
  approx(fib.levels.find((l) => l.ratio === 1).price, A.price);
  approx(C.ratio, (B.price - C.price) / AB);
  assert.ok(C.ratio > 0.58 && C.ratio < 0.66, 'the scenario retraces ≈ 0.618');
  approx(D.price, C.price + AB * 1); // CD = AB
  assert.ok(D.price > B.price);
  assert.equal(abcd.valid, true);
});

test('LONG: the 4H setup is primary — lower time frames cannot create a setup without it', async () => {
  const { long, short } = await run('pullback', { wp: longWaypoints({ upToStage: 'pullback' }) });
  assert.ok(long.analysis);
  assert.notEqual(long.analysis.stage, 'ENTRY_READY'); // 30M/15M/5M not confirmed yet
  assert.equal(short.analysis, null);
  // a market with no 4H CHoCH → nothing, whatever the lower time frames do
  const flat = buildMaster([{ to: 100, bars: 3000 }, { to: 120, bars: 600 }, { to: 100, bars: 600 }, { to: 120, bars: 600 }], 100);
  const r = await analyzeSymbol({ symbol: 'FLATUSDT', getCandles: makeGetCandles(flat), cfg: CFG, nowSec: nowOf(flat) });
  assert.ok(r.results.every((x) => !x.analysis || stageRank(x.analysis.stage) < stageRank('LTF_CONFIRMATION')));
});

test('LONG: stage progression follows the market', async () => {
  assert.equal((await run('swing')).long.analysis.stage, 'FIBONACCI_ACTIVE');
  assert.equal((await run('czone')).long.analysis.stage, 'C_ZONE_REACHED');
  const s1h = (await run('1h')).long.analysis;
  assert.equal(s1h.stage, 'LTF_CONFIRMATION');
  assert.equal(s1h.ltf['1h'].status, 'CONFIRMED');
  assert.equal(s1h.entry, null);
});

// ── SHORT ──────────────────────────────────────────────────────────────────────────────────────
test('SHORT: mirrored market gives the mirrored setup (symmetry)', async () => {
  const L = (await run('entry')).long.analysis;
  const S = (await run('entry', { mirror: true })).short.analysis;
  assert.ok(S, 'SHORT setup found');
  assert.equal(S.dir, 'SHORT');
  assert.equal(S.stage, 'ENTRY_READY');
  const m = (p) => MIRROR_K - p;
  approx(S.h4.A.price, m(L.h4.A.price));
  approx(S.h4.B.price, m(L.h4.B.price));
  approx(S.h4.C.price, m(L.h4.C.price));
  approx(S.h4.D.price, m(L.h4.D.price));
  approx(S.entry.price, m(L.entry.price));
  approx(S.entry.sl, m(L.entry.sl));
  approx(S.entry.tp1, m(L.entry.tp1));
  approx(S.entry.tp3, m(L.entry.tp3));
  approx(S.entry.rr, L.entry.rr);
  assert.equal(S.score, L.score);
  const e = S.entry;
  assert.ok(e.sl > e.price && e.price > e.tp1 && e.tp1 > e.tp2 && e.tp2 > e.tp3, 'SHORT levels ordered SL > entry > TP1 > TP2 > TP3');
});

test('SHORT: Fibonacci anchor orientation (high → low) and ABCD points', async () => {
  const S = (await run('entry', { mirror: true })).short.analysis;
  const { A, B, C, D, fib } = S.h4;
  assert.ok(A.price > C.price && C.price > B.price, 'A > C > B for a SHORT ABCD');
  const AB = A.price - B.price;
  for (const l of fib.levels) approx(l.price, B.price + AB * l.ratio); // 0 = B (low) … 1 = A (high)
  assert.equal(fib.anchor, 'high→low');
  assert.ok(D.price < B.price);
  assert.ok(S.h4.czone.top > S.h4.czone.bottom, 'zone top is always the higher price');
  assert.ok(S.entry.zone.top > S.entry.zone.bottom && S.ltf['1h'].zone.top > S.ltf['1h'].zone.bottom);
});

test('LONG market never produces a SHORT setup (and vice-versa)', async () => {
  const L = await run('entry');
  assert.equal(L.short.analysis, null);
  const S = await run('entry', { mirror: true });
  assert.equal(S.long.analysis, null);
});

// ── ABCD validation ────────────────────────────────────────────────────────────────────────────
test('ABCD: a too-deep BC retrace invalidates, a shallow one stays at FIBONACCI_ACTIVE', async () => {
  const deep = await run(null, { wp: [...longWaypoints({ upToStage: 'swing' }), { to: 232, bars: 400 }] });
  assert.equal(deep.long.analysis, null);
  assert.match(deep.long.reason, /retrace|broke A/);
  const shallow = await run(null, { wp: [...longWaypoints({ upToStage: 'swing' }), { to: 286, bars: 300 }] });
  assert.equal(shallow.long.analysis.stage, 'FIBONACCI_ACTIVE');
  assert.ok(shallow.long.analysis.h4.abcd.retrace < CFG.abcdMinRetrace);
  const broke = await run(null, { wp: [...longWaypoints({ upToStage: 'swing' }), { to: 225, bars: 400 }] });
  assert.equal(broke.long.analysis, null);
  assert.match(broke.long.reason, /broken|broke A/);
});

// ── 1W / 1D alignment ──────────────────────────────────────────────────────────────────────────
const wave = (n, f, t0, step) =>
  Array.from({ length: n }, (_, i) => {
    const c = f(i);
    return { time: t0 + i * step, open: c - 0.5, close: c + 0.5, high: c + 3, low: c - 3, volume: 10 };
  });

test('HTF alignment: LONG needs 1D bias up (standard) · strict needs 1W too · off ignores', async () => {
  const c5 = buildMaster(longWaypoints({ upToStage: 'czone' }));
  const base = makeGetCandles(c5);
  const up = (n, step) => wave(n, (i) => 100 + i * 4 + 14 * Math.sin(i / 1.4), 1_700_000_000, step);
  const down = (n, step) => wave(n, (i) => 400 - i * 4 + 14 * Math.sin(i / 1.4), 1_700_000_000, step);
  const mk = (w, d) => async (tf, limit) => (tf === '1w' ? w.slice(-limit) : tf === '1d' ? d.slice(-limit) : base(tf, limit));
  const W = (cfg, w, d) => analyzeSymbol({ symbol: 'X', getCandles: mk(w, d), cfg: normalizeSkConfig(cfg), nowSec: nowOf(c5), dirs: ['LONG'] }).then((r) => r.results[0]);
  assert.ok((await W({ htfAlignment: 'standard' }, up(60, 604800), up(120, 86400))).analysis);
  const bad = await W({ htfAlignment: 'standard' }, up(60, 604800), down(120, 86400));
  assert.equal(bad.analysis, null);
  assert.match(bad.reason, /HTF not aligned/);
  assert.ok((await W({ htfAlignment: 'standard' }, down(60, 604800), up(120, 86400))).analysis === null, '1W opposite blocks (standard)');
  assert.equal((await W({ htfAlignment: 'strict' }, up(60, 604800), up(120, 86400))).analysis?.stage, 'C_ZONE_REACHED');
  assert.ok((await W({ htfAlignment: 'off' }, down(60, 604800), down(120, 86400))).analysis);
});

// ── multi-timeframe connection + chart annotations ─────────────────────────────────────────────
test('MTF: every lower-timeframe step is tied to the 4H structure (times, zone, floor)', async () => {
  const a = (await run('entry')).long.analysis;
  const { h4, ltf, entry } = a;
  assert.ok(ltf['1h'].choch.breakTime >= h4.czone.reachedTime, '1H CHoCH comes after the 4H C zone was reached');
  assert.ok(ltf['1h'].A1.price <= h4.czone.top + 0.03 * (h4.B.price - h4.A.price), '1H swing low sits in the C zone');
  assert.ok(ltf['1h'].A1.price > h4.A.price, 'never below A');
  for (const tf of ['30m', '15m', '5m']) {
    assert.ok(ltf[tf].low.time >= ltf['1h'].B1.time, `${tf} pullback follows the 1H high`);
    assert.ok(ltf[tf].low.price <= ltf['1h'].zone.top + 1, `${tf} CHoCH low is inside the 1H Fib zone`);
  }
  assert.ok(entry.armedAt >= ltf['5m'].choch.breakTime);
  assert.ok(entry.sl < ltf['5m'].low.price, 'SL is below the pullback low');
  assert.equal(entry.d, h4.D.price);
  assert.equal(entry.tp2, h4.B.price, 'TP2 = 4H B (structure targets)');
});

test('chart: annotations come from calculated data, grouped and TF-labelled', async () => {
  const a = (await run('entry')).long.analysis;
  const groups = new Set(a.annotations.map((x) => x.group));
  for (const g of ['trend', 'swings', 'choch', 'fib', 'abcd', 'czone', 'ltf', 'entry', 'targets']) assert.ok(groups.has(g), `group ${g}`);
  for (const x of a.annotations) {
    assert.ok(x.tf && x.group && x.kind);
    const prices = x.kind === 'poly' ? x.points.map((p) => p.p) : [x.p1, x.p2, x.p].filter((v) => v !== undefined);
    assert.ok(prices.length && prices.every(Number.isFinite), x.id);
  }
  const mark = (n) => a.annotations.find((x) => x.group === 'abcd' && x.kind === 'marker' && x.label === n);
  assert.equal(mark('A').p, a.h4.A.price);
  assert.equal(mark('B').p, a.h4.B.price);
  assert.equal(mark('C').p, a.h4.C.price);
  assert.equal(a.annotations.find((x) => x.group === 'abcd' && x.projected).p, a.h4.D.price);
  const hl = (g, label) => a.annotations.find((x) => x.group === g && x.kind === 'hline' && x.label.startsWith(label));
  assert.equal(hl('entry', 'Entry').p1, a.entry.price);
  assert.equal(hl('entry', 'SL').p1, a.entry.sl);
  for (const k of ['TP1', 'TP2', 'TP3']) assert.equal(hl('targets', k).p1, a.entry[k.toLowerCase()]);
  assert.equal(hl('choch', '4H CHoCH').p1, a.h4.choch.level);
  assert.ok(a.annotations.some((x) => x.group === 'fib' && x.label.includes('0.618') && x.p1 === a.h4.fib.levels.find((l) => l.ratio === 0.618).price));
  assert.ok(a.annotations.filter((x) => x.tf === '15m').length && a.annotations.filter((x) => x.tf === '5m').length && a.annotations.filter((x) => x.tf === '1h').length);
  assert.deepEqual(buildAnnotations(a), a.annotations, 'annotation building is deterministic');
});

// ── lifecycle ──────────────────────────────────────────────────────────────────────────────────
const T = 1_700_000_000;
const cdl = (i, o, h, l, c) => ({ time: T + i * 300, open: o, high: h, low: l, close: c, volume: 1 });
const mkSetup = (dir = 'LONG') => ({
  id: 'sk_X_LONG_1', symbol: 'X', dir, stage: 'ENTRY_READY', maxStage: 'ENTRY_READY', status: 'OPEN', primaryTf: '4h',
  A: { time: T - 100000, price: dir === 'LONG' ? 50 : 150 }, D: { price: dir === 'LONG' ? 130 : 70 },
  createdAt: new Date(T * 1000).toISOString(),
  entry: dir === 'LONG' ? { price: 100, sl: 95, tp1: 110, tp2: 120, tp3: 130, d: 130, armedAt: T, locked: true } : { price: 100, sl: 105, tp1: 90, tp2: 80, tp3: 70, d: 70, armedAt: T, locked: true },
});
const flip = (cs) => cs.map((c) => ({ ...c, open: 200 - c.open, close: 200 - c.close, high: 200 - c.low, low: 200 - c.high }));
const ev = (s, cs, extra = {}) => evaluateSetup(s, { candles: cs, ...extra }, T + 300 * (cs.length + 2), CFG);

for (const dir of ['LONG', 'SHORT']) {
  const f = (cs) => (dir === 'LONG' ? cs : flip(cs));
  test(`lifecycle ${dir}: entry → TP1 → TP2 (open)`, () => {
    const r = ev(mkSetup(dir), f([cdl(0, 106, 108, 102, 103), cdl(1, 103, 104, 99.9, 101), cdl(2, 101, 111, 103, 110), cdl(3, 110, 121, 109, 120)]));
    assert.equal(r.patch.stage, 'TP2_HIT');
    assert.equal(r.patch.status, 'OPEN');
    assert.deepEqual(r.events.map((e) => e.stage), ['ENTRY_ONGOING', 'TP1_HIT', 'TP2_HIT']);
  });
  test(`lifecycle ${dir}: stop loss (no TP) → STOP_LOSS_HIT`, () => {
    const r = ev(mkSetup(dir), f([cdl(0, 106, 108, 102, 103), cdl(1, 103, 104, 99.9, 101), cdl(2, 101, 102, 94, 95)]));
    assert.equal(r.patch.stage, 'STOP_LOSS_HIT');
    assert.equal(r.patch.status, 'CLOSED');
    assert.equal(r.patch.outcome, 'SL');
  });
  test(`lifecycle ${dir}: TP1 then SL stays a win (TP1_THEN_SL)`, () => {
    const r = ev(mkSetup(dir), f([cdl(0, 103, 104, 99.9, 101), cdl(1, 101, 111, 103, 110), cdl(2, 110, 111, 94, 95)]));
    assert.equal(r.patch.stage, 'TP1_HIT');
    assert.equal(r.patch.outcome, 'TP1_THEN_SL');
    assert.equal(r.patch.status, 'CLOSED');
  });
  test(`lifecycle ${dir}: TP1 before the entry filled → INVALIDATED (missed entry)`, () => {
    const r = ev(mkSetup(dir), f([cdl(0, 106, 112, 104, 111)]));
    assert.equal(r.patch.stage, 'INVALIDATED');
    assert.match(r.patch.invalidation.reason, /Missed entry/);
    assert.equal(r.patch.status, 'CLOSED');
  });
  test(`lifecycle ${dir}: TP3 = D closes as D_TARGET_REACHED`, () => {
    const r = ev(mkSetup(dir), f([cdl(0, 103, 104, 99.9, 101), cdl(1, 101, 131, 103, 130)]));
    assert.equal(r.patch.stage, 'D_TARGET_REACHED');
    assert.equal(r.patch.status, 'CLOSED');
    assert.ok(r.events.some((e) => e.stage === 'TP3_HIT') && r.events.some((e) => e.stage === 'D_TARGET_REACHED'));
  });
  test(`lifecycle ${dir}: SL and TP inside one candle → SL first (conservative)`, () => {
    const r = ev(mkSetup(dir), f([cdl(0, 103, 104, 99.9, 101), cdl(1, 101, 125, 90, 100)]));
    assert.equal(r.patch.stage, 'STOP_LOSS_HIT');
  });
  test(`lifecycle ${dir}: entry never filled for entryExpiryHours → EXPIRED`, () => {
    const s = mkSetup(dir);
    const r = evaluateSetup(s, { candles: f([cdl(0, 106, 108, 102, 103)]) }, T + (CFG.entryExpiryHours + 1) * 3600, CFG);
    assert.equal(r.patch.stage, 'EXPIRED');
  });
  test(`lifecycle ${dir}: replay is idempotent (events recorded once)`, () => {
    const s = mkSetup(dir);
    const cs = f([cdl(0, 103, 104, 99.9, 101), cdl(1, 101, 111, 103, 110)]);
    const first = ev(s, cs);
    const again = ev({ ...s, ...first.patch, eventKeys: first.events.map((e) => e.stage) }, cs);
    assert.equal(again.events.length, 0);
    assert.equal(again.patch.stage, first.patch.stage);
  });
}

test('lifecycle: pre-entry invalidation by a 4H close beyond A, and expiry', () => {
  const s = { ...mkSetup('LONG'), entry: null, stage: 'C_ZONE_REACHED', maxStage: 'C_ZONE_REACHED' };
  const c4 = [{ time: T, open: 60, high: 61, low: 49, close: 49.5, volume: 1 }];
  const r = evaluateSetup(s, { c4h: c4 }, T + 14400, CFG);
  assert.equal(r.patch.stage, 'INVALIDATED');
  assert.match(r.patch.invalidation.reason, /beyond A/);
  const ok = evaluateSetup(s, { c4h: [{ ...c4[0], close: 70, low: 49 }] }, T + 14400, CFG);
  assert.deepEqual(ok.patch, undefined === ok.patch ? undefined : ok.patch);
  assert.equal(Object.keys(ok.patch).length, 0, 'a wick below A does not invalidate (close rule)');
  const exp = evaluateSetup(s, { c4h: [] }, T + (CFG.setupExpiryHours + 1) * 3600, CFG);
  assert.equal(exp.patch.stage, 'EXPIRED');
});

test('lifecycle: terminal setups are never re-opened; tracking tf covers the whole age', () => {
  const closed = { ...mkSetup(), stage: 'STOP_LOSS_HIT', status: 'CLOSED' };
  assert.deepEqual(ev(closed, [cdl(0, 100, 200, 1, 150)]), { patch: {}, events: [] });
  assert.equal(trackingTf(3600), '5m');
  assert.equal(trackingTf(10 * 86400), '15m');
  assert.equal(trackingTf(40 * 86400), '1h');
  assert.equal(bucketOf({ status: 'OPEN', stage: 'ENTRY_READY' }), 'entry_ready');
  assert.equal(bucketOf({ status: 'OPEN', stage: 'TP1_HIT' }), 'ongoing');
  assert.equal(bucketOf({ status: 'CLOSED', stage: 'INVALIDATED' }), 'invalidated');
  assert.equal(bucketOf({ status: 'CLOSED', stage: 'D_TARGET_REACHED' }), 'completed');
});

// ── persistence, history, duplicates ───────────────────────────────────────────────────────────
test('persistence: same structure scanned again = ONE setup; history keeps the original analysis', async () => {
  const sym = 'DUPEUSDT';
  const at = async (upTo) => {
    const c5 = buildMaster(longWaypoints({ upToStage: upTo }));
    const r = await analyzeSymbol({ symbol: sym, getCandles: makeGetCandles(c5), cfg: CFG, nowSec: nowOf(c5) });
    return r.results.find((x) => x.dir === 'LONG').analysis;
  };
  const a1 = await at('czone');
  const u1 = await upsertFromAnalysis({ analysis: a1, price: 260, cfg: CFG, runId: 'r1' });
  assert.equal(u1.action, 'created');
  const u2 = await upsertFromAnalysis({ analysis: a1, price: 261, cfg: CFG, runId: 'r2' });
  assert.notEqual(u2.action, 'created');
  assert.equal((await store.listSetups({ symbol: sym })).length, 1);
  assert.equal((await store.listEvents(u1.id)).filter((e) => e.stage === 'C_ZONE_REACHED').length, 1);

  const a2 = await at('entry'); // same market, later → same A swing → same setup id
  assert.equal(skSetupId(sym, 'LONG', a2.h4.A.time), u1.id);
  const u3 = await upsertFromAnalysis({ analysis: a2, price: 282, cfg: CFG, runId: 'r3' });
  assert.equal(u3.action, 'advanced');
  assert.equal((await store.listSetups({ symbol: sym })).length, 1);
  const cur = await store.getSetup(u1.id);
  assert.equal(cur.stage, 'ENTRY_READY');
  assert.equal(cur.entry.locked, true);
  const orig = await store.getSnapshot(u1.id, 'C_ZONE_REACHED'); // the original analysis is still there, unchanged
  assert.equal(orig.analysis.stage, 'C_ZONE_REACHED');
  assert.equal(orig.analysis.entry, null);
  assert.equal(orig.analysis.annotations.some((x) => x.group === 'entry'), false);
  assert.deepEqual((await store.listSnapshots(u1.id)).map((s) => s.stage), ['C_ZONE_REACHED', 'ENTRY_READY']);

  // a locked entry is never re-priced by a later scan
  const lockedEntry = { ...cur.entry };
  await upsertFromAnalysis({ analysis: { ...a2, entry: { ...a2.entry, price: 1 } }, price: 283, cfg: CFG, runId: 'r4' });
  assert.deepEqual((await store.getSetup(u1.id)).entry, lockedEntry);

  // closed setups stay in history and are not re-created
  await store.saveSetup({ ...(await store.getSetup(u1.id)), status: 'CLOSED', stage: 'STOP_LOSS_HIT', closedAt: new Date().toISOString() });
  const u4 = await upsertFromAnalysis({ analysis: a2, price: 270, cfg: CFG, runId: 'r5' });
  assert.equal(u4.action, 'ignored');
  assert.equal((await store.listSetups({ symbol: sym })).length, 1);
  assert.equal((await store.getSetup(u1.id)).stage, 'STOP_LOSS_HIT');
});

test('persistence: a different structure (different A) is a different setup; filters work', async () => {
  const sym = 'MULTIUSDT';
  const base = (await run('czone')).long.analysis;
  const other = JSON.parse(JSON.stringify(base));
  other.symbol = sym;
  const second = JSON.parse(JSON.stringify(other));
  second.h4.A.time += 4 * 14400;
  const s = normalizeSkConfig({ htfAlignment: 'off' });
  const a = await upsertFromAnalysis({ analysis: other, price: 1, cfg: s });
  const b = await upsertFromAnalysis({ analysis: second, price: 1, cfg: s });
  assert.notEqual(a.id, b.id);
  const rows = await store.listSetups({ symbol: 'MULTI' });
  assert.equal(rows.length, 2);
  assert.equal((await store.listSetups({ symbol: 'MULTI', dir: 'SHORT' })).length, 0);
  assert.equal((await store.listSetups({ symbol: 'MULTI', minScore: 99 })).length, 0);
  assert.equal((await store.listSetups({ symbol: 'MULTI', stage: 'C_ZONE_REACHED' })).length, 2);
  assert.equal((await store.listSetups({ symbol: 'MULTI', from: new Date(Date.now() + 86400_000).toISOString() })).length, 0);
});

test('persistence: stages below the storage threshold are not stored', async () => {
  const sym = 'SWINGUSDT';
  const a = (await run('swing')).long.analysis;
  a.symbol = sym;
  assert.equal((await upsertFromAnalysis({ analysis: a, price: 1, cfg: CFG })).action, 'below-threshold');
  assert.equal((await store.listSetups({ symbol: sym })).length, 0);
});

// ── universe: ALL coins / Top N ────────────────────────────────────────────────────────────────
const mkUni = (n) => {
  const eligible = Array.from({ length: n }, (_, i) => `C${String(i).padStart(3, '0')}USDT`);
  const tickers = Object.fromEntries(eligible.map((s, i) => [s, { price: 10, volume: 1000 + i, change: (i % 21) - 10, high: 10 + (i % 7), low: 10 }]));
  return { eligible, tickers };
};
test('universe: ALL COINS returns every eligible symbol (no hidden cap)', () => {
  const { eligible, tickers } = mkUni(537);
  const all = selectUniverse({ mode: 'all', eligible, tickers });
  assert.equal(all.length, 537);
  assert.equal(new Set(all).size, 537);
  assert.equal(all[0], 'C536USDT'); // highest volume first
  const noTicker = selectUniverse({ mode: 'all', eligible: [...eligible, 'NEWUSDT'], tickers });
  assert.equal(noTicker.length, 538, 'a coin without a ticker is still scanned');
});
test('universe: Top N is exact for every preset and custom N, by every ranking method', () => {
  const { eligible, tickers } = mkUni(300);
  for (const n of [10, 20, 30, 50, 100, 7, 250]) assert.equal(selectUniverse({ mode: 'top', topN: n, eligible, tickers }).length, n);
  assert.equal(selectUniverse({ mode: 'top', topN: 1000, eligible, tickers }).length, 300);
  const g = selectUniverse({ mode: 'top', topN: 5, ranking: 'gainers', eligible, tickers });
  assert.ok(g.every((s) => tickers[s].change === 10));
  const l = selectUniverse({ mode: 'top', topN: 5, ranking: 'losers', eligible, tickers });
  assert.ok(l.every((s) => tickers[s].change === -10));
  const v = selectUniverse({ mode: 'top', topN: 5, ranking: 'volatility', eligible, tickers });
  assert.ok(v.every((s) => tickers[s].high - tickers[s].low === 6));
  assert.deepEqual(selectUniverse({ mode: 'top', topN: 3, ranking: 'volume', eligible, tickers }), ['C299USDT', 'C298USDT', 'C297USDT']);
  assert.deepEqual(selectUniverse({ mode: 'all', symbols: ['c001usdt', 'NOPEUSDT', 'C002USDT'], eligible, tickers }), ['C001USDT', 'C002USDT']);
});

// ── scanning: progress, resume, failures ───────────────────────────────────────────────────────
function makeDeps({ n = 24, setupSyms = [], failSyms = [], banAt = null } = {}) {
  const long = buildMaster(longWaypoints({ upToStage: 'entry' }));
  const flat = buildMaster([{ to: 100, bars: 4000 }, { to: 100.4, bars: 400 }], 100);
  const gc = { long: makeGetCandles(long), flat: makeGetCandles(flat) };
  const eligible = Array.from({ length: n }, (_, i) => `S${String(i).padStart(2, '0')}USDT`);
  const calls = { n: 0, bySymbol: {} };
  const state = { banAt };
  return {
    state,
    calls,
    eligible,
    loadExchangeInfo: async () => eligible,
    loadTickers: async () => Object.fromEntries(eligible.map((s, i) => [s, { price: 280, volume: 1e6 + i, change: 0, high: 1, low: 1 }])),
    getKlines: async (symbol, tf, limit) => {
      calls.n++;
      calls.bySymbol[symbol] = (calls.bySymbol[symbol] || 0) + 1;
      if (state.banAt != null && calls.n >= state.banAt) {
        const e = new Error('HTTP 418: Binance banned this IP');
        e.banned = true;
        throw e;
      }
      if (failSyms.includes(symbol)) throw new Error('boom');
      return (setupSyms.includes(symbol) ? gc.long : gc.flat)(tf, limit);
    },
  };
}
const SCFG = normalizeSkConfig({ htfAlignment: 'off', batchSize: 5, maxConcurrent: 3, retryCount: 1, retryDelayMs: 0 });

test('scan: Top N run analyses EVERY selected symbol, persists progress and completes', async () => {
  const deps = makeDeps({ n: 30, setupSyms: ['S29USDT', 'S28USDT'] });
  const run1 = await startRun({ cfg: SCFG, deps, mode: 'top', topN: 12, ranking: 'volume' });
  assert.equal(run1.total, 12);
  assert.equal(run1.status, 'running');
  assert.deepEqual(run1.symbols.slice(0, 2), ['S29USDT', 'S28USDT']);
  const out = await runChunk({ runId: run1.id, deps, cfg: SCFG, budgetMs: 120_000, force: true });
  assert.equal(out.run.status, 'completed');
  assert.equal(out.run.analyzed, 12);
  assert.equal(out.run.ok, 12);
  assert.equal(out.run.failed, 0);
  assert.equal(out.run.setupsFound, 2);
  for (const sym of run1.symbols) assert.ok(deps.calls.bySymbol[sym] > 0, `${sym} was analysed`);
  assert.ok(!Object.keys(deps.calls.bySymbol).some((x) => /^S\d\d/.test(x) && !run1.symbols.includes(x)), 'no symbol outside the selected Top N was scanned');
  const saved = await store.getRun(run1.id);
  assert.equal(saved.analyzed, 12);
  assert.ok(saved.finishedAt);
  assert.equal((await store.listSetups({ symbol: 'S29' })).length, 1);
});

test('scan: ALL COINS run covers the full eligible list', async () => {
  const deps = makeDeps({ n: 41 });
  const run1 = await startRun({ cfg: SCFG, deps, mode: 'all' });
  assert.equal(run1.total, 41);
  const out = await runChunk({ runId: run1.id, deps, cfg: SCFG, budgetMs: 120_000, force: true });
  assert.equal(out.run.status, 'completed');
  assert.equal(out.run.analyzed, 41);
  assert.equal(Object.keys(deps.calls.bySymbol).filter((x) => /^S\d\d/.test(x)).length, 41);
});

test('scan: a run is NOT completed while symbols remain (time budget exhausted)', async () => {
  const deps = makeDeps({ n: 15 });
  const run1 = await startRun({ cfg: SCFG, deps, mode: 'top', topN: 15 });
  const part = await runChunk({ runId: run1.id, deps, cfg: SCFG, budgetMs: 5_000, force: true }); // < 6 s margin → no batch fits
  assert.equal(part.run.status, 'running');
  assert.ok(part.run.analyzed < part.run.total);
  const fin = await runChunk({ runId: run1.id, deps, cfg: SCFG, budgetMs: 120_000, force: true });
  assert.equal(fin.run.status, 'completed');
  assert.equal(fin.run.analyzed, 15);
});

test('scan: rate-limit / ban pauses the run and resume finishes it without duplicates', async () => {
  const deps = makeDeps({ n: 20, setupSyms: ['S19USDT', 'S18USDT', 'S10USDT'] });
  deps.state.banAt = 60; // the exchange starts refusing in the middle of the scan
  const run1 = await startRun({ cfg: SCFG, deps, mode: 'top', topN: 20 });
  const first = await runChunk({ runId: run1.id, deps, cfg: SCFG, budgetMs: 120_000, force: true });
  assert.equal(first.run.status, 'paused');
  assert.match(first.run.pausedReason, /banned/);
  assert.ok(first.run.analyzed > 0 && first.run.analyzed < 20);
  const offsetAtPause = first.run.offset;
  assert.equal(offsetAtPause, first.run.analyzed, 'the failed batch is not counted as analysed');
  // while paused nothing moves
  const idle = await runChunk({ runId: run1.id, deps, cfg: SCFG, budgetMs: 120_000, force: true });
  assert.equal(idle.skipped, 'run is paused');
  // the ban ends → resume
  deps.state.banAt = null;
  await setRunStatus(run1.id, 'running');
  const done = await runChunk({ runId: run1.id, deps, cfg: SCFG, budgetMs: 120_000, force: true });
  assert.equal(done.run.status, 'completed');
  assert.equal(done.run.analyzed, 20);
  assert.equal(done.run.ok + done.run.failed, 20);
  for (const s of ['S19', 'S18', 'S10']) assert.equal((await store.listSetups({ symbol: s })).length, 1, `${s}: exactly one setup`);
});

test('scan: stop keeps the saved progress, a failing coin is reported (not silently skipped)', async () => {
  const deps = makeDeps({ n: 10, failSyms: ['S05USDT'] });
  const run1 = await startRun({ cfg: SCFG, deps, mode: 'all' });
  await setRunStatus(run1.id, 'stopped', 'stopped by admin');
  const stopped = await runChunk({ runId: run1.id, deps, cfg: SCFG, budgetMs: 120_000, force: true });
  assert.equal(stopped.skipped, 'run is stopped');
  assert.equal((await store.getRun(run1.id)).analyzed, 0);
  await setRunStatus(run1.id, 'running');
  const out = await runChunk({ runId: run1.id, deps, cfg: SCFG, budgetMs: 120_000, force: true });
  assert.equal(out.run.status, 'completed');
  assert.equal(out.run.analyzed, 10);
  assert.equal(out.run.failed, 1);
  assert.equal(out.run.ok, 9);
  assert.equal(out.run.failedSymbols[0].symbol, 'S05USDT');
});

test('scan: scanSymbol returns per-direction reasons and stores nothing for a market without a setup', async () => {
  const deps = makeDeps({ n: 3 });
  const r = await scanSymbol({ symbol: 'S00USDT', deps, cfg: SCFG, runId: 'x' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.stored, []);
  assert.equal(r.results.length, 2);
});

test('tracker: open setups are replayed with their locked levels and closed in history', async () => {
  const sym = 'TRACKUSDT';
  const c5 = buildMaster(longWaypoints({ upToStage: 'entry' }));
  const a = (await analyzeSymbol({ symbol: sym, getCandles: makeGetCandles(c5), cfg: CFG, nowSec: nowOf(c5) })).results.find((r) => r.dir === 'LONG').analysis;
  const u = await upsertFromAnalysis({ analysis: a, price: 282, cfg: CFG });
  // the market then dips into the entry, runs through TP1/TP2 and finally stops out after TP2
  const e = a.entry;
  const t0 = e.armedAt;
  const after = [
    { time: t0, open: 282, high: 283, low: e.price - 0.01, close: e.price + 1, volume: 1 },
    { time: t0 + 300, open: e.price + 1, high: e.tp1 + 0.5, low: e.price + 0.5, close: e.tp1, volume: 1 },
    { time: t0 + 600, open: e.tp1, high: e.tp2 + 0.5, low: e.tp1 - 1, close: e.tp2, volume: 1 },
    { time: t0 + 900, open: e.tp2, high: e.tp2 + 0.2, low: e.sl - 1, close: e.sl, volume: 1 },
  ];
  const deps = { getKlines: async () => after };
  const out = await trackOpenSetups({ deps, cfg: CFG, nowSec: t0 + 3600 });
  assert.ok(out.tracked >= 1);
  const s = await store.getSetup(u.id);
  assert.equal(s.status, 'CLOSED');
  assert.equal(s.outcome, 'TP2_THEN_SL');
  assert.equal(s.stage, 'TP2_HIT');
  assert.deepEqual(s.entry, { ...e, locked: true }, 'the locked trade plan never changed');
  assert.ok(s.analysis.annotations.length > 0, 'the original chart analysis is still stored');
  const stages = (await store.listEvents(u.id)).map((x) => x.stage);
  for (const st of ['C_ZONE_REACHED', 'ENTRY_READY', 'ENTRY_ONGOING', 'TP1_HIT', 'TP2_HIT', 'STOP_LOSS_HIT']) assert.ok(stages.includes(st), st);
  // history keeps it
  assert.equal((await store.listSetups({ symbol: 'TRACK' })).length, 1);
  assert.equal(bucketOf(s), 'completed');
});

test('mirror helper is an involution', () => {
  const cs = aggregate(buildMaster([{ to: 120, bars: 300 }], 100), '15m');
  assert.deepEqual(mirrorCandles(mirrorCandles(cs)).map((c) => c.high), cs.map((c) => c.high));
  assert.equal(mirrorMaster(buildMaster([{ to: 120, bars: 30 }], 100)).length, 30);
});

// ── normal users: capped scans, own runs ───────────────────────────────────────────────────────
test('user scan: admins unlimited, users capped by userScanMax, 0 disables, 600+ allows ALL', () => {
  const cfg = normalizeSkConfig({ userScanMax: 50, topN: 20 });
  assert.deepEqual(resolveScanRequest({ cfg, isAdmin: true, body: { mode: 'all' } }), { ok: true, mode: 'all', topN: null });
  assert.equal(resolveScanRequest({ cfg, isAdmin: true, body: { mode: 'top', topN: 300 } }).topN, 300);
  const u = resolveScanRequest({ cfg, isAdmin: false, body: { mode: 'top', topN: 300 } });
  assert.equal(u.topN, 50);
  assert.match(u.notice, /Top 50/);
  const all = resolveScanRequest({ cfg, isAdmin: false, body: { mode: 'all' } });
  assert.equal(all.mode, 'top');
  assert.equal(all.topN, 50);
  assert.equal(resolveScanRequest({ cfg, isAdmin: false, body: { topN: 30 } }).notice, undefined);
  const picked = resolveScanRequest({ cfg, isAdmin: false, body: { symbols: ['ltc', 'btcusdt'] } });
  assert.deepEqual(picked.symbols, ['LTCUSDT', 'BTCUSDT']);
  assert.equal(resolveScanRequest({ cfg: normalizeSkConfig({ userScanMax: 3 }), isAdmin: false, body: { symbols: ['a', 'b', 'c', 'd', 'e'] } }).symbols.length, 3);
  assert.equal(resolveScanRequest({ cfg: normalizeSkConfig({ userScanMax: 0 }), isAdmin: false, body: {} }).ok, false);
  assert.equal(resolveScanRequest({ cfg: normalizeSkConfig({ userScanMax: 650 }), isAdmin: false, body: { mode: 'all' } }).mode, 'all');
});

test('user scan: every user has their own run (progress is not shared or overwritten)', async () => {
  const deps = makeDeps({ n: 12 });
  const a = await startRun({ cfg: SCFG, deps, mode: 'top', topN: 6, owner: 'user-a' });
  const b = await startRun({ cfg: SCFG, deps, mode: 'top', topN: 9, owner: 'user-b' });
  assert.equal((await store.getLatestRun('user-a')).id, a.id);
  assert.equal((await store.getLatestRun('user-b')).id, b.id);
  assert.equal(await store.getLatestRun('nobody'), null);
  const [ra, rb] = await Promise.all([
    runChunk({ runId: a.id, deps, cfg: SCFG, budgetMs: 120_000, force: true }),
    runChunk({ runId: b.id, deps, cfg: SCFG, budgetMs: 120_000, force: true }),
  ]);
  assert.equal(ra.run.status, 'completed');
  assert.equal(ra.run.analyzed, 6);
  assert.equal(rb.run.status, 'completed');
  assert.equal(rb.run.analyzed, 9);
});
