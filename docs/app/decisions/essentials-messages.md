# Essentials, web messages (2026-09-30): decisions (AP-440…AP-459)

Stream W1 of the essentials build (Whombat `docs/implementation/essentials/assignment.md`): item 8 (edit and delete),
item 14's emoji picker, pinned messages, link previews, search filters and “New canvas”, and item 11's “Reply in thread”
on every message, in the web app and `@whombat/client`. Contracts 0.26.0 (CT-166…CT-184) are settled; the runtime side
is R2's. W2 (direct conversations, channels, the bell, presence), W3 (settings) and M (mobile) work beside this.

## AP-440 One toolbar and one menu for every message

**Superseded in part by AP-6141 (chat-polish.md)**: the toolbar has no Add reaction; it is in the menu only.

- A message row (conversation and thread pane) shows a small toolbar at its top right while the pointer is over it or
  focus is in it: **Add reaction**, **Reply in thread** (conversation only), **More actions**. It replaces the single
  “More actions” button (WS-09) in the same place and style (28px buttons, `--line2` frame, `--bg`), and stays while its
  menu or picker is open.
- The menu (More actions, or a right-click on the row): Reply in thread, Add reaction, Edit message, Pin to this
  conversation / Unpin, then the existing Make a plan and Learn this as a skill, and **Delete message** last in the bad
  tone (`ContextMenuItem.danger`, new).
- What a message offers is one pure function, `messageActions(m, {viewer, features, place})` (`messageActions.ts`), from
  core's rules: `canEditMessage` (people, own, not a card), `canDeleteMessage` (own; burrow owners anyone's),
  `canPinMessage` (people), and the runtime's features (AP-447). A message still being sent and a tombstone offer
  nothing.
- Keyboard: More actions is the row's one tab stop (as before); the toolbar's other two buttons are `tabIndex=-1`
  because the menu has both. The menu keeps the context menu's arrows / Esc / Tab.

## AP-441 Editing in place

