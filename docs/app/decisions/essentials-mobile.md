# Essentials, mobile (2026-09-30): decisions (AP-500…AP-519)

Stream M of the essentials build (Whombat `docs/implementation/essentials/assignment.md`): the mobile parts of items 4
(failed turns), 5 (branch rooms by repo), 8 (edit and delete), 9 (direct conversations), 11 (browse, join, reply in
thread, archived), 12 (notification levels, Do not disturb, quiet hours) and 14 (reactions, link previews, pins,
presence), in `apps/mobile` on contracts 0.26.0 (CT-166…CT-184). The runtime side is R1/R2/R3's; the shared client
hooks are W1's (`useEditMessage`, `useDeleteMessage`, `usePinMessage`, `usePins`) and W3's (`useRetryTurn`), merged from
`main`. Nothing here is mocked: every screen follows the inbox's grouped-list language and the DM's chat language.

## AP-500 The `turn_failed` card on the phone

- A failed turn's message shows its card under the bubble (`TurnFailedCardView`, the compact card frame: `sf`, `line`
  border, radius 16): the failure's short state in the bad tone (`TURN_FAILURE_LABELS`, “NOT SIGNED IN”), its safe
  sentence — left out when the message's own text already is that sentence, which is what the runtime posts — and
  “Try again” (a 44dp primary button) for people who may wake that agent there (`canRetryTurn`: a personal agent's owner
  only, never a retired agent), on a runtime that has `dispatches.retry`. The card summary list (`cardSummary`) leaves
  `turn_failed` to this view; `ChatItem.turnFailed` is the pure model (`data/turns.ts`, `turnFailedView`).
- Pressing it calls the shared `useRetryTurn` (W3): the card says “Tried again · 14:32” at once, the label quietens to
  neutral, and a toast says “Asked Pippa to try again.”. A refused retry's words sit under the card in the bad tone; a
  409 (the agent was retired, the person left) is final and the button goes (`isFinalRetryRefusal`, as on the web).
- TalkBack reads the card as one stop: “Pippa couldn’t finish. Not signed in. {sentence}. Tried again · 14:32”.
- A sign-in failure has no “Open AI accounts” link on the phone: the sentence names Settings → AI accounts, and the
  settings sheet already sends people there (SUB-11).

## AP-501 Try again in the Work view

- `retry_turn` maps to `{kind: 'retry_turn', dispatchId: refs.dispatchId}` (`workCommand`), a primary button, once
  per failed turn: a retried item (`failure.retriedAt`) offers nothing and shows “Tried again · 14:32”. The row shows the
  failure's label (bad, quiet once retried) and sentence in place of a detail that repeats it, and — for owners and
  admins, exactly when the server sends `failure.detail` — “Show details”, which opens the redacted technical detail in
  the code surface (`colors.code`, mono, selectable). Compact Inbox rows show the sentence on one line and no detail.
- The button goes through the same `useRetryTurn`, then the Work view is read again (`settle`), with the same toast.

## AP-502 The message menu is a long press

*On iPhone superseded by AP-6260…AP-6263 (ios-message-menu.md): iOS's own context menu; Android keeps the sheet.*

- A long press (350 ms) anywhere on a message opens a bottom sheet (`MessageMenuSheet`): the message's first two lines
  quietly on top, the six quick reactions (`QUICK_REACTIONS`, 44dp circles; the viewer's own on `sel` with a brand
  ring) and “+” for the full emoji sheet, then the actions as 52dp rows: Reply in thread, Edit, Pin / Unpin, Delete
  (last, bad tone). The wrapping `Pressable` is `accessible={false}`, so TalkBack still reaches the cards, links and
  replies inside; the message's own controls keep working.
- What a message offers is one pure function, `messageMenu(m, viewer, {inThread, features})`
  (`data/messageActions.ts`), from core's rules (`canEditMessage`, `canDeleteMessage`, `canPinMessage`) and the
  runtime's features: Edit and Delete need `messages.edit`, Pin needs `messages.pins`. Reply in thread is offered on
  any top-level message outside a thread (item 11); a reply and the thread screen don't offer it (the composer already
  replies there). A message still sending has no menu; a tombstone offers only Reply in thread and no reactions.
- The viewer is `messageViewer(bootstrap.me)`: a person with their burrow role, so owners get Delete on anyone's message.

## AP-503 Tombstones, “(edited)” and former members

- A deleted thread root (`deletedAt`) shows `MESSAGE_DELETED_TEXT` in a quiet dashed bubble (`Tombstone`), no card,
  attachments, reactions or previews, and keeps “N replies ›”. The chat item is built without reading the gone fields.
- An edited message says “(edited)”: after the time in the author line when one is shown, else a small mono line under
  the bubble on its side (`EditedMark`). A pinned message has a small “Pinned” mark above it.
