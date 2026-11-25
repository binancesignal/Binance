import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findHarmonicEvents,
  revalidateSavedSignal,
  buildHarmonicChartSvg,
  normalizeHsScanConfig,
} from '../lib/scanner/strategy/harmonicScan/index.js';
import {
  rsiSeries,
  xIsLegExtreme,
  detectXDDivergence,
  resolveDivergence,
  divergenceStatusOk,
} from '../lib/scanner/strategy/harmonicScan/divergence.js';

// ───────────────────────────── helpers ─────────────────────────────
function legs(points, bars) {
  const out = [points[0]];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    const n = bars[k - 1];
    for (let i = 1; i <= n; i++) out.push(a + ((b - a) * i) / n);
  }
  return out;
}
const toCandles = (closes, w = 0.3) =>
  closes.map((c, i) => ({ time: 1_700_000_000 + i * 900, open: c + 0.02, high: c + w, low: c - w, close: c, volume: 1 }));

// bullish Gartley-ish XABC (X = 100 low) with a chosen run-up before X
function bullPattern(pre) {
  const pat = legs([100, 110, 103.82, 108.2, 105.5], [10, 6, 5, 7]);
  return [...Array.from({ length: 60 }, () => pre[0]), ...pre, ...pat];
}
const downPre = legs([125, 100.6], [30]); // 30-bar sell-off ending at X  → X is the BOTTOM of a down-leg
const flatPre = Array.from({ length: 30 }, (_, i) => 100.6 + (i % 2 ? 0.2 : 0)); // plateau → no leg
const risePre = legs([90, 100.6], [30]); // rising into X → lower lows exist before X
const mirror = (closes) => closes.map((c) => 200 - c); // bullish → bearish mirror

const BASE = { minScore: 40, maxPointAgeBars: 80, swingLeft: 2, swingRight: 2, includeProjected: true, includeCompleted: true };

// ───────────────────────────── RSI ─────────────────────────────
test('RSI: all-up = 100, flat = 50, mixed stays between 0 and 100', () => {
  const up = toCandles(Array.from({ length: 40 }, (_, i) => 100 + i));
  assert.equal(rsiSeries(up, 14)[39], 100);
  const flat = toCandles(Array.from({ length: 40 }, () => 100));
  assert.equal(rsiSeries(flat, 14)[39], 50);
  const mixed = toCandles(Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 5));
  for (const v of rsiSeries(mixed, 14)) if (v != null) assert.ok(v >= 0 && v <= 100);
  assert.equal(rsiSeries(up, 14)[5], null);
});

// ───────────────────────────── X at the extreme of the leg ─────────────────────────────
test('leg check: bullish needs X = bottom of a down-leg; bearish needs X = top of an up-leg', () => {
  const down = toCandles([...Array.from({ length: 60 }, () => 125), ...downPre]);
  const xi = down.length - 1;
  const r = xIsLegExtreme(down, { i: xi, price: down[xi].low }, 'LONG', { legLookbackBars: 40, legMinAtr: 3 });
  assert.equal(r.ok, true);
  assert.ok(r.legSizeAtr > 3);

  // mirrored: up-leg into X (a swing HIGH) → bearish
  const up = toCandles(mirror([...Array.from({ length: 60 }, () => 125), ...downPre]));
  const ri = up.length - 1;
  assert.equal(xIsLegExtreme(up, { i: ri, price: up[ri].high }, 'SHORT', {}).ok, true);

  // wrong direction: a LONG pattern whose X is NOT the bottom (lower low before X)
  const rise = toCandles([...Array.from({ length: 60 }, () => 90), ...risePre]);
  const wi = rise.length - 1;
  const bad = xIsLegExtreme(rise, { i: wi, price: rise[wi].low }, 'LONG', {});
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /lower low/);

  // leg too small
  const tiny = toCandles(Array.from({ length: 80 }, (_, i) => 100.4 - i * 0.002));
  assert.equal(xIsLegExtreme(tiny, { i: 79, price: tiny[79].low }, 'LONG', { legMinAtr: 3 }).ok, false);
});

test('requireLegX filters real harmonic scans (bullish AND bearish mirror); D beyond X never matters', () => {
  for (const mir of [false, true]) {
    const f = (closes) => toCandles(mir ? mirror(closes) : closes);
    const withLeg = f(bullPattern(downPre));
    const flat = f(bullPattern(flatPre));
    const rising = f(bullPattern(risePre));

    // sanity: the plain scan finds the pattern on all three (filter OFF)
    for (const c of [withLeg, flat, rising]) assert.ok(findHarmonicEvents(c, BASE).length > 0, 'fixture must contain a harmonic');

    const on = (c) => findHarmonicEvents(c, { ...BASE, requireLegX: true });
    const kept = on(withLeg);
    assert.ok(kept.length > 0, 'pattern with a leg into X must be kept');
    assert.ok(kept.every((e) => e.direction === (mir ? 'SHORT' : 'LONG') && e.legX?.ok && e.legX.legSizeAtr > 3));
    assert.equal(on(flat).length, 0, 'no leg before X → dropped');
    assert.equal(on(rising).length, 0, 'X is not the extreme → dropped');
  }
  // default is OFF → nothing changes for existing users
  assert.equal(normalizeHsScanConfig({}).requireLegX, false);
  assert.equal(normalizeHsScanConfig({ requireLegX: true }).requireLegX, true);
  assert.equal(normalizeHsScanConfig({ requireLegX: 'true' }).requireLegX, true);
});

