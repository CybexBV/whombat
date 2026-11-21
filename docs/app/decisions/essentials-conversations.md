# Essentials (2026-09-30): conversations on the web — decisions (AP-460…AP-479)

Stream W2 of the essentials build (Whombat `docs/implementation/essentials/assignment.md`): item 9 (direct messages
between people and group DMs), item 11 (Browse, join, private, archive, leave, the members pane), item 12's
per-conversation bell, muted look and do-not-disturb moon, and item 14's presence dots for people. Built on contracts
0.26.0 (CT-171, CT-172, CT-175, CT-177, CT-179, CT-182, CT-183). Unmocked screens follow the nearest mocked pattern
(AP-22, B-05): tokens only, copy plain, the product's curly quotes and middle dots.

## AP-460 Direct conversations have their own route

`/direct/:id` (router `directRoute`, same style as `/dm/:agent`, search `validateConversationSearch`) opens
`DirectScreen`. `/direct/$id` joins `BURROW_ROUTES` in `@whombat/client` (so `splitBurrowPath` reads old-form
`/<burrow>/direct/<id>` links too, and the router test keeps the list and the routes equal). `appPath({type: 'direct',
id})` is core's `linkPath` without the burrow. An id that turns out not to be a direct conversation (a hand-edited link)
is replaced by that conversation's own address.

## AP-461 DIRECT: people and agents together, by recent activity

- The DIRECT section lists `sidebar.dms` (agent DMs) and `sidebar.direct` (people) in one list: the viewer's own
  personal agent first (PA-08), then newest `lastMessageAt` first; conversations without a message keep the server's
  order after the rest (`byRecentActivity`, a stable sort).
- A people row shows the others' names (`directTitle`: “Tom”, “Priya and Tom”, …) at the row's weight rules (600 when
  selected or unread, AP-97). One other person: their 26px face with their presence dot (9px, `--side` ring, like the
  footer). A group: the first two faces at 18px, overlapping diagonally in the 26px slot. The row's `title` is the
  others' full names.
- A retired agent's DM leaves DIRECT, and the agent leaves AGENTS (`isActivePrincipal`, CT-177). Its DM stays readable
  by link (`/dm/:agent` finds it through `openDm`, the existing DM) and is closed: `retiredAgentText` (“Quill is
  retired. You can still read this conversation.”) in the composer's place, no bell.
- A conversation whose one other person left the burrow keeps its row, “Kim · former member” (`principalStatusLabel`),
  without presence.
- Alt+↑/↓ steps through DIRECT in this order (`/direct/:id` for people rows).
- The section shows even when empty on a Whombat with `conversations.direct`, so its `+` is reachable.

## AP-462 The direct conversation

- Header: one other person → their 44px face with a 12px presence dot, their name, and “{title} · Active now / Away /
  Offline” (or just the presence; “Former member” for someone who left). A group → the first two faces (32px, −10px
  overlap, like the member stack), “Priya and Tom”, “3 people”, and the member stack without a count (the line already
  says it) as the link to the members pane. “Pinned · N” (W1's AP-445) while something is pinned, the bell (AP-469); no
  channel menu.
- Composer: `composerPlaceholder({kind: 'direct', title})` (“Message Joris”); `@` offers the people in the conversation
  only; the tool chip reads “@ mention” and there is no “/ command” chip (no commands or skills here); the hint beside
  the tools is empty. When the draft mentions an agent (`mentionsAnAgent`, core `resolveMentions` over agents),
  `DIRECT_AGENTS_HINT` (“Agents aren’t in this conversation”) shows in the composer's note line; sending still works
  (the server wakes nobody, CT-171).
- A two-person conversation whose other person left the burrow is read-only for the one who stays: the header says
  “Former member” and the composer's place “Kim isn’t in this burrow any more. You can still read this conversation.”
  People who left are never offered for a mention, and nobody can start a new conversation with them (AP-463, AP-464).
- Empty conversation: the others' faces (64px), “This is the start of your conversation with {title}”, and “Agents
  aren’t in direct conversations, so mentioning one here wakes nobody.” No claim about who else can read it.

## AP-463 New message

DIRECT's `+` (“New message”, `NEW_DIRECT_MESSAGE`, on hover or focus like CHANNELS' `+`) opens a 560px dialog: kicker
DIRECT, the people picker (AP-464) for up to `DIRECT_OTHERS_MAX` (8) people, “Open conversation” (one person) or
“Start group conversation”. It calls `conversations.openDirect` (get-or-create by the exact member set) and goes to
`/direct/:id`. Agents aren't offered: they have their DMs (Message on their row). A group's members pane offers “New
conversation with more people”, the same dialog with its people picked, because the member set is fixed.

## AP-464 The people picker

