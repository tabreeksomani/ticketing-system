// scripts/migrate.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  const connectionString = process.env.DATABASE_URL || 'postgres://localhost:5432/ticketing_system';
  const ssl = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined;

  const pool = new Pool({
    connectionString,
    ssl,
    max: 1, // Single connection is plenty for running migrations
  });

  const migrationsDir = path.join(__dirname, '../migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.error(`Migrations directory not found at ${migrationsDir}`);
    process.exit(1);
  }

  let client;

  try {
    client = await pool.connect();
    // 1. Ensure the schema_migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // 2. Fetch applied migrations
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const appliedList = rows.map(r => r.name);

    // 3. Find local migration files
    const localFiles = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort(); // Alphabetic sorting guarantees sequential order (e.g. 001, 002)

    // 4. Determine pending migrations
    const pendingList = localFiles.filter(f => !appliedList.includes(f));

    if (pendingList.length === 0) {
      console.log('No pending database migrations. Database is up to date.');
      return;
    }

    console.log(`Found ${pendingList.length} pending migration(s) to apply.`);

    // 4b. Perform safety validation checks unless overridden via environment or command-line flag
    const force = process.argv.includes('--force') || process.argv.includes('-f') || process.env.ALLOW_DESTRUCTIVE_MIGRATIONS === 'true';
    if (force) {
      console.log('⚠️  [WARNING] --force / -f override flag detected. Bypassing safety check for destructive operations.');
    } else {
      const { lintFile } = require('./lint-migrations');
      for (const file of pendingList) {
        const filePath = path.join(migrationsDir, file);
        if (!lintFile(filePath)) {
          throw new Error(`Aborting migration execution due to safety validation failure in ${file}. Use --force to override.`);
        }
      }
    }

    // 5. Execute pending migrations sequentially in a transaction
    for (const file of pendingList) {
      console.log(`Applying migration: ${file} ...`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Successfully applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`❌ Migration failed at file: ${file}`);
        throw err;
      }
    }

    console.log('All migrations applied successfully.');
  } catch (err) {
    console.error('Migration runner failed:', err.message);
    process.exit(1);
  } finally {
    if (client) {
      client.release();
    }
    await pool.end();
  }
}

migrate();
