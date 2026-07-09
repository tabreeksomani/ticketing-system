const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { jsonError } = require('./errors');

// Login credentials are now manually managed (no self-provisioning), so the
// JWT secret follows the same pattern as DATABASE_URL/PORT elsewhere - an env
// var for real deployments, with a random per-process fallback for local dev
// (fine since dev tokens don't need to survive a restart).
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

function getBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice(7);
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
}

/** Requires a valid token of ANY role. Returns the decoded payload. */
async function requireAuth(req) {
  const token = getBearerToken(req);
  if (token === null) {
    jsonError('Missing token', 401);
  }
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    jsonError('Invalid or expired token', 401);
  }
}

/** Requires a valid token AND that its role is in the allowed list. */
async function requireRole(req, allowedRoles) {
  const user = await requireAuth(req);
  if (!allowedRoles.includes(user.role)) {
    jsonError('Not authorized for this action', 403);
  }
  return user;
}

/** For hub-scoped actions: must be a volunteer AND cover the given hubId. */
function requireOwnHub(user, hubId) {
  if (user.role !== 'volunteer' || !(user.hubIds || []).includes(hubId)) {
    jsonError('Not authorized for this hub', 403);
  }
}

module.exports = { signToken, requireAuth, requireRole, requireOwnHub };
