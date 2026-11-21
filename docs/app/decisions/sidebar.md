# A calmer sidebar (AP-2600…AP-2619)

Whombat `docs/decisions/sidebar.md` SB-02…SB-12 (John, 2026-10-19: “I agree, but add more spacing between the logo and
the first menu entry. Implement this fully.”). Contracts 0.95.0 (CT-453 `ThingSummary.reason`, CT-454
`HomeSummary.worst`). Web only: the phone has no sidebar.

## AP-2600 The burrow alone, with room under it

The head is the logo and the burrow's name; its bottom padding goes from 16 to 28 px before the first place (John).

## AP-2601 Watch's badge colour

**Superseded by needs-you-list.md NYL-04**: Needs you's badge, in the colour of its worst item that needs the person.

`AssistantNavRow.badgeTone` is `summary.worst` (`watchWorst`), or `bad` when the Whombat doesn't send it. `bad` keeps
the red fill, `warn` is amber (`--warn`), `info` is grey (`--sel` with `--ink2`). The badge's text is `--btnfg`, which
flips with the theme as the fills do: the light theme's dark red had dark text before and was hard to read.

## AP-2602 Why, in the tooltip and the label

`ThingRow.reason` is `ThingSummary.reason` when the status isn't `ok`. The row's label reads “blackbox, needs a look:
filling up” (the reason's first letter lowered); its tooltip (`ThingRow.tip`) is “blackbox · Filling up”, the
status's words without a reason (“pve-02 · Needs a look”), the name alone when fine. The dot's own tooltip is the
reason, else the status.

## AP-2603 A dot only when something isn't fine

`ThingRow.dot`: `warn`, `bad`, `offline` and `learning` draw one; `ok` and `unknown` none. The `dot_ok` and
`dot_unknown` styles are gone.

## AP-2604 Names in the sans face

The sidebar no longer sets servers' names in mono (`ThingRow.mono` stays for other lists).

## AP-2605 The theme in the account menu

The theme pill (`ThemeToggle`) leaves the sidebar's head (the crew shell and the brand page keep theirs). The account
menu has “Switch to light theme” or “Switch to dark theme” above Sign out; it stays open, so the change is seen.

## AP-2606 No count on Automations

The Automations row has no count; `AssistantSidebarInput.automations` is gone.

## AP-2607 Two groups

**Superseded by final-shell-web.md FSW-01**: one order of nine places, no groups.

**Superseded in part by needs-you-list.md NYL-05**: Needs you where Watch was.

In the Chat shell: Chat · Feedback · Watch, then Connections with `gapBefore` (12 px above it) · Automations · Skills
(a Whombat without the library) · Vault. Before the Chat shell the order stays Connections · Watch · Automations · Vault
without a gap: Connections is `/` there.

## AP-2608 The `+` buttons

SERVERS' `+` is `addServerHref()` with `tab=servers` (`/connections?tab=servers&add=1`, `/` before the Chat shell).
SERVICES' `+` opens Add a connection as Connections' button does: `connection=add` where `connections.catalog` is on,
else Settings → Connections.

## AP-2609 Folding

The SERVERS and SERVICES headings hold a button (`aria-expanded`, `aria-controls` the rows) with the title and a
chevron that shows on hover and focus and stays while folded. `useSidebarFolds` keeps the folded sections in
`localStorage` (`whombat.sidebar.folded`, a JSON list; removed when none is folded). Folded, `shownRows` keeps the rows
with a dot and the selected one, and the heading says how many are tucked away (“3”, read as “3 more”). The `+` stays.
