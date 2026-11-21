# The Dashboard becomes Connections (CN-01…CN-10)

John (2026-10-19, main checkout): “Dashboard” is not the right name, he is thinking of Connections; he doesn't like
the Dashboard on the web or the phone; a server's page shows CPU, memory and the rest twice (keep the figures' card
on top and make it clickable for the detailed charts); the Guests list on PVE-02 is “terrible”: the guest's name
matters most, tags matter less (remove them). My proposal (mockups in whombat-app
`docs/design-handoff/connections/`: conn-web, conn-phone, server-web, server-open, guests-web) and his answer: “I agree
fully, implement this”. Contracts 0.94.0 (CT-449…CT-452), whombat-app `connections-page.md` (AP-2501…).

## CN-01 Connections

**Superseded by sidebar-tabs.md SBT-01**: the page is called Overview; its address stays `/connections`.

The Dashboard is called **Connections**: the web sidebar's entry, the phone's tab, the page's title, the crumb on a
server's or connection's page, and every word Whombat, its agents and the contracts say (“pin it to your Connections
page”). Its path is `/connections`; `/dashboard` still opens it (links in older messages). Code names (`home.*`,
`HomeOverview`) stay.

## CN-02 Servers and Services

**Superseded by sidebar-tabs.md SBT-02, SBT-03**: Services is called Connections; the sidebar shows Servers and Connections as tabs.

The page holds two groups of the same kind of card, **Servers** and **Services**. The group called Connections since
HR-48 (Home Assistant, UniFi, Hetzner, the heat pump, Mail) is **Services**, so the page doesn't hold a “Connections”
inside Connections; the web sidebar's sections are SERVERS and SERVICES. “Add a connection” stays the word for adding
either.

## CN-03 The page

**Superseded in part by needs-you-list.md NYL-01**: Needs you is its own list, not a card on Connections.

