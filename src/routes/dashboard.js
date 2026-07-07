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
              (SELECT COUNT(*) FROM tickets tk WHERE tk.timeslot_id = t.id AND tk.leg1_bus_id IS NOT NULL)::int AS boarded
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
      };
    });

    const { rows: standbyRows } = await pool.query(
      'SELECT COUNT(*)::int AS c FROM tickets WHERE hub_id = $1 AND is_standby = TRUE',
      [hub.id]
    );

    out.push({
      hubId: hub.id,
      hubName: hub.name,
      travelMinutes: hub.travel_minutes,
      timeslots: slots,
      totalSold: slots.reduce((s, x) => s + x.sold, 0),
      totalCapacity: slots.reduce((s, x) => s + x.capacity, 0),
      totalBoarded: slots.reduce((s, x) => s + x.boarded, 0),
      totalNoShow: slots.reduce((s, x) => s + x.noShow, 0),
      standbyIssued: standbyRows[0].c,
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
