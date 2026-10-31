import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartSvg } from '../lib/telegram/chartSvg.js';
import { analyseElliottWave } from '../lib/scanner/engines/elliottWave.js';
import { applyLifecycle } from '../lib/signals/signalLifecycle.js';
import { rangeSince, firstTouchTime } from '../lib/signals/pathRange.js';

/* ---------- synthetic market ---------- */
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** straight legs between the given pivot prices, with a flat noisy lead-in */
function candlesThrough(pivots, perLeg = 10, pad = 40, start = 1_760_000_000, dt = 900) {
  const r = rng(7);
  const out = [];
  let t = start;
  let price = pivots[0];
  const push = (target, wob) => {
    const o = price;
    const c = target + (r() - 0.5) * wob;
    out.push({ time: t, open: o, high: Math.max(o, c) + r() * 0.25, low: Math.min(o, c) - r() * 0.25, close: c, volume: 100 });
    price = c;
    t += dt;
  };
  for (let i = 0; i < pad; i++) push(price + (r() - 0.5) * 0.8, 0.1);
  for (let k = 1; k < pivots.length; k++) {
    for (let j = 1; j <= perLeg; j++) push(pivots[k - 1] + ((pivots[k] - pivots[k - 1]) * j) / perLeg, 0.3);
  }
  return out;
}
const BEAR_IMPULSE = [110, 100, 106, 90, 96, 84, 88, 86];
const candles = candlesThrough(BEAR_IMPULSE);
const last = candles[candles.length - 1];
const iso = (sec) => new Date(sec * 1000).toISOString();
const tAgo = (n) => candles[candles.length - n].time;

const baseSignal = {
  signal_id: 'T1', symbol: 'TESTUSDT', direction: 'SHORT', status: 'ONGOING',
  entry: 88, sl: 92, tp1: 82, tp2: 78, tp3: 74, current_price: last.close,
  metadata: { strategy: 'crypto_confluence', cryptoConfluence: { elliott: { enabled: true } } },
};
const render = (sig, cs = candles) => buildChartSvg(sig, cs, { tf: '15m', visible: 80 }).svg;
const PLOT_X1 = 876;

/** x of the first vertical lifecycle line drawn in `stroke` + its pill rect */
function marker(svg, stroke, key) {
  const line = svg.match(new RegExp(`<line x1="([\\d.]+)" y1="[\\d.]+" x2="[\\d.]+" y2="[\\d.]+" stroke="${stroke}" stroke-width="(2\\.4|3\\.2)"`));
  const pill = svg.match(new RegExp(`<rect x="([\\d.]+)"[^>]*width="([\\d.]+)"[^>]*/><text[^>]*>(?:&lt; )?${key} `));
  return { x: line ? +line[1] : null, pill: pill ? [+pill[1], +pill[1] + +pill[2]] : null, pinned: new RegExp(`&lt; ${key} `).test(svg) };
}

/* ---------- A) READY / ONGOING lines ---------- */
test('READY (yellow) and ONGOING (green) lines are drawn from ISO stamps', () => {
  const svg = render({ ...baseSignal, ready_at: iso(tAgo(8)), entry_hit_at: iso(tAgo(4)) });
  const r = marker(svg, '#facc15', 'READY');
  const o = marker(svg, '#0ecb81', 'ONGOING');
  assert.ok(r.x != null && o.x != null, 'both lines present');
  assert.ok(o.x > r.x, 'ONGOING is to the right of READY');
  assert.ok(!r.pinned && !o.pinned, 'not pinned to the left edge');
  assert.match(svg, /stroke="#facc15" stroke-width="2.4" stroke-dasharray="7 5"/);
});

test('lifecycle stamps given as epoch seconds / ms (number or string) land on the right candle', () => {
  const ref = marker(render({ ...baseSignal, ready_at: iso(tAgo(8)), entry_hit_at: iso(tAgo(4)) }), '#facc15', 'READY').x;
  for (const [name, mk] of [
    ['epoch s', (s) => s],
    ['epoch ms', (s) => s * 1000],
    ['epoch ms string', (s) => String(s * 1000)],
    ['epoch s string', (s) => String(s)],
    ['postgres +00', (s) => iso(s).replace('T', ' ').replace('Z', '+00')],
    ['tz-less (UTC)', (s) => iso(s).replace('Z', '')],
  ]) {
    const svg = render({ ...baseSignal, ready_at: mk(tAgo(8)), entry_hit_at: mk(tAgo(4)) });
    const r = marker(svg, '#facc15', 'READY');
    assert.equal(r.x, ref, `${name}: READY x`);
    assert.ok(!r.pinned, `${name}: not pinned left`);
    assert.ok(marker(svg, '#0ecb81', 'ONGOING').x != null, `${name}: ONGOING drawn`);
  }
});

