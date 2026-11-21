# The assistant looks first, on the web and in the shared client (AP-5900…AP-5919)

John, 2026-10-27 (main checkout): a look said “Home Assistant needs a look” and nothing else. The assistant now looks
into a look by itself and says what is wrong; it offers one step on a button, or none when only the person can fix it.
What happens is Whombat's `docs/decisions/look-research.md` (LR-01…LR-12); the wire is contracts 3.5 (`LookResearch`,
`NeedsYouItem.research`, `ThingPage.research`, `DeskHero.research`/`fix`, `looks.fix`, `DESK_WORDS.looks.looking`,
`lookingSoFar`, `fixing`, `ask`, `DESK_WORDS.calm.ignore`). The reference is the mock of four desk cards John approved
(looking, found with a step, only you can, fixed); Home's Needs you and a thing's page tell the same story in their own
layout. The phone's decisions are AP-5920…, its own file.

**The shared client logic is commit `0ce14ea16`** (branch `looks-w`): merge it for the phone.

## Shared client (`packages/client`)

### AP-5900 One view of a research, for every screen

`lookResearchView(research, assistant, reason?)` (`home/lookResearch.ts`) says what a screen draws, or null for the
look as before (no research, or `failed`, LR-11):

| state | title | the line by the assistant's face | spinner | step | Ignore | Ask {assistant} |
|---|---|---|---|---|---|---|
| looking | the look's own | “I’m looking into it.”, with “So far: {reason}.” when the screen gives a reason | yes | – | yes | – |
| found | the assistant's | its summary | – | its label, when it offers one | yes | yes |
| fixing | the assistant's | “I’m on it.” | yes | – | yes | yes |
| fixed (green) | the assistant's | its summary | – | – | – | yes |

