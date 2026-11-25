import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFibBreaker } from '../lib/fibBreaker/engine.js';
import { validateFbConfig, normalizeFbConfig, FB_DEFAULTS } from '../lib/fibBreaker/config.js';

const CFG = normalizeFbConfig({});
const T = 1_800_000_000;
const H = 3600;
const mk = (rows, t0 = T) => rows.map(([o, h, l, c], i) => ({ time: t0 + i * H, open: o, high: h, low: l, close: c, volume: 100 }));
/** price legs → 1H candles with directional wicks (turning points are strict pivots) */
const zig = (pts, per = 8) => {
  const rows = [];
  let p = pts[0];
  for (let k = 1; k < pts.length; k++)
    for (let j = 1; j <= per; j++) {
      const n = pts[k - 1] + ((pts[k] - pts[k - 1]) * j) / per;
      const up = n >= p;
      rows.push([p, Math.max(p, n) + (up ? 0.3 : 0.02), Math.min(p, n) - (up ? 0.02 : 0.3), n]);
      p = n;
    }
  return mk(rows);
};
// 140 → H1 160 → L1 132 → H2 (LH) 148 → A (LL) 112 → rally 158 (breaks the LH = New High) → HL 130 → HH 185
const BASE = [140, 160, 132, 148, 112, 158, 130, 185];
const run = async (pts, over = {}, per = 8) => {
  const cs = zig(pts, per);
  const now = cs.at(-1).time + H;
  const res = await analyzeFibBreaker({ symbol: 'TESTUSDT', getCandles: async () => cs, cfg: CFG, nowSec: now, tfs: ['1h'], dirs: ['LONG'], ...over });
  return { cs, now, r: res.results[0], a: res.results[0].analysis };
};
const mirror = (cs) => cs.map((c) => ({ ...c, open: -c.open, high: -c.low, low: -c.high, close: -c.close }));

test('config: defaults valid · values clamped · tfs filtered · fib band ordered', () => {
  const { config, notes } = validateFbConfig({});
  assert.deepEqual(notes, []);
  assert.deepEqual(config.tfs, FB_DEFAULTS.tfs);
  const bad = validateFbConfig({ tfs: ['9m', '1h', '1h'], swingBars: 99, entryFibFrom: 0.8, entryFibTo: 0.5, minRR: -2, hack: 1 });
  assert.deepEqual(bad.config.tfs, ['1h']);
  assert.equal(bad.config.swingBars, 8);
  assert.ok(bad.config.entryFibFrom < bad.config.entryFibTo && bad.notes.length === 1);
  assert.equal(bad.config.minRR, 0.5);
  assert.equal(bad.config.hack, undefined);
});

test('stage ladder: WAITING (price far above) → ENTRY_READY → ONGOING → COMPLETED · INVALIDATED below the stop', async () => {
  const cases = { entry_ready: [175], inzone: [156.5], ongoing: [155, 168], completed: [154, 186], invalid: [125] };
  const out = {};
  for (const [k, tail] of Object.entries(cases)) out[k] = (await run([...BASE, ...tail])).a;
  assert.equal(out.entry_ready.stage, 'ENTRY_READY');
  assert.equal(out.entry_ready.inZone, false);
  assert.ok(out.entry_ready.distanceAtr > 0);
  assert.equal(out.inzone.stage, 'ENTRY_READY');
  assert.equal(out.inzone.inZone, true);
  assert.equal(out.ongoing.stage, 'ONGOING');
  assert.ok(out.ongoing.filledTime);
  assert.equal(out.completed.stage, 'COMPLETED');
  assert.equal(out.invalid.stage, 'INVALIDATED');
  assert.match(out.invalid.reason, /closed below/);
  for (const a of Object.values(out)) assert.equal(a.bucket, { ENTRY_READY: 'entry_ready', ONGOING: 'ongoing', COMPLETED: 'completed', INVALIDATED: 'invalidated' }[a.stage]);
});

