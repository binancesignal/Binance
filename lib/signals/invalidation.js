export const INVALIDATION_CATEGORIES = [
  'Breakout',
  'HTF / Structure',
  'SMC / Order Block',
  'Confluence',
  'Rejection',
  'Score / Quality',
  'Elliott Wave',
  'Risk / RR',
  'Entry Quality',
  'Expired',
];

export function buildInvalidationRecord({
  signal,
  previousStatus,
  category = 'Entry Quality',
  reasons = [],
  price,
  at = new Date().toISOString(),
}) {
  const normalized = (Array.isArray(reasons) ? reasons : [reasons])
    .filter(Boolean)
    .map((item) =>
      typeof item === 'string'
        ? { category, reason: item, actual: null, required: null }
        : {
            category: item.category || category,
            reason: item.reason || 'Validation failed',
            actual: item.actual ?? null,
            required: item.required ?? null,
            ...(item.code ? { code: item.code } : {}),
            ...(item.details ? { details: item.details } : {}),
          }
    );
  const primary = normalized[0] || {
    category,
    reason: 'Signal invalidated',
    actual: null,
    required: null,
  };

  return {
    category: primary.category || category,
    reason: normalized.map((item) => item.reason).join('; '),
    reasons: normalized.length ? normalized : [primary],
    previousStatus: previousStatus || signal?.status || 'UNKNOWN',
    price: price ?? signal?.current_price ?? signal?.last_price ?? null,
    time: at,
    originalScore: signal?.score ?? null,
    currentScore: normalized.find((item) => item.code === 'RESCORE')?.actual ?? null,
    actual: normalized.length === 1 ? primary.actual : null,
    required: normalized.length === 1 ? primary.required : null,
  };
}