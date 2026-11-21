# A calmer sidebar (SB-02…SB-12)

John (2026-10-19, main checkout) asked how the web sidebar could be better, with a screenshot of his DEV box (Chat ·
Feedback · Connections · Watch 18 · Automations 2 · Vault, SERVERS and SERVICES with a dot on every row, the theme pill
beside the burrow's name). My ten suggestions, and his answer: “I agree, but add more spacing between the logo and the
first menu entry. Implement this fully.” SB-01 is the Vault in the sidebar (settings-sidebar.md); this file continues
the series. Contracts 0.95.0 (CT-453 `ThingSummary.reason`, CT-454 `HomeSummary.worst`), whombat-app `sidebar.md`
(AP-2600…).

## SB-02 Watch's badge in its worst item's colour

**Superseded by needs-you-list.md NYL-04**: the badge is Needs you's, the one count, in its worst item's colour.

The badge counts the open Watch items as before, coloured by the most serious one (`summary.worst`, CT-454): red for a
problem, amber when the worst is something to look at, grey for hints only. A badge that is red all day for things
that only need a look stops being read. The server sends the first open item's severity (Watch is sorted worst
first); an older server sends none and the badge stays red.

## SB-03 Why it isn't fine

A thing that isn't fine says why in a few plain words (`ThingSummary.reason`, CT-453), shown in its sidebar tooltip and
read with its name (“blackbox, needs a look: filling up”). Where the words come from:

- a server: the hosts service's own note (“Filling up”);
- Home Assistant: “Started in recovery mode”, else “3 integrations not loading”, else “1 repair waiting”;
- UniFi: “The gateway is offline”, “1 access point offline”, “2 devices offline” (its badge's words);
- a check that failed: its line (“Couldn’t reach it”, “It answered with an error”, “Needs to be connected again”).

The health pass keeps the reason in the glance (`ConnectionGlance.reason`, not stored anywhere else). A thing without
words for it (a device, Hetzner, a kind without a reader) says its status alone.

## SB-04 A dot only when something isn't fine

The sidebar draws a status dot for what needs a look (amber), has a problem (red) or is offline (grey ring), and the
dashed one for a device being learned. Fine and not checked yet draw none, as an agent's dot shows only while it works
(AP-946). The three that need attention are what the eye finds. Screen readers still hear every row's status.

## SB-05 The burrow alone at the top

The theme pill leaves the sidebar's head: “Light” in the dark theme read as the state, not the switch, and took room
from the burrow's name. The switch is in the account menu as an action (“Switch to light theme”). The head has more
room under it before the first place (John).

## SB-06 One face for names

Servers' names were in the mono face and services' in the sans one: one list looked like two, and mono reads as a
developer's tool. Every name in the sidebar is in the sans face; a server's page keeps the host name in mono where it is
copied.

## SB-07 No count on Automations

“Automations 2” said how many exist, which tells nobody anything; a run that failed is on Watch.

## SB-08 Two groups of places

**Superseded by final-shell-web.md FSW-01**: one order of nine places, no groups.

**Superseded by needs-you-list.md NYL-05**: Needs you takes Watch's place beside Chat.

What comes to you first — **Chat**, **Feedback**, **Watch** — then a gap and what you set up — **Connections**,
**Automations**, **Vault**. Watch moves up beside Chat because both are where something waits for you. Before the
Chat shell, Connections is the home page (`/`) and stays first, without groups.

## SB-09 A Proxmox or Unraid connection found by its server's name

John's Unraid connection showed under SERVICES although it is blackbox: blackbox answers on 10.100.0.40 (where its
containers' pages are, and where the connection points), while its agent reports 10.100.1.23, so the address match of
CP-10 missed. The health pass now reads Unraid's own hostname (`{ info { os { hostname } } }`, kept in the glance as
`hostname`), and a Proxmox or Unraid connection whose address matches no server is part of the one server whose
hostname (or id) is that name, case and a domain ignored; the name in its address (`tower.local`) counts too. Two
servers with the name: no match. The address still wins when it matches.

## SB-10 Both `+` buttons add right away

**Superseded in part by sidebar-tabs.md SBT-03**: one `+`, for the open tab; Add a connection opens `/connections?connection=add`.

SERVERS' `+` opens Add a server on Connections' Servers tab (`/connections?tab=servers&add=1`); SERVICES' `+` opens
Add a connection, the page Connections' own button opens (`/settings?tab=connections&connection=add` where the catalog
is), not the Connections settings overview it opened before.

## SB-11 SERVERS and SERVICES fold

**Superseded by sidebar-tabs.md SBT-03, SBT-04**: the two lists are tabs; a problem in the other tab still shows.

A section's heading folds its list; the browser remembers it (`whombat.sidebar.folded`). Folded, the rows that aren't
fine stay (and the one open now), with how many are tucked away beside the heading, so a problem never hides behind a
fold. Nothing folds by itself.

## SB-12 Where it is built

Web only: the phone has no sidebar. The phone's lists keep their dots (a fine server there says “Running” with its
dot, AP-2585).
