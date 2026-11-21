-- 006: multi-exchange (Bybit + Binance) support.
-- RUN THIS BEFORE DEPLOYING the new code (new inserts write signals.exchange).

-- 1) every signal belongs to one exchange. Existing rows were produced on Bybit.
ALTER TABLE signals ADD COLUMN IF NOT EXISTS exchange TEXT NOT NULL DEFAULT 'bybit';
ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_exchange_check;
ALTER TABLE signals ADD CONSTRAINT signals_exchange_check CHECK (exchange IN ('bybit','binance'));
CREATE INDEX IF NOT EXISTS idx_signals_exchange_status ON signals (exchange, status);

-- 2) per-user connection mode + verification info.
--    mode: 'mock' = exchange testnet keys, 'live' = real-money keys.
ALTER TABLE user_exchange_keys ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'mock';
ALTER TABLE user_exchange_keys DROP CONSTRAINT IF EXISTS user_exchange_keys_mode_check;
ALTER TABLE user_exchange_keys ADD CONSTRAINT user_exchange_keys_mode_check CHECK (mode IN ('mock','live'));
ALTER TABLE user_exchange_keys ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE user_exchange_keys ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
-- existing Bybit rows were saved as testnet keys
UPDATE user_exchange_keys SET mode = 'mock' WHERE mode IS NULL;
