-- Email verification for new sign-ups.
-- Existing users stay verified (DEFAULT true); new sign-ups are inserted with false
-- when SMTP is configured in Admin → Email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT true;
