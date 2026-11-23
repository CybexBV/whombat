# Find My as a connection: the build assignment

John, 2026-11-23: “I would like to make this a separate connector which requires a Mac server to be configured.” His
answers to the three questions: Dusty may see where people are, **on by default**; reading in the background,
**yes, optionally**; arriving and leaving automations, **yes**. “Build this fully.”

Today Find My is a tab on a Mac's page (`findmy.md`, `docs/decisions/macos-servers.md` MAC-52…MAC-71): the box reads
the Mac's Find My app through Whombat Helper while someone looks, keeps the read in memory for an hour, the Mac draws
the map, “Show exactly” cuts Find My's own map from the screen. All of that stays: this build moves it into a
connection of its own, lets it read without anyone looking, gives it to the assistant and to automations.

Names in this file are made up (Mara, Ruben and Noor Visser, a Mac called Studio).

## 1. What the person sees

1. **Add connection → Find My** (catalog id `findmy`; a neutral mark of its own, a location pin over two heads, never
   Apple's icon). Sign-in: none. Two settings:
   - **Mac**: which Mac reads Find My. Its choices are the person's Macs (servers whose platform is macOS), picked by
     itself when there is one. A Mac that already has a Find My connection is refused with “Find My on Studio is
     already connected.”
   - **Read in the background**: Off (the default), Every 5 minutes, Every 15 minutes, Every 30 minutes, Every hour.
   Several Find My connections may exist, one per Mac (each Mac is signed in to its own Apple Account).
2. **No Mac yet**: the Find My tile says “Add a Mac first” and its action opens Add a server. A Mac counts once the
   hosts service knows it as macOS; a Whombat Helper older than 1.1.0 makes the connection's check fail with today's
   `helper_old` words.
3. **The connection's page** opens on its **Find My** tab: today's map, people list, Read again and Show exactly
   (web `MacFindMyTab.tsx`, phone `MacFindMy.tsx`, moved to components that take the Mac's server id; nothing new to
   look at). Under the map one muted line says how it reads: “Reads only while someone looks”, “Reads every 15 minutes”,
   or “Reads every 15 minutes for “Tell me when Mara gets home”” when an automation needs it (§2.4). The usual tabs
   (Activity, Connection with its settings and the assistant's tools) follow.
4. **Overview tile**: “3 people · read 5 min ago”, “Not read yet”, or the read's problem in a few words. No places on the
   tile (Overview is also on the desk display).
5. **The Mac's page** no longer has a Find My tab. Its summary has one link row “Find My” to the connection's page
   when a Find My connection uses that Mac; nothing otherwise.
6. **The assistant** has one tool on the connection, `findmy_people` (tier `can` by default, as every tool; John: on by
   default). It answers each person's name, place, street, how long ago Find My saw them, nearby, and when Whombat read
   it, optionally for one person (`person`: a name or first name). When the last read is older than 2 minutes and the
   Mac can be used it reads first, waiting up to 45 seconds, else it answers the last read with its age and why it
   couldn't read. Never pictures, never coordinates.
7. **Automations**: “Tell me when Mara gets home”, “… leaves home”, “… arrives in Lelystad”. Made by talking, like
   every automation (`automation-chat.md`); the Automations page's ideas offer “Tell me when Mara gets home” for each
   person a Find My connection has seen at Home.

## 2. How it works (box)

### 2.1 The catalog entry and its check

- `packages/core/src/domain/connections-catalog/findmy.ts`, listed in `ENTRIES`; connectable (not `builtin`) with
  `transport: 'rest'` so its tool is served through an adapter (`connections/sync.ts`), `signIn: [{ kind: 'none' }]`,
  `baseUrl: 'whombat-hosts:'` (the Servers connection's), and a new check kind `{ kind: 'mac' }`.
- An entry whose check is `mac` has no address: `createTokenConnection` skips `requireBaseUrl` and
  `requireDestination` for it, the catalog test allows it, and nothing ever sends a request to its base URL.
- The `mac` check (`runCatalogCheck`): the field's server exists in the hosts fleet, is macOS, and its helper isn't
  older than 1.1.0 (`helperTooOld`). It never touches the screen: the health pass runs it every 5 minutes. Its
  choices (`fromService`) are the person's Macs `[{ id: serverId, name }]`, so `chooseServiceFields` picks the only one
  and asks when there are several. A removed Mac fails it: “Studio isn't one of Whombat's servers any more. Pick
  another Mac.”
- Setup fields: `mac` (`select`, `fromService`) and `background` (`select` with **static options**, a new
  `options: { value, label }[]` on `CatalogField`; web and phone show them as radio cards, like a `fromService`
  choice). Both can be changed later from the connection's settings (`updateConnection`).
- Catalog status: a new reason `needs_mac` (no macOS server in the fleet). Words: “Add a Mac first”. Older apps read
  an unknown reason as null.

### 2.2 The kind (`apps/server/src/things/kinds/findmy.ts`)

- `view`: tabs `[{ key: 'findmy', label: 'Find My', server: <serverId>, panels: [] }, …]`: the tab names the Mac
  (`ThingPageTab.server`, new and optional), the apps draw it. The Find My tab is the page's first.
- `seen` → glance from the box's memory only (never reads): people count and the read's age, or its problem.
- `checks`: one, “Find My can't be read” (the last read's problem, `perItem: false`), **starts off** (a read that
  failed is what a person looks at the page for; nothing breaks). The Mac being gone is the connection's own check
  failing, shown as every broken connection is.

### 2.3 Reading in the background (`apps/server/src/hosts/findmy-background.ts`)

- One loop for the box. A Find My connection reads in the background when its `background` isn't Off, or when a live
  `findmy` automation listens to it (then at least every 15 minutes: `FIND_MY_LISTENED_MS`).
- Each read is today's `FindMyStore.refresh`: it leaves a Mac someone is using alone (then it tries again after 2
  minutes) and puts a locked Mac back. A failure waits twice as long each time, up to an hour, and shows on the page as
  today's problem line. While reads run the read stays in memory; once they stop, today's hour after the last look
  applies.
- It stops when the connection is removed, its Mac is gone, or the setting goes back to Off with nothing listening.

### 2.4 Arriving and leaving

- After each read (background, page or assistant) the box compares each person's **place** (Find My's own words:
  “Home”, “Work”, “Lelystad”) with the last known one. `arrives` at X: the place is X now and wasn't before; `leaves`
  X: it was X and now is another place. A person without a place (“No location found”) neither arrives nor leaves.
  Places compare case- and space-insensitively.
