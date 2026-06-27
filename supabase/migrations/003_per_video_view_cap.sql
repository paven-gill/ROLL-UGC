-- Per-video view cap for payouts (2026-06-27)
--
-- Payouts now cap each video's contribution at 1,000,000 views. The dashboard
-- still shows TRUE (uncapped) views; only the payable basis is capped. We track
-- a parallel "capped" cumulative series alongside the existing true cumulative.
--
-- Backfill = current values: no video has ever exceeded 1M views, so capped ==
-- true at migration time. This makes the first post-deploy sync a no-op for
-- payouts (no blip) and only diverges once a future video crosses 1M.
--
-- Run in the Supabase SQL editor BEFORE deploying the matching code.

-- 1. Daily snapshots: capped cumulative views per creator+platform.
ALTER TABLE view_snapshots
  ADD COLUMN IF NOT EXISTS capped_cumulative_views BIGINT NOT NULL DEFAULT 0;
UPDATE view_snapshots
  SET capped_cumulative_views = cumulative_views
  WHERE capped_cumulative_views = 0 AND cumulative_views <> 0;

-- 2. Active cycle: capped baseline at cycle start (mirrors baseline_views).
ALTER TABLE creator_cycles
  ADD COLUMN IF NOT EXISTS baseline_capped_views BIGINT NOT NULL DEFAULT 0;
UPDATE creator_cycles
  SET baseline_capped_views = baseline_views
  WHERE baseline_capped_views = 0 AND baseline_views <> 0;

-- 3. Completed cycles: keep start_views / end_views / views_earned as the TRUE
-- (displayed) figures and add capped_views_earned — the payable delta the
-- view_bonus / payout_amount are computed from. Backfill capped = true (equal
-- historically, since nothing has crossed the cap).
ALTER TABLE payout_cycles
  ADD COLUMN IF NOT EXISTS capped_views_earned BIGINT NOT NULL DEFAULT 0;
UPDATE payout_cycles
  SET capped_views_earned = views_earned
  WHERE capped_views_earned = 0 AND views_earned <> 0;
