-- 009_hub_travel_split.sql
-- Splits hubs.travel_minutes (a single hub<->Premium Lounge estimate) into
-- two directional estimates: time_to_pl (hub -> Premium Lounge, used by O1
-- trips routed through Central) and time_to_vcc (hub -> VCC direct, used by
-- O1 trips that bypass Central entirely). The two paths aren't the same
-- distance, so one shared number was never quite right for both.
-- Backfilled from the old column so existing hubs don't go from "an
-- estimate" to "no estimate" - time_to_vcc defaults to the same value as
-- time_to_pl until someone corrects it by hand (hubs have no CRUD API, set
-- up via psql per src/routes/hubs.js).
--
-- travel_minutes itself is deliberately left in place, just unused by the
-- application from here on - this project's migration policy (see
-- scripts/lint-migrations.js) is to deprecate a column in code first and
-- drop it later during scheduled maintenance, not in the same migration
-- that stops reading it.
ALTER TABLE hubs ADD COLUMN IF NOT EXISTS time_to_pl INTEGER;
ALTER TABLE hubs ADD COLUMN IF NOT EXISTS time_to_vcc INTEGER;

UPDATE hubs SET time_to_pl = travel_minutes WHERE time_to_pl IS NULL;
UPDATE hubs SET time_to_vcc = travel_minutes WHERE time_to_vcc IS NULL;

ALTER TABLE hubs ALTER COLUMN time_to_pl SET DEFAULT 30;
ALTER TABLE hubs ALTER COLUMN time_to_vcc SET DEFAULT 30;
ALTER TABLE hubs ALTER COLUMN time_to_pl SET NOT NULL;
ALTER TABLE hubs ALTER COLUMN time_to_vcc SET NOT NULL;
