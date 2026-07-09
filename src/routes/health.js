const fs = require('fs');
const path = require('path');
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

let cachedHealth = null;
let lastCheckTime = 0;
const HEALTH_TTL_MS = 60000; // 60 seconds TTL

async function getMigrationsStatus() {
  const behavior = process.env.DATABASE_MIGRATION_BEHAVIOR || 'WARN';
  if (behavior === 'IGNORE') {
    return { status: 'UP', details: { behavior, pendingCount: 0, pending: [] } };
  }

  const migrationsDir = path.join(__dirname, '../../migrations');
  if (!fs.existsSync(migrationsDir)) {
    return { status: 'UP', details: { behavior, pendingCount: 0, pending: [] } };
  }

  const localFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  // Check if schema_migrations table exists
  const tableCheck = await pool.query(`
    SELECT EXISTS (
      SELECT FROM pg_tables 
      WHERE schemaname = 'public' AND tablename = 'schema_migrations'
    );
  `);

  let pending = [];
  if (!tableCheck.rows[0].exists) {
    pending = localFiles;
  } else {
    const { rows } = await pool.query('SELECT name FROM schema_migrations');
    const runMigrations = rows.map(r => r.name);
    pending = localFiles.filter(f => !runMigrations.includes(f));
  }

  let status = 'UP';
  if (pending.length > 0) {
    status = (behavior === 'KILL') ? 'DOWN' : 'WARN';
  }

  return {
    status,
    details: {
      behavior,
      pendingCount: pending.length,
      pending
    }
  };
}

async function checkHealth() {
  const now = Date.now();

  if (cachedHealth && (now - lastCheckTime < HEALTH_TTL_MS)) {
    return cachedHealth;
  }

  try {
    // 1. Perform live connection check (ping DB)
    const startTime = Date.now();
    await pool.query('SELECT 1');
    const latencyMs = Date.now() - startTime;

    // 2. Perform migration check
    const migrationsStatus = await getMigrationsStatus();

    // Overall status is DOWN if database is down or migrations status is DOWN
    // Overall status is WARN if migrations status is WARN
    let overallStatus = 'UP';
    if (migrationsStatus.status === 'DOWN') {
      overallStatus = 'DOWN';
    } else if (migrationsStatus.status === 'WARN') {
      overallStatus = 'WARN';
    }

    cachedHealth = {
      status: overallStatus,
      components: {
        db: {
          status: 'UP',
          details: {
            database: 'PostgreSQL',
            latencyMs
          }
        },
        migrations: migrationsStatus
      }
    };
    lastCheckTime = now;
  } catch (err) {
    cachedHealth = {
      status: 'DOWN',
      components: {
        db: {
          status: 'DOWN',
          details: {
            error: err.message
          }
        },
        migrations: {
          status: 'DOWN',
          details: {
            error: 'Database connection failed'
          }
        }
      }
    };
    // Cache failures for only 5 seconds to avoid slamming a struggling DB while allowing fast recovery checks
    lastCheckTime = now - HEALTH_TTL_MS + 5000;
  }

  return cachedHealth;
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
