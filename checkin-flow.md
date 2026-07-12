# Check-in Flow — Team Walkthrough

This describes how the shuttle check-in system (`checkin.html`) works end to end: the
full round trip a rider takes, who's responsible for each step, and exactly what each
role sees and does. Use this to walk the team through training.

## The journey, in one picture

Every rider makes a 4-leg round trip. Each leg is its own independent bus trip — a bus
isn't tracked across legs, so a bus that just did an O1 run doesn't "remember" that
trip once it's time to do an R2 run later.

```
 Hub                Central              Venue
  |--- O1 (bus) --->  |--- O2 (bus) --->   |
  |                   |                    |  (event happens)
  |<-- R2 (bus) ----  |<-- R1 (bus) -----  |
```

| Leg | From → To         | Created/boarded by | Marked arrived by |
|-----|--------------------|---------------------|--------------------|
| O1  | Hub → Central      | Hub volunteer       | Central            |
| O2  | Central → Venue    | Central             | Venue              |
| R1  | Venue → Central    | Venue               | Central            |
| R2  | Central → Hub      | Central             | Hub volunteer      |

Note the pattern: whoever creates/boards a trip is at the *origin*; whoever marks it
arrived is at the *destination*. The one exception — either side can mark a trip
arrived, not just the receiving end. This is so a volunteer who physically rides along
with the bus can confirm arrival themselves without needing a separate login at the
other end.

## Signing in

Everyone signs in from the same page, `checkin.html`, which has three top-level tabs:
**Hubs**, **Central**, **Venue**. Each tab is its own independent login/session — being
signed into one doesn't affect the others, and switching tabs never signs you out of
anything.

- **Hubs**: pick your login from a dropdown, enter the password. If your login covers
  more than one hub, a "Current Location" switcher appears right after sign-in — this
  is important, see the callout below.
- **Central** / **Venue**: single fixed login shared by whoever's working that station
  that day (password only, no login picker).

Sign out lives in the top-right corner of the header, same as the volunteer/admin
pages, and only shows up for whichever role tab is currently active and signed in.

---

## Hub volunteer

**Tabs: Departures / Arrivals**

### Departures (O1 — Hub → Central)
1. Tap **New Trip**, enter the bus's license plate.
2. Scan tickets one at a time as riders board. Each scan shows a running onboard count.
3. If a scanned code isn't a real ticket, the system treats it as a forgotten-ticket
   walk-up: it creates a new standby ticket tied to your hub on the spot and boards it
   immediately — no separate step needed.
4. Once at least one person has boarded, **Mark Departed** becomes available. Tap it
   when the bus is full and ready to leave.
5. A ticket can only board a given O1 trip once — rescanning the same code again (same
   leg) is rejected.

### Arrivals (R2 — Central → Hub)
- Shows buses currently en route back to your hub.
- Tap **Mark Arrived** once the bus has physically pulled in. (Central may have already
  done this if a volunteer rode along — either side marking it is fine, whichever
  happens first "wins.")

### The hub switcher (multi-hub logins only)
If your login covers more than one hub, a "Current Location" dropdown sits at the top
of your screen. **Everything you do — scanning, creating a trip, standby issuance — is
attributed to whichever hub is currently selected.** If you physically move to a
different hub partway through the day, switch it first. Forgetting to switch doesn't
throw an error — it will silently attribute a scan to the wrong hub. This is the single
most important thing to get right in training if you have multi-hub volunteers.

---

## Central

**Tabs: Arrivals / Send to Venue / Send to Hub**

Central sits in the middle of the journey and has three separate jobs, one per tab.

### Arrivals (O1 + R1 — buses arriving from Hubs and from Venue)
- Shows every bus currently en route to Central, from either direction, in one list.
- Tap **Mark Arrived** as each bus pulls in.
- Since this list combines two different legs, check the route label on each card
  (e.g. "Surrey → Central" vs. "Venue → Central") rather than relying on list order —
  the two legs aren't interleaved by time, just listed one after the other.

### Send to Venue (O2 — Central → Venue)
- Same shape as Hub's Departures: New Trip → license plate → scan tickets → Mark
  Departed once at least one person's boarded.
