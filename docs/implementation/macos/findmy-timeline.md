# A Find My timeline: the build assignment

John, 2026-11-23, after reading every 5 minutes: “we should be able to create a location timeline, right?” He saw the
mockup (a Timeline tab: everyone's day as strips, one person's stops on a map and as a list, a week view, settings)
and answered its three questions: keep each day **30 days**; **only he** sees it; **Dusty can read it, on by default**.
“Build this.”

Until now Whombat keeps no history of where anyone was (`docs/decisions/macos-servers.md` MAC-55,
`docs/decisions/findmy-connection.md` FMC-21). The timeline changes that **only when the person turns it on, only for
the people they tick**, and only for 30 days. Everything else about Find My stays as it is.

Names in this file are made up (Noor, Ruben and Ilse, a Mac called Studio, towns Rietveen and Wilgendam).

## 1. What the person sees

The mockup is the visual reference: `docs/implementation/macos/findmy-timeline-mockup.html` (open it in a browser;
its top bar switches between the timeline, the screen before it's on, and its settings, and between light and dark).
It uses the web app's tokens; the build uses the real components and tokens and matches it.

1. **A Timeline tab** on a Find My connection's page, right after its Find My tab (both name the Mac:
   `ThingPageTab.server`). Older apps don't get it (§2.9).
2. **Before it's on**: one card. Title “Keep a timeline?”, the words of the mockup, the people of the Mac's last read
   as tick boxes (all unticked), the button “Keep a timeline” (disabled until someone is ticked), and the muted line
   “The people on it should know you keep it.” No read yet: “Whombat hasn’t read Find My yet. Read it once on the Find
   My tab, then choose people here.”
