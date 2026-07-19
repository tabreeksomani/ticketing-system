-- 004_parking_lot_code.sql
-- Adds an optional free-text `code` to each parking lot (e.g. a gate/access
-- code or short reference). Nullable, no default - lots without a code simply
-- carry NULL. Shown on the dashboard and edited from the Manage tab; the
-- marshal Update flow never touches it.

ALTER TABLE parking_lots ADD COLUMN IF NOT EXISTS code TEXT;
