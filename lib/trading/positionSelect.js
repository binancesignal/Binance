// Pure helper (no I/O) so it can be unit-tested without a database.
export const dirOf = (p) => (p.side === 'Buy' ? 'LONG' : 'SHORT');

/** Pick the positions to close. `target` = { symbol, direction } or { all: true }. */
export function selectPositions(positions, target = {}) {
  if (target.all) return positions;
  const sym = String(target.symbol || '').toUpperCase();
  const dir = String(target.direction || '').toUpperCase();
  return positions.filter((p) => p.symbol === sym && (!dir || dirOf(p) === dir));
}
