# Automations as a tab on the phone (2026-10-30)

John, 2026-10-30, in the main checkout: “Is there a way that I can see what the automations are in the Whombat iOS or
Android app? If not, is there room for another button for automations?” The only way in was a row at the foot of
Connections. A mock-up of a fifth tab (both phones, the narrowest ones measured) followed, then “Implement the automation
button”. Phone only: no contract or runtime change.

| # | Decision | Why |
|---|---|---|
| AP-6310 | *Superseded in part by inbox.md IBX-01 (docs/decisions): the second tab is Inbox.* **Automations is a tab of its own: Chat · Needs you · Connections · Automations · Settings**, the web sidebar's order, with the lightning bolt the sidebar uses and no badge (a run waiting for a yes or a failed one counts on Needs you, the one count). The page is today's, opened as a tab: the big title, no back button. The row at the foot of Connections goes. `whombat://automations` and the hosted UI's `/automations` open the tab; a run or Talk about it opens over it with “‹ Automations”, and with two pages beside it, the right page saying “Pick a run to see it here.” until then. Supersedes needs-you-list.md NYL-10. | The list was a scroll to the bottom of another tab away, so nobody found it. Both platforms' guidelines allow five tabs. |
| AP-6311 | **Five words fit the bottom bar on every phone**: the words are 11 px (12 before), each at least 2.5 px clear of its tab's edges. Where a tab is narrower than that needs (74 px for “Automations”, 69 px at 11 px semibold), the bar's side margins go from 10 to 4, then the words to 10.5 px: an iPhone 16/17 or a Pixel keeps 10 and 11, a 384 dp phone gets 4 and 11, an iPhone mini or SE (375 pt) and a Galaxy S (360 dp) get 4 and 10.5 (`navigation/tabBarFit.ts`). Larger system text shrinks back to fit its tab instead of wrapping. The iPhone Duo's side tabs were 11 px already. | At 12 px “Connections” (71) and “Automations” (73) nearly touch on a 393-point phone and overflow a 68-point tab on a Galaxy S; iOS's own tab bars use 10. |
| AP-6312 | **The demo world has three automations** (`fixtures/automations.ts`): a tracker report flow, a GitHub one with a run waiting for a yes, a weekday summary, switched on and off in memory. | So the tab is seen and checked with rows in it, not “Automations didn’t load.” |
