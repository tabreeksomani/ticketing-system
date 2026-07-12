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
    const { rows: slotRows } = await pool.query(
      `SELECT t.*,
              (SELECT COUNT(*) FROM tickets tk WHERE tk.timeslot_id = t.id)::int AS sold,
              (SELECT COUNT(*) FROM tickets tk WHERE tk.timeslot_id = t.id AND tk.trip1_id IS NOT NULL)::int AS boarded,
              (SELECT COUNT(*) FROM tickets tk JOIN bus_trips bt4 ON tk.trip4_id = bt4.id
                WHERE tk.timeslot_id = t.id AND bt4.arrived_at IS NOT NULL)::int AS returned
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
      };
    });

    const { rows: standbyRows } = await pool.query(
      `SELECT COUNT(*)::int AS issued,
              COUNT(*) FILTER (WHERE tk.trip1_id IS NOT NULL)::int AS boarded,
              (SELECT COUNT(*) FROM tickets tk2 JOIN bus_trips bt4 ON tk2.trip4_id = bt4.id
                WHERE tk2.hub_id = $1 AND tk2.is_standby = TRUE AND bt4.arrived_at IS NOT NULL)::int AS returned
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
      standbyIssued: standby.issued,
      standbyBoarded: standby.boarded,
      standbyReturned: standby.returned,
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
            COUNT(*)::int AS count
     FROM tickets t JOIN hubs h ON t.hub_id = h.id
     GROUP BY h.id, h.name, day
     ORDER BY day ASC`
  );
  res.json(rows.map((r) => ({
    hubId: r.hub_id, hubName: r.hub_name,
    day: r.day.toISOString().slice(0, 10),
    count: r.count,
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

  const { rows: statRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE bt1.departed_at IS NOT NULL)::int AS departed_hub_total,
       COUNT(*) FILTER (WHERE bt1.departed_at IS NOT NULL AND bt1.arrived_at IS NULL)::int AS en_route_to_central,
       COUNT(*) FILTER (WHERE bt1.arrived_at IS NOT NULL AND t.trip2_id IS NULL)::int AS at_central,
       COUNT(*) FILTER (WHERE bt2.departed_at IS NOT NULL AND bt2.arrived_at IS NULL)::int AS en_route_to_venue,
       COUNT(*) FILTER (WHERE bt2.arrived_at IS NOT NULL)::int AS arrived_at_venue,
       AVG(EXTRACT(EPOCH FROM (t.trip2_boarded_at - bt1.arrived_at)) / 60)
         FILTER (WHERE bt1.arrived_at IS NOT NULL AND t.trip2_boarded_at IS NOT NULL) AS avg_wait_at_central_minutes
     FROM tickets t
     LEFT JOIN bus_trips bt1 ON t.trip1_id = bt1.id
     LEFT JOIN bus_trips bt2 ON t.trip2_id = bt2.id`
  );

  // Cumulative departed-hub total, broken down by hub - same "ever left,
  // regardless of what's happened since" definition as the aggregate above.
  const { rows: hubRows } = await pool.query(
    `SELECT h.id AS hub_id, h.name AS hub_name,
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
    hubs: hubRows.map((r) => ({ hubId: r.hub_id, hubName: r.hub_name, departedTotal: r.departed_total })),
    trips: tripRows.map((r) => ({
      tripId: r.id, leg: r.leg, licensePlate: r.license_plate,
      origin: r.origin, destination: r.destination, status: r.status,
      onboard: r.onboard, departedAt: r.departed_at, arrivedAt: r.arrived_at,
    })),
  });
}));

// The return half of the journey (R1 venue->central, R2 central->hub) as
// the mirror image of /dashboard/ingress. "Departed Venue" is cumulative
// (same running-total convention as Ingress's "Departed Hub"). The other
// four are live snapshots partitioning riders into mutually exclusive
// buckets: enRouteToCentral -> atCentral -> enRouteToHub -> arrivedAtHub.
//
// `waitingPerHub` is the headline number for this dashboard - unlike
// Ingress (where Venue is one destination for everybody), R2 destinations
// vary per rider, so "at Central" only means something once broken down by
// each ticket's home hub. Same for `arrivedPerHub`.
router.get('/dashboard/egress', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);

  const { rows: statRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE bt3.departed_at IS NOT NULL)::int AS departed_venue_total,
       COUNT(*) FILTER (WHERE bt3.departed_at IS NOT NULL AND bt3.arrived_at IS NULL)::int AS en_route_to_central,
       COUNT(*) FILTER (WHERE bt3.arrived_at IS NOT NULL AND t.trip4_id IS NULL)::int AS at_central_total,
       COUNT(*) FILTER (WHERE bt4.departed_at IS NOT NULL AND bt4.arrived_at IS NULL)::int AS en_route_to_hub,
       COUNT(*) FILTER (WHERE bt4.arrived_at IS NOT NULL)::int AS arrived_at_hub_total,
       AVG(EXTRACT(EPOCH FROM (t.trip4_boarded_at - bt3.arrived_at)) / 60)
         FILTER (WHERE bt3.arrived_at IS NOT NULL AND t.trip4_boarded_at IS NOT NULL) AS avg_wait_at_central_minutes
     FROM tickets t
     LEFT JOIN bus_trips bt3 ON t.trip3_id = bt3.id
     LEFT JOIN bus_trips bt4 ON t.trip4_id = bt4.id`
  );

  // Per hub, both waiting at Central (R1 arrived, R2 not yet boarded) and
  // en route to Central (R1 departed Venue, not yet arrived) - shown side
  // by side so dispatch decisions ("does hub X need an R2 bus now, or is
  // one already about to fill up from what's still in transit?") can see
  // both the current backlog and what's about to add to it. LEFT JOIN from
  // hubs (not tickets) so every hub appears even at zero, same reasoning as
  // GET /trips/hub-headcounts (which the "waiting" half of this mirrors).
  const { rows: waitingRows } = await pool.query(
    `SELECT h.id AS hub_id, h.name AS hub_name,
            COUNT(t.id) FILTER (WHERE bt.arrived_at IS NOT NULL AND t.trip4_id IS NULL)::int AS waiting_count,
            COUNT(t.id) FILTER (WHERE bt.departed_at IS NOT NULL AND bt.arrived_at IS NULL)::int AS en_route_count
     FROM hubs h
     LEFT JOIN tickets t ON t.hub_id = h.id
     LEFT JOIN bus_trips bt ON t.trip3_id = bt.id
     GROUP BY h.id, h.name
     ORDER BY h.name ASC`
  );

  // Cumulative arrived-at-hub total, by hub.
  const { rows: arrivedRows } = await pool.query(
    `SELECT h.id AS hub_id, h.name AS hub_name,
            COUNT(t.id) FILTER (WHERE bt.arrived_at IS NOT NULL)::int AS count
     FROM hubs h
     LEFT JOIN tickets t ON t.hub_id = h.id
     LEFT JOIN bus_trips bt ON t.trip4_id = bt.id
     GROUP BY h.id, h.name
     ORDER BY h.name ASC`
  );

  // Every R1 (venue->central) and R2 (central->hub) trip, for the mini
  // trip-card list - all statuses, not just en-route.
  const { rows: tripRows } = await pool.query(
    `SELECT bt.*,
            (CASE bt.leg
               WHEN 'R1' THEN (SELECT COUNT(*) FROM tickets tk WHERE tk.trip3_id = bt.id)
               WHEN 'R2' THEN (SELECT COUNT(*) FROM tickets tk WHERE tk.trip4_id = bt.id)
             END)::int AS onboard
     FROM bus_trips bt
     WHERE bt.leg IN ('R1', 'R2')
     ORDER BY bt.created_at DESC`
  );

  const s = statRows[0];
  res.json({
    departedVenueTotal: s.departed_venue_total,
    enRouteToCentral: s.en_route_to_central,
    atCentralTotal: s.at_central_total,
    enRouteToHub: s.en_route_to_hub,
    arrivedAtHubTotal: s.arrived_at_hub_total,
    avgWaitAtCentralMinutes: s.avg_wait_at_central_minutes !== null ? Math.round(s.avg_wait_at_central_minutes) : null,
    waitingPerHub: waitingRows.map((r) => ({
      hubId: r.hub_id, hubName: r.hub_name,
      waitingCount: r.waiting_count, enRouteCount: r.en_route_count,
    })),
    arrivedPerHub: arrivedRows.map((r) => ({ hubId: r.hub_id, hubName: r.hub_name, count: r.count })),
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

router.get('/dashboard/transport', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const { rows } = await pool.query(
    `SELECT b.*, h.name AS hub_name,
            (SELECT COUNT(*) FROM tickets tk WHERE tk.leg1_bus_id = b.id)::int AS onboard,
            (SELECT COUNT(*) FROM tickets tk WHERE tk.leg1_bus_id = b.id AND tk.is_standby = TRUE)::int AS standby_onboard
     FROM buses b JOIN hubs h ON b.hub_id = h.id
     WHERE b.leg = 'hub_to_central'
     ORDER BY h.name ASC, b.id ASC`
  );

  const grouped = { scheduled: [], boarding: [], departed: [], arrived: [] };
  for (const r of rows) {
    const entry = {
      id: r.id,
      hubId: r.hub_id,
      hubName: r.hub_name,
      label: r.label,
      capacity: r.capacity,
      onboard: r.onboard,
      standbyOnboard: r.standby_onboard,
      boardingStartedAt: r.boarding_started_at,
      departedAt: r.departed_at,
      arrivedAt: r.arrived_at,
    };
    if (grouped[r.status]) {
      grouped[r.status].push(entry);
    }
  }

  const { rows: standbyByHub } = await pool.query(
    `SELECT h.id AS hub_id, h.name AS hub_name, COUNT(*)::int AS c
     FROM tickets t JOIN hubs h ON t.hub_id = h.id
     WHERE t.is_standby = TRUE
     GROUP BY h.id, h.name
     ORDER BY h.name ASC`
  );
  grouped.standby = {
    total: standbyByHub.reduce((s, r) => s + r.c, 0),
    byHub: standbyByHub.map((r) => ({ hubId: r.hub_id, hubName: r.hub_name, count: r.c })),
  };

  res.json(grouped);
}));

module.exports = router;
