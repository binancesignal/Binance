# Signal Desk — Multi-User SaaS (Binance/Bybit Live Board + Auto-Trade)

Walt / Phantom style fintech UI · 7-day free trial · Stripe-ready billing · Admin panel

**Existing scanner, signal lifecycle, Telegram live board, Bybit auto-trade logic, and 15-minute protection are preserved.**  
This release adds multi-user auth, plans/trial, per-user encrypted keys, entitlement gates, and a full UI redesign on top.

---

## What’s new (v2)

| Feature | Description |
|--------|-------------|
| Auth | Email/password signup & login (JWT cookie sessions) |
| Trial | 7-day free trial on signup (`TRIAL_DAYS` env) |
| Plans | trial / signal / auto / pro — admin assignable |
| UI | Mobile-first fintech wallet style (soft gray, white cards, blue pills, bottom tabs) |
| Per-user keys | Bybit API keys encrypted at rest (`ENCRYPTION_KEY`) |
| Auto-trade gate | Only Auto/Pro plans can enable auto-trade |
| Admin | `/admin` — users, extend trial, assign plan, suspend |
| Legacy | Scanner, Telegram board, cron, signal APIs unchanged |

---

## Scanner strategy modes

Admins can select **Independent Zone + Pattern Confluence**, **Chart Pattern**, **ICT SMC**,
**ICT + Chart Pattern (Balanced)**, or strict **ICT + Chart Pattern confirmation** in Admin →
Scanner. Balanced mode scans ICT and chart-pattern setups independently, so either can produce a
candidate. The strict mode is
an AND-filter and only keeps ICT setups with a confirmed chart-pattern breakout for the same coin
and direction; it can produce very few signals. The admin scanner page has an **Apply recommended
ICT + Pattern defaults** action for updating saved settings. Active signals are not changed.
ICT SMC is an explicit, rules-based interpretation of the
provided BOS / liquidity-sweep / POI reference: it looks for a closed-candle liquidity raid,
displacement close through a confirmed swing, then a fresh Order Block and/or Fair Value Gap
for a possible retrace. Setup candles default to 15m with 1h context; both timeframes can be
changed in scanner settings. It is ICT-inspired, not a claim to reproduce unavailable video rules
or to predict profitable trades.
Recommended chart defaults scan 15m, 30m, and 1h patterns, soften volume/HTF/context gates, and
keep closed-candle breakout, freshness, and reward/risk checks. Applying the preset affects new
signals only; existing active signals remain unchanged. Signals are not guarantees of profit.

For ICT SMC signals, **WATCHING** means price is waiting for the POI, **READY** means price is
near/inside the POI, and **ONGOING** means the entry level has been reached.

### Independent Zone + Pattern Confluence

The **Independent Zone + Pattern Confluence** mode is separate from the existing ICT and chart
pattern strategies. It clusters weekly/daily highs and lows, confirmed swing levels, Fibonacci
retracements, order blocks, and unfilled FVGs into price zones. A candidate then needs two reactions
at a confluence zone (for example a double bottom/top, higher low/lower high, or sweep-and-reclaim)
and a closed-candle break of the pattern neckline. Fibonacci alignment contributes to the score but
is not a mandatory gate.

Use **Apply recommended Zone + Pattern preset** in Admin → Scanner to select this mode and save its
own settings: 15m setup candles, 4h context, at least two distinct zone-source types, 0.45 ATR zone
clustering, 0.8 ATR maximum breakout chase, 60 minimum strategy score, and 1.2 minimum TP1 R:R.
The strategy bypasses the legacy scanner score, HTF, liquidity, entry-distance, gap, displacement,
and SMC/chart-pattern filters; its own zone, pattern, BOS, chase, stop-distance, and R:R checks apply.
It does not modify the settings for the other modes or existing active signals. This version has
synthetic unit tests, not a historical market replay or profitability backtest.

## Update: missed-TP1 entries, TP→SL counting, cleaner chart

