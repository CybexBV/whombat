# Find My as a connection in the apps (FMA-01 … FMA-08)

John, 2026-11-23: Find My becomes a connection of its own that needs a Mac
(`docs/implementation/macos/findmy-connection.md`, §1 is the apps' part). Today's Find My tab on a Mac's page moves to
that connection's page; nothing new to look at. Web and phone alike. Names here are made up (Mara, Ruben and Noor
Visser, a Mac called studio).

## FMA-01 The connection's page draws its Find My tab itself

The server sends the tab `{ key: 'findmy', label: 'Find My', server: <serverId>, panels: [] }` first. The apps keep a
tab's `server` (`thingTabs`, `ThingTabView.server`; the phone's `PhoneThingTab.server`) and draw the `findmy` tab from
that Mac's own reads: today's map, people, Read again and Show exactly, moved unchanged into components that take the
Mac's id (web `features/things/findmy/FindMyTab.tsx`, phone `screens/findmy/FindMyPart.tsx`). They read the Mac's page
first for its screen's switches, so the screen's reason still comes first. A Mac that is gone shows the read's error;
the connection's own check says why on its Connection tab.

## FMA-02 One muted line under the map says how the box reads

From `HostFindMy.background`: “Reads only while someone looks” (null, or an older box that doesn't send it), “Reads
every 15 minutes”, “Reads every hour”, or “Reads every 15 minutes for “Tell me when Mara gets home”” when an automation
is why (`findMyBackgroundLine`). On the web it shares the card's foot with the note about spots, two lines and one rule.

## FMA-03 The Mac's page links to its Find My, nothing more

The Mac has no Find My tab (Screen, Storage, Sensors, System on the web; Summary and Screen on the phone). Its Summary
has one link row “Find My”, after its panels, when a Find My connection's `mac` field is that server; the row carries
the connection's line from Overview (“4 people · read 5 min ago”). The apps find the connection in the connections list
they already read (`ConnectionView.fields`, `findMyConnectionOf`), so no new read on the server. An old link to the
Mac's `?tab=findmy` opens its Summary, where the row is.

## FMA-04 Add connection: radio cards for a field's own choices

A `select` with its own `options` (Find My's Read in the background) is radio cards, like a choice the service gives:
web `OptionCards`, phone `RadioCards`, its default (Off) picked. The Mac stays a `fromService` choice: picked by the box
when there is one, asked with the existing choice cards when there are several. An entry checked through a Mac has
nothing to sign in to, so its step asks “How should Whombat read it?” (`setupStepTitle`).

## FMA-05 No Mac yet: the tile opens Add a server

`needs_mac` joins the reasons that say what to do first (`AddressReason`): the tile and row say “Add a Mac first” and
open Add a server directly (web `/connections?add=1`, phone `AddServer`); the entry's own page says “This works through
one of your Macs. Add your Mac as a server first, then connect.” with an Add a server button. Once a Find My connection
exists, its tile opens its page as any connected entry's.

## FMA-06 The choices change later on the connection's page

The Connection tab (web) and Connection screen (phone) list each choice the app can offer again (`choiceSettings`): a
select's own options, and the Mac of an entry checked through a Mac among the servers that are Macs (from the fleet,
`useMacChoices`). Each shows its value with Change, then radio cards and Save, which sends only that field
(`connections.update`; the server merges it into the others and checks it as it checks a new connection). Other
`fromService` choices (Moneybird's administration) are still only asked when connecting: the app doesn't know them.

## FMA-07 Automations: when-words and ideas

A Find My automation's next run reads “Next run when Noor Visser arrives at Home” (core `findMyWhenText`). The
Automations page's ideas offer “Tell me when Mara gets home” for each person a Find My connection's last read has at
Home, from what each Mac's Find My holds now (`hosts.findMy`, never a read of its own, so nobody's screen is taken for
an idea), and one “Tell me when someone gets home” while that isn't known. They come after the mail idea; three ideas
at most, as before. The phone has no ideas list.

## FMA-08 The fixture worlds have Find My through studio

One builder for both apps (`@whombat/client/hosts/fixtures`, `fixtures-findmy-connection.ts`): the connection with
`mac: studio` and `background: 15`, its Overview tile and its page; studio's Find My says it reads every 15 minutes for
“Tell me when Ruben gets home”. The web lists it only beside studio (`localStorage['whombat.fixtures.mac']`), so the
mock's screens stay as drawn, and without studio the catalog says `needs_mac`. The phone's demo world lists it in
Settings → Connections; its Home stays mock 4's.
