const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { jsonError, asyncHandler } = require('../errors');

const router = express.Router();

// Runtime key/value event state - see migrations/010_flags.sql. Distinct from
// the seed-time hub/timeslot config: these are meant to flip during the event
// itself. First consumer is 'phase' (ingress -> egress), toggled from admin's
// Live tab and surfaced on the Ops dashboard.

// Shared read used both by GET /flags and by the dashboard routes, so there's
// one definition of "the current phase, defaulting to ingress if unset."
async function readFlags() {
  const { rows } = await pool.query('SELECT key, value FROM flags');
  const flags = {};
  rows.forEach((r) => { flags[r.key] = r.value; });
  return flags;
}

// Any authenticated dashboard user may read flags - harmless state, and the
// Ops-only login needs the phase too.
router.get('/flags', asyncHandler(async (req, res) => {
  await requireAuth(req);
  res.json(await readFlags());
}));

// Admin-only write - upserts one flag. Deliberately generic (the table is for
// arbitrary state), so no per-key value whitelist here; callers decide what a
// given key's values mean. Value must be a non-empty string.
router.post('/flags/:key', asyncHandler(async (req, res) => {
  await requireRole(req, ['admin']);
  const key = decodeURIComponent(req.params.key);
  const value = String(req.body.value ?? '').trim();
  if (value === '') jsonError('value is required', 400);
  await pool.query(
    `INSERT INTO flags (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [key, value]
  );
  res.json({ key, value });
}));

module.exports = router;
module.exports.readFlags = readFlags;
