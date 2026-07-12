# Transportation Ticketing System

Sells pre-printed QR-coded tickets at multiple transport hubs and tracks passengers as they
board hub buses.

Stack: Node/Express + Postgres, no build step, no frontend framework — two static HTML portals
talking to one JSON API.

## Quick start (for a new collaborator/environment)

Requires [Docker](https://www.docker.com/) (for a local Postgres - `docker compose`
must work) and Node.

```bash
git clone https://github.com/tabreeksomani/ticketing-system.git
cd ticketing-system
npm install
npm run setup   # starts Postgres, creates .env, seeds example data, starts the server
```

That's genuinely the whole thing - `npm run setup` starts Postgres via
`docker-compose.yml` (port 5433, not 5432, to avoid clashing with a Postgres
install you might already have running natively), waits for it to be ready,
creates `.env` from `.env.example` if one doesn't exist, seeds
`scripts/example.json` (placeholder hubs/passwords - see **Manual setup**
below), and starts the server at `http://localhost:8000`.

Pass a different file to seed real data instead of the placeholder example:

```bash
npm run setup -- scripts/your-real-data.json
```

Safe to re-run — `docker compose up -d` no-ops if Postgres is already running,
`.env` is never overwritten if it already exists, and `scripts/seed.js` upserts
(updates existing hubs/logins/timeslots instead of duplicating them). The
Postgres container keeps running in the background after the script exits
(`docker compose down` in the project folder stops it).

If you'd rather not use Docker, point `DATABASE_URL` in `.env` at any other
Postgres instance you have access to, then run `npm start` directly instead
of `npm run setup` (which assumes Docker).

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

Nothing about hubs, timeslots, buses, or logins is created through the app - no CRUD API, no
admin forms. Two ways to populate them:

- **`node scripts/seed.js path/to/data.json`** (or `npm run setup -- path/to/data.json`) - reads
  a JSON file describing hubs, their timeslots, and login passwords, and upserts everything in
  one shot. See `scripts/example.json` for the expected shape. Safe to re-run with updated
  numbers - existing rows get updated in place, not duplicated.
- **Raw `psql`**, for one-off tweaks or anything the seed script doesn't cover (like buses):

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
3. **Check-in Scan** (`volunteer.html`) lets a volunteer pick a bus from a dropdown and
   scan tickets onto it. The first scan flips the bus from `scheduled` to `boarding`. Scanning an
   unrecognized code issues it as a brand-new **standby ticket** on the spot (see below).
   "Complete & Depart" locks further boarding and timestamps the departure.

All ticket codes are expected to start with the prefix `MLEBC` - every scan handler on
`volunteer.html` (Allocation, Update/Reassignment, Check-in Scan) rejects anything else
instantly, client-side, with sound/vibration feedback, before it ever reaches the API.

## Ingress tracking (one scan per ticket)

Once a ticket has been scanned onto any bus at Check-in Scan, it's marked `is_ingressed` and
can't be scanned again - a second attempt is rejected with "This ticket has already been
scanned in and cannot be scanned again until egress." There's a matching `is_egressed` column
already in the `tickets` table, but nothing sets it yet - no egress trigger has been decided,
so today this is effectively "once, ever" per ticket.

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

- **Sales**:
  - **Total Allocated** — a single headline number, total tickets sold across every hub.
  - **Hubs Overview** — one row per hub: hub, time to central, capacity, allocated, remaining.
  - **Daily Sales by Khane** — a bar graph of tickets sold per day, with a checkbox multiselect
    (one per hub, defaults to all checked) to include/exclude hubs from the daily totals. Days
    are bucketed by **Pacific-time calendar day** (`sold_at AT TIME ZONE 'America/Los_Angeles'`),
    not UTC day.
  - Per-hub cards (tap to expand) — sold/capacity, boarded, standby issued, and a per-timeslot
    table (departure, capacity, allocated, remaining, boarded) with a totals row.
- **Transport Buses** — every bus grouped by status: scheduled, boarding, departed, arrived.

Departure times are always displayed in **Pacific Time**, regardless of the viewing device's own
timezone setting - the stored `departure_time` text is parsed as Pacific wall-clock time
directly, not reinterpreted through the browser's local timezone (which would show a different
clock time to someone viewing from outside Pacific otherwise).

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
   tables) creates itself on first request - the *rows* in it don't (see Manual setup above, or
   run `npm run setup -- your-data.json` to seed them).
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

## Health Check

The app provides a health check endpoint at `/health` (and `/api/health`) that reports the application and database connectivity status.
* **Status Codes**: Returns `200 OK` if the system is fully operational, or `503 Service Unavailable` if the database is down or connection timeouts occur.
* **Caching (60s TTL)**: To prevent load balancer pings from overloading the database, successful results are cached in memory for **60 seconds**. Failed health checks are cached for only **5 seconds** to allow fast recovery discovery.

