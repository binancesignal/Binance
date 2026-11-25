import { findSwings } from './indicators.js';

export function detectStructure(candles) {
  const swings = findSwings(candles, 2, 2);
  if (swings.length < 4)
    return { bias: 'neutral', bos: null, choch: null, swings };
  const recent = swings.slice(-6);
  let bias = 'neutral';
  let bos = null;
  let choch = null;
  const highs = recent.filter((s) => s.type === 'H');
  const lows = recent.filter((s) => s.type === 'L');
  if (highs.length >= 2 && lows.length >= 2) {
    const lastH = highs[highs.length - 1].price;
    const prevH = highs[highs.length - 2].price;
    const lastL = lows[lows.length - 1].price;
    const prevL = lows[lows.length - 2].price;
    if (lastH > prevH && lastL > prevL) {
      bias = 'bullish';
      bos = 'bullish';
    } else if (lastH < prevH && lastL < prevL) {
      bias = 'bearish';
      bos = 'bearish';
    } else if (lastH > prevH && lastL < prevL) {
      choch = 'bullish';
      bias = 'bullish';
    } else if (lastH < prevH && lastL > prevL) {
      choch = 'bearish';
      bias = 'bearish';
    }
  }
  return { bias, bos, choch, swings: recent };
}
