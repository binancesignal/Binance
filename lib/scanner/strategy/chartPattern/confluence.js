/**
 * Strategy 2 confluence — REAL, direction- and location-aware checks.
 *
 *  SMC  : sweep before the breakout, same-direction OB under the pattern base,
 *         FVG left by the breakout, LTF BOS/CHOCH, premium/discount room,
 *         and BLOCKERS (opposing OB / swing extreme between entry and TP1).
 *  FIB  : retracement of the dominant prior leg (pullback depth of the pattern base,
 *         or breakout level reclaiming a retracement), + fib-extension targets.
 *
 * Returns points (already capped by cfg.weights), human notes, blockers, and
 * drawable geometry (times, not indexes) for the Telegram chart.
 */
import { findSwings, premiumDiscount } from '../../indicators.js';
import { detectOrderBlocks } from '../../orderBlocks.js';
import { detectFVGs } from '../../fvg.js';
import { detectStructure } from '../../structure.js';

const RETR = [0.382, 0.5, 0.618, 0.705, 0.786];
const GOLDEN = (r) => r >= 0.5 && r <= 0.705;

function smcCheck({ pattern, br, direction, closed, A, entry, tp1, cap }) {
  const long = direction === 'LONG';
  const out = { points: 0, notes: [], blocked: [], ob: null, fvg: null, sweep: null };
  const bi = br.breakoutIndex;
  const base = long ? pattern.support : pattern.resistance;
  if (base == null) return out;
  const wantType = long ? 'bullish' : 'bearish';
  let pts = 0;

  // 1) sweep: a wick that takes out an EARLIER extreme of the pattern and closes back inside
  //    (spring / upthrust — the classic stop-hunt right before the real move)
  const pStart = Math.max(0, pattern.startIndex ?? 0);
  const from = Math.max(pStart + 3, bi - 30);
  for (let i = bi - 1; i >= from; i--) {
    const c = closed[i];
    const rng = c.high - c.low || 1e-9;
    let ext = long ? Infinity : -Infinity;
    for (let k = pStart; k < i; k++) ext = long ? Math.min(ext, closed[k].low) : Math.max(ext, closed[k].high);
    if (long) {
      const wick = Math.min(c.open, c.close) - c.low;
      if (c.low < ext - 0.05 * A && c.close > ext && wick / rng >= 0.5) {
        out.sweep = { t: c.time, p: c.low };
        break;
      }
    } else {
      const wick = c.high - Math.max(c.open, c.close);
      if (c.high > ext + 0.05 * A && c.close < ext && wick / rng >= 0.5) {
        out.sweep = { t: c.time, p: c.high };
        break;
      }
    }
  }
  if (out.sweep) {
    pts += 6;
    out.notes.push(long ? 'Sell-side liquidity swept' : 'Buy-side liquidity swept');
  }

  // 2) same-direction order block sitting at the pattern base
  let obs = [];
  try { obs = detectOrderBlocks(closed); } catch (_) {}
  const sup = obs
    .filter((o) =>
      o.type === wantType &&
      (long ? o.low <= base + 0.8 * A && o.high >= base - 0.6 * A : o.high >= base - 0.8 * A && o.low <= base + 0.6 * A)
    )
    .sort((a, b) => b.strength - a.strength)[0];
  if (sup) {
    out.ob = { high: sup.high, low: sup.low, t: sup.time, type: sup.type, status: sup.status };
    pts += sup.status === 'FRESH' || sup.status === 'TESTED ONCE' ? 5 : 3;
    out.notes.push(`${long ? 'Bull' : 'Bear'} OB at base (${sup.status.toLowerCase()})`);
  }

  // 3) FVG: left by the breakout displacement (or inside the pattern range), same direction
  let fvgs = [];
  try { fvgs = detectFVGs(closed); } catch (_) {}
  const zLo = Math.min(pattern.support ?? base, pattern.resistance ?? base);
  const zHi = Math.max(pattern.support ?? base, pattern.resistance ?? base);
  const fv = fvgs
    .filter((f) => f.type === wantType && f.status !== 'FILLED')
    .filter((f) => f.index >= closed.length - 2 || (f.high >= zLo && f.low <= zHi))
    .sort((a, b) => b.index - a.index)[0];
  if (fv) {
    out.fvg = { high: fv.high, low: fv.low, t: closed[Math.max(0, fv.index - 2)]?.time ?? fv.time, type: fv.type };
    pts += 3;
    out.notes.push(fv.index >= closed.length - 2 ? 'Breakout leaves FVG' : 'FVG inside pattern');
  }

  // 4) LTF structure break in trade direction
  try {
    const st = detectStructure(closed.slice(-60));
    const want = long ? 'bullish' : 'bearish';
    if (st.bos === want || st.choch === want) {
      pts += 2;
      out.notes.push(`LTF ${st.choch === want ? 'CHOCH' : 'BOS'} ${long ? 'up' : 'down'}`);
    }
  } catch (_) {}

  // 5) premium / discount room
  try {
    const pd = premiumDiscount(closed);
    if (long && pd.pos > 0.85) { pts -= 3; out.blocked.push('Long into range premium (little room)'); }
    if (!long && pd.pos < 0.15) { pts -= 3; out.blocked.push('Short into range discount (little room)'); }
  } catch (_) {}

  // 6) BLOCKERS between entry and TP1
  const reach = Math.abs(tp1 - entry) * 0.8;
  const opp = obs.find((o) =>
    o.type !== wantType &&
    (long ? o.low > entry - 0.1 * A && o.low < entry + reach && o.high > entry : o.high < entry + 0.1 * A && o.high > entry - reach && o.low < entry)
  );
  if (opp) out.blocked.push(`${long ? 'Bearish' : 'Bullish'} OB before TP1`);
  const sws = findSwings(closed, 3, 3).filter((s) => s.i >= closed.length - 100);
  const swBlock = sws.find((s) =>
    long ? s.type === 'H' && s.price > entry + 0.3 * A && s.price < entry + reach
         : s.type === 'L' && s.price < entry - 0.3 * A && s.price > entry - reach
  );
  if (swBlock) out.blocked.push(`Prior swing ${long ? 'high' : 'low'} before TP1`);
  pts -= Math.min(6, out.blocked.filter((b) => /before TP1/.test(b)).length * 4);

  out.points = Math.max(0, Math.min(cap, pts));
  return out;
}