- An author who left or an agent that was retired gets core's `principalStatusLabel` (“former member”, “retired”) after
  the name in the author line (CT-177); nothing else changes in history.

## AP-504 Editing in a sheet

Edit opens `EditMessageSheet`: the text in a growing field (auto-focus), Cancel and Save. Save is held while nothing
changed, the text is empty (a message with files may lose its text, per CT-173) or too long (`messageTextFits`); the
reason shows under the field (`editProblem`). The message keeps its old text until the server answers (W1's
`useEditMessage` replaces it everywhere); a refusal stays in the sheet. No inline editing in the list: a phone's
keyboard covers half the screen, and a sheet keeps the field in view.

## AP-505 Deleting asks first

Delete asks with the system alert (`deleteConfirm`): “Delete this message?” — or “Delete Tom Beck’s message?” for an
owner deleting someone else's — with “It’s removed for everyone in this conversation.” or, for a thread root with
replies, “Its replies stay; it shows “This message was deleted.” for everyone.”; the destructive button says Delete.
W1's `useDeleteMessage` takes it out of every list and the pins at once.

## AP-506 Direct conversations on the Channels tab

- DIRECT lists agent DMs and direct conversations with people together, newest activity first (`directSection`,
  `byRecentActivity`; conversations without a message last, in the server's order). A direct row shows the other
  members' faces (`DirectFaces`: one face with its presence dot, two stacked for a group), the title core computes
  (`directTitle`: “Priya”, “Priya and Tom”, “Priya, Tom, Jamie and 2 others”), and “Direct” or “3 people” as its mono
  line. An older server without `sidebar.direct` lists the DMs as before.
- “New message” (`NEW_DIRECT_MESSAGE`) is the last row of DIRECT on a runtime with `conversations.direct`, and opens
  `NewMessageScreen`: a search field, the burrow's people as 64dp checkbox rows (`pickablePeople`: members who haven't
  left, never agents, never yourself; `matchesPerson` on name, any word of it, or handle) with their presence, at most
  eight picked (`DIRECT_OTHERS_MAX`; the rest dim and the line says “A conversation has at most 9 people, you
  included.”), and a sticky 52dp button “Message Priya and Tom” (`newMessageCta`) that calls
  `conversations.openDirect` and replaces itself with the conversation.
- A direct conversation opens in `ConversationScreen` (kind `direct`): header faces and title as in the row; the
  subtitle is the one other person's presence (“Active”, “Away”, “Offline”, plus their title) or “3 people”; the
  composer says `Message Priya and Tom` (`composerPlaceholder({kind: 'direct'})`), and while the typed text mentions an
  agent (core's `resolveMentions` over the bootstrap's principals) a quiet line above the field says
  `DIRECT_AGENTS_HINT` (“Agents aren’t in this conversation”). No “What agents remember” for a direct conversation. The
  empty state says “This is the start of your conversation with Priya.”.
