/**
 * User level (Bronze → Diamond) from the user's own traded volume.
 * Volume = sum of notional (USDT) of the user's bot executions that really reached the exchange.
 */
export const LEVELS = [
  { name: 'Bronze', min: 0, color: '#C98A5E' },
  { name: 'Silver', min: 1_000_000, color: '#A8B0BC' },
  { name: 'Gold', min: 5_000_000, color: '#E6B422' },
  { name: 'Platinum', min: 20_000_000, color: '#7FB7D6' },
  { name: 'Diamond', min: 50_000_000, color: '#6C8CFF' },
];

const NOT_TRADED = ['FAILED', 'SKIPPED', 'CANCELLED', 'REJECTED'];

export function sumTradedVolume(executions) {
  let total = 0;
  for (const e of Array.isArray(executions) ? executions : []) {
    if (!e || e.dry_run) continue;
    if (NOT_TRADED.includes(String(e.status || '').toUpperCase())) continue;
    const n = Number(e.notional);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return Math.round(total * 100) / 100;
}

export function levelFromVolume(volume) {
  const v = Math.max(0, Number(volume) || 0);
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) if (v >= LEVELS[i].min) idx = i;
  const cur = LEVELS[idx];
  const next = LEVELS[idx + 1] || null;
  const progress = next ? Math.min(1, (v - cur.min) / (next.min - cur.min)) : 1;
  return {
    level: cur.name,
    color: cur.color,
    volume: v,
    nextLevel: next ? next.name : null,
    nextColor: next ? next.color : cur.color,
    target: next ? next.min : cur.min,
    progress,
  };
}
