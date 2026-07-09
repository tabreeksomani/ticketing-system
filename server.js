require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { execSync } = require('child_process');
const { pool } = require('./src/db');
const { HttpError } = require('./src/errors');

// Cache git info once on startup to avoid spawning sub-processes on HTTP requests
let gitInfo = { sha: 'unknown', date: 'unknown' };
try {
  const sha = execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const date = execSync('TZ=America/Los_Angeles git log -1 --format=%cd --date=format:"%Y-%m-%d %H:%M:%S"', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  gitInfo = { sha, date };
} catch (err) {
  console.warn('Failed to retrieve Git info on startup:', err.message);
}

const app = express();
app.use(express.json());

// No cross-origin access is ever needed: every page in this app fetches "api/..."
// as a relative path, meaning the frontend and API are always served from the
// same origin. Not sending an Access-Control-Allow-Origin header at all means
// browsers default to disallowing cross-origin access - intentional, since
// there's no legitimate reason any other site should be able to call this API.
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/api/git-info', (req, res) => {
  res.json(gitInfo);
});

// Register health check BEFORE schema-readiness middleware so it can report DB downtime gracefully
app.use(require('./src/routes/health'));



app.use('/api/auth', require('./src/routes/auth'));
app.use('/api', require('./src/routes/hubs'));
app.use('/api', require('./src/routes/buses'));
app.use('/api', require('./src/routes/tickets'));
app.use('/api', require('./src/routes/dashboard'));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Static frontend: three plain HTML portals, no build step, no frontend framework.
app.use(express.static(__dirname, { index: 'index.html' }));

// Defense in depth: never let a stack trace leak into a response body - the
// only thing that should ever produce an error response is this handler, and
// only with detail when APP_DEBUG=1 is explicitly set.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('Unhandled exception:', err);
  res.status(500).json({
    error: 'Server error',
    detail: process.env.APP_DEBUG === '1' ? err.message : null,
  });
});

async function verifyDatabaseSchema() {
  const behavior = process.env.DATABASE_MIGRATION_BEHAVIOR || 'WARN';
  if (behavior === 'IGNORE') return;

  try {
    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) return;

    const localFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

    // Check if the schema_migrations table exists
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

    if (pending.length > 0) {
      if (behavior === 'KILL') {
        console.error('\n======================================================');
        console.error('❌ FATAL: Pending database migrations detected on startup!');
        console.error('Server is configured to KILL on pending migrations.');
        console.error(`Please run "npm run db:migrate" to apply ${pending.length} pending migration(s):`);
        pending.forEach(f => console.error(`   - ${f}`));
        console.error('======================================================\n');
        process.exit(1);
      } else if (behavior === 'WARN') {
        console.warn('\n======================================================');
        console.warn('⚠️  WARNING: There are pending database migrations!');
        console.warn(`Please run "npm run db:migrate" to apply ${pending.length} pending migration(s):`);
        pending.forEach(f => console.warn(`   - ${f}`));
        console.warn('======================================================\n');
      }
    }
  } catch (err) {
    let errMsg = err.message;
    if (!errMsg && err.errors && err.errors.length > 0) {
      errMsg = err.errors.map(e => e.message).join('; ');
    }
    console.error('Failed to verify database migration status on boot:', errMsg || err.code || err);
    if (behavior === 'KILL') {
      process.exit(1);
    }
  }
}

const port = parseInt(process.env.PORT, 10) || 8000;

async function startServer() {
  await verifyDatabaseSchema();
  app.listen(port, () => {
    console.log(`Ticketing system listening on http://localhost:${port}`);
  });
}

startServer().catch(err => {
  console.error('Fatal server startup failure:', err.message);
  process.exit(1);
});
