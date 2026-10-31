/**
 * Sri Lanka time (Asia/Colombo, UTC+5:30)
 */
const TZ = 'Asia/Colombo';

export function formatLK(isoOrDate, opts = {}) {
  if (!isoOrDate) return '—';
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return '—';
  const withSeconds = opts.seconds !== false;
  return d.toLocaleString('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
    hour12: false,
  }).replace(',', '');
}

export function nowLK() {
  return formatLK(new Date());
}
