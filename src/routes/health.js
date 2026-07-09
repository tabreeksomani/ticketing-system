const express = require('express');
const { ready, pool } = require('../db');

const router = express.Router();

let cachedHealth = null;
let lastCheckTime = 0;
const HEALTH_TTL_MS = 60000; // 60 seconds TTL

async function checkHealth() {
  const now = Date.now();

  // If there's a valid cache, return it
  if (cachedHealth && (now - lastCheckTime < HEALTH_TTL_MS)) {
    return cachedHealth;
  }

  try {
    // 1. Check if database schema setup has completed on startup
    await ready();

    // 2. Perform live connection check (ping DB)
    const startTime = Date.now();
    await pool.query('SELECT 1');
    const latencyMs = Date.now() - startTime;

    cachedHealth = {
      status: 'UP',
      components: {
        db: {
          status: 'UP',
          details: {
            database: 'PostgreSQL',
            latencyMs
          }
        }
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
  const isUp = health.status === 'UP';
  res.status(isUp ? 200 : 503).json(health);
};

// Mount route for both top-level and API-level paths
router.get('/health', healthHandler);
router.get('/api/health', healthHandler);

module.exports = router;
