# Strategies: Elliott Wave Impulse + ABCD/SP breaker (build binance-22)

**Separate from the Harmonic strategy.** Own admin card (**Strategies**, under the Harmonic card), own settings
(`strategy_ui_config`), own timeframes, own master switches. The Harmonic settings (families, ratios, score, EMA /
breaker / volume / leg filters) do NOT apply to them. Shared with Harmonic: the **coin-scan system** (universe, chunk
size, rest time, server cron) and the **chart setting**. One cron pass scans each coin for Harmonic (if ON) and for the
strategies on their own timeframes.

Card buttons: Save · Save + start a full scan now · Stop cron · *Test coins now* (type 1–2 coins, see the result and the filter funnel).
The card shows a **funnel** (how many setups survive each filter) so an empty result is explainable.
Scanner tab: strategy chips (All / Harmonic / Elliott / ABCD·SP); one-signal-per-coin is applied per strategy.

Every result goes through the same board lifecycle
(Watching → Entry ready → In trade → TP / SL, Formed), the refresh cron, the admin status pin and the auto-trader.

| switch (Strategies card) | default |
|---|---|
| Also scan Harmonic patterns | ON (turn OFF to scan only the strategies) |
| Elliott Wave – Impulse | OFF |
| ABCD + SP breaker | OFF |

Code: `lib/scanner/strategy/harmonicScan/extraStrategies.js` · tests: `tests/extra-strategies.test.js`

## 1. Elliott Wave – Impulse (port of the Pine v4 indicator)
- zigzag (length 10), pivots confirmed like the indicator (`waitForConfirmation`), ±2 = higher-high / lower-low pivot
- wave 1 = P0→P1, wave 2 = P1→P2, **W2/W1 within ±5 % of 0.5 / 0.618 / 0.764 / 0.854**
- wave 1 pivot must be a higher-high (lower-low for shorts) and wave 2 must hold above the start of wave 1
- **Entry** = P2 ± 30 % of W2 · **Stop** = P0 · **T.Stop** = P2 ∓ 30 % of W2 · **Targets** = P2 ± 1.618 / 2.0 / 2.618 / 3.236 × W2
- entry is a *breakout* level (above the wave-2 low for longs): the price must trade up through it
- admin numbers: zigzag length, Fib error %, entry %

## 2. ABCD + SP breaker (Pine v6 ABCD + your rules)
- ABCD: swings 5/5, BC/AB 0.50–0.886, CD/BC 1.13–1.618, AB ≥ 1.5 × ATR (same as the script)
- **SP breaker** = a breaker block whose **starting (origin) candle** is on the AB or BC wave, at or before C, and that touches
  the **C candle (wick or body)**; side must match the trade. Breakers that start after C are never used.
  Option *Strict*: the breaker must also have been confirmed (broken) at or before C — OFF by default because it removed
  ~90 % of the otherwise valid setups in testing
- **Trend = EMA200**: the whole pattern must sit on one side of it. Fully below → trend down, fully above → trend up.
  A pattern that touches the EMA200 anywhere is skipped
- trend down + **upward** ABCD (HH, HL) → **LONG** · entry = SP breaker **top line** · stop = below its bottom line
- trend up + **downward** ABCD (LL, LH) → **SHORT** · entry = SP breaker **bottom line** · stop = above its top line
- stop buffer = admin number (× ATR, default 0.25); targets for now: TP1 half way back to D (min 1R), TP2 = D (min 1.5R),
  TP3 = D + 0.618 × CD (min 2.2R) — placeholders until you send the other trading setups
- admin numbers: swing bars, min AB leg (× ATR), stop buffer

## Lifecycle at scan time
| situation | status |
|---|---|
| a target was already hit before the scan | **FORMED** |
| entry already hit, no target / stop yet | IN_TRADE |
| entry not hit, price within the "Entry ready" % (auto-trade setting) | **ENTRY_READY** |
| entry not hit, farther away | **WATCHING** |
| stop hit / structure broken before the entry | not listed |

The refresh cron then follows the trade (entry → TP1/2/3 or SL). Chart: structure lines + labels, SP breaker box, EMA200,
entry / stop / T.Stop / targets. The card shows the strategy badge and a **Theory** text explaining the setup.

## Note for auto-trade
Elliott's entry is a breakout level. When a signal is ENTRY_READY a *limit* order at that level (price still below it for a
long) fills immediately at the market price, a little better than the entry. ABCD+SP entries are real retest levels, so a limit order waits for them.

## Live full scan (build binance-23)
Before, "Save + scan" only switched the server cron ON; coins were scanned only when an **external** cron-job.org call
hit `/api/cron/harmonic-scan`, so with no external cron nothing moved and nothing was shown.
Now the Strategies card **drives the scan itself while the page is open** (`scan_tick` action: one server tick after another,
same chunk size / rest time / ban protection as the cron) and shows, live:
- `Scanning 120 / 540 coins · 22 %` + progress bar, the next coin, the last coins finished (✓ chips), signals found, coins with errors
- the filter funnel (how many setups survive each filter)
- state line: 🟢 this page is running it / 🟡 cron ON but nobody is driving it / ⚪ not running
Buttons: **Save + start a full scan now**, **Continue scanning here** (after a reload), **Stop**.
With the page closed the scan continues only if the cron-job.org call to the scan URL is set (Harmonic card → cron box).