// ───────────────────────────── divergence (cheat-sheet) ─────────────────────────────
function pathCandles(parts, start = 100) {
  let p = start;
  const cl = [p];
  for (const [n, d] of parts) for (let i = 0; i < n; i++) cl.push((p += d));
  return cl.map((c, i) => ({ time: 1_700_000_000 + i * 900, open: c, high: c + 0.05, low: c - 0.05, close: c, volume: 1 }));
}
const wiggle = (n, a) => Array.from({ length: n }, (_, i) => [1, i % 2 ? -a : a]);
const wiggleDown = (n, a) => wiggle(n, -a); // exact mirror of wiggle() so bullish cases are true mirrors of the bearish ones
function run(dir, parts, xFn) {
  const candles = pathCandles(parts);
  const bear = dir === 'SHORT';
  const cI = xFn.cI(candles);
  let xI = xFn.start;
  for (let i = xFn.start; i < cI; i++) if (bear ? candles[i].high > candles[xI].high : candles[i].low < candles[xI].low) xI = i;
  const X = { i: xI, price: bear ? candles[xI].high : candles[xI].low };
  const C = { i: cI, price: bear ? candles[cI].low : candles[cI].high };
  const ev = { direction: dir, status: 'ENTRY_READY', X, C };
  return { candles, ev, div: detectXDDivergence(candles, ev), rsi: rsiSeries(candles, 14) };
}

test('divergence cheat-sheet: regular bearish / hidden bearish / regular bullish / hidden bullish', () => {
  // REGULAR BEARISH: price higher high, RSI lower high
  let r = run('SHORT', [...wiggle(60, 0.3), [8, 1.5], [6, -1.0], [17, 0.4]], { start: 60, cI: () => 60 + 14 });
  assert.equal(r.div.type, 'REGULAR_BEARISH');
  assert.ok(r.div.dPrice > r.div.xPrice && r.div.dRsi < r.div.xRsi);
  assert.equal(r.div.kind, 'REGULAR');
  assert.equal(r.div.bias, 'BEARISH');

  // REGULAR BULLISH: price lower low, RSI higher low
  r = run('LONG', [...wiggleDown(60, 0.3), [8, -1.5], [6, 1.0], [17, -0.4]], { start: 60, cI: () => 60 + 14 });
  assert.equal(r.div.type, 'REGULAR_BULLISH');
  assert.ok(r.div.dPrice < r.div.xPrice && r.div.dRsi > r.div.xRsi);

  // HIDDEN BEARISH: price lower high, RSI higher high
  const hb = [...wiggle(60, 0.3), ...Array.from({ length: 40 }, () => [[1, 0.8], [1, -0.9]]).flat(), [1, -0.3], [1, 4]];
  r = run('SHORT', hb, { start: 60, cI: () => 60 + 80 + 1 });
  assert.equal(r.div.type, 'HIDDEN_BEARISH');
  assert.ok(r.div.dPrice < r.div.xPrice && r.div.dRsi > r.div.xRsi);
  assert.equal(r.div.kind, 'HIDDEN');

  // HIDDEN BULLISH (mirror): price higher low, RSI lower low
  const hu = [...wiggleDown(60, 0.3), ...Array.from({ length: 40 }, () => [[1, -0.8], [1, 0.9]]).flat(), [1, 0.3], [1, -4]];
  r = run('LONG', hu, { start: 60, cI: () => 60 + 80 + 1 });
  assert.equal(r.div.type, 'HIDDEN_BULLISH');
  assert.ok(r.div.dPrice > r.div.xPrice && r.div.dRsi < r.div.xRsi);
});

test('no divergence when price and RSI agree, or D not reached yet; result is marked as judged', () => {
  // price higher high AND RSI higher high → confirms the move, not a divergence
  const candles = pathCandles([...wiggle(60, 0.3), [6, 1.0], [3, -0.3], [8, 2.5]]);
  const cI = 60 + 9;
  let xI = 60;
  for (let i = 60; i < cI; i++) if (candles[i].high > candles[xI].high) xI = i;
  const ev = { direction: 'SHORT', status: 'ENTRY_READY', X: { i: xI, price: candles[xI].high }, C: { i: cI, price: candles[cI].low } };
  const d = detectXDDivergence(candles, ev);
  assert.equal(d.found, false);
  assert.ok(d.evaluatedAt > 0);

  // nothing after C yet
  const early = detectXDDivergence(candles.slice(0, cI + 1), ev);
  assert.equal(early.found, false);
  assert.match(early.reason, /not reached/);
});

