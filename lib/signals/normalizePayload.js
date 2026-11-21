export function normalizeSignalsPayload(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data)) return data;

  const active = Array.isArray(data.signals)
    ? data.signals
    : Array.isArray(data.active)
      ? data.active
      : [
          ...(Array.isArray(data.ongoing) ? data.ongoing : []),
          ...(Array.isArray(data.ready) ? data.ready : []),
          ...(Array.isArray(data.watching) ? data.watching : []),
        ];
  const invalidated = Array.isArray(data.invalidationCatalog)
    ? data.invalidationCatalog
    : Array.isArray(data.invalidated)
      ? data.invalidated
      : [];
  const combined = [
    ...active,
    ...invalidated,
    ...(Array.isArray(data.history) ? data.history : []),
  ];
  const seen = new Set();
  return combined.filter((signal, index) => {
    const key = signal?.signal_id || signal?.id ||
      `${signal?.symbol || 'signal'}:${signal?.status || ''}:${signal?.created_at || index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}