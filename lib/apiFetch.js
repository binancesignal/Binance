const API_PROXY_PREFIX = '/trading-monitor-api';

/**
 * The workspace-level API artifact owns /api in the Replit preview router.
 * Route this app's browser requests through its own prefix; Next rewrites the
 * request internally to the existing app/api handlers.
 */
export function apiFetch(input, init) {
  const url =
    typeof input === 'string'
      ? input.replace(/^\/api(?=\/|$)/, API_PROXY_PREFIX)
      : input;
  return globalThis.fetch(url, init);
}
