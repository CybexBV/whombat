# Clearing a channel, Copy in the right-click menus

John, 2026-10-02 (on dev.whombat.com): “I would like to be able to right click on a message and be able to delete it.
When I right click on a channel I want to be able to remove all messages in that channel so the channel is empty
again. When I have selected text the context menu should offer a copy option.” Contracts CT-216 (0.35.0); the runtime
side is Whombat `docs/decisions/channel-clear.md` (CC-01…CC-05).

Deleting a message from its right-click menu was already there (AP-440…AP-442: “Delete message”, last and in the bad
tone, for your own messages and, for owners, anyone's); nothing changes about it.

| ID | Decision | Why |
|---|---|---|
| AP-614 | **“Clear all messages” in a channel's menus, for owners, on runtimes with `channels.clear`.** The sidebar's right-click menu and the header's “More” menu end with it, separated and in the bad tone like “Delete message” (`canClearConversation`: owners, channels; the header only when you're in the channel). It always asks first (`ConfirmDialog`, kicker CLEAR CHANNEL, “Clear all messages in #name?”, “Every message in #name is removed for everyone, with its replies and files. This can’t be undone. Threads that still hold work in progress stay: a live run, an approval waiting for a decision, an agent working there.”, button “Clear all messages”); a refusal stays in the dialog. Done: the toast “Cleared #name.”, or with kept threads “Cleared #name. 1 message stays: it holds work in progress.” / “… N messages stay: they hold work in progress.” (`clearedText`), and the conversations, message lists, threads and pins are fetched again besides the `message.deleted` frames. Not in the mock: the existing menu and dialog language. `FEATURE_NAMES` calls it “clearing a channel”. Android unchanged (no channel menus there yet). | John asked for it; destructive and for everyone, so owners only and always confirmed. |
| AP-615 | **“Copy” first in a right-click menu when text is selected in the row.** `useRowMenu().open` takes the selection when the menu opens (`selectedTextIn`: a non-empty selection that intersects the row) and puts “Copy” first, the row's own items after a separator; it copies with the clipboard API, else the copy command on a hidden text area. Every right-click menu built on `useRowMenu` gets it (messages, sidebar rows, plan steps, members). A message without other actions now opens a menu with “Copy” alone instead of nothing; with no items and no selection no menu opens. | Our menu replaces the browser's, which offered Copy; selecting words in a message and right-clicking should still copy them. |

### AP-616 whombat-app 0.24.0

AP-614 and AP-615 as 0.24.0, on contracts 0.35.0 (CT-216, `SESSION_API_LEVEL` 25 unchanged). Tests:
`features/conversations/conversations.test.tsx` (clear from the sidebar's menu: the dialog, the toast, the empty
channel), the menus in `Sidebar.test.tsx`, `conversations.test.tsx` and `gating.test.tsx` (hidden without
`channels.clear`), `features/messaging/essentials.test.tsx` (Copy first over a selection, copied text; Delete message
on the menu). Visual: checked in fixture mode at 1440×900, light and dark (the sidebar menu, the dialog, the cleared
channel with its toast, a message's menu over selected text). No baseline changes (the visual suite's screens don't
open these menus). Released like 0.23.0.
