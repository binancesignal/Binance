/**
 * Telegram chart — candlesticks + every analysis element, rendered locally.
 *
 * Why this replaced the QuickChart version:
 *  - QuickChart "create" returns a URL even when the chart config is broken,
 *    so the fallbacks never ran and Telegram received a blank / failing image.
 *  - Its candlestick + annotation plugins could not draw swings, sweeps,
 *    FVG start points, volume, etc.
 *
 * Now: lib/telegram/chartSvg.js builds an SVG, @resvg/resvg-js turns it into a
 * PNG buffer (fonts are bundled, so it also works on Vercel), and
 * telegram.js uploads the buffer with sendPhoto.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SIGNAL_CONFIG } from '../config/signalConfig.js';
import { getKlines } from '../exchange/index.js';
import { buildChartSvg } from './chartSvg.js';
import { CHART_PATTERN_CONFIG } from '../scanner/strategy/chartPattern/config.js';
import { FONT_REGULAR_B64, FONT_BOLD_B64 } from './fontData.js';

let fontFiles = null;

/** resvg reads fonts from disk; write the bundled subsets to /tmp once per instance */
function ensureFonts() {
  if (fontFiles) return fontFiles;
  const dir = path.join(os.tmpdir(), 'hq-chart-fonts');
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    ['DejaVuSans-subset.ttf', FONT_REGULAR_B64],
    ['DejaVuSans-Bold-subset.ttf', FONT_BOLD_B64],
  ].map(([name, b64]) => {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    return f;
  });
  fontFiles = files;
  return files;
}

async function svgToPng(svg, width) {
  const { Resvg } = await import('@resvg/resvg-js');
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      fontFiles: ensureFonts(),
      loadSystemFonts: false,
      defaultFontFamily: 'DejaVu Sans',
    },
  });
  return resvg.render().asPng();
}

/**
 * Returns a PNG Buffer, or null if anything fails (caller falls back to text).
 * @param {object} signal   DB row or live scan result
 * @param {Array}  candles  optional pre-fetched OB-timeframe candles (closed)
 */
export async function generateSignalChartImage(signal, candles) {
  try {
    const meta = signal.metadata || {};
    // Strategy 2 (chart pattern) is detected on its own timeframe (15m by default),
    // NOT the SMC order-block timeframe — the chart must use the same candles.
    const isPat =
      (meta.strategy || signal.strategy) === 'chart_pattern' ||
      !!(meta.pattern || signal.pattern);
    const geom = isPat ? meta.patternGeom || null : null;
    const tf = isPat
      ? (geom && geom.tf) || meta.patternTf || CHART_PATTERN_CONFIG.patternTf || '15m'
      : meta.obTf || SIGNAL_CONFIG.obTf || '1h';
    const htf = isPat
      ? (geom && geom.htf) || meta.htf || CHART_PATTERN_CONFIG.htf || '1h'
      : meta.htf || SIGNAL_CONFIG.htf || '4h';
    let data = candles;
    if (!data?.length) {
      // same limit the scanner uses → usually a cache hit
      data = await getKlines(
        signal.symbol,
        tf,
        isPat ? CHART_PATTERN_CONFIG.patternKlineLimit || 120 : SIGNAL_CONFIG.obKlineLimit || 100
      );
    }
    if (!data?.length) {
      console.error('[chart] no candles for', signal.symbol);
      return null;
    }
    // show the whole pattern (+ a few candles of context), 60–90 candles
    let visible = 60;
    if (isPat && geom && geom.t0 != null) {
      const first = data.findIndex((c) => +c.time >= geom.t0);
      if (first >= 0) visible = Math.min(90, Math.max(60, data.length - first + 8));
    }
    const built = buildChartSvg(signal, data, { tf, htf, visible });
    if (!built) {
      console.error('[chart] not enough candles for', signal.symbol);
      return null;
    }
    // 1280px wide = Telegram's max photo width, so it is never re-scaled softer
    return await svgToPng(built.svg, 1280);
  } catch (e) {
    console.error('[chart] failed:', e?.stack || e?.message || e);
    return null;
  }
}