test('candles delivered in milliseconds still place the lines correctly', () => {
  const ms = candles.map((c) => ({ ...c, time: c.time * 1000 }));
  const svg = render({ ...baseSignal, ready_at: iso(tAgo(8)), entry_hit_at: iso(tAgo(4)) }, ms);
  assert.ok(!marker(svg, '#facc15', 'READY').pinned);
  assert.equal(marker(svg, '#facc15', 'READY').x, marker(render({ ...baseSignal, ready_at: iso(tAgo(8)), entry_hit_at: iso(tAgo(4)) }), '#facc15', 'READY').x);
});

test('a transition inside the still-forming candle is drawn (right of the last closed candle), not skipped', () => {
  const forming = last.time + 600; // 10 min into the candle that is not in the closed-candle feed
  const svg = render({ ...baseSignal, ready_at: iso(forming - 120), entry_hit_at: iso(forming) });
  const r = marker(svg, '#facc15', 'READY');
  const o = marker(svg, '#0ecb81', 'ONGOING');
  assert.ok(r.x != null && o.x != null);
  const lastCandleX = marker(render({ ...baseSignal, ready_at: iso(last.time), entry_hit_at: iso(last.time) }), '#facc15', 'READY').x;
  assert.ok(r.x > lastCandleX - 4, 'right of / on the last candle');
});

test('ONGOING / STOPPED / COMPLETED_PROFIT without entry_hit_at still show an ONGOING line', () => {
  for (const status of ['ONGOING', 'STOPPED', 'COMPLETED_PROFIT']) {
    const svg = render({ ...baseSignal, status, ready_at: iso(tAgo(8)) });
    assert.ok(marker(svg, '#0ecb81', 'ONGOING').x != null, `${status}: ONGOING line`);
    assert.ok(marker(svg, '#facc15', 'READY').x != null, `${status}: READY line`);
  }
  // only created_at known
  const svg = render({ ...baseSignal, created_at: iso(tAgo(8)) });
  assert.ok(marker(svg, '#0ecb81', 'ONGOING').x != null);
});

test('READY and ONGOING on the same candle are offset so both stay visible; labels stay inside the plot', () => {
  const stamp = iso(tAgo(4));
  const svg = render({ ...baseSignal, ready_at: stamp, entry_hit_at: stamp });
  const r = marker(svg, '#facc15', 'READY');
  const o = marker(svg, '#0ecb81', 'ONGOING');
  assert.notEqual(r.x, o.x);
  for (const m of [r, o]) {
    assert.ok(m.pill[0] >= 16 && m.pill[1] <= PLOT_X1, `label inside plot: ${m.pill}`);
  }
  // marker right at the right edge → label must not be clipped
  const edge = render({ ...baseSignal, ready_at: iso(last.time + 3000), entry_hit_at: iso(last.time + 3000) });
  for (const [col, key] of [['#facc15', 'READY'], ['#0ecb81', 'ONGOING']]) {
    const m = marker(edge, col, key);
    assert.ok(m.pill[0] >= 16 && m.pill[1] <= PLOT_X1, `edge label inside plot: ${m.pill}`);
  }
});

test('older-than-window stamps are pinned to the left edge with a "<" hint instead of vanishing', () => {
  const svg = render({ ...baseSignal, ready_at: iso(candles[0].time - 86400), entry_hit_at: iso(candles[0].time - 80000) });
  assert.ok(marker(svg, '#facc15', 'READY').pinned);
});

/* ---------- B) Elliott Wave on crypto_confluence ---------- */
test('engine: zigzag mode finds the textbook bearish impulse even after the bounce off wave 5', () => {
  assert.equal(analyseElliottWave(candles).primaryCount, null, 'legacy picker misses it (the old bug)');
  const pc = analyseElliottWave(candles, { zigzag: true }).primaryCount;
  assert.ok(pc);
  assert.equal(pc.type, 'IMPULSE');
  assert.equal(pc.direction, 'bearish');
  assert.deepEqual(pc.pivots.map((p) => p.label), ['0', '1', '2', '3', '4', '5']);
  assert.ok(pc.pivots.every((p) => Number.isFinite(p.time)), 'pivots carry candle time');
  assert.ok(Number.isFinite(pc.invalidation));
});

test('crypto_confluence chart draws the purple 0-5 path, EW tag and invalidation line', () => {
  // metadata exactly like the old scanner wrote it: label only, NO pivots
  const svg = render({ ...baseSignal, status: 'READY', ready_at: iso(tAgo(6)), metadata: { strategy: 'crypto_confluence', cryptoConfluence: { elliott: { enabled: true, label: 'Potential Wave 5 down', bonus: 7 } } } });
  assert.match(svg, /<path d="M[^"]*" fill="none" stroke="#a78bfa" stroke-width="2.4"/);
  for (const l of ['0', '1', '2', '3', '4', '5']) assert.match(svg, new RegExp(`<rect[^>]*fill="#7c3aed"[^>]*/><text[^>]*>${l}</text>`), `pivot ${l}`);
  assert.match(svg, /EW IMPULSE · bearish · W5 · \d+%/);
  assert.match(svg, /EW invalidation [\d.]+/);
  assert.match(svg, /Elliott/); // legend
});

