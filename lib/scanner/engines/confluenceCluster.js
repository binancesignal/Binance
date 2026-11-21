/**
 * Confluence Cluster Engine.
 * Merges overlapping technical zones within ATR tolerance into clusters.
 * Prevents double-counting of equal-high / swing / liquidity that represent the same area.
 */
import { detectOrderBlocks } from '../orderBlocks.js';
import { detectFVGs } from '../fvg.js';
import { detectLiquidity } from '../liquidity.js';
import { findSwings, calcATR } from '../indicators.js';

/**
 * Collect raw zones from existing detectors and merge into clusters.
 */
export function buildConfluenceClusters(candles, direction, atr, opts = {}) {
  const closed = candles?.slice(0, -1) || [];
  if (closed.length < 20) return { clusters: [], raw: [] };

  const A = atr > 0 ? atr : calcATR(closed, 14) || closed[closed.length - 1].close * 0.004;
  const tol = A * (opts.toleranceATR ?? 0.55);
  const long = direction === 'LONG';
  const want = long ? 'bullish' : 'bearish';

  const zones = [];

  // Order Blocks
  let obs = [];
  try { obs = detectOrderBlocks(closed); } catch (_) {}
  for (const o of obs) {
    if (o.status === 'INVALIDATED') continue;
    if (o.type !== want) continue;
    zones.push({
      kind: 'OB',
      high: o.high,
      low: o.low,
      mid: (o.high + o.low) / 2,
      strength: o.strength || 50,
      status: o.status,
      time: o.time,
      source: 'orderBlock',
    });
  }

  // FVGs
  let fvgs = [];
  try { fvgs = detectFVGs(closed); } catch (_) {}
  for (const f of fvgs) {
    if (f.status === 'FILLED' || f.type !== want) continue;
    zones.push({
      kind: 'FVG',
      high: f.high,
      low: f.low,
      mid: (f.high + f.low) / 2,
      strength: 40,
      status: f.status,
      time: f.time,
      source: 'fvg',
    });
  }

  // Liquidity / equal highs-lows / swings
  const swings = findSwings(closed, 3, 3);
  let liq = {};
  try { liq = detectLiquidity(closed, swings); } catch (_) {}

  if (long) {
    for (const el of liq.equalLows || []) {
      zones.push({
        kind: 'EQUAL_LOW',
        high: el.price + A * 0.15,
        low: el.price - A * 0.15,
        mid: el.price,
        strength: 45 + (el.count || 0) * 5,
        source: 'equalLow',
      });
    }
    if (liq.sellSide) {
      zones.push({
        kind: 'SELL_LIQ',
        high: liq.sellSide + A * 0.2,
        low: liq.sellSide - A * 0.1,
        mid: liq.sellSide,
        strength: 50,
        source: 'sellSideLiq',
      });
    }
  } else {
    for (const eh of liq.equalHighs || []) {
      zones.push({
        kind: 'EQUAL_HIGH',
        high: eh.price + A * 0.15,
        low: eh.price - A * 0.15,
        mid: eh.price,
        strength: 45 + (eh.count || 0) * 5,
        source: 'equalHigh',
      });
    }
    if (liq.buySide) {
      zones.push({
        kind: 'BUY_LIQ',
        high: liq.buySide + A * 0.1,
        low: liq.buySide - A * 0.2,
        mid: liq.buySide,
        strength: 50,
        source: 'buySideLiq',
      });
    }
  }

  // Previous swings as S/R
  const highs = swings.filter((s) => s.type === 'H').slice(-6);
  const lows = swings.filter((s) => s.type === 'L').slice(-6);
  if (long) {
    for (const l of lows) {
      zones.push({
        kind: 'SWING_LOW',
        high: l.price + A * 0.15,
        low: l.price - A * 0.15,
        mid: l.price,
        strength: 35,
        source: 'swingLow',
        i: l.i,
      });
    }
  } else {
    for (const h of highs) {
      zones.push({
        kind: 'SWING_HIGH',
        high: h.price + A * 0.15,
        low: h.price - A * 0.15,
        mid: h.price,
        strength: 35,
        source: 'swingHigh',
        i: h.i,
      });
    }
  }

  // Fib levels derived from recent dominant swing leg (simple, no lookahead)
  try {
    const swings = findSwings(closed, 3, 3);
    const highs = swings.filter((s) => s.type === 'H').slice(-4);
    const lows = swings.filter((s) => s.type === 'L').slice(-4);
    if (highs.length >= 1 && lows.length >= 1) {
      const lastH = highs[highs.length - 1];
      const lastL = lows[lows.length - 1];
      const legHigh = Math.max(lastH.price, lastL.price);
      const legLow = Math.min(lastH.price, lastL.price);
      const range = legHigh - legLow;
      if (range > A * 0.5) {
        for (const r of [0.382, 0.5, 0.618, 0.705, 0.786]) {
          const price = lastH.i > lastL.i
            ? legHigh - range * r   // down leg → retracement from high
            : legLow + range * r;   // up leg → retracement from low
          zones.push({
            kind: 'FIB',
            high: price + A * 0.12,
            low: price - A * 0.12,
            mid: price,
            strength: (r >= 0.5 && r <= 0.786) ? 55 : 35,
            source: `fib_${r}`,
            ratio: r,
          });
        }
      }
    }
  } catch (_) {}

  // Merge overlapping zones into clusters
  const clusters = mergeZones(zones, tol, long);
  return { clusters, raw: zones, atr: A };
}

