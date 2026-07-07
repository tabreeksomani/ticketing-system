# Transportation Ticketing System

Sells pre-printed QR-coded tickets at multiple transport hubs and tracks passengers as they
board hub buses.

Stack: Node/Express + Postgres, no build step, no frontend framework — two static HTML portals
talking to one JSON API.

## Design philosophy

- **Route** (hubs, timeslots, buses) and **Login** (credentials) are static configuration,
  decided once before an event. There is deliberately **no CRUD API** for any of it — no
  create/edit/delete endpoints, no admin forms. It's set up by hand, once, via `psql`.
- **Ticket** is the only domain that's genuinely live and concurrent during an event (selling,
  boarding, reassigning), so it's the only thing with a real API — one that encapsulates
  business rules (`capacity − allocated = remaining`) server-side, not a thin CRUD wrapper.

## The two portals

| Page | Login | Purpose |
|---|---|---|
| `/volunteer.html` | Pick your hub + that hub's password | **Ticket Allocation** (sell tickets), **Ticket Update/Reassignment** (switch a ticket's timeslot), **Ticket Check-in Scan** (board tickets onto a bus) |
| `/admin.html` | Admin password | Live **Sales** and **Transport Buses** dashboards |

There's no self-provisioned default login for either — see **Manual setup** below.

## Manual setup

Nothing about hubs, timeslots, buses, or logins is created through the app. Insert them directly:

```sql
INSERT INTO hubs (id, name, travel_minutes) VALUES ('surrey', 'Surrey', 45);

INSERT INTO timeslots (hub_id, departure_time, capacity)
VALUES ('surrey', '2026-07-06T18:00:00', 50);

-- role is 'admin' or 'volunteer'; hub_id is NULL for admin, set for volunteer.
-- "id" doubles as the login username - for volunteers it's the hub's own id.
INSERT INTO logins (id, role, hub_id, secret) VALUES ('admin', 'admin', NULL, 'a-real-password');
INSERT INTO logins (id, role, hub_id, secret) VALUES ('surrey', 'volunteer', 'surrey', 'a-real-password');

-- Buses are also set up ahead of time, one row per bus a hub will use for boarding.
INSERT INTO buses (leg, hub_id, label, capacity, status)
VALUES ('hub_to_central', 'surrey', 'Bus 1', 50, 'scheduled');
```

Secrets are stored in plaintext, not hashed — this is a small internal tool with manually
managed credentials, not a public-facing account system, and plaintext lets you actually read a
login back if needed. Do this setup once before an event; there's nothing to re-run per request.

## How the flow works

1. **Ticket Allocation** (`volunteer.html`) is a 2-step wizard, same as before:
   - **Scan.** The clerk scans tickets one at a time. Each scan is checked against every ticket
     ever sold (codes are globally unique — the first scan of a code anywhere registers it).
     Duplicates are rejected immediately.
   - **Select a time and confirm.** Only timeslots with enough remaining seats for the batch are
     shown. A separate "Confirm Sale" button finalizes the sale.
2. **Ticket Update** (`volunteer.html`) looks up a ticket (camera or manual entry)
   and, if it hasn't boarded yet and isn't a standby ticket, lists every other timeslot at that
   hub with live availability. Picking one and confirming moves the ticket there — there's no
   separate "release" step, since capacity is always computed live from ticket counts.
3. **Check-in** (`volunteer.html`) lets a volunteer pick a bus from a dropdown and
   scan tickets onto it. The first scan flips the bus from `scheduled` to `boarding`. Scanning an
   unrecognized code issues it as a brand-new **standby ticket** on the spot (see below).
   "Close Bus & Mark Departed" locks further boarding and timestamps the departure.

## Concurrency: no oversold timeslots

Selling a batch of tickets and reassigning a ticket both take a row-level lock
(`SELECT ... FOR UPDATE`) on the timeslot being sold/reassigned into, inside one transaction,
before checking and writing. Without this, two concurrent requests against the same timeslot
could both read "N seats left" before either commits, and both succeed — an oversold timeslot.
The lock forces the second request to wait for the first to commit, so its own recount reflects
the first request's inserts. Different timeslots aren't blocked by each other — the lock is
per-row, not per-hub.

