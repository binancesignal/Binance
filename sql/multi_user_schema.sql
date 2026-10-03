-- Multi-user SaaS schema extension for Binance/Bybit Live Board
-- Run in Supabase SQL editor. Does NOT drop existing tables.

-- Plans
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  auto_trade BOOLEAN NOT NULL DEFAULT false,
  max_positions INTEGER NOT NULL DEFAULT 3,
  max_pairs INTEGER NOT NULL DEFAULT 50,
  features JSONB DEFAULT '[]'::jsonb,
  trial_days INTEGER DEFAULT 0,
  stripe_price_id TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO plans (id, name, price_cents, auto_trade, max_positions, max_pairs, features, trial_days)
VALUES
  ('trial',  'Trial',  0,    false, 1,  5,   '["signals_view"]', 7),
  ('signal', 'Signal', 1900, false, 0,  50,  '["signals_view","telegram"]', 0),
  ('auto',   'Auto',   4900, true,  5,  100, '["signals_view","telegram","auto_trade"]', 0),
  ('pro',    'Pro',    9900, true,  15, 200, '["signals_view","telegram","auto_trade","priority"]', 0)
ON CONFLICT (id) DO NOTHING;

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  plan TEXT NOT NULL DEFAULT 'trial' REFERENCES plans(id),
  trial_started_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  subscription_status TEXT NOT NULL DEFAULT 'trialing'
    CHECK (subscription_status IN ('trialing','active','past_due','canceled','expired')),
  stripe_customer_id TEXT,
  is_suspended BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan);

-- Subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'trialing',
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);

-- Per-user Bybit keys (encrypted)
CREATE TABLE IF NOT EXISTS user_exchange_keys (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL DEFAULT 'bybit',
  encrypted_key TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  key_hint TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, exchange)
);

-- Per-user trading settings
CREATE TABLE IF NOT EXISTS user_trading_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Admin audit log
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID,
  action TEXT NOT NULL,
  meta JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log(created_at DESC);

-- Optional: add user_id to trade_executions for multi-user isolation later
-- ALTER TABLE trade_executions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

-- Personal Telegram link (run if columns missing)
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_linked_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code_expires TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_tg_chat ON users(telegram_chat_id);
CREATE INDEX IF NOT EXISTS idx_users_tg_code ON users(telegram_link_code);
