/**
 * Plain signal chart for users: candles + Entry / SL / TP1-3 only.
 * No zones, no fib lines, no strategy text.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fp = (n) => {
  const v = +n;
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : a >= 0.01 ? 6 : 8;
  return v.toFixed(d);
};

export function buildPlainSignalChartSvg({ symbol, side, entry, sl, tp1, tp2, tp3, tpPct = [], riskPct, candles, price, tfLabel = '', visible = 90 }) {
  const cs = (candles || []).slice(-visible).filter((c) => [c.open, c.high, c.low, c.close].every((x) => Number.isFinite(+x)));
  if (cs.length < 10) return null;
  const W = 820;
  const H = 520;
  const L = 14;
  const R = 150; // room for level labels
  const T = 64;
  const B = 44;
  const px1 = W - R;
  const levels = [entry, sl, tp1, tp2, tp3].map(Number).filter(Number.isFinite);
  const lo0 = Math.min(...cs.map((c) => +c.low), ...levels);
  const hi0 = Math.max(...cs.map((c) => +c.high), ...levels);
  const pad = (hi0 - lo0) * 0.06 || hi0 * 0.01;
  const lo = lo0 - pad;
  const hi = hi0 + pad;
  const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const step = (px1 - L) / cs.length;
  const cw = Math.max(1.5, step * 0.62);
  const isBuy = String(side).toUpperCase() === 'BUY';
  const UP = '#22c55e';
  const DN = '#ef4444';
  const parts = [];

  parts.push(`<rect width="${W}" height="${H}" fill="#0b1220"/>`);
  // zones
  const zone = (a, b, fill) => parts.push(`<rect x="${L}" y="${Math.min(y(a), y(b))}" width="${px1 - L}" height="${Math.abs(y(a) - y(b))}" fill="${fill}"/>`);
  zone(entry, sl, 'rgba(239,68,68,.12)');
  zone(entry, tp3, 'rgba(34,197,94,.10)');
  // grid
  for (let i = 0; i <= 4; i++) {
    const gy = T + ((H - T - B) * i) / 4;
    parts.push(`<line x1="${L}" x2="${px1}" y1="${gy}" y2="${gy}" stroke="#1e293b" stroke-width="1"/>`);
  }
  // candles
  cs.forEach((c, i) => {
    const x = L + step * i + step / 2;
    const up = +c.close >= +c.open;
    const col = up ? UP : DN;
    parts.push(`<line x1="${x}" x2="${x}" y1="${y(+c.high)}" y2="${y(+c.low)}" stroke="${col}" stroke-width="1"/>`);
    const top = y(Math.max(+c.open, +c.close));
    const h = Math.max(1, Math.abs(y(+c.open) - y(+c.close)));
    parts.push(`<rect x="${x - cw / 2}" y="${top}" width="${cw}" height="${h}" fill="${col}"/>`);
  });
  // level lines + labels
  const line = (v, color, label, dash) => {
    if (!Number.isFinite(+v)) return;
    const yy = y(+v);
    parts.push(`<line x1="${L}" x2="${px1}" y1="${yy}" y2="${yy}" stroke="${color}" stroke-width="1.4" ${dash ? 'stroke-dasharray="6 4"' : ''}/>`);
    parts.push(`<rect x="${px1 + 4}" y="${yy - 11}" width="${R - 10}" height="22" rx="5" fill="${color}"/>`);
    parts.push(`<text x="${px1 + 10}" y="${yy + 4}" font-size="12" font-weight="700" fill="#fff" font-family="system-ui,sans-serif">${esc(label)}</text>`);
  };
  line(tp3, '#16a34a', `TP3 ${fp(tp3)}`);
  line(tp2, '#16a34a', `TP2 ${fp(tp2)}`);
  line(tp1, '#16a34a', `TP1 ${fp(tp1)}`);
  line(entry, '#2563eb', `ENTRY ${fp(entry)}`, true);
  line(sl, '#dc2626', `SL ${fp(sl)}`);
  if (Number.isFinite(+price)) {
    const yy = y(+price);
    parts.push(`<line x1="${L}" x2="${px1}" y1="${yy}" y2="${yy}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2 4"/>`);
    parts.push(`<text x="${px1 - 6}" y="${yy - 5}" text-anchor="end" font-size="11" fill="#cbd5e1" font-family="system-ui,sans-serif">Now ${esc(fp(price))}</text>`);
  }
  // header
  parts.push(`<text x="${L}" y="30" font-size="20" font-weight="800" fill="#f8fafc" font-family="system-ui,sans-serif">${esc(symbol)}</text>`);
  parts.push(`<rect x="${L + 8 + String(symbol).length * 13}" y="12" width="62" height="26" rx="13" fill="${isBuy ? UP : DN}"/>`);
  parts.push(`<text x="${L + 8 + String(symbol).length * 13 + 31}" y="30" text-anchor="middle" font-size="13" font-weight="800" fill="#fff" font-family="system-ui,sans-serif">${isBuy ? 'BUY' : 'SELL'}</text>`);
  parts.push(`<text x="${L}" y="52" font-size="12" fill="#94a3b8" font-family="system-ui,sans-serif">Risk ${esc(riskPct ?? '—')}% · TP1 +${esc(tpPct[0] ?? '—')}% · TP2 +${esc(tpPct[1] ?? '—')}% · TP3 +${esc(tpPct[2] ?? '—')}%${tfLabel ? ` · ${esc(tfLabel)}` : ''}</text>`);
  parts.push(`<text x="${L}" y="${H - 14}" font-size="10" fill="#64748b" font-family="system-ui,sans-serif">Closed candles · informational only, not financial advice.</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(symbol)} signal chart">${parts.join('')}</svg>`;
}

/** neutral display time frame — does not reveal the exact LTF used by the strategy */
export function displayTfFor(ltf) {
  if (ltf === '5m' || ltf === '15m') return '15m';
  if (ltf === '30m' || ltf === '1h') return '1h';
  return '4h';
}
