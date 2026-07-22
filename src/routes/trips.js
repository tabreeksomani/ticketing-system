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
// O1's destination is variable (not a single fixed value like the other
// three legs) - a hub can send a bus straight to Central as usual, or
// straight to the venue directly (labeled "VCC" in the hub-facing picker),
// bypassing the O2 relay entirely. `arrivalRole` for O1 is therefore resolved
// per-trip from its own destination (see resolveArrivalRole), not fixed here.
// allowStandbyCreate + standbyHubSource: a scanned code that matches no real
// ticket can be issued as a walk-up standby on the spot (someone lost their
// ticket) - but a standby still needs a home hub (tickets.hub_id is
// NOT NULL), and only some legs have one naturally available from the trip
// itself: O1's origin and R2's destination are always real hubs. O2's
// origin/destination are 'central'/'venue' - neither is a real hub row - so
// standbyHubSource: 'explicit' means the caller must say which hub via
// standbyHubId (that choice matters: it's what lets this rider board the
// right R2 bus home later). R1 has no boarding screen anymore, so it's left
// without standby support.
const LEGS = {
  O1: { originRole: 'volunteer', destination: 'variable', arrivalRole: 'variable', tripCol: 'trip1', allowStandbyCreate: true, standbyHubSource: 'origin' },
  O2: { originRole: 'central', destination: 'venue', arrivalRole: 'venue', tripCol: 'trip2', allowStandbyCreate: true, standbyHubSource: 'explicit' },
  R1: { originRole: 'venue', destination: 'variable', arrivalRole: 'variable', tripCol: 'trip3' },
  R2: { originRole: 'central', destination: 'dynamic-hub', arrivalRole: 'volunteer', tripCol: 'trip4', validateHomeHub: true, allowStandbyCreate: true, standbyHubSource: 'destination' },
};

// O1 and R1 both have a variable destination (an admin can send an empty
// bus straight to a hub instead of the usual Central/VCC) - resolves which
// role must mark a given trip arrived, based on that specific trip's own
// destination rather than a single fixed value for the whole leg.
function resolveArrivalRole(trip, config) {
  if (config.arrivalRole !== 'variable') return config.arrivalRole;
  if (trip.destination === 'venue') return 'venue';
  if (trip.destination === 'central') return 'central';
  return 'volunteer';
}

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
  const arrivalRole = resolveArrivalRole(trip, config);
  if (arrivalRole === 'volunteer') return user.role === 'volunteer' && user.hubIds.includes(trip.destination);
  return user.role === arrivalRole;
}

function requireOriginAccess(user, trip, config) {
  if (!isOriginAuthorized(user, trip, config)) jsonError('Not authorized for this trip', 403);
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
    if (config.arrivalRole === 'variable') {
      // O1 and R1's arrival role depends on each trip's own destination
      // (Central, VCC, or - for an admin-repositioned empty bus - a real
      // hub), not one fixed role for the whole leg. Central/venue callers
      // are scoped to their own fixed destination; a volunteer is scoped to
      // whichever of their own hubs they ask about, same as the dedicated
      // volunteer-arrival branch below.
      if (user.role === 'admin') {
        // no extra scope - admin sees all
      } else if (user.role === 'central' || user.role === 'venue') {
        params.push(user.role === 'central' ? 'central' : 'venue');
        sql += ` AND bt.destination = $${params.length}`;
      } else if (user.role === 'volunteer') {
        const destination = req.query.destination;
        if (!destination || !user.hubIds.includes(destination)) {
          jsonError('destination must be one of your hubs', 403);
        }
        params.push(destination);
        sql += ` AND bt.destination = $${params.length}`;
      } else {
        jsonError('Not authorized for this leg', 403);
      }
    } else if (config.arrivalRole === 'volunteer') {
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
    // Still-inbound buses (status='departed') always show. Recently-arrived
    // ones stay visible too, non-clickable, so whoever just marked one
    // arrived can see it's there (was previously removed from the list the
    // instant it was marked, with no self-service way to double-check) -
    // bounded to a few hours so this doesn't grow unbounded over a
    // multi-day event.
    sql += ` AND (bt.status = 'departed' OR (bt.status = 'arrived' AND bt.arrived_at > now() - interval '4 hours'))`;
    // Once a plate has a newer trip (any leg - e.g. VCC sending an arrived
    // bus straight back to Premium Lounge), the older arrived card here is
    // stale: that bus has already moved on, so it shouldn't keep sitting in
    // this list with a now-meaningless action still available on it.
    sql += ` AND NOT EXISTS (SELECT 1 FROM bus_trips newer WHERE newer.license_plate = bt.license_plate AND newer.id > bt.id)`;
  }

  // Departures (side=origin): newest trip first, so whichever trip is
  // actively boarding is the one nearest the top, not buried under the
  // day's earlier trips. Arrivals: still-inbound buses oldest-first (FIFO,
  // whichever departed earliest should arrive next), with already-arrived
  // ones pushed to the bottom regardless of age.
  sql += side === 'origin'
    ? ' ORDER BY bt.id DESC'
    : ` ORDER BY (bt.status = 'arrived')::int ASC, bt.id ASC`;
  const { rows } = await pool.query(sql, params);
  res.json(rows.map(tripRow));
}));

