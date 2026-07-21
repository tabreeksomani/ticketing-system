const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../auth');
const { jsonError, asyncHandler } = require('../errors');

const router = express.Router();

function incidentRow(row) {
  return {
    id: row.id,
    licensePlate: row.license_plate,
    description: row.description,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

router.get('/incidents', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const { rows } = await pool.query('SELECT * FROM incidents ORDER BY created_at DESC');
  res.json(rows.map(incidentRow));
}));

router.post('/incidents', asyncHandler(async (req, res) => {
  const user = await requireRole(req, ['admin']);
  const licensePlate = String(req.body.licensePlate || '').trim();
  const description = String(req.body.description || '').trim();
  if (!licensePlate) jsonError('licensePlate is required', 400);
  if (!description) jsonError('description is required', 400);
  const { rows } = await pool.query(
    `INSERT INTO incidents (license_plate, description, created_by) VALUES ($1, $2, $3) RETURNING *`,
    [licensePlate, description, user.id]
  );
  res.status(201).json(incidentRow(rows[0]));
}));

router.post('/incidents/:id(\\d+)/resolve', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const id = parseInt(req.params.id, 10);
  const { rows } = await pool.query(
    `UPDATE incidents SET status = 'resolved', resolved_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  if (!rows.length) jsonError('Incident not found', 404);
  res.json(incidentRow(rows[0]));
}));

router.post('/incidents/:id(\\d+)/reopen', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const id = parseInt(req.params.id, 10);
  const { rows } = await pool.query(
    `UPDATE incidents SET status = 'open', resolved_at = NULL WHERE id = $1 RETURNING *`,
    [id]
  );
  if (!rows.length) jsonError('Incident not found', 404);
  res.json(incidentRow(rows[0]));
}));

module.exports = router;
