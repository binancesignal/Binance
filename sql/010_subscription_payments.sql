-- Subscription payment methods + audit (extends 008_payments_referrals)
-- Safe to re-run

ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS usdt_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS paypal_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS bank_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS usdt_price NUMERIC;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS paypal_price NUMERIC;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS bank_price NUMERIC;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS usdt_fee_pct NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS paypal_fee_pct NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS bank_fee_pct NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS paypal_email TEXT;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS paypal_me_link TEXT;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS bank_instructions TEXT;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS require_profile_verify_for_pay BOOLEAN NOT NULL DEFAULT false;

-- Method used on each deposit
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS method TEXT DEFAULT 'usdt'
  CHECK (method IS NULL OR method IN ('usdt','paypal','bank'));
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS expected_amount NUMERIC;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS detected_amount NUMERIC;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USDT';
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS status_detail TEXT;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS detected_at TIMESTAMPTZ;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS external_ref TEXT;

-- Unique external tx → cannot activate two accounts
CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_tx_hash_unique
  ON deposits (tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash <> '';

-- Payment audit log
CREATE TABLE IF NOT EXISTS payment_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID REFERENCES deposits(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  source TEXT DEFAULT 'system',
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_audit_payment ON payment_audit(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_audit_created ON payment_audit(created_at DESC);
