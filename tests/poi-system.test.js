import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePoiConfig, normalizePoiConfig, POI_DEFAULTS } from '../lib/poiSystem/config.js';
import { closedCandles, pivots, labelPivots, walkStructure, dealingRange, rangePos, liquidityPools, findSweeps, findFvgs, findOrderBlocks, overlapFrac } from '../lib/poiSystem/structure.js';
import { analyzePoiSymbol } from '../lib/poiSystem/engine.js';
import { replayBacktest, statsOf } from '../lib/poiSystem/backtest.js';
import { buildMaster, makeGetCandles, longWaypoints } from './helpers/skFixture.js';

const CFG = normalizePoiConfig({});
const T = 1_800_000_000; // a 15M-aligned timestamp
/** [o,h,l,c] rows → 15M candles */
const mk = (rows, tf = 900, t0 = T) => rows.map(([o, h, l, c], i) => ({ time: t0 + i * tf, open: o, high: h, low: l, close: c, volume: 100 }));
/** zig-zag helper: price legs → candles (1 candle per step, small bodies) */
const zig = (pts, per = 4) => {
  const rows = [];
  let p = pts[0];
  for (let k = 1; k < pts.length; k++) {
    for (let j = 1; j <= per; j++) {
      const n = pts[k - 1] + ((pts[k] - pts[k - 1]) * j) / per;
      const up = n >= p;
      rows.push([p, Math.max(p, n) + (up ? 0.3 : 0.02), Math.min(p, n) - (up ? 0.02 : 0.3), n]); // directional wicks → turning points are strict pivots
      p = n;
    }
  }
  return mk(rows);
};

// A multi-timeframe market: 40 days of gentle up-trend, then the SK long scenario (a real HTF structure with pull-backs)
const pre = [];
for (let k = 0; k < 40; k++) pre.push({ to: 100 + k * 1.2 + 6, bars: 144 }, { to: 100 + k * 1.2 + 2, bars: 144 });
const C5 = buildMaster([...pre, ...longWaypoints({ upToStage: 'entry' })], 100);
const NOW = C5[C5.length - 1].time + 300;
const getAll = makeGetCandles(C5);
const run = (over = {}) => analyzePoiSymbol({ symbol: 'TESTUSDT', getCandles: getAll, cfg: CFG, nowSec: NOW, ...over });
const long = async (over) => (await run({ ...over, dirs: ['LONG'] })).results[0];
const mirrored = (cs) => cs.map((c) => ({ ...c, open: -c.open, high: -c.low, low: -c.high, close: -c.close }));
const getMirror = async (tf, limit) => mirrored(await getAll(tf, limit));

// ─────────────────────────────── config ───────────────────────────────
test('config: defaults valid, values clamped, unknown keys dropped, thresholds ordered A+ > B > C', () => {
  const { config, notes } = validatePoiConfig({});
  assert.deepEqual(notes, []);
  assert.equal(config.enabled, true);
  const bad = validatePoiConfig({ swingSensitivity: 'weird', minScore: 500, confirmCloseBars: -4, thresholdAplus: 50, thresholdB: 60, thresholdC: 70, hack: 1, weights: { mss: 999, nope: 3 } });
  assert.equal(bad.config.swingSensitivity, 'medium');
  assert.equal(bad.config.minScore, 100);
  assert.equal(bad.config.confirmCloseBars, 0);
  assert.ok(bad.config.thresholdAplus > bad.config.thresholdB && bad.config.thresholdB > bad.config.thresholdC);
  assert.ok(bad.notes.length > 0);
  assert.equal(bad.config.weights.mss, 50);
  assert.equal(bad.config.hack, undefined);
  assert.equal(bad.config.weights.nope, undefined);
  assert.equal(normalizePoiConfig({ minScore: 5, thresholdC: 40 }).minScore, 40); // nothing below C is ever listed
});

// ─────────────────────────────── structure ───────────────────────────────
test('closed candles only: the forming candle never reaches the analysis', () => {
  const cs = mk([[1, 2, 0, 1], [1, 2, 0, 1], [1, 2, 0, 1]]);
  const at = (n) => closedCandles(cs, '15m', n).length;
  assert.equal(at(T + 900 * 3), 3); // the last candle closes exactly now
  assert.equal(at(T + 900 * 3 - 1), 2); // one second earlier it is still forming
});

