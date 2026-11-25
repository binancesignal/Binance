# Harmonic — server crons (browser / phone can be OFF)

Two independent cron-job.org jobs. Both are GET, both answer immediately and work in the background
(so cron-job.org's 30 s limit never fails them).

Set / generate the secret in the admin panel: Harmonic → **Show server crons** → *Cron secret*.
(Stored in the database — no environment variable / redeploy needed.)

| Job | URL | Every |
|-----|-----|-------|
| **Full scan** (finds new signals, in chunks) | `https://YOUR-DOMAIN/api/cron/harmonic-scan?secret=YOUR_SECRET` | **1 min** |
| **Status refresh** (Watching → Entry ready → In trade → TP1/TP2/TP3 hit / SL hit, live price) | `https://YOUR-DOMAIN/api/cron/harmonic-refresh?secret=YOUR_SECRET` | **1–2 min** |

Test: add `&ping=1` (shows state) or `&wait=1` (runs once and shows the result).

## Full scan
- Turn it on in the admin panel: **Start server scan** (timeframes, rest between passes, coins per call).
- Each cron call scans the next N coins, saves them to the database straight away (admin + Scanner tab see
  them while the pass is still running), then moves a cursor forward. After the last coin it rests, then restarts.
- API-ban safe: small chunks, a pause between candle requests, Binance used-weight guard, ban circuit-breaker
  (while banned NO request is sent), overlapping calls are blocked by a lock, the coin that hit a limit is retried later.

## Status refresh
- Refreshes **every live signal in one run** and stamps them all with the same time.
- One candle download per coin+timeframe (cheap 499-candle request first), small parallelism.
- Finished signals (SL hit / TP3 / invalid / missed) are frozen. TP1/TP2 keep being tracked.
- Runs separately from the full scan, so signals found so far keep updating during a long scan pass.

## Scanner tab (all users)
`/api/harmonic-feed` reads the database only (never calls Binance for the list). Category tabs:
All · Entry ready · Watching · In trade · TP hit · SL hit · Missed. Cards show coin logo, entry / SL / market,
TP1–TP3 with ✅ when reached, pattern points, RR, update time and the chart.

## EMA 20/50 cross + EMA 200 touch (test scan, admin only)
Harmonic panel → blue button **EMA 20/50 cross + 200 touch**. Not a harmonic pattern.
Finds PAST (formed) EMA20/EMA50 crosses where the candle on the vertical line through the cross point
touched the same time frame's EMA200. Scans all USDT-perp coins in chunks of 6 with a 1.5 s pause
(Binance weight guard + ban circuit-breaker apply). Results are kept in the browser after a refresh.

## Leg filter + RSI divergence (Harmonic)
- Settings → **Leg filter**: when ON, a bearish (W-shape) harmonic must have X at the TOP of an up-leg and a bullish
  (M-shape) harmonic must have X at the BOTTOM of a down-leg. Only the move before X is checked (D beyond X is fine).
  Saved with *Save settings*; the server scan cron uses the saved values.
- Divergence: when a signal first becomes ENTRY READY (or FORMED), RSI(14) at X is compared with RSI at D
  (D = the extreme since C, i.e. where price is sitting). Regular / hidden, bullish / bearish as in the cheat-sheet.
  The result is judged once and frozen on the signal: card chip + RSI pane on the charts with the divergence line.
