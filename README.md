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

### 6. Cron (unchanged)

Keep hitting `/api/cron/scan` with `Authorization: Bearer CRON_SECRET` every 5 minutes.

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

SQL (if needed):
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_linked_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code_expires TIMESTAMPTZ;
```

Env optional: `TELEGRAM_BOT_USERNAME=YourBotName`