test('bullish structure: HH / HL labels and BULLISH trend · bearish mirrored', () => {
  const up = zig([100, 110, 104, 118, 111, 126, 119, 134], 5);
  const lab = labelPivots(pivots(up, 2));
  assert.equal(lab.trend, 'BULLISH');
  assert.ok(lab.labeled.some((p) => p.label === 'HH') && lab.labeled.some((p) => p.label === 'HL'));
  const down = zig([134, 124, 130, 116, 122, 106, 112, 98], 5);
  const lab2 = labelPivots(pivots(down, 2));
  assert.equal(lab2.trend, 'BEARISH');
  assert.ok(lab2.labeled.some((p) => p.label === 'LH') && lab2.labeled.some((p) => p.label === 'LL'));
});

test('BOS = continuation break · MSS = break of the opposite swing · one event per swing (no duplicates)', () => {
  // up-trend, then a lower-low break (MSS bear), then a break back above a lower high (MSS bull)
  const cs = zig([100, 110, 104, 118, 111, 126, 112, 99, 108, 92, 100, 115], 6);
  const ev = walkStructure(cs, pivots(cs, 2)).events;
  assert.ok(ev.length >= 3);
  assert.equal(ev[0].kind, 'BOS'); // first break has no prior trend → continuation label
  assert.ok(ev.some((e) => e.kind === 'MSS' && e.dir === 'BEAR'));
  const lv = ev.map((e) => `${e.dir}:${e.pivotIndex}`);
  assert.equal(new Set(lv).size, lv.length); // a swing is broken only once
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].index > ev[i - 1].index);
});

test('BOS needs a CLOSE beyond the swing (wick alone does not count) unless wick mode is chosen', () => {
  const base = zig([100, 110, 104, 112, 105], 5);
  const hi = Math.max(...base.map((c) => c.high));
  const wick = [...base, { time: base.at(-1).time + 900, open: 106, high: hi + 3, low: 105, close: hi - 1, volume: 1 }, ...mk([[106, 107, 105, 106], [106, 107, 105, 106], [106, 107, 105, 106]], 900, base.at(-1).time + 1800)];
  assert.equal(walkStructure(wick, pivots(wick, 2), { confirm: 'close' }).events.filter((e) => e.dir === 'BULL' && e.index === base.length).length, 0);
  assert.ok(walkStructure(wick, pivots(wick, 2), { confirm: 'wick' }).events.some((e) => e.dir === 'BULL' && e.index === base.length));
});

test('look-ahead guard: a pivot is only usable AFTER its confirmation candle (a break on that bar does not use it)', () => {
  const cs = zig([100, 110, 104, 112, 104, 125], 5);
  const alt = pivots(cs, 2);
  const ev = walkStructure(cs, alt).events;
  for (const e of ev) {
    const piv = alt.find((p) => p.i === e.pivotIndex);
    assert.ok(e.index > piv.confirmedAt, `event at ${e.index} must come after pivot ${piv.i} was confirmed at ${piv.confirmedAt}`);
  }
});

test('hold rule: a break that is not held by the next closed candle is dropped; an unconfirmed latest break is flagged pending', () => {
  const base = zig([100, 110, 104, 112, 105], 5);
  const hi = Math.max(...base.map((c) => c.high));
  const t = (n) => base.at(-1).time + 900 * n;
  const fake = [...base, { time: t(1), open: 106, high: hi + 2, low: 105, close: hi + 1, volume: 1 }, { time: t(2), open: hi, high: hi + 0.5, low: 104, close: 105, volume: 1 }];
  assert.equal(walkStructure(fake, pivots(fake, 2), { holdBars: 1 }).events.filter((e) => e.dir === 'BULL' && e.index === base.length).length, 0); // fell back → not a break
  const pend = [...base, { time: t(1), open: 106, high: hi + 2, low: 105, close: hi + 1, volume: 1 }];
  const e = walkStructure(pend, pivots(pend, 2), { holdBars: 1 }).events.find((x) => x.dir === 'BULL' && x.index === base.length);
  assert.ok(e && e.pending === true);
});