The words are `DESK_WORDS.looks` and the research's own; nothing new is worded. Ask isn't offered while it looks (the
mock's first card has only the quiet button): there is nothing to ask about yet. Nothing to ignore once it is fixed:
the look goes by itself on the next pass.

### AP-5901 Needs you rows carry it

`needsYouRows(items, now, timeZone, assistant)` adds `research` (`needsYouResearch`) to a row whose item has one: the
row's title is the assistant's, its grey body is left out (the summary is on the face's line), and its buttons are
`needsYouResearchActions`: *Look into it* goes from the start (it is being looked into); once it found out the snooze
goes too (Ignore is the choice there, LR-10) and what is left, a place where something is done (*Reconnect*), follows
the step as a second choice. While it looks the item keeps its words and its other buttons, and the line says
“I’m looking into it.” only: the body already says what Whombat knows. Without the assistant's name a row is as before.

### AP-5902 Ask opens the look's thread

`lookThreadHref(research)` is `/chat?thread=<threadRootId>` (the look's thread in the person's Chat, LR-04);
`needsYouAskIntent(item)` opens it, or, without a thread (an answer that has none), starts a chat about the item as
*Look into it* did, so the button always does something.

### AP-5903 The step's press reads “I’m on it.” at once

`useFixLook(burrow, onDone)` (`react/looks.ts`) sends `looks.fix` with the look's key. Home's items and the thing pages
of that look read `fixing` without the step the moment it is pressed (`fixingResearch`, `withNeedsYouResearch`,
`withThingResearch`), the server's research replaces it, and a refusal or a failure puts the card back with its step;
both are read again after the answer. Its toast is only for when it didn't go through (`lookFixOutcomeText`): 403
“You can’t change this.” (the desk settings' word), 404 “That isn’t needed any more.”, else the shell's “That didn’t
work. Try again in a moment.” Going through needs no toast: the card says “I’m on it.” and the thread has the person's
“Go ahead”.

### AP-5904 The preview's hero buttons

`deskHeroButtons(hero, {assistant, server})` mirrors the screen's hero for Settings → Screen's picture of it: *Answer*
on a question; on a look the step first (`fix`, only `found`), *Ask {assistant} to fix it* only on a down server
nobody looked into, *Open {server}* (outlined after a first button, filled when it is the first), and *Ignore* last,
where *Not now* was. Ignore is on every look's hero, researched or not: LR-10 says the hero offers Ignore where it
offered Not now, and only the card behind it keeps both. Once fixed there is nothing to ignore.

## The web (`apps/web`)

### AP-5905 Home's Needs you: the assistant's words on a line of their own

A researched item is a two-line row (`features/home/NeedsYouCard.tsx`): the tile and the title (the assistant's, or the
item's own while it looks, with its grey body after the “·”), then under the title the assistant's head (20 px) and its
words (`LookSays`, shared with the thing page), a spinner first while it looks or takes the step; the buttons on the
right across both lines, under them on a narrow page. The step is the solid first button, Ignore is outlined beside it
(the mock's second button) and Ask {assistant} is quiet (ghost) last; while it looks, Ignore stays quiet as on any other
row. Fixed: the tile turns green with a check, only Ask is left. When it came stays the row's tooltip: Home's rows have
no “Since” line, unlike the desk's hero. The step's press is `useFixLook` through `useNeedsYouActions().fix`; Ask goes
through the same `run` as the other intents.

### AP-5906 A thing's page: a card at the top of the Summary

`ThingPage.research` is a card above the Summary's panels (`features/things/page/LookCard.tsx`), on the Summary only:
the look's dot and the assistant's title, its words by its head (22 px), the step (primary) and Ask {assistant} (ghost),
tinted in the look's colour (the page's status: bad or offline red, else amber; green once fixed). While it looks, the
card is the line “I’m looking into it.” alone. No Ignore on it: the research doesn't name the line it is about, and
that line's ⋯ in Worth a look, right under it, has Ignore. Ask opens the look's thread, or the page's Ask pane without
one. A server's page has no research yet (LR-12).

### AP-5907 Settings → Screen's preview

The preview's hero draws `deskHeroButtons` (AP-5904) and, for a look the assistant looked into, its words by its face
(40 px at the screen's size, from `useTheAgent`) with a spinner while it looks or takes the step, the title a size down
(46 px, cut with an ellipsis) so the assistant's longer title stays on its line and the words at most two lines; green
(hero and the top edge) once fixed. The fake desk world's *Something’s wrong* shows its down server as found, with
“Restart {server}” (`fakeWorld.ts` `researched`), only while core's preview planner doesn't give the hero a research of
its own (stream S makes `deskPreviewInput` do so; then this does nothing). Its baselines changed accordingly.

### AP-5908 Inbox's NEEDS YOU is unchanged

`features/inbox/NeedsYouRow.tsx` draws `WorkItem`s (approvals, runs, plan steps, failed turns), which carry no research
in contracts 3.5: nothing to show there. A look reaches the person through Home, its page, the desk and its thread.

### AP-5909 The fixture world's looks

`app/lookFixtures.ts`, a layer over Home, the thing pages and Chat: Home Assistant found with “Restart Zigbee”, the
hallway access point that only Mara can fix (UniFi), pve-02 being looked into, each a Needs you item, its page's
research (Home Assistant, UniFi) and a thread of Mara's Chat that Neo started, listed among the threads and opened by
Ask. Pressing the step posts “Go ahead: restart Zigbee.” in its thread and reads `fixing`; a read 4 s later finds it
fixed (“Zigbee works again”) with Neo's word in the thread: the fixture world has no `home.changed`, so the screen shows
it on its next read (coming back, a page's own refresh). Off unless `VITE_FIXTURE_LOOKS=1` or
`localStorage['whombat:fixture-looks']`, so Home, Chat and their tests stay as the mocks draw them. The visual baselines
are `visual/looks.spec.ts` (Needs you in each state, Home Assistant's Summary, both themes, 1440×900), compared by eye
with the mock's four cards.
