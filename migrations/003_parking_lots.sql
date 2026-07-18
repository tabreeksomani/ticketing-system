-- 002_parking_lots.sql
-- Parking availability feature, ported from the standalone parking-tracker app.
--
-- Field marshals mark lots Available/Full with an optional count of open
-- stalls; a live dashboard shows green/red availability. Access is gated by
-- three new JWT roles (a progressive hierarchy) carried on the existing
-- `logins` table:
--   parking_dashboard - read-only: view the availability dashboard
--   parking_marshal   - view + update a lot's status/open-stall count
--   parking_admin     - update + manage (create/edit/delete) lots
-- Reads (the dashboard + lot pickers) are open to any authenticated user.

CREATE TABLE IF NOT EXISTS parking_lots (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  total_stalls INTEGER NOT NULL DEFAULT 0,
  available_stalls INTEGER,                          -- NULL until a marshal reports a count
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'full')),
  distance_value REAL,                               -- numeric distance from the venue, for sorting
  distance_unit TEXT NOT NULL DEFAULT 'min walk' CHECK (distance_unit IN ('min walk', 'm')),
  rate TEXT,                                         -- free text, e.g. '$20 flat / event'
  updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
