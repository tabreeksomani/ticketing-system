// scripts/test-concurrency.js
// Audits and tests the concurrency safety of the database ticket allocation.
// Replicates the overselling bug (without FOR UPDATE) and verifies the fix (with FOR UPDATE).

const { Pool } = require('pg');
require('dotenv').config();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function simulatePurchase(pool, timeslotId, codes, useLocking) {
  const client = await pool.connect();
  const result = { success: false, error: null };
  
  try {
    await client.query('BEGIN');
    
    // 1. Fetch timeslot (either with row lock or without)
    const lockClause = useLocking ? 'FOR UPDATE' : '';
    const { rows: slotRows } = await client.query(
      `SELECT * FROM timeslots WHERE id = $1 ${lockClause}`,
      [timeslotId]
    );
    const timeslot = slotRows[0];
    
    // 2. Count existing sales
    const { rows: soldRows } = await client.query(
      'SELECT COUNT(*)::int AS c FROM tickets WHERE timeslot_id = $1',
      [timeslotId]
    );
    const available = timeslot.capacity - soldRows[0].c;
    
    // Simulate database processing delay to guarantee transaction overlap
    await delay(100);
    
    // 3. Check capacity constraint
    if (codes.length > available) {
      throw new Error(`Only ${available} seat(s) left for ${codes.length} tickets requested.`);
    }
    
    // 4. Insert tickets
    for (const code of codes) {
      await client.query(
        "INSERT INTO tickets (code, hub_id, timeslot_id) VALUES ($1, 'burnaby-lake', $2)",
        [code, timeslotId]
      );
    }
    
    await client.query('COMMIT');
    result.success = true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    result.error = err.message;
  } finally {
    client.release();
  }
  
  return result;
}

async function runAudit() {
  console.log('=== DATABASE CONCURRENCY AUDIT & REPLICATION ===');
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    // ==========================================
    // PHASE 1: Replicate the Bug (Without FOR UPDATE)
    // ==========================================
    console.log('\n--- PHASE 1: Replicating Bug (No locking) ---');
    
    // Create a timeslot with capacity = 3
    const insertRes1 = await pool.query(
      "INSERT INTO timeslots (hub_id, departure_time, capacity) VALUES ('burnaby-lake', '23:59', 3) RETURNING id"
    );
    const timeslotId1 = insertRes1.rows[0].id;
    console.log(`Created Timeslot ID ${timeslotId1} with Capacity: 3`);

    // Fire 3 concurrent purchases of 2 tickets each (total 6) without locking
    console.log('Sending 3 concurrent requests (2 tickets each) without locks...');
    const results1 = await Promise.all([
      simulatePurchase(pool, timeslotId1, ['BUG-A1', 'BUG-A2'], false),
      simulatePurchase(pool, timeslotId1, ['BUG-B1', 'BUG-B2'], false),
      simulatePurchase(pool, timeslotId1, ['BUG-C1', 'BUG-C2'], false)
    ]);

    results1.forEach((res, i) => {
      console.log(`  Request ${i + 1}: ${res.success ? '✅ SUCCESS' : '❌ FAILED - ' + res.error}`);
    });

    // Check DB ticket count
    const countRes1 = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tickets WHERE timeslot_id = $1',
      [timeslotId1]
    );
    const ticketsSold1 = countRes1.rows[0].count;
    console.log(`Database Check: Written tickets = ${ticketsSold1} (Capacity limit = 3)`);
    
    if (ticketsSold1 > 3) {
      console.log('⚠️  BUG REPLICATED: The database allowed overselling (double-booking)!');
    }

    // Cleanup Phase 1
    await pool.query('DELETE FROM tickets WHERE timeslot_id = $1', [timeslotId1]);
    await pool.query('DELETE FROM timeslots WHERE id = $1', [timeslotId1]);

    // ==========================================
    // PHASE 2: Verify the Fix (With FOR UPDATE)
    // ==========================================
    console.log('\n--- PHASE 2: Verifying Fix (With SELECT ... FOR UPDATE) ---');
    
    // Create another timeslot with capacity = 3
    const insertRes2 = await pool.query(
      "INSERT INTO timeslots (hub_id, departure_time, capacity) VALUES ('burnaby-lake', '23:59', 3) RETURNING id"
    );
    const timeslotId2 = insertRes2.rows[0].id;
    console.log(`Created Timeslot ID ${timeslotId2} with Capacity: 3`);

    // Fire 3 concurrent purchases of 2 tickets each (total 6) with locking
    console.log('Sending 3 concurrent requests (2 tickets each) with row locking...');
    const results2 = await Promise.all([
      simulatePurchase(pool, timeslotId2, ['FIX-A1', 'FIX-A2'], true),
      simulatePurchase(pool, timeslotId2, ['FIX-B1', 'FIX-B2'], true),
      simulatePurchase(pool, timeslotId2, ['FIX-C1', 'FIX-C2'], true)
    ]);

    results2.forEach((res, i) => {
      console.log(`  Request ${i + 1}: ${res.success ? '✅ SUCCESS' : '❌ FAILED - ' + res.error}`);
    });

    // Check DB ticket count
    const countRes2 = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tickets WHERE timeslot_id = $1',
      [timeslotId2]
    );
    const ticketsSold2 = countRes2.rows[0].count;
    console.log(`Database Check: Written tickets = ${ticketsSold2} (Capacity limit = 3)`);
    
    if (ticketsSold2 <= 3) {
      console.log('🛡️  FIX VERIFIED: Row locking successfully blocked double-booking!');
    }

    // Cleanup Phase 2
    await pool.query('DELETE FROM tickets WHERE timeslot_id = $1', [timeslotId2]);
    await pool.query('DELETE FROM timeslots WHERE id = $1', [timeslotId2]);

  } catch (error) {
    console.error('Audit execution failed:', error.message);
  } finally {
    await pool.end();
    console.log('\nAudit completed.');
  }
}

runAudit();