- Edit message (or ↑ in an empty composer or reply box, no modifier, no files attached: the viewer's newest message in
  view that they may edit) replaces the text with an editor: the composer's card look with a brand border, a box that
  grows, “Enter to save · Esc to cancel”, Cancel and Save. Enter saves, Shift+Enter adds a line, Esc cancels without
  closing the pane behind it (it stops the event). Unchanged text just closes. Empty text saves only on a message with
  attachments (core's rule; the server checks too). The too-long rule is the composer's (`messageFits`).
- An edit is **not optimistic**: the editor shows “Saving…” until the server answers, then the server's copy replaces
  the message everywhere (`useEditMessage` → `upsertMessageEverywhere`). A refusal keeps the editor and the typed text
  with the reason (“That needs a person to approve it first. We’ve asked.”, “You can’t do that to this message.”, an
  unknown outcome: “Not confirmed yet: …”). After saving or cancelling, focus returns to the composer (or the reply box).
- The editor is a plain text box: no `@` picker. A mention typed in an edit counts (the runtime wakes or notifies only
  what the edit adds, `addedMentions`).
- “(edited)” sits after the time in the meta line, mono meta in `--mut`, with “Edited 11:28” as its tooltip; in the
  thread pane too.

## AP-442 Deleting, and the tombstone

- Delete message asks first, in the channel modal's language: “Delete this message?”, “It’s removed for everyone in
  #billing-v2.” (plus “Its replies stay, under “This message was deleted.”” when it has replies; an owner removing
  someone else's message reads “You’re removing Joris de Vries’s message as a burrow owner. …”), the message's first
  160 characters as a quote, Cancel and Delete (primary: there is no danger button in the design system). A refusal
  stays in the dialog. Success toasts “Message deleted.”.
- Not optimistic (a delete is destructive, AP-14). Answered without a message it leaves every list, its thread, the pins
  and search at once and is remembered as a tombstone, so a late `message.updated` can't bring it back
  (`removeMessageEverywhere`, the same path as the `message.deleted` event). Answered with the tombstone, that replaces it.
  A thread pane whose root is removed closes.
- A tombstone (`deletedAt`) shows no author: a 40px (32px in the pane) `--sf2` circle with a bin, “This message was
  deleted.” in muted italics, and its thread link. No reactions, previews or actions. Its accessible name is “Deleted
  message, 11:27”.

## AP-553 Deleting a thread's first message removes the thread

2026-09-30, John: “The whole thread should be removed when I remove the first message.” The server removes the replies
with it (Whombat EC-04b), so the dialog now says “It’s removed for everyone in #billing-v2, with its 2 replies.” (“…, with
its reply.”; mobile: “It’s removed for everyone in this conversation, with its replies.”) instead of AP-442's “Its
replies stay …”. The server's refusals (another person replied and you're not an owner, an agent still working there,
live work in the thread) stay in the dialog as before. Every removed message arrives as `message.deleted`; the open
thread pane closes. Tombstones still render for threads deleted before (until they're removed too).

## AP-443 Reply in thread on every message

The toolbar's Reply in thread and the menu item open `?thread=<id>` on any top-level message (clearing a plan, the plans
list and the pins pane), even without replies: the thread endpoint answers for any message, on every runtime, so there
is no feature gate. The reply box takes focus (a one-shot request, `replyFocus.ts`, so opening a thread from its link or
an address doesn't move focus). The thread pane has no Reply in thread (everything there is in the thread already).

## AP-444 Reactions and the emoji picker

**Superseded in part by AP-6141 (chat-polish.md)**: the picker opens from the menu's Add reaction only; the small
“Add reaction” pill after the pills is gone.

- Add reaction opens a popover (`EmojiPicker`, the context menu's surface, 340px): a search field (focused), the quick
  reactions 👍 ❤️ 😂 🎉 👀 ✅ (`QUICK_REACTIONS`), a button per group (`EMOJI_GROUPS`, the group's first emoji, its label as
  name and tooltip; it scrolls there and shows which group is in view), then **Recent** and every group in an 8-column
  grid with sticky mono headings, and a footer naming the emoji under the pointer or focus. Typing replaces the grid with
  core's `searchEmoji` results (“No emoji match “x”.”); Enter picks the first result.
- Keyboard: ↓ from the search moves into the grid; arrows move there (left/right in order across sections; up/down keep
  the column, clamped to short rows, stepping between sections; ↑ from the first row goes back to the search), Home/End,
  Enter or Space picks, Esc closes and returns focus to what opened it, Tab out closes. One tab stop in the grid (roving
  `tabIndex`). The model is pure and tested (`emojiModel.ts`). The picker closes on a click outside, the page scrolling,
  a resize or the window losing focus.
- A pick toggles: an emoji the viewer already gave is marked in the picker (`aria-pressed`) and picking it takes it
  back, like its pill. Recent is per browser: `localStorage` `whombat:recent-emoji` (core's `pushRecentEmoji`, at most
  16), read strictly (a short list of short strings), kept in memory when storage refuses. It isn't account data and is
  not cleared on sign-out (like the theme).
- Pills keep the mock's look exactly (“👍 · 2”, sf2, mono); the viewer's own is told by `aria-pressed` and the tooltip
  (“Joris, Priya reacted with 👍”), not a new border, so the mock's rows compare unchanged. A small “Add reaction” pill
  (mouse only, shown on hover) follows them. Emoji characters use `--font-emoji` (AP-451).
- Reactions work in the thread pane too (pills, toolbar, picker); before this the pane showed none. `messages.react`
  exists on every runtime and a reaction's value is the character (`ReactionValue`), so there is no gate.

## AP-445 Pinned messages

- Pin to this conversation / Unpin in the menu (people; not a tombstone), optimistic with rollback (`usePinMessage`,
  `applyOptimisticPin`), toasting “Pinned to #billing-v2.” / “Unpinned from #billing-v2.”. A pinned message shows a
  small pin and “Pinned” after its time (mono meta, `--mut`); tooltip and accessible name “Pinned by Mara Okafor”.
- The header shows **“Pinned · N”** (pin icon, a header action like Plans, placed before Plans) only while something is
  pinned; N is `conversations.pins`' length (read when a conversation opens, on a runtime with `messages.pins`). Beside a
  pane (the header under 1000px, a container query) it shows the pin and the count only; “Pinned ·” stays for screen
  readers, so the name is always “Pinned · N”.
- It opens the pins pane, `?pins=1` (a `1` like `focus=1`; one pane at a time: a plan wins over the plans list, the plans
  list over the pins, the pins over a thread; Esc and × close it): “Pinned” with the conversation, `PINNED · N`, rows newest
  pin first with the author, when it was said, three lines of it (or its files), and “Pinned by Mara Okafor · 11:10”.
  A row scrolls a loaded top-level message into view and highlights it for 1.6 s (`--hi`), leaving the pane open;
  anything else (older history, a thread reply) opens as a thread (a reply's root).
- W2's direct conversation screen gets the same by passing `pins={usePinnedCount(...) ? {count, href: here(PINS_SEARCH)}
  : undefined}` to `ConversationHeader` (`PinsPane.tsx` exports both).

## AP-446 Link previews

Messages with `previews` show compact cards under the text (and attachments), in rows and the thread pane: the site name
(else the host) in mono, the title as the link in brand/600, two lines of description; a 3px `--line2` edge, `--sf`, no
images. The whole card opens the link, in a new tab with `rel="noopener noreferrer"`. Rendering is driven by the data: a
runtime without `messages.previews` never sends any, so there's nothing to gate. A tombstone has none.

## AP-447 Older Whombats

`useOptionalFeature(feature)` (`messageFeatures.ts`) reads the managed runtime's features like `useLongMessages`; over
the legacy server, in fixtures and outside the app's providers every feature is there. Without `messages.edit` there is
no Edit or Delete (and ↑ does nothing); without `messages.pins` no Pin/Unpin and no “Pinned · N”, and a pins address says
“Update your Whombat to use pinned messages.”; without `search.filters` the filter row is hidden and no filter is sent
(the plain search still works). Reactions, Reply in thread, previews and New canvas need nothing new.

## AP-448 Search filters and Load more

- Under the type chips, a row of native selects in the chip's pill frame (a chevron, ink border once set): **From**
  (“From anyone”, then people and agents by name, handles as values; removed and retired ones marked, their messages
  still count), **In** (“Anywhere”, then the sidebar's channels, direct conversations — by their other members, W2's
  `Sidebar.direct` when present —, agent DMs and branch rooms), and **When** (Any time, Today, Last 7 days, Last 30 days,
  Custom dates; days in the viewer's zone). Custom shows Start and End date fields (inclusive, as the contract says).
  “Clear filters” resets all four.
- The address holds them: `/search?q=&type=&from=<handle>&in=<cnv_…>&after=<YYYY-MM-DD>&before=<YYYY-MM-DD>`, each
  dropped when malformed. The presets aren't in the address; they are read back from the days.
- Empty states: “No results for “x” with these filters.”, and “Nothing matches these filters.” with no query (`q` may be
  empty when a filter is set).
- **Load more** appears while the last page has `next`; each further page is its own cached `search.query` (by
  `cursor`, `useQueries`), so realtime patches reach every page. Results are shown once each (by id); chip counts come
  from the first page.

## AP-449 New canvas

The Canvases list has “New canvas” (primary, the roster's “Hire an agent” place). The dialog, in the channel modal's
language: NEW CANVAS, “Start a canvas”, TITLE (1–160) and CHANNEL (optional: “No channel” or one of the viewer's
channels, the canvas's breadcrumb), Cancel / Create canvas. `canvases.create`, the list is refetched and the new canvas
opens. The dialog focuses itself, not the field, like every modal here.

## AP-450 The cache

- `upsertMessageEverywhere` (events, edits, pins, optimistic copies) also patches the conversation's
  `conversations.pins` (join when `pinnedAt`, leave when unpinned or a tombstone, replace in place; newest pin first, at
  most `PINS_MAX`) and `search.query` results showing that message (`MESSAGE`/`THREAD` with its id): an edit shows its
  plain words (the runtime's snippet is the plain text's first 1000 characters), a tombstone leaves with its chip counts.
- `removeMessageEverywhere` (the `message.deleted` event and an own delete) takes it out of lists, threads, pins and
  search, and drops its own reads.
- `useEditMessage`, `useDeleteMessage`, `usePinMessage` and `usePins` join `@whombat/client/react`; mobile can use them.

## AP-451 `--font-emoji`

A token, `--font-emoji` (`emojiFontFamily`: Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Twemoji Mozilla,
sans-serif), for emoji on their own: picker cells and the emoji in a reaction pill. Without it a text font's monochrome
glyphs won on Linux. It isn't a type style's family (mobile draws emoji natively).

## AP-452 The visual suite

`pnpm visual` keeps comparing against the mock: `hideAdditions` also hides the message toolbar, the “Add reaction” pill,
“Pinned · N” and the search filter row. None of these change a row's layout (the toolbar is absolute, the pill takes the
reactions' height), and the mock world has no pins, previews or edits unless seeded (AP-453).

## AP-453 Fixture mode

`essentialsFixtures.ts` gives the shared fixture world (which lacks them) `messages.edit`, `messages.delete`,
`messages.pin`, `messages.react`, `conversations.pins`, search filters with cursor paging and `canvases.create` (and
reading what it created), as patches applied to every message read; tests, `VITE_FIXTURES=1` and the fake managed world
use it. `VITE_FIXTURE_ESSENTIALS=1` (or `essentials: true`) also seeds #billing-v2 with Mara's edited message with a link
preview and emoji reactions, a deleted thread root with two replies, Priya's message pinned, two search results of
Mara's, and pages search by six. Swatch's rich messages (`VITE_FIXTURE_RICH`) aren't patched.

## AP-454 Screenshots

`tmp/visual/essentials-messages/` (not committed), fixture mode with the seed, light and dark, at 1440×900 and at
646×844 (the page gets a phone's 390px beside the 256px sidebar, AP-388): the room with the toolbar, the menu, the
picker and its search, the editor, the delete dialog, the pins pane, the tombstone in the thread pane, search with and
without filters (Load more), and the New canvas dialog.

## AP-455 Left open

- The conversation header was already tight beside a pane (Plans, WS-09): at 1440 with the thread pane, a channel title
  like “billing-v2” wraps. The compact pins button helps; the title's own wrapping is the header's (W2 touches it too).
- The edit box has no `@` picker (AP-441).
- Mobile (stream M) renders its own reactions, pins and previews; the client hooks here are shared.
