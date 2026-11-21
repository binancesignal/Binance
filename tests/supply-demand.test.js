import test from 'node:test';
import assert from 'node:assert/strict';
import { rmaAtr, findSupplyDemandZones, matchSupplyDemand } from '../lib/doubleOb/supplyDemand.js';

const T0 = 1_700_000_000 - (1_700_000_000 % 86400); // 00:00 UTC
const mk = (i, o, h, l, c) => ({ time: T0 + i * 900, open: o, high: h, low: l, close: c }); // 15m candles, 00:00 UTC start

/** quiet range 100 ± 1, with one clean spike HIGH at index `at` */
function withSpike(n, at, spike) {
  const cs = [];
  for (let i = 0; i < n; i++) {
    const up = i % 2;
    cs.push(mk(i, up ? 99.6 : 100.2, 100.6, 99.4, up ? 100.2 : 99.6));
  }
  cs[at] = mk(at, 100, spike, 99.8, 100.1);
  return cs;
}

test('rmaAtr: NaN until `len` candles, then Wilder smoothing', () => {
  const cs = withSpike(60, 40, 104);
  const a = rmaAtr(cs, 20);
  assert.ok(Number.isNaN(a[18]));
  assert.ok(a[19] > 0);
  assert.ok(Math.abs(a[19] - 1.2) < 0.2, 'quiet candles are ~1.2 tall');
  assert.ok(a[59] > 0);
});

test('a pivot high creates a SUPPLY zone exactly 1.0 × ATR tall, centred on the pivot candle', () => {
  const cs = withSpike(120, 50, 104);
  const zones = findSupplyDemandZones(cs);
  const z = zones.find((x) => x.type === 'supply' && x.startIndex === 50);
  assert.ok(z, 'supply zone at the spike');
  const atrAtCreate = rmaAtr(cs, 20)[z.createdIndex];
  assert.ok(Math.abs(z.top - z.bottom - atrAtCreate) < 1e-9);
  assert.ok(Math.abs((z.top + z.bottom) / 2 - (104 + 99.8) / 2) < 1e-9);
  assert.equal(z.createdIndex, 62, 'confirmed swingLen (12) candles later');
});

test('supply zone is broken when a candle CLOSES above it; wick alone does not break it (Close method)', () => {
  const cs = withSpike(130, 50, 104);
  cs[90] = mk(90, 100, 108, 99.5, 100.4); // wick only
  let z = findSupplyDemandZones(cs).find((x) => x.startIndex === 50);
  assert.equal(z.broken, false);
  cs[100] = mk(100, 100, 110, 99.9, 109); // close above
  z = findSupplyDemandZones(cs).find((x) => x.startIndex === 50);
  assert.equal(z.broken, true);
  assert.equal(z.brokenIndex, 100);
  const w = findSupplyDemandZones(cs, { invalidation: 'Wick' }).find((x) => x.startIndex === 50);
  assert.equal(w.brokenIndex, 90, 'with the Wick method the first wick breaks it');
});

test('a new pivot closer than 44 bars to the last zone is ignored', () => {
  const cs = withSpike(140, 50, 104);
  cs[70] = mk(70, 100, 104.2, 99.8, 100.1); // second spike only 20 bars later
  const supply = findSupplyDemandZones(cs).filter((x) => x.type === 'supply');
  assert.equal(supply.filter((x) => x.startIndex === 70).length, 0);
});

test('the "Other" session (UTC 22–24) creates no zones', () => {
  const cs = withSpike(120, 50, 104);
  const shift = 22 * 3600; // move the whole series so the confirming candle opens at 22:xx UTC
  const late = cs.map((c) => ({ ...c, time: c.time + shift - ((62 * 900) % 86400) }));
  const hourOfConfirm = new Date(late[62].time * 1000).getUTCHours();
  assert.equal(hourOfConfirm, 22);
  assert.equal(findSupplyDemandZones(late).filter((x) => x.startIndex === 50).length, 0);
});

test('match: red (bearish) double OB needs a SUPPLY zone touching it; green needs DEMAND', () => {
  const zones = [
    { type: 'supply', top: 108, bottom: 104, startIndex: 10, startTime: 1, brokenIndex: null, brokenTime: null },
    { type: 'demand', top: 96, bottom: 92, startIndex: 12, startTime: 2, brokenIndex: null, brokenTime: null },
  ];
  const bearish = { type: 'bearish', status: 'UNMITIGATED', outer: { high: 110, low: 100 }, inner: { high: 108, low: 103 } };
  const m = matchSupplyDemand(bearish, zones, []);
  assert.equal(m.type, 'SUPPLY');
  assert.equal(m.touchesInner, true);
  // not touching
  assert.equal(matchSupplyDemand({ ...bearish, outer: { high: 130, low: 120 }, inner: { high: 128, low: 122 } }, zones, []), null);
  // a bullish OB is NOT confirmed by a supply zone
  assert.equal(matchSupplyDemand({ type: 'bullish', status: 'UNMITIGATED', outer: { high: 110, low: 100 }, inner: { high: 108, low: 103 } }, zones, []), null);
  assert.equal(matchSupplyDemand({ type: 'bullish', status: 'UNMITIGATED', outer: { high: 97, low: 90 }, inner: { high: 95, low: 93 } }, zones, []).type, 'DEMAND');
  // touching the outer OB only
  const outerOnly = matchSupplyDemand({ type: 'bearish', status: 'UNMITIGATED', outer: { high: 112, low: 100 }, inner: { high: 111, low: 109 } }, zones, []);
  assert.equal(outerOnly.touchesOuter, true);
  assert.equal(outerOnly.touchesInner, false);
});

test('match: a waiting setup ignores a broken zone; a mitigated setup accepts a zone that broke AFTER it', () => {
  const broken = [{ type: 'supply', top: 108, bottom: 104, startIndex: 10, startTime: 1, brokenIndex: 80, brokenTime: 2 }];
  const wait = { type: 'bearish', status: 'UNMITIGATED', outer: { high: 110, low: 100 }, inner: { high: 108, low: 103 } };
  assert.equal(matchSupplyDemand(wait, broken, []), null);
  const done = { ...wait, status: 'MITIGATED', mitigatedIndex: 60 };
  assert.equal(matchSupplyDemand(done, broken, []).type, 'SUPPLY');
  assert.equal(matchSupplyDemand({ ...done, mitigatedIndex: 90 }, broken, []), null, 'zone was already dead when the OB was mitigated');
});
