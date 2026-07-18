const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { jsonError, asyncHandler } = require('../errors');

const router = express.Router();

// The three roles this feature introduces:
//   parking_dashboard - read-only. Served by the GET below (requireAuth).
//   parking_marshal   - read + update a lot's status/open-stall count.
//   parking_admin     - read + manage (create/edit/delete) lots.
// The parking.html UI hides the read-only Dashboard tab from admins (they work
// from Update/Manage), but the read endpoint itself stays open to any login.
const CAN_UPDATE = ['parking_marshal', 'parking_admin'];
const CAN_MANAGE = ['parking_admin'];

// Whitelisted ORDER BY clauses, ported straight from the parking-tracker
// dashboard. Keyed by the ?sort= value so no user input reaches the SQL.
const SORTS = {
  // Available lots first, then most open stalls, then closest, then by name.
  available:
    "CASE status WHEN 'available' THEN 0 ELSE 1 END ASC, " +
    'available_stalls IS NULL, available_stalls DESC, ' +
    'distance_value IS NULL, distance_value ASC, name ASC',
  distance: 'distance_value IS NULL, distance_value ASC, name ASC',
  spots: 'available_stalls IS NULL, available_stalls DESC, name ASC',
};

function lotRow(row) {
  return {
    id: row.id,
    name: row.name,
    totalStalls: row.total_stalls,
    availableStalls: row.available_stalls,
    status: row.status,
    distanceValue: row.distance_value,
    distanceUnit: row.distance_unit,
    rate: row.rate,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

// trim + coerce helpers, mirroring admin.php's clean_int / clean_num.
function cleanInt(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') return 0;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}
function cleanNum(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// GET the full lot list, sorted. Any authenticated user may read - this powers
// both the read-only dashboard and the marshal/admin pickers.
router.get('/parking/lots', asyncHandler(async (req, res) => {
  await requireAuth(req);
  const orderBy = SORTS[req.query.sort] || SORTS.available;
  const { rows } = await pool.query(`SELECT * FROM parking_lots ORDER BY ${orderBy}`);
  res.json(rows.map(lotRow));
}));

// Marshal action: mark a lot Available/Full and optionally report open stalls.
// A "full" lot never carries a stray open-stall count (same rule as the
// original update.php).
router.post('/parking/lots/:id/status', asyncHandler(async (req, res) => {
  await requireRole(req, CAN_UPDATE);
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) jsonError('Invalid lot id', 400);

  const status = req.body.status === 'full' ? 'full' : 'available';

  let availableStalls = null;
  if (status === 'available') {
    const raw = req.body.availableStalls;
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      if (!/^\d+$/.test(String(raw).trim())) {
        jsonError('Available stalls must be a whole number.', 400);
      }
      availableStalls = Number.parseInt(String(raw).trim(), 10);
    }
  }

  const { rows } = await pool.query(
    `UPDATE parking_lots SET status = $1, available_stalls = $2, updated_at = now()
     WHERE id = $3 RETURNING *`,
    [status, availableStalls, id]
  );
  if (!rows.length) jsonError('Lot not found', 404);
  res.json(lotRow(rows[0]));
}));

// Admin action: create a lot.
router.post('/parking/lots', asyncHandler(async (req, res) => {
  await requireRole(req, CAN_MANAGE);
  const name = String(req.body.name || '').trim();
  if (name === '') jsonError('Lot name is required.', 400);
  const totalStalls = cleanInt(req.body.totalStalls);
  const distanceValue = cleanNum(req.body.distanceValue);
  const distanceUnit = req.body.distanceUnit === 'm' ? 'm' : 'min walk';
  const rate = String(req.body.rate || '').trim() || null;

  const { rows } = await pool.query(
    `INSERT INTO parking_lots (name, total_stalls, available_stalls, status, distance_value, distance_unit, rate, updated_at)
     VALUES ($1, $2, NULL, 'available', $3, $4, $5, now()) RETURNING *`,
    [name, totalStalls, distanceValue, distanceUnit, rate]
  );
  res.status(201).json(lotRow(rows[0]));
}));

// Admin action: edit a lot's descriptive fields (name/total/distance/rate).
// Live status + open-stall count are owned by the marshal status endpoint, so
// they're intentionally left untouched here - same split as the original app.
router.put('/parking/lots/:id', asyncHandler(async (req, res) => {
  await requireRole(req, CAN_MANAGE);
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) jsonError('Invalid lot id', 400);
  const name = String(req.body.name || '').trim();
  if (name === '') jsonError('Lot name is required.', 400);
  const totalStalls = cleanInt(req.body.totalStalls);
  const distanceValue = cleanNum(req.body.distanceValue);
  const distanceUnit = req.body.distanceUnit === 'm' ? 'm' : 'min walk';
  const rate = String(req.body.rate || '').trim() || null;

  const { rows } = await pool.query(
    `UPDATE parking_lots SET name = $1, total_stalls = $2, distance_value = $3, distance_unit = $4, rate = $5, updated_at = now()
     WHERE id = $6 RETURNING *`,
    [name, totalStalls, distanceValue, distanceUnit, rate, id]
  );
  if (!rows.length) jsonError('Lot not found', 404);
  res.json(lotRow(rows[0]));
}));

// Admin action: delete a lot.
router.delete('/parking/lots/:id', asyncHandler(async (req, res) => {
  await requireRole(req, CAN_MANAGE);
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) jsonError('Invalid lot id', 400);
  const { rows } = await pool.query('DELETE FROM parking_lots WHERE id = $1 RETURNING id', [id]);
  if (!rows.length) jsonError('Lot not found', 404);
  res.json({ deleted: id });
}));

module.exports = router;