// Per hub, tickets that have arrived at Central via R1 but not yet boarded
// R2 - the live "waiting to go home" queue that drives Central's R2
// destination picker (and is reused by the admin Shuttle dashboard).
// Just the hub list for Central's R2 destination picker - this used to also
// return a live "waiting at Central" count per hub (arrived via R1, not yet
// on R2), but that's no longer computable now that R1 has no boarding
// screen: nobody ever gets a trip3_id again, so the count would always read
// zero for every hub - worse than not showing one at all. Dispatch is
// entirely admin's real-world call now, relayed to Central verbally.
router.get('/trips/hub-headcounts', asyncHandler(async (req, res) => {
  await requireRole(req, ['central', 'admin']);
  const { rows } = await pool.query('SELECT id AS hub_id, name AS hub_name FROM hubs ORDER BY name ASC');
  res.json(rows.map((r) => ({ hubId: r.hub_id, hubName: r.hub_name })));
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
    // Opened/closed are both guards around trip creation (see
    // src/routes/hubs.js): must be opened first, and not yet closed.
    const { rows: hubRows } = await pool.query('SELECT opened_at, closed_at FROM hubs WHERE id = $1', [origin]);
    if (hubRows[0] && hubRows[0].closed_at) {
      jsonError('This hub is closed - no new trips can be created here', 409);
    }
    if (!hubRows[0] || !hubRows[0].opened_at) {
      jsonError('This hub has not been opened yet - open it before creating a trip', 409);
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
  } else if (config.destination === 'variable') {
    destination = String(req.body.destination || 'central').trim();
    if (!['central', 'venue'].includes(destination)) {
      // Not one of the two fixed locations - only other valid option is a
      // real hub (an admin repositioning an empty bus straight to a hub,
      // bypassing Central/VCC entirely).
      const { rows: hubRows } = await pool.query('SELECT id FROM hubs WHERE id = $1', [destination]);
      if (!hubRows.length) jsonError('destination must be central, venue, or a valid hub', 400);
    }
  } else {
    destination = config.destination;
  }

  // An empty bus being repositioned (admin's Move Bus, or VCC sending an
  // arrived bus straight back to Premium Lounge) has no riders to board -
  // go straight to "en route" instead of sitting in the scheduled/boarding
  // queue waiting for a passenger that will never come. Only admin or this
  // leg's own legitimate operator can skip boarding this way.
  const startDeparted = (user.role === 'admin' || user.role === config.originRole) && req.body.immediate === true;

  let rows;
  try {
    ({ rows } = await pool.query(
      `INSERT INTO bus_trips (license_plate, origin, destination, leg, status, created_by, departed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [licensePlate, origin, destination, leg, startDeparted ? 'departed' : 'scheduled', user.id, startDeparted ? new Date() : null]
    ));
  } catch (e) {
    // Unique violation on bus_trips_active_plate (migrations/003) - this
    // exact bus is already scheduled/boarding somewhere else right now.
    if (e.code === '23505') {
      jsonError(`Bus ${licensePlate} already has an active trip in progress - depart or complete that one first`, 409);
    }
    throw e;
  }
  res.status(201).json(tripRow({ ...rows[0], onboard: 0 }));
}));

// Single-trip refetch for the boarding screen's live-poll (see checkin.html)
// - lets a device pick up onboard-count changes made by someone else
// scanning the same trip from a different device, without a full trip-list
// reload. Same origin-access rule as board/depart.
router.get('/trips/:id(\\d+)', asyncHandler(async (req, res) => {
  const user = await requireAuth(req);
  const tripId = parseInt(req.params.id, 10);
  const trip = await fetchTrip(tripId);
  if (!trip) jsonError('Trip not found', 404);
  const config = legConfig(trip.leg);
  requireOriginAccess(user, trip, config);
  res.json(tripRow(trip));
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

  // Virtual ticket: nobody has any code at all to scan or type (not even a
  // lost physical ticket) - generate one from a dedicated sequence instead,
  // starting at 9000 so it's obviously out of range of real event codes and
  // never collides with one.
  const isVirtual = req.body.virtual === true;
  if (isVirtual && !config.allowStandbyCreate) {
    jsonError('Virtual tickets are not supported on this leg', 400);
  }

  let code;
  if (isVirtual) {
    const { rows: seqRows } = await pool.query("SELECT nextval('virtual_ticket_code_seq') AS n");
    code = String(seqRows[0].n);
  } else {
    code = normalizeCode(req.body.code);
    if (code === '') jsonError('code is required', 400);
  }

  const { rows } = await pool.query(
    `SELECT t.*, h.name AS hub_name FROM tickets t JOIN hubs h ON h.id = t.hub_id WHERE t.code = $1`,
    [code]
  );
  let ticket = rows[0];

  if (isVirtual && ticket) {
    // Should be practically impossible (the sequence's range is reserved),
    // but never silently board someone else's real ticket over this.
    jsonError('Virtual ticket code collision - try again', 409);
  }

  let isNewStandby = false;
  if (!ticket) {
    if (!config.allowStandbyCreate) {
      jsonError('Unknown ticket code', 404);
    }

    let standbyHubId;
    if (config.standbyHubSource === 'origin') {
      standbyHubId = trip.origin;
    } else if (config.standbyHubSource === 'destination') {
      standbyHubId = trip.destination;
    } else {
      // 'explicit': this leg's own origin/destination aren't real hubs, so
      // there's nothing to infer a home hub from - the volunteer has to say
      // which one, since it determines which R2 bus this rider can board
      // later. Signaled with a distinct message so the frontend can catch it
      // specifically and prompt for a hub instead of just erroring out.
      standbyHubId = String(req.body.standbyHubId || '').trim();
      if (!standbyHubId) {
        jsonError('NEED_STANDBY_HUB: choose the rider\'s home hub to issue a walk-up standby ticket', 409);
      }
      const { rows: hubRows } = await pool.query('SELECT id FROM hubs WHERE id = $1', [standbyHubId]);
      if (!hubRows.length) jsonError('Unknown hub', 404);
    }

    // Forgotten-ticket workflow: treat as a walk-up standby, boarded in the
    // same step.
    await pool.query('INSERT INTO tickets (code, hub_id, timeslot_id, is_standby) VALUES ($1, $2, NULL, TRUE)', [code, standbyHubId]);
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
  // Exception: if their current bus for this leg hasn't departed yet, this
  // scan is treated as a bus switch rather than a duplicate - clears the old
  // trip's boarding and boards them here instead (nothing extra to update on
  // the old trip's row itself; its onboard count is a live COUNT(*), so it
  // drops automatically once this ticket's id column points elsewhere).
  // Once their current bus has already departed, that's no longer safe to
  // silently reverse - that needs a real Undo Scan or admin correction.
  let switchedFromTripId = null;
  if (ticket[idCol] !== null) {
    if (ticket[idCol] === tripId) {
      jsonError('This ticket has already been scanned onto this trip', 409);
    }
    const currentTrip = await fetchTrip(ticket[idCol]);
    if (!currentTrip) {
      jsonError('This ticket has already been scanned for this leg and cannot be scanned again', 409);
    }
    if (currentTrip.status === 'departed' || currentTrip.status === 'arrived') {
      jsonError('This ticket has already departed on a different bus and cannot be scanned again', 409);
    }
    switchedFromTripId = currentTrip.id;
  }

  // R2 only: the ticket's home hub doesn't match this bus's destination -
  // warn, don't silently block. `force` lets the volunteer board them anyway
  // after seeing the warning (e.g. a family splitting up, or the ticket's
  // home hub is just wrong in the system) - the first scan always requires
  // confirmation; only a resubmit with force=true actually boards them.
  if (config.validateHomeHub && ticket.hub_id !== trip.destination && req.body.force !== true) {
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
  if (isVirtual) result.virtualCode = code;
  if (switchedFromTripId) result.switchedFromTrip = switchedFromTripId;
  // O2 passive display only (§8.1): shows when this rider arrived at Central
  // via O1, so a volunteer can visually catch someone boarding out of order.
  // Purely informational - never blocks the scan.
  if (trip.leg === 'O2') {
    result.priorLegBoardedAt = ticket.trip1_boarded_at;
  }
  // O1 only, non-blocking: bus_trips has no link to a timeslot at all (a
  // trip is just whatever bus a volunteer creates whenever they're ready),
  // so this can't check "wrong bus for this timeslot" - instead it flags
  // when a ticket's own assigned timeslot is well outside of wall-clock
  // "now" (more than 30 min early or late), for the volunteer to use their
  // own judgment on. Skipped entirely for standby tickets (no timeslot).
  if (trip.leg === 'O1' && ticket.timeslot_id) {
    const { rows: slotRows } = await pool.query(
      `SELECT departure_time,
              EXTRACT(EPOCH FROM (now() - (regexp_replace(departure_time, '\\s+[A-Za-z_/]+$', '')::timestamp AT TIME ZONE 'America/Los_Angeles'))) / 60 AS minutes_late
       FROM timeslots WHERE id = $1`,
      [ticket.timeslot_id]
    );
    const slot = slotRows[0];
    if (slot && Math.abs(slot.minutes_late) > 30) {
      result.timeslotWarning = { departureTime: slot.departure_time, minutesLate: Math.round(slot.minutes_late) };
    }
  }
  res.json(result);
}));

// Reverses a single ticket's boarding on this one leg (clears trip{n}_id/
// trip{n}_boarded_at) - for a mis-scan the volunteer wants to immediately
// take back, e.g. after seeing the timeslot or wrong-hub warning. Doesn't
// delete the ticket itself, so a walk-up standby created by mistake on the
// wrong trip can just be rescanned onto the correct one afterward. Only
// undoes this leg's own column - has no effect on any other leg.
router.post('/trips/:id(\\d+)/unboard', asyncHandler(async (req, res) => {
  const user = await requireAuth(req);
  const tripId = parseInt(req.params.id, 10);
  const trip = await fetchTrip(tripId);
  if (!trip) jsonError('Trip not found', 404);
  const config = legConfig(trip.leg);
  requireOriginAccess(user, trip, config);

  if (trip.status === 'arrived') {
    jsonError('This trip has already arrived - nothing to undo', 409);
  }

  const code = normalizeCode(req.body.code);
  if (code === '') jsonError('code is required', 400);

  const { rows } = await pool.query('SELECT * FROM tickets WHERE code = $1', [code]);
  const ticket = rows[0];
  if (!ticket) jsonError('Unknown ticket code', 404);

  const idCol = `${config.tripCol}_id`;
  const atCol = `${config.tripCol}_boarded_at`;
  if (ticket[idCol] !== tripId) {
    jsonError('This ticket is not boarded on this trip', 409);
  }

  await pool.query(`UPDATE tickets SET ${idCol} = NULL, ${atCol} = NULL WHERE id = $1`, [ticket.id]);
  res.json(tripRow(await fetchTrip(tripId)));
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
  if (!isArrivalAuthorized(user, trip, config)) jsonError('Not authorized for this trip', 403);

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

// Fixes a genuine mistake (wrong license plate typo, wrong leg/hub picked,
// duplicate "New Trip" tap) - not admin-only, since whoever's authorized to
// create/board this trip in the first place is the one who'd make and
// notice this kind of mistake, and waiting on admin for a typo isn't
// operationally realistic in the field. Self-service is limited to
// onboard === 0 though (nobody's boarded yet); deleting a trip that already
// has real riders on it is an admin-only escalation (see below), since
// that's a bigger call than fixing your own mistake. Either way, only valid
// before the trip departs - once it's left, this has to go through a real
// depart/arrive/undo flow instead, not a delete.
router.delete('/trips/:id(\\d+)', asyncHandler(async (req, res) => {
  const user = await requireAuth(req);
  const tripId = parseInt(req.params.id, 10);
  const trip = await fetchTrip(tripId);
  if (!trip) jsonError('Trip not found', 404);
  const config = legConfig(trip.leg);
  requireOriginAccess(user, trip, config);

  if (trip.status === 'departed' || trip.status === 'arrived') {
    jsonError('Cannot delete a trip that has already departed', 409);
  }

  if (trip.onboard > 0) {
    // Self-service (Hub/Central) still can't delete a trip with real riders
    // on it - that's reserved for admin, since it's a bigger call than
    // fixing your own typo. Admin force-deleting un-boards everyone first
    // (clears trip{n}_id/trip{n}_boarded_at) so they're free to be rescanned
    // onto a different bus, rather than the trip row just vanishing out
    // from under them.
    if (user.role !== 'admin') {
      jsonError('Cannot delete a trip that already has riders boarded', 409);
    }
    const idCol = `${config.tripCol}_id`;
    const atCol = `${config.tripCol}_boarded_at`;
    await pool.query(`UPDATE tickets SET ${idCol} = NULL, ${atCol} = NULL WHERE ${idCol} = $1`, [tripId]);
  }

  await pool.query('DELETE FROM bus_trips WHERE id = $1', [tripId]);
  res.status(204).end();
}));

// Corrects a mis-typed plate even after boarding's started - unlike
// destination, the plate is just a label with nothing downstream keyed off
// its value (no ticket routing, no standby hub attribution depends on it,
// only the active-plate uniqueness check does) - so there's no reason to
// force a delete-and-lose-the-boarded-riders response to "we typed the
// wrong plate," which is exactly the scenario that matters: a volunteer
// already mid-scan who only now notices the plate's wrong. Allowed any time
// before the bus actually leaves (not after 'departed'/'arrived' - by then
// correcting it serves no purpose).
router.post('/trips/:id(\\d+)/license-plate', asyncHandler(async (req, res) => {
  const user = await requireAuth(req);
  const tripId = parseInt(req.params.id, 10);
  const trip = await fetchTrip(tripId);
  if (!trip) jsonError('Trip not found', 404);
  const config = legConfig(trip.leg);
  requireOriginAccess(user, trip, config);

  if (trip.status !== 'scheduled' && trip.status !== 'boarding') {
    jsonError('Cannot change the license plate after this trip has departed', 409);
  }

  const licensePlate = String(req.body.licensePlate || '').trim();
  if (licensePlate === '') jsonError('licensePlate is required', 400);

  try {
    await pool.query('UPDATE bus_trips SET license_plate = $1 WHERE id = $2', [licensePlate, tripId]);
  } catch (e) {
    if (e.code === '23505') {
      jsonError(`Bus ${licensePlate} already has an active trip in progress - depart or complete that one first`, 409);
    }
    throw e;
  }
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

// Admin-only: fix a mis-picked destination any time before the trip
// arrives. Only O1 and R2 have a destination worth changing - O1 because
// it's genuinely variable (Central vs VCC), R2 because it's picked by hand
// from the hub list and a volunteer can fat-finger the wrong one. O2/R1
// have a single fixed destination for the whole leg, so there's nothing to
// change. Allowed through 'departed' (not just 'scheduled') - a rider
// already boarded keeps whatever hub_id/arrival-role was resolved at their
// own board time, so correcting the trip's destination afterward doesn't
// silently mis-route anyone already on it; it only changes how *new* boards
// and the eventual arrival are handled, which is exactly the point of
// fixing a mislabeled bus. Once it's 'arrived', there's nothing left to fix.
router.post('/trips/:id(\\d+)/destination', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const tripId = parseInt(req.params.id, 10);
  const trip = await fetchTrip(tripId);
  if (!trip) jsonError('Trip not found', 404);

  if (trip.leg !== 'O1' && trip.leg !== 'R2') {
    jsonError('Destination can only be changed for O1 or R2 trips', 400);
  }
  if (trip.status === 'arrived') {
    jsonError('Destination can only be changed before the trip has arrived', 409);
  }

  const destination = String(req.body.destination || '').trim();
  if (trip.leg === 'O1') {
    if (!['central', 'venue'].includes(destination)) {
      jsonError("destination must be 'central' or 'venue'", 400);
    }
  } else {
    const { rows: hubRows } = await pool.query('SELECT id FROM hubs WHERE id = $1', [destination]);
    if (!hubRows.length) jsonError('Unknown hub', 404);
  }

  await pool.query('UPDATE bus_trips SET destination = $1 WHERE id = $2', [destination, tripId]);
  res.json(tripRow(await fetchTrip(tripId)));
}));

module.exports = router;
