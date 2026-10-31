// Pure helper (no I/O) so it can be unit-tested without a database.
/** Pure: sum the income rows that belong to one trade. Returns null until Binance has reported a realized PnL. */
export function summarizeIncome(rows, { fromMs, toMs = Infinity }) {
  const mine = (rows || []).filter((r) => r.time >= fromMs && r.time <= toMs);
  const realized = mine.filter((r) => r.type === 'REALIZED_PNL');
  if (!realized.length) return null;
  const sum = (type) => mine.filter((r) => r.type === type).reduce((s, r) => s + r.income, 0);
  const gross = sum('REALIZED_PNL');
  const commission = sum('COMMISSION');
  const funding = sum('FUNDING_FEE');
  return {
    gross,
    commission,
    funding,
    net: gross + commission + funding,
    closedAtMs: Math.max(...realized.map((r) => r.time)),
  };
}
