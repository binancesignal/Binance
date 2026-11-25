import test from 'node:test';
import assert from 'node:assert/strict';
import { isNested, pairDoubleObs, sortSetups, findDoubleObs } from '../lib/doubleOb/detect.js';

const T0 = 1_700_000_000;
const candle = (i, o, h, l, c, v = 100) => ({ time: T0 + i * 3600, open: o, high: h, low: l, close: c, volume: v });
const ob = (type, high, low, index, extra = {}) => ({ type, high, low, mid: (high + low) / 2, avg: (high + low) / 2, index, confBar: index + 5, time: T0 + index * 3600, mitigatedAt: null, tests: 0, ...extra });

/** 80 flat-ish candles around `base`, last close = `last` */
function flat(base, last, n = 80) {
  const cs = [];
  for (let i = 0; i < n; i++) cs.push(candle(i, base, base + 0.5, base - 0.5, i === n - 1 ? last : base));
  return cs;
}

test('nested: same direction, inner later + smaller + inside outer', () => {
  const outer = ob('bearish', 110, 100, 20);
  assert.equal(isNested(outer, ob('bearish', 108, 103, 30)), true);
  assert.equal(isNested(outer, ob('bullish', 108, 103, 30)), false, 'other direction');
  assert.equal(isNested(outer, ob('bearish', 108, 103, 10)), false, 'inner must be newer');
  assert.equal(isNested(outer, ob('bearish', 120, 103, 30)), false, 'sticks out of the outer one');
  assert.equal(isNested(outer, ob('bearish', 111, 99, 30)), false, 'inner larger than outer');
  assert.equal(isNested(ob('bearish', 110, 100, 20, { mitigatedAt: 25 }), ob('bearish', 108, 103, 30)), false, 'outer already broken before the inner formed');
  assert.equal(isNested(ob('bearish', 110, 100, 20, { mitigatedAt: 60 }), ob('bearish', 108, 103, 30)), true, 'outer broken only later is fine');
});

test('a double OB that price has not come back to is UNMITIGATED; it carries entry + distance', () => {
  const cs = flat(90, 90); // price far below a bearish pair above it
  const obs = [ob('bearish', 110, 100, 20), ob('bearish', 108, 103, 40)];
  const r = pairDoubleObs(obs, cs, { symbol: 'XUSDT', tf: '1h' });
  assert.equal(r.length, 1);
  const s = r[0];
  assert.equal(s.status, 'UNMITIGATED');
  assert.equal(s.side, 'SELL');
  assert.equal(s.mitigation, null);
  assert.equal(s.entry, 105.5);
  assert.ok(s.distPct > 10 && s.proximityPct >= 1 && s.proximityPct < 50);
  assert.equal(s.outer.high, 110);
  assert.equal(s.inner.low, 103);
});

test('price that already traded into the inner block → MITIGATED (touched)', () => {
  const cs = flat(90, 90);
  cs[60] = candle(60, 95, 104, 94, 96); // wick into 103–108
  const r = pairDoubleObs([ob('bearish', 110, 100, 20), ob('bearish', 108, 103, 40)], cs);
  assert.equal(r[0].status, 'MITIGATED');
  assert.equal(r[0].mitigation, 'touched');
  assert.equal(r[0].mitigatedIndex, 60);
});

test('inner block broken through (mitigatedAt set) → MITIGATED (broken)', () => {
  const cs = flat(90, 90);
  const r = pairDoubleObs([ob('bearish', 110, 100, 20), ob('bearish', 108, 103, 40, { mitigatedAt: 70 })], cs);
  assert.equal(r[0].status, 'MITIGATED');
  assert.equal(r[0].mitigation, 'broken');
});

test('old mitigated pairs and old inner blocks are not listed', () => {
  const cs = flat(90, 90, 400);
  cs[100] = candle(100, 95, 104, 94, 96);
  assert.equal(pairDoubleObs([ob('bearish', 110, 100, 20), ob('bearish', 108, 103, 40)], cs).length, 0, 'inner formed > 200 candles ago');
  const cs2 = flat(90, 90, 200);
  cs2[60] = candle(60, 95, 104, 94, 96);
  assert.equal(pairDoubleObs([ob('bearish', 110, 100, 20), ob('bearish', 108, 103, 100)], cs2).length, 1);
  assert.equal(pairDoubleObs([ob('bearish', 110, 100, 20), ob('bearish', 108, 103, 40)], cs2.slice(0, 190).concat(flat(90, 90, 10)), {}).filter((x) => x.status === 'MITIGATED').length <= 1, true);
});

test('bullish pair works the other way round (BUY, zone below price)', () => {
  const cs = flat(120, 120);
  const r = pairDoubleObs([ob('bullish', 100, 90, 20), ob('bullish', 97, 92, 40)], cs);
  assert.equal(r[0].side, 'BUY');
  assert.equal(r[0].status, 'UNMITIGATED');
  assert.equal(r[0].entry, 94.5);
});

test('sorting: waiting first (nearest to the entry on top), then mitigated (most recent first)', () => {
  const list = [
    { status: 'MITIGATED', mitigatedAgo: 30 },
    { status: 'UNMITIGATED', distAtr: 9 },
    { status: 'MITIGATED', mitigatedAgo: 4 },
    { status: 'UNMITIGATED', distAtr: 1.5 },
  ];
  assert.deepEqual(sortSetups(list).map((x) => x.distAtr ?? x.mitigatedAgo), [1.5, 9, 4, 30]);
});

test('findDoubleObs never throws on short / odd input and returns arrays', () => {
  assert.deepEqual(findDoubleObs([]), []);
  assert.deepEqual(findDoubleObs(null), []);
  const cs = [];
  let p = 100;
  for (let i = 0; i < 300; i++) {
    const c = p + Math.sin(i / 7) * 2 + ((i * 37) % 11) / 10 - 0.5;
    cs.push(candle(i, p, Math.max(p, c) + 0.6, Math.min(p, c) - 0.6, c, 100 + ((i * 53) % 29) * 7));
    p = c;
  }
  const r = findDoubleObs(cs, { symbol: 'T', tf: '1h' });
  assert.ok(Array.isArray(r));
  for (const s of r) {
    assert.ok(['UNMITIGATED', 'MITIGATED'].includes(s.status));
    assert.ok(s.inner.high <= s.outer.high * 1.2 && s.inner.low >= s.outer.low * 0.8);
  }
});

test('midGapPct: distance between the two mid lines as % of the outer block height', () => {
  const cs = flat(90, 90);
  // outer 100–110 (mid 105). inner 103–108 → mid 105.5 → gap 0.5 / 10 = 5 %
  const a = pairDoubleObs([ob('bearish', 110, 100, 20), ob('bearish', 108, 103, 40)], cs)[0];
  assert.equal(a.midGapPct, 5);
  // inner 102–108 → mid 105 → exactly the same line
  const b = pairDoubleObs([ob('bearish', 110, 100, 20), ob('bearish', 108, 102, 40)], cs)[0];
  assert.equal(b.midGapPct, 0);
  // inner 106–109 → mid 107.5 → gap 2.5 / 10 = 25 %
  const c = pairDoubleObs([ob('bearish', 110, 100, 20), ob('bearish', 109, 106, 40)], cs)[0];
  assert.equal(c.midGapPct, 25);
});
