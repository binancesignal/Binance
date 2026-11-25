import test from 'node:test';
import assert from 'node:assert/strict';
import { revalidateObFibSignal, obOfSignal, candlesNeededForOb } from '../lib/scanner/strategy/obFib/revalidate.js';
import { detectLuxAlgoOrderBlocks } from '../lib/scanner/orderBlocks.js';
import { siblingKey, pickSibling } from '../lib/signals/sibling.js';

const T0 = 1_700_000_000;
const STEP = 900;

// wavy series with volume spikes (deterministic) — produces several LuxAlgo OBs
function series(n = 400) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const close = 100 + Math.sin(i / 9) * 4.8 + i * 0.01;
    out.push({
      time: T0 + i * STEP,
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

function signalFor(ob, tf = '15m') {
  return {
    symbol: 'LTCUSDT',
    direction: ob.type === 'bearish' ? 'SHORT' : 'LONG',
    strategy: 'ob_fib',
    metadata: {
      strategy: 'ob_fib',
      patternTf: tf,
      ob: { time: ob.time, type: ob.type, high: ob.high, low: ob.low },
      obFib: { tf, refTf: '1M', hitRatio: 0.618, weekly: { time: 1 }, lux: { length: 5, bullExtLast: 3, bearExtLast: 3, mitigation: 'Wick' } },
    },
  };
}

test('OB still present in LuxAlgo → signal stays valid', () => {
  const c = series();
  const obs = detectLuxAlgoOrderBlocks(c, 300, { length: 5, bullExtLast: 3, bearExtLast: 3, mitigation: 'Wick' });
  assert.ok(obs.length > 0);
  const r = revalidateObFibSignal(signalFor(obs[obs.length - 1]), c, {});
  assert.equal(r.ok, true);
  assert.equal(r.code, 'present');
});

test('OB mitigated by a later wick → INVALID (mitigated)', () => {
  const c = series();
  const obs = detectLuxAlgoOrderBlocks(c, 300, { length: 5, bullExtLast: 3, bearExtLast: 3, mitigation: 'Wick' });
  const ob = obs[obs.length - 1];
  const idx = c.findIndex((x) => x.time === ob.time);
  const sig = signalFor(ob);
  // force a candle far beyond the zone on the far side, after the OB was confirmed
  const j = Math.min(c.length - 1, idx + 12);
  const broken = c.map((x, i) =>
    i >= j
      ? ob.type === 'bullish'
        ? { ...x, low: ob.low - 50, close: Math.min(x.close, ob.low - 40) }
        : { ...x, high: ob.high + 50, close: Math.max(x.close, ob.high + 40) }
      : x
  );
  const r = revalidateObFibSignal(sig, broken, {});
  assert.equal(r.ok, false);
  assert.ok(['mitigated', 'replaced', 'flipped'].includes(r.code));
  assert.match(r.reason, /Order block/);
});

test('OB that is no longer in the LuxAlgo list never invalidates when data is missing', () => {
  const c = series();
  const ob = detectLuxAlgoOrderBlocks(c, 300, {}).pop();
  const sig = signalFor(ob);
  assert.equal(revalidateObFibSignal(sig, c.slice(-20), {}).ok, true); // too little data
  assert.equal(revalidateObFibSignal(sig, c.slice(c.findIndex((x) => x.time === ob.time) + 1), {}).ok, true); // OB outside window
  assert.equal(revalidateObFibSignal({ ...sig, metadata: { strategy: 'ob_fib' } }, c, {}).ok, true); // no OB time stored
});

test('obOfSignal + candlesNeededForOb cover the OB age', () => {
  const sig = signalFor({ time: T0, type: 'bullish', high: 2, low: 1 });
  assert.equal(obOfSignal(sig).time, T0);
  const need = candlesNeededForOb(sig, {}, T0 + 700 * STEP);
  assert.ok(need >= 700 && need <= 1000);
});

test('OB+Fib siblings: different HTF / fib / OB are never merged into one signal', () => {
  const base = (refTf, ratio, obTime) => ({
    signal_id: `${refTf}-${ratio}-${obTime}`,
    symbol: 'LTCUSDT',
    direction: 'LONG',
    strategy: 'ob_fib',
    entry: 100,
    status: 'WATCHING',
    metadata: { strategy: 'ob_fib', patternTf: '15m', pattern: 'OB+FIB', obFib: { refTf, hitRatio: ratio, weekly: { time: 5 } }, ob: { time: obTime } },
  });
  const a = base('1M', 0.618, 111);
  assert.notEqual(siblingKey(a), siblingKey(base('3M', 0.618, 111)));
  assert.notEqual(siblingKey(a), siblingKey(base('1M', 0.5, 111)));
  assert.notEqual(siblingKey(a), siblingKey(base('1M', 0.618, 222)));
  assert.equal(siblingKey(a), siblingKey({ ...base('1M', 0.618, 111), signal_id: 'other-id', entry: 101 }));
  assert.equal(pickSibling(base('3M', 0.618, 111), [a]), null);
  assert.equal(pickSibling({ ...base('1M', 0.618, 111), signal_id: 'moved', entry: 101 }, [a])?.signal_id, a.signal_id);
});
