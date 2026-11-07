export function detectFVGs(candles) {
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];

    if (c1.high < c3.low) {
      const size = c3.low - c1.high;
      let filled = 0;
      for (let k = i + 1; k < candles.length; k++) {
        if (candles[k].low < c3.low)
          filled = Math.max(
            filled,
            (c3.low - Math.max(candles[k].low, c1.high)) / size
          );
      }
      fvgs.push({
        type: 'bullish',
        high: c3.low,
        low: c1.high,
        size,
        filled: Math.min(1, filled),
        status: filled > 0.9 ? 'FILLED' : filled > 0.3 ? 'PARTIAL' : 'OPEN',
        index: i,
        time: c3.time,
      });
    }

    if (c1.low > c3.high) {
      const size = c1.low - c3.high;
      let filled = 0;
      for (let k = i + 1; k < candles.length; k++) {
        if (candles[k].high > c3.high)
          filled = Math.max(
            filled,
            (Math.min(candles[k].high, c1.low) - c3.high) / size
          );
      }
      fvgs.push({
        type: 'bearish',
        high: c1.low,
        low: c3.high,
        size,
        filled: Math.min(1, filled),
        status: filled > 0.9 ? 'FILLED' : filled > 0.3 ? 'PARTIAL' : 'OPEN',
        index: i,
        time: c3.time,
      });
    }
  }
  return fvgs.filter((f) => f.status !== 'FILLED').slice(-8);
}