**1. Wicks between cron ticks are no longer missed.** The monitor used to look only at the
current forming 5m candle, so a wick to TP1 between two ticks was invisible. Now it reads every
candle since the signal was created (WATCHING / READY) or since the entry fill (ONGOING)
(`lib/signals/pathRange.js`):
- WATCHING / READY: if price touched **TP1 before the entry was filled** (and later came back to
  the entry zone) the signal is INVALIDATED as *Missed Entry — TP1 before entry*.
- ONGOING: candles are walked in time order — a TP touched before the stop-out is kept, a TP that
  only appears after the stop-out is ignored.

**2. TP1/TP2 then SL = TP, not SL.** Results tiles, win rate, signal cards, the Telegram board and
the recent-results list now count such a trade once, at the highest TP it reached. Only a stop that
never touched any TP is an SL. Win rate = (TP3 + TP→SL) / (TP3 + TP→SL + pure SL).

**3. Existing records are healed automatically.** `lib/signals/healTpBeforeSl.js` re-reads the
candles between entry and stop for every STOPPED trade of the last 30 days that has no TP flag; if a
TP was reached first, `tp1_hit/tp2_hit/tp3_hit` are written. It runs from the full-scan cron in small
batches (6 per run), checks each trade once, and sleeps 6h when nothing is left.
Run it all at once: `POST /api/admin/heal-tp` (admin login, or `?secret=CRON_SECRET`;
optional `days`, `limit`). `GET /api/admin/heal-tp` shows its status. No SQL migration needed.

**3b. ONGOING needs a real entry touch.** READY → ONGOING now also requires that price traded through the entry level since the signal was created (a SHORT whose price sat below entry used to count as "closed beyond entry" and went ONGOING without touching it). READY/ONGOING chart lines are drawn apart when on the same candle, and pinned to the left edge when older than the visible candles.

**4. Cleaner chart.** Default `labels=clean`: small faint OB/FVG/BOS tags parked on the left edge,
only the latest 4 HH/HL/LH/LL labels, READY/ONGOING time tags on the plot edge. The web chart has a
**Labels: clean / all** button; `/api/chart?...&labels=full` gives the old big labels.

---

## Quick setup

### 1. Install

```bash
npm install
```

### 2. Environment variables

Create `.env.local` (or set in Vercel):

```env
# Required for production DB
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Auth & encryption (generate strong secrets)
JWT_SECRET=long-random-string-at-least-32-chars
ENCRYPTION_KEY=64-char-hex-or-base64-32-byte-key

# Existing
CRON_SECRET=your-cron-secret

# Optional
TRIAL_DAYS=7
# STRIPE_SECRET_KEY=sk_...
# STRIPE_WEBHOOK_SECRET=whsec_...
```

Generate secrets:

```bash
# JWT
openssl rand -base64 48

# ENCRYPTION_KEY (32 bytes hex)
openssl rand -hex 32
```

### 3. Database

1. Keep your existing tables (`signals`, `trade_executions`, `app_state`, `scan_runs`, …).
2. Run the new schema:

```bash
# In Supabase SQL Editor, paste and run:
cat sql/multi_user_schema.sql
```

### 4. Create first admin

In local dev (in-memory) or after schema is applied, sign up normally, then promote:

