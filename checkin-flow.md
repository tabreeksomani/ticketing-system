# Check-in Flow — Team Walkthrough

This describes how the shuttle check-in system (`checkin.html`) works end to end: the
full trip a rider takes, who's responsible for each step, and exactly what each role
sees and does. Use this to walk the team through training.

## The journey, in one picture

Every rider makes a round trip. Each leg is its own independent bus trip — a bus isn't
tracked across legs, so a bus that just did an O1 run doesn't "remember" that trip once
it's time to do an R2 run later.

**Outbound has two possible paths**, chosen per-trip by whoever's at the hub:

```
 Hub                 Central              Venue
  |--- O1 (bus) ---->  |--- O2 (bus) --->   |
  |------------------- O1 direct to VCC --->|   (event happens)
  |<-- R2 (bus) -----  ×  (no R1 anymore)    |
```

- **O1 → Central** (the default): the usual relay through Central, then O2 onward to
  the venue.
- **O1 → VCC**: the same O1 trip, but the hub volunteer picks "VCC" as the destination
  instead of "Central" — the bus goes straight to the venue, skipping Central and O2
  entirely for those riders.
- **The way home is R2 only, and it isn't tracked end to end.** There is no R1
  (Venue → Central) leg anymore — Venue doesn't scan anyone leaving. R2 itself is
  created and boarded at Central, but nobody scans or taps to confirm it actually made
  it back to the hub — that "mark arrived" step is gone too. The last tracked moment
  for a returning rider is boarding the R2 bus at Central; everything after that (the
  drive home, arrival) is untracked.

| Leg | From → To                  | Created/boarded by | Marked arrived by |
|-----|------------------------------|---------------------|--------------------|
| O1  | Hub → **Central or VCC**     | Hub volunteer       | Central (if →Central) or Venue (if →VCC), decided per-trip |
| O2  | Central → Venue              | Central             | Venue              |
| R2  | Central → Hub                | Central             | *Nobody* — untracked, same as R1 |

Whoever creates/boards a trip is at the *origin*; whoever marks it arrived is at the
*destination* — except O1 (destination chosen per-trip) and R2 (nobody marks it arrived
at all anymore). Elsewhere, either side of a leg can mark it arrived, not just the
receiving end, so a volunteer who physically rides along with the bus can confirm
arrival themselves without a separate login at the other end.

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

**One tab: Departures only.** Hub's job is entirely outbound now — there's no arrivals
screen, since R2 (the bus bringing riders back) is no longer confirmed arrived by
anyone (see above).

### Departures (O1 — Hub → Central *or* VCC)
1. Tap **New Trip**.
2. Pick the **Destination**: **Central** (default) or **VCC**. Central is the normal
   relay-through-the-middle route; VCC sends the bus straight to the venue, skipping
   Central and O2 for everyone on it. This choice is shown clearly on the trip list and
   the scanning screen afterward, so it's always obvious which one a given bus is doing.
