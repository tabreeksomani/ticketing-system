# Full System Demo — Happy & Sad Paths, Every Role

A walkthrough script for demoing the whole system end to end: selling a ticket,
checking it in through all three legs, and watching it show up on the admin
dashboards — plus every "sad path" (lost ticket, wrong bus, duplicate scan,
license plate conflict, etc.) baked in at the point where it naturally comes up.

Run the sections in order the first time — later ones assume tickets sold or
boarded in earlier ones. Pick **fresh ticket codes** each time you re-run this
(the codes below are examples, not fixed values) — a code can only be sold
once and only boards a given leg once, so re-running with the same codes will
just hit "already sold" / already-boarded errors.

## Cast & logins

All three apps are separate logins, all password `password` in local dev:

| App | URL | Who | Login |
|---|---|---|---|
| `volunteer.html` | ticket sales/lookup | Hub volunteer, pre-event | pick hub from dropdown (e.g. `surrey`) |
| `checkin.html` | day-of scanning | Hub / Central / Venue | **Hubs** tab → pick login; **Central**/**Venue** tabs → just password |
| `admin.html` | dashboards + overrides | Admin | `admin` |

Local dev already has demo bus activity seeded across Surrey, Abbotsford,
Burnaby Lake, Downtown, Maple Ridge, and Tricities (see
`scratchpad/seed-demo-buses.js`) — Central/Venue/Admin sections below will
show real numbers even before you do anything.

---

## 1. Sell a ticket (Volunteer → Allocate Ticket)

**Happy path**
1. Log into `volunteer.html` as `surrey`.
2. **Allocate Ticket** tab → pick a timeslot (e.g. the 2:00 AM slot).
3. Scan/type 3 fresh codes, e.g. `WALK101`, `WALK102`, `WALK103`.
4. Set the child count to `1` (first scanned code becomes `fare_type: child`,
   the rest `adult`) — confirms the adult/child split shows up correctly
   later on the Sales dashboard.
5. Finalize the sale. All 3 should show as sold.

**Sad path — duplicate code**
6. Try to sell `WALK101` again (same code, same or different timeslot).
   Expect a per-code rejection: "Already sold" — the other codes in a mixed
   batch still succeed; only the duplicate is rejected.

**Sad path — overselling a timeslot**
7. Try to sell more codes than the timeslot's remaining capacity (check the
   Sales dashboard first for a near-full slot, or sell into a small-capacity
   slot repeatedly). Expect a 409: `Only N seat(s) left in that timeslot for
   M ticket(s)` — the whole batch is rejected, nothing partially sold.

**Sad path — standby**
8. Switch "Standby" on instead of picking a timeslot, sell `WALKSTANDBY1`.
   No capacity check applies; it's issued with no `timeslot_id`.

---

## 2. Hub departure (Check-in → Hubs → Departures, leg O1)

Log into `checkin.html` → **Hubs** tab → `surrey` / `password`.

**Happy path**
1. Tap **New Trip**. Destination: leave as **Central** (default).
2. License plate: `DEMOPLATE1`.
3. Scan `WALK101`, `WALK102`, `WALK103` one at a time — onboard count ticks
   up each time.
4. Tap **Mark Departed** (only enabled once ≥1 rider has boarded).

**Sad path — lost/forgotten ticket → walk-up standby**
5. Start a second trip, plate `DEMOPLATE2`, destination Central.
6. Scan a code that was never sold, e.g. `LOSTRIDER1`. Instead of an error,
   it's silently issued as a walk-up standby ticket tied to Surrey and
   boarded immediately — no separate step.

**Sad path — can't board the same ticket twice**
7. On `DEMOPLATE2`, scan `WALK101` again (already boarded on `DEMOPLATE1`).
   Expect a rejection — a ticket can only board a given leg once.

**Sad path — duplicate license plate while active**
8. Try **New Trip** with plate `DEMOPLATE1` again, *before* departing/undoing
   the first one. Expect a 409: `Bus DEMOPLATE1 already has an active trip in
   progress — depart or complete that one first`. Depart or complete the
   original trip, then retry — it should succeed (plates are reusable once
   the previous trip has departed).

**Sad path — Undo Scan**
9. On `DEMOPLATE2` (still boarding), tap **Undo** next to "Last scanned" to
   remove `LOSTRIDER1` from the trip. Confirm the onboard count drops back
   down. (This does not delete the ticket, just un-boards it from this leg.)

**Sad path — timeslot early/late warning**
10. Scan a ticket whose timeslot is more than ~30 minutes away from right now
    (wall-clock). Expect a non-blocking amber toast, e.g. "their 2:00 AM
    timeslot is 46 min early" — the scan still succeeds, it's advisory only.

**Happy path — VCC-direct**
11. Start a third trip, plate `DEMOPLATE3`, destination **VCC** this time.
    Board `WALKVCC1` (a fresh code sold to Surrey), Mark Departed. This bus
    skips Central/O2 entirely — confirm in section 4 it shows up directly on
    Venue's Arrivals list.

---

## 3. Central (Check-in → Central)

Log into `checkin.html` → **Central** tab → `password`.

### Arrivals (O1 buses inbound, Central-bound only)
**Happy path**
1. Find `DEMOPLATE1` (departed in step 2.4) in the Arrivals list.
2. Tap **Mark Arrived**.
3. Confirm `DEMOPLATE3` (the VCC-direct one) does **not** appear here — it
   only shows on Venue's list, never Central's.

### Send to Venue (O2 — Central → Venue)
**Happy path**
4. **New Trip**, plate `DEMOPLATE4`.
5. Scan `WALK101`/`WALK102`/`WALK103` (now arrived at Central). The scan
   screen passively shows each rider's O1 boarding time — informational only,
   never blocks.
6. Mark Departed.

**Sad path — lost ticket needs a hub picked**
7. On a new O2 trip (or the same one before departing), scan an unknown code,
   e.g. `LOSTVENUE1`. Since O2 has no natural home hub (origin/destination
   are `central`/`venue`, not real hubs), you'll be prompted to pick the
   rider's home hub from a list before the standby ticket is issued. Pick
   `abbotsford`. Confirm it boards immediately after you choose.

### Send to Hub (R2 — Central → each rider's home hub)
**Happy path**
8. Pick **Destination Hub**: `surrey`. Plate `DEMOPLATE5`. New Trip.
9. Scan `WALK101` (home hub is Surrey) — boards normally.

**Sad path — wrong bus**
10. On the same `DEMOPLATE5` (destination Surrey), scan a ticket whose home
    hub is Abbotsford (e.g. `LOSTVENUE1` from step 7, or any existing
    Abbotsford ticket). Expect an amber confirm modal: *"Wrong bus — this
    ticket is for Abbotsford, not Surrey. Board them on this bus anyway?"*
    with **Cancel** / **Board Anyway** buttons.
    - Tap **Cancel** first — confirm nothing boards.
    - Retry the same scan, tap **Board Anyway** — confirm it now boards
      despite the mismatch (dispatcher's call, not a hard block).

**Sad path — lost ticket on R2**
11. Scan an unknown code on `DEMOPLATE5`, e.g. `LOSTHOME1`. No hub prompt
    needed this time — it's automatically tied to Surrey (this bus's
    destination).

---

## 4. Venue (Check-in → Venue)

Log into `checkin.html` → **Venue** tab → `password`.

**Happy path**
1. Arrivals list should show **two** buses: `DEMOPLATE4` (O2, from Central)
   and `DEMOPLATE3` (O1, direct VCC) — each labeled with its route so you can
   tell them apart.
2. Tap **Mark Arrived** on both.

There's nothing else to do at Venue — no departures/scanning for the way
home anymore (that's R2 at Central only, see section 3).

---

## 5. Admin dashboards & overrides (`admin.html`)

Log into `admin.html` as `admin`.

### Sales tab
- Confirm `WALK101`–`WALK103`'s timeslot row shows `boarded: 3`, `returned:
  1` (only `WALK101` went home via R2 so far), and the adult/child split
  reflects the `1` child from step 1.4.
- Check the Standby row picks up `WALKSTANDBY1`, `LOSTRIDER1`,
  `LOSTVENUE1`, `LOSTHOME1`.

### Departing (Ingress) tab
- Confirm Surrey's numbers reflect `DEMOPLATE1` (arrived at Central) and
  `DEMOPLATE3` (arrived at Venue, VCC-direct — counted straight into "Arrived
  at Venue", never touching "At Central").
- Try the hub filter dropdown — deselect all but Surrey, confirm the trip
  list narrows to just Surrey-origin trips.

### Returning (Egress) tab
- Confirm Surrey shows `Departed (Total)` ≥ `Returned (Total)`, with a
  positive `Outstanding` (Departed − Returned) — expected, since not
  everyone from earlier legs has boarded an R2 bus yet.

### Status overrides (3-dot menu on any trip card)
**Happy path**
1. Find a still-`boarding` trip (e.g. `DEMOPLATE2` if not yet departed) →
   3-dot menu → **Mark Departed** → confirm.
2. Find a `departed` trip → **Mark Arrived** → confirm.

**Sad path — undo**
3. On that same trip, 3-dot menu → **Undo Arrived** (reverts to departed) →
   confirm. Then **Undo Departed** (reverts to boarding) → confirm.

**Happy path — change destination**
4. Create a fresh `scheduled` trip if none exists (or use one you haven't
   boarded anyone onto yet) → 3-dot menu → **Change Destination**. For an O1
   trip, switch Central ↔ VCC; for an R2 trip, pick a different hub. Confirm
   the trip list reflects the change immediately.

**Sad path — can't change after boarding starts**
5. Board at least one rider onto a trip, then try **Change Destination**
   again. It should no longer appear in the menu at all (status is no longer
   `scheduled`) — confirming the gate that prevents re-routing riders who've
   already boarded.

### Report tab
- Just confirm it renders — stat tiles, the vertical stacked bar chart
  (Volunteer/General split, i.e. 2–3 AM timeslots vs. everything else), and
  a "Generated [timestamp]" line. This one's for screenshots, not
  interaction.

---

## 6. Ticket lookup & reassignment (Volunteer → View/Update Ticket)

Log into `volunteer.html` as `surrey`.

**Happy path**
1. **View Ticket** → look up `WALK101`. Confirm it shows sold/boarded status
   for O1/O2/R2 (whichever legs it's completed by now). Note: View Ticket has
   no hub restriction — any login can view any code, by design (it's
   read-only, not an action).
2. **Update Ticket** → look up `WALKSTANDBY1` (from step 1.8) → reassign it
   onto a real timeslot with available capacity. Confirm it now shows a
   `timeslot_id` instead of standby.

**Sad path — wrong hub (Update Ticket only)**
3. Log in as `abbotsford` instead, and try **Update Ticket** on `WALK101`
   (a Surrey ticket, not one of Abbotsford's). Expect a 403 — reassignment is
   scoped to hubs your login covers, unlike View Ticket above.

---

## Cleanup

Everything created in this walkthrough uses plate prefixes `DEMOPLATE*` and
ticket codes `WALK*`/`LOST*`, matching the existing demo-data convention
(`DEMOA*`, `DEMOB*`, `DEMOSTANDBY1`, `DEMO-BUS-*`) — safe to bulk-delete
later via a cleanup script once you're done testing.
