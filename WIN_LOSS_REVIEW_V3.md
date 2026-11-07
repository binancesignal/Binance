# Crypto Confluence — Win/Loss Review V3

Reviewed the supplied chart exports: 7 unique stopped trades and 7 profit trades.

## What the samples actually showed

- 4H/1D NEUTRAL appeared in both winners and losers, so rejecting NEUTRAL HTF would remove good trades too.
- All 7 supplied winners were SHORT setups with the 15m EMA state shown as bearish/aligned.
- The stopped sample was dominated by EMA-mixed or counter-trend entries; the supplied LONG losses were entered while the 15m EMA state was bearish.
- Very stretched RSI also appeared in some stopped shorts (e.g. deeply oversold), so an extreme momentum anti-chase guard was added.
- RVOL alone was not a reliable separator: a supplied winner had RVOL below 1.0, while some losses had RVOL above 1.0. Therefore RVOL remains a score/confirmation factor, not a hard neutral-HTF gate.

## V3 changes

1. Removed the V2 hard rule requiring NEUTRAL HTF setups to have key-zone + Fib + FVG + RVOL >= 1.10.
2. Added 15m EMA21/EMA50 direction confirmation as a hard entry-quality gate.
3. Added an extreme RSI anti-chase guard (SHORT below RSI 20 / LONG above RSI 80 rejected).
4. Kept liquidity sweep, OB/FVG, Fib/key-zone, BOS freshness, structural SL buffer and lifecycle close-confirmation logic.
5. EMA alignment is also included in the confluence score and metadata.

## Important limitation

This is a very small user-supplied sample and all 7 winners happen to be SHORT trades. It is useful for fixing an obvious false filter (HTF NEUTRAL), but it is not enough to prove future win rate or guarantee fewer stop losses. Validate on a larger, mixed LONG/SHORT sample and live-forward data before increasing risk.
