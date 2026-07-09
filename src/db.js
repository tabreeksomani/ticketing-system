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
  rateLimitCheck,
  rateLimitRecordFailure,
  rateLimitClear,
};
