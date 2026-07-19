-- 003_unique_active_trip_per_bus.sql
-- Prevents two people from concurrently creating/running the same physical
-- bus as two different active trips - e.g. a double-tap on "New Trip", two
-- volunteers both starting one for the same bus, or (as caught by this
-- constraint during testing) the same plate accidentally used for two
-- legs at once. Just license_plate, not scoped to origin/leg/destination:
-- a single physical bus can't be boarding two trips at the same time,
-- anywhere in the system, full stop.
--
-- A plain UNIQUE constraint won't work on its own, though - buses do laps,
-- so the same plate legitimately gets reused for a new trip later in the
-- day. A PARTIAL index scoped to only the "still active" statuses solves
-- this - once a trip departs, that plate is free again for the bus's next
-- lap (whatever leg/destination that next trip happens to be).
CREATE UNIQUE INDEX IF NOT EXISTS bus_trips_active_plate
  ON bus_trips (license_plate)
  WHERE status IN ('scheduled', 'boarding');
