-- Auto-trading execution records
CREATE TABLE IF NOT EXISTS trade_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  status TEXT NOT NULL DEFAULT 'PENDING',
  score NUMERIC,
  signal_entry NUMERIC,
  actual_entry NUMERIC,
  quantity NUMERIC,
  margin NUMERIC,
  notional NUMERIC,
  leverage NUMERIC,
  tp1 NUMERIC,
  tp2 NUMERIC,
  tp3 NUMERIC,
  sl NUMERIC,
  atr_pct NUMERIC,
  dry_run BOOLEAN DEFAULT FALSE,
  entry_order_id TEXT,
  bybit_order_id TEXT,
  tp1_order_id TEXT,
  tp2_order_id TEXT,
  tp3_order_id TEXT,
  sl_order_id TEXT,
  realized_pnl NUMERIC,
  unrealized_pnl NUMERIC,
  error TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  filled_at TIMESTAMPTZ,
  protected_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);

-- One live/attempted execution per signal+side (idempotency)
CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_exec_signal_side
  ON trade_executions (signal_id, side)
  WHERE status NOT IN ('FAILED', 'CANCELLED');

CREATE INDEX IF NOT EXISTS idx_trade_exec_status ON trade_executions (status);
CREATE INDEX IF NOT EXISTS idx_trade_exec_symbol ON trade_executions (symbol);
CREATE INDEX IF NOT EXISTS idx_trade_exec_created ON trade_executions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_exec_signal ON trade_executions (signal_id);
