require('dotenv').config();
const path = require('path');
const express = require('express');
const { ready } = require('./src/db');
const { HttpError } = require('./src/errors');

const app = express();
app.use(express.json());

// No cross-origin access is ever needed: every page in this app fetches "api/..."
// as a relative path, meaning the frontend and API are always served from the
// same origin. Not sending an Access-Control-Allow-Origin header at all means
// browsers default to disallowing cross-origin access - intentional, since
// there's no legitimate reason any other site should be able to call this API.
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// Ensure the schema exists before the first request is handled - hubs,
// timeslots, and logins themselves are seeded by hand (psql), not by the app.
app.use('/api', (req, res, next) => {
  ready().then(() => next()).catch(next);
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api', require('./src/routes/hubs'));
app.use('/api', require('./src/routes/buses'));
app.use('/api', require('./src/routes/tickets'));
app.use('/api', require('./src/routes/dashboard'));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Static frontend: three plain HTML portals, no build step, no frontend framework.
app.use(express.static(__dirname, { index: 'index.html' }));

// Defense in depth: never let a stack trace leak into a response body - the
// only thing that should ever produce an error response is this handler, and
// only with detail when APP_DEBUG=1 is explicitly set.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('Unhandled exception:', err);
  res.status(500).json({
    error: 'Server error',
    detail: process.env.APP_DEBUG === '1' ? err.message : null,
  });
});

const port = parseInt(process.env.PORT, 10) || 8000;
app.listen(port, () => {
  console.log(`Ticketing system listening on http://localhost:${port}`);
});