- As a passive, informational-only check, the scan screen shows when a rider last
  boarded their O1 leg (so you can visually catch someone trying to board out of
  order) — but it never blocks the scan. Riders who arranged their own transport to
  Central are allowed to board O2 without ever having boarded an O1 bus.

### Send to Hub (R2 — Central → each rider's home hub)
- **You do not decide which hub gets the next bus — admin calls that.** Once admin
  tells you (in person, since you're both at Central), pick that hub from the
  **Destination Hub** dropdown, enter the license plate, and create the trip.
- Each option in the dropdown shows a live waiting count for that hub — that's there so
  you can sanity-check what admin told you against what you're seeing, not so you can
  make the call yourself.
- Scan tickets same as any other leg. **One thing R2 checks that others don't:** if a
  scanned ticket's home hub doesn't match the hub this bus is signed for, you'll get an
  amber "Wrong bus" warning and the scan is rejected — that ticket belongs on a
  different R2 bus. This is the one leg where a mis-scan is actively caught by the
  system instead of just relying on the volunteer to notice.

---

## Venue

**Tabs: Arrivals / Departures**

### Arrivals (O2 — Central → Venue)
- Shows buses en route from Central. Tap **Mark Arrived** as each pulls in.

### Departures (R1 — Venue → Central)
- Same New Trip → scan → Mark Departed pattern as every other origin-side tab.

---

## Admin

Admin has two separate things going on: read-only dashboards for situational awareness,
and a status-override tool for fixing mistakes. Admin does **not** have its own
scan/board interface — dispatch decisions get relayed to Central verbally since you're
co-located.

### Dashboards (`admin.html`)
- **Sales**: per-hub timeslot capacity/allocation/boarded/returned, plus a Standby row
  and daily sales chart.
- **Departing** (O1/O2 funnel): Departed Hubs (cumulative) → En Route to Central → At
  Central → En Route to Venue → Arrived at Venue, plus Avg Wait at Central.
- **Returning** (R1/R2 funnel): mirror image, plus **Waiting at Central, by Hub** — this
  is the number you use to decide which hub gets the next R2 bus. It also shows
  "En Route to Central" per hub so you can see what's about to add to the backlog, not
  just what's already waiting.

### Status overrides
Every trip card (Departing/Returning tabs) has a 3-dot menu for fixing a mis-tap,
scoped to whatever's actually valid for that trip's current status:
- **Boarding** → Mark Departed
- **Departed** → Mark Arrived, or Undo Departed (reverts to Boarding)
- **Arrived** → Undo Arrived (reverts to Departed)

Every action asks for confirmation first. There's currently no "undo" for an individual
mis-scanned ticket (only whole-trip status) — if the wrong ticket gets scanned onto a
trip, that has to be handled as a one-off outside the app for now.

---

## Ticket lifecycle, at a glance

A ticket carries four independent leg records (`trip1`–`trip4`, one per O1/O2/R1/R2).
Each can only be set once — a ticket can't board the same leg twice, but boarding one
leg has no effect on the others.

| Leg | What "boarded" means for a ticket |
|-----|-------------------------------------|
| O1  | Scanned onto a Hub→Central bus |
| O2  | Scanned onto a Central→Venue bus |
| R1  | Scanned onto a Venue→Central bus |
| R2  | Scanned onto a Central→Hub bus (must match the ticket's home hub) |

"Boarded" and "Returned" on the Sales dashboard are computed from these fields directly
— there's no separate manual bookkeeping step anywhere in the system.

## Training priorities, if time is short

1. **Hub multi-hub switcher** — the one mistake that fails silently instead of erroring.
2. **Central's three tabs** — make sure whoever's at Central knows which tab covers
   which direction before the event starts; it's the only station juggling three jobs.
3. **R2's wrong-hub warning** — good news, the system catches this one for you; just
   make sure volunteers know an amber toast means "try a different bus," not "broken."
4. Everything else (Hub Departures/Arrivals, Venue's two tabs) is scan → button →
   confirm, and shouldn't need more than a couple minutes of walkthrough per person.
