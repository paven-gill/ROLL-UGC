-- Adds per-creator Wise payout details. The edit UI already sends these,
-- but the columns didn't exist, so saving the Payment section silently failed.
-- Safe to run multiple times.

ALTER TABLE creators ADD COLUMN IF NOT EXISTS wise_email TEXT;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS wise_tag   TEXT;