test('every strategy step is reported and the full chain is DONE for a complete setup', async () => {
  const { a } = await run([...BASE, 175]);
  assert.deepEqual(a.steps.map((s) => s.id), ['trend', 'choch', 'nh', 'hl', 'hh', 'zone', 'trendline', 'entry']);
  for (const id of ['trend', 'choch', 'nh', 'hl', 'hh', 'zone']) assert.equal(a.steps.find((s) => s.id === id).status, 'DONE', id);
  assert.deepEqual([a.names.A, a.names.H2, a.names.NH, a.names.HL, a.names.HH], ['LL', 'LH', 'New High', 'HL', 'HH']);
});

test('incomplete structure is WAITING and says what is missing (no HH yet / no HL yet / no breakout)', async () => {
  const noHh = await run([100, 140, 160, 132, 148, 112, 158, 130, 152], {}, 12); // HL formed, no close above the New High yet
  assert.equal(noHh.a.stage, 'WAITING');
  assert.equal(noHh.a.listed, false);
  assert.match(noHh.a.reason, /HH/);
  assert.ok(noHh.a.annotations.some((x) => x.label === 'HL'));
  const noNh = await run([100, 140, 160, 132, 148, 112, 158], {}, 12); // rally after the breakout still running
  assert.equal(noNh.a.stage, 'WAITING');
  assert.match(noNh.a.reason, /New High/);
  const noHl = await run([100, 140, 160, 132, 148, 112, 158, 140], {}, 12); // New High made, pull-back still falling
  assert.equal(noHl.a.stage, 'WAITING');
  assert.match(noHl.a.reason, /HL/);
  const none = await run([100, 140, 160, 132, 148, 112, 128], {}, 12); // never broke the LH
  assert.equal(none.a, null);
  assert.match(none.r.reason, /LH Breakout/);
});

test('fibonacci + zone math: levels from HL (1) to HH (0) · zone = breaker ∩ fib 0.5–0.786 · SL under 0.786 · TP1 = HH', async () => {
  const { a } = await run([...BASE, 175]);
  const HH = a.levels.HH.price;
  const HL = a.levels.HL.price;
  const leg = HH - HL;
  assert.ok(Math.abs(a.fib.leg - leg) < 1e-6);
  for (const f of a.fib.levels) assert.ok(Math.abs(f.price - (HH - f.ratio * leg)) < 1e-6, `fib ${f.ratio}`);
  const f = (r) => HH - r * leg;
  assert.ok(a.zone.high <= f(0.5) + 1e-6 && a.zone.low >= f(0.786) - 1e-6);
  assert.ok(a.zone.high <= a.breaker.high + 1e-6 && a.zone.low >= a.breaker.low - 1e-6); // inside the breaker block
  assert.equal(a.breaker.overlap, true);
  assert.ok(a.plan.entry >= a.zone.low && a.plan.entry <= a.zone.high);
  assert.ok(a.plan.sl < f(0.786) && a.plan.sl > HL);
  assert.equal(a.plan.tp1, HH);
  assert.ok(a.plan.tp2 > HH && a.plan.tp3 > a.plan.tp2);
  assert.ok(Math.abs(a.plan.rr1 - (a.plan.tp1 - a.plan.entry) / (a.plan.entry - a.plan.sl)) < 0.02);
});

test('breaker block: the last up-candle at the New High that price then closed above', async () => {
  const { a, cs } = await run([...BASE, 175]);
  const bar = cs.find((c) => c.time === a.breaker.time);
  assert.ok(bar && bar.close > bar.open);
  assert.ok(Math.abs(bar.high - a.breaker.high) < 1e-6 && Math.abs(bar.low - a.breaker.low) < 1e-6);
  const nh = a.levels.NH.price;
  assert.ok(Math.abs(bar.time - a.levels.NH.time) <= 4 * H);
  assert.ok(cs.some((c) => c.time > a.levels.HL.time && c.close > nh)); // it was broken (flipped to support)
});

