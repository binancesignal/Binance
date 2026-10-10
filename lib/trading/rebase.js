/**
 * Signals are built from mainnet market data, but mock orders use an exchange
 * testnet whose prices can differ a lot (especially on altcoins). Rebase every
 * level by executionPrice / mainnetPrice to preserve percentage distances.
 *
 * Previously we skipped when divergence > 10%. That blocked most altcoin tests
 * on testnet. Mock execution always rebases and never skips solely because of
 * price divergence.
 */
const MIN_REBASE = 0.0005; // <0.05% → ignore (treat as same price)

const PRICE_FIELDS = ['entry', 'entry_hit_price', 'sl', 'tp1', 'tp2', 'tp3'];

export function rebaseSignalToExchangePrice(signal, exchangeLivePrice, exchange = 'exchange') {
  const livePrice = +exchangeLivePrice;
  const ref = +signal.current_price || +signal.last_price || +signal.entry_hit_price || +signal.entry;
  if (!(livePrice > 0) || !(ref > 0)) {
    return { ok: false, reason: `${exchange} price unavailable` };
  }
  const ratio = livePrice / ref;
  const divergence = Math.abs(ratio - 1);

  const out = { ...signal };
  const original = { ...(signal.metadata?.mainnetLevels || {}) };
  const exchangeLevels = {};
  for (const f of PRICE_FIELDS) {
    const v = signal[f];
    if (v != null && v !== '' && Number.isFinite(+v)) {
      if (original[f] == null) original[f] = +v;
      const rebased = divergence < MIN_REBASE ? +v : +v * ratio;
      out[f] = rebased;
      exchangeLevels[f] = rebased;
    }
  }
  const effectiveRatio = divergence < MIN_REBASE ? 1 : ratio;
  out.metadata = {
    ...(signal.metadata || {}),
    mainnetLevels: original,
    exchangeLevels,
    exchangeRebaseRatio: effectiveRatio,
    exchangePriceDivergencePct: +(divergence * 100).toFixed(2),
    ...(exchange === 'testnet'
      ? {
          testnetLevels: exchangeLevels,
          testnetRebaseRatio: effectiveRatio,
          testnetDivergencePct: +(divergence * 100).toFixed(2),
        }
      : {}),
  };
  return {
    ok: true,
    signal: out,
    ratio: effectiveRatio,
    rebased: divergence >= MIN_REBASE,
  };
}

export function rebaseSignalToTestnet(signal, testnetPrice) {
  return rebaseSignalToExchangePrice(signal, testnetPrice, 'testnet');
}
