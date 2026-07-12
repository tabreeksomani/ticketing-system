-- 001_init.sql
-- Initial database schema for the Transportation Ticketing System.

-- 1. Hubs
CREATE TABLE IF NOT EXISTS hubs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  travel_minutes INTEGER NOT NULL DEFAULT 30
);

-- 2. Timeslots
CREATE TABLE IF NOT EXISTS timeslots (
  id SERIAL PRIMARY KEY,
  hub_id TEXT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
  departure_time TEXT NOT NULL,
  capacity INTEGER NOT NULL
);

-- 3. Logins
CREATE TABLE IF NOT EXISTS logins (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  hub_id TEXT REFERENCES hubs(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  name TEXT
);

-- 4. Login Hubs mapping
CREATE TABLE IF NOT EXISTS login_hubs (
  id SERIAL PRIMARY KEY,
  login_id TEXT NOT NULL REFERENCES logins(id) ON DELETE CASCADE,
  hub_id TEXT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
  UNIQUE (login_id, hub_id)
);

-- One-time backfill so existing single-hub logins keep working
INSERT INTO login_hubs (login_id, hub_id)
SELECT id, hub_id FROM logins WHERE hub_id IS NOT NULL
ON CONFLICT (login_id, hub_id) DO NOTHING;

-- 5. Buses (Legacy / Dormant)
CREATE TABLE IF NOT EXISTS buses (
  id SERIAL PRIMARY KEY,
  leg TEXT NOT NULL,
  hub_id TEXT REFERENCES hubs(id) ON DELETE CASCADE,
  timeslot_id INTEGER REFERENCES timeslots(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  boarding_started_at TIMESTAMPTZ,
  departed_at TIMESTAMPTZ,
  arrived_at TIMESTAMPTZ
);

-- 6. Bus Trips (Active Tracking)
CREATE TABLE IF NOT EXISTS bus_trips (
  id SERIAL PRIMARY KEY,
  license_plate TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  boarding_started_at TIMESTAMPTZ,
  departed_at TIMESTAMPTZ,
  arrived_at TIMESTAMPTZ,
  leg TEXT NOT NULL DEFAULT 'O1',
  created_by TEXT REFERENCES logins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7. Tickets
CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  timeslot_id INTEGER REFERENCES timeslots(id),
  is_standby BOOLEAN NOT NULL DEFAULT FALSE,
  sold_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  leg1_bus_id INTEGER REFERENCES buses(id),
  leg1_boarded_at TIMESTAMPTZ,
  leg2_bus_id INTEGER REFERENCES buses(id),
  leg2_boarded_at TIMESTAMPTZ,
  returned_at TIMESTAMPTZ,
  is_ingressed BOOLEAN NOT NULL DEFAULT FALSE,
  is_egressed BOOLEAN NOT NULL DEFAULT FALSE,
  trip1_id INTEGER REFERENCES bus_trips(id),
  trip1_boarded_at TIMESTAMPTZ,
  trip2_id INTEGER REFERENCES bus_trips(id),
  trip2_boarded_at TIMESTAMPTZ,
  trip3_id INTEGER REFERENCES bus_trips(id),
  trip3_boarded_at TIMESTAMPTZ,
  trip4_id INTEGER REFERENCES bus_trips(id),
  trip4_boarded_at TIMESTAMPTZ
);

-- 8. Login Attempts
CREATE TABLE IF NOT EXISTS login_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ
);
