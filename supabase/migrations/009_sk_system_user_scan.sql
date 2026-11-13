-- 013: SK SYSTEM PRO — scans started by normal users. Safe to run more than once.
-- (Skip if you ran the updated 012, which already has the column.)
ALTER TABLE sk_scan_runs ADD COLUMN IF NOT EXISTS owner_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sk_runs_owner ON sk_scan_runs (owner_id, started_at DESC);
