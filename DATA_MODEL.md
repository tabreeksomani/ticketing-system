# Data Model

Postgres schema, built up across `migrations/001_init.sql` through `008_incidents.sql`.

## hubs
Physical origin/return points (not venue, not central).

| column | type | notes |
|---|---|---|
| id | TEXT PK | slug, e.g. `'north'` |
| name | TEXT | unique |
| travel_minutes | INT | default 30 |
| opened_at | TIMESTAMPTZ | null = not yet opened today |
| closed_at | TIMESTAMPTZ | null = open; guards against new O1 trips once set |

## timeslots
What a ticket is sold against.

| column | type | notes |
|---|---|---|
| id | SERIAL PK | |
| hub_id | TEXT FK → hubs | |
| departure_time | TEXT | wall-clock string |
| capacity | INT | |

`sold`/`available`/`boarded`/`returned` are never stored — always `COUNT(tickets ...)` computed live.

## tickets
One row per rider ticket. The single source of truth for a rider's progress through all 4 legs of the round trip.

| column | type | notes |
|---|---|---|
| id | SERIAL PK | |
| code | TEXT | unique, scanned/typed at check-in |
| hub_id | TEXT FK → hubs | rider's home hub |
| timeslot_id | INT FK → timeslots | null for standby |
| fare_type | TEXT | 'adult' \| 'child' (app-level allow-list, no CHECK) |
| is_standby | BOOL | walk-up / lost-ticket issued on the spot |
| sold_at | TIMESTAMPTZ | |
| trip1_id / trip1_boarded_at | INT FK → bus_trips | leg O1: hub → central |
| trip2_id / trip2_boarded_at | INT FK → bus_trips | leg O2: central → venue |
| trip3_id / trip3_boarded_at | INT FK → bus_trips | leg R1: venue → central (dead — no boarding screen anymore) |
| trip4_id / trip4_boarded_at | INT FK → bus_trips | leg R2: central → hub (return home) |
| is_ingressed / is_egressed | BOOL | legacy flags, predate the trip-leg model |
| leg1_bus_id, leg1_boarded_at, leg2_bus_id, leg2_boarded_at, returned_at | — | legacy, predate `bus_trips`; superseded by trip1-4 |

A rider's exact state is fully derivable from which `tripN_id` columns are null vs set — no separate status field needed.

## bus_trips
One row per bus per leg (a bus is not tracked across legs — each leg gets its own row).

| column | type | notes |
|---|---|---|
| id | SERIAL PK | |
| license_plate | TEXT | |
| leg | TEXT | 'O1' \| 'O2' \| 'R1' \| 'R2' |
| origin / destination | TEXT | hub id, or 'central' / 'venue' |
| status | TEXT | 'scheduled' → 'boarding' → 'departed' → 'arrived' |
| boarding_started_at / departed_at / arrived_at | TIMESTAMPTZ | |
| created_by | TEXT FK → logins | |
| created_at | TIMESTAMPTZ | |

**Onboard count** for a trip = `COUNT(tickets WHERE trip{N}_id = this trip)`, where N is picked by `leg`. Never stored on the row.

## logins / login_hubs
Auth. `logins`: `id, role, secret, name` (role ∈ volunteer/central/venue/admin/parking_*). `login_hubs`: many-to-many join — one volunteer login can cover several hubs.

## incidents
Ad hoc issue log against a bus, admin-facing.

| column | type | notes |
|---|---|---|
| id | SERIAL PK | |
| license_plate | TEXT | not FK'd to bus_trips — a plate, not a specific trip |
| description | TEXT | |
| status | TEXT | 'open' \| 'resolved' |
| created_by | TEXT FK → logins | |
| created_at / resolved_at | TIMESTAMPTZ | |

## parking_lots
Separate feature, unrelated to the ticketing/transport flow above.

| column | type | notes |
|---|---|---|
| id | SERIAL PK | |
| name | TEXT | |
| total_stalls / available_stalls | INT | available null until a marshal reports |
| status | TEXT | 'available' \| 'full' |
| distance_value / distance_unit | REAL / TEXT | for sorting near→far |
| rate | TEXT | free text |
| updated_at / created_at | TIMESTAMPTZ | |

## Relationships at a glance

```
hubs 1──* timeslots
hubs 1──* tickets
timeslots 1──* tickets
logins *──* hubs      (via login_hubs)
logins 1──* bus_trips (created_by)
logins 1──* incidents (created_by)
tickets *──1 bus_trips   (via trip1_id, trip2_id, trip3_id, trip4_id — 4 separate FKs)
```

`buses` (from `001_init.sql`) is legacy/dormant — superseded by `bus_trips`, kept only for the old `tickets.leg1_bus_id`/`leg2_bus_id` columns.
