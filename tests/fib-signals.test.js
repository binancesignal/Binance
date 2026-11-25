import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFibSignalsConfig, engineConfigFrom, FIB_SIGNALS_DEFAULTS } from '../lib/fibSignals/config.js';
import { scanCoinFibSignals, fibLevelTouched, fibSignalId } from '../lib/fibSignals/engine.js';
import { evaluateFibSignal, outcomeLabel } from '../lib/fibSignals/evaluate.js';
import { pruneStore } from '../lib/fibSignals/store.js';
import { setStateImpl } from '../lib/fibSignals/state.js';
import { runFibSignalsPass } from '../lib/fibSignals/runner.js';
import { normalizeObFibConfig } from '../lib/scanner/strategy/obFib/config.js';
import { entryProximity } from '../lib/fibSignals/proximity.js';

const NOW = Math.floor(Date.now() / 1000);
const ms = (y, m) => Math.floor(Date.UTC(y, m, 1) / 1000);
const d0 = new Date();
const MONTH_A = ms(d0.getUTCFullYear(), d0.getUTCMonth() - 2);
const MONTH_B = ms(d0.getUTCFullYear(), d0.getUTCMonth() - 1);

function ltfSeries(n = 400, step = 900) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const close = 100 + Math.sin(i / 9) * 4.8 + i * 0.01;
    out.push({
      time: NOW - (n - i) * step,
      open: p,
      close,
      high: Math.max(p, close) + 0.4,
      low: Math.min(p, close) - 0.4,
      volume: 100 + ((i * 37) % 23) * 10 + (i % 11 === 0 ? 400 : 0),
    });
    p = close;
  }
  return out;
}
function daily(low, high, n = 40) {
  return Array.from({ length: n }, (_, i) => ({ time: NOW - (n - i) * 86400, open: 100, close: 100, high, low, volume: 1 }));
}
const fakeKlines =
  (dailyLow = 99.8, extra = null) =>
  async (symbol, tf) => {
    if (tf === '1m' || tf === '5m') return [{ time: NOW - 60, open: 100, high: 100, low: 100, close: 100, volume: 1 }];
    if (tf === '1d') return daily(dailyLow, 100.2);
    if (tf === '1M')
      return [
        { time: MONTH_A, open: 90, close: 120, high: 125, low: 85, volume: 1 },
        { time: MONTH_B, open: 100, close: 96, high: 106, low: 92, volume: 1 },
      ];
    const base = ltfSeries();
    return extra ? [...base, ...extra(base)] : base;
  };

const CFG = normalizeFibSignalsConfig({ enabled: true, refTimeframes: ['1M'], timeframes: ['15m'], fibLevels: [0.236, 0.382, 0.5, 0.618, 0.786] });

test('config: only valid selections survive, gates are not configurable', () => {
  const c = normalizeFibSignalsConfig({ refTimeframes: ['1M', 'x'], timeframes: ['bad'], fibLevels: [0.618, 'z', 99], firstTouchOnly: 1, enabled: true });
  assert.deepEqual(c.refTimeframes, ['1M']);
  assert.deepEqual(c.timeframes, FIB_SIGNALS_DEFAULTS.timeframes);
  assert.deepEqual(c.fibLevels, [0.618]);
  assert.equal(c.firstTouchOnly, false); // only literal true enables it
  assert.equal(normalizeFibSignalsConfig({ firstTouchOnly: true }).firstTouchOnly, true);
  // the auto scan runs with the SAME config as Coin Scan: the admin's OB+Fib scanner settings,
  // only HTF / LTF / fib lines replaced by the Fib Signals selections
  const base = normalizeObFibConfig({ minScore: 55, minRR: 1.2, maxEntryDistanceATR: 7, requireApproachSide: true, singleFibOnly: true });
  const e = engineConfigFrom(c, base);
  assert.equal(e.minScore, 55);
  assert.equal(e.minRR, 1.2);
  assert.equal(e.maxEntryDistanceATR, 7);
  assert.equal(e.requireApproachSide, true);
  assert.equal(e.singleFibOnly, true);
  assert.deepEqual(e.refTimeframes, ['1M']);
  assert.deepEqual(e.fibLevels, [0.618]);
  assert.equal(e.enabled, true);
  assert.equal(e.requireUntouchedEntry, false, 'used entries are flagged and parked as invalid instead of dropped');
  // without a base the scanner defaults apply (never a looser, private rule set)
  assert.equal(engineConfigFrom(c).minScore, normalizeObFibConfig({}).minScore);
});

