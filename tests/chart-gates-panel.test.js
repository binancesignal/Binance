import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartSvg } from '../lib/telegram/chartSvg.js';

function mk() {
  const t0 = 1_700_000_000;
  const candles = Array.from({ length: 120 }, (_, i) => {
    const base = 100 + Math.sin(i / 7) * 3;
    return { time: t0 + i * 900, open: base - 0.3, high: base + 0.9, low: base - 0.9, close: base + 0.3, volume: 100 + i };
  });
  const T = (i) => candles[i].time;
  const signal = {
    symbol: 'TESTUSDT', direction: 'SHORT', score: 78, entry: 99, sl: 102, tp1: 96, tp2: 94, tp3: 92, rr: 1.0, current_price: 99.5,
    strategy: 'chart_pattern',
    conf: ['Pattern ok', '\u26a0 soft: Retest missing'],
    metadata: {
      strategy: 'chart_pattern', patternTf: '15m', htf: '1h',
      patternGeom: {
        type: 'DOUBLE_TOP', direction: 'SHORT', pending: false, tf: '15m', htf: '1h',
        t0: T(70), t1: T(110), tb: T(112), level: 99, top: 103, bottom: 99, height: 4, tp2: 94, tp3: 92,
        lines: [], anchors: [{ t: T(80), p: 103, label: 'A' }, { t: T(100), p: 103, label: 'B' }],
        elliott: { type: 'IMPULSE', direction: 'bearish', currentWave: 3, confidence: 71, invalidation: 104,
          pivots: [{ label: '1', p: 101, t: T(60) }, { label: '2', p: 103, t: T(75) }, { label: '3', p: 99, t: T(105) }] },
        gates: [
          { key: 'wave', label: 'Elliott Wave', mode: 'hard', pass: true },
          { key: 'rejectionZone', label: 'Rejection zone (reversals)', mode: 'hard', pass: true },
          { key: 'htf', label: 'HTF align', mode: 'soft', pass: false },
          { key: 'retest', label: 'Retest', mode: 'soft', pass: null },
        ],
        zones: [{ kind: 'REJECTION', label: 'REJECTION ZONE OB+FIB', high: 103.4, low: 102.2 }, { kind: 'FVG', label: 'FVG', high: 100.5, low: 100.1 }],
        liqLevels: [{ kind: 'EQH', label: 'Equal highs', price: 102.8 }],
        pd: { high: 104, low: 96, eq: 100, zone: 'PREMIUM', pos: 0.78 },
      },
    },
  };
  return { signal, candles };
}

test('chart marks rejection zone / liquidity / EQ and shows the GATES panel', () => {
  const { signal, candles } = mk();
  const svg = buildChartSvg(signal, candles, { tf: '15m', htf: '1h', visible: 90 })?.svg;
  assert.ok(svg, 'svg built');
  assert.match(svg, /GATES/);
  assert.match(svg, /PASS Elliott Wave \[HARD\]/);
  assert.match(svg, /FAIL HTF align \[SOFT\]/);
  assert.match(svg, /n\/a Retest \[SOFT\]/);
  assert.match(svg, /REJECTION ZONE OB\+FIB/);
  assert.match(svg, /Equal highs/);
  assert.match(svg, /EQ · PREMIUM 78%/);
  assert.ok(!/\u26a0/.test(svg), 'no glyph missing from the bundled font');
});
