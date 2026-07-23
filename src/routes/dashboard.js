const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../auth');
const { asyncHandler } = require('../errors');

const router = express.Router();

router.get('/dashboard/sales', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  // Demo hub is for exercising the scan flow on shared devices, not a real
  // sales channel - excluded from Sales/Report so its test tickets don't
  // skew the real per-hub numbers admin is reading off of here.
  const { rows: hubs } = await pool.query("SELECT * FROM hubs WHERE id != 'demo' ORDER BY name ASC");
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
      timeToPl: hub.time_to_pl,
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
     WHERE h.id != 'demo'
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

// Human-readable place name for a trip origin/destination id - same mapping
// used by transportLocationLabel above, factored out so the activity feed
// below can reuse it without dragging in that whole function's status logic.
function placeLabel(id, hubNameById) {
  if (id === 'central') return 'Premium Lounge';
  if (id === 'venue') return 'VCC';
  return hubNameById[id] || id;
}

// One combined feed for the TV/kiosk Ops dashboard - the "Buses by location"
// table, the rider-lifecycle funnel (same definition as /dashboard/ingress,
// just relabeled Lounge/VCC to match this screen's language), the top stat
// row, and a synthesized activity log. No new event-log table: activity is
// reconstructed from timestamps that already exist (bus_trips
// departed_at/arrived_at, hubs opened_at/closed_at, incidents created_at) -
// good enough for "what just happened," not a substitute for a real log if
// this ever needs custom per-event messages.
router.get('/dashboard/ops', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);

  // Demo hub excluded, same reasoning as /dashboard/sales - this is a
  // public-facing screen, not somewhere test scans from a shared device
  // should show up as real hub activity.
  const { rows: hubRows } = await pool.query("SELECT id, name, opened_at, closed_at, time_to_pl, time_to_vcc FROM hubs WHERE id != 'demo' ORDER BY name ASC");
  const hubNameById = {};
  const hubTimeToPlById = {};
  const hubTimeToVccById = {};
  hubRows.forEach((h) => {
    hubNameById[h.id] = h.name;
    hubTimeToPlById[h.id] = h.time_to_pl;
    hubTimeToVccById[h.id] = h.time_to_vcc;
  });

  // Idle/Boarding/En route counts + last departure, per hub-as-origin.
  const { rows: hubBusRows } = await pool.query(
    `SELECT h.id,
            COUNT(bt.id) FILTER (WHERE bt.status = 'scheduled')::int AS idle,
            COUNT(bt.id) FILTER (WHERE bt.status = 'boarding')::int AS boarding,
            COUNT(bt.id) FILTER (WHERE bt.status = 'departed')::int AS en_route,
            MAX(bt.departed_at) AS last_departure
     FROM hubs h
     LEFT JOIN bus_trips bt ON bt.origin = h.id
     GROUP BY h.id`
  );
  const hubBusById = {};
  hubBusRows.forEach((r) => { hubBusById[r.id] = r; });

  // Same breakdown for Premium Lounge (central) and VCC (venue) - not real
  // hub rows, so queried separately and appended after the hub list below.
  const { rows: placeBusRows } = await pool.query(
    `SELECT origin,
            COUNT(*) FILTER (WHERE status = 'scheduled')::int AS idle,
            COUNT(*) FILTER (WHERE status = 'boarding')::int AS boarding,
            COUNT(*) FILTER (WHERE status = 'departed')::int AS en_route,
            MAX(departed_at) AS last_departure
     FROM bus_trips WHERE origin IN ('central', 'venue')
     GROUP BY origin`
  );
  const placeBusByOrigin = {};
  placeBusRows.forEach((r) => { placeBusByOrigin[r.origin] = r; });

  // Registered (every ticket sold for that hub, standby included) vs
  // departed (how many of those have actually left via O1) - same
  // definitions as /dashboard/egress's soldTotal/departedTotal, just scoped
  // to this screen's own hub list.
  const { rows: hubTicketRows } = await pool.query(
    `SELECT t.hub_id,
            COUNT(*)::int AS registered,
            COUNT(*) FILTER (WHERE bt1.departed_at IS NOT NULL)::int AS departed
     FROM tickets t
     LEFT JOIN bus_trips bt1 ON t.trip1_id = bt1.id
     WHERE t.hub_id != 'demo'
     GROUP BY t.hub_id`
  );
  const hubTicketsById = {};
  hubTicketRows.forEach((r) => { hubTicketsById[r.hub_id] = r; });

  const locations = hubRows.map((h) => {
    const b = hubBusById[h.id] || { idle: 0, boarding: 0, en_route: 0, last_departure: null };
    const t = hubTicketsById[h.id] || { registered: 0, departed: 0 };
    return {
      id: h.id, name: h.name, kind: 'hub',
      openedAt: h.opened_at, closedAt: h.closed_at,
      idle: b.idle, boarding: b.boarding, enRoute: b.en_route, lastDeparture: b.last_departure,
      registered: t.registered, departed: t.departed,
    };
  });
  [['central', 'Premium Lounge'], ['venue', 'VCC']].forEach(([id, name]) => {
    const b = placeBusByOrigin[id] || { idle: 0, boarding: 0, en_route: 0, last_departure: null };
    locations.push({
      id, name, kind: id,
      openedAt: null, closedAt: null,
      idle: b.idle, boarding: b.boarding, enRoute: b.en_route, lastDeparture: b.last_departure,
    });
  });

  // Top stat row. Demo hub excluded throughout, same as the location table.
  const { rows: totalRows } = await pool.query("SELECT COUNT(*)::int AS total FROM tickets WHERE hub_id != 'demo'");
  const totalTickets = totalRows[0].total;

  const { rows: enRouteRows } = await pool.query(
    `SELECT COUNT(*)::int AS trips
     FROM bus_trips bt WHERE bt.status = 'departed' AND bt.origin != 'demo' AND bt.destination != 'demo'`
  );
  const busesEnRoute = enRouteRows[0].trips;

  const { rows: incidentCountRows } = await pool.query("SELECT COUNT(*)::int AS n FROM incidents WHERE status = 'open'");
  const activeIncidents = incidentCountRows[0].n;

  // Rider lifecycle funnel - same query/definitions as /dashboard/ingress'
  // statRows (see the comment there for why departedHubTotal is cumulative
  // and destination='venue' trips fold into the en-route/arrived-at-venue
  // buckets), just relabeled Lounge/VCC for this screen.
  const { rows: funnelRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE bt1.departed_at IS NOT NULL)::int AS departed_hub_total,
       COUNT(*) FILTER (WHERE bt1.destination = 'central' AND bt1.departed_at IS NOT NULL AND bt1.arrived_at IS NULL)::int AS en_route_to_lounge,
       COUNT(*) FILTER (WHERE bt1.destination = 'central' AND bt1.arrived_at IS NOT NULL AND t.trip2_id IS NULL)::int AS at_lounge,
       COUNT(*) FILTER (WHERE
            (bt2.departed_at IS NOT NULL AND bt2.arrived_at IS NULL)
         OR (bt1.destination = 'venue' AND bt1.departed_at IS NOT NULL AND bt1.arrived_at IS NULL)
       )::int AS en_route_to_vcc,
       COUNT(*) FILTER (WHERE bt2.arrived_at IS NOT NULL OR (bt1.destination = 'venue' AND bt1.arrived_at IS NOT NULL))::int AS arrived_vcc,
       AVG(EXTRACT(EPOCH FROM (t.trip2_boarded_at - bt1.arrived_at)) / 60)
         FILTER (WHERE bt1.destination = 'central' AND bt1.arrived_at IS NOT NULL AND t.trip2_boarded_at IS NOT NULL) AS avg_wait_at_lounge_minutes
     FROM tickets t
     LEFT JOIN bus_trips bt1 ON t.trip1_id = bt1.id
     LEFT JOIN bus_trips bt2 ON t.trip2_id = bt2.id
     WHERE t.hub_id != 'demo'`
  );
  const f = funnelRows[0];
  // "Riders departed total" for the stat row - same cumulative definition as
  // lifecycle.notDeparted derives from (bt1.departed_at IS NOT NULL), just
  // surfaced as its own headline number instead of buried in the funnel.
  const ridersDepartedTotal = f.departed_hub_total;
  const lifecycle = {
    totalTickets,
    departedHubTotal: ridersDepartedTotal,
    enRouteToLounge: f.en_route_to_lounge,
    atLounge: f.at_lounge,
    avgWaitAtLoungeMinutes: f.avg_wait_at_lounge_minutes !== null ? Math.round(f.avg_wait_at_lounge_minutes) : null,
    enRouteToVcc: f.en_route_to_vcc,
    arrivedVcc: f.arrived_vcc,
  };

  // Open incidents, most recent first - capped for display; activeIncidents
  // above stays the true total even if it exceeds this cap.
  const { rows: incidentRows } = await pool.query(
    `SELECT license_plate, description, created_at FROM incidents WHERE status = 'open' ORDER BY created_at DESC LIMIT 10`
  );
  const incidents = incidentRows.map((r) => ({ licensePlate: r.license_plate, description: r.description, createdAt: r.created_at }));

  // Activity feed: no dedicated event-log table (see comment above the
  // route) - reconstructed from existing timestamps across 4 sources, merged
  // and sorted here in JS since they don't share a common row shape.
  const { rows: departureRows } = await pool.query(
    `SELECT license_plate, origin, destination, departed_at, ${TRANSPORT_ONBOARD_CASE} AS onboard
     FROM bus_trips bt WHERE departed_at IS NOT NULL AND origin != 'demo' AND destination != 'demo'
     ORDER BY departed_at DESC LIMIT 15`
  );
  const { rows: arrivalRows } = await pool.query(
    `SELECT license_plate, destination, arrived_at FROM bus_trips
     WHERE arrived_at IS NOT NULL AND origin != 'demo' AND destination != 'demo'
     ORDER BY arrived_at DESC LIMIT 15`
  );
  const { rows: incidentActivityRows } = await pool.query(
    `SELECT license_plate, description, created_at FROM incidents ORDER BY created_at DESC LIMIT 10`
  );

  const activity = [];
  departureRows.forEach((r) => {
    activity.push({
      at: r.departed_at,
      text: `${r.license_plate} departed ${placeLabel(r.origin, hubNameById)} → ${placeLabel(r.destination, hubNameById)}${r.onboard === 0 ? ' (empty)' : ''}`,
    });
  });
  arrivalRows.forEach((r) => {
    activity.push({ at: r.arrived_at, text: `${r.license_plate} arrived at ${placeLabel(r.destination, hubNameById)}` });
  });
  hubRows.forEach((h) => {
    if (h.opened_at) activity.push({ at: h.opened_at, text: `${h.name} opened for the day` });
    if (h.closed_at) activity.push({ at: h.closed_at, text: `${h.name} closed` });
  });
  incidentActivityRows.forEach((r) => {
    activity.push({ at: r.created_at, text: `Incident logged — ${r.license_plate}: ${r.description}` });
  });
  activity.sort((a, b) => new Date(b.at) - new Date(a.at));

  // Arrivals forecast: riders currently en route to Lounge or VCC, bucketed
  // by estimated minutes-until-arrival. Estimated, not tracked - there's no
  // live GPS anywhere in this system, so "arrival" is departed_at + an
  // assumed travel duration. O1 uses that hub's own directional estimate -
  // time_to_pl for a hub->central trip, time_to_vcc for a hub->venue direct
  // trip, since those are different distances. O2 (Premium Lounge -> VCC)
  // has no per-hub estimate to draw on (it doesn't originate at a hub), so
  // it uses a flat assumed duration instead. Trips estimated more than 30
  // minutes out are outside this forecast's window entirely (matches the
  // UI, which only has 0-10/10-20/20-30 buckets) - not lost data, just not
  // shown here.
  const O2_DURATION_MINUTES = 10;

  const { rows: enRouteTripRows } = await pool.query(
    `SELECT bt.leg, bt.origin, bt.destination, bt.departed_at, ${TRANSPORT_ONBOARD_CASE} AS onboard
     FROM bus_trips bt
     WHERE bt.status = 'departed' AND bt.origin != 'demo' AND bt.destination != 'demo'
       AND ((bt.leg = 'O1' AND bt.destination IN ('central', 'venue')) OR bt.leg = 'O2')`
  );

  const forecast = {
    lounge: { '0-10': 0, '10-20': 0, '20-30': 0 },
    vcc: { '0-10': 0, '10-20': 0, '20-30': 0 },
  };
  const now = Date.now();
  enRouteTripRows.forEach((r) => {
    const bucketKey = r.destination === 'central' ? 'lounge' : r.destination === 'venue' ? 'vcc' : null;
    if (!bucketKey || !r.departed_at) return;
    const durationMinutes = r.leg === 'O2'
      ? O2_DURATION_MINUTES
      : ((r.destination === 'venue' ? hubTimeToVccById[r.origin] : hubTimeToPlById[r.origin]) ?? 30);
    const estimatedArrival = new Date(r.departed_at).getTime() + durationMinutes * 60000;
    const minutesOut = (estimatedArrival - now) / 60000;
    if (minutesOut <= 10) forecast[bucketKey]['0-10'] += r.onboard;
    else if (minutesOut <= 20) forecast[bucketKey]['10-20'] += r.onboard;
    else if (minutesOut <= 30) forecast[bucketKey]['20-30'] += r.onboard;
  });

  res.json({
    ridersDepartedTotal,
    totalTickets,
    busesEnRoute,
    activeIncidents,
    lifecycle,
    locations,
    incidents,
    activity: activity.slice(0, 25),
    forecast,
  });
}));

module.exports = router;
