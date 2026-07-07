const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://localhost:5432/ticketing_system',
  // Azure Database for PostgreSQL requires SSL; local Postgres doesn't offer it
  // by default, so this stays opt-in via env var rather than always-on.
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

let initPromise = null;

// Hubs, timeslots, and logins are all static config decided once before an
// event - there's deliberately no CRUD API for any of them. They're set up
// by hand (psql, manual INSERTs) before first use. Only tickets (and, later,
// buses once Check-in Scan is built) are genuinely live/concurrent data.
async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS hubs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      travel_minutes INTEGER NOT NULL DEFAULT 30
    )`);

    // Kept as a real table (not a JSONB blob on hubs) specifically so ticket
    // sales/reassignments can take a row-level lock on the one timeslot being
    // sold against (SELECT ... FOR UPDATE in tickets.js) without serializing
    // unrelated timeslots at the same hub.
    await client.query(`CREATE TABLE IF NOT EXISTS timeslots (
      id SERIAL PRIMARY KEY,
      hub_id TEXT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
      departure_time TEXT NOT NULL,
      capacity INTEGER NOT NULL
    )`);

    // Two roles only: 'admin' (hub_id NULL) and 'volunteer' (hub_id set).
    // "id" doubles as the login username - for volunteers it's the hub's own
    // id, so there's exactly one login row per hub with no separate
    // identifier to keep in sync.
    await client.query(`CREATE TABLE IF NOT EXISTS logins (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      hub_id TEXT REFERENCES hubs(id) ON DELETE CASCADE,
      secret TEXT NOT NULL
    )`);

    // Dormant until Check-in Scan is built - nothing currently calls
    // board/depart/arrive, so this table exists but stays empty. Left with
    // its full original shape (leg/arrived_at included) since src/routes/buses.js
    // itself is intentionally untouched this pass and still references them.
    await client.query(`CREATE TABLE IF NOT EXISTS buses (
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
    )`);

    // No pre-load: a code becomes a real ticket row the moment it's first sold.
    // Ticket "state" is always derived from these columns + the buses they point
    // to, never stored redundantly, so it can't drift out of sync. leg2_*/
    // returned_at were central-hub-only; kept here (unused for now) since
    // buses.js still references leg2_bus_id/leg2_boarded_at and is left
    // untouched this pass.
    await client.query(`CREATE TABLE IF NOT EXISTS tickets (
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
      is_egressed BOOLEAN NOT NULL DEFAULT FALSE
    )`);
    // Scanning constraint: once a ticket has been scanned onto any bus
    // (is_ingressed), it can't be scanned again until it's been egressed.
    // Egress isn't wired up to anything yet (no trigger decided) - the column
    // exists so the constraint can be relaxed later without another migration.
    await client.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS is_ingressed BOOLEAN NOT NULL DEFAULT FALSE');
    await client.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS is_egressed BOOLEAN NOT NULL DEFAULT FALSE');

    await client.query(`CREATE TABLE IF NOT EXISTS login_attempts (
      bucket TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      locked_until TIMESTAMPTZ
    )`);
  } finally {
    client.release();
  }
}

// Call before handling any request; safe to call many times (only runs once).
function ready() {
  if (!initPromise) {
    initPromise = initSchema();
  }
  return initPromise;
}

/**
 * Lightweight brute-force protection for login endpoints. Tracks failed
 * attempts per (client IP + login id) in Postgres and locks out further
 * tries for a cooldown period after too many failures.
 */
async function rateLimitCheck(bucket) {
  const { rows } = await pool.query('SELECT * FROM login_attempts WHERE bucket = $1', [bucket]);
  const row = rows[0];
  if (row && row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    const waitMin = Math.max(1, Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 60000));
    const err = new Error(`Too many failed attempts. Try again in about ${waitMin} minute(s).`);
    err.status = 429;
    throw err;
  }
}

async function rateLimitRecordFailure(bucket) {
  const maxAttempts = 8;
  const windowMinutes = 15;
  const lockoutMinutes = 15;

  const { rows } = await pool.query('SELECT * FROM login_attempts WHERE bucket = $1', [bucket]);
  const row = rows[0];

  if (!row || new Date(row.first_attempt_at).getTime() < Date.now() - windowMinutes * 60000) {
    // No record yet, or the previous tracking window has expired - start fresh.
    await pool.query(
      `INSERT INTO login_attempts (bucket, attempts, first_attempt_at, locked_until) VALUES ($1, 1, now(), NULL)
       ON CONFLICT (bucket) DO UPDATE SET attempts = 1, first_attempt_at = now(), locked_until = NULL`,
      [bucket]
    );
    return;
  }

  const attempts = row.attempts + 1;
  const lockedUntil = attempts >= maxAttempts ? new Date(Date.now() + lockoutMinutes * 60000) : null;
  await pool.query('UPDATE login_attempts SET attempts = $1, locked_until = $2 WHERE bucket = $3', [attempts, lockedUntil, bucket]);
}

async function rateLimitClear(bucket) {
  await pool.query('DELETE FROM login_attempts WHERE bucket = $1', [bucket]);
}

module.exports = {
  pool,
  ready,
  rateLimitCheck,
  rateLimitRecordFailure,
  rateLimitClear,
};
