-- 005: make the scan lock atomic.
-- The 1-minute cron and the 5-minute full-scan cron both fire at hh:mm:00 on every 5th minute.
-- Without this index both can read "no RUNNING scan" and start together. With it, the database
-- allows only ONE row with status = 'RUNNING'; the loser gets a unique violation (23505) which
-- the app treats as "lock busy" (1-min cron skips, full-scan waits / defers).

-- Close any leftover RUNNING rows first, otherwise the index cannot be created.
UPDATE scan_runs
   SET status = 'FAILED',
       error_message = COALESCE(error_message, 'Closed by migration 005'),
       completed_at = COALESCE(completed_at, NOW())
 WHERE status = 'RUNNING';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_scan_runs_single_running
  ON scan_runs ((1))
  WHERE status = 'RUNNING';
