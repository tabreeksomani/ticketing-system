-- 006_hub_closure.sql
-- Lets a hub volunteer mark their hub "closed" once every bus for the day
-- has departed - a guard against accidentally creating another O1 trip
-- after they're actually done, not a scheduling/capacity concept. Nullable
-- timestamp rather than a boolean so "when" is recorded for free, and
-- reopening is just clearing it back to NULL (admin-only, see src/routes).
ALTER TABLE hubs ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