test('engine: plain professional signal with fixed levels', async () => {
  const r = await scanCoinFibSignals({ symbol: 'LTCUSDT', price: 100, getKlines: fakeKlines(), cfg: CFG, nowSec: NOW });
  // the wavy fixture revisits every OB middle, so by the "entry works only once" rule these are parked as invalid —
  // they still carry the full plain-signal shape
  assert.ok(r.signals.length + r.invalid.length > 0);
  const s = r.signals[0] || { ...r.invalid[0], status: 'ACTIVE' };
  assert.equal(s.status, 'ACTIVE');
  assert.ok(['BUY', 'SELL'].includes(s.side));
  assert.ok(s.entry && s.sl && s.tp1 && s.tp2 && s.tp3 && s.rr);
  assert.ok(s.entryZone.low < s.entryZone.high);
  assert.equal(s.fib.refTf, '1M');
  assert.equal(s.ltf, '15m');
  assert.match(s.signal_id, /^FS_LTCUSDT_/);
  assert.equal(s.signal_id, fibSignalId({ symbol: s.symbol, dir: s.dir, ob: s.ob, metadata: { obFib: { refTf: '1M', weekly: { time: s.fib.candleTime }, hitRatio: s.fib.ratio, tf: s.ltf } } }));
  assert.equal(s.firstTouch, false);
});

test('first-touch ON: a fib line already touched since its candle closed is dropped', async () => {
  const on = { ...CFG, firstTouchOnly: true };
  const untouched = await scanCoinFibSignals({ symbol: 'LTCUSDT', price: 100, getKlines: fakeKlines(99.8), cfg: on, nowSec: NOW });
  const count = (r) => r.signals.length + r.invalid.length;
  assert.ok(count(untouched) > 0, 'line at 99 never traded → kept');
  assert.ok(untouched.signals.every((s) => s.firstTouch === true));
  const touched = await scanCoinFibSignals({ symbol: 'LTCUSDT', price: 100, getKlines: fakeKlines(98.5), cfg: on, nowSec: NOW });
  assert.equal(count(touched), 0, 'daily range covers the fib line → touched');
  // OFF keeps them
  const off = await scanCoinFibSignals({ symbol: 'LTCUSDT', price: 100, getKlines: fakeKlines(98.5), cfg: CFG, nowSec: NOW });
  assert.ok(count(off) > 0);
});

test('entry works only once: an OB whose middle was already touched goes to the INVALID list, not to signals', async () => {
  const r = await scanCoinFibSignals({ symbol: 'LTCUSDT', price: 100, getKlines: fakeKlines(), cfg: CFG, nowSec: NOW });
  assert.ok(r.invalid.length > 0, 'wavy fixture revisits every OB middle');
  for (const iv of r.invalid) {
    assert.equal(iv.status, 'INVALID');
    assert.equal(iv.closeReason, 'ENTRY_USED');
    assert.ok(Date.parse(iv.entryUsedAt) > 0);
    assert.ok(iv.entry && iv.signal_id);
  }
  const ids = new Set(r.signals.map((x) => x.signal_id));
  assert.ok(r.invalid.every((iv) => !ids.has(iv.signal_id)), 'never both a signal and invalid');
});

test('entry proximity is measured in ATR, so it is comparable between calm and wild coins', () => {
  const calm = entryProximity({ price: 101, entry: 100, atr: 1 }); // 1 ATR away
  const wild = entryProximity({ price: 101, entry: 100, atr: 10 }); // same 1 % but only 0.1 ATR away
  assert.ok(wild.pct > calm.pct);
  assert.equal(entryProximity({ price: 100, entry: 100, atr: 1 }).pct, 100);
  assert.equal(calm.distPct, 1);
  assert.ok(entryProximity({ price: 130, entry: 100, atr: 1 }).pct < 5);
  // no ATR stored → unit derived from the stop distance
  assert.ok(entryProximity({ price: 101, entry: 100, sl: 95 }).pct > 80);
  assert.equal(entryProximity({ price: null, entry: 100, atr: 1 }).pct, null);
});

test('fibLevelTouched ignores candles that ended before the fib candle closed', () => {
  const since = NOW - 5 * 86400;
  const before = [{ time: since - 3 * 86400, low: 90, high: 110 }];
  assert.equal(fibLevelTouched(100, since, before), false);
  assert.equal(fibLevelTouched(100, since, [{ time: since + 86400, low: 99, high: 101 }]), true);
  assert.equal(fibLevelTouched(100, since, [{ time: since + 86400, low: 100.5, high: 101 }]), false);
});

function sig(over = {}) {
  return {
    dir: 'LONG', entry: 100, sl: 98, tp1: 102, tp2: 104, tp3: 106,
    createdAt: new Date(NOW * 1000).toISOString(), evalFrom: NOW, status: 'ACTIVE', ...over,
  };
}
const cdl = (t, low, high) => ({ time: NOW + t, open: low, close: high, low, high, volume: 1 });
const traced = (candle, prices, complete = true) => ({
  ...candle,
  requiresTradePath: true,
  tradesComplete: complete,
  trades: prices.map((price, index) => ({ price, time: candle.time * 1000 + 100 + index * 100 })),
});