function GOLDEN(r) {
  return r >= 0.5 && r <= 0.786;
}

function mergeZones(zones, tol, long) {
  if (!zones.length) return [];
  // Sort by mid price
  const sorted = [...zones].sort((a, b) => a.mid - b.mid);
  const clusters = [];
  let current = null;

  for (const z of sorted) {
    if (!current) {
      current = {
        high: z.high,
        low: z.low,
        midpoint: z.mid,
        direction: long ? 'bullish' : 'bearish',
        strength: z.strength,
        sources: [z.kind],
        sourceCount: 1,
        timeframes: ['pattern'],
        freshness: z.status === 'FRESH' ? 1 : 0.7,
        retestCount: z.status === 'TESTED ONCE' ? 1 : z.status === 'FRESH' ? 0 : 2,
        members: [z],
      };
      continue;
    }
    // Overlap or within tol of midpoint
    const gap = Math.min(
      Math.abs(z.mid - current.midpoint),
      Math.abs(z.low - current.high),
      Math.abs(z.high - current.low)
    );
    if (gap <= tol || (z.low <= current.high + tol && z.high >= current.low - tol)) {
      current.high = Math.max(current.high, z.high);
      current.low = Math.min(current.low, z.low);
      current.midpoint = (current.high + current.low) / 2;
      current.strength = Math.min(100, current.strength + z.strength * 0.4);
      if (!current.sources.includes(z.kind)) {
        current.sources.push(z.kind);
        current.sourceCount++;
      }
      current.members.push(z);
      if (z.status === 'FRESH') current.freshness = Math.max(current.freshness, 1);
    } else {
      clusters.push(finalizeCluster(current));
      current = {
        high: z.high,
        low: z.low,
        midpoint: z.mid,
        direction: long ? 'bullish' : 'bearish',
        strength: z.strength,
        sources: [z.kind],
        sourceCount: 1,
        timeframes: ['pattern'],
        freshness: z.status === 'FRESH' ? 1 : 0.7,
        retestCount: z.status === 'TESTED ONCE' ? 1 : 0,
        members: [z],
      };
    }
  }
  if (current) clusters.push(finalizeCluster(current));
  return clusters.sort((a, b) => b.strength - a.strength);
}

function finalizeCluster(c) {
  // Cap strength and label
  c.strength = Math.min(100, Math.round(c.strength));
  c.label = c.direction === 'bullish' ? 'BULLISH REJECTION CLUSTER' : 'BEARISH REJECTION CLUSTER';
  // Penalize over-tested
  if (c.retestCount >= 3) {
    c.strength = Math.round(c.strength * 0.7);
    c.overTested = true;
  }
  return c;
}

/**
 * Score how well a pattern price sits inside the best matching cluster.
 */
export function clusterScoreForPattern(clusters, pattern, direction, atr) {
  if (!clusters?.length || !pattern) return { score: 0, cluster: null, notes: [] };
  const long = direction === 'LONG';
  const price = long ? (pattern.support ?? pattern.neckline) : (pattern.resistance ?? pattern.neckline);
  if (price == null) return { score: 0, cluster: null, notes: [] };

  const A = atr || 1;
  let best = null;
  let bestDist = Infinity;
  for (const c of clusters) {
    if ((c.direction === 'bullish') !== long) continue;
    const dist = price >= c.low - A * 0.3 && price <= c.high + A * 0.3
      ? 0
      : Math.min(Math.abs(price - c.low), Math.abs(price - c.high));
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  if (!best || bestDist > A * 1.5) return { score: 0, cluster: null, notes: ['No confluence cluster nearby'] };

  let score = Math.round(best.strength * (1 - bestDist / (A * 2)));
  const notes = [`Cluster: ${best.sources.join('+')} (str ${best.strength})`];
  if (best.overTested) {
    score = Math.round(score * 0.7);
    notes.push('Over-tested zone penalty');
  }
  if (best.sourceCount >= 3) {
    score = Math.min(100, score + 10);
    notes.push(`Strong multi-source cluster (${best.sourceCount})`);
  }
  return { score: Math.max(0, Math.min(100, score)), cluster: best, notes };
}
