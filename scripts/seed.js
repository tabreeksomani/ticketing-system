// Manual bulk setup for hubs/timeslots/logins, run by hand - not an API.
// Usage: node scripts/seed.js path/to/data.json
//
// Safe to re-run: hubs and logins are upserted by id; timeslots are matched
// by (hub_id, departure_time) and updated in place rather than duplicated.
//
// Expected JSON shape:
// {
//   "admin": { "password": "..." },
//   "hubs": [
//     {
//       "id": "surrey",              // optional - derived from name if omitted
//       "name": "Surrey",
//       "travelMinutes": 45,
//       "volunteerPassword": "...",
//       "timeslots": [
//         { "departureTime": "2026-07-06T18:00:00", "capacity": 50 }
//       ]
//     }
//   ]
// }

require('dotenv').config();
const fs = require('fs');
const path = require('path');
// Reuses the server's own pool/schema-creation instead of assuming the
// tables already exist - on a genuinely fresh database (e.g. a just-started
// Docker container), nothing has created them yet until this runs `ready()`.
const { pool, ready } = require('../src/db');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/seed.js path/to/data.json');
  process.exit(1);
}

function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'hub';
}

async function main() {
  await ready();
  const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));

  try {
    if (data.admin && data.admin.password) {
      await pool.query(
        `INSERT INTO logins (id, role, hub_id, secret) VALUES ('admin', 'admin', NULL, $1)
         ON CONFLICT (id) DO UPDATE SET secret = excluded.secret`,
        [data.admin.password]
      );
      console.log('admin login: set');
    }

    for (const role of ['venue', 'central']) {
      if (data[role] && data[role].password) {
        await pool.query(
          `INSERT INTO logins (id, role, hub_id, secret) VALUES ($1, $1, NULL, $2)
           ON CONFLICT (id) DO UPDATE SET secret = excluded.secret`,
          [role, data[role].password]
        );
        console.log(`${role} login: set`);
      }
    }

    for (const hub of data.hubs || []) {
      const id = hub.id || slugify(hub.name);
      await pool.query(
        `INSERT INTO hubs (id, name, travel_minutes) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, travel_minutes = excluded.travel_minutes`,
        [id, hub.name, hub.travelMinutes ?? 30]
      );
      console.log(`hub "${hub.name}" (${id}): upserted`);

      if (hub.volunteerPassword) {
        await pool.query(
          `INSERT INTO logins (id, role, hub_id, secret) VALUES ($1, 'volunteer', $1, $2)
           ON CONFLICT (id) DO UPDATE SET role = 'volunteer', hub_id = excluded.hub_id, secret = excluded.secret`,
          [id, hub.volunteerPassword]
        );
        console.log(`  volunteer login: set`);
      }

      for (const slot of hub.timeslots || []) {
        const { rows } = await pool.query(
          'SELECT id FROM timeslots WHERE hub_id = $1 AND departure_time = $2',
          [id, slot.departureTime]
        );
        if (rows.length) {
          await pool.query('UPDATE timeslots SET capacity = $1 WHERE id = $2', [slot.capacity, rows[0].id]);
          console.log(`  timeslot ${slot.departureTime}: updated capacity to ${slot.capacity}`);
        } else {
          await pool.query(
            'INSERT INTO timeslots (hub_id, departure_time, capacity) VALUES ($1, $2, $3)',
            [id, slot.departureTime, slot.capacity]
          );
          console.log(`  timeslot ${slot.departureTime}: created (capacity ${slot.capacity})`);
        }
      }
    }

    console.log('Done.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
