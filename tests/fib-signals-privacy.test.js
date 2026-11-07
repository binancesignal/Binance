import test from 'node:test';
import assert from 'node:assert/strict';
import { toPublicSignal, publicId, isPublicVisible, publicOutcome, findSignal } from '../lib/fibSignals/publicView.js';
import { buildPlainSignalChartSvg, displayTfFor } from '../lib/fibSignals/plainChart.js';

const stored = {
  signal_id: 'FS_BTCUSDT_SHORT_1M_1759276800_0.618_15m_1761900000',
  exchange: 'binance', symbol: 'BTCUSDT', dir: 'SHORT', side: 'SELL', status: 'ACTIVE',
  createdAt: '2026-10-31T10:00:00.000Z', priceAtIssue: 100,
  entry: 101, entryZone: { low: 100.5, high: 101.5 }, sl: 102, tp1: 100, tp2: 99, tp3: 98,
  rr: 1, riskPct: 0.99, tpPct: [0.99, 1.98, 2.97], score: 83, atr: 0.4, ltf: '15m',
  fib: { refTf: '1M', refLabel: 'Monthly', ratio: 0.618, price: 101.2, high: 130, low: 90, dir: 'bearish' },
  ob: { time: 1761900000, type: 'bearish', high: 101.5, low: 100.5, status: 'FRESH' },
  lux: { length: 5 }, firstTouch: true, entryHit: false, tp1Hit: false, tp2Hit: false, tp3Hit: false, slHit: false, evalFrom: 1,
};

test('public signal exposes ONLY trade levels and results — no strategy information', () => {
  const p = toPublicSignal(stored);
  assert.deepEqual(Object.keys(p).sort(), [
    'closeReason', 'closedAt', 'createdAt', 'entry', 'entryHit', 'entryTime', 'id', 'outcome',
    'riskPct', 'rr', 'side', 'sl', 'slHit', 'status', 'symbol', 'tp1', 'tp1Hit', 'tp2',
    'tp2Hit', 'tp3', 'tp3Hit', 'tpPct', 'trackingPaused',
  ]);
  const json = JSON.stringify(p);
  for (const leak of ['fib', 'Fib', '"ob"', 'zone', 'score', 'ltf', '15m', 'lux', 'firstTouch', '0.618', 'Monthly', 'bearish', 'bullish']) {
    assert.ok(!json.includes(leak), `leaks ${leak}`);
  }
  assert.ok(!json.includes('FS_BTCUSDT'), 'raw id (encodes fib TF / ratio / OB time) must not be exposed');
  assert.equal(p.id, publicId(stored.signal_id));
  assert.match(p.id, /^[0-9a-f]{14}$/);
});

test('users never see lifecycle stages or never-filled signals; only real results', () => {
  assert.equal(publicOutcome(stored), ''); // pending → nothing shown (no "watching/ready")
  assert.equal(publicOutcome({ ...stored, entryHit: true }), ''); // no "ongoing"
  assert.equal(publicOutcome({ ...stored, tp1Hit: true, entryHit: true }), 'TP1 ✓');
  assert.equal(publicOutcome({ ...stored, status: 'CLOSED', closeReason: 'SL', slHit: true, entryHit: true }), 'SL hit');
  assert.equal(publicOutcome({ ...stored, status: 'CLOSED', closeReason: 'TP3', tp1Hit: true, tp2Hit: true, tp3Hit: true, entryHit: true }), 'TP3 ✓');
  for (const reason of ['INVALID', 'MISSED', 'EXPIRED']) {
    assert.equal(isPublicVisible({ ...stored, status: 'CLOSED', closeReason: reason, entryHit: false }), false, `${reason} hidden`);
  }
  assert.equal(isPublicVisible({ ...stored, status: 'CLOSED', closeReason: 'SL', entryHit: true }), true);
});

test('chart ids: admin raw id and public id both resolve; unknown ids do not', () => {
  const store = { signals: [stored] };
  assert.equal(findSignal(store, stored.signal_id), stored);
  assert.equal(findSignal(store, publicId(stored.signal_id)), stored);
  assert.equal(findSignal(store, 'nope'), undefined);
});

test('plain chart: candles + Entry/SL/TP only — no zones, fib lines or strategy words', () => {
  const now = Math.floor(Date.now() / 1000);
  const candles = Array.from({ length: 120 }, (_, i) => {
    const c = 100 + Math.sin(i / 8) * 3;
    return { time: now - (120 - i) * 900, open: c - 0.3, close: c + 0.3, high: c + 0.8, low: c - 0.8, volume: 1 };
  });
  const svg = buildPlainSignalChartSvg({ symbol: 'BTCUSDT', side: 'SELL', entry: 101, sl: 102, tp1: 100, tp2: 99, tp3: 98, tpPct: [1, 2, 3], riskPct: 1, candles, price: 100.2, tfLabel: '15M' });
  assert.ok(svg.startsWith('<svg'));
  for (const w of ['ENTRY', 'SL ', 'TP1', 'TP2', 'TP3', 'SELL']) assert.ok(svg.includes(w), w);
  const text = svg.replace(/<[^>]+>/g, ' ');
  assert.ok(!/Fib|OB\b|Order|Weekly|Monthly|ICT|SMC|FVG|Liquidity|zone|BOS|CHoCH/i.test(text), 'no strategy words in the chart');
  assert.equal(buildPlainSignalChartSvg({ symbol: 'X', side: 'BUY', entry: 1, sl: 0.9, tp1: 1.1, candles: [] }), null);
  // display time frame does not reveal the exact LTF
  assert.deepEqual(['5m', '15m', '30m', '1h', '2h', '4h'].map(displayTfFor), ['15m', '15m', '1h', '1h', '4h', '4h']);
});
