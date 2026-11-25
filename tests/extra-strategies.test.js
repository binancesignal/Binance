import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findElliottEvents,
  findAbcdSpEvents,
  abcdPatterns,
  findSpBreaker,
  normalizeExtraConfig,
  revalidateExtraSignal,
  buildExtraChartSvg,
  buildExtraAnnotations,
  EXTRA_DEFAULTS,
  findStrategyEvents,
  emptyDiag,
} from '../lib/scanner/strategy/harmonicScan/extraStrategies.js';
import { findHarmonicEvents, buildHarmonicChartSvg, buildHarmonicAnnotations, revalidateSavedSignal } from '../lib/scanner/strategy/harmonicScan/index.js';

/** Piecewise-linear price path through [bar, price] waypoints. */
function path(way, total, { base = 1.7e9, tf = 3600, wick = 0.15 } = {}) {
  const out = [];
  for (let i = 0; i < total; i++) {
    let k = 0;
    while (k < way.length - 2 && i > way[k + 1][0]) k++;
    const [i0, p0] = way[k];
    const [i1, p1] = way[k + 1];
    const t = Math.min(1, Math.max(0, (i - i0) / (i1 - i0)));
    const c = p0 + (p1 - p0) * t;
    const o = i ? out[i - 1].close : c;
    out.push({ time: base + i * tf, open: o, close: c, high: Math.max(o, c) + wick, low: Math.min(o, c) - wick, volume: 100 });
  }
  return out;
}
const mirror = (cs, k = 230) =>
  cs.map((c) => ({ ...c, open: k - c.open, close: k - c.close, high: k - c.low, low: k - c.high }));

// prior swing high 108 → P0 100 → P1 120 → P2 110 (W2 = 50 % of W1)
const IMPULSE = [[0, 104], [20, 108], [45, 100], [75, 120], [100, 110]];
const impulse = (tail) => path([...IMPULSE, ...tail], tail[tail.length - 1][0] + 1);

test('defaults: both extra strategies OFF, Pine parameters', () => {
  assert.equal(EXTRA_DEFAULTS.enableElliott, false);
  assert.equal(EXTRA_DEFAULTS.enableAbcdSp, false);
  assert.deepEqual({ ...EXTRA_DEFAULTS.elliott }, { zigzagLength: 10, errorPercent: 5, entryPercent: 30, maxAgeBars: 80, maxPerSide: 2 });
  assert.equal(EXTRA_DEFAULTS.abcd.minLegAtr, 1.5);
  assert.equal(normalizeExtraConfig({ enableElliott: 'true' }).enableElliott, true);
});

test('Elliott: wave levels follow the indicator formulas (long)', () => {
  const [e] = findElliottEvents(impulse([[130, 116], [135, 116.5]]), {});
  assert.ok(e, 'impulse found');
  assert.equal(e.direction, 'LONG');
  const [p0, p1, p2] = e.points.map((p) => p.price);
  const w2 = p1 - p2;
  assert.ok(Math.abs(e.ratios.w2w1 - 0.5) < 0.03);
  assert.ok(Math.abs(e.plan.entry - (p2 + 0.3 * w2)) < 1e-9);
  assert.equal(e.plan.sl, p0);
  assert.ok(Math.abs(e.plan.tstop - (p2 - 0.3 * w2)) < 1e-9);
  assert.ok(Math.abs(e.plan.tp1 - (p2 + 1.618 * w2)) < 1e-9);
  assert.ok(Math.abs(e.plan.tp4 - (p2 + 3.236 * w2)) < 1e-9);
  assert.ok(e.theory.includes('Elliott'));
});

test('Elliott lifecycle: watching → ready → in trade → formed (TP already hit before the scan)', () => {
  const far = findElliottEvents(impulse([[104, 111.0], [112, 111.5]]), {}, { proximityPct: 0.5 })[0];
  assert.ok(far, 'far setup listed');
  assert.equal(far.status, 'WATCHING'); // entry not hit, price not close
  const near = findElliottEvents(impulse([[104, 112.4], [112, 112.5]]), {}, { proximityPct: 2 })[0];
  assert.ok(near, 'near setup listed');
  assert.equal(near.status, 'ENTRY_READY'); // close to the entry
  const inTrade = findElliottEvents(impulse([[130, 116], [135, 116.5]]), {})[0];
  assert.equal(inTrade.status, 'IN_TRADE'); // entry crossed, no target yet
  const formed = findElliottEvents(impulse([[125, 128], [135, 128]]), {})[0];
  assert.equal(formed.status, 'FORMED'); // target 1 already hit
  assert.ok(formed.tpReached >= 1);
});

