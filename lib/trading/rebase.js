/**
 * Signals are built from MAINNET market data, but orders are sent to Bybit TESTNET,
 * whose prices can differ a lot (especially on altcoins). We always rebase every
 * price level by testnetPrice / mainnetPrice so percentage distances
 * (risk, TP1/2/3, R:R) stay exactly the same on the testnet book.
 *
 * Previously we skipped when divergence > 10%. That blocked most altcoin tests
 * on testnet. For testing the full order → protect flow we now always rebase
 * and never skip solely because of price divergence.
 */
const MIN_REBASE = 0.0005; // <0.05% → ignore (treat as same price)

const PRICE_FIELDS = ['entry', 'entry_hit_price', 'sl', 'tp1', 'tp2', 'tp3'];

export function rebaseSignalToTestnet(signal, testnetPrice) {
  const tn = +testnetPrice;
  const ref = +signal.current_price || +signal.last_price || +signal.entry_hit_price || +signal.entry;
  if (!(tn > 0) || !(ref > 0)) {
    return { ok: false, reason: 'Testnet price unavailable' };
  }
  const ratio = tn / ref;
  const divergence = Math.abs(ratio - 1);

  const out = { ...signal };
  const original = { ...(signal.metadata?.mainnetLevels || {}) };
  const testnetLevels = {};
  for (const f of PRICE_FIELDS) {
    const v = signal[f];
    if (v != null && v !== '' && Number.isFinite(+v)) {
      if (original[f] == null) original[f] = +v;
      const rebased = divergence < MIN_REBASE ? +v : +v * ratio;
      out[f] = rebased;
      testnetLevels[f] = rebased;
    }
  }
  const effectiveRatio = divergence < MIN_REBASE ? 1 : ratio;
  out.metadata = {
    ...(signal.metadata || {}),
    mainnetLevels: original,
    testnetLevels,
    testnetRebaseRatio: effectiveRatio,
    testnetDivergencePct: +(divergence * 100).toFixed(2),
  };
  return {
    ok: true,
    signal: out,
    ratio: effectiveRatio,
    rebased: divergence >= MIN_REBASE,
  };
}
