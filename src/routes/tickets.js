const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../auth');
const { jsonError, asyncHandler } = require('../errors');

const router = express.Router();

// Quick check while scanning, before the sale is finalized. Doesn't write anything.
router.post('/tickets/check', asyncHandler(async (req, res) => {
  await requireRole(req, ['volunteer']);
  const code = String(req.body.code || '').trim();
  if (code === '') {
    jsonError('code is required', 400);
  }
  const { rows } = await pool.query('SELECT id FROM tickets WHERE code = $1', [code]);
  if (rows.length) {
    res.json({ valid: false, reason: 'This code has already been sold' });
    return;
  }
  res.json({ valid: true });
}));

// Finalizes a sale: assigns a batch of codes to one timeslot, or - if the
// clerk picked the Standby catch-all because no timeslot had room - issues
// them as standby tickets instead (no timeslot, no capacity constraint,
// same as the walk-up standby path in buses.js's board endpoint).
// Re-validates everything server-side (never trust the client's earlier check-scan results).
//
// Concurrency: takes a row lock on the timeslot (SELECT ... FOR UPDATE)
// before counting sold tickets, all inside one transaction. Without this, two
// concurrent sales against the same timeslot could both read "N seats left"
// before either commits, and both succeed - an oversold timeslot. The lock
// forces a second concurrent transaction against the *same* timeslot to wait
// until the first commits, so its own count reflects those inserts. Different
// timeslots aren't blocked by each other - the lock is per-row. Standby sales
// have no capacity to protect, so they don't need this lock.
router.post('/tickets/sell', asyncHandler(async (req, res) => {
  const user = await requireRole(req, ['volunteer']);
  const standby = req.body.standby === true;
  const timeslotId = req.body.timeslotId !== undefined ? parseInt(req.body.timeslotId, 10) : null;
  const codes = [...new Set((req.body.codes || []).map((c) => String(c).trim()).filter((c) => c !== ''))];
  if ((!standby && !timeslotId) || codes.length === 0) {
    jsonError('timeslotId (or standby) and at least one code are required', 400);
  }

  const sold = [];
  const rejected = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (standby) {
      for (const code of codes) {
        const { rows: existing } = await client.query('SELECT id FROM tickets WHERE code = $1', [code]);
        if (existing.length) {
          rejected.push({ code, reason: 'Already sold' });
          continue;
        }
        await client.query('INSERT INTO tickets (code, hub_id, timeslot_id, is_standby) VALUES ($1, $2, NULL, TRUE)', [code, user.hubId]);
        sold.push(code);
      }
      await client.query('COMMIT');
      res.json({ sold, rejected, timeslotId: null, standby: true });
      return;
    }

    const { rows: slotRows } = await client.query('SELECT * FROM timeslots WHERE id = $1 FOR UPDATE', [timeslotId]);
    const timeslot = slotRows[0];
    if (!timeslot) {
      jsonError('Timeslot not found', 404);
    }
    if (timeslot.hub_id !== user.hubId) {
      jsonError('That timeslot does not belong to your hub', 403);
    }

    const { rows: soldRows } = await client.query('SELECT COUNT(*)::int AS c FROM tickets WHERE timeslot_id = $1', [timeslotId]);
    const available = timeslot.capacity - soldRows[0].c;
    if (codes.length > available) {
      jsonError(`Only ${available} seat(s) left in that timeslot for ${codes.length} ticket(s)`, 409);
    }

    for (const code of codes) {
      const { rows: existing } = await client.query('SELECT id FROM tickets WHERE code = $1', [code]);
      if (existing.length) {
        rejected.push({ code, reason: 'Already sold' });
        continue;
      }
      await client.query('INSERT INTO tickets (code, hub_id, timeslot_id) VALUES ($1, $2, $3)', [code, user.hubId, timeslotId]);
      sold.push(code);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  res.json({ sold, rejected, timeslotId });
}));

// Looks up a ticket's current status, for the ticket update/reassignment page.
router.get('/tickets/lookup', asyncHandler(async (req, res) => {
  const user = await requireRole(req, ['volunteer', 'admin']);
  const code = String(req.query.code || '').trim();
  if (code === '') {
    jsonError('code is required', 400);
  }
  const { rows } = await pool.query(
    `SELECT t.*, ts.departure_time, ts.capacity AS slot_capacity
     FROM tickets t LEFT JOIN timeslots ts ON t.timeslot_id = ts.id
     WHERE t.code = $1`,
    [code]
  );
  const ticket = rows[0];
  if (!ticket) {
    jsonError('This ticket has not been allocated', 404);
  }
  if (user.role === 'volunteer' && ticket.hub_id !== user.hubId) {
    jsonError('This ticket was not sold at your hub', 403);
  }
  res.json({
    code: ticket.code,
    hubId: ticket.hub_id,
    timeslotId: ticket.timeslot_id !== null ? ticket.timeslot_id : null,
    departureTime: ticket.departure_time,
    isStandby: ticket.is_standby,
    boarded: ticket.leg1_bus_id !== null,
  });
}));

// Moves a ticket to a different timeslot at the same hub, releasing its seat
// in the original timeslot (capacity is always computed live from ticket
// counts, so simply changing timeslot_id is the whole "release" operation).
// Standby tickets can be switched too - since they have no timeslot to begin
// with, this converts them into a regular allocation against the chosen
// timeslot (is_standby flips to false, same as any other ticket in that
// timeslot). Only allowed before the ticket has boarded a bus.
//
// Same concurrency fix as /tickets/sell: locks the target timeslot row before
// counting, inside one transaction, so two concurrent reassignments can't
// both squeeze into the same last open seat.
router.post('/tickets/reassign', asyncHandler(async (req, res) => {
  const user = await requireRole(req, ['volunteer', 'admin']);
  const code = String(req.body.code || '').trim();
  const newTimeslotId = req.body.timeslotId !== undefined ? parseInt(req.body.timeslotId, 10) : null;
  if (code === '' || !newTimeslotId) {
    jsonError('code and timeslotId are required', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query('SELECT * FROM tickets WHERE code = $1', [code]);
    const ticket = rows[0];
    if (!ticket) {
      jsonError('Unknown ticket code', 404);
    }
    if (user.role === 'volunteer' && ticket.hub_id !== user.hubId) {
      jsonError('This ticket was not sold at your hub', 403);
    }
    if (ticket.leg1_bus_id !== null) {
      jsonError('This ticket has already boarded a bus and can no longer be switched', 409);
    }
    if (ticket.timeslot_id === newTimeslotId) {
      jsonError("That's already this ticket's timeslot", 409);
    }

    const { rows: slotRows } = await client.query('SELECT * FROM timeslots WHERE id = $1 FOR UPDATE', [newTimeslotId]);
    const newSlot = slotRows[0];
    if (!newSlot) {
      jsonError('Timeslot not found', 404);
    }
    if (newSlot.hub_id !== ticket.hub_id) {
      jsonError('That timeslot belongs to a different hub', 409);
    }

    const { rows: soldRows } = await client.query('SELECT COUNT(*)::int AS c FROM tickets WHERE timeslot_id = $1', [newTimeslotId]);
    if (soldRows[0].c >= newSlot.capacity) {
      jsonError('That timeslot is full', 409);
    }

    await client.query('UPDATE tickets SET timeslot_id = $1, is_standby = FALSE WHERE id = $2', [newTimeslotId, ticket.id]);
    await client.query('COMMIT');
    res.json({ code, newTimeslotId, departureTime: newSlot.departure_time });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

module.exports = router;