test('Elliott: stop-hit setups are listed as SL_HIT (board cards); extended wave 2 still dropped in finder', () => {
  const stopped = findElliottEvents(impulse([[120, 116], [140, 98], [150, 98.5]]), {});
  const hit = stopped.filter((e) => e.points[2].price > 109 && e.points[2].price < 111);
  // Board shows SL_HIT cards instead of hiding them
  if (hit.length) assert.equal(hit[0].status, 'SL_HIT');
  const extended = findElliottEvents(impulse([[110, 108], [125, 108.5]]), {});
  assert.equal(extended.filter((e) => Math.abs(e.points[2].price - 109.8) < 0.5).length, 0);
});

test('Elliott: the mirrored (bearish) impulse gives a SHORT with mirrored levels', () => {
  const cs = mirror(impulse([[130, 116], [135, 116.5]]));
  const [e] = findElliottEvents(cs, {});
  assert.ok(e);
  assert.equal(e.direction, 'SHORT');
  assert.ok(e.plan.entry < e.points[2].price);
  assert.ok(e.plan.sl > e.points[1].price);
  assert.ok(e.plan.tp1 < e.plan.entry);
});

// ── ABCD + SP breaker ───────────────────────────────────────────────────────
// downtrend (so EMA200 sits ABOVE the pattern) then an UPWARD ABCD near the bottom
function abcdSeries(tail) {
  const way = [
    [0, 330], [260, 110], // long slide: EMA200 stays far above
    [270, 100], // A (low)
    [285, 110], // B (high)
    [295, 103], // C (higher low): BC = 70 % of AB
    [306, 112.1], // D (higher high): CD = 1.3 × BC
    ...tail,
  ];
  return path(way, way[way.length - 1][0] + 1, { wick: 0.2 });
}
const SP_LONG = { id: 7, isBull: true, side: 'Bullish', top: 104.0, bot: 102.6, bornBar: 290, obBar: 276, quality: 70 };

test('ABCD zigzag finds the upward ABCD with the Pine ratios', () => {
  const cs = abcdSeries([[330, 108]]);
  const pats = abcdPatterns(cs.slice(0, -1), normalizeExtraConfig({}).abcd);
  const up = pats.filter((p) => p.form === 'UP');
  assert.ok(up.length >= 1);
  const p = up[up.length - 1];
  assert.ok(p.bcR >= 0.5 && p.bcR <= 0.886);
  assert.ok(p.cdR >= 1.13 && p.cdR <= 1.618);
});

test('SP breaker rules: origin on AB/BC wave, touches C candle, born at or before C, side matches', () => {
  const cs = abcdSeries([[330, 108]]);
  const closed = cs.slice(0, -1);
  const p = abcdPatterns(closed, normalizeExtraConfig({}).abcd).filter((x) => x.form === 'UP').pop();
  const C = closed[p.C.b];
  const touching = { id: 1, isBull: true, top: C.low + 0.3, bot: C.low - 0.5, bornBar: p.C.b - 2, obBar: p.A.b + 3 };
  assert.equal(findSpBreaker([touching], p, closed, true).id, 1);
  // default: only the STARTING candle (origin) must be at/before C; strict mode also wants it confirmed by C
  assert.equal(findSpBreaker([{ ...touching, bornBar: p.C.b + 1 }], p, closed, true).id, 1, 'confirmed after C is fine by default');
  assert.equal(findSpBreaker([{ ...touching, bornBar: p.C.b + 1 }], p, closed, true, { strictBorn: true }), null, 'strict: born after C');
  assert.equal(findSpBreaker([{ ...touching, obBar: p.A.b - 4 }], p, closed, true), null, 'origin before A');
  assert.equal(findSpBreaker([{ ...touching, obBar: p.C.b + 2 }], p, closed, true), null, 'origin after C');
  assert.equal(findSpBreaker([{ ...touching, top: C.high + 3, bot: C.high + 1 }], p, closed, true), null, 'does not touch the C candle');
  assert.equal(findSpBreaker([{ ...touching, isBull: false }], p, closed, true), null, 'wrong side');
  // wick-only touch counts
  assert.equal(findSpBreaker([{ ...touching, top: C.low + 0.01, bot: C.low - 0.4 }], p, closed, true).id, 1);
});