- Routes: `{type: 'direct', id}` links and `whombat://direct/:conversationId` open the conversation by id (an alias of
  the Conversation screen's path); web paths `/direct/:id` in either form map to it (`appUrlForPath`) through
  `BURROW_ROUTES`' `/direct/$id`, which W2 added with the web router's route (the web's router test wants both at once,
  so this branch didn't add it itself and merged it from `main`).
- The names, order, badge and picker rules are the shared ones from `@whombat/client` (W2's `conversations.ts`):
  `directName` / `directOthers`, `byRecentActivity`, `unreadBadge` / `isMuted`, `pickablePeople`, `matchesPrincipal`;
  `data/direct.ts` keeps thin wrappers that take the app's `People`.

## AP-507 Reactions

- Reactions show as 32dp pills under the message on its side (`ReactionRow`: emoji + mono count; the viewer's own on
  `sel` with a brand outline), a tap adds or takes back (the shared optimistic `useReaction`), and a “+” after them
  opens the emoji sheet. TalkBack reads each pill as “thumbs up, 3 people, you too” (`reactionPills`, the emoji's
  CLDR name from core's `emojiByChar`; a text reaction reads as itself).
- The emoji sheet (`EmojiSheet`): a search field over core's `searchEmoji` (results only, best first, “No emoji match
  that.” when none), else RECENT (the phone's own list, `whombat.recentEmoji` in the secure store, `pushRecentEmoji`,
  ≤ 16, unknown characters dropped on read) and every group in `EMOJI_GROUPS` order with its label; 44dp cells, the
  emoji's name as the accessible label. Picking one the viewer already reacted with takes it back, like its pill.

## AP-508 Link previews

A message's `previews` (≤ 3) show as compact cards under the bubble (`LinkPreviews`, 84% wide, a 3dp `line2` left
edge): the site name or, when the page named none, the link's host without `www.` (`hostOf`), the title on two lines,
the description on two. No images (CT-174). A tap opens the link in the system browser; TalkBack reads “Link: {title},
{site}, opens in your browser”.

## AP-509 Pins

Pin / Unpin are on the long-press menu (W1's `usePinMessage`); the header's “More” has “Pinned messages”, which opens
`PinsScreen`: `conversations.pins` newest pin first as rows — the author's avatar and name, “pinned by Mara · 11:20” as
the mono line, the message's first lines (a card says “A card”, files say “2 files”, a tombstone says its text) — under
a `PINNED · N` label; empty: “Nothing is pinned here yet. Long-press a message and pick Pin.”. A pinned reply opens its
thread; a top-level one returns to the conversation (no scroll-to-message on the phone yet). Every pinned message also
carries the small “Pinned” mark in the conversation.

## AP-510 Presence for people

`BurrowProvider` seeds the shared presence cache from the bootstrap's `presence` snapshot (W2's `useSeedPresence`,
CT-179); `usePresenceOf()` answers a person's state from the shared `usePresence` events (the snapshot as a fallback
for the first render), offline for everyone else and for anyone who left (`isActivePrincipal`). Agents have no presence dot
(their status is their own). The dot (`PresenceDot`: `ok` active, `warn` away, a hollow `mut` ring offline) sits at
the bottom right of a person's avatar in direct rows, the direct header and the New message picker; it is decorative —
the words say it (“Priya active” in the row's label, “Active” in the header and the picker's mono line). The phone
doesn't report its own presence beyond the socket (the runtime marks a connected client active).

## AP-511 A conversation's notification level

*On iPhone the “More” button opens iOS's own menu with the same choices (AP-6271, ios-native.md); Android keeps the
sheet.*

Every conversation screen (channels, branch rooms, direct, agent DMs) gets a 44dp “More” button at the end of its
header (`MenuButton`; `ChatHeader.right`), opening `ConversationMenuSheet`: NOTIFICATIONS as a radio group of All /
Mentions / Nothing (`NOTIFY_LEVEL_LABELS`), each with what it lets through (“Every new message”, “Mentions, @channel and
replies in your threads”, “Only what needs you”) and “· default” on the kind's default, the level in effect checked;
then “Pinned messages” and, outside direct conversations, “What agents remember” (the title's link stays too). The
group shows only on a runtime with `notifications.levels`, pins only with `messages.pins`. Picking the default sends
`notify: null` (the conversation follows the default again), anything else the level (`notifyBody`); the sidebar and
the detail show it at once and the answer confirms (the shared `useSetNotify`, W2).

## AP-512 Muted rows

A conversation set to Nothing reads muted on the Channels tab: its badge counts only mentions, and with none a small
crossed-out bell (`BellOff`, labelled “Muted”) takes the time's place. A private channel (`visibility: 'private'` from
the server; absent says nothing) shows a lock in its tile. Archived channels never reach the sidebar (the server leaves
them out; the row model drops any that do).

## AP-513 Do not disturb and quiet hours in the settings sheet

- The settings sheet gets DO NOT DISTURB and QUIET HOURS under THEME (`NotificationsSection`), on a Whombat with
  `notifications.levels` and outside the demo world (no account there). Do not disturb: a dot (`warn` while on) and the
  state (“Off”, “On until 14:52”, “On until tomorrow at 08:00”; `dndStateText`, `endsText`), “Turn off” while on, the
  three quick durations as secondary buttons (`DND_PRESET_LABELS`, `dndUntilFor`), and “Until” with a typed time and
  Set: a typed “18:30” means the next time the clock shows it in the person's zone (today if still to come, else
  tomorrow; `dndUntilClock`, `parseClock` takes `7:30`, `0730`, `07:30`); a bad time says “Type a time such as 18:30.”.
  The web's hint under it: “Holds back push and email notifications until then. Your inbox still fills, and it ends on
  time.” A toast confirms (“Do not disturb until 18:30.”, “Do not disturb is off.”).