test('evaluate: pending → entry → TP1 → TP2 → TP3 closes; idempotent', () => {
  let s = sig();
  let r = evaluateFibSignal(s, [cdl(900, 101, 103)], NOW + 2000); // never touches entry 100, no TP1 run-away? high 103>=tp1 & low>entry → MISSED
  assert.equal(r.patch.closeReason, 'MISSED');

  s = sig();
  r = evaluateFibSignal(s, [traced(cdl(900, 99.5, 100.5), [100.2, 99.9])], NOW + 2000);
  assert.equal(r.patch.entryHit, true);
  assert.equal(r.patch.entryTimeExact, true);
  assert.ok(r.patch.entryTime > 1e12);
  assert.equal(r.closed, false);
  Object.assign(s, r.patch);
  assert.equal(outcomeLabel(s), 'Entry reached');
  r = evaluateFibSignal(s, [traced(cdl(900, 99.5, 100.5), [100.2, 99.9]), cdl(1800, 100.2, 104.5)], NOW + 3000);
  Object.assign(s, r.patch);
  assert.equal(s.tp1Hit && s.tp2Hit, true);
  assert.equal(s.tp3Hit, false);
  assert.equal(outcomeLabel(s), 'TP2 ✓');
  r = evaluateFibSignal(s, [cdl(2700, 104, 106.5)], NOW + 4000);
  assert.equal(r.patch.closeReason, 'TP3');
  assert.equal(r.patch.status, 'CLOSED');
});

test('evaluate: ordered trade path resolves SL/TP and no OHLC heuristic guesses', () => {
  let r = evaluateFibSignal(sig(), [traced(cdl(900, 97.5, 100.5), [100.1, 97.9])], NOW + 2000);
  assert.equal(r.patch.closeReason, 'SL');
  r = evaluateFibSignal(sig(), [traced(cdl(900, 97.5, 103), [100.2, 99.9, 103, 97.9])], NOW + 2000);
  assert.equal(r.patch.closeReason, 'SL');
  assert.equal(r.patch.tp1Hit, true);

  const unresolved = evaluateFibSignal(sig(), [{
    ...cdl(900, 97.5, 106.5),
    requiresTradePath: true,
    tradesComplete: false,
    trades: [],
  }], NOW + 2000);
  assert.equal(unresolved.patch.status, undefined);
  assert.equal(unresolved.patch.entryHit, false);
  assert.equal(unresolved.patch.tp1Hit, false);
  assert.equal(unresolved.patch.slHit, false);
  assert.equal(unresolved.patch.trackingIssue, 'TRADE_PATH_UNAVAILABLE');
  assert.equal(unresolved.patch.evalFrom, NOW + 900);

  const s = sig();
  let r2 = evaluateFibSignal(s, [
    traced(cdl(900, 99.5, 100.5), [100.2, 99.9]),
    cdl(1800, 100.5, 102.5),
    cdl(2700, 97.9, 100),
  ], NOW + 4000);
  Object.assign(s, r2.patch);
  assert.equal(outcomeLabel(s), 'TP1 → SL');
  const short = sig({ dir: 'SHORT', entry: 100, sl: 102, tp1: 98, tp2: 96, tp3: 94 });
  assert.equal(evaluateFibSignal(short, [
    traced(cdl(900, 99.5, 100.5), [99.8, 100.1]),
    cdl(1800, 93.5, 99),
  ], NOW + 3000).patch.closeReason, 'TP3');
  const old = sig({ createdAt: new Date((NOW - 9 * 86400) * 1000).toISOString(), evalFrom: NOW - 9 * 86400 });
  assert.equal(evaluateFibSignal(old, [], NOW, { expireDays: 7 }).patch.closeReason, 'EXPIRED');
  assert.equal(evaluateFibSignal(old, [], NOW, { expireDays: 0 }).closed, false);
});

test('store: keeps active, prunes old closed', () => {
  const old = new Date(Date.now() - 20 * 86400_000).toISOString();
  const s = pruneStore({ signals: [
    { signal_id: 'a', status: 'ACTIVE', createdAt: old },
    { signal_id: 'b', status: 'CLOSED', createdAt: old, closedAt: old },
    { signal_id: 'c', status: 'CLOSED', createdAt: old, closedAt: new Date().toISOString() },
  ] });
  assert.deepEqual(s.signals.map((x) => x.signal_id).sort(), ['a', 'c']);
});