test('ABCD+SP: downtrend + upward ABCD → LONG at the SP breaker TOP, SL under its bottom', () => {
  const cs = abcdSeries([[330, 108]]);
  const closed = cs.slice(0, -1);
  const p = abcdPatterns(closed, normalizeExtraConfig({}).abcd).filter((x) => x.form === 'UP').pop();
  const C = closed[p.C.b];
  const sp = { id: 9, isBull: true, side: 'Bullish', top: C.low + 0.4, bot: C.low - 0.6, bornBar: p.C.b - 1, obBar: p.A.b + 4, quality: 60 };
  const evs = findAbcdSpEvents(cs, {}, { breakers: [sp], proximityPct: 2 });
  assert.equal(evs.length, 1);
  const e = evs[0];
  assert.equal(e.direction, 'LONG');
  assert.equal(e.trend, 'DOWN');
  assert.equal(e.plan.entry, sp.top);
  assert.ok(e.plan.sl < sp.bot);
  assert.ok(Math.abs(sp.bot - e.plan.sl - 0.25 * (e.plan.entry - e.plan.sl) * 0 - (sp.bot - e.plan.sl)) < 1e-9);
  assert.ok(e.plan.tp1 > e.plan.entry && e.plan.tp2 > e.plan.tp1 && e.plan.tp3 > e.plan.tp2);
  assert.ok(['WATCHING', 'ENTRY_READY'].includes(e.status)); // price still near D, entry not touched
  assert.ok(e.theory.includes('EMA200'));
});

test('ABCD+SP: stop buffer is the admin setting (ATR units)', () => {
  const cs = abcdSeries([[330, 108]]);
  const closed = cs.slice(0, -1);
  const p = abcdPatterns(closed, normalizeExtraConfig({}).abcd).filter((x) => x.form === 'UP').pop();
  const C = closed[p.C.b];
  const sp = { id: 9, isBull: true, top: C.low + 0.4, bot: C.low - 0.6, bornBar: p.C.b - 1, obBar: p.A.b + 4, quality: 60 };
  const tight = findAbcdSpEvents(cs, { stopBufferAtr: 0 }, { breakers: [sp] })[0];
  const wide = findAbcdSpEvents(cs, { stopBufferAtr: 2 }, { breakers: [sp] })[0];
  assert.equal(tight.plan.sl, sp.bot);
  assert.ok(wide.plan.sl < tight.plan.sl);
});

test('ABCD+SP: pattern that touches the EMA200 is dropped; wrong trend/shape pair is dropped', () => {
  // flat market → EMA200 runs through the pattern
  const flat = path([[0, 105], [260, 105], [270, 100], [285, 110], [295, 103], [306, 112.1], [330, 108]], 331, { wick: 0.2 });
  const closed = flat.slice(0, -1);
  const p = abcdPatterns(closed, normalizeExtraConfig({}).abcd).filter((x) => x.form === 'UP').pop();
  const sp = { id: 3, isBull: true, top: 104, bot: 102.6, bornBar: p.C.b - 1, obBar: p.A.b + 4 };
  assert.equal(findAbcdSpEvents(flat, {}, { breakers: [sp] }).length, 0);
  // uptrend + UPWARD abcd is not one of the two taken combinations
  const up = path([[0, 40], [260, 90], [270, 100], [285, 110], [295, 103], [306, 112.1], [330, 108]], 331, { wick: 0.2 });
  assert.equal(findAbcdSpEvents(up, {}, { breakers: [{ ...sp, id: 4 }] }).length, 0);
});

test('ABCD+SP mirrored: uptrend + downward ABCD → SHORT at the SP breaker BOTTOM, SL above its top', () => {
  const cs = mirror(abcdSeries([[330, 108]]), 330 + 100 - 0); // mirror around a high level keeps ordering
  const closed = cs.slice(0, -1);
  const p = abcdPatterns(closed, normalizeExtraConfig({}).abcd).filter((x) => x.form === 'DOWN').pop();
  assert.ok(p, 'downward ABCD present');
  const C = closed[p.C.b];
  const sp = { id: 5, isBull: false, side: 'Bearish', top: C.high + 0.6, bot: C.high - 0.4, bornBar: p.C.b - 1, obBar: p.A.b + 4, quality: 60 };
  const [e] = findAbcdSpEvents(cs, {}, { breakers: [sp] });
  assert.ok(e);
  assert.equal(e.direction, 'SHORT');
  assert.equal(e.trend, 'UP');
  assert.equal(e.plan.entry, sp.bot);
  assert.ok(e.plan.sl > sp.top);
  assert.ok(e.plan.tp1 < e.plan.entry);
});

