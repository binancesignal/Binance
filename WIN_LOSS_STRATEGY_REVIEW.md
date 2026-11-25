# WIN / LOSS Strategy Review — Crypto Confluence

Date: 2026-10-25  
Strategy reviewed: `crypto_confluence` (`lib/scanner/strategy/cryptoConfluence.js`)  
Sample: 7 COMPLETED_PROFIT charts + 7 unique STOPPED charts (user-supplied screenshots)

**Important:** This is a small, same-day sample. All 7 winners were SHORT. Findings guide filters; they do not prove future win rate or guarantee fewer stop-outs.

---

## 1. WIN samples — findings

| Symbol | Dir | Score | HTF | EMA | RSI | RVOL | Risk | Key notes |
|--------|-----|-------|-----|-----|-----|------|------|-----------|
| MORPHOUSDT | SHORT | 88 | NEUTRAL | bear | 26 | 2.03 | ~1.3% | 4H Swing Low, fresh BEAR OB |
| GRTUSDT | SHORT | 88 | NEUTRAL | bear | 32 | 1.86 | ~1.2% | Previous Day Low |
| 1000CATUSDT | SHORT | 80 | NEUTRAL | bear | 32 | 0.98 | ~1.0% | FVG overlaps OB |
| (others) | SHORT | 76–80 | NEUTRAL | bear | 32–37 | 0.70–1.17 | ~1.1–1.4% | PDL / Fib / volume |

**Common WIN characteristics (observed, not guessed):**
- Direction: **all SHORT**
- HTF 4H/1D: **NEUTRAL** (no displayed BOS/CHoCH)
- 15m EMA: **bear / aligned** with SHORT
- Fresh **BEAR** Order Block
- 15m liquidity sweep + 15m CHoCH/BOS close
- Key zone and/or Fib 0.618–0.786 present
- RSI roughly mid-low (26–37), not extreme oversold
- Risk distance typically **~1.0%–1.4%** (structurally meaningful)
- RVOL mixed (0.70–2.03) — **not** a hard separator

---

## 2. LOSS samples — findings

| Symbol | Dir | Score | HTF | EMA | RSI | RVOL | Risk | Notable issues |
|--------|-----|-------|-----|-----|-----|------|------|----------------|
| JSTUSDT | LONG | 83 | NEUTRAL | **bear** | 31 | 0.78 | **0.21%** | Counter-EMA; **micro SL** |
| SAPIENUSDT | SHORT | 76 | NEUTRAL | **mixed** | 35 | 1.42 | 0.72% | EMA mixed; **bullish DIV** |
| DYMUSDT | LONG | 79 | NEUTRAL | **bear** | 37 | 0.82 | 2.60% | Counter-EMA LONG |
| ROBOUSDT | SHORT | 79 | NEUTRAL | **mixed** | **4** | 0.86 | 0.90% | Extreme RSI chase |
| ZKPUSDT | LONG | 88 | NEUTRAL | **bear** | 17 | 1.85 | 3.54% | Counter-EMA; RSI extreme |
| AUSDT | SHORT | 80 | NEUTRAL | **mixed** | **15** | 1.26 | 1.16% | Extreme RSI; EMA mixed |
| GLMUSDT | SHORT | 79 | NEUTRAL | **mixed** | 35 | 0.64 | 1.21% | EMA mixed; low RVOL |

**Recurring loss drivers in this sample:**
1. **15m EMA misalignment / mixed** (most stopped trades)
2. **Counter-trend LONG** while EMA bear
3. **Extreme RSI** on shorts (4, 15) — chasing exhausted moves
4. **Micro stop** (JST 0.21%) — normal 15m wick noise can hit
5. HTF NEUTRAL alone did **not** separate win vs loss

---

## 3. WIN vs LOSS comparison (do not overfit)

| Factor | WIN | LOSS | Action |
|--------|-----|------|--------|
| HTF NEUTRAL | Present | Present | **Do not hard-reject** |
| 15m EMA aligned | All | Rare / mixed / counter | **Hard require alignment** |
| Extreme RSI (short <22 / long >78) | Absent | Present in several | **Hard reject extremes** |
| Risk distance | ~1.0–1.4% | One at 0.21% | **Min risk floor** |
| RVOL | Mixed | Mixed | Score only, not hard gate |
| Key zone + Fib | Present | Often present | Keep existing requirement |
| Fresh OB + sweep + BOS | Present | Present | Keep core sequence |

Preserve: neutral HTF + aligned 15m EMA + structural OB/FVG/sweep/BOS + meaningful SL.  
Filter: EMA counter/mixed, RSI chase, micro-SL, clearly opposed HTF, stale BOS.

---

## 4. Code changes (this pass — V4 + V5)

Files: `lib/scanner/strategy/cryptoConfluence.js`, `lib/signals/signalLifecycle.js`

| Change | Reason |
|--------|--------|
| Keep hard **EMA21/EMA50 alignment** | Strongest separator in sample |
| RSI anti-chase: SHORT RSI < **22**, LONG RSI > **78** | LOSS had RSI 4/15; WIN floor ~26 |
| **Min risk floor**: risk ≥ 0.45×ATR and ≥ 0.45% of price | Blocks JST-style 0.21% stops |
| Soft −6 score if key-zone name is wrong-sided | LONG@High / SHORT@Low seen in a stopped chart |
| Keep SL buffer 0.35 ATR beyond OB **and** sweep extreme | Structural invalidation, not arbitrary distance |
| Keep bosAge ≤ 18, opposed HTF reject, key∨fib required | Prior V2/V3 logic retained |
| READY→ONGOING stricter body/ATR (existing lifecycle) | Avoid touch-only fills |
| **V5: Opposite RSI divergence hard reject at scan** | SAPIENUSDT SHORT had bullish DIV → never emit signal |
| **V5: READY/WATCHING → INVALIDATED if opposite DIV** | Blocks ONGOING even if signal already existed |

**Not changed:** UI, auth, DB, admin, other strategies, env secrets.

---

## 5. SL improvements

- SL is **not** a fixed arbitrary %.
- Placement: beyond **min/max(OB edge, sweep extreme)** + `max(0.35×ATR, 0.10% price)`.
- New floor prevents “noise stop” when OB body is tiny.
- Floor is still tied to ATR/structure so R:R is not arbitrarily destroyed.

---

## 6. Signal quantity

- No mass of new hard filters that would drive signals near zero.
- EMA alignment + RSI + min risk remove low-quality setups; core sequence + neutral HTF still allowed.
- Target remains **approximately 5–10 signals/day** in normal conditions (quality filters may reduce count in weak markets). Not a guarantee.

---

## 7. Sample-size limitations & risks

- n=14 charts, one session, **all winners SHORT** → LONG behavior under-sampled.
- EMA/RSI thresholds tuned near observed edges; slight overfit risk.
- No full historical backtest infrastructure run in this review → no invented win-rate numbers.
- Live-forward validation still required before increasing risk size.

---

## 8. Tests / build

See final response for `npm test` / build output. Existing failures (if any) are reported separately from changes introduced here.