**Option A — Supabase SQL**

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@email.com';
```

**Option B — Dev memory**  
Sign up, then in a one-off script or by temporarily setting role in `createUser`.

### 5. Run

```bash
npm run dev
# open http://localhost:3000 → redirected to /login
```

### 6. Cron (two jobs)

Both accept `Authorization: Bearer CRON_SECRET` or `?secret=CRON_SECRET`.

| Job | URL | Every | Does |
|-----|-----|-------|------|
| Lifecycle | `/api/cron/scan` | 1 min | Monitors ALL active signals (entry / TP / SL / invalidation) + scans a rotating chunk of 15 coins |
| Full scan | `/api/cron/full-scan` | 5 min (admin-configurable) | Sweeps ALL coins (top volume first) within a time budget; creates new signals and updates levels of existing WATCHING/READY signals in place. ONGOING / closed signals are never changed |

- **Background mode (default):** both cron URLs answer instantly (`{"started":true}`) and run the scan in
  `after()`, so cron-job.org's 30s limit can no longer time out. Append `&wait=1` to a cron URL to hold the
  response until the scan finishes (debugging only). Results: **Admin → Scan log** (live status, every coin
  scanned with its result, coverage of the whole list, run history). Scan log data lives in `app_state`
  (no migration needed).
- **Binance ban guard:** HTTP 418 (IP banned) stops the scan at once, stores the ban end time and every
  later cron tick sends **no requests** until it expires (shown as a red banner in Admin → Scan log).
  HTTP 429 is retried once and then treated as a 60s back-off. The client also reads Binance's
  `x-mbx-used-weight-1m` header and pauses when the IP's used weight reaches 1400/2400
  (`BINANCE_WEIGHT_SOFT_LIMIT`), which matters on Vercel's shared IPs.
- Concurrency: only one scan runs at a time. The 1-min job skips if busy; the full scan waits up to
  15s, otherwise it is deferred and the next 1-min run promotes itself to a full sweep.
- Run `supabase/migrations/005_single_running_scan.sql` to make that lock atomic (two crons firing in
  the same second can no longer both start).
- Time budget: Admin → System → *Full scan time budget* (or env `FULL_SCAN_BUDGET_SECONDS`, default 40s).
  Coins not reached are continued by the 1-min cron via the saved cursor.

---

## Architecture (phase 1)

```
┌─────────────┐     shared feed      ┌──────────────┐
│   Scanner   │ ──────────────────► │   Signals    │
│  (global)   │                     │  (global)    │
└─────────────┘                     └──────┬───────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ▼                      ▼                      ▼
              User A (keys)          User B (keys)          User C (view only)
              Auto if plan=auto      Auto if plan=auto      Plan=signal/trial
```

- One shared scanner + Telegram live board  
- Many users consume signals  
- Auto-trade uses **per-user** encrypted Bybit keys when plan allows  

---

## Plans (default)

| Plan   | Price | Auto-trade | Notes |
|--------|-------|------------|-------|
| Trial  | Free  | No         | 7 days, limited view |
| Signal | $19   | No         | Board + Telegram |
| Auto   | $49   | Yes        | + auto-trade, 5 positions |
| Pro    | $99   | Yes        | Higher limits |

Admin can extend trial or assign any plan without payment (comp).

---

## UI screens

- **Home** — greeting, trial ring, icon actions, status counts  
- **Signals** — card list + filter pills (Watching / Ready / Ongoing)  
- **Trade** — auto-trade toggle (gated), risk summary  
- **Keys** — Bybit key form (masked after save)  
- **Plans** — comparison cards + upgrade CTA  
- **Profile** — email, disclaimer, logout, admin link  

Mobile: bottom tab bar. Desktop: same design language, wider shell.

---

## Security notes

- API secrets encrypted with AES-256-GCM (`ENCRYPTION_KEY`)  
- Never echoed after save  
- Session JWT in httpOnly cookie  
- Admin routes require `role=admin`  
- Existing `CRON_SECRET` protection retained  
- Soft-lock premium when trial ends — data is never deleted  

---

## Stripe (structure ready)

Checkout + webhooks can be wired to:

- `app/api/billing/checkout` (create session)  
- `app/api/billing/webhook` (activate plan on `checkout.session.completed` / `invoice.paid`)  

Store `stripe_customer_id` / `stripe_subscription_id` on users & subscriptions tables.  
PayHere (LK) can be added later alongside Stripe.

---

## Migrating from v1 (single-user)

1. Deploy schema  
2. Set env vars (`JWT_SECRET`, `ENCRYPTION_KEY`)  
3. Create admin user  
4. Move global Bybit keys into the admin user’s key vault if desired  
5. Keep cron and Telegram config as before (still global via `app_state`)  

Legacy dashboard is saved as `app/page.legacy.js` for reference.

---

## Scripts

```bash
npm run dev      # local
npm run build    # production build
npm test         # existing unit tests
```

---

## Disclaimer

Trading involves substantial risk of loss. This software does not guarantee profits.  
Prefer Bybit **Testnet** keys until you fully understand behaviour.  
No guaranteed profit claims are made in the product copy.

---

## Personal Telegram alerts (multi-user)

1. Admin configures **one** bot (token + chat_id for live board + **bot_username** without @).
2. Set webhook:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR_DOMAIN/api/telegram/webhook"
   ```
