import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VP_DEFAULTS,
  computeVolumeProfile,
  findPeakNodes,
  peaksInBreakers,
} from '../lib/scanner/strategy/harmonicScan/volumeProfile.js';

// 400 bars drifting between 100 and 110, but ONE price band (104–105) trades a huge volume
function series() {
  const out = [];
  for (let i = 0; i < 400; i++) {
    const wave = 105 + Math.sin(i / 9) * 5; // 100..110
    const o = wave - 0.2;
    const c = wave + 0.2;
    out.push({ time: 1_700_000_000 + i * 3600, open: o, high: wave + 0.6, low: wave - 0.6, close: c, volume: 100 });
  }
  // heavy bars parked around 104.5
  for (let i = 300; i < 340; i++) {
    out[i] = { ...out[i], open: 104.4, close: 104.6, high: 104.9, low: 104.1, volume: 5000 };
  }
  return out;
}

test('defaults are the LuxAlgo indicator defaults', () => {
  assert.deepEqual({ ...VP_DEFAULTS }, { length: 360, rows: 100, valueAreaPct: 70, peakNodePct: 9, thresholdPct: 1 });
});

test('profile covers the last 360 bars, 100 rows, and POC sits on the heavy band', () => {
  const p = computeVolumeProfile(series());
  assert.equal(p.rows, 100);
  assert.equal(p.total.length, 100);
  assert.equal(p.startIndex, 40);
  const pocPrice = p.low + (p.pocLevel + 0.5) * p.step;
  assert.ok(pocPrice > 104 && pocPrice < 105.2, `poc ${pocPrice}`);
  assert.ok(p.valLevel <= p.pocLevel && p.vahLevel >= p.pocLevel);
});

test('peak nodes: the heavy band is a blue peak and neighbours inside ±9 rows are not', () => {
  const p = computeVolumeProfile(series());
  const peaks = findPeakNodes(p);
  assert.ok(peaks.length >= 1);
  const top = [...peaks].sort((a, b) => b.volume - a.volume)[0];
  assert.equal(top.index, p.pocLevel);
  assert.equal(top.pct, 100);
  for (const q of peaks) {
    if (q === top) continue;
    assert.ok(Math.abs(q.index - top.index) > 9, 'peaks are at least N rows apart');
  }
  assert.ok(top.hi > top.lo);
});

test('no volume / no range → no profile', () => {
  assert.equal(computeVolumeProfile([]), null);
  const same = Array.from({ length: 30 }, (_, i) => ({ time: i, open: 5, high: 5, low: 5, close: 5, volume: 1 }));
  assert.equal(computeVolumeProfile(same), null);
});

test('peaksInBreakers keeps only peaks that overlap a breaker and returns that breaker', () => {
  const peaks = [
    { index: 10, lo: 104, hi: 105, volume: 9, pct: 100 },
    { index: 70, lo: 108, hi: 109, volume: 5, pct: 50 },
  ];
  const brA = { id: 'A', bot: 104.5, top: 106 };
  const brB = { id: 'B', bot: 100, top: 101 };
  const r = peaksInBreakers(peaks, [brA, brB]);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].breakerId, 'A');
  assert.deepEqual(r.breakers.map((b) => b.id), ['A']);
  assert.equal(peaksInBreakers(peaks, [brB]).nodes.length, 0);
});

// ── engine integration: D zone ∩ breaker block ∩ blue volume zone ───────────────────────────
import { findHarmonicEvents, buildHarmonicAnnotations, buildHarmonicChartSvg } from '../lib/scanner/strategy/harmonicScan/index.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}
function gen(seed) {
  const r = rng(seed);
  const out = [];
  let p = 100;
  for (let i = 0; i < 500; i++) {
    const d = Math.sin(i / 14) * 1.2 + (r() - 0.5) * 1.5;
    const o = p;
    const c = Math.max(5, p + d);
    const hi = Math.max(o, c) + r() * 0.8;
    const lo = Math.min(o, c) - r() * 0.8;
    p = c;
    out.push({ time: 1.7e9 + i * 3600, open: o, high: hi, low: lo, close: c, volume: 50 + r() * 400 + (i % 37 === 0 ? 900 : 0) });
  }
  return out;
}
const COMMON = { minScore: 30, requireBreakerInDzone: true, dZoneAtr: 4, breakerPadAtr: 1.5 };

test('rule OFF: no volume nodes on the events (nothing changes)', () => {
  const ev = findHarmonicEvents(gen(1395), COMMON);
  assert.ok(ev.length >= 1);
  assert.ok(ev.every((e) => !e.volumeNodes));
});

test('rule ON keeps only setups whose breaker holds a blue zone, drops the rest', () => {
  const cs = gen(2410);
  assert.equal(findHarmonicEvents(cs, COMMON).length, 2); // two setups have a breaker through D …
  assert.equal(findHarmonicEvents(cs, { ...COMMON, requireVolumeNodeInBreaker: true }).length, 0); // … none has a blue zone in it
  const kept = findHarmonicEvents(gen(1395), { ...COMMON, requireVolumeNodeInBreaker: true });
  assert.equal(kept.length, 1);
  const e = kept[0];
  assert.ok(e.volumeNodeInBreaker && e.volumeNodes.length >= 1);
  for (const n of e.volumeNodes) {
    const br = e.breakers.find((b) => b.id === n.breakerId);
    assert.ok(br, 'node points at a breaker that overlaps D');
    assert.ok(Math.min(n.hi, br.top) - Math.max(n.lo, br.bot) > 0, 'blue zone overlaps the breaker');
  }
});

test('the blue zone is marked on both chart outputs', () => {
  const cs = gen(1395);
  const e = findHarmonicEvents(cs, { ...COMMON, requireVolumeNodeInBreaker: true })[0];
  assert.ok(buildHarmonicAnnotations(e, cs, { tf: '1h' }).some((a) => a.group === 'volume' && a.kind === 'zone'));
  assert.match(buildHarmonicChartSvg(cs, e, { symbol: 'T', tf: '1h' }), /VP PEAK/);
});

test('no peak survives a 100 % threshold → rule ON returns nothing', () => {
  const cs = gen(1395);
  assert.equal(findHarmonicEvents(cs, { ...COMMON, requireVolumeNodeInBreaker: true, volumeProfileCfg: { thresholdPct: 100 } }).length, 0);
});

test('the volume rule switches breaker detection on by itself', () => {
  const cs = gen(1395);
  const ev = findHarmonicEvents(cs, { ...COMMON, enableBreakers: false, requireVolumeNodeInBreaker: true });
  assert.equal(ev.length, 1);
});
