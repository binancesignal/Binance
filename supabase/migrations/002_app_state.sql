-- Simple key/value app state — used to persist the rotating scan cursor
-- (which chunk of symbols to scan next) across serverless invocations.

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE app_state ENABLE ROW LEVEL SECURITY;

-- Writes only via service role (bypasses RLS); no public policy needed
-- since the dashboard never reads this table directly.