- **Only while an automation listens** to that connection: each change records one signed event
  `findmy.place_changed { connectionId, person, name, from, to }` through the commit pipeline (no street, no
  coordinates). No automation, no event: the event log never becomes a history of where people were.
- The last known place of each person of a connection that an automation listens to is kept (only the place's words
  and since when, never a history), so an update or restart neither makes up an arrival nor misses one. Written only
  when it changes, through the commit pipeline. The first read with nothing kept sets it without an event.
- Trigger `{ kind: 'findmy', connectionId, person, change: 'arrives' | 'leaves', place }` (`person`: the stable id,
  `findMyPersonId`). The run's scope: `trigger.text` (“Mara Visser is now at Home (was in Lelystad).”),
  `trigger.person` (the name), `trigger.place`, `trigger.from`.
- Plumbing as mail and trackers did it: `AutomationTrigger`, `TriggerFacts`, `triggerMatches`, `EVENT_TYPES` +
  `eventFacts`, `EVENT_TRIGGER_KINDS`, `AutomationTriggerInfo`/`AutomationSource`, glance `SOURCES`, plan `whenLine`,
  the connection check in `commands.ts`, `release-gate.ts` (a box rolling back must not keep automations it can't run),
  `older-apps.ts`, `automation_read` (`findMyPeople`: connection, person id, name, current place) and the authoring
  guide. A new recipe has no earlier words; its test is the mail one (`mail.test.ts` “is current”).
- Removing the Find My connection: its automations behave as a removed mail connection's do.

### 2.5 The assistant's tool

`FINDMY_ADAPTER` in `connections/adapters/index.ts`: `findmy_people { person? }`, through `findMyFor(services)`
and `hostsFor(services)` like `hosts/tools-shared.ts` `scope()`; outside an agent turn as `scope()` handles it.

### 2.6 What changes in privacy (supersedes parts of MAC-52…MAC-59)

- Still: nothing read is logged; streets and coordinates are never stored; pictures are never kept.
- New: the assistant's answers stay in the chat like any answer; a listened connection keeps each person's last place
  words and signs an event per change.

## 3. Work split

- **Contract** (first, alone): everything in `packages/core`, `packages/brand` and `packages/protocol` named above:
  the catalog entry with its tool definition, `CatalogCheck` `mac`, `CatalogField.options`, the `needs_mac` reason,
  `ThingPageTab.server`, the `findmy` trigger and `findmy.place_changed` event schemas, `TriggerFacts`, constants
  (`FIND_MY_BACKGROUND_CHOICES`, `FIND_MY_LISTENED_MS`), the mark. Tests for the schemas; `pnpm contracts:gen` when a
  generated form changes.
- **Server** (`apps/server`): §2. Decisions in `docs/decisions/findmy-connection.md` (FMC-01…); the MAC rows it
  supersedes marked there.
- **Apps** (`apps/web`, `apps/mobile`, `packages/client`): §1. Visual check against the existing Find My tab in both
  themes; the phone through the demo world.
- **Last** (the orchestrator): merge, `DECISIONS.md`, `ARCHITECTURE.md`, fast-test, ship (candidate `--minor`, the app's
  minor version, APK, iOS), and on Home: add Find My on the Mac Studio and see it read.