One component (`PeoplePicker`) for New message, Create a channel and Add people: the picks as chips (20px face, name,
×), a name field (combobox) that filters by the start of the name or any word of it, the handle or a person's title,
and a multi-select listbox (↑/↓, Enter or click picks and unpicks, Backspace in an empty field takes the last pick back,
44px rows, an 18px round check). People who left the burrow, the viewer and those already in are never offered
(`pickablePeople`, `isActivePrincipal`); where agents may join (channels, branch rooms) they follow the people
(`pickableAgents`: no system principals, no personal assistants, no retired agents). At the maximum the rest are
disabled and “Up to 8 people.” shows. The composer's `@` list (`mentionOptions`) leaves out people who left and
retired agents too.

## AP-465 Browse channels

- A dialog over any burrow page, as URL state like `?approval=`: `?browse=1` (`BurrowSearch.browse`, `ModalState`
  `browse`; Esc closes it). Entry points: the compass button left of CHANNELS' `+` (on hover or focus, “Browse
  channels”), ⌘K (the search screen shows the channels whose name matches the query and “Browse channels →” under the
  field), and a public channel you're not in: its page says “You’re not in #design-crit yet.” with “Join #design-crit”.
- The dialog (760px): a search field (debounced, `q`), Channels / Archived (`archived=true`), rows with `#` or a lock,
  name, topic, “8 members · Private · Joined”, and Join (a public channel you're not in: joins, then opens it) or Open.
  “Create a channel” swaps the dialog to the create form, with “← Browse channels” back.
- `conversation.updated` keeps cached Browse rows current (members, topic, visibility, archived, `joined`).

## AP-466 The members pane

- The header's member stack is a link to `?members=1` (a right pane like Plans, 400px; one pane at a time: a plan, then
  the plans list, then the members, then a thread). It looks exactly as before (a `sel` hover).
- PEOPLE · n (32px face with presence, name, “You · Owner · Engineering lead” or “former member”), then AGENTS · n (role
  title, “retired” when so). Channels and branch rooms: “Add people” opens the picker inline (people, then agents) → `addMembers`; each
  other row has Remove and your own Leave (not in #general), shown on hover or focus and always on touch screens. Who may
  remove whom is the server's call; its refusal shows in a toast in its own words.
- Direct conversations: no Add, Remove or Leave (the member set is fixed); archived channels: read-only.

## AP-467 Public and private channels

- A lock replaces `#` (sidebar row, header title, Browse) only when the server says `private`. An older server sends no
  visibility: every channel there is members-only and nothing is marked, so the old sidebar looks as it did.
- Create a channel: a “Private channel” switch (off: public, the contract's default) with “Only people in it can find it
  and read it. Anyone can join a public channel.”, and the people picker (people, then agents) → `memberIds`. On a
  Whombat without `channels.browse` the switch is hidden and `visibility` isn't sent (its channels are all
  members-only); the description keeps its /invite line there.
- Channel settings: burrow owners get the same switch (`conversations.update.visibility`), never for #general and only
  when the server sends a visibility.

## AP-468 Presence

- A dot on people only: filled green (`--presence`) while active, filled grey (`--status-idle`) while away (idle 10
  minutes), an empty `--mut` ring while offline. Always labelled and with a tooltip (“Active”, “Away”, “Offline”), so
  colour isn't the only signal. Where: DIRECT's one-person rows, the members pane, the direct conversation's header,
  the mention list and the people pickers.
- The bootstrap's `presence` is a snapshot at its `serverTime` (`seedPresence`, `useSeedPresence`): listed people as
  listed, everyone else offline; a `presence` event newer than the snapshot wins, an older one is dropped.
- Your own dot follows the realtime connection (`ownPresence`): open → active; connecting, reconnecting → away; closed
  → offline; no socket at all (fixtures) → active, so the footer looks as mocked.
- On a Whombat without `presence` no dot shows on anyone else (the footer keeps its own).

## AP-469 The bell

- An outlined 36px icon button after the header's actions (channels, DMs, direct conversations, branch rooms; not on an
  archived channel): BellRing for All, Bell for Mentions, BellOff for Nothing; its name and tooltip “Notifications:
  Mentions”. Its menu is the sidebar's context menu with `menuitemradio`s: All “Every new message”, Mentions “@you,
  @channel, @here and your threads”, Nothing “Only what needs you”, the one in effect ticked and the kind's default
  marked “(default)” (`defaultNotifyLevel`). Choosing the default stores null (back to the default if it changes).
- `useSetNotify` applies the level at once everywhere it shows (sidebar, lists, the detail) and confirms with the
  server's answer; a failure refetches and says so in a toast. `conversation.notify` (another device) patches the same
  places instead of refetching them.

## AP-470 Muted conversations

A conversation at Nothing is muted: its sidebar row is dimmed (`--mut`), never bold for plain traffic, and its badge
counts only its mentions; without mentions a 13px BellOff labelled “Muted” stands where the badge would be. Row menus
offer Mute / Unmute (Nothing / the default). The tab title, favicon and app badge (AP-98) count only a muted
conversation's mentions, and direct conversations count like agent DMs. Unread counts are otherwise the server's.

## AP-471 The channel menu

