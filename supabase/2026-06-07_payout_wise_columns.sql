-- Adds the bonus + Wise columns the Pay flow writes. Without these,
-- clicking Pay (especially with a bonus) errors because the columns don't exist.
-- Safe to run multiple times (IF NOT EXISTS).

ALTER TABLE payout_cycles ADD COLUMN IF NOT EXISTS bonus_amount        DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE payout_cycles ADD COLUMN IF NOT EXISTS bonus_note          TEXT;
ALTER TABLE payout_cycles ADD COLUMN IF NOT EXISTS paid_at             TIMESTAMP WITH TIME ZONE;
ALTER TABLE payout_cycles ADD COLUMN IF NOT EXISTS wise_transfer_id    TEXT;
ALTER TABLE payout_cycles ADD COLUMN IF NOT EXISTS wise_transfer_status TEXT;
