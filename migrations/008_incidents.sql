-- 008_incidents.sql
-- Admin logs a quick incident against a bus plate when something goes
-- wrong (breakdown, safety issue, etc), tracked until resolved.
-- Deliberately minimal - just plate + description + status, no
-- severity/category, matching what's actually needed right now.
CREATE TABLE IF NOT EXISTS incidents (
  id SERIAL PRIMARY KEY,
  license_plate TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT REFERENCES logins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