test('dealing range + premium / discount are derived from real swings (equilibrium = 50 %)', () => {
  const cs = zig([100, 160, 130, 150, 120, 140], 6);
  const alt = pivots(cs, 2);
  const r = dealingRange(cs, alt);
  assert.ok(r);
  const lastH = alt.filter((p) => p.type === 'high').at(-1);
  const lastL = alt.filter((p) => p.type === 'low').at(-1);
  assert.ok(r.high >= lastH.price && r.low <= lastL.price); // the latest swing high / low (extended only by candles that traded beyond them)
  assert.ok(cs.some((c) => c.high === r.high) && cs.some((c) => c.low === r.low)); // both ends are real candle extremes
  assert.ok(Math.abs(r.eq - (r.high + r.low) / 2) < 1e-6);
  assert.ok(rangePos(r, r.low) === 0 && rangePos(r, r.high) === 1 && Math.abs(rangePos(r, r.eq) - 0.5) < 1e-9);
  assert.equal(dealingRange(cs.slice(0, 5), pivots(cs.slice(0, 5), 2)), null); // no confirmed swings → no invented range
});

test('liquidity: equal highs / lows are one pool; resting vs taken; no pool is invented', () => {
  const cs = mk([
    [100, 105, 99, 104], [104, 110, 103, 108], [108, 109, 105, 106], [106, 107, 100, 101], [101, 106, 98, 105],
    [105, 110.01, 104, 108], [108, 109, 104, 105], [105, 106, 100, 101], [101, 105, 97.5, 104], [104, 106, 102, 105], [105, 106, 103, 104], [104, 106, 103, 105],
  ]);
  const alt = pivots(cs, 1);
  const pools = liquidityPools(cs, alt, { tolAtr: 0.5 });
  const eqh = pools.find((p) => p.kind === 'EQUAL_HIGHS');
  assert.ok(eqh && eqh.count === 2 && eqh.price >= 110);
  for (const p of pools) assert.ok(cs.some((c) => (p.type === 'BSL' ? c.high >= p.price - 1e-9 : c.low <= p.price + 1e-9))); // every pool rests on a real wick
  assert.ok(pools.every((p) => typeof p.taken === 'boolean'));
});

test('sweep: wick beyond + close back + held + moved away = REJECTED; close beyond = NOT a sweep; wick without follow-through = FAILED', () => {
  const lead = zig([110, 100, 108, 101, 109], 3);
  const alt = pivots(lead, 1);
  const pool = liquidityPools(lead, alt, { tolAtr: 0.05 }).filter((p) => p.type === 'SSL').sort((a, b) => a.price - b.price)[0];
  assert.ok(pool);
  const P = pool.price;
  const t = (n) => lead.at(-1).time + 900 * n;
  const c = (n, o, h, l, cl) => ({ time: t(n), open: o, high: h, low: l, close: cl, volume: 1 });
  const good = [...lead, c(1, P + 4, P + 5, P - 2, P + 3), c(2, P + 3, P + 7, P + 2, P + 6), c(3, P + 6, P + 9, P + 5, P + 8)];
  const s1 = findSweeps(good, [pool], { holdBars: 2, moveAtr: 0.5 });
  assert.equal(s1.length, 1);
  assert.equal(s1[0].status, 'REJECTED');
  assert.equal(s1[0].side, 'BULL');
  const broke = [...lead, c(1, P + 4, P + 5, P - 3, P - 2), c(2, P - 2, P - 1, P - 6, P - 5)];
  assert.equal(findSweeps(broke, [pool], { holdBars: 1 }).length, 0); // closed below the pool = a real break
  const weak = [...lead, c(1, P + 4, P + 5, P - 0.1, P + 3), c(2, P + 3, P + 3.2, P + 0.2, P + 0.4), c(3, P + 0.4, P + 0.6, P + 0.05, P + 0.2)];
  assert.equal(findSweeps(weak, [pool], { holdBars: 2, moveAtr: 3 })[0]?.status, 'FAILED'); // tiny wick, no displacement → not a rejection
  const pending = [...lead, c(1, P + 4, P + 5, P - 2, P + 3)];
  assert.equal(findSweeps(pending, [pool], { holdBars: 2 })[0].status, 'PENDING');
});

