# Tabs that look like tabs on the phone (AP-2630…AP-2639)

John, 2026-10-19: “when I visit Connections we have tabs, but it's unclear which tab is active on mobile”, then “I agree
with everything, please implement fully”. Follows settings-tab-android.md (AP-2620…AP-2629). Phone only: the web's tabs
already have the underline (`Tabs.module.css`).

## AP-2630 An underline says where you are

Connections' tabs filled the open one with `sf2` (dark) or `sf` (light) on a `sel` track (connections-page.md AP-2584).
In the dark theme that is #2e2925 on about #2c2825, the same colour to the eye, so only the words' colour said which tab
was open. The rule from now on: an underline says which page or part you are on (tabs); a filled pill (`Segmented`) is
for picking a value (the theme, a range, Off · Ask · On). Tabs are `ui/UnderlineTabs.tsx`; `ConnectionsSwitch` and its
track are gone.

## AP-2631 The look

The web's tabs at phone sizes. A row with a 1dp `line` hairline under it, reaching over the page's side padding
(`bleed`) so the hairline runs from edge to edge. Each tab is 44dp tall: its name 14.5/500 in `mut`, its count after it
in mono 11.5/500 (`mut`), and the tone's 7dp dot when something in it isn't fine. The open tab is 600 in `ink`, its count
in `ink2`, with a 2dp `ink` underline lying over the hairline. No fills and no track. A pressed tab gets the `sel` wash,
the open one none; focus shows the app's ring.

## AP-2632 Fill or scroll

Up to four tabs share the row equally, centred, when each one's words fit its share on a 360dp phone (`tabsLayout.ts`:
the longest tab's characters, its count and dot included, times the shares, at most 40). More, or longer ones, scroll
sideways, each as wide as its words with 12dp on each side; the row starts 12dp less than the page's padding in, so the
first tab's words line up with the page. A trailing control takes a share. When the open tab changes, the row scrolls
just far enough to show it with 24dp of the next one peeking in; on opening it shows at once.

## AP-2633 Connections, a server and a guest

**Superseded in part by docs/decisions/overview-one-page.md OVP-01, OVP-11**: Overview has no tabs; its sections have jump chips
under the title. A server's and a guest's tabs stay.

Connections' Servers · Services · Pinned keep their counts, dots and spoken words (`connectionsTabs`). A server's
Summary · Guests · Backups (or Summary · Array · Guests · Plugins) and a guest's Summary · Settings · Snapshots ·
Backups · Tasks are tabs too; a guest's five scroll.

## AP-2634 A connection's page

Its tabs (“Integrations 171”) are underlined. Settings opens the Connection screen, so it is no tab: a button with its
chevron on the right of the row, outside the scrolling tabs and always in sight, in the tabs' words (14.5/500 `mut`).

## AP-2635 What stays a segmented control

Every other `Segmented` picks a value, so it stays: the theme in Settings, This Whombat's range, Spend's window, the
audit log's Actor filter, Off · Ask · On for keys, an agent's Checkout and Access, a server's Asks you first, Backup
file's “When something is different”, and Add a server's “How to add it” (signing in or a command: two ways to do one
thing, not parts of a page). Chip rows stay chips: they filter a list or pick a chart. `Segmented` keeps its
five-or-more sizing for a value list that long.

## AP-2636 TalkBack and touch

**Superseded in part by docs/decisions/overview-one-page.md OVP-01**: Overview has no tab row, so no “Connections: what to show”.

The row is a `tablist` named for TalkBack (“pve-02: what to show”, “Connections: what to show”), each tab a `tab` with
`selected`, read by its `spoken` words, else its name and count. Settings is a button with its hint. Every tab and
Settings is 44dp tall; the touch-target audit lists `UnderlineTabs`, and it reads in the order shown.
