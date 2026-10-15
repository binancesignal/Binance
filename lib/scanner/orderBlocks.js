import { avg } from './indicators.js';

/**
 * Order Block detection — preserved from original scanner.
 */
export function detectOrderBlocks(candles, lookback = 80) {
  const obs = [];
  const len = candles.length;
  if (len < 20) return obs;
  const ranges = candles.slice(-30).map((c) => c.high - c.low);
  const avgRange = avg(ranges) || 0.001;

  for (let i = Math.max(3, len - lookback); i < len - 5; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    const isBull = c.close > c.open;
    const isBear = c.close < c.open;

    // Bullish OB
    if (isBear && body > avgRange * 0.4) {
      let disp = 0;
      let volExp = false;
      for (let j = 1; j <= 6; j++) {
        if (i + j >= len) break;
        const n = candles[i + j];
        if (n.close > n.open) {
          disp += n.close - n.open;
          if (n.volume > candles[i].volume * 1.3) volExp = true;
        }
      }
      if (disp > avgRange * 1.8) {
        const high = c.high;
        const low = Math.min(c.open, c.close);
        const mid = (high + low) / 2;
        let tests = 0;
        let mitigated = false;
        for (let k = i + 1; k < len; k++) {
          if (candles[k].low <= high && candles[k].high >= low) {
            tests++;
            if (candles[k].close < low) mitigated = true;
          }
        }
        let status = 'FRESH';
        if (mitigated) status = 'INVALIDATED';
        else if (tests >= 3) status = 'TESTED MULTIPLE';
        else if (tests >= 1) status = 'TESTED ONCE';

        obs.push({
          type: 'bullish',
          high,
          low,
          mid,
          index: i,
          time: c.time,
          status,
          tests,
          displacement: disp,
          volumeExp: volExp,
          strength: Math.min(
            100,
            (disp / avgRange) * 25 +
              (volExp ? 15 : 0) +
              (status === 'FRESH' ? 20 : status === 'TESTED ONCE' ? 10 : 0)
          ),
        });
      }
    }

    // Bearish OB
    if (isBull && body > avgRange * 0.4) {
      let disp = 0;
      let volExp = false;
      for (let j = 1; j <= 6; j++) {
        if (i + j >= len) break;
        const n = candles[i + j];
        if (n.close < n.open) {
          disp += n.open - n.close;
          if (n.volume > candles[i].volume * 1.3) volExp = true;
        }
      }
      if (disp > avgRange * 1.8) {
        const low = c.low;
        const high = Math.max(c.open, c.close);
        const mid = (high + low) / 2;
        let tests = 0;
        let mitigated = false;
        for (let k = i + 1; k < len; k++) {
          if (candles[k].high >= low && candles[k].low <= high) {
            tests++;
            if (candles[k].close > high) mitigated = true;
          }
        }
        let status = 'FRESH';
        if (mitigated) status = 'INVALIDATED';
        else if (tests >= 3) status = 'TESTED MULTIPLE';
        else if (tests >= 1) status = 'TESTED ONCE';

        obs.push({
          type: 'bearish',
          high,
          low,
          mid,
          index: i,
          time: c.time,
          status,
          tests,
          displacement: disp,
          volumeExp: volExp,
          strength: Math.min(
            100,
            (disp / avgRange) * 25 +
              (volExp ? 15 : 0) +
              (status === 'FRESH' ? 20 : status === 'TESTED ONCE' ? 10 : 0)
          ),
        });
      }
    }
  }

  return obs
    .filter((o) => o.status !== 'INVALIDATED')
    .sort((a, b) => b.strength - a.strength || b.index - a.index)
    .slice(0, 6);
}