test('stored pivots (by time) are drawn even when they come from a different scan window', () => {
  const pc = analyseElliottWave(candles, { zigzag: true }).primaryCount;
  const stored = {
    enabled: true, type: pc.type, direction: pc.direction, currentWave: 5, confidence: pc.confidence, invalidation: pc.invalidation,
    pivots: pc.pivots.map((p) => ({ label: p.label, price: p.price, time: p.time, i: p.i + 999 })), // index is meaningless here
  };
  const svg = render({ ...baseSignal, metadata: { strategy: 'crypto_confluence', cryptoConfluence: { elliott: stored } } });
  assert.match(svg, /stroke="#a78bfa" stroke-width="2.4"/);
  assert.match(svg, /EW IMPULSE/);
});

test('EW is soft: disabled → nothing drawn; no clean count → small tag; corrupt data → chart still renders', () => {
  assert.doesNotMatch(render({ ...baseSignal, metadata: { strategy: 'crypto_confluence', cryptoConfluence: { elliott: { enabled: false } } } }), /EW IMPULSE|stroke-width="2.4"/);
  const flat = candlesThrough([100, 100.2, 99.9, 100.1, 100, 100.2, 100], 8);
  const svgFlat = render({ ...baseSignal, entry: 100, sl: 101, tp1: 99, tp2: 98, tp3: 97 }, flat);
  assert.match(svgFlat, /EW no clear count/);
  const bad = candles.map((c) => ({ ...c })); bad[50].high = NaN;
  assert.ok(render(baseSignal, bad).startsWith('<svg'));
  // other strategies without EW metadata are untouched
  assert.doesNotMatch(render({ ...baseSignal, metadata: { strategy: 'ict_smc' } }), /EW IMPULSE|EW no clear/);
});

test('bullish impulse on a LONG is drawn too', () => {
  const cs = candlesThrough([80, 90, 84, 100, 94, 106, 102, 103]);
  const svg = render({ ...baseSignal, direction: 'LONG', entry: 100, sl: 96, tp1: 106, tp2: 110, tp3: 114, current_price: cs[cs.length - 1].close }, cs);
  assert.match(svg, /EW IMPULSE · bullish · W5/);
});

/* ---------- C) READY → ONGOING when entry was traded through ---------- */
const MIN5 = 5 * 60 * 1000;
const t0 = Date.UTC(2026, 9, 25, 10, 0, 0);
const c5 = (i, o, h, l, cl) => ({ time: (t0 + i * MIN5) / 1000, open: o, high: h, low: l, close: cl });
const readyShort = {
  signal_id: 'XUSDT_SHORT_CC', symbol: 'XUSDT', direction: 'SHORT', status: 'READY',
  entry: 100, sl: 103, tp1: 96, tp2: 93, tp3: 90,
  created_at: new Date(t0).toISOString(), ready_at: new Date(t0).toISOString(),
  metadata: { strategy: 'crypto_confluence' },
};

test('READY whose entry was traded through but price has since left the entry band → ONGOING with the real fill time', () => {
  const path = [c5(0, 99, 99.4, 98.8, 99.2), c5(1, 99.2, 100.3, 99.1, 100.1), c5(2, 100.1, 100.2, 98.4, 98.6), c5(3, 98.6, 98.9, 98.0, 98.2)];
  const now = new Date(t0 + 4 * MIN5);
  const readyRange = rangeSince(path, t0, MIN5);
  const entryTouchAt = firstTouchTime(path, 100, t0, MIN5);
  assert.equal(entryTouchAt, path[1].time);
  const res = applyLifecycle(readyShort, 98.2, 1, now, { high: 98.9, low: 98.0 }, null, { preEntryRange: readyRange, readyRange, entryTouchAt });
  assert.equal(res.nextStatus, 'ONGOING');
  assert.equal(res.updates.status, 'ONGOING');
  assert.equal(res.updates.entry_hit_at, new Date(entryTouchAt * 1000).toISOString());
});

test('READY stays READY when entry was never traded through after READY', () => {
  const path = [c5(0, 98.5, 99.0, 98.2, 98.7), c5(1, 98.7, 99.1, 98.4, 98.9), c5(2, 98.9, 99.2, 98.5, 99.0)];
  const readyRange = rangeSince(path, t0, MIN5);
  const res = applyLifecycle(readyShort, 99.0, 1, new Date(t0 + 3 * MIN5), { high: 99.2, low: 98.5 }, null, { preEntryRange: readyRange, readyRange, entryTouchAt: null });
  assert.equal(res.nextStatus, 'READY');
});