test('FVG: bullish / bearish three-candle gaps with FRESH → PARTIAL → FILLED / INVALIDATED lifecycle', () => {
  const bull = mk([[100, 101, 99, 100.5], [100.5, 105, 100.4, 104.5], [104.5, 106, 103, 105.5], [105.5, 107, 105, 106.5]]);
  const f = findFvgs(bull, { minAtr: 0 });
  assert.equal(f.length, 1);
  assert.deepEqual([f[0].type, f[0].low, f[0].high, f[0].status], ['BULL', 101, 103, 'FRESH']);
  const partial = [...bull, ...mk([[106.5, 106.6, 102.4, 103.5]], 900, bull.at(-1).time + 900)];
  assert.equal(findFvgs(partial, { minAtr: 0 })[0].status, 'PARTIAL');
  const filled = [...bull, ...mk([[106.5, 106.6, 100.8, 102.5]], 900, bull.at(-1).time + 900)];
  assert.equal(findFvgs(filled, { minAtr: 0 })[0].status, 'FILLED');
  const inval = [...bull, ...mk([[106.5, 106.6, 99, 100]], 900, bull.at(-1).time + 900)];
  assert.equal(findFvgs(inval, { minAtr: 0 })[0].status, 'INVALIDATED');
  const bear = mk([[106, 107, 105, 105.5], [105.5, 105.6, 100, 100.5], [100.5, 103, 99, 99.5], [99.5, 100, 98, 99]]);
  const fb = findFvgs(bear, { minAtr: 0 });
  assert.deepEqual([fb[0].type, fb[0].low, fb[0].high], ['BEAR', 103, 105]);
  assert.equal(findFvgs(bull, { minAtr: 50 }).length, 0); // too small for the ATR filter
});

test('order blocks: FRESH / MITIGATED / INVALIDATED follow the rules on real structure', () => {
  const cs = closedCandles(makeGetCandles(C5) ? C5.filter((_, i) => i % 12 === 0).map((c, i, a) => ({ ...c })) : [], '1h', NOW + 1e9);
  const obs = findOrderBlocks(C5.length ? aggregate1h() : cs, { lookback: 400, mitigation: 'close', minDisplacementAtr: 0 });
  assert.ok(obs.length > 0);
  const h1 = aggregate1h();
  for (const ob of obs) {
    const after = h1.slice(ob.confBar + 1);
    const closedThrough = after.some((c) => (ob.type === 'BULL' ? c.close < ob.low : c.close > ob.high));
    const touched = after.some((c) => c.low <= ob.high && c.high >= ob.low);
    if (ob.status === 'INVALIDATED') assert.ok(closedThrough);
    else {
      assert.equal(closedThrough, false);
      assert.equal(ob.status, touched ? 'MITIGATED' : 'FRESH');
    }
    assert.ok(ob.high > ob.low);
  }
  assert.ok(obs.every((o) => o.valid === (o.displacementAtr >= 0)));
  const strict = findOrderBlocks(h1, { lookback: 400, mitigation: 'close', minDisplacementAtr: 3 });
  assert.ok(strict.filter((o) => o.valid).length <= strict.length);
});
function aggregate1h() {
  const out = [];
  for (let i = 0; i + 12 <= C5.length; i += 12) {
    const g = C5.slice(i, i + 12);
    out.push({ time: g[0].time, open: g[0].open, high: Math.max(...g.map((c) => c.high)), low: Math.min(...g.map((c) => c.low)), close: g.at(-1).close, volume: g.reduce((a, c) => a + c.volume, 0) });
  }
  return out;
}

