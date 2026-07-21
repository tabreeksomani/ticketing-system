const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../auth');
const { asyncHandler } = require('../errors');

const router = express.Router();

router.get('/dashboard/sales', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const { rows: hubs } = await pool.query('SELECT * FROM hubs ORDER BY name ASC');
  const out = [];
  for (const hub of hubs) {
    // "Returned" means boarded an R2 bus (trip4_id set), not "R2 marked
    // arrived" - nobody marks R2 arrived anymore (mirrors R1, which was
    // dropped entirely), so bus_trips.arrived_at for R2 would always be
    // NULL and this would permanently read zero otherwise. Boarding the R2
    // bus at Central is the last real signal this system has.
    const { rows: slotRows } = await pool.query(
      `SELECT t.*,
              (SELECT COUNT(*) FROM tickets tk WHERE tk.timeslot_id = t.id)::int AS sold,
              (SELECT COUNT(*) FROM tickets tk WHERE tk.timeslot_id = t.id AND tk.trip1_id IS NOT NULL)::int AS boarded,
              (SELECT COUNT(*) FROM tickets tk WHERE tk.timeslot_id = t.id AND tk.trip4_id IS NOT NULL)::int AS returned,
              (SELECT COUNT(*) FROM tickets tk WHERE tk.timeslot_id = t.id AND tk.fare_type = 'adult')::int AS adult,
              (SELECT COUNT(*) FROM tickets tk WHERE tk.timeslot_id = t.id AND tk.fare_type = 'child')::int AS child
       FROM timeslots t WHERE t.hub_id = $1 ORDER BY t.departure_time ASC`,
      [hub.id]
    );
    const slots = slotRows.map((row) => {
      const sold = row.sold;
      const boarded = row.boarded;
      return {
        id: row.id,
        departureTime: row.departure_time,
        capacity: row.capacity,
        sold,
        available: row.capacity - sold,
        boarded,
        noShow: sold - boarded,
        returned: row.returned,
        adult: row.adult,
        child: row.child,
      };
    });

    const { rows: standbyRows } = await pool.query(
      `SELECT COUNT(*)::int AS issued,
              COUNT(*) FILTER (WHERE tk.trip1_id IS NOT NULL)::int AS boarded,
              COUNT(*) FILTER (WHERE tk.fare_type = 'adult')::int AS adult,
              COUNT(*) FILTER (WHERE tk.fare_type = 'child')::int AS child,
              COUNT(*) FILTER (WHERE tk.trip4_id IS NOT NULL)::int AS returned
       FROM tickets tk WHERE tk.hub_id = $1 AND tk.is_standby = TRUE`,
      [hub.id]
    );
    const standby = standbyRows[0];

    out.push({
      hubId: hub.id,
      hubName: hub.name,
      travelMinutes: hub.travel_minutes,
      timeslots: slots,
      totalSold: slots.reduce((s, x) => s + x.sold, 0),
      totalCapacity: slots.reduce((s, x) => s + x.capacity, 0),
      totalBoarded: slots.reduce((s, x) => s + x.boarded, 0),
      totalNoShow: slots.reduce((s, x) => s + x.noShow, 0),
      totalReturned: slots.reduce((s, x) => s + x.returned, 0),
      totalAdult: slots.reduce((s, x) => s + x.adult, 0) + standby.adult,
      totalChild: slots.reduce((s, x) => s + x.child, 0) + standby.child,
      standbyIssued: standby.issued,
      standbyBoarded: standby.boarded,
      standbyReturned: standby.returned,
      standbyAdult: standby.adult,
      standbyChild: standby.child,
    });
  }
  res.json(out);
}));