test('divergence is judged only near / at D, then FROZEN (status gate + resolveDivergence)', () => {
  assert.equal(divergenceStatusOk('WAITING'), false);
  assert.equal(divergenceStatusOk('WATCHING'), false);
  assert.equal(divergenceStatusOk('MISSED'), false);
  assert.equal(divergenceStatusOk('ENTRY_READY'), true);
  assert.equal(divergenceStatusOk('IN_TRADE'), true);
  assert.equal(divergenceStatusOk('TP1_HIT'), true);

  const r = run('SHORT', [...wiggle(60, 0.3), [8, 1.5], [6, -1.0], [17, 0.4]], { start: 60, cI: () => 60 + 14 });
  // WAITING → nothing yet
  assert.equal(resolveDivergence(r.candles, { ...r.ev, status: 'WAITING' }, undefined), undefined);
  // ENTRY_READY → judged
  const first = resolveDivergence(r.candles, r.ev, undefined);
  assert.equal(first.type, 'REGULAR_BEARISH');
  // later (even if the picture changed) the judged result is kept as-is
  const later = resolveDivergence(r.candles.slice(0, -5), { ...r.ev, status: 'IN_TRADE' }, first);
  assert.equal(later, first);
});

// ───────────────────────────── chart + saved signal flow ─────────────────────────────
test('SVG chart gets an RSI pane and draws the divergence on RSI and on price', () => {
  const r = run('SHORT', [...wiggle(60, 0.3), [8, 1.5], [6, -1.0], [17, 0.4]], { start: 60, cI: () => 60 + 14 });
  const ev = {
    kind: 'PROJECTED', status: 'ENTRY_READY', family: 'BAT', label: 'Bat', direction: 'SHORT', score: 70,
    X: { ...r.ev.X, time: r.candles[r.ev.X.i].time }, A: { i: 63, price: 108, time: r.candles[63].time },
    B: { i: 66, price: 111, time: r.candles[66].time }, C: { ...r.ev.C, time: r.candles[r.ev.C.i].time },
    D: { i: null, price: 113, time: null }, entry: 113, przLow: 112.8, przHigh: 113.2, price: 112.9,
    plan: { entry: 113, sl: 114, tp1: 111, tp2: 110, tp3: 109 }, divergence: r.div,
  };
  const svg = buildHarmonicChartSvg(r.candles, ev, { symbol: 'TESTUSDT', tf: '15m' });
  assert.match(svg, /RSI 14/);
  assert.match(svg, /Regular bearish divergence/);
  const noRsi = buildHarmonicChartSvg(r.candles, ev, { symbol: 'TESTUSDT', tf: '15m', rsi: false });
  assert.ok(!/RSI 14/.test(noRsi));
  // no divergence found → says so
  const none = buildHarmonicChartSvg(r.candles, { ...ev, divergence: { ...r.div, found: false, none: true, type: undefined, label: undefined } }, { symbol: 'T', tf: '15m' });
  assert.match(none, /No X–D divergence/);
});

test('revalidate: judges divergence once the signal reaches the D zone, then keeps it unchanged', () => {
  const base = toCandles(bullPattern(downPre));
  const ev = findHarmonicEvents(base, BASE).find((e) => e.kind === 'PROJECTED');
  assert.ok(ev, 'projected event expected');
  assert.equal(ev.divergence, undefined, 'not near D yet → no divergence judged');

  // price now slides to the D zone → ENTRY_READY / IN_TRADE
  const lastClose = base[base.length - 1].close;
  const slide = legs([lastClose, ev.entry + 0.1], [8]).slice(1);
  const ext = toCandles([...base.map((c) => c.close), ...slide]);
  const saved = { ...ev, symbol: 'TESTUSDT', tf: '15m', id: 'x' };
  const r1 = revalidateSavedSignal(ext, saved, BASE);
  assert.ok(['ENTRY_READY', 'IN_TRADE'].includes(r1.status), `status ${r1.status}`);
  assert.ok(r1.divergence && r1.divergence.evaluatedAt > 0, 'divergence judged at entry-ready');
  assert.match(r1.chartSvg, /RSI 14/);

  // next refresh: frozen
  const ext2 = toCandles([...ext.map((c) => c.close), ev.entry + 0.3, ev.entry + 0.6]);
  const r2 = revalidateSavedSignal(ext2, { ...r1, chartSvg: undefined, annotations: undefined }, BASE);
  assert.deepEqual(r2.divergence, r1.divergence);
});
