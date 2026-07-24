-- 010_flags.sql
-- A generic key/value store for arbitrary runtime event state - things that
-- flip *during* the event, as opposed to the seed-time config that lives on
-- hubs/timeslots (set by hand via scripts/seed.js). Values are plain TEXT so
-- callers can store whatever they need without a schema change per flag.
--
-- First consumer: 'phase', which starts at 'ingress' and is flipped to
-- 'egress' from the admin Live tab so the Ops dashboard can show which phase
-- the operation is in.
CREATE TABLE IF NOT EXISTS flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the phase flag so every reader has a value from day one (readers still
-- default to 'ingress' if the row is somehow missing). ON CONFLICT keeps this
-- migration safe to re-run and non-destructive if a phase row already exists.
INSERT INTO flags (key, value) VALUES ('phase', 'ingress')
ON CONFLICT (key) DO NOTHING;
