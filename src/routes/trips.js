const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { jsonError, asyncHandler } = require('../errors');
const { normalizeCode } = require('../util');

const router = express.Router();

// The full 4-leg round trip: O1 (hub->central), O2 (central->venue),
// R1 (venue->central), R2 (central->hub). Each leg is an independent,
// non-persistent bus trip - a bus isn't tracked across legs, so every leg
// creates its own bus_trips row. `tripCol` picks which trip{n}_id/
// trip{n}_boarded_at pair on `tickets` belongs to this leg.
//
// originRole is who may create/board/depart a trip on this leg. arrivalRole
// is who may mark it arrived - deliberately NOT always the same as
// originRole (e.g. O1 is created by a hub volunteer but arrives under
// Central's role, since Central is physically the one receiving the bus).
const LEGS = {
  O1: { originRole: 'volunteer', destination: 'central', arrivalRole: 'central', tripCol: 'trip1', allowStandbyCreate: true },
  O2: { originRole: 'central', destination: 'venue', arrivalRole: 'venue', tripCol: 'trip2' },
  R1: { originRole: 'venue', destination: 'central', arrivalRole: 'central', tripCol: 'trip3' },
  R2: { originRole: 'central', destination: 'dynamic-hub', arrivalRole: 'volunteer', tripCol: 'trip4', validateHomeHub: true },
};

function legConfig(leg) {
  const config = LEGS[leg];
  if (!config) jsonError('leg must be one of O1, O2, R1, R2', 400);
  return config;
}

// Picks the right trip{n}_id column for a trip's own leg, so one query works
// across all four legs instead of needing four near-identical branches.
function onboardCountCase(alias = 'bt') {
  return `(CASE ${alias}.leg
    WHEN 'O1' THEN (SELECT COUNT(*) FROM tickets tk WHERE tk.trip1_id = ${alias}.id)
    WHEN 'O2' THEN (SELECT COUNT(*) FROM tickets tk WHERE tk.trip2_id = ${alias}.id)
    WHEN 'R1' THEN (SELECT COUNT(*) FROM tickets tk WHERE tk.trip3_id = ${alias}.id)
    WHEN 'R2' THEN (SELECT COUNT(*) FROM tickets tk WHERE tk.trip4_id = ${alias}.id)
  END)::int`;
}

function tripRow(row) {
  return {
    id: row.id,
    leg: row.leg,
    licensePlate: row.license_plate,
    origin: row.origin,
    destination: row.destination,
    status: row.status,
    onboard: Number(row.onboard ?? 0),
    createdBy: row.created_by,
    createdAt: row.created_at,
    boardingStartedAt: row.boarding_started_at,
    departedAt: row.departed_at,
    arrivedAt: row.arrived_at,
  };
}