The channel header gets “More” (⋯, `aria-label` “More for #billing-v2”): Members, Channel settings (members, not
archived), Archive or Unarchive channel (`canArchiveChannel`: burrow owners and the channel's creator, never #general),
Leave channel (members, not #general, not archived). The sidebar's right-click menu keeps Channel settings and
Knowledge and adds Mute/Unmute, Archive channel (burrow owners: a sidebar row doesn't know the creator) and Leave
channel.

## AP-472 Archived channels

Read-only: the composer's place says `ARCHIVED_CHANNEL_TEXT` (“This channel is archived.”) in the composer's frame, with
Unarchive for those who may; an “Archived” chip beside the title; no bell. Archiving asks first (“It leaves everyone’s
sidebar and becomes read-only: no new messages, and no agent or automation works in it. Its history stays, and you can
find it under Browse channels → Archived to unarchive it.”). An archived channel leaves the sidebar (also through
`conversation.updated`), stays open where you are, and is found under Browse → Archived.

## AP-473 Leaving

Leaving a public channel happens at once (you can join it again from Browse); leaving a private one asks first (“to
come back, someone in it has to add you again”). Leaving the channel on screen goes to the burrow's home.

## AP-474 The do-not-disturb moon

While do not disturb is on, a moon sits at the right of the sidebar's user row: “Do not disturb until 14:30” (“until
tomorrow 08:00”, “until Sat 08:00”); during quiet hours “Quiet hours until 08:00” (`quietLabel`). It is a button to
Settings → Notifications (`/settings?tab=notifications`, W3's tab; a Whombat app without the tab opens General). The
label refreshes every 30 seconds, so the moon goes when DND ends.

## AP-475 Older runtimes

Each entry point asks the runtime (AP-256): `conversations.direct` (New message; links to `/direct/:id` still open),
`channels.browse` (Browse, the ⌘K channels, Join from a channel page, Archive, the private switches, the lock's note in
the members pane), `notifications.levels` (the bell, Mute), `presence` (dots). Leaving and adding members use the
existing endpoints and need no feature. Nothing calls an operation the runtime lacks.

## AP-476 The header with more buttons

The bell and More are 36px outlined squares after the actions (after W1's “Pinned · N”, which drops its word in a
header under 1000px). Beside a right pane the header wraps its actions to a right-aligned second line instead of
squeezing the name (the name keeps at least 200px and ellipsizes); the mock's widths keep one line. `pnpm visual` hides the bell, More, the header's lock and ⌘K's channels (`hideAdditions`,
AP-306); the stack link looks as drawn.

## AP-477 The essentials fixture world

`VITE_FIXTURE_CONVERSATIONS=1` (or `conversations: true` in `createWebFixtureFetch`) adds `app/conversationFixtures.ts`
over the shared world (W1's `essentialsFixtures.ts` / `VITE_FIXTURE_ESSENTIALS` are the message states, a separate
layer): Mara's direct conversations with Joris (one unread) and with Priya and Tom; Joris active, Priya away, Tom
offline; #general and #incidents public, #billing-v2 private, #incidents muted; #design-crit (public, Mara not in it),
#leadership (private) and #q3-launch (archived, created by Mara); Mara in do not disturb for 90 minutes unless her
preferences say otherwise. It answers Browse, join, leave, add, archive, create, update, set-notify, open-direct, mark
read and messages in its conversations like the runtime (no realtime: the app refetches). Off by default, so the mock's
screens stay as drawn.

## AP-478 The client

`@whombat/client`: `sidebarSummaries`, `directOthers`/`directName`, `byRecentActivity`, `isMuted`/`unreadBadge`,
`pickablePeople`/`pickableAgents`/`matchesPrincipal`, `mergePresenceSnapshot`, `ownPresence` (pure,
`conversations.ts`); the cache keeps `sidebar.direct` (new, renamed, members) and drops archived channels on
`conversation.updated`, patches Browse rows, patches `conversation.notify`, bumps and clears unread in direct
conversations; `seedPresence`, `useSeedPresence`, `useSetNotify`, `useBrowseChannels`. Mobile (stream M) can use the
same helpers.

## AP-479 Tests and the visual check

Unit: `packages/client/src/conversations.test.ts`, `apply.test.ts` (direct and archived `conversation.updated`, the
notify patch, `seedPresence`), `paths.test.ts`, `apps/web/src/app/shell/sidebarEssentials.test.ts` (order, presence,
retired, muted, private, the tab count, the moon). Components on the fixture world: `features/conversations/
conversations.test.tsx` (DIRECT, New message, the direct conversation, Browse and join, archived, the bell, muted rows,
the members pane, create a channel, the footer) and `gating.test.tsx` (an older runtime). `pnpm visual` shell,
messaging and search specs pass against the mock. Screenshots at 1440×900 light and dark; at 390×844 the dialogs and
the members pane (the web shell's sidebar doesn't collapse on a phone, AP-407: the mobile app is the phone client).
