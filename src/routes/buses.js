const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireOwnHub } = require('../auth');
const { jsonError, asyncHandler } = require('../errors');
const { normalizeCode } = require('../util');

const router = express.Router();

function busRow(row) {
  return {
    id: row.id,
    leg: row.leg,
    hubId: row.hub_id,
    hubName: row.hub_name ?? null,
    timeslotId: row.timeslot_id !== null && row.timeslot_id !== undefined ? row.timeslot_id : null,
    label: row.label,
    capacity: row.capacity,
    status: row.status,
    onboard: Number(row.onboard),
    boardingStartedAt: row.boarding_started_at,
    departedAt: row.departed_at,
    arrivedAt: row.arrived_at ?? null,
  };
}

async function fetchBus(id) {
  const { rows } = await pool.query('SELECT * FROM buses WHERE id = $1', [id]);
  const bus = rows[0];
  if (!bus) return null;
  const countCol = bus.leg === 'hub_to_central' ? 'leg1_bus_id' : 'leg2_bus_id';
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS c FROM tickets WHERE ${countCol} = $1`, [id]);
  bus.onboard = countRows[0].c;
  return bus;
}

router.get('/buses', asyncHandler(async (req, res) => {
  const user = await requireAuth(req);
  const leg = req.query.leg;
  if (!['hub_to_central', 'central_to_venue'].includes(leg)) {
    jsonError('leg must be hub_to_central or central_to_venue', 400);
  }

  const countCol = leg === 'hub_to_central' ? 'leg1_bus_id' : 'leg2_bus_id';
  let sql = `SELECT b.*, h.name AS hub_name, (SELECT COUNT(*) FROM tickets tk WHERE tk.${countCol} = b.id)::int AS onboard
             FROM buses b LEFT JOIN hubs h ON h.id = b.hub_id WHERE b.leg = $1`;
  const params = [leg];

  if (leg === 'hub_to_central') {
    if (user.role === 'volunteer') {
      params.push(user.hubId);
      sql += ` AND b.hub_id = $${params.length}`;
    } else if (user.role === 'central') {
      // Dormant - no login can have this role anymore since central hub was
      // removed. Left in place for when central returns as an ordinary hub.
      if (req.query.status) {
        params.push(req.query.status);
        sql += ` AND b.status = $${params.length}`;
      }
    } else if (user.role === 'admin') {
      if (req.query.hubId) {
        params.push(req.query.hubId);
        sql += ` AND b.hub_id = $${params.length}`;
      }
    } else {
      jsonError('Not authorized', 403);
    }
  } else if (!['central', 'admin'].includes(user.role)) {
    jsonError('Not authorized', 403);
  }

  sql += ' ORDER BY b.id ASC';
  const { rows } = await pool.query(sql, params);
  res.json(rows.map(busRow));
}));

router.post('/buses', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const leg = req.body.leg;
  const label = String(req.body.label || '').trim();
  const capacity = req.body.capacity !== undefined ? parseInt(req.body.capacity, 10) : null;
  if (!['hub_to_central', 'central_to_venue'].includes(leg) || label === '' || !capacity) {
    jsonError('leg, label, and capacity are required', 400);
  }

  let hubId = null;
  let timeslotId = null;
  if (leg === 'hub_to_central') {
    hubId = req.body.hubId || null;
    if (!hubId) {
      jsonError('hubId is required for a hub_to_central bus', 400);
    }
    const { rows } = await pool.query('SELECT id FROM hubs WHERE id = $1', [hubId]);
    if (rows.length === 0) {
      jsonError('Hub not found', 404);
    }
    timeslotId = req.body.timeslotId ? parseInt(req.body.timeslotId, 10) : null;
  }

  const { rows: inserted } = await pool.query(
    "INSERT INTO buses (leg, hub_id, timeslot_id, label, capacity, status) VALUES ($1, $2, $3, $4, $5, 'scheduled') RETURNING id",
    [leg, hubId, timeslotId, label, capacity]
  );
  res.status(201).json(busRow({
    id: inserted[0].id, leg, hub_id: hubId, timeslot_id: timeslotId,
    label, capacity, status: 'scheduled',
    onboard: 0, boarding_started_at: null, departed_at: null, arrived_at: null,
  }));
}));

// Admin can edit a bus's label/capacity only before boarding has started -
// changing capacity mid-boarding (or after departure) would be confusing and
// could invalidate the capacity checks already applied to boarded tickets.
router.put('/buses/:id(\\d+)', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const busId = parseInt(req.params.id, 10);
  const bus = await fetchBus(busId);
  if (!bus) {
    jsonError('Bus not found', 404);
  }
  if (bus.status !== 'scheduled') {
    jsonError('Can only edit a bus before boarding has started', 409);
  }

  const label = 'label' in req.body ? String(req.body.label).trim() : bus.label;
  const capacity = 'capacity' in req.body ? parseInt(req.body.capacity, 10) : bus.capacity;
  if (label === '' || capacity < 1) {
    jsonError('label and a positive capacity are required', 400);
  }

  await pool.query('UPDATE buses SET label = $1, capacity = $2 WHERE id = $3', [label, capacity, busId]);
  res.json(busRow(await fetchBus(busId)));
}));

// Admin can delete a bus only if it never received any passengers - deleting a
// bus that tickets already point to would orphan those references.
router.delete('/buses/:id(\\d+)', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const busId = parseInt(req.params.id, 10);
  const bus = await fetchBus(busId);
  if (!bus) {
    jsonError('Bus not found', 404);
  }
  if (bus.onboard > 0) {
    jsonError('Cannot delete a bus that already has passengers on it', 409);
  }
  await pool.query('DELETE FROM buses WHERE id = $1', [busId]);
  res.json({ deleted: busId });
}));

// Board a single scanned ticket onto this bus. Works for either leg, gated appropriately.
router.post('/buses/:id(\\d+)/board', asyncHandler(async (req, res) => {
  const user = await requireAuth(req);
  const busId = parseInt(req.params.id, 10);
  const bus = await fetchBus(busId);
  if (!bus) {
    jsonError('Bus not found', 404);
  }

  if (bus.leg === 'hub_to_central') {
    requireOwnHub(user, bus.hub_id);
  } else if (user.role !== 'central') {
    jsonError('Not authorized', 403);
  }

  if (bus.status === 'departed') {
    jsonError('This bus has already departed', 409);
  }
  if (bus.onboard >= bus.capacity) {
    jsonError('Bus is at full capacity', 409);
  }

  const code = normalizeCode(req.body.code);
  if (code === '') {
    jsonError('code is required', 400);
  }

  const { rows } = await pool.query('SELECT * FROM tickets WHERE code = $1', [code]);
  let ticket = rows[0];

  let isNewStandby = false;
  if (!ticket) {
    if (bus.leg !== 'hub_to_central') {
      // Only the originating hub can issue a standby ticket - a leg2 (venue)
      // scan is supposed to be for a ticket that already exists from leg1.
      jsonError('Unknown ticket code', 404);
    }
    // Forgotten-ticket workflow: this code was never sold through the normal
    // flow, so treat it as a walk-up standby - create it now, tied to this
    // hub, with no pre-sold timeslot (so it never counts against any
    // timeslot's capacity), and board it in the same step.
    await pool.query('INSERT INTO tickets (code, hub_id, timeslot_id, is_standby) VALUES ($1, $2, NULL, TRUE)', [code, bus.hub_id]);
    const { rows: newRows } = await pool.query('SELECT * FROM tickets WHERE code = $1', [code]);
    ticket = newRows[0];
    isNewStandby = true;
  }

  // Scanning constraint: once ingressed (scanned onto any bus), a ticket
  // can't be scanned again until it's egressed. Egress isn't wired up to
  // anything yet, so today this just means "once, ever" per ticket.
  if (ticket.is_ingressed && !ticket.is_egressed) {
    jsonError('This ticket has already been scanned in and cannot be scanned again until egress', 409);
  }

  if (bus.leg === 'hub_to_central') {
    if (ticket.hub_id !== bus.hub_id) {
      jsonError('This ticket was not sold at this hub', 409);
    }
    if (ticket.leg1_bus_id !== null) {
      jsonError('This ticket has already boarded a bus', 409);
    }
    await pool.query('UPDATE tickets SET leg1_bus_id = $1, leg1_boarded_at = now(), is_ingressed = TRUE WHERE id = $2', [busId, ticket.id]);
  } else {
    if (ticket.leg1_bus_id === null) {
      jsonError('This ticket has not boarded a hub bus yet', 409);
    }
    const leg1Bus = await fetchBus(ticket.leg1_bus_id);
    // 'arrived' is a further progression of 'departed', not a different
    // branch - a bus that's been confirmed arrived definitely also departed.
    if (!leg1Bus || !['departed', 'arrived'].includes(leg1Bus.status)) {
      jsonError("This ticket's hub bus has not departed yet", 409);
    }
    if (ticket.leg2_bus_id !== null) {
      jsonError('This ticket has already boarded a venue bus', 409);
    }
    await pool.query('UPDATE tickets SET leg2_bus_id = $1, leg2_boarded_at = now() WHERE id = $2', [busId, ticket.id]);
  }

  // First scan onto a 'scheduled' bus flips it into 'boarding'.
  if (bus.status === 'scheduled') {
    await pool.query("UPDATE buses SET status = 'boarding', boarding_started_at = now() WHERE id = $1", [busId]);
  }

  const result = busRow(await fetchBus(busId));
  result.issuedStandby = isNewStandby;
  res.json(result);
}));

router.post('/buses/:id(\\d+)/depart', asyncHandler(async (req, res) => {
  const user = await requireAuth(req);
  const busId = parseInt(req.params.id, 10);
  const bus = await fetchBus(busId);
  if (!bus) {
    jsonError('Bus not found', 404);
  }

  if (bus.leg === 'hub_to_central') {
    requireOwnHub(user, bus.hub_id);
  } else if (user.role !== 'central') {
    jsonError('Not authorized', 403);
  }

  if (bus.status === 'departed') {
    jsonError('This bus has already departed', 409);
  }
  if (bus.status !== 'boarding') {
    jsonError('Board at least one passenger before departing', 409);
  }

  await pool.query("UPDATE buses SET status = 'departed', departed_at = now() WHERE id = $1", [busId]);
  res.json(busRow(await fetchBus(busId)));
}));

// Central marshal confirms a hub bus has physically arrived at the central hub.
// This is a manual confirmation, not a calculated ETA - it's what actually moves
// a bus's passengers into the "currently at central hub" dashboard count.
router.post('/buses/:id(\\d+)/arrive', asyncHandler(async (req, res) => {
  const user = await requireAuth(req);
  if (!['central', 'admin'].includes(user.role)) {
    jsonError('Not authorized', 403);
  }
  const busId = parseInt(req.params.id, 10);
  const bus = await fetchBus(busId);
  if (!bus) {
    jsonError('Bus not found', 404);
  }
  if (bus.leg !== 'hub_to_central') {
    jsonError('Only hub-to-central buses can be marked arrived', 400);
  }
  if (bus.status === 'arrived') {
    jsonError('This bus is already marked arrived', 409);
  }
  if (bus.status !== 'departed') {
    jsonError('This bus must depart its hub before it can be marked arrived', 409);
  }

  await pool.query("UPDATE buses SET status = 'arrived', arrived_at = now() WHERE id = $1", [busId]);
  res.json(busRow(await fetchBus(busId)));
}));

module.exports = router;