// Daily ticket sales per hub, bucketed by Pacific-time calendar day (not
// UTC day - sold_at is a real timestamp, but the event runs on Pacific wall-
// clock days, same as departure_time elsewhere in this app). One row per
// (hub, day); the frontend pivots this into a bar per day, summed across
// whichever hubs are selected in its multiselect.
router.get('/dashboard/daily-sales', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const { rows } = await pool.query(
    `SELECT h.id AS hub_id, h.name AS hub_name,
            (t.sold_at AT TIME ZONE 'America/Los_Angeles')::date AS day,
            COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE t.fare_type = 'adult')::int AS adult_count,
            COUNT(*) FILTER (WHERE t.fare_type = 'child')::int AS child_count
     FROM tickets t JOIN hubs h ON t.hub_id = h.id
     GROUP BY h.id, h.name, day
     ORDER BY day ASC`
  );
  res.json(rows.map((r) => ({
    hubId: r.hub_id, hubName: r.hub_name,
    day: r.day.toISOString().slice(0, 10),
    count: r.count,
    adultCount: r.adult_count,
    childCount: r.child_count,
  })));
}));

// The outbound half of the journey (O1 hub->central, O2 central->venue) as
// one 5-stage funnel, plus every O1/O2 trip for the mini trip-card list.
//
// `departedHubTotal` is deliberately cumulative (everyone who has EVER left
// their hub, whether or not they've since arrived at Venue) - a running
// total that only goes up, showing total throughput. The other four are
// live snapshots of exactly one stage of the pipeline right now, and
// partition all sold tickets into mutually exclusive buckets:
//   enRouteToCentral -> atCentral -> enRouteToVenue -> arrivedAtVenue
// (plus whoever hasn't departed their hub yet, not shown here since this
// is the Ingress view, not a full "everyone" count).
router.get('/dashboard/ingress', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);

  // A hub's O1 trip can go straight to Central (the usual path) or straight
  // to the venue/VCC directly, bypassing O2 entirely. Direct-to-venue trips
  // are excluded from the en-route/at-Central buckets (they were never
  // headed there) and folded into en-route/arrived-at-venue instead, so they
  // don't get permanently stuck showing as "At Central" (they'll never get a
  // trip2_id, since they skip O2 altogether).
  const { rows: statRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE bt1.departed_at IS NOT NULL)::int AS departed_hub_total,
       COUNT(*) FILTER (WHERE bt1.destination = 'central' AND bt1.departed_at IS NOT NULL AND bt1.arrived_at IS NULL)::int AS en_route_to_central,
       COUNT(*) FILTER (WHERE bt1.destination = 'central' AND bt1.arrived_at IS NOT NULL AND t.trip2_id IS NULL)::int AS at_central,
       COUNT(*) FILTER (WHERE
            (bt2.departed_at IS NOT NULL AND bt2.arrived_at IS NULL)
         OR (bt1.destination = 'venue' AND bt1.departed_at IS NOT NULL AND bt1.arrived_at IS NULL)
       )::int AS en_route_to_venue,
       COUNT(*) FILTER (WHERE bt2.arrived_at IS NOT NULL OR (bt1.destination = 'venue' AND bt1.arrived_at IS NOT NULL))::int AS arrived_at_venue,
       AVG(EXTRACT(EPOCH FROM (t.trip2_boarded_at - bt1.arrived_at)) / 60)
         FILTER (WHERE bt1.destination = 'central' AND bt1.arrived_at IS NOT NULL AND t.trip2_boarded_at IS NOT NULL) AS avg_wait_at_central_minutes
     FROM tickets t
     LEFT JOIN bus_trips bt1 ON t.trip1_id = bt1.id
     LEFT JOIN bus_trips bt2 ON t.trip2_id = bt2.id`
  );

  // Cumulative departed-hub total, broken down by hub - same "ever left,
  // regardless of what's happened since" definition as the aggregate above.
  // sold_total is every ticket issued for that hub (including standby),
  // regardless of whether it's boarded anything yet - so admin can subtract
  // to see how many are still at the hub, not yet departed.
  const { rows: hubRows } = await pool.query(
    `SELECT h.id AS hub_id, h.name AS hub_name,
            COUNT(*)::int AS sold_total,
            COUNT(*) FILTER (WHERE bt1.departed_at IS NOT NULL)::int AS departed_total
     FROM tickets t
     JOIN hubs h ON h.id = t.hub_id
     LEFT JOIN bus_trips bt1 ON t.trip1_id = bt1.id
     GROUP BY h.id, h.name
     ORDER BY h.name ASC`
  );

  // Every O1 (hub->central) and O2 (central->venue) trip, for the mini
  // trip-card list - all statuses, not just en-route, so a trip that
  // hasn't departed yet or has already arrived both still show up.
  const { rows: tripRows } = await pool.query(
    `SELECT bt.*,
            (CASE bt.leg
               WHEN 'O1' THEN (SELECT COUNT(*) FROM tickets tk WHERE tk.trip1_id = bt.id)
               WHEN 'O2' THEN (SELECT COUNT(*) FROM tickets tk WHERE tk.trip2_id = bt.id)
             END)::int AS onboard
     FROM bus_trips bt
     WHERE bt.leg IN ('O1', 'O2')
     ORDER BY bt.created_at DESC`
  );

  const s = statRows[0];
  res.json({
    departedHubTotal: s.departed_hub_total,
    enRouteToCentral: s.en_route_to_central,
    atCentral: s.at_central,
    enRouteToVenue: s.en_route_to_venue,
    arrivedAtVenue: s.arrived_at_venue,
    avgWaitAtCentralMinutes: s.avg_wait_at_central_minutes !== null ? Math.round(s.avg_wait_at_central_minutes) : null,
    hubs: hubRows.map((r) => ({ hubId: r.hub_id, hubName: r.hub_name, soldTotal: r.sold_total, departedTotal: r.departed_total })),
    trips: tripRows.map((r) => ({
      tripId: r.id, leg: r.leg, licensePlate: r.license_plate,
      origin: r.origin, destination: r.destination, status: r.status,
      onboard: r.onboard, departedAt: r.departed_at, arrivedAt: r.arrived_at,
    })),
  });
}));

// R1 (venue->central) no longer has a boarding screen (Venue's role dropped
// it entirely - see checkin.html), so no ticket can ever get a trip3_id
// again. That means any "waiting at Central" / "en route from Venue" style
// metric can never be anything but permanently zero - not a real snapshot,
// just dead data. R2 (central->hub) is unaffected by that (its own
// boarding/departing/arriving doesn't depend on trip3_id at all), so this is
// deliberately just a simple cumulative count of who's boarded an R2 bus,
// grouped by destination hub - the one number that's still meaningful.
router.get('/dashboard/egress', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);

  // LEFT JOIN from hubs (not tickets) so every hub appears even at zero.
  // departedTotal (how many ever left this hub via O1) is included here too
  // so it can sit right next to "returned," for a direct at-a-glance
  // comparison without switching to the Departing tab.
  const { rows: hubRows } = await pool.query(
    `SELECT h.id AS hub_id, h.name AS hub_name,
            COUNT(t.id) FILTER (WHERE bt4.id IS NOT NULL)::int AS count,
            COUNT(t.id) FILTER (WHERE bt1.departed_at IS NOT NULL)::int AS departed_total
     FROM hubs h
     LEFT JOIN tickets t ON t.hub_id = h.id
     LEFT JOIN bus_trips bt4 ON t.trip4_id = bt4.id
     LEFT JOIN bus_trips bt1 ON t.trip1_id = bt1.id
     GROUP BY h.id, h.name
     ORDER BY h.name ASC`
  );

  // Every R2 (central->hub) trip, for the mini trip-card list.
  const { rows: tripRows } = await pool.query(
    `SELECT bt.*, (SELECT COUNT(*) FROM tickets tk WHERE tk.trip4_id = bt.id)::int AS onboard
     FROM bus_trips bt
     WHERE bt.leg = 'R2'
     ORDER BY bt.created_at DESC`
  );

  res.json({
    total: hubRows.reduce((s, r) => s + r.count, 0),
    perHub: hubRows.map((r) => ({ hubId: r.hub_id, hubName: r.hub_name, count: r.count, departedTotal: r.departed_total })),
    trips: tripRows.map((r) => ({
      tripId: r.id, leg: r.leg, licensePlate: r.license_plate,
      origin: r.origin, destination: r.destination, status: r.status,
      onboard: r.onboard, departedAt: r.departed_at, arrivedAt: r.arrived_at,
    })),
  });
}));

// Per-trip breakdown of who's onboard, by home hub / timeslot / standby -
// works for any of the 4 legs (not just O1/O2) since it resolves the right
// tickets.trip{n}_id column from the trip's own leg, so this can be reused
// once Egress trip cards want the same drill-down.
router.get('/dashboard/trip/:id/breakdown', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const tripId = parseInt(req.params.id, 10);
  const { rows: tripRows } = await pool.query('SELECT * FROM bus_trips WHERE id = $1', [tripId]);
  const trip = tripRows[0];
  if (!trip) {
    res.status(404).json({ error: 'Trip not found' });
    return;
  }
  const tripCol = { O1: 'trip1_id', O2: 'trip2_id', R1: 'trip3_id', R2: 'trip4_id' }[trip.leg];
  const { rows } = await pool.query(
    `SELECT h.name AS hub_name, ts.departure_time, t.is_standby,
            COUNT(*)::int AS count
     FROM tickets t
     JOIN hubs h ON h.id = t.hub_id
     LEFT JOIN timeslots ts ON t.timeslot_id = ts.id
     WHERE t.${tripCol} = $1
     GROUP BY h.name, ts.departure_time, t.is_standby
     ORDER BY h.name ASC, ts.departure_time ASC`,
    [tripId]
  );
  res.json(rows.map((r) => ({
    hubName: r.hub_name, departureTime: r.departure_time,
    isStandby: r.is_standby, count: r.count,
  })));
}));

// Live onboard count for any leg, from tickets' own trip{n}_id columns -
// same pattern used throughout trips.js/dashboard.js, repeated here since
// this endpoint (unlike the others) spans all four legs at once.
const TRANSPORT_ONBOARD_CASE = `(CASE bt.leg
  WHEN 'O1' THEN (SELECT COUNT(*) FROM tickets tk WHERE tk.trip1_id = bt.id)
  WHEN 'O2' THEN (SELECT COUNT(*) FROM tickets tk WHERE tk.trip2_id = bt.id)
  WHEN 'R1' THEN (SELECT COUNT(*) FROM tickets tk WHERE tk.trip3_id = bt.id)
  WHEN 'R2' THEN (SELECT COUNT(*) FROM tickets tk WHERE tk.trip4_id = bt.id)
END)::int`;

// Purely inferred from leg/status/destination - there's no real location
// tracking anywhere in this system. R2 deliberately has no "arrived" state:
// nobody at a hub confirms a returning bus made it home (removed earlier),
// so the most specific thing this can ever say for a departed R2 trip is
// "en route to {hub}," never "arrived."
function transportLocationLabel(row, hubNameById) {
  const destName = row.destination === 'central' ? 'Premium Lounge'
    : row.destination === 'venue' ? 'VCC'
    : (hubNameById[row.destination] || row.destination);
  if (row.status === 'scheduled' || row.status === 'boarding') {
    const originName = row.origin === 'central' ? 'Premium Lounge'
      : row.origin === 'venue' ? 'VCC'
      : (hubNameById[row.origin] || row.origin);
    return `Waiting at ${originName}`;
  }
  if (row.status === 'departed') return `En route to ${destName}`;
  if (row.status === 'arrived') return `At ${destName}`;
  return 'Unknown';
}

router.get('/dashboard/transport', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);

  const { rows: hubRows } = await pool.query('SELECT id, name, opened_at, closed_at FROM hubs ORDER BY name ASC');
  const hubNameById = {};
  hubRows.forEach((h) => { hubNameById[h.id] = h.name; });

  const { rows: activeRows } = await pool.query(
    `SELECT bt.*, ${TRANSPORT_ONBOARD_CASE} AS onboard
     FROM bus_trips bt
     WHERE bt.status != 'arrived'
     ORDER BY bt.created_at DESC`
  );

  const plateCounts = {};
  activeRows.forEach((r) => { plateCounts[r.license_plate] = (plateCounts[r.license_plate] || 0) + 1; });

  const active = activeRows.map((r) => ({
    tripId: r.id,
    leg: r.leg,
    licensePlate: r.license_plate,
    origin: r.origin,
    destination: r.destination,
    status: r.status,
    onboard: r.onboard,
    createdAt: r.created_at,
    boardingStartedAt: r.boarding_started_at,
    departedAt: r.departed_at,
    locationLabel: transportLocationLabel(r, hubNameById),
    samePlateActive: plateCounts[r.license_plate] > 1,
  }));

  // History: every trip that's actually finished one way or another
  // (departed or arrived) - 'scheduled'/'boarding' trips aren't "completed"
  // yet, they're in the active list above. Deliberately unconditioned (no
  // leg/hub/date filtering server-side) - the History tab's own filters are
  // applied client-side instead, since this same array also feeds the Live
  // tab's "arrived" buckets and the By-Plate tab's per-plate current state.
  // Filtering it server-side per-request used to mean picking a filter on
  // the History tab could silently change what Live/By-Plate showed too.
  const { rows: historyRows } = await pool.query(
    `SELECT bt.*, ${TRANSPORT_ONBOARD_CASE} AS onboard
     FROM bus_trips bt
     WHERE bt.status IN ('departed', 'arrived')
     ORDER BY bt.created_at DESC`
  );

  const history = historyRows.map((r) => ({
    tripId: r.id,
    leg: r.leg,
    licensePlate: r.license_plate,
    origin: r.origin,
    destination: r.destination,
    status: r.status,
    onboard: r.onboard,
    createdAt: r.created_at,
    boardingStartedAt: r.boarding_started_at,
    departedAt: r.departed_at,
    arrivedAt: r.arrived_at,
  }));

  // Deliberately its own unconditioned query, ignoring the leg/hubId/date
  // filters above entirely - those only scope the `history` array for the
  // history table. completedToday/tripSummary need to stay "today,
  // everything" regardless of whatever the admin's currently filtering the
  // history table to, otherwise applying a leg filter would make the
  // trip-summary and completed-today numbers silently (and wrongly) drop
  // to just that leg's count.
  const { rows: todayRows } = await pool.query(
    `SELECT bt.leg, COUNT(*)::int AS trip_count, AVG(${TRANSPORT_ONBOARD_CASE})::float AS avg_onboard
     FROM bus_trips bt
     WHERE bt.status IN ('departed', 'arrived')
       AND (bt.created_at AT TIME ZONE 'America/Los_Angeles')::date = (now() AT TIME ZONE 'America/Los_Angeles')::date
     GROUP BY bt.leg`
  );
  const tripSummary = { O1: { tripCount: 0, avgOnboard: 0 }, O2: { tripCount: 0, avgOnboard: 0 }, R2: { tripCount: 0, avgOnboard: 0 } };
  todayRows.forEach((r) => {
    if (tripSummary[r.leg]) {
      tripSummary[r.leg] = { tripCount: r.trip_count, avgOnboard: Math.round((r.avg_onboard || 0) * 10) / 10 };
    }
  });
  const completedToday = todayRows.reduce((s, r) => s + r.trip_count, 0);

  res.json({
    summary: {
      totalActive: active.length,
      boarding: active.filter((a) => a.status === 'boarding' || a.status === 'scheduled').length,
      departed: active.filter((a) => a.status === 'departed').length,
      totalOnboard: active.reduce((s, a) => s + a.onboard, 0),
      completedToday,
    },
    hubs: hubRows.map((h) => ({ id: h.id, name: h.name, openedAt: h.opened_at, closedAt: h.closed_at })),
    tripSummary,
    active,
    history,
  });
}));

module.exports = router;