## Forgotten-ticket workflow (standby tickets)

If someone shows up to board without their physical ticket, a volunteer just scans (or types)
*any* new code at Check-in Scan. If that code isn't recognized, the system automatically issues
it as a brand-new "standby" ticket — tied to that hub, with no pre-sold timeslot (so it never
counts against any timeslot's capacity) — and boards it in the same step.

## Dashboards (`admin.html`)

- **Sales** — summarized by hub (sold/capacity, boarded, no-show, standby); tap a hub to expand
  the per-timeslot breakdown.
- **Transport Buses** — every bus grouped by status: scheduled, boarding, departed, arrived.

## Central hub

Central-hub functionality (confirming bus arrivals, boarding onto venue-bound buses, return
scanning) has been removed for now — it'll come back later as an ordinary hub in the same
volunteer/location model, rather than as a separate role/login/page.

## Deploying

1. Point `DATABASE_URL` at your Postgres instance (`.env.example` has the format). Set
   `DATABASE_SSL=true` for hosts that require it (e.g. Azure Database for PostgreSQL).
2. Set a real fixed `JWT_SECRET` — if unset, the app falls back to a random value generated at
   process startup, which is fine for local dev but invalidates all sessions on every restart.
3. Run `npm install && npm start`. The schema (hubs/timeslots/logins/buses/tickets/login_attempts
   tables) creates itself on first request - the *rows* in it don't (see Manual setup above).
4. `npm run dev` restarts on file changes during local development.

## Mobile camera scanning

Every scanning screen opens straight into a **live camera view** — no button to tap first. It
uses a pure-JavaScript QR decoder (`vendor/jsQR.js`, bundled locally, no CDN dependency) rather
than the browser's Shape Detection API, since that API doesn't exist on iOS Safari at all.

- A "Enter code manually instead" link is always available below the camera as a fallback.
- Sound + vibration on every successful/rejected scan.
- **HTTPS is required for camera access on real phones** — a hard browser/OS restriction, not a
  bug. Both iOS Safari and Android Chrome refuse camera access on plain `http://` unless it's
  `localhost`. The scanner screen shows a clear on-screen warning if this happens.
- Each screen releases the camera the moment you navigate away.

## Security

- **Brute-force protection**: all logins track failed attempts per (client IP + login id) and
  lock out further tries for 15 minutes after 8 failures in a 15-minute window.
- **Timing-safe comparisons**: login secrets are compared with a constant-time helper
  (`src/util.js`), not `===`, so a wrong secret can't be distinguished from a right one by
  response time.
- **SQL injection**: every user-controlled value goes through parameterized (`$1`, `$2`, ...)
  queries via `pg`.
- **XSS**: every user-controlled field rendered into the DOM goes through an `escapeHtml()`
  helper before insertion.
- **No CORS**: every page fetches `api/...` as a relative path, so frontend and backend are
  always same-origin — no `Access-Control-Allow-Origin` header is sent at all.
- Error responses never leak internal detail unless `APP_DEBUG=1` is explicitly set.

## Files

```
index.html         Landing page: Admin / Volunteer
volunteer.html      Volunteer login: Ticket Allocation, Update/Reassignment, Check-in Scan
admin.html          Admin login: Sales + Transport Buses dashboards
vendor/jsQR.js      Pure-JS QR decoder (MIT licensed)
server.js           Express app entry point, static file serving + API mount
src/db.js           Postgres pool, schema creation (no data seeding), rate-limit helpers
src/auth.js         JWT signing/verification, role/hub-scope guards
src/errors.js       HttpError + asyncHandler
src/util.js         Timing-safe string comparison
src/routes/         auth.js, hubs.js (timeslots read), buses.js, tickets.js, dashboard.js
```
