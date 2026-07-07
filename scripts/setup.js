// One-command local run: starts Postgres (via docker-compose.yml), creates
// .env if missing, seeds hubs/timeslots/logins, then starts the server.
//   npm run setup                       - seeds scripts/example.json
//   npm run setup -- path/to/data.json  - seeds a specific data file instead
//
// Safe to re-run: `docker compose up -d` no-ops if the container's already
// running, .env is never overwritten if it already exists, and seed.js
// upserts (updates existing rows instead of duplicating them).

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
const envExamplePath = path.join(root, '.env.example');

function startPostgres() {
  try {
    execFileSync('docker', ['compose', 'up', '-d'], { cwd: root, stdio: 'inherit' });
  } catch (e) {
    console.warn('Could not start Postgres via `docker compose up -d` - is Docker running?');
    console.warn('Continuing anyway in case Postgres is already reachable some other way.');
  }
}

async function waitForPostgres(connectionString, maxAttempts = 30) {
  const { Client } = require('pg');
  for (let i = 1; i <= maxAttempts; i++) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      await client.end();
      console.log('Postgres is ready.');
      return;
    } catch (e) {
      await client.end().catch(() => {});
      if (i === maxAttempts) {
        throw new Error(`Postgres never became reachable at ${connectionString}\n${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function main() {
  if (fs.existsSync(envPath)) {
    console.log('.env already exists - leaving it as-is.');
  } else {
    fs.copyFileSync(envExamplePath, envPath);
    console.log('Created .env from .env.example.');
  }

  startPostgres();

  require('dotenv').config({ path: envPath });
  const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ticketing_system';
  console.log('Waiting for Postgres...');
  await waitForPostgres(connectionString);

  const dataFile = process.argv[2] || path.join('scripts', 'example.json');
  console.log(`Seeding from ${dataFile} ...`);
  execFileSync('node', [path.join('scripts', 'seed.js'), dataFile], { cwd: root, stdio: 'inherit' });

  console.log('\nStarting the server - http://localhost:8000\n');
  const result = spawnSync('node', ['server.js'], { cwd: root, stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
