# A service's page

Every service Whombat knows well (Plex, Seerr, SABnzbd, Home Assistant, Pi-hole…) gets a page built from the same
slots, so a new or changed service looks like the others on a phone, an open foldable and a desktop without any app
work. The decisions are in [service-slots.md](decisions/service-slots.md); the builders are
`apps/server/src/things/kinds/slots.ts`; Plex (`kinds/media/plex.ts`, `plexSlots`) is the example to copy.

## The slots

| slot | what goes in it | builder | width |
|---|---|---|---|
| Worth a look | what needs the person, from the kind's `notices` | the page does it | strip on top, gone when empty |
| Live | what happens now: what plays, downloads, waits for a yes, the lights to switch | `liveRows`, `liveList`, `liveControls` | 2 of 3 |
| Inventory | how much of each thing it holds, with what changed this week and its button | `inventory` + `countLine` | 1 of 3 |
| Shelf | one row of pictures: recently added, just available, camera snapshots | `shelf` (+ `askedBy`) | 3 of 3 |
| Trend | a bar per day of the last week, today last, with the total and the change | `trend` + `lastDays`, `countByDay`, `weekChange`; `pointsByDay` + `daysWith` for Whombat's own daily readings | 1 of 3 |
| People | who uses it most, with their initial; a person may be marked (`tone`, `sub`: “Quota 300 GB”) | `people` | 1 of 3 |
| Machine | processor, memory and disk of what it runs on, then the kind's own lines (its version) | `machine` lines in `slotPanels`; the page draws the card | 1 of 3 |

The machine card: the machine Whombat knows, linked; else the service's own figures (`KindView.slots.own`, a NAS or
Home Assistant OS) as “The machine” without a link; else only the kind's lines as “<name> itself”. A page in slots
never gets the response-time chart, the machine's charts or a row of figures, whatever the view sets; a chart over the
page's range goes in `more`. A connection without a kind gets slots of its own (`things/generic.ts`: How it answers,
Answer time).

A slot the service has nothing for is left out and the row closes up. Anything that fits no slot (failed downloads,
open issues, backups) goes in `more`: below the rows, in the main column.

## Giving a service its page

1. Read what the service says through its kind's reads (`kinds/read.ts`: `latestRead`, `liveRead`, `cachedRead`).
   Keep slow things (history, counts) cached for minutes and the live part for seconds.
2. Build each slot with its builder and return them from the kind's page part:

   ```ts
   return {
     ...slotPanels({ live, inventory, shelf, trend, people, more, machine: versionLines }),
     kpis: [],               // no row of figures: counts belong in Inventory
     notices,                // Worth a look
     facts, open, buttons, readAt, suggestions, verdict, …
   };
   ```

3. Words follow the rules in `AGENTS.md`/`CLAUDE.md`: plain, short, the person's words (“Downloading now”, “Who asks”),
   curly quotes, `·` between parts, `−` for a drop.
4. Test the view: `expect(slotProblems(view)).toEqual([])` with the kind's recorded answers, and the facts each slot
   must show (who, how many, what changed). The page also logs `service page: slots out of place` when a kind's view
   breaks them.
5. Give it a fixture page in slots, so the apps' fixture mode shows it as a real Whombat would: add an entry to your
   group's file `packages/fixtures/src/servicePages/<group>.ts` (the shape and an example are in `types.ts` there):
   its `thing` (`connection:con_<name>`), `catalogId`, `name`, the service's address in `fields`, and `make`, which
   returns its `page()` (the `ThingPage` as the server would answer it), its sidebar `row()` (line and facts), its
   buttons (`action`) and What Whombat watches (`checks`). Nothing else needs changing: the page answers at
   `/things/<thing>` in the web's (`VITE_FIXTURES=1`) and the phone's fixture mode, and with `VITE_FIXTURE_SERVICES=1`
   the connection is listed on Home and in Connections, and in the sidebar while it needs a look (its Settings tab
   lists the catalog's tools). A page the
   world draws already (UniFi `connection:con_unifi`, Hetzner `connection:con_hetzner`, Protect
   `connection:con_protect`) is replaced by using its id. `servicePages.test.ts` parses every page and row. Look at it
   in the web's fixture mode at 1440 × 900 in both themes, 390 × 844 and 884 × 1104.
6. Desk widgets read the page: a figures widget uses the Live count and each Inventory line (`slotFigures`), and a
   kind's widget hints (`desk/widgets/thing-kinds.ts`) name panels by `id`, so keep ids stable or update the hints. Live
   rows without pictures (SABnzbd's downloads) give their hint `view: 'list'`, so a screen lists them with their bars.
   Live rows that are each a figure rather than things to count (Fusebox's limits) are named in the hint's
   `rowFigures`: each row's share becomes a figure under the row's id, its tag's colour kept.
