import test from 'node:test';
import assert from 'node:assert/strict';
import {
  revalidateSavedSignal,
  remapSavedPoints,
} from '../lib/scanner/strategy/harmonicScan/index.js';
import {
  harmonicCategory,
  pickBestPerCoin,
  isFinalHarmonicStatus,
} from '../lib/scanner/strategy/harmonicScan/categories.js';

function candles(n, startTime = 1_700_000_000, step = 3600) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ time: startTime + i * step, open: 100, high: 101, low: 99, close: 100, volume: 1 });
  }
  return out;
}

test('remapSavedPoints finds X/A/B/C by candle TIME in a shifted window', () => {
  const all = candles(700);
  const win1 = all.slice(100, 600); // scan window
  const win2 = all.slice(150, 700); // refresh window (shifted by 50 bars, later)
  const pt = (idx) => ({ time: all[idx].time, price: 100, i: idx - 100 });
  const saved = { X: pt(300), A: pt(320), B: pt(340), C: pt(360), direction: 'LONG' };
  const r = remapSavedPoints(win2, saved);
  assert.equal(r.X.i, 300 - 150);
  assert.equal(r.C.i, 360 - 150);
  assert.equal(win2[r.C.i].time, all[360].time);
  assert.ok(win1.length === 500);
});

test('remapSavedPoints returns null when the pattern scrolled out of the window', () => {
  const all = candles(700);
  const win = all.slice(300, 700);
  const saved = { X: { time: all[10].time, i: 10 }, A: { time: all[20].time, i: 20 }, B: { time: all[30].time, i: 30 }, C: { time: all[40].time, i: 40 } };
  assert.equal(remapSavedPoints(win, saved), null);
  assert.equal(revalidateSavedSignal(win, { ...saved, direction: 'LONG', entry: 100 }), null);
});

test('revalidate does not count TP/SL from bars BEFORE the pattern (old index bug)', () => {
  // Window is 1000 bars; the pattern sits near the end, but its stored .i came from a 500-bar scan.
  const all = candles(1000);
  // Bars 0..499 contain a big spike that would "touch" the entry/SL if indexes were misread
  for (let i = 100; i < 200; i++) { all[i].high = 140; all[i].low = 60; }
  const cIdx = 950;
  const saved = {
    kind: 'PROJECTED', direction: 'LONG', family: 'GARTLEY',
    X: { time: all[900].time, price: 90, i: 400 },
    A: { time: all[920].time, price: 110, i: 420 },
    B: { time: all[940].time, price: 100, i: 440 },
    C: { time: all[cIdx].time, price: 107, i: 450 }, // stale index from a 500-bar scan
    entry: 80, przLow: 79, przHigh: 81,
    plan: { entry: 80, sl: 75, tp1: 90, tp2: 95, tp3: 100, rr1: 1, rr2: 2 },
    status: 'WAITING',
  };
  const r = revalidateSavedSignal(all, saved, {});
  assert.ok(r, 'should revalidate');
  assert.equal(r.C.i, cIdx);
  assert.equal(r.entryTouched, false);
  assert.ok(['WAITING', 'ENTRY_READY', 'MISSED'].includes(r.status), `unexpected status ${r.status}`);
});

test('status categories map to admin tabs', () => {
  assert.equal(harmonicCategory('WAITING'), 'watching');
  assert.equal(harmonicCategory('ENTRY_READY'), 'entry_ready');
  assert.equal(harmonicCategory('IN_TRADE'), 'in_trade');
  assert.equal(harmonicCategory('TP1_HIT'), 'tp_hit');
  assert.equal(harmonicCategory('TP3_HIT'), 'tp_hit');
  assert.equal(harmonicCategory('SL_HIT'), 'sl_hit');
  assert.equal(harmonicCategory('MISSED'), 'invalid');
  assert.equal(harmonicCategory('INVALIDATED'), 'invalid');
  assert.equal(isFinalHarmonicStatus('SL_HIT'), true);
  assert.equal(isFinalHarmonicStatus('TP1_HIT'), false);
  assert.equal(isFinalHarmonicStatus('WAITING'), false);
});

test('pickBestPerCoin keeps one signal per coin (live stage, then score, then newest)', () => {
  const items = [
    { id: 'a', symbol: 'BTCUSDT', status: 'SL_HIT', score: 90, time: 1 },
    { id: 'b', symbol: 'BTCUSDT', status: 'WAITING', score: 60, time: 2 },
    { id: 'c', symbol: 'BTCUSDT', status: 'ENTRY_READY', score: 50, time: 3 },
    { id: 'd', symbol: 'ETHUSDT', status: 'WAITING', score: 70, time: 5 },
    { id: 'e', symbol: 'ETHUSDT', status: 'WAITING', score: 80, time: 4 },
    { id: 'f', symbol: 'SOLUSDT', status: 'TP1_HIT', score: 60, time: 1 },
  ];
  const kept = pickBestPerCoin(items).map((x) => x.id).sort();
  assert.deepEqual(kept, ['c', 'e', 'f']);
  assert.equal(pickBestPerCoin([]).length, 0);
});