function fibCheck({ pattern, br, direction, closed, A, tp2, tp3, cap }) {
  const long = direction === 'LONG';
  const out = { points: 0, notes: [], level: null, price: null, kind: null, leg: null, ext: null };
  const sws = findSwings(closed, 3, 3).filter((s) => s.i >= closed.length - 100);
  const highs = sws.filter((s) => s.type === 'H');
  const lows = sws.filter((s) => s.type === 'L');
  if (!highs.length || !lows.length) return out;
  const hiS = highs.reduce((a, b) => (b.price > a.price ? b : a));
  const loS = lows.reduce((a, b) => (b.price < a.price ? b : a));
  const range = hiS.price - loS.price;
  if (!(range >= 2.5 * A)) return out;
  const up = loS.i < hiS.i; // dominant leg direction
  const lvl = (r) => (up ? hiS.price - range * r : loS.price + range * r);
  const tol = 0.4 * A;
  const aligned = up === long; // leg in trade direction → pattern is a pullback / continuation
  out.leg = {
    t1: (up ? loS : hiS).time, p1: up ? loS.price : hiS.price,
    t2: (up ? hiS : loS).time, p2: up ? hiS.price : loS.price,
    up,
  };

  // (a) retracement match
  const ref = aligned ? (long ? pattern.support : pattern.resistance) : br.level;
  let best = null;
  if (ref != null) {
    for (const r of RETR) {
      const d = Math.abs(ref - lvl(r));
      if (d <= tol && (!best || d < best.d)) best = { r, d };
    }
  }
  if (best) {
    out.level = best.r;
    out.price = lvl(best.r);
    out.kind = aligned ? 'pullback' : 'reclaim';
    out.points += GOLDEN(best.r) ? 7 : 5;
    out.notes.push(
      aligned
        ? `Pullback to Fib ${best.r} of prior ${up ? 'rally' : 'drop'}`
        : `Break at Fib ${best.r} of prior ${up ? 'rally' : 'drop'}`
    );
  }

  // (b) extension confluence for targets (only when the prior leg is in trade direction)
  if (aligned) {
    const baseP = long ? pattern.support : pattern.resistance;
    for (const r of [1.272, 1.618]) {
      const e = long ? baseP + range * r : baseP - range * r;
      if ([tp2, tp3].some((t) => t != null && Math.abs(t - e) <= tol * 1.5)) {
        out.points += 3;
        out.ext = { r, price: e };
        out.notes.push(`Target near Fib ext ${r}`);
        break;
      }
    }
  }
  out.points = Math.min(cap, out.points);
  return out;
}

export function computeConfluence({ pattern, br, direction, candles, atr, entry, tp1, tp2, tp3, cfg }) {
  const closed = candles.slice(0, -1);
  const A = atr || entry * 0.004;
  const w = cfg.weights || {};
  let smc = { points: 0, notes: [], blocked: [] };
  let fib = { points: 0, notes: [] };
  try { smc = smcCheck({ pattern, br, direction, closed, A, entry, tp1, cap: w.smc ?? 16 }); } catch (_) {}
  try { fib = fibCheck({ pattern, br, direction, closed, A, tp2, tp3, cap: w.fib ?? 10 }); } catch (_) {}
  return { smc, fib, smcOk: smc.points >= 5, fibOk: fib.points >= 4 };
}
