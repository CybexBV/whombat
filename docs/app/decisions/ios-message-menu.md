# The message menu on iPhone (2026-10-28)

John, 2026-10-28, in the main checkout, with a screenshot of the long-press sheet on the iPhone Duo: “This pop-up
doesn’t look to be native, if true can you improve this?” It wasn't: the sheet (AP-502) is the app's own, drawn the
same on both phones. No contract or runtime change.

| # | Decision | Why |
|---|---|---|
| AP-6260 | *Its lift and dimming superseded by AP-6272 (ios-native.md): the compact menu where the message is held.* **On iPhone a long press on a message opens iOS's own context menu** (`UIContextMenuInteraction`): the message lifts over the dimmed conversation with the menu beside it, the system's haptic, its animation and its dismissal. Android keeps the sheet (AP-502), which is how Android's own chat apps show a message's actions. Everywhere a message row shows (Chat, Feedback, threads, conversations); a message still sending has no menu, as before. | What iOS's own apps do (Messages, Mail, Files); a sheet sliding up from the bottom, as wide as a phone in the middle of the open Duo, read as foreign there. |
| AP-6261 | **The menu holds what the sheet held** (`nativeMenuSpec`, from the same `messageMenu`): the six quick reactions as a row of emoji on top (a palette; the viewer's own on the reaction pills' `sel` circle with a `brand` ring), then “More reactions” (the smiley symbol) on a line of its own, which opens the emoji sheet once the menu has gone; then the actions with the system's symbols, a line between the groups — the thread (Settle thread or Open again, Reply in thread), copying (Copy text, Copy link), changing (Edit, Pin or Unpin) and Delete, red and last. What answered an agent's reply (“Claude · Opus · High effort”) is the menu's quiet title. No first lines on top: the message itself is lifted. | The same choices on both phones; only the drawing is the platform's. A palette shows six across and scrolls a seventh out of sight, so “+” at the end of the row would be hidden. |
| AP-6262 | *Superseded by AP-6272 (ios-native.md): nothing lifts.* **What lifts is the part of the message on screen, at most 40 % of the window tall**, with a 10-point margin (8 above and below) of the conversation's background and 14-point corners. | A long reply would otherwise shrink to fit whole, too small to read; the lines the person was looking at say which message it is. |
| AP-6263 | **`modules/whombat-menu`, a small native module of our own** (Swift, iOS only): a view around the message row that takes the menu as JSON and sends back the id of a pick once the menu has gone, so the emoji sheet, the edit sheet or Delete's question isn't presented over a menu still closing. The row's `Pressable` keeps a long press that does nothing, so letting go after the menu opened isn't a tap that opens the thread. Without the module (Android, tests, a build from before it) the sheet opens. | A context-menu library would bring a native dependency tree for one view; the app already keeps its platform code in small modules of its own (`whombat-fold`, `whombat-voice`). |
| AP-6264 | **On iPhone a copy says so in the app's toast** (“Copied the text.”, at the bottom, gone by itself), not in an alert to dismiss (`copyToClipboard`). Android keeps its own: the system's preview from Android 13, the toast before. | An alert that has to be tapped away after every copy is not how an iPhone app confirms anything small. |
| AP-6265 | **A sheet dims the whole window behind it**, also beside the panel where a wide window (the open Duo) keeps it a phone's width (AP-5811), and **the emoji sheet wraps its grid to the panel's width**, not the window's. | On the open Duo only the strip above the sheet was dimmed, and the emoji grid ran past the panel's right edge. |

## Checked

`pnpm check`; the demo world's Release build on Xcode 27.1's iPhone Duo simulator (iOS 27.1), open, light and dark: the
long press on a person's message in Chat (Settle thread on a thread's first message), on an agent's reply in a thread
(its runtime as the title), on a long message (the part on screen lifted, readable), a quick tap still opening the
thread, and the picks — a reaction (reaches the app; the demo world has no reactions route), More reactions (the emoji
sheet, the window dimmed, twelve to a row), Copy text (the toast) and Reply in thread (the thread on the right page).
