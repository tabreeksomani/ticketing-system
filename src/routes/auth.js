const express = require('express');
const { pool, rateLimitCheck, rateLimitRecordFailure, rateLimitClear } = require('../db');
const { signToken } = require('../auth');
const { jsonError, asyncHandler } = require('../errors');
const { safeEquals } = require('../util');

const router = express.Router();

// Single login for both roles - the row in `logins` (hand-inserted, no CRUD
// API) already carries the role and hub scope, so there's nothing role-
// specific left in this handler.
router.post('/login', asyncHandler(async (req, res) => {
  const id = String(req.body.id || '').trim();
  const secret = String(req.body.secret || '').trim();
  if (id === '' || secret === '') {
    jsonError('id and secret are required', 400);
  }

  const bucket = `${req.ip}:${id}`;
  await rateLimitCheck(bucket);

  const { rows } = await pool.query('SELECT * FROM logins WHERE id = $1', [id]);
  const login = rows[0];
  if (!login || !safeEquals(login.secret, secret)) {
    await rateLimitRecordFailure(bucket);
    jsonError('Invalid id or secret', 401);
  }
  await rateLimitClear(bucket);

  const token = signToken({
    role: login.role, hubId: login.hub_id,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
  });
  res.json({ token, user: { role: login.role, id: login.id, hubId: login.hub_id } });
}));

// Public: powers the volunteer login's hub picker. No secrets in the
// response, just enough to populate a dropdown.
router.get('/login-ids', asyncHandler(async (req, res) => {
  const role = req.query.role;
  if (!['admin', 'volunteer'].includes(role)) {
    jsonError('role must be admin or volunteer', 400);
  }
  const { rows } = await pool.query(
    `SELECT l.id, h.name AS hub_name FROM logins l LEFT JOIN hubs h ON h.id = l.hub_id
     WHERE l.role = $1 ORDER BY COALESCE(h.name, l.id) ASC`,
    [role]
  );
  res.json(rows.map((r) => ({ id: r.id, name: r.hub_name || r.id })));
}));

module.exports = router;