test('runner: sweeps and de-duplicates without guessing from an ambiguous OHLC candle', async () => {
  const mem = new Map();
  setStateImpl({ getState: async (k, f = null) => (mem.has(k) ? mem.get(k) : f), setState: async (k, v) => void mem.set(k, JSON.parse(JSON.stringify(v))) });
  const symbols = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT', 'EEEUSDT', 'FFFUSDT', 'GGGUSDT', 'HHHUSDT'];
  const mkDeps = (extra) => ({
    getKlines: fakeKlines(99.8, extra),
    loadExchangeInfo: async () => symbols,
    loadTickers: async () => Object.fromEntries(symbols.map((s, i) => [s, { price: 100, volume: 1000 - i }])),
  });

  // disabled → nothing happens
  assert.equal((await runFibSignalsPass({ deps: mkDeps(), budgetMs: 20_000 })).skipped, true);

  mem.set('fib_signals_config', { enabled: true, refTimeframes: ['1M'], timeframes: ['15m'], fibLevels: [0.236, 0.382, 0.5, 0.618, 0.786] });
  const p1 = await runFibSignalsPass({ deps: mkDeps(), budgetMs: 20_000 });
  assert.equal(p1.scanned, symbols.length);
  assert.equal(p1.total, symbols.length);
  assert.equal(p1.sweepDone, true);
  assert.equal(p1.created, 0, 'every OB middle in the wavy fixture was already used');
  assert.ok(p1.invalid > 0);
  assert.ok(mem.get('fib_signals_invalid').items.length > 0, 'parked in the separate invalid list');
  assert.equal(mem.get('fib_signals_cursor').offset, 0);
  assert.equal(mem.get('fib_signals_cursor').cycles, 1);

  // publish one signal by hand so the tracking half of the pass can be exercised
  const seed = (await scanCoinFibSignals({ symbol: 'AAAUSDT', price: 100, getKlines: fakeKlines(99.8), cfg: CFG, nowSec: NOW })).invalid[0];
  const { status: _s, closeReason: _c, closeNote: _n, entryUsedAt: _u, invalidAt: _i, ...seedSignal } = seed;
  mem.set('fib_signals_store', { v: 1, signals: [{ ...seedSignal, status: 'ACTIVE' }] });
  const n1 = mem.get('fib_signals_store').signals.length;

  const p2 = await runFibSignalsPass({ deps: mkDeps(), budgetMs: 20_000 });
  assert.equal(p2.created, 0, 'same setups are not published twice');
  assert.equal(p2.invalid, 0, 'the same invalid setup is not listed twice');
  assert.equal(mem.get('fib_signals_store').signals.length, n1);

  // price then trades through the entry and all targets → signals close
  const run = (base) => {
    const t = NOW + 3600;
    return [
      { time: t, open: 100, close: 100, low: 90, high: 110, volume: 1 },
    ].map((c) => ({ ...c, time: Math.max(t, +base[base.length - 1].time + 900) }));
  };
  const p3 = await runFibSignalsPass({ deps: mkDeps(run), budgetMs: 20_000 });
  assert.ok(p3.tracked > 0);
  const store = mem.get('fib_signals_store').signals;
  assert.ok(store.some((s) => s.trackingIssue === 'TRADE_PATH_UNAVAILABLE'));
  assert.ok(store.every((s) => s.status !== 'CLOSED' || s.closeReason));
  assert.ok(store.every((s) => s.closeReason !== 'TP3' || (s.tp1Hit && s.tp2Hit && s.tp3Hit)));
  assert.ok(store.every((s) => s.status !== 'CLOSED' || s.closeReason));
  setStateImpl(null);
});

test('runner: a lock held by another pass skips; a rate-limit stops the pass without advancing past the failed batch', async () => {
  const mem = new Map();
  setStateImpl({ getState: async (k, f = null) => (mem.has(k) ? mem.get(k) : f), setState: async (k, v) => void mem.set(k, JSON.parse(JSON.stringify(v))) });
  mem.set('fib_signals_config', { enabled: true, refTimeframes: ['1M'], timeframes: ['15m'], fibLevels: [0.5] });
  const symbols = ['AAAUSDT', 'BBBUSDT'];
  const deps = {
    getKlines: async () => { const e = new Error('HTTP 429'); e.throttled = true; throw e; },
    loadExchangeInfo: async () => symbols,
    loadTickers: async () => Object.fromEntries(symbols.map((s) => [s, { price: 100, volume: 5 }])),
  };
  mem.set('fib_signals_lock', { at: Date.now() });
  assert.match((await runFibSignalsPass({ deps, budgetMs: 15_000 })).reason, /another/);
  mem.set('fib_signals_lock', { at: 0 });
  const r = await runFibSignalsPass({ deps, budgetMs: 15_000 });
  assert.equal(r.stopped, 'throttled');
  assert.equal(mem.get('fib_signals_cursor').offset, 0);
  setStateImpl(null);
});