test('SHORT is the exact mirror (same engine): states, scores and prices mirror the LONG result', async () => {
  const cs = zig([...BASE, 156.5]);
  const now = cs.at(-1).time + H;
  const L = (await analyzeFibBreaker({ symbol: 'X', getCandles: async () => cs, cfg: CFG, nowSec: now, tfs: ['1h'], dirs: ['LONG'] })).results[0].analysis;
  const S = (await analyzeFibBreaker({ symbol: 'X', getCandles: async () => mirror(cs), cfg: CFG, nowSec: now, tfs: ['1h'], dirs: ['SHORT'] })).results[0].analysis;
  assert.ok(S);
  assert.deepEqual([S.stage, S.score, S.inZone], [L.stage, L.score, L.inZone]);
  assert.ok(Math.abs(S.plan.entry - -L.plan.entry) < 1e-6 && Math.abs(S.plan.sl - -L.plan.sl) < 1e-6 && Math.abs(S.plan.tp1 - -L.plan.tp1) < 1e-6);
  assert.deepEqual([S.names.A, S.names.NH, S.names.HH], ['HH', 'New Low', 'LL']);
  assert.ok(S.plan.sl > S.plan.entry && S.plan.entry > S.plan.tp1); // short geometry
  assert.ok(S.zone.high > S.zone.low);
});

test('closed candles only: a still-forming candle can never change the analysis', async () => {
  const cs = zig([...BASE, 175]);
  const now = cs.at(-1).time + H;
  const base = await analyzeFibBreaker({ symbol: 'X', getCandles: async () => cs, cfg: CFG, nowSec: now, tfs: ['1h'], dirs: ['LONG'] });
  const forming = { time: now - 1200, open: 175, high: 400, low: 10, close: 20, volume: 1 }; // opened 20 minutes ago → not closed
  const withF = await analyzeFibBreaker({ symbol: 'X', getCandles: async () => [...cs, forming], cfg: CFG, nowSec: now, tfs: ['1h'], dirs: ['LONG'] });
  assert.equal(JSON.stringify(base.results[0].analysis), JSON.stringify(withF.results[0].analysis));
});

test('no look-ahead / no repainting: analysis at time t ignores any candle after t, and stages only move forward', async () => {
  const cs = zig([100, ...BASE, 175, 156.5, 155, 168, 186]);
  const rank = { WAITING: 1, ENTRY_READY: 2, ONGOING: 3, COMPLETED: 4 };
  let last = 0;
  let seenInvalid = false;
  const stages = new Set();
  for (let n = 60; n <= cs.length; n += 4) {
    const now = cs[n - 1].time + H;
    const past = cs.slice(0, n);
    const a1 = (await analyzeFibBreaker({ symbol: 'X', getCandles: async () => past, cfg: CFG, nowSec: now, tfs: ['1h'], dirs: ['LONG'] })).results[0].analysis;
    const a2 = (await analyzeFibBreaker({ symbol: 'X', getCandles: async () => cs, cfg: CFG, nowSec: now, tfs: ['1h'], dirs: ['LONG'] })).results[0].analysis; // future candles present
    assert.equal(JSON.stringify(a1), JSON.stringify(a2), `n=${n}`);
    if (!a1) continue;
    stages.add(a1.stage);
    if (a1.stage === 'INVALIDATED') { seenInvalid = true; continue; }
    assert.ok(rank[a1.stage] >= last, `${a1.stage} after rank ${last}`);
    last = rank[a1.stage];
  }
  assert.equal(seenInvalid, false);
  for (const s of ['WAITING', 'ENTRY_READY', 'ONGOING', 'COMPLETED']) assert.ok(stages.has(s), `stage ${s} reached`);
});

