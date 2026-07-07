// One-time onboarding for a new collaborator/environment:
//   npm run setup                       - seeds scripts/example.json
//   npm run setup -- path/to/data.json  - seeds a specific data file instead
//
// Copies .env.example to .env if one doesn't already exist (never overwrites
// a real .env), then runs scripts/seed.js against the given (or default)
// data file. Doesn't touch Postgres itself - you still need an instance
// reachable at whatever DATABASE_URL ends up pointing to.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
const envExamplePath = path.join(root, '.env.example');

if (fs.existsSync(envPath)) {
  console.log('.env already exists - leaving it as-is.');
} else {
  fs.copyFileSync(envExamplePath, envPath);
  console.log('Created .env from .env.example - edit DATABASE_URL/JWT_SECRET if needed.');
}

const dataFile = process.argv[2] || path.join('scripts', 'example.json');
console.log(`Seeding from ${dataFile} ...`);
execFileSync('node', [path.join('scripts', 'seed.js'), dataFile], { cwd: root, stdio: 'inherit' });

console.log('\nSetup complete. Run `npm start` and open http://localhost:8000');
