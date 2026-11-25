-- KYC / identity verification
-- Run in Supabase SQL editor (safe to re-run).

ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'none'
  CHECK (kyc_status IN ('none', 'draft', 'pending', 'approved', 'rejected'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_reviewed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_reviewed_by UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_review_note TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_data JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_users_kyc_status ON users(kyc_status);
CREATE INDEX IF NOT EXISTS idx_users_country_code ON users(country_code);

COMMENT ON COLUMN users.kyc_data IS 'docType, firstName, lastName, docNumber, dob, nationality, docFront, docBack, selfie, frameHints, ...';
COMMENT ON COLUMN users.kyc_status IS 'none | draft | pending | approved | rejected';
