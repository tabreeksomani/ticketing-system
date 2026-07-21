const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
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
  // Any authenticated user can read the timeslot list - it's a harmless read.
  // Writes (selling against a timeslot) are gated separately in tickets.js.
  const user = await requireAuth(req);
  const hubId = decodeURIComponent(req.params.hubId);
  if (user.role === 'volunteer' && !user.hubIds.includes(hubId)) {
    jsonError('Not authorized for this hub', 403);
  }
  const { rows } = await pool.query(`${TIMESLOT_SELECT} WHERE t.hub_id = $1 ORDER BY t.departure_time ASC`, [hubId]);
  res.json(rows.map(timeslotRow));
}));

// Every hub, with its open/closed state - powers admin's hub-status list
// and Hub's own "is my hub already opened/closed" check before rendering
// New Trip.
router.get('/hubs', asyncHandler(async (req, res) => {
  await requireAuth(req);
  const { rows } = await pool.query('SELECT id, name, opened_at, closed_at FROM hubs ORDER BY name ASC');
  res.json(rows.map((r) => ({ id: r.id, name: r.name, openedAt: r.opened_at, closedAt: r.closed_at })));
}));

// Opening is purely a record of when a hub actually started for the day -
// unlike closing, it doesn't gate anything (yet). Same authorization shape
// as closing: the hub's own volunteer, or admin.
router.post('/hubs/:hubId/open', asyncHandler(async (req, res) => {
  const user = await requireRole(req, ['volunteer', 'admin']);
  const hubId = decodeURIComponent(req.params.hubId);
  if (user.role === 'volunteer' && !user.hubIds.includes(hubId)) {
    jsonError('Not authorized for this hub', 403);
  }
  const { rows } = await pool.query('SELECT id FROM hubs WHERE id = $1', [hubId]);
  if (!rows.length) jsonError('Unknown hub', 404);
  await pool.query('UPDATE hubs SET opened_at = now() WHERE id = $1', [hubId]);
  res.json({ id: hubId, openedAt: new Date().toISOString() });
}));

// Closing a hub is a guard, not a schedule: once every bus for the day has
// left, a volunteer marks it closed so nobody at that hub can accidentally
// spin up another O1 trip afterward (enforced in trips.js's POST /trips).
// Either the hub's own volunteer or admin can close it - same authorization
// shape as creating a trip there in the first place.
router.post('/hubs/:hubId/close', asyncHandler(async (req, res) => {
  const user = await requireRole(req, ['volunteer', 'admin']);
  const hubId = decodeURIComponent(req.params.hubId);
  if (user.role === 'volunteer' && !user.hubIds.includes(hubId)) {
    jsonError('Not authorized for this hub', 403);
  }
  const { rows } = await pool.query('SELECT id, opened_at FROM hubs WHERE id = $1', [hubId]);
  if (!rows.length) jsonError('Unknown hub', 404);
  if (!rows[0].opened_at) jsonError('This hub has not been opened yet', 409);
  await pool.query('UPDATE hubs SET closed_at = now() WHERE id = $1', [hubId]);
  res.json({ id: hubId, closedAt: new Date().toISOString() });
}));

// Admin-only correction for a hub closed by mistake - mirrors the
// undo-depart/undo-arrive pattern in trips.js (admin-only reversal of a
// status change).
router.post('/hubs/:hubId/reopen', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const hubId = decodeURIComponent(req.params.hubId);
  const { rows } = await pool.query('SELECT id FROM hubs WHERE id = $1', [hubId]);
  if (!rows.length) jsonError('Unknown hub', 404);
  await pool.query('UPDATE hubs SET closed_at = NULL WHERE id = $1', [hubId]);
  res.json({ id: hubId, closedAt: null });
}));

module.exports = router;
