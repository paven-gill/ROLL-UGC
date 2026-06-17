-- 002_wise_per_campaign.sql
-- Each brand/campaign has its OWN Wise account, so the Wise API token (and the
-- chosen Wise profile) move from the global app_settings onto each campaign.
-- Run in the Supabase SQL editor AFTER 001_auth_campaigns.sql.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS wise_api_token  TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS wise_profile_id TEXT;

-- Backfill: move the existing single (global) token onto the Roll campaign so
-- Roll's finance keeps working unchanged.
UPDATE campaigns
  SET wise_api_token = (SELECT value FROM app_settings WHERE key = 'wise_api_token')
  WHERE slug = 'roll'
    AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'wise_api_token');

-- Optional cleanup once you've confirmed Roll's finance still loads:
--   DELETE FROM app_settings WHERE key = 'wise_api_token';