3. User: Profile → **Connect Telegram** → opens `t.me/Bot?start=CODE` → taps Start.
4. READY / ONGOING / TP / SL go as **personal DMs** to linked users with active trial/plan.
5. Live board channel remains global (unchanged).
6. READY messages include a **Full chart analysis** button. Send `/analyze` or `/chart` to the bot
   to choose another active signal and receive its annotated chart.
7. The liveboard also has a **READY charts** button that filters the picker to READY signals.
   In the web app, open a signal’s details and select **View ICT/SMC chart analysis**, or use
   **Analyze any coin with ICT/SMC** to enter another USDT perpetual symbol and timeframe.
   From Telegram, send `/chart BTC 15m` to request a chart for a specific coin; `/chart` without
   a symbol continues to open the active-signal picker.
 8. Closed outcomes stay in signal history: the Telegram liveboard shows recent **SL HIT** and
    **TP3 HIT** results, and the web Signals list includes history with an **SL Hit** filter.
    Closed outcomes remain separate from active monitoring and are not scanned or traded again.

The chart endpoint can also be called directly:
`/api/chart?symbol=BTC&strategy=ict_smc&timeframe=15m&format=svg`
Timeframes supported for ICT/SMC analysis are `5m`, `15m`, `30m`, `1h`, `2h`, and `4h`.
When no active setup matches, it still returns the chart with current market context and
reports `NO_SETUP` in the `X-ICT-Status` response header.

SQL (if needed):
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_linked_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code_expires TIMESTAMPTZ;
```

Env optional: `TELEGRAM_BOT_USERNAME=YourBotName`


---

## Multi-exchange (Binance default, Bybit optional)

- Run `supabase/migrations/005_single_running_scan.sql`, then
  `supabase/migrations/006_multi_exchange.sql` (adds `signals.exchange`, connection `mode`), then
  `supabase/migrations/007_user_exchange_executions.sql`.
- Crons scan Binance by default. Bybit scanning, analysis, and its admin-wide auto-trader run only when selected in
  Admin → System → *Exchanges the cron scans*. Each enabled exchange has its own coin
  list, cursor and signal rows. Bybit keeps the legacy signal-id format; Binance ids are prefixed `bin_`.
- Users pick the exchange they look at (Bybit | Binance switch). `/api/signals?exchange=` filters the feed.
- Per-user connections: `POST /api/user/exchanges` (`connect` / `disconnect` / `select` / `autotrade`).
  Keys are verified against the exchange before saving. `mode`: `mock` = testnet, `live` = real money
  (needs explicit confirmation). Both exchanges can be connected at once.
- Dashboard: `GET /api/user/portfolio?exchange=` → equity, available, unrealized P&L, positions, open orders.
- Auto-trade is armed for **one** exchange at a time (`autoTradeExchange`). Binance orders use the user's connected
  mock/testnet or explicitly confirmed live credentials, rebase mock protection levels to Binance Futures Testnet,
  and persist per-user execution records. Protective SL/TP use Binance USDⓈ-M conditional algo orders with
  `closePosition=true` and `workingType=MARK_PRICE`. Bybit remains on its existing admin-wide execution path.

---

## High Risk mode (Binance auto-trade)

The only risk mode. Each user confirms it once (Trade tab → *Risk mode*); until then no trades are placed for them. Parameters set by the admin (Admin → Auto-trade → *High Risk mode*).

- **Margin per trade:** fixed % of balance, never below 25% (default 25%, user may raise up to the admin max).
- **Leverage per trade is derived**, not chosen: `leverage = lossCap / (margin% × SL distance%)`, then limited by max
  leverage, the symbol's max and a liquidation-safety check. Tight SL (volatile coin) → more leverage, wide SL → less,
  so a stop-out costs about the same (default ≤ 5% of balance) every time.
- **Positions:** no fixed count — all open margin together ≤ *total margin cap* (default 75% → 3 trades at 25%).
  The old per-user default of 3 and the admin position cap do not apply in this mode (the plan cap still does).
- **Brakes:** SL tighter than 0.5% or wider than 8% is skipped; daily loss stop (10%, resets at Sri Lanka midnight);
  drawdown halt (20% from peak) until the user re-arms auto-trade. State in `app_state` key `risk_guard:<userId>`.
- The old Standard mode has been removed. Code: `lib/trading/riskSizing.js` (pure), integration in `lib/trading/binanceAutoTrader.js`.
- Tests: `tests/high-risk-sizing.test.js`, `tests/high-risk-flow.test.js` (fake Binance, mock host only).

## Update: My Profile screen

"More" / the profile icon now opens a **My Profile** screen: email, Level card (Bronze → Silver → Gold → Platinum → Diamond from your bot trading volume, `GET /api/user/level`), Verification (Verified / Unverified → opens the verify steps), **Settings** (the old contact / Telegram / account page), **Support**, Sign Out and a "Suggest new features" card (opens live chat). There is no Legal item.
Levels live in `lib/trading/userLevel.js` (thresholds $1M / $5M / $20M / $50M).

## Update: Welcome screen (after the splash)

Signed-out visitors (and Sign out) now go **splash → /welcome → Register / Sign in**.
- `/welcome`: 3–5 auto-sliding, swipeable slides (photo + title + text), dots, **Register** (→ /signup), **Sign in** (→ /login) and an optional **Google** button.
- **Admin → Welcome**: edit photo, title and text per slide, reorder, add (max 5), delete, Save, Reset to defaults, Preview. Photos are auto-cropped to **1080 × 1140 px** (the hero box); without a photo a built-in artwork is shown. Stored in `app_state` key `welcome_slides` (no SQL needed). Logo from Admin → Branding is shown on the top-left of the hero.
- **Google sign-in** is hidden until you set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (Google Cloud → OAuth client, type *Web*, redirect URI `https://YOUR-DOMAIN/api/auth/google/callback`). New Google users get a normal 7-day trial account.

