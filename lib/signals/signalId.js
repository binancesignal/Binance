/**
 * Deterministic signalId to prevent duplicates.
 * signalId = symbol_direction_obTime_entryRounded
 */
export function buildSignalId(symbol, direction, obTime, entry) {
  const dir = (direction || 'LONG').toUpperCase();
  const t = obTime || 0;
  // Round entry to reduce float noise while keeping uniqueness
  const e = Number(entry).toPrecision(8).replace(/\./g, 'p').replace(/-/g, 'm');
  return `${symbol}_${dir}_${t}_${e}`;
}

export function parseSignalId(signalId) {
  const parts = String(signalId).split('_');
  if (parts.length < 4) return null;
  return {
    symbol: parts[0],
    direction: parts[1],
    obTime: parts[2],
    entryKey: parts.slice(3).join('_'),
  };
}
