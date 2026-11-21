-- 012: SK SYSTEM PRO (independent strategy). Safe to run more than once. Existing tables are NOT touched.
-- RUN THIS BEFORE enabling SK SYSTEM PRO in production.

-- setup records (one row per unique 4H structure: symbol + direction + A swing)
CREATE TABLE IF NOT EXISTS sk_setups (
  id              TEXT PRIMARY KEY,                 -- sk_<SYMBOL>_<DIR>_<A time>
  symbol          TEXT NOT NULL,
  dir             TEXT NOT NULL CHECK (dir IN ('LONG','SHORT')),
  strategy        TEXT NOT NULL DEFAULT 'sk_system_pro',
  primary_tf      TEXT NOT NULL DEFAULT '4h',
  stage           TEXT NOT NULL,
  max_stage       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  outcome         TEXT,
  score           INTEGER NOT NULL DEFAULT 0,
  quality         TEXT,
  a               JSONB,                            -- A swing {time, price}
  b               JSONB,                            -- B swing
  c               JSONB,                            -- C swing + retrace ratio
  d               JSONB,                            -- projected D
  fib             JSONB,                            -- Fibonacci calculation (anchor, levels, extensions)
  entry           JSONB,                            -- locked entry zone / entry / SL / TP1-3
  hits            JSONB,                            -- entry / TP / SL timestamps
  invalidation    JSONB,
  analysis        JSONB,                            -- latest multi-timeframe analysis + chart annotations
  current_price   NUMERIC,
  close_reason    TEXT,
  scan_run_id     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_scanned_at TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sk_setups_status   ON sk_setups (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sk_setups_symbol   ON sk_setups (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sk_setups_stage    ON sk_setups (stage);
CREATE INDEX IF NOT EXISTS idx_sk_setups_created  ON sk_setups (created_at DESC);

-- lifecycle events (stage changes, TP / SL hits …) — one row per (setup, stage, type)
CREATE TABLE IF NOT EXISTS sk_setup_events (
  id        BIGSERIAL PRIMARY KEY,
  setup_id  TEXT NOT NULL REFERENCES sk_setups(id) ON DELETE CASCADE,
  type      TEXT NOT NULL DEFAULT 'STAGE',
  stage     TEXT NOT NULL,
  price     NUMERIC,
  note      TEXT,
  at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (setup_id, type, stage)
);
CREATE INDEX IF NOT EXISTS idx_sk_events_setup ON sk_setup_events (setup_id, at);

-- analysis snapshots: the multi-timeframe analysis, fib calculation, ABCD points and chart annotations
-- exactly as they were when each stage was first reached (old charts stay accurate)
CREATE TABLE IF NOT EXISTS sk_setup_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  setup_id    TEXT NOT NULL REFERENCES sk_setups(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL,
  score       INTEGER,
  analysis    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (setup_id, stage)
);
CREATE INDEX IF NOT EXISTS idx_sk_snapshots_setup ON sk_setup_snapshots (setup_id, created_at);

-- scan runs (resumable; progress survives restarts)
CREATE TABLE IF NOT EXISTS sk_scan_runs (
  id             TEXT PRIMARY KEY,
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','paused','stopped','completed')),
  universe       TEXT NOT NULL,
  top_n          INTEGER,
  ranking        TEXT,
  total          INTEGER NOT NULL DEFAULT 0,
  next_offset    INTEGER NOT NULL DEFAULT 0,
  analyzed       INTEGER NOT NULL DEFAULT 0,
  ok_count       INTEGER NOT NULL DEFAULT 0,
  failed_count   INTEGER NOT NULL DEFAULT 0,
  setups_found   INTEGER NOT NULL DEFAULT 0,
  current_symbol TEXT,
  paused_reason  TEXT,
  symbols        JSONB NOT NULL DEFAULT '[]'::jsonb,
  failed_symbols JSONB NOT NULL DEFAULT '[]'::jsonb,
  config         JSONB,
  owner_id       TEXT,                             -- user who started the scan (NULL = admin/cron)
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sk_runs_started ON sk_scan_runs (started_at DESC);

-- server-side access only (service role bypasses RLS); the browser never reads these tables directly
ALTER TABLE sk_setups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sk_setup_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sk_setup_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE sk_scan_runs       ENABLE ROW LEVEL SECURITY;
