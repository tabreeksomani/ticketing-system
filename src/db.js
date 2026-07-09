const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://localhost:5432/ticketing_system',
  // Azure Database for PostgreSQL requires SSL; local Postgres doesn't offer it
  // by default, so this stays opt-in via env var rather than always-on.
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: process.env.DATABASE_POOL_MAX ? parseInt(process.env.DATABASE_POOL_MAX, 10) : 10,
  min: process.env.DATABASE_POOL_MIN ? parseInt(process.env.DATABASE_POOL_MIN, 10) : 4,
  idleTimeoutMillis: process.env.DATABASE_POOL_IDLE_TIMEOUT_MS ? parseInt(process.env.DATABASE_POOL_IDLE_TIMEOUT_MS, 10) : 30000,
  connectionTimeoutMillis: process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS ? parseInt(process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS, 10) : 10000,
  maxUses: process.env.DATABASE_POOL_MAX_USES ? parseInt(process.env.DATABASE_POOL_MAX_USES, 10) : undefined,
  statement_timeout: process.env.DATABASE_STATEMENT_TIMEOUT_MS ? parseInt(process.env.DATABASE_STATEMENT_TIMEOUT_MS, 10) : 60000,
  lock_timeout: process.env.DATABASE_LOCK_TIMEOUT_MS ? parseInt(process.env.DATABASE_LOCK_TIMEOUT_MS, 10) : 10000,
  idle_in_transaction_session_timeout: process.env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS ? parseInt(process.env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS, 10) : 30000,
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

    // "id" doubles as the login username. hub_id (single hub) is kept below
    // for backward compatibility but is deprecated - superseded by the
    // login_hubs mapping table further down, which lets one login cover
    // multiple hubs. New code reads login_hubs, not hub_id.
    await client.query(`CREATE TABLE IF NOT EXISTS logins (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      hub_id TEXT REFERENCES hubs(id) ON DELETE CASCADE,
      secret TEXT NOT NULL
    )`);
    // Optional display name for the login picker (e.g. "Darkhana Team") -
    // falls back to the login's own id when unset.
    await client.query('ALTER TABLE logins ADD COLUMN IF NOT EXISTS name TEXT');

    // Which hubs a login can sell for - a login maps to one or more hubs.
    // Own surrogate PK (not the (login_id, hub_id) pair) with a UNIQUE
    // constraint enforcing no duplicate pairs; login_id/hub_id are plain
    // FK columns, neither is the primary key.
    await client.query(`CREATE TABLE IF NOT EXISTS login_hubs (
      id SERIAL PRIMARY KEY,
      login_id TEXT NOT NULL REFERENCES logins(id) ON DELETE CASCADE,
      hub_id TEXT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
      UNIQUE (login_id, hub_id)
    )`);
    // One-time backfill so existing single-hub logins keep working with no
    // manual migration step - safe to re-run (ON CONFLICT DO NOTHING).
    await client.query(`
      INSERT INTO login_hubs (login_id, hub_id)
      SELECT id, hub_id FROM logins WHERE hub_id IS NOT NULL
      ON CONFLICT (login_id, hub_id) DO NOTHING
    `);

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

    // The active bus-tracking system (the old `buses` table above is a
    // separate, dormant, untouched system). A trip is a single journey, not
    // a physical vehicle - no ownership/hub column here on purpose (a
    // volunteer's own hub is forced into `origin` at creation time in the
    // route handler, not stored redundantly as a separate FK). No capacity
    // either - onboard count is just however many tickets reference this
    // trip, no fixed limit to check against.
    await client.query(`CREATE TABLE IF NOT EXISTS bus_trips (
      id SERIAL PRIMARY KEY,
      license_plate TEXT NOT NULL,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      boarding_started_at TIMESTAMPTZ,
      departed_at TIMESTAMPTZ,
      arrived_at TIMESTAMPTZ
    )`);

    // One column-pair per leg of the full round trip (hub->central,
    // central->venue, venue->central, central->hub) - named trip1-4 rather
    // than leg1-4 to avoid colliding with the existing leg1_bus_id/
    // leg1_boarded_at/leg2_bus_id/leg2_boarded_at columns above, which
    // belong to the separate dormant `buses` system. Only trip1 (hub->
    // central) is wired up to anything yet; trip2-4 sit unused until those
    // legs get built - added now so no further migration is needed then.
    await client.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS trip1_id INTEGER REFERENCES bus_trips(id)');
    await client.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS trip1_boarded_at TIMESTAMPTZ');
    await client.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS trip2_id INTEGER REFERENCES bus_trips(id)');
    await client.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS trip2_boarded_at TIMESTAMPTZ');
    await client.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS trip3_id INTEGER REFERENCES bus_trips(id)');
    await client.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS trip3_boarded_at TIMESTAMPTZ');
    await client.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS trip4_id INTEGER REFERENCES bus_trips(id)');
    await client.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS trip4_boarded_at TIMESTAMPTZ');

    // Full 4-leg round trip (O1 hub->central, O2 central->venue, R1
    // venue->central, R2 central->hub) - trip1-4 above map directly to
    // O1-R2 in that order. `leg` lets route handlers dispatch generically
    // instead of re-deriving it from origin/destination on every query.
    await client.query('ALTER TABLE bus_trips ADD COLUMN IF NOT EXISTS leg TEXT');
    await client.query("UPDATE bus_trips SET leg = 'O1' WHERE leg IS NULL");
    await client.query('ALTER TABLE bus_trips ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES logins(id) ON DELETE SET NULL');
    await client.query('ALTER TABLE bus_trips ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()');

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