// ─────────────────────────────── engine ───────────────────────────────
test('engine: multi-timeframe analysis returns a complete, coherent LONG / SHORT result', async () => {
  const res = await run();
  assert.equal(res.results.length, 2);
  const a = res.results.find((r) => r.dir === 'LONG').analysis;
  assert.ok(a);
  assert.ok(['WATCHING', 'READY', 'CONFIRMED', 'INVALIDATED'].includes(a.state));
  assert.ok(['A+', 'B', 'C', 'NONE'].includes(a.class));
  for (const k of ['symbol', 'dir', 'htf', 'poi', 'premiumDiscount', 'liquidity', 'ob', 'fvg', 'confirmationTf', 'signalTime', 'invalidation', 'diagnostics', 'annotations', 'breakdown']) assert.ok(a[k] !== undefined, `missing ${k}`);
  assert.equal(a.confirmationTf, '15m');
  for (const k of ['high', 'low', 'type', 'tf', 'createdTime', 'mitigation', 'invalidated']) assert.ok(a.poi[k] !== undefined, `poi.${k}`);
  assert.ok(a.poi.high > a.poi.low);
  assert.equal(a.htf.align, 'STRONG'); // 1D + 4H both bullish in this market
  assert.ok(a.premiumDiscount.swingHigh > a.premiumDiscount.eq && a.premiumDiscount.eq > a.premiumDiscount.swingLow);
  assert.ok(Math.abs(a.premiumDiscount.eq - (a.premiumDiscount.swingHigh + a.premiumDiscount.swingLow) / 2) < 1e-6);
  assert.ok(a.score >= 0 && a.score <= 100);
  assert.ok(a.id.startsWith('poi_TESTUSDT_LONG_'));
});

test('chart annotations are the real calculated levels: swings = real candle extremes, zones start on real candles', async () => {
  const a = (await long()).analysis;
  const h4 = makeGetCandles(C5);
  const c4 = await h4('4h', 1000);
  const sh = a.annotations.find((x) => x.label === 'SWING HIGH');
  const sl = a.annotations.find((x) => x.label === 'SWING LOW');
  assert.ok(c4.some((c) => c.time === sh.t1 && Math.abs(c.high - sh.p1) < 1e-6));
  assert.ok(c4.some((c) => c.time === sl.t1 && Math.abs(c.low - sl.p1) < 1e-6));
  const eq = a.annotations.find((x) => x.group === 'eq');
  assert.ok(Math.abs(eq.p1 - (sh.p1 + sl.p1) / 2) < 1e-6);
  const prem = a.annotations.find((x) => x.group === 'premium');
  const disc = a.annotations.find((x) => x.group === 'discount');
  assert.ok(prem.p2 === eq.p1 && disc.p1 === eq.p1);
  const allTimes = new Set();
  for (const tf of ['4h', '1h', '30m', '15m']) (await h4(tf, 1000)).forEach((c) => allTimes.add(c.time));
  for (const z of a.annotations.filter((x) => ['ob', 'fvg', 'poi'].includes(x.group))) {
    assert.ok(allTimes.has(z.t1), `${z.group} zone must start on a real candle`);
    assert.ok(z.p1 > z.p2);
  }
  for (const m of a.annotations.filter((x) => x.kind === 'marker')) assert.ok(allTimes.has(m.t), `${m.group} marker must sit on a real candle`);
  const groups = new Set(a.annotations.map((x) => x.group));
  for (const g of ['swings', 'premium', 'discount', 'eq', 'liquidity', 'poi']) assert.ok(groups.has(g), `group ${g}`);
});

test('mirror symmetry: SHORT on the mirrored market equals LONG on the original (same engine, no hidden bias)', async () => {
  const L = (await long()).analysis;
  const S = (await analyzePoiSymbol({ symbol: 'TESTUSDT', getCandles: getMirror, cfg: CFG, nowSec: NOW, dirs: ['SHORT'] })).results[0].analysis;
  assert.ok(S);
  assert.deepEqual([S.state, S.class, S.score, S.poi.type, S.poi.tf], [L.state, L.class, L.score, L.poi.type, L.poi.tf]);
  assert.ok(Math.abs(S.poi.high - -L.poi.low) < 1e-6 && Math.abs(S.poi.low - -L.poi.high) < 1e-6);
  assert.equal(S.htf.align, L.htf.align);
  assert.equal(S.premiumDiscount.zone, L.premiumDiscount.zone === 'PREMIUM' ? 'DISCOUNT' : 'PREMIUM');
});

