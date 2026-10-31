/**
 * Server-only USDT payment verification (TRC20 via TronGrid).
 * No withdrawal / trading keys — read public chain data only.
 * Secrets: TRON_API_KEY (optional, rate-limit boost) via env only.
 */
const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

/**
 * @returns {Promise<null|{tx_hash,amount,from,timestamp}>}
 */
export async function findUsdtTrc20Deposit({ address, expectedAmount, sinceMs, tolerance = 0.02 }) {
  if (!address || !(expectedAmount > 0)) return null;
  const key = process.env.TRON_API_KEY || '';
  const headers = { Accept: 'application/json' };
  if (key) headers['TRON-PRO-API-KEY'] = key;

  const minTs = sinceMs || Date.now() - 7 * 24 * 3600 * 1000;
  const target = Number(expectedAmount);

  try {
    const url =
      `https://api.trongrid.io/v1/accounts/${encodeURIComponent(address)}/transactions/trc20` +
      `?only_to=true&limit=80&contract_address=${USDT_TRC20}`;
    const res = await fetch(url, { headers, cache: 'no-store' });
    if (!res.ok) {
      const err = new Error(`TronGrid HTTP ${res.status}`);
      err.retryable = true;
      throw err;
    }
    const json = await res.json();
    for (const tx of json.data || []) {
      const ts = Number(tx.block_timestamp || 0);
      if (ts && ts < minTs) continue;
      const amount = Number(tx.value || 0) / 1e6;
      if (Math.abs(amount - target) <= tolerance) {
        return {
          tx_hash: tx.transaction_id || tx.txID || null,
          amount,
          from: tx.from || null,
          timestamp: ts || null,
        };
      }
    }
  } catch (e) {
    if (e.retryable) throw e;
    console.warn('[verifyUsdt]', e.message);
  }
  return null;
}
