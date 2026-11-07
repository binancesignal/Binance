-- =============================================
-- Payments, Wallet, Referrals, Deposits, Withdrawals
-- Run once in Supabase SQL Editor after main schema
-- =============================================

-- Extend users for referral + wallet
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
CREATE INDEX IF NOT EXISTS idx_users_plan_expires ON users(plan_expires_at);

-- App-wide payment / referral settings (single row style via key)
-- Reuse app_state if present; also dedicated table for clarity
CREATE TABLE IF NOT EXISTS payment_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  plan_price_usdt NUMERIC NOT NULL DEFAULT 49,
  plan_duration_days INTEGER NOT NULL DEFAULT 30,
  plan_name TEXT NOT NULL DEFAULT 'Pro',
  deposit_address_usdt TEXT,
  deposit_network TEXT NOT NULL DEFAULT 'TRC20',
  deposit_auto_confirm_minutes INTEGER NOT NULL DEFAULT 0,
  withdraw_min_usdt NUMERIC NOT NULL DEFAULT 10,
  withdraw_fee_usdt NUMERIC NOT NULL DEFAULT 1,
  withdraw_coins TEXT[] NOT NULL DEFAULT ARRAY['USDT','BTC','ETH','BNB'],
  referral_levels INTEGER NOT NULL DEFAULT 4,
  referral_rates NUMERIC[] NOT NULL DEFAULT ARRAY[10,5,3,2],
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO payment_settings (id) VALUES ('default')
ON CONFLICT (id) DO NOTHING;

-- Deposit requests
CREATE TABLE IF NOT EXISTS deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_usdt NUMERIC NOT NULL,
  unique_amount NUMERIC,
  network TEXT NOT NULL DEFAULT 'TRC20',
  address TEXT,
  tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','submitted','confirmed','rejected','expired')),
  note TEXT,
  confirmed_by UUID,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
CREATE INDEX IF NOT EXISTS idx_deposits_created ON deposits(created_at DESC);

-- Withdrawal requests
CREATE TABLE IF NOT EXISTS withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_usdt NUMERIC NOT NULL,
  coin TEXT NOT NULL DEFAULT 'USDT',
  coin_amount NUMERIC,
  coin_price_usdt NUMERIC,
  address TEXT NOT NULL,
  network TEXT DEFAULT 'TRC20',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','rejected','cancelled')),
  admin_note TEXT,
  processed_by UUID,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);

-- Wallet ledger (all balance changes)
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  balance_after NUMERIC,
  ref_type TEXT,
  ref_id TEXT,
  meta JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_user ON wallet_ledger(user_id, created_at DESC);

-- Referral earnings log
CREATE TABLE IF NOT EXISTS referral_earnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  earner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  level INTEGER NOT NULL,
  deposit_id UUID REFERENCES deposits(id) ON DELETE SET NULL,
  amount_usdt NUMERIC NOT NULL,
  rate_percent NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ref_earn_earner ON referral_earnings(earner_id, created_at DESC);

-- Done

-- Auto processing flags (safe to re-run)
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS auto_deposit_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS auto_withdraw_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS auto_withdraw_max_usdt NUMERIC NOT NULL DEFAULT 50;