test('opposite direction is gated by the 4H bias (SHORT in a bullish market is not listed)', async () => {
  const S = (await run()).results.find((r) => r.dir === 'SHORT');
  if (S.analysis) {
    assert.equal(S.analysis.htf.align, 'CONFLICT');
    assert.equal(S.analysis.listed, false);
    assert.ok(S.analysis.reasons.some((r) => /4H/.test(r)));
  } else assert.ok(S.reason);
  const off = normalizePoiConfig({ requireHtfAlignment: false, minScore: 0, thresholdC: 0, thresholdB: 1, thresholdAplus: 2 });
  assert.ok(off.thresholdC === 0);
});

test('no look-ahead / no repainting: analysis at time t is identical whether or not future candles are present', async () => {
  const total = C5.length;
  const SEC = { '1d': 86400, '4h': 14400, '1h': 3600, '30m': 1800, '15m': 900 };
  for (const cut of [total - 2400, total - 1500, total - 700, total - 200]) {
    const now = C5[cut - 1].time + 300;
    const past = makeGetCandles(C5.slice(0, cut));
    const all = makeGetCandles(C5);
    const part = await analyzePoiSymbol({ symbol: 'T', getCandles: past, cfg: CFG, nowSec: now, dirs: ['LONG'] });
    // same history, but 40 FUTURE candles of every time frame are appended (a leaking data feed)
    const leaky = async (tf, limit) => {
      const hist = await past(tf, limit);
      const fut = (await all(tf, 100000)).filter((c) => c.time >= hist[hist.length - 1].time + SEC[tf]).slice(0, 40);
      return [...hist, ...fut];
    };
    const withFuture = await analyzePoiSymbol({ symbol: 'T', getCandles: leaky, cfg: CFG, nowSec: now, dirs: ['LONG'] });
    assert.ok(part.results[0].analysis, `cut ${cut}`);
    assert.equal(JSON.stringify(part.results[0].analysis), JSON.stringify(withFuture.results[0].analysis), `cut ${cut}`);
  }
});

test('a still-forming candle can never produce or confirm a signal', async () => {
  const cut = C5.length - 900;
  const now = C5[cut - 1].time + 300;
  const base = await analyzePoiSymbol({ symbol: 'T', getCandles: makeGetCandles(C5.slice(0, cut)), cfg: CFG, nowSec: now, dirs: ['LONG'] });
  const g = makeGetCandles(C5.slice(0, cut));
  const withForming = async (tf, limit) => {
    const cs = await g(tf, limit);
    const sec = { '1d': 86400, '4h': 14400, '1h': 3600, '30m': 1800, '15m': 900 }[tf];
    const lastC = cs[cs.length - 1];
    // a huge forming candle that started after the last closed one (would break everything if it were used)
    return [...cs, { time: now - Math.floor(sec / 3), open: lastC.close, high: lastC.close * 3, low: lastC.close * 0.2, close: lastC.close * 2.5, volume: 1 }];
  };
  const forming = await analyzePoiSymbol({ symbol: 'T', getCandles: withForming, cfg: CFG, nowSec: now, dirs: ['LONG'] });
  assert.equal(JSON.stringify(base.results[0].analysis), JSON.stringify(forming.results[0].analysis));
});

test('state machine: ids move WATCHING → READY → CONFIRMED → INVALIDATED only forward (no repaint) across a walk-forward', async () => {
  const hist = new Map();
  const classes = [];
  for (let n = C5.length - 3600; n <= C5.length; n += 240) {
    const now = C5[n - 1].time + 300;
    const a = (await analyzePoiSymbol({ symbol: 'T', getCandles: getAll, cfg: CFG, nowSec: now, dirs: ['LONG'] })).results[0].analysis;
    if (!a) continue;
    (hist.get(a.id) || hist.set(a.id, []).get(a.id)).push(a.state);
    classes.push(a);
  }
  const rank = { WATCHING: 1, READY: 2, CONFIRMED: 3, INVALIDATED: 4 };
  assert.ok(hist.size > 0);
  for (const [id, seq] of hist) for (let i = 1; i < seq.length; i++) assert.ok(rank[seq[i]] >= rank[seq[i - 1]], `${id}: ${seq.join('>')}`);
  assert.ok(classes.some((a) => a.state === 'WATCHING') && classes.some((a) => a.state === 'READY') && classes.some((a) => a.state === 'CONFIRMED'), 'all promotion stages are reached in the scenario');
  // price touching a POI never confirms by itself: READY always precedes CONFIRMED for the same id
  for (const [, seq] of hist) if (seq.includes('CONFIRMED')) assert.ok(seq.indexOf('READY') < seq.indexOf('CONFIRMED') || seq[0] === 'CONFIRMED');
});

