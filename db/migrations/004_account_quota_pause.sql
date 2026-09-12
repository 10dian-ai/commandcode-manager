ALTER TABLE managed_accounts ADD COLUMN IF NOT EXISTS quota_paused BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE managed_accounts ADD COLUMN IF NOT EXISTS quota_resume_at TIMESTAMPTZ;
ALTER TABLE managed_accounts ADD COLUMN IF NOT EXISTS quota_pause_reasons TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS managed_accounts_quota_resume ON managed_accounts(quota_resume_at, id) WHERE quota_paused;
