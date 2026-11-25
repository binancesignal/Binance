# Auto limit orders from the Scanner board (build binance-17)

## Flow
1. `harmonic-refresh` cron (and the scan cron, and an admin status change) → `triggerAutoTrade()`.
2. `processBinanceUserAutoTrades()` (LIMIT mode), per armed user:
   1. **Sync** pending limits with Binance (`lib/trading/limitSync.js`)
      - filled → read position, place SL + TP, execution becomes `PROTECTED` (= in trade)
      - cancelled / expired outside the bot → `CANCELLED` with the reason
      - (before this build a filled limit was never given SL/TP — fixed)
   2. **Score rotation** (`lib/trading/limitRotation.js`): ready pool = every `ENTRY_READY` signal on the Scanner
      board (incl. ones the admin pinned), best score first. Only the best `maxPendingLimitOrders`
      (admin setting, default **1**) may hold a waiting limit.
      - better score appears → old limit cancelled, new limit placed
      - equal / lower score → nothing changes (no swapping)
      - the signal leaves ENTRY READY → its limit is cancelled
      - better one disappears later and the weaker one is still ready → it gets its order back
      - a limit that already filled is never cancelled (checked on Binance first)
   3. place limits for the signals the plan asks for (admin: margin %, leverage fraction, offset %, SL/TP)

## Portfolio tab
`AutoOrdersPanel` polls `/api/user/auto-orders` every 3 s (database only, no Binance call):
- waiting limit orders, trades in progress, and orders that were **not placed / failed / cancelled** with the reason
- every card: signal entry, limit price, SL, TP1-3 (✅ when reached), qty, position size, margin, leverage,
  score, pattern + timeframe, D zone, Binance order id, environment, history timeline, "replaced X" note
- live signal strip: signal status, market price, % from entry
- the entry-ready queue (who has the order, who waits for a higher score) and the last bot run
- the heavy Binance account poll is now 4 s; the tab is called (not mounted inline) so it is no longer
  re-mounted on every parent render.

A skipped signal is re-checked at most every 3 min and Telegram is sent only when the reason changes.

## Scanner tab — admin status
Each card has an **Admin status** select (visible to admin without opening the card) and an **Auto** button.
- the chosen status is **pinned**: refresh cron and re-scans keep it while price/levels keep updating
- pin ends when the admin presses **Auto**, or the market really finishes the trade (SL / TP3)
- choosing `ENTRY_READY` makes the bot treat it like any ready signal (limit order, score rotation)
- changing a status runs the trader immediately

Also fixed: opening a card crashed the Scanner feed (`statusMsg` undefined); TP status never lowers
(TP2 → TP1) and TP3 is final; `TP1 ✅ then SL` keeps the TP1 tick.

## Admin
Auto-trade settings → **Waiting limit orders at once (best score wins)** → `maxPendingLimitOrders`.

## Admin pin → order (build binance-17b)
- an admin-pinned ENTRY READY ignores the minimum score and ranks FIRST (admin decision beats score)
- setting ENTRY READY runs the trader at once and the Scanner tab shows the result ("✅ limit order placed" or the reasons)
- Portfolio lists everything that blocks orders for the user (auto-trade OFF, not armed for Binance, High Risk not confirmed,
  no API keys, plan) and the last run's blocker; signals below the minimum score show in the queue with the reason