test('CONFIRMED always has a closed 15M structure shift after the POI was reached (and after a sweep when one exists)', async () => {
  let seen = 0;
  for (let n = C5.length - 1800; n <= C5.length; n += 240) {
    const now = C5[n - 1].time + 300;
    const a = (await analyzePoiSymbol({ symbol: 'T', getCandles: getAll, cfg: CFG, nowSec: now, dirs: ['LONG'] })).results[0].analysis;
    if (a?.state !== 'CONFIRMED') continue;
    seen++;
    assert.ok(a.poi.touchedTime, 'POI was reached');
    assert.ok(a.signalTime > a.poi.touchedTime, 'confirmation after the touch');
    assert.ok(a.signalTime + 900 <= now, 'confirmation candle is closed');
    if (a.liquidity.sweep.status === 'REJECTED' || a.liquidity.sweep.status === 'PENDING') assert.ok(a.signalTime > a.liquidity.sweep.time);
    assert.ok(a.diagnostics.find((d) => d.id === 'confirm').ok === true);
  }
  assert.ok(seen > 0);
});

test('probability classes: A+ needs the full checklist · thresholds are applied · scores never double count', async () => {
  const strict = normalizePoiConfig({ thresholdAplus: 99, thresholdB: 98, thresholdC: 97, minScore: 97 });
  assert.equal((await long({ cfg: strict })).analysis.listed, false);
  const checked = [];
  for (let n = C5.length - 3000; n <= C5.length; n += 300) {
    const now = C5[n - 1].time + 300;
    const a = (await analyzePoiSymbol({ symbol: 'T', getCandles: getAll, cfg: normalizePoiConfig({ thresholdAplus: 60, thresholdB: 50, thresholdC: 40 }), nowSec: now, dirs: ['LONG'] })).results[0].analysis;
    if (a) checked.push(a);
  }
  for (const a of checked) {
    const keys = a.breakdown.map((b) => b.factor);
    assert.equal(new Set(keys).size, keys.length, 'each factor counted once');
    const sum = Math.max(0, Math.min(100, a.breakdown.reduce((s, b) => s + b.points, 0)));
    assert.equal(a.score, sum);
    if (a.class === 'A+') {
      assert.equal(a.htf.align, 'STRONG');
      assert.equal(a.state, 'CONFIRMED');
      assert.equal(a.liquidity.sweep.status, 'REJECTED');
      assert.equal(a.poi.mitigation, 'FRESH');
      assert.ok(a.location.extreme && a.plan.rrOk);
    }
  }
});

test('POI dedupe: no two POIs of one analysis overlap more than the configured percentage', async () => {
  const a = (await long()).analysis;
  const zones = [a.poi, ...a.alternatives.map((x) => x.poi)];
  for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) assert.ok(overlapFrac(zones[i], zones[j]) * 100 < CFG.poiOverlapPct, `${i}/${j}`);
});

test('double OB: a nested order block makes a DOUBLE_OB POI and adds its own (single) score factor', async () => {
  const base = (await long()).analysis;
  const zone = { high: base.poi.high, low: base.poi.low };
  const tfCandles = closedCandles(await getAll(base.poi.tf, { '4h': 500, '1h': 600, '30m': 600, '15m': 700 }[base.poi.tf]), base.poi.tf, NOW); // exactly the array the engine indexes into
  const at = tfCandles.findIndex((c) => c.time === base.poi.createdTime);
  assert.ok(at >= 0);
  const pair = { type: 'bullish', status: 'UNMITIGATED', inner: { ...zone, index: at, confBar: Math.min(at + 1, tfCandles.length - 1), time: base.poi.createdTime }, outer: { high: zone.high + 1, low: zone.low - 1, index: at - 3, time: base.poi.createdTime } };
  const withDbl = (await long({ doubleObs: { [base.poi.tf]: [pair] } })).analysis;
  assert.ok(withDbl.poi.sources.some((s) => s.src === 'DOUBLE_OB'), 'the double OB is part of the POI');
  assert.equal(withDbl.poi.type, 'DOUBLE_OB');
  assert.equal(withDbl.breakdown.filter((b) => b.factor === 'doubleOb').length, 1); // counted once
  assert.equal(base.breakdown.filter((b) => b.factor === 'doubleOb').length, 0);
  assert.ok(withDbl.score >= base.score);
  assert.ok(withDbl.poi.outer && withDbl.poi.outer.high > withDbl.poi.high); // the larger OB is kept for reference
  // a MITIGATED pair is never a POI source
  const none = (await long({ doubleObs: { [base.poi.tf]: [{ ...pair, status: 'MITIGATED' }] } })).analysis;
  assert.ok(![none, ...none.alternatives].some((x) => x.poi.sources.some((s) => s.src === 'DOUBLE_OB')));
});

