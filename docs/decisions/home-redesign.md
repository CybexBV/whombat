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

## Server decisions for Done recently (stream S, HR-30…HR-39)

| # | Decision | Why |
|---|---|---|
| HR-30 | **A write's title** (`connections/changes.ts` `changeTitle`): Whombat's own words when they come with an Undo, else the agent's `change` (whitespace folded to one line), else Whombat's words without an Undo, else the generic title. The generic title and Home Assistant's “Changed X in …” name the connection without the address Whombat added (`nameWithoutAddress`); a name a person gave stays as it is. | Words with an Undo say exactly what Undo reverses; “Turned on Kitchen” without one is no better than what the agent said, and “Changed light.x in …” is worse. |
| HR-31 | **Superseded in part by one-person.md OP-S52**: `report_change` records kind `agent.report` as it says, and every report shows in Done recently. **`report_change`** records kind `agent.report` in the turn's chat. `thing` is tried as a thing id (`server:…` against the hosts service's fleet, `connection:`/`device:` against what the turn may see), then a connection handle, then a server id or host name. A report about a personal connection, or a personal assistant's report about nothing in particular (for the turn's person), is that person's alone; everything else is shared. At most 30 reports an hour per agent (`capped`). `undoes` takes any change of this burrow the same agent made (a report or a tool's), and the report that puts one back has no Undo of its own. Signed `change.reported` (its text only when shared). | One place for work the tools don't see; personal stays personal (PA-09); a runaway loop can't fill Done recently. |
| HR-32 | **Undo of a reported change** is a direct undoer that commits `ask_to_undo_change` as the person: their “Please undo this: <title>” (client id `undo:<change>:<hash>`, waking nobody by itself) and the agent woken there with `undo_requested` as a turn of its own (`QuietWake.own`: no queued turn takes it over), `changes.undo_asked_at/_by_id` set. Answer `requested` + `conversationId`. Within 10 minutes a second press is refused (“I’m already undoing this.”). Someone the agent can't be woken for there (another person's assistant) is refused in plain words and nothing is posted. The turn's `undoRequest` is read only when the trigger message is that person's request for that agent's change, not yet undone. An `undo_requested` turn takes the person's follow-ups (steering). | The note stays private to the agent; Done recently keeps Undo until the agent's own report marks it, so the state is honest. |
| HR-33 | **An approved call's result** (`approvals/result.ts`) is sealed on the approval (`approvals.result_enc`, AAD `approval:<id>:result`) and the requester is woken through `approval_granted` as for commands; the turn reads it as `grantedResult` (data, delimited and defused) and is told not to call again. The Servers connection's own words are still posted and wake nobody. With nobody to wake: “Done.”, “It didn’t work: the service said it couldn’t do it.” or “It didn’t work. <our reason>”. **Pack calls** (`packs/commands.ts`) had the same “ran after approval” post and get the same treatment; their approval's WHAT HAPPENS now says the agent tells how it went. | The approval belongs to the call, so a queued turn that takes the wake over still finds the result. |
| HR-34 | **Done recently and “Everything I did”** list changes with `agent_id` set; `changes.list` with `thing` lists every change there (the panel “Changes here”, devices too). | A person's own edits aren't news to them on Home. |
| HR-35 | **A change's `link`** is computed per viewer: `/chats/<id>` when the change's conversation is the viewer's own DM with an assistant (a task chat or the default one), else the stored place (the thing's page). A change made in a channel links to the thing. `thingId` is unchanged. | Only its person can open a chat; everyone else gets the thing. |
| HR-36 | **Settings saved in a row** (`recordOrMergeChange`, `hosts/merge.ts`): merge on `hosts.<op>:<server>:<guest>` (`server_settings`, `guest_config`; `changes.merge_key`, `merge_fields`), same actor and kind, within 2 minutes of the last save (the change's time moves to each save), not undone or asked to be undone, and both with an Undo or both without (else each keeps its own). Undo keeps the first save's old values and adds keys only a later save changed; a configuration's `expect` takes the last save's values; details merge per key (first old → last new). An undo's own change and a revert-only save never merge. Titles name up to three known fields (a server's switches as “what Whombat may do”), else count them (“Changed a setting of …”, “Changed 4 settings of …”); this applies to a single save too. | Undo goes back to how it was before the first save, and no Undo is lost to a merge. |
| HR-37 | **A new connection's automatic name** (`insertConnection`, CT-408 `onlyOne`) is the service's name unless a connection of the same service is already seen by the same agents (the set that keeps handles unique); a custom API or MCP server keeps its address. The first connection is not renamed when a second arrives. It applies to every label the person didn't type, found on the network or not. The app sends a label only when typed, but its placeholder still shows the address (stream W). | One rule wherever a connection is made; renaming the first behind a person's back would confuse. |
| HR-38 | **Migration 0111** is SQL with a fixed list of the 15 catalog entries whose label carries a URL host (not custom entries, not gateways): exactly “<name> · <host[:port]>” of the connection's own URL, and no other connection of that entry for the same people (shared: the burrow's and its members' personal; personal: the account's and its burrows' shared). It also replaces the old label in its changes' titles and subject names and its task chats' subject names; `updated_at` is left alone. | A migration is a snapshot; exact matching never touches a name a person gave. |
| HR-39 | **Reads through a POST** (HR-01): `requestReads` passes the body to `isReadRequest`, so a GraphQL read path (CT-400) is a read too; the test proves `POST /api/template` and `check_config` run with the write key off, ask nothing and record nothing. | The catalog decides; the server only has to hand it the body. |