No greeting. The title “Connections” with the status sentence under it (it says what the assistant is working on; the
persona refers to it as the page's first line) and **Add a connection** on the right. Then **Needs you**, one line per
item (its title, a grey detail, its buttons on the right), then **Servers**, **Services**, and what was pinned from a
chat under **Pinned** at the bottom.

## CN-04 A card per server or service

Logo, name (a server's in the mono face), one grey line of what it is, a status word only when something isn't fine
(a dot with a label otherwise), two or three key figures (a server: CPU with a small line, Memory as a bar, the hottest
sensor with a small line; a service: its live figures), and one line at the foot (“19 of 22 guests running · Up 55 d”,
“Looked after by Dusty · Used today”). The whole card opens the page. Three across on a wide screen.

## CN-05 A figure opens its charts

A server's or connection's Summary keeps its figures' card on top and no longer repeats them as chart cards. A figure
with charts is a button: it opens them inside the same card, with the range (1h…90d) beside them and a close button,
one figure at a time, and the address keeps which (`?chart=cpu`). Network opens the disks' traffic beside its own,
Unraid's Array the disks' temperatures. A figure without a chart leads to its tab (Guests, Storage, Array). The tab
row has no range picker any more. Contracts 0.94 `ThingPageKpi.charts`/`link` (CT-449); a chart no figure names stays a
card.

## CN-06 Connection pages too

The connection pages the server builds (Home Assistant, UniFi, Hetzner) name the charts their figures open, so they
follow CN-05 without a chart repeated under the figures.

## CN-07 The phone

One **Connections** tab replaces Dashboard and Things, which listed the same servers and connections: the bar is
**Chat · Connections · Watch**. The screen: Needs you, Servers as rows with small CPU and memory bars, Services as
rows, Pinned. On a server's or connection's Summary a tapped figure opens its charts under the figures, as on the web.

## CN-08 The Guests list

The guest's name comes first and is never cut; “VM 5911” or “CT 129” under it, or a note (“Restart to apply 1
change”) in amber. Tags are gone from the list (still found by search, still on the guest's page). No State column: a
dot says it, and a stopped guest says “Stopped”, is dimmed and sorts last. CPU and memory as small bars with their
numbers (memory amber from 90 %), uptime short (“55 d”), console and ⋯ as quiet icon buttons, tick boxes only on
hover or once something is ticked. Running guests first by name; a column head sorts by it.

## CN-09 No separate Servers list

The servers list at `/things/servers` is folded into Connections: that path opens Connections, Add a server
(`?add=1`) and the sign-in links still work there, and the view of every guest on every server (`?view=guests`) stays,
linked from the Servers group as “All guests”. A server's crumb says Connections.

## CN-10 Words

The assistant's persona and the widget refusal say the Connections page instead of the Dashboard
(`agent-runtime` persona, `home/widgets.ts`).

# Tabs and the new server card (CN-11…CN-14)

John (2026-10-19, main checkout), after CN-01…CN-10 went live: redesign the server cards after a screenshot he gave
(a header with the server's icon, name, `user@host · up 23d 21h` and a Live pill; four tiles CPU, MEMORY, STORAGE,
TEMP, each a number over a meter of segments). What was good: the logo, the guests running, the system it runs. What
could be better: CPU, Memory and Hottest (Storage instead), and “the CPU written full, so we can see what's inside the
server”. I proposed the cards; he liked them and asked whether Servers and Services should be tabs; I agreed and
proposed them; his answer: “Implement this fully”. Mockups in whombat-app `docs/design-handoff/connections/`
(`tabs.html`, `server-cards.html` and their PNGs); the app's decisions are AP-2564…AP-2599 there. No contract change:
`HostServer.cpu`, `.storage` and `.temperature` already carry every figure, and real servers report them.

## CN-11 Tabs

**Superseded by overview-one-page.md OVP-01, OVP-25**: Overview is one page; Servers, Connections and Pinned are
sections with jump links that carry the count and the dot, and an old `?tab=` scrolls to its section.

Under Needs you, Connections has the tabs **Servers**, **Services** and **Pinned**, each with how many it holds and a
dot in the worst tone of what's in it (an offline server is red; a device being learned is no trouble), so trouble
behind a closed tab still shows. Needs you stays above them: what to act on shows whichever tab is open. Pinned only
when something is pinned; with one group alone there is no tab row. Servers is open by default; the web keeps the open
tab in the address (`/connections?tab=services`), the phone in the screen, where the tabs are a switch. The open tab's
summary (“5 online · 84 of 155 guests running”, All guests) sits on the tab row's right.

## CN-12 A server's card

**Superseded by overview-one-page.md OVP-02…OVP-07, OVP-11**: servers are one list with the same columns, a card per
server only on a narrow page and in the phone app.

**Superseded in part by ui-refresh-status.md UIR-22**: the pill is the status scale's (an offline server's is the
not-working one); “Running” stays.

Its logo on a tile, the name in mono with the system and uptime under it (“Proxmox VE 9.2 · up 55 d”), a status pill
(green Running, the problem's word, grey Offline). Then what's inside it: the CPU written in full (only the (R)/(TM)
marks left out), wrapping rather than cut, with its cores and threads. Then the four tiles (CN-13) and the guests at
the foot (“19 of 22 guests running”; offline, when it was last seen). Two across on the web.

## CN-13 Four tiles: CPU, Memory, Storage, Temp

**Superseded in part by overview-one-page.md OVP-02, OVP-03, OVP-04**: the figures are columns of a server's row,
the figure first with its word, the processor's last 24 hours as a line; a figure still opens its charts and the
thresholds stand.

Each tile: the figure as a number with its unit, a meter of segments (the reference's), and a small line: the CPU's
24-hour average, memory and storage used of the total, the temperature's limit. On the card Hottest becomes Temp and
Storage is added; the CPU's 24-hour line becomes its average. Amber and red as the server page
says (memory and CPU from 90 %, storage from 80 / 90 %, temperature by its sensor). A tile opens its figure's charts on
the server's Summary (CN-05), Storage its Storage tab. The phone shows the tiles without the small line.

## CN-14 Services look the same

**Superseded by ui-refresh-status.md UIR-15, UIR-21**: one card for every connection, the reason line, the foot.

A service's card takes the server card's look: the logo tile, the pill (Connected, Needs a look, Learning), its
figures as tiles without meters; two across. The phone keeps Services as rows.
