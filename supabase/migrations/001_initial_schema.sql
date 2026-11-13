-- Binance HQ Signal Monitor — initial schema
-- Run in Supabase SQL editor

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ========== signals ==========
CREATE TABLE IF NOT EXISTS signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id TEXT UNIQUE NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  status TEXT NOT NULL CHECK (status IN (
    'WATCHING', 'READY', 'ONGOING', 'COMPLETED_PROFIT', 'STOPPED', 'INVALIDATED'
  )),
  score NUMERIC,
  entry NUMERIC,
  entry_hit_price NUMERIC,
  sl NUMERIC,
  tp1 NUMERIC,
  tp2 NUMERIC,
  tp3 NUMERIC,
  rr NUMERIC,
  current_price NUMERIC,
  current_pnl_percent NUMERIC,
  atr_5m NUMERIC,
  distance_to_entry NUMERIC,
  distance_percent NUMERIC,
  atr_distance NUMERIC,
  proximity_score NUMERIC,
  ready_threshold NUMERIC,
  ob_low NUMERIC,
  ob_high NUMERIC,
  ob_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at TIMESTAMPTZ,
  entry_hit_at TIMESTAMPTZ,
  tp1_hit_at TIMESTAMPTZ,
  tp2_hit_at TIMESTAMPTZ,
  tp3_hit_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  last_updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_price NUMERIC,
  max_profit_percent NUMERIC,
  max_loss_percent NUMERIC,
  tp1_hit BOOLEAN DEFAULT FALSE,
  tp2_hit BOOLEAN DEFAULT FALSE,
  tp3_hit BOOLEAN DEFAULT FALSE,
  ready_notified BOOLEAN DEFAULT FALSE,
  entry_notified BOOLEAN DEFAULT FALSE,
  tp1_notified BOOLEAN DEFAULT FALSE,
  tp2_notified BOOLEAN DEFAULT FALSE,
  tp3_notified BOOLEAN DEFAULT FALSE,
  sl_notified BOOLEAN DEFAULT FALSE,
  invalidated_notified BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_signals_signal_id ON signals (signal_id);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals (symbol);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals (status);
CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_active ON signals (status)
  WHERE status IN ('WATCHING', 'READY', 'ONGOING');
CREATE INDEX IF NOT EXISTS idx_signals_last_updated ON signals (last_updated_at DESC);

-- ========== signal_events ==========
CREATE TABLE IF NOT EXISTS signal_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  price NUMERIC,
  old_status TEXT,
  new_status TEXT,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_events_signal_id ON signal_events (signal_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON signal_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON signal_events (event_type);

-- ========== scan_runs ==========
CREATE TABLE IF NOT EXISTS scan_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  symbols_scanned INTEGER DEFAULT 0,
  signals_created INTEGER DEFAULT 0,
  signals_updated INTEGER DEFAULT 0,
  ready_count INTEGER DEFAULT 0,
  ongoing_count INTEGER DEFAULT 0,
  watching_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  error_message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_scan_runs_started ON scan_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_runs_status ON scan_runs (status);

-- RLS: enable, no public write
ALTER TABLE signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_runs ENABLE ROW LEVEL SECURITY;

-- Allow anon read of signals (optional — prefer API gateway)
CREATE POLICY "Allow public read signals"
  ON signals FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Allow public read events"
  ON signal_events FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Allow public read scan_runs"
  ON scan_runs FOR SELECT
  TO anon, authenticated
  USING (true);

-- Writes only via service role (bypasses RLS)
COMMENT ON TABLE signals IS 'HQ order-block signals with lifecycle status';
COMMENT ON TABLE signal_events IS 'Lifecycle event log for signals';
COMMENT ON TABLE scan_runs IS 'Server-side scan run audit log';
