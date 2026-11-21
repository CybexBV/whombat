# A thread opens at its latest reply (AP-676)

John on DEV (2026-10-03): “When I open a thread, we should automatically scroll towards the bottom to see the latest
reply.”

## AP-676 The thread pane scrolls to the bottom when it opens

`ThreadView` scrolls its list to the bottom when the thread's messages first arrive and whenever another thread is
shown in the same pane (its root changes). Replies and typing lines that arrive later move it only for a reader at the
end (ui-jumps.md AP-9010). The
mock opened at the root; the visual specs scroll the list to the top before the shot, so they compare as before.

## AP-6450 The thread stays at the end while its replies settle

John on DEV (2026-11-02): a long thread opened above its latest reply, and the rest seemed to load while he scrolled.
A thread of 30 replies or more draws off-screen rows at a guessed height (WX-02), and cards, previews and images grow
after their message, so the one jump to the bottom at open landed thousands of pixels above the end (measured: 2,245px
in a 49-reply thread). `useThreadScroll` now follows the end, like the room does: a resize observer on the list and each
of its rows moves the list to the end again while the reader is there.

## AP-6451 Only the reader's own scrolling takes the thread away from the end

Whether the reader is at the end changes only on a scroll that follows their wheel, key, touch or pointer (within
250 ms, longer while a flung scroll goes on, and while they hold the scrollbar). The browser's scroll anchoring moves the
list as rows above take their real size, and a resize can be seen before the scroll event that caused it; judging those
by position pulled a reader who scrolled up back down, or left the button's jump short.

## AP-6452 “Scroll to the end ↓” further up the thread

More than half the list's height (at least 240px) above the end, a quiet pill “Scroll to the end” with a down arrow sits
over the list's bottom edge, centred on the reply column: the surface colour with a hairline and the toast shadow (not
the room's dark “New messages ↓”, which says something new came in). A press jumps to the end at once (a smooth scroll
through rows of guessed height would land short) and the thread follows the end again.
