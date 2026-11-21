# Right-click menus on the places, and Clear chats (AP-4500…AP-4529)

John, 2026-10-21: “In the WEB UI I want to be able to right click in the sidebar and see a dialog screen where I can
select options, for example when I right click on “Chat” in the sidebar it should have an option to “Clear Chats” (but
keep the threads when we click on Threads). Consider useful options for all other menubar items and if there aren't any
then do not show a dialog at all.” What clearing means is Whombat's `docs/decisions/chat-clear.md` (CHC-01…CHC-07);
contracts 0.119.0 (CT-990…CT-994). Web only: the phone has no sidebar, and its Chat shows the cleared room as the
runtime serves it.

## AP-4500 A menu per place

The Chat shell's places open the sidebar's right-click menu (`useRowMenu`, the crew sidebar's look and keys: arrows, Esc,
focus back to the row; `navMenu` in `assistantSidebarModel.ts` says what each holds):

| Place | Menu |
|---|---|
| Chat | Threads · **Clear chats** (below a line, in the bad tone) |
| Feedback | Threads · **Clear feedback** |
| Connections | Add a server (owners where the servers service runs, as the SERVERS `+`) · Add a connection |
| Automations | New automation |
| Vault | Add to Vault |
| Watch | none |

Threads opens the room with its Threads list (`?threads=1`). The other entries are each page's own main button, opened
from anywhere. The row keeps its hover background while its menu is open (`.menuOpen`).

## AP-4501 Nothing to offer, nothing at all

Watch has no page-wide action (its actions belong to its items: Look into it, Remind me tomorrow, Acknowledge), and the
SERVERS, SERVICES and CONVERSATIONS rows are pages in a list whose Ask is one click away on the page, so they get no
menu. Right-clicking them, or anywhere else in the sidebar without a menu (a heading, Ask, the person, the space
between), shows nothing: the sidebar holds back the browser's own menu, as the crew sidebar's SM-02 does. Only a text
field keeps it, for paste and spelling. Middle-click and Ctrl/⌘-click still open a row in a new tab.

John, 2026-10-22, after the first version kept the browser's menu there: “The items that do not have a menu should show
nothing when I click my right mouse button on it.”

## AP-4502 Clear chats asks first

“Clear Chat?” (`CLEAR CHAT`) says the messages leave Chat, that the assistant (by name) starts fresh on the next
question, and that every thread stays in Threads; its button is “Clear chats”. Feedback: “Clear Feedback?”, every report
stays in Threads, “Clear feedback”. The entry shows only where the Whombat has `chat.clear`. The menu's label keeps
John's words in the sentence case of the other menus. The words live in `features/chats/clearWords.ts`.

## AP-4503 What it says after

A toast: “Cleared Chat. Every thread is still in Threads.” (“Every report …” for Feedback), or “Chat is already clear.”
when nothing was left to clear. A refusal stays in the dialog in the server's words.

## AP-4504 The room is read again

After `chats.clear` the room's `messages.list` is reset (its newest page is read again, older pages dropped) and
`chats.list` refetched for the badge; the `chat.cleared` frame (`query/apply.ts`) does the same on the person's other
tabs and on the phone. Threads, an open thread and the Threads list are untouched.

## AP-4505 Fixture mode

`chatChannelFixtures.ts` answers `POST /chats/clear` for Chat: the timeline starts after the clear (at least the newest
message's time, since the world's times are of today), Threads lists every thread as before.

## AP-4506 Feature names

`FEATURE_NAMES['chat.clear']` is “clearing Chat”.

## AP-4507 Two pages opened by address

`/automations?new=1` opens New automation and `/vault?add=1` Add to Vault (closing either drops the flag, `replace`), so a
menu entry is a link like the others. The Vault's stays shut past its limit (`canAdd`).