import { planTick, normalizeScanSettings } from '../lib/harmonicSaved/scanPlan.js';
import { tpLevelOf } from '../lib/scanner/strategy/harmonicScan/categories.js';

test('WATCHING counts as the Watching category', () => {
  assert.equal(harmonicCategory('WATCHING'), 'watching');
});

test('tpLevelOf reads the highest TP reached from the status', () => {
  assert.equal(tpLevelOf({ status: 'TP1_HIT' }), 1);
  assert.equal(tpLevelOf({ status: 'TP2_HIT' }), 2);
  assert.equal(tpLevelOf({ status: 'TP3_HIT' }), 3);
  assert.equal(tpLevelOf({ status: 'WAITING' }), 0);
});

test('scan settings are clamped to safe values', () => {
  const s = normalizeScanSettings({ enabled: true, tfs: ['1h', 'bad'], restMin: 9999, coinsPerTick: 1000 });
  assert.deepEqual(s.tfs, ['1h']);
  assert.equal(s.restMin, 240);
  assert.equal(s.coinsPerTick, 60);
  assert.equal(normalizeScanSettings({}).enabled, false);
});

test('planTick: disabled → skip, fresh → start, mid-pass → continue, rest → skip, pause → skip', () => {
  const base = { enabled: true, restMin: 5, pass: null, lastPassEndedAt: 0, pausedUntil: 0 };
  const now = 1_000_000_000_000;
  assert.equal(planTick({ ...base, enabled: false }, now).action, 'skip');
  assert.equal(planTick(base, now).action, 'start');
  assert.equal(planTick({ ...base, pass: { symbols: ['A', 'B'], idx: 1 } }, now).action, 'continue');
  assert.equal(planTick({ ...base, lastPassEndedAt: now - 60_000 }, now).action, 'skip'); // still resting
  assert.equal(planTick({ ...base, lastPassEndedAt: now - 6 * 60_000 }, now).action, 'start');
  assert.equal(planTick({ ...base, pausedUntil: now + 1000 }, now).action, 'skip'); // ban / rate-guard backoff
  // a finished cursor must not "continue"
  assert.equal(planTick({ ...base, pass: { symbols: ['A'], idx: 1 } }, now).action, 'start');
});

function tradeSetup(mutate) {
  const all = candles(1000);
  const saved = {
    kind: 'PROJECTED', direction: 'LONG', family: 'GARTLEY',
    X: { time: all[900].time, price: 90, i: 900 }, A: { time: all[920].time, price: 110, i: 920 },
    B: { time: all[940].time, price: 100, i: 940 }, C: { time: all[950].time, price: 107, i: 950 },
    entry: 80, przLow: 79, przHigh: 81,
    plan: { entry: 80, sl: 75, tp1: 90, tp2: 95, tp3: 100, rr1: 1, rr2: 2 }, status: 'WAITING',
  };
  // flat 100 candles never touch 79..81, so bar 960 enters the zone and later bars run the trade
  all[960] = { ...all[960], low: 80, high: 82 };
  for (let i = 961; i < all.length; i++) all[i] = { ...all[i], high: 85, low: 83, close: 84 }; // quiet after entry
  mutate(all);
  return revalidateSavedSignal(all, saved, {});
}

test('TP status follows the HIGHEST target reached and TP3 is final', () => {
  const r = tradeSetup((all) => {
    all[961] = { ...all[961], high: 96, low: 85 };  // TP1 + TP2
    all[962] = { ...all[962], high: 91, low: 85 };  // shallower later bar must not lower it
  });
  assert.equal(r.status, 'TP2_HIT');
  assert.equal(r.tpReached, 2);
  const w = tradeSetup((all) => {
    all[961] = { ...all[961], high: 101, low: 85 }; // TP3
    all[962] = { ...all[962], high: 90, low: 70 };  // later dip below SL must not undo the win
  });
  assert.equal(w.status, 'TP3_HIT');
});

test('TP1 reached and then stopped out keeps the TP1 ✅ on the card', () => {
  const r = tradeSetup((all) => {
    all[961] = { ...all[961], high: 91, low: 85 };  // TP1
    all[962] = { ...all[962], high: 88, low: 70 };  // SL
  });
  assert.equal(r.status, 'SL_HIT');
  assert.equal(r.tpReached, 1);
});