## OB + HTF Fib — per-coin scan (Month / 3-Month / 1-Year added)

Any user can open **Coin Scan** on the live board, type a coin (`LTC` or `LTCUSDT`) and scan it.

* **Fib time frames (toggle):** Daily · Weekly · **Month · 3 Month · 1 Year**. Each one draws its *own* Fib
  from its last CLOSED candle (never the forming one). 3M / 1Y candles are built from monthly candles
  (Binance and Bybit).
* **LTF (toggle):** 5m · 15m · 30m · 1h · 2h · 4h. Every Fib TF is checked against **every** LTF, so the result is
  grouped `Fib TF → LTF` (also showing "signal නැත" for pairs without a setup).
* Each signal shows direction, Fib ratio, entry / SL / TP1, RR, score and the **order-block candle time**;
  the **Chart** button draws that exact Fib TF × LTF pair (OB zone + Fib line + previous H/L).
* API: `POST /api/scan/symbol { symbol, refTimeframes?, timeframes? }` → `groups[]` + flat `signals[]`
  (12 scans / minute / IP). Chart: `/api/chart?strategy=ob_fib&symbol=LTCUSDT&ref=1M&timeframe=1h&format=svg`.
* Code: `lib/scanner/strategy/obFib/scanSymbol.js` (LTF candles are downloaded once and reused for all Fib TFs).

### Coin Scan UI (signal cards)
Coin Scan results are rendered with the same light-theme `sg-card` signal cards as the live board (entry / SL / now / TP1-3, Fib TF + LTF tags, OB candle time, scan time). Tapping a card opens the OB + HTF Fib chart image for that exact (Fib TF × LTF) pair. Styles: `.cs-*` in `app/globals.css`.

## OB + HTF Fib — all-market scan, lifecycle & OB invalidation

* **Scanner (Admin → Scanner → "OB (HTF Fib + LTF Order Block)")** now runs the SAME core as the per-coin Coin Scan
  (`scanObFibCore` in `lib/scanner/strategy/obFib/scanSymbol.js`) for every coin of each chunk: every admin-selected
  Fib TF (Daily / Weekly / Month / 3 Month / 1 Year) draws its own Fib and is checked against every admin-selected LTF.
  LTF candles are downloaded once per coin and reused for all Fib TFs.
