/**
 * Liquidity pools + simple sweep detection on the OB timeframe candles.
 * Sweep = stop-run beyond equal high/low or swing extreme, then reclaim.
 */
export function detectLiquidity(candles, swings) {
  const liq = {
    equalHighs: [],
    equalLows: [],
    buySide: null,
    sellSide: null,
    bullishSweep: false,
    bearishSweep: false,
    sweepDetail: null,
  };
  if (!candles?.length) return liq;

  const tol = 0.0015;
  const highs = swings.filter((s) => s.type === 'H');
  const lows = swings.filter((s) => s.type === 'L');

  for (let i = 0; i < highs.length; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      if (
        Math.abs(highs[i].price - highs[j].price) / highs[i].price <
        tol
      ) {
        liq.equalHighs.push({
          price: (highs[i].price + highs[j].price) / 2,
          count: 2,
        });
      }
    }
  }
  for (let i = 0; i < lows.length; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      if (Math.abs(lows[i].price - lows[j].price) / lows[i].price < tol) {
        liq.equalLows.push({
          price: (lows[i].price + lows[j].price) / 2,
          count: 2,
        });
      }
    }
  }
  if (highs.length) liq.buySide = Math.max(...highs.map((h) => h.price));
  if (lows.length) liq.sellSide = Math.min(...lows.map((l) => l.price));

  // Recent sweep on last ~12 closed bars
  const n = candles.length;
  const look = Math.min(12, n - 1);
  if (look >= 3) {
    const recent = candles.slice(n - look);
    const sellLevel =
      liq.sellSide ||
      (liq.equalLows.length
        ? Math.min(...liq.equalLows.map((e) => e.price))
        : null);
    const buyLevel =
      liq.buySide ||
      (liq.equalHighs.length
        ? Math.max(...liq.equalHighs.map((e) => e.price))
        : null);

    // Bullish sweep: wick/close below sell-side liquidity, then reclaim above
    if (sellLevel) {
      for (let i = 0; i < recent.length - 1; i++) {
        const c = recent[i];
        const took = c.low <= sellLevel * 0.999;
        if (!took) continue;
        // any later bar reclaimed above level
        for (let j = i + 1; j < recent.length; j++) {
          if (recent[j].close > sellLevel * 1.0005) {
            liq.bullishSweep = true;
            liq.sweepDetail = {
              side: 'sell',
              level: sellLevel,
              sweepLow: c.low,
            };
            break;
          }
        }
        if (liq.bullishSweep) break;
      }
    }

    // Bearish sweep: wick above buy-side, then reclaim below
    if (buyLevel) {
      for (let i = 0; i < recent.length - 1; i++) {
        const c = recent[i];
        const took = c.high >= buyLevel * 1.001;
        if (!took) continue;
        for (let j = i + 1; j < recent.length; j++) {
          if (recent[j].close < buyLevel * 0.9995) {
            liq.bearishSweep = true;
            liq.sweepDetail = {
              side: 'buy',
              level: buyLevel,
              sweepHigh: c.high,
            };
            break;
          }
        }
        if (liq.bearishSweep) break;
      }
    }
  }

  return liq;
}