async function fetchTrip(id) {
  const { rows } = await pool.query(
    `SELECT bt.*, ${onboardCountCase('bt')} AS onboard FROM bus_trips bt WHERE bt.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// The caller's own origin scope for a leg - what "my hub/location" resolves
// to for create/board/depart access. Throws if the caller's role doesn't
// match this leg's originRole at all. For a volunteer (who may cover
// several hubs), the caller must say explicitly which one via
// `requestedOrigin` (the frontend's hub switcher) - it's no longer implicit.
function callerOrigin(user, leg, config, requestedOrigin) {
  if (user.role === 'admin') return requestedOrigin || null;
  if (user.role !== config.originRole) {
    jsonError('Not authorized for this leg', 403);
  }
  if (config.originRole === 'volunteer') {
    if (!requestedOrigin || !user.hubIds.includes(requestedOrigin)) {
      jsonError('origin must be one of your hubs', 403);
    }
    return requestedOrigin;
  }
  return leg === 'O2' || leg === 'R2' ? 'central' : 'venue';
}

function isOriginAuthorized(user, trip, config) {
  if (user.role === 'admin') return true;
  if (config.originRole === 'volunteer') return user.role === 'volunteer' && user.hubIds.includes(trip.origin);
  return user.role === config.originRole;
}

function isArrivalAuthorized(user, trip, config) {
  if (user.role === 'admin') return true;
  if (config.arrivalRole === 'volunteer') return user.role === 'volunteer' && user.hubIds.includes(trip.destination);
  return user.role === config.arrivalRole;
}

function requireOriginAccess(user, trip, config) {
  if (!isOriginAuthorized(user, trip, config)) jsonError('Not authorized for this trip', 403);
}

// Either side of the leg can mark it arrived - normally the receiving
// location, but also whoever departed it, for when that same volunteer
// physically rides along with the bus and wants to confirm arrival
// themselves without needing a separate login at the destination.
function requireArrivalAccess(user, trip, config) {
  if (!isOriginAuthorized(user, trip, config) && !isArrivalAuthorized(user, trip, config)) {
    jsonError('Not authorized for this trip', 403);
  }
}

// List trips for one leg, scoped by role.
// side=origin  -> trips this caller could board/depart (their own origin).
// side=arrival -> trips this caller could mark arrived, limited to ones
//                 actually awaiting arrival (departed, not yet arrived).
router.get('/trips', asyncHandler(async (req, res) => {
  const user = await requireAuth(req);
  const leg = req.query.leg;
  const side = req.query.side === 'arrival' ? 'arrival' : 'origin';
  const config = legConfig(leg);

  const params = [leg];
  let sql = `SELECT bt.*, ${onboardCountCase('bt')} AS onboard FROM bus_trips bt WHERE bt.leg = $1`;

  if (side === 'origin') {
    const origin = callerOrigin(user, leg, config, req.query.origin);
    if (origin !== null) {
      params.push(origin);
      sql += ` AND bt.origin = $${params.length}`;
    }
  } else {
    if (config.arrivalRole === 'volunteer') {
      if (user.role === 'admin') {
        // no extra scope - admin sees all
      } else if (user.role !== 'volunteer') {
        jsonError('Not authorized for this leg', 403);
      } else {
        const destination = req.query.destination;
        if (!destination || !user.hubIds.includes(destination)) {
          jsonError('destination must be one of your hubs', 403);
        }
        params.push(destination);
        sql += ` AND bt.destination = $${params.length}`;
      }
    } else if (user.role !== 'admin') {
      if (user.role !== config.arrivalRole) jsonError('Not authorized for this leg', 403);
      params.push(config.arrivalRole === 'central' ? 'central' : 'venue');
      sql += ` AND bt.destination = $${params.length}`;
    }
    sql += ` AND bt.status = 'departed' AND bt.arrived_at IS NULL`;
  }

  // Departures (side=origin): newest trip first, so whichever trip is
  // actively boarding is the one nearest the top, not buried under the
  // day's earlier trips. Arrivals stay oldest-first (FIFO) - whichever bus
  // departed earliest should be the one dispatchers expect to arrive next.
  sql += side === 'origin' ? ' ORDER BY bt.id DESC' : ' ORDER BY bt.id ASC';
  const { rows } = await pool.query(sql, params);
  res.json(rows.map(tripRow));
}));

// Per hub, tickets that have arrived at Central via R1 but not yet boarded
// R2 - the live "waiting to go home" queue that drives Central's R2
// destination picker (and is reused by the admin Shuttle dashboard).
router.get('/trips/hub-headcounts', asyncHandler(async (req, res) => {
  await requireRole(req, ['central', 'admin']);
  // LEFT JOIN from hubs (not tickets) so every hub appears in the picker,
  // including ones with nobody currently waiting - Central needs to be able
  // to dispatch a bus to any hub, not just ones with a nonzero headcount.
  const { rows } = await pool.query(
    `SELECT h.id AS hub_id, h.name AS hub_name,
            COUNT(t.id) FILTER (WHERE bt.arrived_at IS NOT NULL AND t.trip4_id IS NULL)::int AS count
     FROM hubs h
     LEFT JOIN tickets t ON t.hub_id = h.id
     LEFT JOIN bus_trips bt ON t.trip3_id = bt.id
     GROUP BY h.id, h.name
     ORDER BY h.name ASC`
  );
  res.json(rows.map((r) => ({ hubId: r.hub_id, hubName: r.hub_name, count: r.count })));
}));

router.post('/trips', asyncHandler(async (req, res) => {
  const leg = req.body.leg;
  const config = legConfig(leg);
  const user = await requireRole(req, [config.originRole, 'admin']);

  const licensePlate = String(req.body.licensePlate || '').trim();
  if (licensePlate === '') jsonError('licensePlate is required', 400);

  let origin;
  if (config.originRole === 'volunteer') {
    origin = String(req.body.origin || '').trim() || null;
    if (!origin) jsonError('origin is required', 400);
    if (user.role === 'volunteer' && !user.hubIds.includes(origin)) {
      jsonError('origin must be one of your hubs', 403);
    }
  } else {
    origin = leg === 'O2' || leg === 'R2' ? 'central' : 'venue';
  }

  let destination;
  if (config.destination === 'dynamic-hub') {
    destination = String(req.body.destinationHubId || '').trim();
    if (!destination) jsonError('destinationHubId is required', 400);
    const { rows: hubRows } = await pool.query('SELECT id FROM hubs WHERE id = $1', [destination]);
    if (!hubRows.length) jsonError('Unknown destination hub', 404);
  } else {
    destination = config.destination;
  }

  const { rows } = await pool.query(
    `INSERT INTO bus_trips (license_plate, origin, destination, leg, status, created_by)
     VALUES ($1, $2, $3, $4, 'scheduled', $5) RETURNING *`,
    [licensePlate, origin, destination, leg, user.id]
  );
  res.status(201).json(tripRow({ ...rows[0], onboard: 0 }));
}));

router.post('/trips/:id(\\d+)/board', asyncHandler(async (req, res) => {
  const user = await requireAuth(req);
  const tripId = parseInt(req.params.id, 10);
  const trip = await fetchTrip(tripId);
  if (!trip) jsonError('Trip not found', 404);
  const config = legConfig(trip.leg);
  requireOriginAccess(user, trip, config);

  if (trip.status === 'departed' || trip.status === 'arrived') {
    jsonError('This trip has already departed', 409);
  }

  const code = normalizeCode(req.body.code);
  if (code === '') jsonError('code is required', 400);

  const { rows } = await pool.query(
    `SELECT t.*, h.name AS hub_name FROM tickets t JOIN hubs h ON h.id = t.hub_id WHERE t.code = $1`,
    [code]
  );
  let ticket = rows[0];

  let isNewStandby = false;
  if (!ticket) {
    if (!config.allowStandbyCreate) {
      jsonError('Unknown ticket code', 404);
    }
    // Forgotten-ticket workflow (O1/Hub only): treat as a walk-up standby,
    // tied to this trip's origin hub, boarded in the same step.
    await pool.query('INSERT INTO tickets (code, hub_id, timeslot_id, is_standby) VALUES ($1, $2, NULL, TRUE)', [code, trip.origin]);
    const { rows: newRows } = await pool.query(
      `SELECT t.*, h.name AS hub_name FROM tickets t JOIN hubs h ON h.id = t.hub_id WHERE t.code = $1`,
      [code]
    );
    ticket = newRows[0];
    isNewStandby = true;
  }

  const idCol = `${config.tripCol}_id`;
  const atCol = `${config.tripCol}_boarded_at`;

  // Anti-rescan: scoped to this leg's own column only - a ticket can be on
  // at most one trip per leg, but boarding one leg has no effect on another.
  if (ticket[idCol] !== null) {
    jsonError('This ticket has already been scanned for this leg and cannot be scanned again', 409);
  }

  // R2 only: the ticket can only board the bus signed for its own home hub.
  if (config.validateHomeHub && ticket.hub_id !== trip.destination) {
    const { rows: destRows } = await pool.query('SELECT name FROM hubs WHERE id = $1', [trip.destination]);
    const destName = destRows[0] ? destRows[0].name : trip.destination;
    jsonError(`Wrong bus — this ticket is for ${ticket.hub_name}, not ${destName}`, 409);
  }

  await pool.query(`UPDATE tickets SET ${idCol} = $1, ${atCol} = now() WHERE id = $2`, [tripId, ticket.id]);

  if (trip.status === 'scheduled') {
    await pool.query("UPDATE bus_trips SET status = 'boarding', boarding_started_at = now() WHERE id = $1", [tripId]);
  }

  const result = tripRow(await fetchTrip(tripId));
  result.issuedStandby = isNewStandby;
  // O2 passive display only (§8.1): shows when this rider arrived at Central
  // via O1, so a volunteer can visually catch someone boarding out of order.
  // Purely informational - never blocks the scan.
  if (trip.leg === 'O2') {
    result.priorLegBoardedAt = ticket.trip1_boarded_at;
  }
  res.json(result);
}));

router.post('/trips/:id(\\d+)/depart', asyncHandler(async (req, res) => {
  const user = await requireAuth(req);
  const tripId = parseInt(req.params.id, 10);
  const trip = await fetchTrip(tripId);
  if (!trip) jsonError('Trip not found', 404);
  const config = legConfig(trip.leg);
  requireOriginAccess(user, trip, config);

  if (trip.status === 'departed' || trip.status === 'arrived') {
    jsonError('This trip has already departed', 409);
  }
  if (trip.status !== 'boarding') {
    jsonError('Board at least one passenger before departing', 409);
  }

  await pool.query("UPDATE bus_trips SET status = 'departed', departed_at = now() WHERE id = $1", [tripId]);
  res.json(tripRow(await fetchTrip(tripId)));
}));

// Marked by the RECEIVING location's role (arrivalRole), not whoever
// created/departed the trip - e.g. an O1 trip is created by a hub volunteer
// but arrives under Central's role, since Central is physically the one
// receiving the bus.
router.post('/trips/:id(\\d+)/arrive', asyncHandler(async (req, res) => {
  const user = await requireAuth(req);
  const tripId = parseInt(req.params.id, 10);
  const trip = await fetchTrip(tripId);
  if (!trip) jsonError('Trip not found', 404);
  const config = legConfig(trip.leg);
  requireArrivalAccess(user, trip, config);

  if (trip.status === 'arrived') {
    jsonError('This trip is already marked arrived', 409);
  }
  if (trip.status !== 'departed') {
    jsonError('This trip must depart before it can be marked arrived', 409);
  }

  await pool.query("UPDATE bus_trips SET status = 'arrived', arrived_at = now() WHERE id = $1", [tripId]);
  res.json(tripRow(await fetchTrip(tripId)));
}));

// Admin-only corrections for a mis-tapped depart/arrive. Reverting arrival
// never orphans anything downstream - boarding the next leg was never
// gated on this trip's arrival to begin with (see the O2 priorLegBoardedAt
// comment above), it's advisory only, so there's nothing to reconcile.
router.post('/trips/:id(\\d+)/undo-depart', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const tripId = parseInt(req.params.id, 10);
  const trip = await fetchTrip(tripId);
  if (!trip) jsonError('Trip not found', 404);

  if (trip.status !== 'departed') {
    jsonError('This trip is not currently departed', 409);
  }

  await pool.query("UPDATE bus_trips SET status = 'boarding', departed_at = NULL WHERE id = $1", [tripId]);
  res.json(tripRow(await fetchTrip(tripId)));
}));

router.post('/trips/:id(\\d+)/undo-arrive', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const tripId = parseInt(req.params.id, 10);
  const trip = await fetchTrip(tripId);
  if (!trip) jsonError('Trip not found', 404);

  if (trip.status !== 'arrived') {
    jsonError('This trip is not currently arrived', 409);
  }

  await pool.query("UPDATE bus_trips SET status = 'departed', arrived_at = NULL WHERE id = $1", [tripId]);
  res.json(tripRow(await fetchTrip(tripId)));
}));

module.exports = router;
