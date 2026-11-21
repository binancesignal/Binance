/**
 * Walk-forward replay of the POI strategy (paper only). The engine is run at every step with `nowSec` = the step time, so it
 * can only see candles that had CLOSED by then (no look-ahead, no repainting). A signal is traded only when it is CONFIRMED,
 * listed, and its R:R passes; the fill is the NEXT 15M open after the signal (never the signal candle itself).
 * Costs are charged on both sides (taker fee + slippage). SL is assumed first when SL and TP1 sit in the same candle.
 */
import { analyzePoiSymbol } from './engine.js';

export const BACKTEST_COSTS = { feePct: 0.05, slippagePct: 0.03 }; // per side, % of price (Binance USDT-M taker ≈ 0.05 %)

/**
 * @param {{symbol:string, candles:Record<string,object[]>, cfg:object, fromSec:number, toSec:number, stepSec?:number, maxHoldBars?:number, costs?:object}} o
 */
export async function replayBacktest(o) {
  const { symbol, candles, cfg } = o;
  const step = o.stepSec || 3600;
  const costs = { ...BACKTEST_COSTS, ...(o.costs || {}) };
  const maxHold = o.maxHoldBars || 96;
  const m15 = candles['15m'];
  const getAt = (nowSec) => async (tf, limit) => candles[tf].filter((c) => c.time < nowSec).slice(-limit);
  const trades = [];
  const seen = new Set();
  let open = null;
  const signals = [];
  for (let t = o.fromSec; t <= o.toSec; t += step) {
    // manage the open trade on the 15M candles that closed since the last step
    if (open) closeIfHit(open, m15, t - step, t, maxHold, costs, trades) && (open = null);
    const res = await analyzePoiSymbol({ symbol, getCandles: getAt(t), cfg, nowSec: t });
    for (const r of res.results) {
      const a = r.analysis;
      if (!a) continue;
      if (a.state === 'CONFIRMED' && a.listed && a.plan?.rrOk && !seen.has(a.id)) {
        seen.add(a.id);
        signals.push({ id: a.id, dir: a.dir, class: a.class, score: a.score, time: t, entry: a.plan.entry, sl: a.plan.sl, tp1: a.plan.tp1 });
        if (open) continue; // one paper trade at a time per symbol
        const fill = m15.find((c) => c.time >= t); // next 15M candle after the observation
        if (!fill) continue;
        const dirSign = a.dir === 'LONG' ? 1 : -1;
        const entry = fill.open * (1 + (dirSign * costs.slippagePct) / 100);
        const risk = (entry - a.plan.sl) * dirSign;
        if (!(risk > 0) || (a.dir === 'LONG' ? a.plan.tp1 <= entry : a.plan.tp1 >= entry)) continue;
        open = { id: a.id, dir: a.dir, cls: a.class, score: a.score, signalTime: t, entryTime: fill.time, entry, sl: a.plan.sl, tp1: a.plan.tp1, risk, dirSign };
      }
    }
  }
  if (open) closeIfHit(open, m15, o.toSec - step, o.toSec + 1, maxHold, costs, trades, true);
  return { symbol, signals, trades, stats: statsOf(trades), costs, note: 'Paper replay on closed candles only. Not a guarantee of future results.' };
}

function closeIfHit(tr, m15, from, to, maxHold, costs, out, force = false) {
  const bars = m15.filter((c) => c.time >= tr.entryTime && c.time < to);
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i];
    const hitSl = tr.dir === 'LONG' ? c.low <= tr.sl : c.high >= tr.sl;
    const hitTp = tr.dir === 'LONG' ? c.high >= tr.tp1 : c.low <= tr.tp1;
    if (hitSl || hitTp || i + 1 >= maxHold) {
      const exit = hitSl ? tr.sl : hitTp ? tr.tp1 : c.close;
      finish(tr, exit, hitSl ? 'SL' : hitTp ? 'TP1' : 'TIME', c.time, costs, out);
      return true;
    }
  }
  if (force && bars.length) {
    finish(tr, bars[bars.length - 1].close, 'OPEN', bars[bars.length - 1].time, costs, out);
    return true;
  }
  return false;
}

function finish(tr, exit, why, time, costs, out) {
  const gross = ((exit - tr.entry) * tr.dirSign) / tr.risk;
  const costR = (((costs.feePct + costs.slippagePct) * 2) / 100 * tr.entry) / tr.risk; // entry slippage is already in `entry`, so this slightly over-counts: conservative
  out.push({ id: tr.id, dir: tr.dir, class: tr.cls, score: tr.score, signalTime: tr.signalTime, entryTime: tr.entryTime, exitTime: time, entry: tr.entry, exit, sl: tr.sl, tp1: tr.tp1, exitReason: why, grossR: +gross.toFixed(3), netR: +(gross - costR).toFixed(3) });
}

export function statsOf(trades) {
  const n = trades.length;
  const net = trades.map((t) => t.netR);
  const wins = trades.filter((t) => t.netR > 0).length;
  const gp = net.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const gl = -net.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const x of net) {
    eq += x;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return { trades: n, wins, winRate: n ? +((wins / n) * 100).toFixed(1) : 0, avgNetR: n ? +(eq / n).toFixed(3) : 0, totalNetR: +eq.toFixed(2), profitFactor: gl > 0 ? +(gp / gl).toFixed(2) : n ? null : 0, maxDrawdownR: +dd.toFixed(2) };
}
