/**
 * Volume Profile with Node Detection — port of the LuxAlgo indicator (peak nodes = the blue zones).
 *
 * Defaults are the indicator's own defaults:
 *   Profile Lookback Length 360 bars · Number of Rows 100 · Value Area 70 %
 *   Volume Peaks: "Peaks", Node Detection Percent 9 %, Volume Node Threshold 1 %
 *
 * Differences from the TradingView script (on purpose):
 *  - the volume of every bar is spread over its high–low range using the bars of the scanned timeframe.
 *    TradingView first requests lower-timeframe bars (1h chart → 5m bars) for a finer spread; that would be
 *    ~12× more Binance requests per coin and a ban risk, and the peak rows barely move because of it.
 *  - the profile is computed once per scan, at the last closed bar (as the indicator shows it "now").
 */

export const VP_DEFAULTS = Object.freeze({
  length: 360, // Profile Lookback Length
  rows: 100, // Profile Number of Rows
  valueAreaPct: 70, // Value Area (%)
  peakNodePct: 9, // Node Detection Percent % (peaks)
  thresholdPct: 1, // Volume Node Threshold %
});

const num = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export function normalizeVpConfig(raw = {}) {
  const d = VP_DEFAULTS;
  return {
    length: Math.round(num(raw.length, d.length, 10, 5000)),
    rows: Math.round(num(raw.rows, d.rows, 30, 130)),
    valueAreaPct: num(raw.valueAreaPct, d.valueAreaPct, 0, 100),
    peakNodePct: num(raw.peakNodePct, d.peakNodePct, 1, 100),
    thresholdPct: num(raw.thresholdPct, d.thresholdPct, 0, 100),
  };
}

/**
 * Volume per price row over the last `length` candles.
 * @returns {null | {low, high, step, rows, total:number[], bull:number[], startTime, startIndex, pocLevel, vahLevel, valLevel}}
 */
export function computeVolumeProfile(candles, cfgIn = {}) {
  const cfg = normalizeVpConfig(cfgIn);
  if (!Array.isArray(candles) || candles.length < 10) return null;
  const startIndex = Math.max(0, candles.length - cfg.length);
  const win = candles.slice(startIndex);
  let low = Infinity;
  let high = -Infinity;
  for (const c of win) {
    if (c.low < low) low = c.low;
    if (c.high > high) high = c.high;
  }
  if (!(high > low)) return null;
  const rows = cfg.rows;
  const step = (high - low) / rows;
  const total = new Array(rows).fill(0);
  const bull = new Array(rows).fill(0);

  for (const c of win) {
    const vol = +c.volume;
    if (!(vol > 0)) continue;
    const cLow = +c.low;
    const cHigh = +c.high;
    const polarity = +c.close > +c.open;
    const s = Math.max(Math.floor((cLow - low) / step), 0);
    const e = Math.min(Math.floor((cHigh - low) / step), rows - 1);
    if (!(cHigh > cLow)) {
      // flat bar: all its volume sits on one row
      total[s] += vol;
      if (polarity) bull[s] += vol;
      continue;
    }
    for (let r = s; r <= e; r++) {
      const lvl = low + r * step;
      let prop;
      if (cLow >= lvl && cHigh > lvl + step) prop = (lvl + step - cLow) / (cHigh - cLow);
      else if (cHigh <= lvl + step && cLow < lvl) prop = (cHigh - lvl) / (cHigh - cLow);
      else if (cLow >= lvl && cHigh <= lvl + step) prop = 1;
      else prop = step / (cHigh - cLow);
      total[r] += vol * prop;
      if (polarity) bull[r] += vol * prop;
    }
  }

  // POC and value area (same walk as the indicator)
  let poc = 0;
  for (let i = 1; i < rows; i++) if (total[i] > total[poc]) poc = i;
  const target = total.reduce((a, b) => a + b, 0) * (cfg.valueAreaPct / 100);
  let vah = poc;
  let val = poc;
  let acc = total[poc];
  while (acc < target) {
    if (val === 0 && vah === rows - 1) break;
    const up = vah < rows - 1 ? total[vah + 1] : 0;
    const dn = val > 0 ? total[val - 1] : 0;
    if (up === 0 && dn === 0) break;
    if (up >= dn) {
      acc += up;
      vah += 1;
    } else {
      acc += dn;
      val -= 1;
    }
  }

  return {
    low,
    high,
    step,
    rows,
    total,
    bull,
    startIndex,
    startTime: win[0].time,
    pocLevel: poc,
    vahLevel: vah,
    valLevel: val,
    cfg,
  };
}

/**
 * Volume PEAK nodes (the blue zones). A row is a peak when each of the N rows before it and the N rows after
 * it carry LESS volume (N = rows × Node Detection Percent), its volume is above the threshold % of the
 * maximum, and rows outside the profile count as zero.
 * @returns {Array<{index:number, lo:number, hi:number, volume:number, pct:number}>}
 */
export function findPeakNodes(profile) {
  if (!profile) return [];
  const { total, rows, low, step, cfg } = profile;
  const N = Math.floor(rows * (cfg.peakNodePct / 100));
  const max = Math.max(...total);
  if (!(max > 0)) return [];
  const at = (i) => (i < 0 || i >= rows ? 0 : total[i]);
  const out = [];
  for (let i = 0; i < rows; i++) {
    const v = total[i];
    if (!(v / max > cfg.thresholdPct / 100)) continue;
    let peak = true;
    for (let k = 1; k <= N && peak; k++) {
      if (at(i - k) >= v || at(i + k) >= v) peak = false;
    }
    if (peak) out.push({ index: i, lo: low + i * step, hi: low + (i + 1) * step, volume: v, pct: (v / max) * 100 });
  }
  return out;
}

/** Peak-node convenience: profile + peaks in one call (null when there is no usable volume). */
export function volumePeaks(candles, cfgIn = {}) {
  const profile = computeVolumeProfile(candles, cfgIn);
  if (!profile) return null;
  return { profile, peaks: findPeakNodes(profile) };
}

const overlaps = (aLo, aHi, bLo, bHi) => Math.min(aHi, bHi) - Math.max(aLo, bLo) > 0;

/**
 * Peaks that sit inside (overlap) a breaker block. `breakers` are the ones that already overlap the D zone,
 * so a hit means: D zone ∩ breaker ∩ blue zone.
 * @returns {{nodes: Array, breakers: Array}} nodes carry the id of the breaker they overlap
 */
export function peaksInBreakers(peaks, breakers) {
  const nodes = [];
  const used = new Set();
  for (const br of breakers || []) {
    const bLo = Math.min(br.bot, br.top);
    const bHi = Math.max(br.bot, br.top);
    for (const p of peaks || []) {
      if (!overlaps(p.lo, p.hi, bLo, bHi)) continue;
      nodes.push({ ...p, breakerId: br.id ?? null });
      used.add(br.id);
    }
  }
  return { nodes, breakers: (breakers || []).filter((b) => used.has(b.id)) };
}
