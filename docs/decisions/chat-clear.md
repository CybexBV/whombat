# Clearing Chat, and right-click menus in the web sidebar (2026-10-21)

John, 2026-10-21 (main checkout): “In the WEB UI I want to be able to right click in the sidebar and see a dialog screen
where I can select options, for example when I right click on “Chat” in the sidebar it should have an option to “Clear
Chats” (but keep the threads when we click on Threads). Consider useful options for all other menubar items and if there
aren't any then do not show a dialog at all.”

Contracts **0.119.0** (CT-990…CT-994: `chats.clear`, the `chat.cleared` frame, feature `chat.clear`, audit
`chat.cleared`), migration **0133**, whombat-app **0.121.0** (its `docs/decisions/chat-clear.md`, AP-4500…). The menus
themselves are the app's; this file is what clearing means and the server's part.

| # | Decision | Why |
|---|---|---|
| CHC-01 | *What clearing does to the threads: superseded in part by chat-inbox.md CIB-13 (they settle when they can).* *Where the threads are found: superseded by chat-settle.md CHS-13 (search; the room's head lists settled threads only).* **Clearing hides, it doesn't delete.** In Chat every top-level message is a thread's first message (CHT-02), so “clear the chat but keep the threads” can only mean: the room's top-level messages up to now leave the room's view, and every thread stays in the Threads list and opens as before (`?thread=`), with its replies. Nothing is removed: no files, reactions, pins, search documents, plans or cards go. Search, Needs you's Answer and every link to a thread keep working. | John's words; removing the roots would remove the threads. |
| CHC-02 | **Chat and Feedback only, each person their own.** `chats.clear {room}` clears the caller's own Chat (default) or Feedback room (CHT-01, CHT-03). Both are private to their person, so the mark is the room's: `conversations.room_cleared_at` (migration 0133, expand). Channels keep their owners' Clear all messages (CC-01), which removes; DMs with team agents, direct conversations and task chats aren't offered it. Agents can't clear (“Only people clear their Chat.”). A runtime advertises `chat.clear` only in the assistant shell, with `chat.channel`. | The rooms a person reads alone; no member-level marks needed for a room with one reader. |
| CHC-03 | **What reads the mark**: `messages.list` (the room's timeline, for the person, any app: the phone's Chat shows the same), the MCP read of the room's top level, and the turn's window (`contextWindowCandidates`): only top-level messages after the mark. Threads (`messages.thread`, `chats.threads`, a turn's own thread) ignore it. The earlier thread a new thread's first turn sees (CH-03) needs its root in the window, so it starts after the mark too. | “Clear” means a fresh start for the assistant as well: what the person no longer sees, it no longer reads at the top. Inside an old thread it still has that thread. |
| CHC-04 | **Its context goes with it**: summaries of the room's top level (`conv:<id>`) are dropped and its active top-level provider sessions retired, as `forgetStaleContext` does for an edit. Thread scopes (`thread:<id>`) are kept: a thread continued from Threads still has its own. | Without this a resumed session would still remember what the person cleared. |
| CHC-05 | **Read and quiet**: the person's read mark moves to the room's newest top-level message (never backwards), so its badge clears, and the person's other tabs and phone get `conversation.unread` and `chat.cleared {conversationId, room, clearedAt}` (topic `me`) and read the room again. | A cleared room with a badge would be odd; one frame for every app of the person. |
| CHC-06 | **One signed event**: `chat.cleared` (Messages, “Cleared Chat” / “Cleared Feedback”, payload `{conversationId, room, cleared}`: ids and the count of top-level messages that left the view, never words). The answer is `{room, conversationId, clearedAt, cleared}`; an empty room answers `cleared: 0` without an event or frames, and keeps its mark. | Same shape as `channel.cleared` (CC-04, CC-05); the app says “was already clear”. |
| CHC-07 | **Clearing again moves the mark forward**; there's no undo. A backup file doesn't carry the mark (its messages are off by default); a restore with messages shows them again. | Nothing was lost, so an undo isn't needed to recover anything; the Threads list holds it all. |

## Delivery

DEV only. Contracts first (0.119.0), then this server (migration 0133, `chats/clear.ts`, `messagePage`'s and the
window's `after`), then whombat-app 0.121.0 vendored here, then the DEV candidate (IN-366). Checks: `pnpm check` and
`pnpm test:server` once (DEV fast, IN-132). The new `chats/clear.int.test.ts` needs Postgres for the read mark, the
filtered timeline and the turn's window.
