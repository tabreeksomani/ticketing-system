const fs = require('fs');
const path = require('path');
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Read local migration files once at startup to avoid blocking sync I/O in HTTP requests
const migrationsDir = path.join(__dirname, '../../migrations');
const localMigrations = fs.existsSync(migrationsDir)
  ? fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
  : [];

let cachedHealth = null;
let cacheExpiresAt = 0;
let activeCheckPromise = null;

async function performHealthCheck() {
  const behavior = process.env.DATABASE_MIGRATION_BEHAVIOR || 'WARN';
  const dbStatus = { status: 'UNKNOWN' };
  let migrationsStatus = { status: 'UNKNOWN' };
  let overallStatus = 'UP';

  // 1. Perform database connection check (ping DB)
  try {
    const startTime = Date.now();
    await pool.query('SELECT 1');
    dbStatus.status = 'UP';
    dbStatus.details = {
      database: 'PostgreSQL',
      latencyMs: Date.now() - startTime
    };
  } catch (err) {
    dbStatus.status = 'DOWN';
    let errMsg = err.message;
    if (!errMsg && err.errors && err.errors.length > 0) {
      errMsg = err.errors.map(e => e.message).join('; ');
    }
    dbStatus.details = { error: errMsg || 'Database connection offline' };
    overallStatus = 'DOWN';
  }

  // 2. Perform migrations check (only if database connection is UP)
  if (dbStatus.status === 'UP') {
    if (behavior === 'IGNORE') {
      migrationsStatus = {
        status: 'UP',
        details: { behavior, pendingCount: 0, pending: [] }
      };
    } else {
      try {
        let runMigrations = [];
        try {
          const { rows } = await pool.query('SELECT name FROM schema_migrations');
          runMigrations = rows.map(r => r.name);
        } catch (err) {
          // If table doesn't exist (Postgres error code 42P01), treat runMigrations as empty
          if (err.code !== '42P01') {
            throw err;
          }
        }

        const pending = localMigrations.filter(f => !runMigrations.includes(f));
        const status = pending.length > 0 ? (behavior === 'KILL' ? 'DOWN' : 'WARN') : 'UP';

        migrationsStatus = {
          status,
          details: {
            behavior,
            pendingCount: pending.length,
            pending
          }
        };

        if (status === 'DOWN') {
          overallStatus = 'DOWN';
        } else if (status === 'WARN' && overallStatus !== 'DOWN') {
          overallStatus = 'WARN';
        }
      } catch (err) {
        migrationsStatus = {
          status: 'DOWN',
          details: { error: `Migration check failed: ${err.message}` }
        };
        overallStatus = 'DOWN';
      }
    }
  } else {
    // If DB is down, migrations check is automatically down
    migrationsStatus = {
      status: 'DOWN',
      details: { error: 'Database connection offline' }
    };
  }

  const result = {
    status: overallStatus,
    components: {
      db: dbStatus,
      migrations: migrationsStatus
    }
  };

  // Cache successful runs (or warnings) for 60 seconds; cache failures for 5 seconds
  const ttlMs = overallStatus === 'DOWN' ? 5000 : 60000;
  cacheExpiresAt = Date.now() + ttlMs;
  cachedHealth = result;

  return result;
}

async function checkHealth() {
  const now = Date.now();

  // If there's a valid cache, return it
  if (cachedHealth && now < cacheExpiresAt) {
    return cachedHealth;
  }

  // Deduplicate concurrent health check requests (Cache Stampede protection)
  if (!activeCheckPromise) {
    activeCheckPromise = performHealthCheck().finally(() => {
      activeCheckPromise = null;
    });
  }

  return activeCheckPromise;
}

const healthHandler = async (req, res) => {
  const health = await checkHealth();
  const isDown = health.status === 'DOWN';
  res.status(isDown ? 503 : 200).json(health);
};

// Mount route for both top-level and API-level paths
router.get('/health', healthHandler);
router.get('/api/health', healthHandler);

module.exports = router;