## Connection Pooling

The PostgreSQL client uses connection pooling with tuning configurations that can be overridden in the `.env` file:
* `DATABASE_POOL_MAX` (default: `10`): Maximum active connections.
* `DATABASE_POOL_MIN` (default: `4`): Minimum idle connections kept pre-warmed.
* `DATABASE_POOL_CONNECTION_TIMEOUT_MS` (default: `10000`): Pool checkout timeout.
* `DATABASE_STATEMENT_TIMEOUT_MS` (default: `60000`): SQL execution limit.
* `DATABASE_LOCK_TIMEOUT_MS` (default: `10000`): Row lock acquisition limit.
* `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` (default: `30000`): Idle transaction limit.

## Database Migrations

Database schema changes (adding tables, indexes, or modifying columns) are decoupled from application startup and managed sequentially via raw `.sql` files in the `migrations/` directory.

### Running Migrations
To check for and apply any pending database migrations:
```bash
npm run db:migrate
```
*Note: In development, `npm run setup` automatically runs all migrations before seeding.*

### Creating a New Migration & Safety Checks
To add a schema change:
1. Create a new `.sql` file in the `migrations/` folder.
2. Prefix it with the next sequential 3-digit number (e.g. `migrations/002_add_discount_code.sql`).
3. Write standard, raw SQL statement(s).
4. Run `npm run db:migrate` locally to verify that it executes and applies successfully.

#### 🛡️ Migration Safety Check (Linter)
To prevent accidental data loss or backward-compatibility breaks in production (e.g. during rolling deploys), a static analysis linter script blocks destructive DDL operations:
* **Blocked Actions**:
  * `DROP TABLE` (prevent accidental table deletion)
  * `DROP COLUMN` or `ALTER TABLE ... DROP` (prevent active column deletion)
  * `RENAME COLUMN` or `RENAME TO` (prevent breaking active database references)
  * `ALTER COLUMN ... TYPE` or `SET DATA TYPE` (prevent data type mismatch crashes)
  * `CREATE INDEX` without `CONCURRENTLY` (prevent locking table writes during index build)
  * `TRUNCATE` (prevent accidental table wipes)
  * `ADD COLUMN ... NOT NULL` without `DEFAULT` (prevent database errors when adding columns to populated tables)
* **Git Pre-commit Hook**: Running `npm run setup` automatically installs a local Git pre-commit hook. If you attempt to commit a migration that contains one of the blocked operations, `git commit` will fail.
* **PR / CI Build Failures**: Any PR build running `npm test` will run the migration linter and fail if a destructive migration is detected.

#### 🔓 How to Bypass Safety Checks
If a destructive migration is genuinely intended (e.g. dropping a temporary table, or cleanup during scheduled maintenance):
* **Bypass via Comment (Recommended)**: Add the following comment anywhere in the SQL file:
  ```sql
  -- safety-bypass: allow-destructive-operations
  ```
  This is the recommended way, as it explicitly documents the intentional nature of the change in version control.
* **Bypass via CLI Override**: Run the migration runner with the `--force` argument:
  ```bash
  npm run db:migrate -- --force
  ```
* **Bypass via Environment Override**: Run with the `ALLOW_DESTRUCTIVE_MIGRATIONS=true` environment variable:
  ```bash
  ALLOW_DESTRUCTIVE_MIGRATIONS=true npm run db:migrate
  ```



### Tracking Applied Migrations
All executed migrations are recorded in the `schema_migrations` table in your database. The runner compares this list against files in the `migrations/` directory to ensure each script runs exactly once.

### Startup Behavior Config
By default, the server performs a non-blocking check on boot to verify if any migrations are pending. You can configure this behavior in your `.env` file using the `DATABASE_MIGRATION_BEHAVIOR` variable:
* `WARN` (default): Prints a warning block in console logs listing all pending files, but boots normally.
* `KILL`: Outputs a fatal error and terminates the process (`process.exit(1)`) immediately, preventing the server from starting.
* `IGNORE`: Bypasses migration checking entirely.


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
src/routes/         auth.js, hubs.js, buses.js, tickets.js, dashboard.js, health.js
docker-compose.yml  Local Postgres for development (started by `npm run setup`)
scripts/setup.js    One-command run: starts Postgres, creates .env, seeds, starts the server
scripts/seed.js     Manual bulk setup: upserts hubs/timeslots/logins from a JSON file
scripts/example.json  Placeholder data matching seed.js's expected shape
```
