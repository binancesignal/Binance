-- Per-user exchange execution records for user-armed auto-trading.
ALTER TABLE trade_executions
  ADD COLUMN IF NOT EXISTS exchange TEXT NOT NULL DEFAULT 'bybit',
  ADD COLUMN IF NOT EXISTS mode TEXT,
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE trade_executions DROP CONSTRAINT IF EXISTS trade_executions_exchange_check;
ALTER TABLE trade_executions
  ADD CONSTRAINT trade_executions_exchange_check CHECK (exchange IN ('bybit', 'binance'));

ALTER TABLE trade_executions DROP CONSTRAINT IF EXISTS trade_executions_mode_check;
ALTER TABLE trade_executions
  ADD CONSTRAINT trade_executions_mode_check CHECK (mode IS NULL OR mode IN ('mock', 'live'));

-- Replace the old global signal+side lock with a per-user, per-exchange lock.
-- The sentinel keeps legacy/admin executions with NULL user_id mutually unique.
DROP INDEX IF EXISTS uq_trade_exec_signal_side;
CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_exec_user_exchange_signal_side
  ON trade_executions (
    (COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    exchange,
    signal_id,
    side
  )
  WHERE status NOT IN ('FAILED', 'CANCELLED');

CREATE INDEX IF NOT EXISTS idx_trade_exec_user_exchange_created
  ON trade_executions (user_id, exchange, created_at DESC);
