const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../auth');
const { jsonError, asyncHandler } = require('../errors');

const router = express.Router();

function timeslotRow(row) {
  const sold = Number(row.sold);
  return {
    id: row.id,
    hubId: row.hub_id,
    departureTime: row.departure_time,
    capacity: row.capacity,
    sold,
    available: row.capacity - sold,
  };
}

const TIMESLOT_SELECT = `
  SELECT t.*, (SELECT COUNT(*) FROM tickets tk WHERE tk.timeslot_id = t.id)::int AS sold
  FROM timeslots t
`;

// The one "business logic" read the Ticket Allocation page needs - computed
// sold/available per timeslot, not raw CRUD. Hubs/timeslots themselves have
// no create/edit/delete API; they're set up by hand via psql.
router.get('/hubs/:hubId/timeslots', asyncHandler(async (req, res) => {
  const user = await requireRole(req, ['volunteer', 'admin']);
  const hubId = decodeURIComponent(req.params.hubId);
  if (user.role === 'volunteer' && !user.hubIds.includes(hubId)) {
    jsonError('Not authorized for this hub', 403);
  }
  const { rows } = await pool.query(`${TIMESLOT_SELECT} WHERE t.hub_id = $1 ORDER BY t.departure_time ASC`, [hubId]);
  res.json(rows.map(timeslotRow));
}));

module.exports = router;