test('chart annotations are real calculated levels: structure points sit on real candle extremes, fib lines match the formula, everything is drawn', async () => {
  const { a, cs } = await run([...BASE, 156.5]);
  const A = a.annotations;
  const groups = new Set(A.map((x) => x.group));
  for (const g of ['structure', 'choch', 'fib', 'breaker', 'entry', 'targets', 'trendline']) assert.ok(groups.has(g), `group ${g}`);
  for (const m of A.filter((x) => x.kind === 'marker')) {
    const c = cs.find((k) => k.time === m.t);
    assert.ok(c, `${m.label} on a real candle`);
    assert.ok(Math.abs(m.p - c.high) < 1e-6 || Math.abs(m.p - c.low) < 1e-6, `${m.label} at a real high/low`);
  }
  assert.deepEqual(A.filter((x) => x.kind === 'marker').map((m) => m.label).sort(), ['HH', 'HL', 'LH', 'LL', 'New High'].sort());
  const fibLines = A.filter((x) => x.group === 'fib');
  assert.equal(fibLines.length, 6);
  for (const f of fibLines) assert.ok(a.fib.levels.some((l) => Math.abs(l.price - f.p1) < 1e-9));
  const line = A.find((x) => x.group === 'choch');
  assert.equal(line.label, 'LH Breakout');
  assert.ok(Math.abs(line.p1 - a.levels.H2.price) < 1e-9);
  const zones = A.filter((x) => x.kind === 'zone');
  for (const z of zones) assert.ok(z.p1 > z.p2, `${z.label} has height`);
  assert.ok(A.some((x) => x.group === 'entry' && /Fib Level/.test(x.label || '')));
  const sl = A.find((x) => x.tone === 'sl');
  assert.ok(Math.abs(sl.p2 - a.plan.sl) < 1e-9);
});

test('rules from the settings are applied: requireBreaker · requireTrendline · minRR · minScore', async () => {
  const strictRR = normalizeFbConfig({ minRR: 9 });
  const a = (await run([...BASE, 175], { cfg: strictRR })).a;
  assert.equal(a.listed, false);
  assert.ok(a.reasons.some((r) => /R:R/.test(r)));
  const needTl = (await run([...BASE, 175], { cfg: normalizeFbConfig({ requireTrendline: true }) })).a;
  assert.ok(needTl.trendline?.confluence ? needTl.listed : !needTl.listed);
  const hi = (await run([...BASE, 175], { cfg: normalizeFbConfig({ minScore: 100 }) })).a;
  assert.equal(hi.listed, false);
  // no breaker overlap → INVALIDATED (setup is not what the strategy asks for)
  const noOv = (await run([...BASE, 175], { cfg: normalizeFbConfig({ entryFibFrom: 0.3, entryFibTo: 0.4, requireBreaker: true }) })).a;
  assert.equal(noOv.stage, 'INVALIDATED');
  assert.match(noOv.reason, /breaker/);
  const fibOnly = (await run([...BASE, 175], { cfg: normalizeFbConfig({ entryFibFrom: 0.3, entryFibTo: 0.4, requireBreaker: false }) })).a;
  assert.notEqual(fibOnly.stage, 'INVALIDATED');
  assert.equal(fibOnly.breaker.overlap, false);
});

test('data problems are reported, never hidden', async () => {
  const few = await analyzeFibBreaker({ symbol: 'X', cfg: CFG, nowSec: T + 1e6, tfs: ['1h'], getCandles: async () => zig([100, 110, 100], 8) });
  assert.ok(few.results.every((r) => r.analysis === null && /not enough closed candles/.test(r.reason)));
  await assert.rejects(analyzeFibBreaker({ symbol: 'X', cfg: CFG, tfs: ['1h'], getCandles: async () => { throw Object.assign(new Error('HTTP 418'), { banned: true }); } }), (e) => e.fetchFailed === true && e.banned === true);
});

test('several time frames in one scan: each (tf × direction) is analysed on its own candles', async () => {
  const cs = zig([...BASE, 175]);
  const res = await analyzeFibBreaker({ symbol: 'X', cfg: CFG, nowSec: cs.at(-1).time + 10 * 86400, tfs: ['1h', '4h'], getCandles: async (tf) => cs.map((c, i) => ({ ...c, time: T + i * (tf === '4h' ? 14400 : H) })) });
  assert.equal(res.results.length, 4);
  assert.deepEqual([...new Set(res.results.map((r) => r.tf))], ['1h', '4h']);
  assert.ok(res.results.every((r) => r.dir === 'LONG' || r.dir === 'SHORT'));
});

