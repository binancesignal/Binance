/**
 * Powerful Max — multi-timeframe Elliott + crypto confluence strategy.
 *
 * Architecture:
 *  1D/4H context → Elliott multi-count agreement → key zone → liquidity sweep
 *  → OB/FVG → Fibonacci → volume/momentum → 15m structure confirmation → entry.
 *
 * Elliott is a context engine, not a standalone trigger. The strategy never
 * enters from an Elliott label alone; price location + structure confirmation
 * remain mandatory.
 */
import { runCryptoConfluenceStrategy } from './cryptoConfluence.js';
import { analyseElliottWave } from '../engines/elliottWave.js';
import { detectStructure } from '../structure.js';
import { findSwings, calcATR, relativeVolume } from '../indicators.js';
import { runHarmonicStrategy } from './harmonic/index.js';
import { runChartPatternStrategy } from './chartPattern/index.js';

const EW_MOTIVE = new Set(['IMPULSE', 'IMPULSE_PARTIAL', 'LEADING_DIAGONAL', 'ENDING_DIAGONAL']);
const EW_CORRECTIVE = new Set(['CORRECTION', 'FLAT', 'RUNNING_FLAT', 'EXPANDED_FLAT', 'TRIANGLE', 'DOUBLE_ZIGZAG', 'TRIPLE_ZIGZAG', 'COMBINATION_WXYXZ']);

const valid = (xs = []) => xs.filter((c) => [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(+v)));

function dirOf(x) { return String(x?.dir || x?.direction || '').toUpperCase(); }
function ewDir(x) { return x?.direction === 'bullish' ? 'LONG' : x?.direction === 'bearish' ? 'SHORT' : null; }

function fibConfluence(candles, dir, atr) {
  const c = valid(candles);
  if (c.length < 25 || !(atr > 0)) return { score: 0, hits: [], levels: [] };
  const swings = findSwings(c.slice(0, -1), 3, 3).slice(-8);
  if (swings.length < 4) return { score: 0, hits: [], levels: [] };
  const a = swings.at(-2);
  const b = swings.at(-1);
  const range = Math.abs(+b.price - +a.price);
  if (!(range > atr * 1.2)) return { score: 0, hits: [], levels: [] };
  const p = +c.at(-1).close;
  const bull = dir === 'LONG';
  const levels = [0.382, 0.5, 0.618, 0.705, 0.786].map((r) => ({
    ratio: r,
    price: bull ? +b.price - range * r : +b.price + range * r,
  }));
  const hits = levels.filter((x) => Math.abs(p - x.price) <= atr * 0.55);
  return { score: Math.min(10, hits.length * 4), hits, levels };
}

function waveQuality(ew, dir) {
  const pc = ew?.primaryCount;
  if (!pc) return { score: 0, ok: false, reason: 'No reliable Elliott count' };
  const want = dir;
  const wd = ewDir(pc);
  const w = pc.currentWave;
  let score = 0;
  const notes = [];

  if (wd === want) { score += 10; notes.push(`Primary EW agrees (${pc.type} W${w})`); }
  else { score -= 8; notes.push(`Primary EW opposes (${pc.type} ${pc.direction})`); }

  if (EW_MOTIVE.has(pc.type)) {
    if (wd === want && (w === 2 || w === 3 || w === 4 || pc.type === 'IMPULSE_PARTIAL')) score += 14;
    if (w === 3 && wd === want) { score += 6; notes.push('Wave 3 continuation preference'); }
    if (w === 5 && wd === want) { score -= 18; notes.push('Same-direction Wave 5 exhaustion penalty'); }
    if (w === 5 && wd !== want) score += 8;
  }

  if (EW_CORRECTIVE.has(pc.type)) {
    const completed = (['CORRECTION','FLAT','RUNNING_FLAT','EXPANDED_FLAT'].includes(pc.type) && w === 'C') ||
      (pc.type === 'TRIANGLE' && w === 'E') ||
      (pc.type === 'DOUBLE_ZIGZAG' && w === 'Y') ||
      (pc.type === 'TRIPLE_ZIGZAG' && w === 'Z') ||
      (pc.type === 'COMBINATION_WXYXZ' && w === 'Z');
    if (completed && wd !== want) { score += 14; notes.push(`Corrective completion reversal (${pc.type} ${w})`); }
    if (!completed) score -= 5;
  }

  const alt = ew.alternativeCount;
  if (alt) {
    const altDir = ewDir(alt);
    if (altDir && altDir !== want && (+alt.confidence || 0) >= (+pc.confidence || 0) - 10) {
      score -= 10;
      notes.push('Close alternative EW count conflicts');
    }
  }

  const confidence = +pc.confidence || 0;
  if (confidence >= 70) score += 8;
  else if (confidence >= 58) score += 4;
  else if (confidence < 50) score -= 4;

  return { score: Math.max(-20, Math.min(42, score)), ok: score >= 8, reason: notes.join(' · '), primary: pc, alternative: alt };
}