* Every signal stores **fib price (`metadata.obFib.hitPrice`), fib ratio, Fib TF (`refTf`/`refLabel`) and LTF (`patternTf`)**
  and shows them on the card / Telegram. WATCHING = waiting for price to return to the Fib ∩ OB zone,
  READY = price near entry, ONGOING = entry filled.
* **OB invalidation:** while a signal is WATCHING / READY the scanner re-runs the LuxAlgo detector on the signal's LTF
  (using the LuxAlgo parameters saved with the signal). If the signal's order block is no longer in the LuxAlgo list —
  mitigated (wick/close), pushed out by newer OBs, or structure flipped — the signal becomes **INVALIDATED**
  (category "Order Block"). Live price-based mitigation in `applyLifecycle` still applies on top. ONGOING trades are untouched.
  Missing/short candle data never invalidates a signal.
* **Sibling fix:** OB+Fib signals of the same coin / direction / LTF but a different Fib TF, fib line or order block are
  now separate signals (before, a rescan could overwrite one with another).

* **Auto-scan parity fix:** the generic *candle-quality* gate (wicky / small-candle filter) was applied to OB+Fib signals in the
  all-market scan but not in Coin Scan, so valid setups were dropped silently. It no longer applies to `ob_fib`, and every
  OB+Fib drop (score, RR, entry reached, TP1 before entry, too far) is now written to the scan log.

## Coin Scan fib-line filter & all-market scan weight cut

* **Fib lines (filter)** chips are now in Coin Scan (Scan + Backtest). Only the selected ratios (e.g. just 0.618) are
  targeted; the Chart button uses the same selection. API: `POST /api/scan/symbol { fibLevels: [0.618] }`.
  The auto scan keeps using the admin `fibLevels`.
* **Why the auto scan stopped after ~20 coins:** every coin downloaded ~19 API weight (5 Fib-TF candle sets + 6 LTF sets) and the
  scan cleared its candle cache on every run, so the Binance rate guard (1400/2400 per min) tripped after ~20 coins.
  Now (a) the Fib reference candles are kept in a persistent cache (`app_state.ob_fib_ref_cache:<exchange>`, valid until the next
  HTF candle closes → ~0 weight), and (b) an LTF is skipped when no selected Fib line is anywhere near the price
  (`pruneLtf`, generous ATR bound — Coin Scan never prunes). The first run after deploy fills the cache; the cursor keeps rotating
  until every coin has been covered.

## Coin Scan → "Scan all coins" (every Binance coin)

Leave the coin box **empty** and tap **Scan all coins**: every Binance USDT perpetual (highest 24h volume first) is scanned with the
selected **Fib TF × LTF × Fib lines**. Results stream in while it runs (progress bar, Stop button), can be filtered Buy/Sell and
sorted by nearest entry or score, and every row has a Chart button.
`POST /api/scan/market { refTimeframes, timeframes, fibLevels, offset, limit, symbols?, total? }` (login required) is called in
chunks of 8 coins; it shares the persistent Fib-candle cache and LTF pruning with the auto scanner, and on a Binance rate-guard hit the
client waits 20 s and retries the same chunk (results are de-duplicated).

## "Scan all coins" now uses the real chunked scanner (admin)

For an **admin**, tapping **Scan all coins** (empty coin box) runs the SAME chunked scanner as the cron job
(`POST /api/scan`, 15 coins per chunk, rotating cursor, final lifecycle pass) but forces **OB + HTF Fib for that run only**,
with the Fib TF / LTF / fib lines selected in Coin Scan (`strategyOverride: 'ob_fib'`, `obFibOverride`). Nothing is saved to the
admin settings. Signals are stored as normal WATCHING / READY / ONGOING signals and appear as the usual **Live board + signal cards**;
the board's new "OB + Fib (selected)" filter shows only the OB+Fib signals that match the selected Fib TF / LTF / fib lines.
Non-admin users keep the read-only preview list (`/api/scan/market`).