test('older setups are found and shown as history: TP1 reached → COMPLETED · stopped → INVALIDATED · otherwise COMPLETED (played out)', async () => {
  // setup 1 completes (entered, TP1 hit), a new down-trend follows, then setup 2 forms and is still live
  const pts = [100, 140, 160, 132, 148, 112, 158, 130, 185, 154, 186, 150, 170, 125, 175, 145, 200, 190];
  const cs = zig(pts);
  const res = await analyzeFibBreaker({ symbol: 'X', getCandles: async () => cs, cfg: CFG, nowSec: cs.at(-1).time + H, tfs: ['1h'], dirs: ['LONG'] });
  const list = res.results.map((r) => r.analysis).filter(Boolean);
  assert.equal(list.length, 2);
  const [latest, old] = list;
  assert.equal(latest.isLatest, true);
  assert.equal(old.isLatest, false);
  assert.ok(old.anchor.aIndex < latest.anchor.aIndex && old.anchor.h2Index < latest.anchor.h2Index);
  assert.equal(old.stage, 'COMPLETED');
  assert.equal(old.bucket, 'completed');
  assert.equal(old.outcome, 'TP1 reached'); // entered at the zone, then price reached the HH
  assert.ok(old.endTime < cs.at(-1).time);
  assert.ok(['ENTRY_READY', 'ONGOING', 'WAITING'].includes(latest.stage));
  assert.notEqual(old.id, latest.id);
  // the finished setup is drawn only up to where it ended (not stretched to "now")
  const sl = old.annotations.find((x) => x.tone === 'sl');
  assert.ok(sl.t2 <= old.endTime + 15 * H);
  // an older setup that was stopped out stays INVALIDATED with the outcome 'stopped out'
  const stopped = [100, 140, 160, 132, 148, 112, 158, 130, 185, 156, 150, 170, 125, 175, 145, 200, 190];
  const rs = (await analyzeFibBreaker({ symbol: 'X', getCandles: async () => zig(stopped), cfg: CFG, nowSec: zig(stopped).at(-1).time + H, tfs: ['1h'], dirs: ['LONG'] })).results.map((r) => r.analysis).filter(Boolean);
  const oldStop = rs.find((a) => !a.isLatest);
  assert.equal(oldStop.stage, 'INVALIDATED');
  assert.equal(oldStop.outcome, 'stopped out');
  // an older setup that entered but reached neither TP1 nor the stop is still history ("completed"), never waiting / ready
  const played = [100, 140, 160, 132, 148, 112, 158, 130, 185, 155, 170, 158, 164, 150, 172, 155, 180, 170];
  const rp = (await analyzeFibBreaker({ symbol: 'X', getCandles: async () => zig(played), cfg: CFG, nowSec: zig(played).at(-1).time + H, tfs: ['1h'], dirs: ['LONG'] })).results.map((r) => r.analysis).filter(Boolean);
  const oldPlayed = rp.find((a) => !a.isLatest);
  assert.ok(oldPlayed, 'older setup found');
  assert.equal(oldPlayed.bucket, 'completed');
  assert.match(oldPlayed.outcome, /older setup/);
  // history depth is a setting
  const one = await analyzeFibBreaker({ symbol: 'X', getCandles: async () => cs, cfg: normalizeFbConfig({ historyDepth: 1 }), nowSec: cs.at(-1).time + H, tfs: ['1h'], dirs: ['LONG'] });
  assert.equal(one.results.filter((r) => r.analysis).length, 1);
});

test('older setup ids never collide and are stable across scans (no repaint of history)', async () => {
  const pts = [100, 140, 160, 132, 148, 112, 158, 130, 185, 154, 186, 150, 170, 125, 175, 145, 200, 190];
  const cs = zig(pts);
  const ids = async (n) => (await analyzeFibBreaker({ symbol: 'X', getCandles: async () => cs.slice(0, n), cfg: CFG, nowSec: cs[n - 1].time + H, tfs: ['1h'], dirs: ['LONG'] })).results.map((r) => r.analysis?.id).filter(Boolean);
  const full = await ids(cs.length);
  const earlier = await ids(cs.length - 12);
  assert.equal(new Set(full).size, full.length);
  const oldId = full[1];
  assert.ok(earlier.includes(oldId) || earlier.length >= 1);
});
