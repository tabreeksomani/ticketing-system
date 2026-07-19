const express = require('express');
const { pool, rateLimitCheck, rateLimitRecordFailure, rateLimitClear } = require('../db');
const { signToken } = require('../auth');
const { jsonError, asyncHandler } = require('../errors');
const { safeEquals } = require('../util');

const router = express.Router();

// Which hubs a login can sell for (login_hubs is the source of truth - see
// src/db.js for why logins.hub_id is deprecated but kept for backfill).
async function hubsForLogin(loginId) {
  const { rows } = await pool.query(
    `SELECT h.id, h.name FROM login_hubs lh JOIN hubs h ON h.id = lh.hub_id
     WHERE lh.login_id = $1 ORDER BY h.name ASC`,
    [loginId]
  );
  return rows;
}

// Single login for both roles - the row in `logins` (hand-inserted, no CRUD
// API) already carries the role and hub scope, so there's nothing role-
// specific left in this handler.
router.post('/login', asyncHandler(async (req, res) => {
  const id = String(req.body.id || '').trim();
  const secret = String(req.body.secret || '').trim();
  if (id === '') {
    jsonError('id is required', 400);
  }

  const bucket = `${req.ip}:${id}`;
  await rateLimitCheck(bucket);

  const { rows } = await pool.query('SELECT * FROM logins WHERE id = $1', [id]);
  const login = rows[0];
  if (login && safeEquals(login.secret, secret)) {
    await rateLimitClear(bucket);
    const hubs = await hubsForLogin(login.id);
    const hubIds = hubs.map((h) => h.id);
    const token = signToken({
      id: login.id, role: login.role, hubIds,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    });
    return res.json({ token, user: { role: login.role, id: login.id, hubIds, hubs } });
  }

  /* disable no password "tester" access
  if (login && secret == '') {
    const hubs = await hubsForLogin(login.id);
    const hubIds = hubs.map((h) => h.id);
    const token = signToken({
      id: login.id, role: 'tester', hubIds,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    });
    return res.json({ token, user: { role: 'tester', id: login.id, hubIds, hubs } });
  }
  */

  await rateLimitRecordFailure(bucket);
  jsonError('Invalid id or secret', 401);
}));

// Maps each front-end app to the login role(s) whose logins should show up in
// that app's sign-in picker. Keeping this mapping server-side means the client
// only has to say which app it is (?app=...) and never needs to know the
// underlying role names - parking, in particular, spans three distinct roles.
const APP_ROLES = {
  ticketing: ['volunteer'],
  checkins: ['volunteer'],
  admin: ['admin'],
  parking: ['parking_dashboard', 'parking_marshal', 'parking_admin'],
};

// Public: powers each app's login picker at sign-in. No secrets in the
// response, just enough to populate a dropdown of logins (not hubs - a
// login may cover more than one now, so it's shown with its hub(s) as a
// subtitle rather than treated as synonymous with a single hub).
router.get('/login-ids', asyncHandler(async (req, res) => {
  const app = req.query.app;
  if (!Object.prototype.hasOwnProperty.call(APP_ROLES, app)) {
    jsonError(`app must be one of: ${Object.keys(APP_ROLES).join(', ')}`, 400);
  }
  const roles = APP_ROLES[app];
  const { rows } = await pool.query(
    `SELECT l.id, l.name,
            COALESCE(ARRAY_AGG(h.name ORDER BY h.name) FILTER (WHERE h.name IS NOT NULL), '{}') AS hub_names
     FROM logins l
     LEFT JOIN login_hubs lh ON lh.login_id = l.id
     LEFT JOIN hubs h ON h.id = lh.hub_id
     WHERE l.role = ANY($1)
     GROUP BY l.id, l.name
     ORDER BY COALESCE(l.name, l.id) ASC`,
    [roles]
  );
  res.json(rows.map((r) => ({
    id: r.id,
    name: r.name || r.id,
    hubNames: r.hub_names,
  })));
}));

module.exports = router;