- Quiet hours: a 44dp switch with the schedule's words (`quietHoursText`: “Every day, 22:00–08:00 (until the next
  morning)”, “Weekends, all day”, “Off”), and when on: From / To as small mono clock fields (saved when they rest; a bad
  time is put back) and the seven days as toggles (`toggleDay`, the week's order). Email and thread replies stay on the
  web (email needs the capability the sheet doesn't show; the phone sheet stays short).
- Saving (`useSaveNotificationPreferences`, the web's AP-491 rule): read the server's preferences first, send
  `notifications` whole with the change applied to what the server has now, show it at once in the bootstrap, put the
  old value back and say why on failure. The person's zone is the app's (`useBurrow().timeZone`).
- Kinds `direct` and `reply` open the right place already: inbox rows carry their `link` (a `direct` link opens the
  conversation, a reply's `message` link its thread), and a push of those kinds goes through `pushTarget`, which the
  vendoring commit taught them (`reply` with mentions, `direct` before agent updates).

## AP-514 Branch rooms by repository

- `routeForLink` for a `pr` link: the sidebar room with that number and repository (`branchRoomFor`; an older server's
  room without `repo` counts when it is the only one with that number), else — when only one room has the number — that
  room, else the Conversation screen with `{prNumber, repo?}`. The screen resolves it: the sidebar first; not there
  (or from another repo) → `prs.get` with `?repo=` and its `conversationId`; several rooms with that number and no
  repo → a short list (“More than one repository has a PR #1. Which one?”, branch, repo, status dot), never a silent
  pick. Deep links `whombat://pr/:prNumber?repo=owner/name` (an alias of the Conversation path; `repo` is checked as
  `owner/name` before it is passed on) and web paths `/pr/:n?repo=` in either form map to it (`appUrlForPath`; the
  files tab is dropped).
- Branch room rows say `CybexOS #1` instead of `#1` when the rooms span more than one repository (`branchRoomMeta`); a
  branch room's header subtitle names the repository before the PR number.

## AP-515 Browse channels, join, archived

“Browse channels” is the last row of CHANNELS on a runtime with `channels.browse`, opening `BrowseChannelsScreen`: a
search field (`conversations.browse` `q`, sent once the typing rests 300 ms), Active / Archived chips (the `archived`
query means “only archived”, CT-172), rows with the `#name`, member count and “Private” / “Archived”, the topic as the
body, and per row: “Joined” and open for a channel the viewer is in, a 44dp Join button for a public one they aren't in
(joins, then opens it), nothing for an archived or private one they aren't in (`browseRows`). An archived channel opens
read-only: the header says “Archived · …” and `ARCHIVED_CHANNEL_TEXT` (“This channel is archived.”) takes the
composer's place (`ChatView.readOnly`). Creating, archiving, visibility and members stay on the web.

## AP-516 Hooks: shared where they exist, the app's own until they do

`useEditMessage`, `useDeleteMessage`, `usePinMessage`, `usePins` (W1), `useRetryTurn` (W3), `useSetNotify`,
`useBrowseChannels` and `useSeedPresence` (W2) are imported from `@whombat/client/react`; `useOpenDirect` and
`useJoinChannel` (`data/useEssentials.ts`) are thin `useApiMutation`s that refetch the sidebar (and Browse). `useFeature(feature)` is the phone's runtime gate: the managed
session's `sessionRuntime(...).has(feature)` (re-read on every session state change), and true over the legacy server
and in the demo world, where every feature exists. Nothing was added to `packages/client`.

## AP-517 Not mocked, so the language is borrowed

Every new surface reuses what exists: bottom sheets look like the settings sheet (`Sheet`: `ov` backdrop first in the
tree, 22dp radius, the grab handle, the modal shadow, the safe-area bottom); menus are 52dp rows with a 19dp Lucide icon;
lists are the inbox's `Section` + `ListRow`; the failed-turn and link cards are the compact card frame; every control is
44dp or padded to it (`touch-targets.test.ts` lists the new files). New Lucide icons: bell-off, ellipsis, lock,
message-square-plus, pencil, pin, pin-off, plus, message-square-reply, trash, users.

## AP-518 Tests

`src/data/essentials.test.ts` (29 tests; the mobile suite is 246 in 35 files) covers the pure parts per item: the card's view and rules, the Work row's
Try again and failure lines, `branchRoomFor` and the routes and deep links with `repo` and `direct`, the message menu's
rules per viewer and feature, the delete confirmation, the edit rules, tombstones and edit marks in the chat items,
reaction pills and the emoji sheet's sections, link cards, the DIRECT section's order and names, the direct header,
presence seeding, the agents hint, the people picker, Browse rows, muted rows, notification levels and bodies, Do not
disturb text and the typed “until”, quiet hours text. The existing route test's “unknown PR is null” became “opens the
screen that asks”. The static audits (touch targets, TalkBack order, dynamic type) list the new files.

## AP-519 Emulator

Not rendered this round: the debug APK was built (Metro port 23817), but the lead asked to finish before the DEV
release, and the demo world (`@whombat/fixtures`) has no direct conversations, failed turns, pins or previews yet, so a
screenshot would have shown the unchanged screens. Fixture data for these and the emulator pass are the first
follow-up.

## Open

- Fixture-world data for the essentials (a direct conversation, a failed turn, pins, previews, a browsable channel) and
  the emulator screenshots (AP-519).
- Scroll-to-message from a pinned top-level message (the phone has no message anchor yet).
- Android app links (`app.config.cjs`): `/direct/` and `/pr/` are not declared (they'd need a native build); the
  hosted UI keeps them in the browser for now, as AP-367 does for `/pr/`.
