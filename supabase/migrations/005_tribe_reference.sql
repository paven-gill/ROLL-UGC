-- 005_tribe_reference.sql
-- Payments moved out of this dashboard: creators are now paid a bonus in Trybe
-- (jointrybe.com), and the dashboard only RECORDS the payout. This column stores
-- an optional reference tying a payout cycle back to the Trybe bonus that paid it,
-- so a year from now you can still trace an amount here to the money that moved.
--
-- Optional: the Pay flow writes it defensively and still works without this column
-- (see api/payout-cycles/pay/route.ts), it just won't store the reference.
-- Safe to run multiple times (IF NOT EXISTS).

ALTER TABLE payout_cycles ADD COLUMN IF NOT EXISTS tribe_reference TEXT;

COMMENT ON COLUMN payout_cycles.tribe_reference IS
  'Optional reference for the Trybe bonus that paid this cycle. Payments are sent in Trybe, not this app.';

-- The Wise columns below are now unused — the Wise integration has been removed.
-- They are LEFT IN PLACE deliberately (no data loss, nothing reads them). To drop
-- them once you are sure you want them gone:
--   ALTER TABLE payout_cycles DROP COLUMN IF EXISTS wise_transfer_id;
--   ALTER TABLE payout_cycles DROP COLUMN IF EXISTS wise_transfer_status;
--   ALTER TABLE campaigns     DROP COLUMN IF EXISTS wise_api_token;
--   ALTER TABLE campaigns     DROP COLUMN IF EXISTS wise_profile_id;
--   ALTER TABLE creators      DROP COLUMN IF EXISTS wise_email;
--   ALTER TABLE creators      DROP COLUMN IF EXISTS wise_tag;
--   ALTER TABLE creators      DROP COLUMN IF EXISTS affiliate_percentage;