3. **When it's on**, from top to bottom:
   - A bar: previous and next day (back to 30 days ago, not past today), the day's name (“Today”, “Yesterday”, then
     “Saturday”, with the date beside it), and a **Day | Week** switch.
   - **Everyone**: one row per person on the Mac's last read. A kept person: avatar, first name, a 24-hour strip, and
     where they are now (today only). A person not kept: “Not kept · Keep Noor’s too” (the link ticks them). The strip
     colours a stay by its place (Find My's words: Home, School, a town), hatches “On the way”, leaves “Not read” and
     “No location” as dashed gaps, draws a line at now (today), and the axis says 00:00, 06:00, 12:00, 18:00, 24:00 and
     now. A legend of the day's places follows. The header's meta: “Reads every 5 minutes · last read 15:18”.
     Choosing a row picks that person for the card below.
   - **One person's day**: avatar, name, “Now in Wilgendam · seen 4 min ago” (today) or “4 stops · about 62 km between
     them”. A map drawn by the Mac (§2.7) with the day's stops numbered in order (a spot visited twice shows “2, 4”),
     dashed lines between stops in order, dotted where Whombat didn't read in between, and the person's avatar over the
     stop they're at now. Under it: “Lines join the spots Whombat read, not the way Ruben went.” and “Spots are where
     Find My’s address is, about 100 m. A stop shorter than 5 minutes can be missed.” (the pace's minutes). Then the
     list: time, a rail (numbered dot per stop in its place's colour, dashed for on the way, dotted for a gap), the
     place, its street, the duration (“1 h 35 min so far” for the stop they're at, with a “Now” pill and Find My's
     “seen …” words). A gap inside one stay is a line under it (“No location 02:10–06:30”).
   - **Week**: chips to pick a kept person, then seven rows (the last 7 days, today last) of strips with the same
     axis, and totals per place, on the way and not read in whole hours. Choosing a day opens it in Day.
   - **Timeline settings** (a card at the end of the tab): **Whose** (tick boxes as before; “kept since 23 Nov”
     beside each kept person; unticking someone deletes their days after a confirmation), **Kept 30 days** (a line,
     not a choice: “Days older than 30 are deleted by themselves.”), **Dusty can read it** (a switch for the
     `findmy_timeline` tool's tier: on = `can`, off = `off`; the assistant's own name, not “Dusty”), the line “Only
     you see it. When Dusty reads it, what it reads goes to its AI like any chat.”, and **Delete the timeline**
     (“Removes every day kept so far.”, with a confirmation; the people stay ticked), and **Stop keeping a timeline**
     (deletes everything and goes back to §1.2).
4. **The phone** has the same tab with the same parts stacked (the mockup at phone width).
5. **Dusty** (`findmy_timeline`, §2.8) answers “Where was Ruben yesterday at three?” or “When did Noor get home?”.

## 2. How it works (box)

### 2.1 What is kept

- `findmy_timeline_people` (connection, person, burrow, name, kept since): who is kept on which connection. A
  connection keeps a timeline when it has rows here.
- `findmy_stops` (id, connection, burrow, person, kind, place, address, lat, lon, accuracy_m, code, first_at,
  last_at), index (connection, person, last_at): one row per stretch where the reads said the same.
  - `place`: Find My had a place: its words (`place`), the street (`address`), and the Mac geocoder's spot (`lat`,
    `lon`, `accuracy_m`; null when it had none).
  - `none`: Find My had no location for that person (“No location found”).
  - `unread`: a background read of the Mac didn't work (`code`: the read's problem code, `in_use` when someone used
    the Mac).
- Both cascade with the connection. Migration with a `compat.json` entry, as `0017_findmy_places`.
- Never kept: pictures (the exact picture, the map), Find My's “seen …” words, anything of people not ticked.

### 2.2 Writing it

- After **every read that worked** of a Mac (the page's, the background's, the assistant's: `FindMyStore.onRead`, as
  `FindMyPlacesWatch` does, one at a time per Mac), for each Find My connection on that Mac with a timeline, for each
  kept person in the read: the person's last row is **extended** (`last_at` = the read's time; name and place words
  refreshed) when it says the same (same kind; for `place` the same street, else the same place words, compared with
  `findMyPlaceKey`) and its `last_at` is within the **tolerance** (twice the connection's pace plus 5 minutes);
  otherwise a new row starts (`first_at` = `last_at` = the read's time). A kept person missing from the read is `none`.
- After **every background read that failed**, the same for each kept person with an `unread` row and the code.
- Times are Whombat's read times. Find My's own “5 min ago” is in the Mac's language and isn't parsed.
- Rows are written through the commit pipeline as the Find My signer (`findmy.timeline_noted`), a command that **emits
  nothing**: the event log never holds where anyone was.
- Turning it on, changing whose, deleting and turning it off are the person's commands (`findmy.timeline_set`,
  `findmy.timeline_deleted`), signed with names only (“Kept a Find My timeline for Noor Visser and Ruben Visser”,
  “Deleted the Find My timeline”) and shown in the connection's Activity. Unticking someone or turning it off deletes
  their rows in the same command.
- **30 days**: each pass of the Find My background (every minute) deletes the rows whose `last_at` is over 30 days old
  (`FIND_MY_TIMELINE_DAYS = 30`), in batches, through the pipeline.

### 2.3 Reading for it

A connection that keeps a timeline reads in the background at least every 15 minutes (`FIND_MY_LISTENED_MS`), as one
an automation listens to does, even when its Read in the background is Off; its page's line then says “Reads every 15
minutes for the timeline”. A faster setting (John's 5 minutes) stays. Its reads stay in memory as background reads do.

### 2.4 From rows to a day (pure, in `@whombat/core`)

`findMyTimelineDay(rows, { from, to, now, toleranceMs })` makes one person's day of segments, cut at the day's bounds:

- `stay` { from, to, place, address, spot, ongoing, holes[] }: a `place` row. Two stays with the same key with only
  `none`/`unread` rows or nothing between them become one stay with those as `holes` ({ from, to, why }).
- `trip` { from, to }: between two different stays when the time between them is within the tolerance.
- `gap` { from, to, why: 'no_location' | 'not_read' | a read problem code }: `none` rows, `unread` rows, and any time
  between rows longer than the tolerance (`not_read`).
- `ongoing`: today, the last stay whose `last_at` is within the tolerance of now; it runs to now.
- Day bounds from a date and an IANA time zone (`findMyDayBounds(date, tz)`, `Intl`, DST days are 23 or 25 hours).
- Unit tests cover merging, holes, trips against gaps, cutting at midnight, ongoing, DST.

### 2.5 What the apps ask (session operations, all `NONE` for the assistant's settings)

- `findMyTimeline` GET (connection, `date`, `tz`, `days` 1…7, default 1): for each day, each kept person's segments;
  the people of the Mac's last read (id, name, kept or not, kept since); the pace in minutes; the last read's time;
  whether Dusty can read it (the tool's tier is `can`). Only the box's person (an owner's route, as `hosts.findMy`);
  never on the desk display, an Overview tile, a share link or in outsiders' turns.
- `findMyTimelineSet` PUT { people: FindMyPersonId[] } (empty: stop, deleting everything).
- `findMyTimelineDelete` POST: deletes every row, keeps whose.
- `findMyTimelineMap` GET (connection, person, `date`, `tz`, `w`, `h`, `dark`): the Mac draws the map around that
  person's stops of that day (`map.snapshot`, the pins being the day's distinct spots in order, at most 20) and answers
  the picture with each pin's point, as `hosts.findMyMap` does; 409 `find_my_no_places` when the day has no spot.
- The tool tier switch uses the connection's existing tools endpoint.

### 2.6 Only the person

A Whombat is one person's (`one-person.md` OP-01): the timeline routes are owner routes, the tool runs only in the
person's turns (never in an outsiders' turn: `call.personId` must be the person), and nothing of the timeline goes to
the Overview tile, the desk display, notifications or a share link.

### 2.7 The map

As `hosts.findMyMap` (MAC-58): the Mac's MapKit snapshot at two pixels a point in the app's theme, fitted to the pins
with room around them; the apps draw the numbered markers, the lines and the avatar over the returned points. The
picture is never kept past `mapMs`, like today's map.

### 2.8 The assistant's tool

`findmy_timeline { person?, date? }` on the Find My connection (catalog tool definition; tier `can` by default, as
`findmy_people`): `date` is `YYYY-MM-DD` (default today, in the person's time zone). It answers, for the person
named (whole name, then first name, then part, as `matchPeople`) or everyone kept: their day as stops with local times
(“08:30–12:15”), the place's words and street, “on the way” and gaps with why; and who isn't kept (“Whombat keeps no
timeline for Ilse. Turn it on under Find My → Timeline.”). Off when nothing is kept: says so. Never coordinates.
More than 30 days ago: “Whombat keeps 30 days.”

### 2.9 Older apps

A new session minor `FIND_MY_TIMELINE_MINOR` (5): a session below it doesn't get the Timeline tab in the kind's view.

### 2.10 What changes in privacy

New decision rows (`docs/decisions/findmy-timeline.md`, FMT-01…): with a timeline on, the box keeps, for the people
ticked, the place's words, the street, the geocoder's spot and the times, 30 days, in its database and so in its
backups. FMC-21's “never a street, coordinates or history” stays for everything else; mark FMC-21 and MAC-55 as
narrowed by the timeline (not superseded: they still hold without one).

## 3. Work split

- **Contract** (first, alone): `packages/core`, `packages/protocol`: the schemas (rows' kinds, segments, the
  operations' bodies and answers), the endpoints, the operations in `operations.ts`, `operation-safety.ts` and the
  assistant-settings map, `FIND_MY_TIMELINE_MINOR`, `FIND_MY_TIMELINE_DAYS`, the `findmy_timeline` tool definition in
  the catalog entry, `findMyTimelineDay` and `findMyDayBounds` with their tests. `pnpm contracts:gen` when a generated
  form changes.
- **Server** (`apps/server`): §2. Decisions in `docs/decisions/findmy-timeline.md`.
- **Apps** (`apps/web`, `apps/mobile`, `packages/client`): §1, against the mockup in both themes; the phone through
  the demo world. Decisions in `docs/app/decisions/findmy-timeline.md`.
- **Last** (the orchestrator): merge, `DECISIONS.md`, `ARCHITECTURE.md`, fast-test, ship (candidate `--minor`, the
  app's minor version, APK, iOS).
