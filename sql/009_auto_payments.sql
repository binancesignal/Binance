-- Auto deposit / withdraw flags
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS auto_deposit_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS auto_withdraw_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS auto_withdraw_max_usdt NUMERIC NOT NULL DEFAULT 50;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS deposit_auto_confirm_minutes INTEGER NOT NULL DEFAULT 0;
