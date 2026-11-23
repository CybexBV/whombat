# A Find My timeline in the apps (FMT-A01 … FMT-A11)

John, 2026-11-23: a Find My connection can keep a timeline of where the people he ticks were, 30 days, only he sees it,
and the assistant can read it, on by default (`docs/implementation/macos/findmy-timeline.md`, §1 is the apps' part; the
visual reference is `findmy-timeline-mockup.html` beside it). Web and phone alike. Names here are made up (Noor, Ruben
and Ilse, a Mac called studio, towns Rietveen, Wilgendam and Oosterhaven).

## FMT-A01 The Timeline tab is the box's to give

The box sends `{ key: 'timeline', label: 'Timeline', server: <serverId>, panels: [] }` after the Find My tab, and only
to a session of minor 5 or later. The apps draw it when they get it (web `FindMyTimelineTab.tsx`, phone
`FindMyTimelinePart.tsx`) and never add it themselves, so an older box shows no tab and nothing breaks. The tab's name
is the server's; the mockup's “New” mark isn't drawn (the contract doesn't carry it).

## FMT-A02 Days are the device's

Days are cut in the device's IANA time zone (`findMyDeviceTimeZone`), which the apps send with each read; “Today” is the
device's date. The bar goes back to 30 days ago and not past today; Week is the last seven days ending today, and a day
picked there opens in Day. Today is read again every minute while it's shown (the box reads every few minutes); an
earlier day isn't. The day before stays on screen, dimmed, while the next one is read.

## FMT-A03 A colour per place, kept while the tab is open

The four chart series, then `mut` (the mockup's fifth, brown-grey, in both themes; `brand` turns light in dark and the
stop numbers would not read on it). Home always has the first; the others take the next in the order the day first
reached them, and a place keeps its colour from day to day while the tab is open (`findMyPlaceOrder`). The colour
follows Find My's place words, not the street, so Wilgendam's station and quay are one colour. A sixth place starts the
four after Home again. Numbers on a colour are `on-solid`.

## FMT-A04 Before it's on is one card

The card asks “Keep a timeline?” with the people of the Mac's last read unticked, “Keep a timeline” waiting for a tick.
The mockup's faded example underneath isn't drawn: made-up days beside real people's names would read as theirs. The
pace in its first line is the connection's when faster than 15 minutes, else 15 (a timeline reads at least that often).

## FMT-A05 The map is the Mac's picture with the apps' marks

The apps ask for the day's map only when the day has a spot (`findMyTimelinePins`), at the card's size and theme, and
draw on the picture the numbered markers at the points the box answers (“2, 4” for a spot visited twice), dashed lines
between the stops in order, dotted where a gap lay between them, and the person's avatar over the stop they're at now.
While it draws: “Drawing the map…”; a day without a spot, or 409 `find_my_no_places`: “No spots to draw for Ruben on
this day.”; another refusal says the box's words. The last picture of the same person and day stays while a new one is
drawn; a new read of the Mac draws today's again. 260 px high, 210 at a phone's width.

## FMT-A06 Gaps in plain words

A gap says why: “Find My had no location for Noor.”, “Whombat didn’t read Find My then.”, “Studio was in use, so
Whombat left it alone.” (the Mac's name, its first letter capital at the start of a sentence), and for any other read
problem “Whombat couldn’t read Find My on studio then.” A hole inside a stay is a line under it, “No location
02:10–06:30” (“Not read” for the rest). The legend and the week's totals call all time without a place “Not read”, as
the mockup does. Totals are whole hours, and a little time is “under 1 h”. “seen” takes Find My's own words with a small
first letter (“seen 4 min ago”, “seen now”).

## FMT-A07 Whose: ticking keeps, unticking asks

Ticking someone, here or with “Keep Ilse’s too” on a row of Everyone, keeps their days from now at once. Unticking asks
first (“Stop keeping Noor’s timeline?”) because their days are deleted; unticking the last one kept is Stop, with Stop's
question. Delete and Stop ask first too. What went through is a toast on the web and a notice on the phone; what didn't
is a toast on the web and an alert on the phone, as elsewhere.

## FMT-A08 The assistant switch is the tool's tier

“Neo can read it” (the assistant's own name) sets the `findmy_timeline` tool's tier through `connections.setTool`, the
endpoint the connection's Tools section uses: on is Allowed (`can`), off is Off. Every cached timeline says the new
value at once (`assistantReads`) and is read again; the connection's tools take the answer as with any tier change.

## FMT-A09 One person's day

Choosing a row of Everyone picks whose day the card below shows (the first kept at first). Its line is “Now in
Wilgendam · seen 4 min ago” while they're somewhere today, else “4 stops · about 62 km between them” (straight lines
between the stops' spots). The list numbers the stops in their colours on a rail: dashed for the way between, dotted
for a gap, the stop they're at with “Now” and “1 h 35 min so far”. A day with nothing kept says “Whombat kept nothing
for Noor on this day.”

## FMT-A10 The phone stacks the same parts

The mockup at phone width: avatars without names on the strips (a tick near now gives way to now's time), durations
after the street, the settings' rows one under another. Strips and the map's lines are SVG (a hatch pattern for the way
between). Tick boxes are 44 dp rows with the checkbox role; Delete and Stop are secondary buttons whose questions have a
destructive answer.

## FMT-A11 The fixture worlds keep Noor and Ruben

One builder for both apps (`@whombat/client/hosts/fixtures`, `fixtures-findmy-timeline.ts`): Noor and Ruben kept for
the last 30 days, Ilse and Sem not; each day made from a plan in local minutes (today as the mockup draws it) and cut at
the day's bounds, now, when each person was kept and the last delete; the map answers as the box does, 409 included.
The web's fixture world serves it from the connections layer, whose `findmy_timeline` tier is the switch; the phone's
demo world serves it and now answers `connections.setTool`. Its Find My page has the Timeline tab.
