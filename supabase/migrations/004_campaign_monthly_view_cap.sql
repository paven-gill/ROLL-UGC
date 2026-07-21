-- Per-campaign hard cap on PAYABLE views per cycle (the 30-day "month").
--
-- A creator's view bonus is min(capped_views_earned, monthly_view_cap) / 1000 * rate.
-- This is a hard payout ceiling across all a creator's videos combined: e.g. a
-- 1,000,000 cap at a $1 CPM tops the view bonus at $1,000 no matter how many views
-- are earned. NULL = uncapped (existing behaviour). The stored capped_views_earned
-- remains the TRUE combined total; only the payout is clamped.
--
-- Applied at: cycle close (sync-core), the Payouts-page in-progress estimate
-- (dashboard/cycles), and post-exclusion recompute (posts/exclude).

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS monthly_view_cap BIGINT;

COMMENT ON COLUMN campaigns.monthly_view_cap IS
  'Per-cycle cap on combined payable (capped) views across a creator''s videos. NULL = uncapped. view_bonus = min(capped_views_earned, monthly_view_cap)/1000*rate.';

-- Roll enforces a 1,000,000-view ceiling; other campaigns stay uncapped.
UPDATE campaigns SET monthly_view_cap = 1000000 WHERE name = 'Roll';