export function runPowerfulMaxGptStrategy({ symbol, setupCandles, h4Candles, d1Candles, price, cfg = {} } = {}) {
  const c = valid(setupCandles), h4 = valid(h4Candles), d1 = valid(d1Candles);
  if (c.length < 80 || h4.length < 45 || d1.length < 25 || !(+price > 0)) return [];

  const minScore = Number.isFinite(+cfg.minScore) ? +cfg.minScore : 76;
  const baseCfg = {
    ...cfg,
    minScore: Number.isFinite(+cfg.baseMinScore) ? +cfg.baseMinScore : 62,
    elliottConfluenceEnabled: true,
    zonePct: Number.isFinite(+cfg.zonePct) ? +cfg.zonePct : 0.014,
  };
  const base = runCryptoConfluenceStrategy({
    symbol, setupCandles: c, h4Candles: h4, d1Candles: d1, price,
    cfg: baseCfg, forceEw: true, strategyName: 'powerful_max_gpt',
  });
  if (!base.length) return [];

  const ew15 = analyseElliottWave(c, { zigzag: true, minConfidence: 45, minLegAtr: 0.70 });
  const ew4h = analyseElliottWave(h4, { zigzag: true, minConfidence: 45, minLegAtr: 0.65 });
  const ew1d = analyseElliottWave(d1, { zigzag: true, minConfidence: 45, minLegAtr: 0.55 });
  const s4 = detectStructure(h4), s1 = detectStructure(d1);
  const rvol = relativeVolume(c);
  const atr = calcATR(c, 14);

  const out = [];
  for (const r of base) {
    const dir = dirOf(r);
    const q15 = waveQuality(ew15, dir);
    if (!q15.ok) continue;
    const q4 = waveQuality(ew4h, dir);
    const q1 = waveQuality(ew1d, dir);

    const h4Aligned = dir === 'LONG' ? (s4.bias === 'bullish' || s4.bos === 'bullish') : (s4.bias === 'bearish' || s4.bos === 'bearish');
    const d1Aligned = dir === 'LONG' ? (s1.bias === 'bullish' || s1.bos === 'bullish') : (s1.bias === 'bearish' || s1.bos === 'bearish');
    const fib = fibConfluence(c, dir, atr);
    const multiTfEw = (q4.primary && ewDir(q4.primary) === dir ? 8 : 0) + (q1.primary && ewDir(q1.primary) === dir ? 7 : 0);
    const htf = (h4Aligned ? 6 : 0) + (d1Aligned ? 8 : 0);
    const volume = rvol >= 1.25 ? 7 : rvol >= 1.0 ? 4 : 0;

    let harmonic = null, chartPattern = null;
    try {
      harmonic = (runHarmonicStrategy({ symbol, candles: c, price, cfg: { patternTf: '15m', minScore: 55 } }) || [])
        .filter((x) => dirOf(x) === dir).sort((a,b) => (+b.score||0)-(+a.score||0))[0] || null;
    } catch (_) {}
    try {
      const cp = runChartPatternStrategy({ symbol, patternCandles: c, htfCandles: h4, price, cfg: { patternTf: '15m', htf: '4h', minSignalScore: 50 }, includeNear: false });
      chartPattern = (cp?.setups || []).filter((x) => dirOf(x) === dir && (x.metadata?.breakoutConfirmed === true || x.quality?.breakoutConfirmed === true))
        .sort((a,b) => (+b.score||0)-(+a.score||0))[0] || null;
    } catch (_) {}

    const patternBonus = (harmonic ? 7 : 0) + (chartPattern ? 8 : 0);
    const score = Math.min(100, Math.round((+r.score || 0) + q15.score + multiTfEw + htf + fib.score + volume + patternBonus));
    if (score < minScore) continue;

    const conf = [...(r.conf || [])];
    conf.push(`POWERFUL MAX: ${q15.reason}`);
    if (q4.primary) conf.push(`4H EW ${q4.primary.type} ${q4.primary.direction} W${q4.primary.currentWave} (${Math.round(q4.primary.confidence)}%)`);
    if (q1.primary) conf.push(`1D EW ${q1.primary.type} ${q1.primary.direction} W${q1.primary.currentWave} (${Math.round(q1.primary.confidence)}%)`);
    if (h4Aligned) conf.push('4H structure aligned');
    if (d1Aligned) conf.push('1D structure aligned');
    if (fib.hits.length) conf.push(`Local Fibonacci confluence ${fib.hits.map(x => x.ratio).join(', ')}`);
    if (rvol >= 1) conf.push(`Relative volume ${rvol.toFixed(2)}x`);
    if (harmonic) conf.push(`Harmonic confirmation: ${harmonic.pattern || harmonic.metadata?.harmonic?.family || 'pattern'}`);
    if (chartPattern) conf.push(`Chart pattern confirmation: ${chartPattern.pattern || chartPattern.metadata?.pattern || 'breakout'}`);

    out.push({
      ...r,
      strategy: 'powerful_max_gpt',
      score,
      conf,
      quality: {
        ...(r.quality || {}),
        powerfulMax: true,
        multiTfElliott: multiTfEw > 0,
        h4ElliottAligned: !!(q4.primary && ewDir(q4.primary) === dir),
        d1ElliottAligned: !!(q1.primary && ewDir(q1.primary) === dir),
        localFibConfluence: fib.hits.length > 0,
        harmonicConfirmed: !!harmonic,
        chartPatternConfirmed: !!chartPattern,
      },
      metadata: {
        ...(r.metadata || {}),
        strategy: 'powerful_max_gpt',
        patternTf: '15m',
        htf: '4h/1d',
        powerfulMax: {
          architecture: '1D/4H CONTEXT → FULL ELLIOTT → KEY ZONE → LIQUIDITY SWEEP → OB/FVG → FIB → VOLUME/MOMENTUM → 15m CHoCH/BOS → ENTRY',
          primaryElliott: q15.primary,
          alternativeElliott: q15.alternative,
          allElliottCounts15m: (ew15.allCounts || []).slice(0, 10),
          allElliottCounts4h: (ew4h.allCounts || []).slice(0, 8),
          allElliottCounts1d: (ew1d.allCounts || []).slice(0, 8),
          elliott4h: q4.primary,
          elliott4hAlternative: q4.alternative,
          elliott1d: q1.primary,
          elliott1dAlternative: q1.alternative,
          fib,
          rvol,
          harmonic: harmonic?.metadata?.harmonic || null,
          chartPattern: chartPattern ? { pattern: chartPattern.pattern, score: chartPattern.score, metadata: chartPattern.metadata } : null,
          scoreBreakdown: { base: +r.score || 0, ew15: q15.score, multiTfEw, htf, fib: fib.score, volume, patternBonus },
        },
      },
    });
  }
  return out.sort((a,b) => b.score - a.score);
}
