/**
 * EMA Bump gates. Every check is written for the BULLISH case on the (possibly mirrored)
 * series; SHORT is handled by the caller passing the mirrored candles.
 *
 * Result per gate: { key, label, mode, pass, detail }
 *   pass true  = passed
 *   pass false = failed (hard → setup rejected, soft → score penalty)
 *   pass null  = could not be evaluated (e.g. HTF candles not supplied)
 * Gates set to 'off' are not part of the checklist at all.
 */
import { calcEMASeries, calcRSISeries, findSwings, premiumDiscount, rsiDivergenceForDirection } from '../../indicators.js';
import { detectFVGs } from '../../fvg.js';
import { EMA_BUMP_GATES, gateMode } from './config.js';

/** @param ctx { cs, fast, slow, atr, t (= last closed bar), d (detection details), levels, realEntry, realSl, rvol, htfCs, cfg } */
export function evaluateEmaBumpGates(ctx) {
  const { cs, fast, slow, atr, t, d, levels, realEntry, realSl, rvol, htfCs, cfg } = ctx;
  const out = [];

  const checks = {
    htf() {
      if (!htfCs || htfCs.length < cfg.slowPeriod + 6) return { pass: null, detail: 'HTF candles n/a' };
      const hf = calcEMASeries(htfCs, cfg.fastPeriod);
      const hs = calcEMASeries(htfCs, cfg.slowPeriod);
      const i = htfCs.length - 1;
      if (hf[i] == null || hs[i] == null || hs[i - 5] == null) return { pass: null, detail: 'HTF EMAs n/a' };
      const against = hf[i] < hs[i] && hs[i] < hs[i - 5] && htfCs[i].close < hf[i];
      return { pass: !against, detail: against ? 'HTF clearly trending against the trade' : 'HTF not against the trade' };
    },
    volume() {
      const pass = rvol != null && rvol >= cfg.volumeMinRvol;
      return { pass, detail: `RVOL ${rvol != null ? (+rvol).toFixed(2) : '—'} (min ${cfg.volumeMinRvol})` };
    },
    chop() {
      let crosses = 0;
      let prev = null;
      for (let i = Math.max(0, t - cfg.chopWindow); i <= t; i++) {
        if (fast[i] == null || slow[i] == null) continue;
        const s = fast[i] > slow[i] ? 1 : -1;
        if (prev != null && s !== prev) crosses++;
        prev = s;
      }
      return { pass: crosses <= cfg.chopMaxCrosses, detail: `${crosses} EMA cross(es) in ${cfg.chopWindow} bars (max ${cfg.chopMaxCrosses})` };
    },
    reaction() {
      const c = cs[t];
      const ok = c.close > slow[t] && c.close > c.open;
      return { pass: ok, detail: ok ? 'last candle bullish and closed above EMA 50' : 'bounce off EMA 50 not confirmed yet' };
    },
    pullbackVol() {
      const avg = (a, b) => {
        let sum = 0, k = 0;
        for (let i = a; i <= b; i++) { sum += +cs[i].volume || 0; k++; }
        return k ? sum / k : 0;
      };
      const bump = avg(d.c, d.th);
      const pull = avg(d.th + 1, t);
      if (!(bump > 0)) return { pass: null, detail: 'volume n/a' };
      const ratio = pull / bump;
      return { pass: ratio <= cfg.pullbackVolMax, detail: `pullback volume ${(ratio * 100).toFixed(0)}% of bump volume (max ${(cfg.pullbackVolMax * 100).toFixed(0)}%)` };
    },
    rsi() {
      const series = calcRSISeries(cs.slice(0, t + 1), 14);
      if (series.length < 5) return { pass: null, detail: 'RSI n/a' };
      const now = series[series.length - 1].rsi;
      const pullRsi = series.filter((r) => r.i > d.th).map((r) => r.rsi);
      const lowest = pullRsi.length ? Math.min(...pullRsi) : now;
      const turned = now > lowest + 1;
      const ok = turned && now <= cfg.rsiMax && now >= cfg.rsiMin;
      return { pass: ok, detail: `RSI ${now.toFixed(0)} (${turned ? 'turned up off the pullback low' : 'still falling'}, limits ${cfg.rsiMin}–${cfg.rsiMax})` };
    },
    rsiDiv() {
      const r = rsiDivergenceForDirection(cs.slice(0, t + 1), 'LONG');
      return { pass: !!r.ok, detail: r.detail };
    },
    smc() {
      const swings = findSwings(cs, 3, 3);
      const lowIdx = d.lo;
      const prior = swings.filter((s) => s.type === 'L' && s.i < lowIdx - 2 && s.i >= lowIdx - 60);
      const swept = prior.some((s) => cs[lowIdx].low < s.price);
      let fvg = false;
      try {
        fvg = detectFVGs(cs.slice(0, t + 1)).some((f) => f.type === 'bullish' && f.index >= d.lo && f.index <= d.th + 1);
      } catch (_) {}
      return { pass: swept || fvg, detail: `${swept ? 'liquidity swept' : 'no sweep'} · ${fvg ? 'fresh FVG' : 'no FVG'}` };
    },
    location() {
      const pd = premiumDiscount(cs.slice(0, t + 1));
      return { pass: pd.pos <= cfg.locationMaxPos, detail: `price at ${(pd.pos * 100).toFixed(0)}% of the 50-bar range (max ${(cfg.locationMaxPos * 100).toFixed(0)}%)` };
    },
    blockedPath() {
      const swings = findSwings(cs, 3, 3).filter((s) => s.type === 'H' && s.i >= cs.length - 100);
      const blocker = swings.find((s) => s.price > levels.entry + atr * 0.05 && s.price < levels.tp1);
      return { pass: !blocker, detail: blocker ? 'opposing swing before TP1' : 'path to TP1 clear' };
    },
    risk() {
      const pct = (Math.abs(realEntry - realSl) / Math.abs(realEntry)) * 100;
      return { pass: pct >= cfg.riskMinPercent && pct <= cfg.riskMaxPercent, detail: `stop ${pct.toFixed(2)}% (limits ${cfg.riskMinPercent}–${cfg.riskMaxPercent}%)` };
    },
  };

  for (const g of EMA_BUMP_GATES) {
    const mode = gateMode(cfg, g.key);
    if (mode === 'off') continue;
    let r;
    try {
      r = checks[g.key]();
    } catch (e) {
      r = { pass: null, detail: `error: ${e.message}` };
    }
    out.push({ key: g.key, label: g.label, mode, pass: r.pass, detail: r.detail });
  }
  return out;
}

/** hard failures reject; a hard gate that could not be evaluated also rejects (fail closed). */
export function summariseGates(gates, { failClosed = true } = {}) {
  const hardFails = gates.filter((g) => g.mode === 'hard' && (g.pass === false || (failClosed && g.pass === null && g.key !== 'htf')));
  const softFails = gates.filter((g) => g.mode === 'soft' && g.pass === false);
  return { hardFails, softFails };
}
