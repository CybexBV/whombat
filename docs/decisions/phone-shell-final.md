# The phone's final shell: tabs, Places, Back and Search (PSH)

John accepted the final design (`docs/design-handoff/council-ui-2026-11/16-final/`, `SHELL.md` and `search/`). This is
the iPhone and Android part of it: the five tabs stay, a row with Search and Places sits above each tab, Places is one
sheet with every place in the web sidebar's order, pages pushed over the tabs start with Back, and Search is a page of
its own. The web's shell is another workstream's.

| # | Decision | Why |
|---|---|---|
| PSH-01 | **The bar keeps its five tabs**: Chat · Inbox · Overview · Automations · Settings, in that order. Files, Vault and Usage are pages pushed over the tabs, never a sixth tab. Our bar's tabs are 48dp tall (Android's smallest target); every new control of the shell is at least 44pt on iPhone and 48dp on Android (`SHELL_TARGET`). | SHELL.md: the same five tab identities on both platforms; 48dp on Android. |
| PSH-02 | Superseded by app chat-inbox-phone.md AP-9370 (one top row: ☰, the title, Search). **Above each tab, one row: Search at the left, Places at the right**, under the status bar and over the tab's own header, with a hairline under it. The tab's layout gives it to the tab's `Screen` (`ScreenTopContext`), so no tab screen draws it itself and a pushed page has none. | SHELL.md: native top-level chrome is a 48px row with a Search text link and Places. |
| PSH-03 | **Superseded in part by servers-connections-places.md SCP-01** (Servers and Connections are places in the sheet, after Overview; no shortcut to each server and connection). **Places is one sheet, the platform's own** (`ui/sheet.tsx`: iOS's form sheet, Android's bottom sheet): Close first, then Search, Chat, Inbox, Overview, Automations, Files, Vault, Usage and Settings, the open place marked, Chat's unread count and the Inbox's count (in `warn`, `bad` only when something there isn't working) said once in words; then a shortcut to each server and connection with its real logo, servers wearing their system's logo as Overview's Servers does. It scrolls at large text instead of shrinking a row. A place opens once the sheet is down; a tab closes the pages above the tabs. Closing it puts a screen reader back on Places. **Files leaves Chat's header**: it is one of Places (Feedback, Settled and What {assistant} did stay, as AP-7460 orders them). | SHELL.md: one Places menu in desktop order, real-logo shortcuts, no second Files home in room actions. |
| PSH-04 | **A page opened from another starts with Back**, the platform's (iPhone the chevron and the previous page's title, Android the arrow named “Back to …”), with no Search and Places row above it. Files, Vault, Usage and Search name the page they were opened from (`back`), and carry Places at the right of their back row, so Search stays one tap away there. | SHELL.md: Back first; Places may share the Back row; the recorded origin supplies the title. |
| PSH-05 | **Search is a page** (`screens/SearchScreen.tsx`, `data/search.ts`): one field, and what it finds as Chats (Chat's and Feedback's threads, with “Waiting for you”, “{assistant} is working” or their replies), Things (servers and connections, logo and how they are), Settings (You, Notifications, Theme, the assistant, Connections, This Whombat, the box's screen, Advanced and its pages) and Places. Every word must match. It has a first page with real suggestions, Searching while the chats and things are read, Couldn't search with Try again, and No results with Clear search. A result opens with “‹ Search”; going back finds the words, the list and the scroll as they were, and the words are kept in the route across a restart. A link's `/search?q=…` opens it with those words. It reads only what the app already reads; no AI answer, nothing written. | SHELL.md and search/NOTES.md: a dedicated Search screen on every platform, grouped in plain words, with distinct states. |
| PSH-06 | **iPhone's tab badges are readable in both themes**: every badge is the unread pill's `btnfg` on `btn` (light words on dark, dark words on light in dark mode), not iOS's white on red. UIKit draws all badges in the selected tab's look, so the colour can't differ per tab; the Inbox's name says “something isn't working” to VoiceOver when that is so. The words' colour needs our patch of react-native-screens (`patches/react-native-screens@4.26.2.patch`, `tabBarItemBadgeTextColor`). | SHELL.md: readable token-coloured iOS badges at 4.5:1; red only for Not working. |
| PSH-07 | **Spend is called Usage on the phone**: its page's title, its place in Places and Search, and its Advanced row. The page itself, its address (`whombat://spend`) and what it shows are unchanged; Search lists it once, as a place. | SHELL.md: Usage is the display name of the existing Spend content, findable outside Advanced. |
| PSH-08 | **Kept**: the 1.6× text cap (`theme/Text.tsx`), the tab labels' fitting (duo-polish.md AP-6550) and Chat's header fitting (phone-refresh-status.md AP-7460). No brief result or setting in Search (brief-removed.md). | The accepted design changes neither; briefs are removed. |

## What this replaces

- `docs/app/decisions/native-feel.md` AP-6412 (iOS's red badges), by PSH-06.
- `docs/app/decisions/phone-refresh-status.md` AP-7463 in part (iPhone keeps iOS's red badges), by PSH-06;
  AP-7460 in part (Files in Chat's header), by PSH-03.
- `docs/app/decisions/one-layout-android.md` AP-2645 in part (a search link has no phone screen), by PSH-05.
- `docs/decisions/settings-groups.md` STG-10 in part (Spend's one place on the phone is Advanced), by PSH-07.

## Checked

`pnpm --filter @whombat/mobile typecheck`, lint, the mobile unit tests (`data/places.test.ts`, `data/search.test.ts`,
the links, the static touch-target, dynamic-type and reading-order audits). On the Android emulator in the demo world,
light and dark and at the largest system text: the row above every tab, Places open, Search's first page, results,
no results, a result opened and back with the words kept, Files, Vault and Usage with Places beside Back. Not seen: the
iPhone's badge colours and Places sheet on a device (the patch is native and needs an iOS build).
