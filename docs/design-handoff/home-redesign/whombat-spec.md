# Home redesign and an honest Done recently (2026-10-18)

John (main checkout) sent a screenshot of Done recently: six “Changed something in Home Assistant · 10.100.0.5:8123”
rows with Review, and four “Changed the settings of pve-01” rows from 07:53. His DEV box showed why:

- None of the six Home Assistant rows changed anything. Dusty read Home Assistant through POST requests (`/api/template`
  to list devices that don't answer, `/api/config/core/check_config` before offering a restart); Home Assistant's
  catalog entry has no read paths, so every POST counted as a write. One of them even asked John for a yes, and the raw
  HTTP answer was then posted into the chat as Dusty's message (“request on homeassistant ran after approval: HTTP 200 …”).
- The two real changes were missing: deleting about 2,000 statistics entries from Home Assistant's database (13:05) and
  removing 14 Zonneplan entities with a Home Assistant restart (14:15) ran over SSH with a Vault key, which records
  nothing.
- The pve-01 rows were John's own edits on the server page, each field saved on its own, none saying what changed.

He then asked for the same server experience on Android as on the web (every server with its CPU line, memory and
temperature) and for a Home that shows every server, everything connected and a way to chat with the agent. He agreed
with the plan below (“implement them all”) and noted the blue outlines in the mock only marked what is new.

Contracts 0.91.0 CT-400…CT-404; app side whombat-app `docs/decisions/home-redesign.md` (AP-2206…); migration 0111.
Mock (illustrative figures): whombat-app `docs/design-handoff/home-redesign/proposed.html`.

## Done recently shows what really changed

### HR-01 Reads stay off the list

A `request` that only reads is a read, also when the service wants a POST for it: Home Assistant's `POST /api/template`
and `POST /api/config/core/check_config` are read paths (contracts CT-400), and every other catalog entry whose guide
tells agents to read through a POST gets its read path too. A read needs only the read key, never asks and is never
recorded as a change.

### HR-02 Agents say what a change does

`connection_call` takes an optional `change` (CT-401): one line in plain words, as the agent would tell the owner
(“Removed 14 old Zonneplan entities”). A write's title is Whombat's own words when it has them (they come with Undo),
else the agent's `change`, else the generic title. The generic title names the connection without its address.

### HR-03 Work outside connections is recorded too

`report_change` (CT-402, every agent) records a change made any other way: `ssh_exec`, the agent's computer, a command
on a server. One call per change a person would care about, not one per command; never for a read. Its `thing` names
what changed (`server:pve-02`, a connection handle), its private `undo` says how to put it back (a backup's path, the old
value). The change links to the chat it was reported in.

With an `undo`, Done recently offers Undo for 24 hours: pressing it posts the person's message in that chat (“Please undo
this: …”) and wakes the agent (trigger `undo_requested`) with the private note; the agent puts it back and calls
`report_change` with `undoes`, which marks the original undone. A second press within 10 minutes is refused (“I’m
already undoing this.”). The persona says when to call it.

### HR-04 An approved call answers in words

A connection call that runs after a yes no longer posts its raw output as the agent's message. The agent is woken with
the result in the chat where it asked (trigger `approval_granted`, as for commands, EA-07) and answers in its own words.
A builtin with words of its own (the Servers connection) keeps them; when no agent can be woken, one plain line (“Done.”,
“It didn’t work: …”).

### HR-05 People's own edits stay off Home

Home's Done recently and “Everything I did” list what an agent changed. A person's own change stays on the thing's page,
whose panel becomes “Changes here” and says who made each one.

### HR-06 Settings saved in a row are one change

A settings change by the same actor on the same server or guest within 2 minutes of the previous one (not undone)
updates that change instead of adding another: the title names what changed where Whombat knows the fields (“Changed the
name and notes of pve-01”), else counts them (“Changed 4 settings of pve-01”), and Undo still goes back to how it was
before the first.

### HR-07 Names without addresses

A connection found on the network is named after its service (“Home Assistant”); the address is added only when another
connection of the same service exists in the burrow. Migration 0111 renames existing connections whose label is the
automatic “<service> · <address>” and whose service name is unique there, and drops the address from the titles and
subject names of their recorded changes.

### HR-08 Review opens the chat

A change made in a chat links to that chat; otherwise to the thing's page. `thingId` still names the thing.

## Home

### HR-20 One Home on web and Android

Both show the same sections in the same order: the greeting and one plain sentence; the Ask box (top on the web, pinned
above the tabs on the phone); Needs you (only when something does); Chats with the assistant; Servers; Your things; Done
recently; pinned panels (only when there are any). The order and contents come from `@whombat/client`; the apps only draw
them. On a wide screen the web pairs Needs you with Chats and Done recently with the first pinned panel; a pair missing
one member gives the other the whole width.

### HR-21 Chats with the assistant replaces Working on

The assistant's face and name; first the chat it is working in (title, progress, “Working · step 3 of 4”), then chats
waiting for the viewer (an approval or a question in them), then the newest others: at most 4 on the web, 3 on the
phone; “All chats”. A row opens its chat. `home.overview.chats` (CT-403) carries them; `working` stays for older apps.
“Automations today” stays as the card's footer on the web when there are any.

### HR-22 Every server, also on the phone

The phone's Servers card has a two-line row per server like the web table: the name with its CPU line over 24 hours and
the figure now; its system, hottest temperature, guests and a memory bar. Problems first; a row opens the server.

### HR-23 Everything connected is on Home

Connections and devices without live figures are shown too, as “Connected · used today” (`ThingSummary.usedAt`, the last
call that worked, CT-404) or “Connected”; the list ends with “Add a connection” for people who may add one. A connection
that is part of a server stays on the server's page (CP-10).

### HR-24 Done recently and pinned panels on the phone

The phone shows the newest 3 changes with Undo or Review and an “Everything I did” screen, then the pinned panels.