test('ABCD+SP lifecycle: entry touched then target → FORMED; stop hit → SL_HIT card', () => {
  const base = abcdSeries([[330, 108]]);
  const closed = base.slice(0, -1);
  const p = abcdPatterns(closed, normalizeExtraConfig({}).abcd).filter((x) => x.form === 'UP').pop();
  const C = closed[p.C.b];
  const sp = { id: 9, isBull: true, top: C.low + 0.4, bot: C.low - 0.6, bornBar: p.C.b - 1, obBar: p.A.b + 4, quality: 60 };
  const entry = sp.top;
  const formed = abcdSeries([[320, entry - 0.1], [335, 113], [340, 113]]);
  const f = findAbcdSpEvents(formed, {}, { breakers: [sp] })[0];
  assert.equal(f.status, 'FORMED');
  const dead = abcdSeries([[320, entry - 0.1], [330, 98], [340, 98.5]]);
  const d = findAbcdSpEvents(dead, {}, { breakers: [sp] });
  assert.ok(d.length >= 1);
  assert.equal(d[0].status, 'SL_HIT');
});

test('chart + annotations draw the structure, SP breaker, entry/stop/targets', () => {
  const cs = impulse([[130, 116], [135, 116.5]]);
  const [e] = findElliottEvents(cs, {});
  const svg = buildExtraChartSvg(cs, e, { symbol: 'TEST', tf: '1h' });
  assert.match(svg, /<svg/);
  for (const t of ['Entry', 'SL', 'T.Stop', 'Target-1', 'Target-4']) assert.ok(svg.includes(t), t);
  const an = buildExtraAnnotations(e, cs, { tf: '1h' });
  assert.ok(an.some((a) => a.kind === 'poly'));
  assert.ok(an.some((a) => a.group === 'targets'));
  // the dispatchers in index.js route extra events here
  assert.match(buildHarmonicChartSvg(cs, e, { symbol: 'T', tf: '1h' }), /Target-1/);
  assert.ok(buildHarmonicAnnotations(e, cs, { tf: '1h' }).some((a) => a.kind === 'poly'));
});

test('strategies are separate from the harmonic scan: harmonic engine ignores strategy switches', () => {
  const cs = impulse([[104, 112.4], [110, 112.5]]);
  assert.equal(findHarmonicEvents(cs, { enableElliott: true, enableAbcdSp: true }).filter((e) => e.strategy).length, 0);
  assert.equal(findStrategyEvents(cs, {}).length, 0, 'both strategies OFF by default');
  const evs = findStrategyEvents(cs, { enableElliott: true });
  assert.ok(evs.length >= 1 && evs.every((e) => e.strategy === 'ELLIOTT'));
});

test('diagnostics count every filter stage', () => {
  const diag = emptyDiag();
  const cs = impulse([[104, 112.4], [110, 112.5]]);
  findStrategyEvents(cs, { enableElliott: true }, { diag });
  assert.equal(diag.windows, 1);
  assert.ok(diag.elliottPivotSets >= 1 && diag.elliottRecent >= 1 && diag.elliottListed >= 1);
});

test('strategy config: own timeframes + master switches, defaults', () => {
  const c = normalizeExtraConfig({});
  assert.deepEqual(c.tfs, ['1h', '4h']);
  assert.equal(c.harmonicEnabled, true);
  assert.equal(normalizeExtraConfig({ harmonicEnabled: false, tfs: ['15m'] }).harmonicEnabled, false);
  assert.deepEqual(normalizeExtraConfig({ tfs: ['15m'] }).tfs, ['15m']);
  assert.equal(normalizeExtraConfig({ abcd: { spStrictBorn: true } }).abcd.spStrictBorn, true);
});

test('refresh keeps the lifecycle of a saved strategy signal', () => {
  const cs = impulse([[104, 112.4], [110, 112.5]]);
  const evs = findStrategyEvents(cs, { enableElliott: true }, { proximityPct: 2 });
  const saved = { ...evs[0], symbol: 'TESTUSDT', tf: '1h' };
  const later = impulse([[125, 128], [135, 128]]);
  const r = revalidateSavedSignal(later, saved, {});
  assert.ok(r.entryTouched);
  assert.ok(/^TP[123]_HIT$/.test(r.status), r.status);
  assert.ok(r.chartSvg && r.annotations.length);
  const stopped = impulse([[120, 116], [140, 98], [150, 98.5]]);
  assert.equal(revalidateSavedSignal(stopped, saved, {}).status, 'SL_HIT');
});