3. Enter the bus's license plate.
4. Scan tickets one at a time as riders board. Each scan shows a running onboard count.
5. **Lost/forgotten ticket?** Scan or type any code that isn't a real ticket and the
   system treats it as a walk-up standby: it creates a new ticket tied to your hub on
   the spot and boards it immediately, no separate step needed. (This same
   forgotten-ticket handling now works on Central's legs too — see below.)
6. Once at least one person has boarded, **Mark Departed** becomes available. Tap it
   when the bus is full and ready to leave.
7. A ticket can only board a given O1 trip once — rescanning the same code again is
   rejected.

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

### Arrivals (buses arriving from Hubs — Central-bound O1 trips only)
- Shows every O1 bus currently en route to Central (i.e. hub buses that picked
  "Central," not "VCC," as their destination).
- Tap **Mark Arrived** as each bus pulls in.

### Send to Venue (O2 — Central → Venue)
- Same shape as Hub's Departures: New Trip → license plate → scan tickets → Mark
  Departed once at least one person's boarded.
- As a passive, informational-only check, the scan screen shows when a rider last
  boarded their O1 leg (so you can visually catch someone trying to board out of
  order) — but it never blocks the scan. Riders who arranged their own transport to
  Central are allowed to board O2 without ever having boarded an O1 bus.
- **Lost ticket at this stage?** Same forgotten-ticket flow as Hub — but since a rider
  showing up here could be from *any* hub, you'll be asked to pick which hub they're
  from before the standby ticket is issued. Get this right: it's what lets that rider
  board the correct R2 bus home later.

### Send to Hub (R2 — Central → each rider's home hub)
- **You do not decide which hub gets the next bus — admin calls that**, in person,
  since you're both at Central. There's no "waiting count" shown here anymore to hint
  at it (see the callout below on why) — it's purely admin's real-world call, relayed
  to you verbally.
- Pick that hub from the **Destination Hub** dropdown, enter the license plate, and
  create the trip.
- Scan tickets same as any other leg. **One thing R2 checks that others don't:** if a
  scanned ticket's home hub doesn't match the hub this bus is signed for, you'll get an
  amber "Wrong bus" warning and the scan is rejected — that ticket belongs on a
  different R2 bus.
- Lost ticket on an R2 bus works too, and needs no extra prompt — the standby is
  automatically tied to whichever hub this specific bus is headed to.

---

## Venue

**Tab: Arrivals only**

Venue's job is purely receiving buses — there is no departures/scanning step for the
way home anymore.

### Arrivals (buses arriving from Central, or straight from a Hub)
- Shows two kinds of incoming buses in one list, distinguished by their route label:
  regular **O2** buses from Central, and any **O1** bus a hub volunteer sent straight to
  VCC instead of via Central.
- Tap **Mark Arrived** as each pulls in.

After this, riders have no further tracked step until they board an R2 bus back to
their home hub at Central — there's nothing to scan in between.

---

## Admin

Admin has two separate things going on: read-only dashboards for situational awareness,
and a status-override tool for fixing mistakes. Admin does **not** have its own
scan/board interface — dispatch decisions get relayed to Central verbally since you're
co-located.

### Dashboards (`admin.html`)
- **Sales**: per-hub timeslot capacity/allocation/boarded/returned, a Standby row,
  Adult/Child fare split, and daily sales charts.
- **Departing** (O1/O2 funnel): Departed Hubs (cumulative) → En Route to Central → At
  Central → En Route to Venue → Arrived at Venue, plus Avg Wait at Central. Only counts
  Central-bound O1 trips in the "En Route/At Central" stages — a VCC-direct trip skips
  straight to "En Route to Venue"/"Arrived at Venue" instead, since it never touches
  Central at all.
- **Returning** (R2 only): just one number, grouped by destination hub — total riders
  who've boarded an R2 bus for each hub. This used to be a multi-stage funnel mirroring
  Departing, but that depended on R1 tracking data that can no longer exist once Venue
  stopped scanning departures — so it's deliberately simple now: a running total, not a
  live snapshot of who's "waiting."
- **Report**: a separate, screenshot-friendly view built for sending to leadership —
  fixed layout, not meant for day-to-day monitoring like the other three tabs.

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

A ticket carries independent leg records, one per leg it actually travels
(`trip1`/`trip2`/`trip4` for O1/O2/R2 — `trip3`/R1 is defined in the schema but nothing
writes to it anymore). Each can only be set once — a ticket can't board the same leg
twice, but boarding one leg has no effect on the others.

| Leg | What "boarded" means for a ticket |
|-----|-------------------------------------|
| O1  | Scanned onto a Hub→Central or Hub→VCC bus |
| O2  | Scanned onto a Central→Venue bus |
| R2  | Scanned onto a Central→Hub bus (must match the ticket's home hub) |

"Boarded" and "Returned" on the Sales dashboard are computed from these fields directly
— there's no separate manual bookkeeping step anywhere in the system.

## Training priorities, if time is short

1. **Hub's Central vs. VCC choice** — new, and it changes who's responsible for marking
   that specific trip arrived (Central or Venue). Make sure hub volunteers understand
   both options exist and pick deliberately, not by habit.
2. **Hub multi-hub switcher** — the one mistake that fails silently instead of erroring.
3. **Central's three tabs**, especially that Send to Hub no longer shows any waiting
   count — the dispatch call is 100% admin telling you verbally now.
4. **R2's wrong-hub warning** — good news, the system catches this one for you; just
   make sure volunteers know an amber toast means "try a different bus," not "broken."
5. **Lost tickets can be handled anywhere now** (Hub, Central's two departure tabs), not
   just at the hub — just know that on Central's "Send to Venue" screen specifically,
   you'll be asked which hub the rider is from.
6. Everything else (Hub's single tab, Venue's single tab) is scan → button → confirm,
   and shouldn't need more than a couple minutes of walkthrough per person.