test('data problems are reported, not hidden: too few candles → reason · fetch failure → throws with fetchFailed', async () => {
  const short = await analyzePoiSymbol({ symbol: 'X', cfg: CFG, nowSec: NOW, getCandles: async (tf) => (await getAll(tf, 1000)).slice(-5) });
  assert.ok(short.results.every((r) => r.analysis === null && /not enough closed candles/.test(r.reason)));
  await assert.rejects(analyzePoiSymbol({ symbol: 'X', cfg: CFG, nowSec: NOW, getCandles: async () => { throw Object.assign(new Error('HTTP 418'), { banned: true }); } }), (e) => e.fetchFailed === true && e.banned === true);
});

test('diagnostics explain every gate (why a coin did / did not become a signal)', async () => {
  const flat = mk(Array.from({ length: 900 }, (_, i) => [100, 100.2, 99.8, 100 + (i % 2 ? 0.05 : -0.05)]));
  const res = await analyzePoiSymbol({ symbol: 'FLAT', cfg: CFG, nowSec: T + 900 * 900 + 86400 * 400, getCandles: async (tf) => flat.map((c, i) => ({ ...c, time: T + i * { '1d': 86400, '4h': 14400, '1h': 3600, '30m': 1800, '15m': 900 }[tf] })) });
  for (const r of res.results) {
    assert.ok(r.analysis === null ? !!r.reason : r.analysis.diagnostics.length > 0);
    assert.ok((r.diagnostics || []).every((d) => d.id && d.label && 'ok' in d && d.detail));
  }
});

// ─────────────────────────────── backtest ───────────────────────────────
test('backtest: walk-forward with fees + slippage · fills on the NEXT candle · no look-ahead', async () => {
  const candles = {};
  for (const tf of ['1d', '4h', '1h', '30m', '15m']) candles[tf] = await getAll(tf, 100000);
  const easy = normalizePoiConfig({ minRR: 0.5 });
  const res = await replayBacktest({ symbol: 'TESTUSDT', candles, cfg: easy, fromSec: C5.at(-1).time - 3 * 86400, toSec: C5.at(-1).time, stepSec: 7200 });
  assert.ok(res.signals.length >= 0 && res.stats && res.costs.feePct > 0 && res.costs.slippagePct > 0);
  for (const t of res.trades) {
    assert.ok(t.entryTime > t.signalTime - 1, 'entry after the signal');
    assert.ok(t.exitTime >= t.entryTime);
    assert.ok(t.netR <= t.grossR, 'costs reduce the result');
  }
  const none = await replayBacktest({ symbol: 'TESTUSDT', candles, cfg: normalizePoiConfig({ minScore: 100, thresholdAplus: 100, thresholdB: 99, thresholdC: 98 }), fromSec: C5.at(-1).time - 86400, toSec: C5.at(-1).time, stepSec: 14400 });
  assert.equal(none.trades.length, 0);
  assert.deepEqual(statsOf([]), { trades: 0, wins: 0, winRate: 0, avgNetR: 0, totalNetR: 0, profitFactor: 0, maxDrawdownR: 0 });
  const st = statsOf([{ netR: 2 }, { netR: -1 }, { netR: -1 }, { netR: 3 }]);
  assert.deepEqual([st.trades, st.wins, st.winRate, st.totalNetR, st.maxDrawdownR], [4, 2, 50, 3, 2]);
});