## Server: chats and when things were used (stream H)

### HR-40 Chats are the chats `chats.list` lists

`home.overview.chats` comes from the same query as the web sidebar's Conversations and the phone's Chats
(`chats/read.ts` `chatRowsOf`): the person's task chats and their default DM with their assistant, archived ones left
out, read once per Home for Needs you, Working on and Chats. A chat's title is the list's: the default DM's is the
assistant's name and it carries `default: true`, so the apps draw it as “Your chat with Dusty”. At most 8.

### HR-41 Working, then waiting, then the newest others

- **Working**: a turn of the assistant is claimed or running in the chat (its status `working`, AS-03; a queued turn
  waiting for a runner is not work yet), newest turn first; then the chat of its newest unfinished plan (the one
  `working` names), unless that chat waits for the person. Progress and step come from the chat's newest unfinished
  plan: steps done of the steps not cancelled, and the active step's title, else the first one not done. A chat with a
  turn and no plan is working without progress.
- **Waiting**: Needs you shows the person an approval they may decide or a question of the assistant they haven't
  answered in that chat. What they snoozed (“Not now”) or ignored doesn't make the chat wait: they said not now.
- **Recent**: the rest, newest activity first.

A turn wins over waiting, waiting over a plan. `at` is when the state began: the turn's start or the plan's last change,
the newest ask, the chat's last message.

### HR-42 One more cheap read

The chat rows replace the two lookups Needs you and Working on each made; the approvals query also returns the chat it
was asked in; the assistant's live turns are one read on `dispatches_agent_idx`. The ordering is pure
(`home/chats.ts`, unit-tested).

### HR-43 Home hears when a chat moves

No new `HomePart`: `working` names a change of the chats (and `needsYou` with it for an approval). `home.changed` goes
out when a plan is made or saved in an agent's DM (to that DM's person); when a personal assistant's status is settled
(a turn claimed or ended, a person answering where it asked), to its owner every time, because the chat a turn runs in
changes while the status stays `working`; and when an approval is made or changes (`syncPlanSteps`, `createApproval`),
to its private approvers, else to everyone in the burrow. Before, Home's Needs you didn't refresh for a new approval
either. Approvals withdrawn because their connection was removed (`connections/commands.ts`) publish nothing yet; Home
catches up with its next change.

### HR-44 Older apps keep Working on

`working` (the newest unfinished plan as steps) and `summary.working` stay as they were; `chats` is extra.

### HR-45 Used: the last call that worked

`catalog_connections.last_worked_at` (migration 0112) is set in `finish_connection_tool` when the call's outcome is
`done`: a call of an agent or an automation that the service answered without an error. `last_used_at` keeps meaning a
call was allowed to run. A connection's thing carries it as `usedAt`. Health checks and widget refreshes don't count:
they are Whombat's own looks every few minutes and would make “used today” true for everything. A switched-on device's
`usedAt` is the newer of its last reading that worked and its connection's last call that worked; a device being learned
has none. No `home.changed` for it: the words change at most once a day and Home is read again with the turn that made
the call.

### HR-46 Every connection and device is in `things`

The server already lists every connection the person may see, with or without figures (no glance yet: “Not checked
yet” and no facts), and every device from its skill; a connection that is part of a server stays in the list with
`partOf`, and the apps leave it out of Home's tiles (CP-10). Nothing changed here; a test holds it.

## HR-47 A calmer Home (2026-10-18, later)

John asked to take the Ask box, Chats with Dusty and Done recently off Home, the search box out of the sidebar (Ask
Dusty moves to its bottom, above the person), and to show Your things like the servers (app 0.89.0,
whombat-app `docs/decisions/home-simplify.md` AP-2269…AP-2276). The server is unchanged: `home.overview` still carries
`chats`, `doneRecently` and `automationsToday` for the 0.88 apps, and changes are still recorded and undone as HR-01…HR-08
say; they show on each thing's page (“Changes here”) and at Everything I did (`/done`), which Home no longer links. The
assistant's persona now says a plan is followed in the chat (Home's first line names it) and a change shows under the
thing's “Changes here”, not “Done recently” or “Working on”. The contracts' words that still name Done recently
(`HOST_ASKS_FIRST_WORDS.hint.never`, `report_change`'s and `home.overview`'s descriptions) change with the next contracts
release (app AP-2276).

## HR-48 “Your things” is called Connections (2026-10-19)

John asked to rename “Your things”; agreed on **Connections**, the word people see where they add one. The web
sidebar, the Dashboard (web and phone) and a connection's page say Connections from app 0.91.2 (app
`connections-label.md` AP-2500); a page action's activity entry says where it happened as “Connections”. The phone's
Things tab keeps its name (it lists servers too), and code names (`things`, the `hosts` source's things) stay.

## HR-49 The Dashboard is called Connections (2026-10-19)

John found “Dashboard” the wrong name and the page, the doubled server charts and the Guests list not to his liking;
he agreed to the whole redesign: `connections-page.md` CN-01…CN-10 (contracts 0.94.0, app `connections-page.md`).
