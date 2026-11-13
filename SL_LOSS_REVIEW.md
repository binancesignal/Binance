# Crypto Confluence SL loss review — 2026-10-24

Reviewed 7 unique STOPPED chart exports from photo.zip (duplicates ignored): JSTUSDT, SAPIENUSDT, DYMUSDT, ROBOUSDT, ZKPUSDT, AUSDT, GLMUSDT.

Observed common factor: all seven charts reported `HTF 4H/1D: NEUTRAL` with no displayed HTF BOS/CHoCH. Several READY→ONGOING transitions occurred quickly (e.g. GLM 4m; AUS 32m; JST/SAPIEN/ROBO about 29m), while DYM stayed pending for hours. This suggests weak/neutral HTF context plus permissive entry confirmation can admit lower-quality retests.

Changes made:
1. Reject a trade if either 4H or 1D is clearly opposed (both bias and BOS opposed on that TF).
2. Neutral HTF is still allowed to preserve signal frequency, but now requires all three: key-zone + Fib 0.618–0.786 + directional FVG, plus relative volume >= 1.10x.
3. Reject stale 15m BOS older than 18 candles (~4.5h).
4. Increase structural SL buffer from 0.22 ATR / 0.05% to 0.35 ATR / 0.10%, outside both OB and swept-liquidity extreme.
5. Crypto-confluence READY→ONGOING confirmation is stricter: body ratio >= 0.45, close >= 0.10 ATR beyond entry, stronger retest confirmation, and reduced chase allowance.

Important: these changes are evidence-guided from a small losing sample, not proof of improved expectancy. Validate on a larger set of wins + losses / historical candles before increasing risk. The 5–10/day figure remains a target, not a guarantee; quality filters can reduce count in weak markets.
