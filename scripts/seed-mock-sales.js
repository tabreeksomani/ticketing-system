// scripts/seed-mock-sales.js
// Utility script to populate the local database with mock sales data matching the dashboard layout

const { pool } = require('../src/db');

async function seed() {
  console.log('=== STARTING MOCK SALES DATA SEEDING ===');

  try {
    console.log('Clearing old tickets, timeslots, and hubs...');
    await pool.query('DELETE FROM tickets');
    await pool.query('DELETE FROM timeslots');
    await pool.query('DELETE FROM hubs');

    const hubs = [
      { id: 'abbotsford', name: 'Abbotsford', capacity: 514, sold: 26 },
      { id: 'burnaby_lake', name: 'Burnaby Lake', capacity: 1500, sold: 236 },
      { id: 'capilano', name: 'Capilano University', capacity: 0, sold: 0 },
      { id: 'darkhana', name: 'Darkhana', capacity: 1050, sold: 203 }
    ];

    for (const h of hubs) {
      console.log(`Inserting hub "${h.name}"...`);
      await pool.query(
        'INSERT INTO hubs (id, name, travel_minutes) VALUES ($1, $2, 30)',
        [h.id, h.name]
      );
      
      if (h.capacity > 0) {
        console.log(`  - Creating timeslot of capacity ${h.capacity}...`);
        const { rows } = await pool.query(
          'INSERT INTO timeslots (hub_id, departure_time, capacity) VALUES ($1, $2, $3) RETURNING id',
          [h.id, '08:00 AM', h.capacity]
        );
        const slotId = rows[0].id;

        console.log(`  - Inserting ${h.sold} sold tickets...`);
        // Bulk insert to speed up seeding
        const values = [];
        const params = [h.id, slotId, 'adult'];
        for (let i = 0; i < h.sold; i++) {
          values.push(`($1, $2, $3, 'TKT-${h.id}-${i}')`);
        }

        if (values.length > 0) {
          const query = `
            INSERT INTO tickets (hub_id, timeslot_id, fare_type, code)
            VALUES ${values.join(', ')}
          `;
          await pool.query(query, params);
        }
      }
    }

    console.log('\n✅ Seeding completed successfully!');
  } catch (err) {
    console.error('\n❌ Seeding failed:', err.message);
  } finally {
    await pool.end();
  }
}

seed();
