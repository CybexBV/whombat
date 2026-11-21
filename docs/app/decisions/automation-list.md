# The Automations list at a glance (contracts 0.72.0, CT-328)

John, 2026-10-10, looking at the Automations page: “I would like to improve the Automations page visually … perhaps we
can add the logo of the GitHub repo?” He approved a mockup (a tile per source with the GitHub owner's picture, trigger →
agent → room chips, tags for what it may do, run history bars, a line when a run waits on someone, an On/Off switch)
and said “implement this fully”. The runtime side is Whombat `docs/decisions/automation-list.md`.

## Web

**AP-1080 — Only where the Whombat has it.** *Superseded by AP-6212 and AP-6214 (automation-chat.md): the subtitle
says to tell the agent, and a row is its sentence without chips or tags.* The rows at a glance (`GlanceRow`) show on a Whombat with
`automations.glance`; without it the row is the one from before (name, sentence, last run, pill), and so is the long
subtitle. With it the subtitle is the mockup's: “Work that starts on its own, from GitHub, the tracker, a message or a
schedule.” — each row's tags now say how far it reaches, which the long subtitle said in general. A row whose
`glance` is null (a draft that doesn't validate yet) gets a pencil tile and its sentence (“Not published yet”).

**AP-1081 — The tile.** GitHub: the repo owner's picture from `github.avatar` (a `data:` URL; the strict CSP allows
`img-src data:`, nothing is loaded from GitHub) with GitHub's mark as a round badge; the mark alone while it loads, when
the Whombat has none (`image` null) or when the call fails. Asked once per owner and kept 6 hours (`retry: false`).
The tracker: its own mark, drawn from its favicon's shapes in its own colours, its dark parts dark on light and light on dark as
The tracker does — like the providers' logos, the one place hex colours stand outside the tokens. A schedule, a message, a
reaction, a webhook and a start by hand: Lucide icons. The tile has a label (“GitHub · DigitalPals/Fusebox”, “The tracker”,
“Schedule” …).

**AP-1082 — The run history.** The latest runs (`recentRuns`, at most ten; `lastRun` alone from a shape without it) as
bars, oldest left, newest right, empty dashed slots on the left: done `ok`, failed `bad`, waiting, paused or needing a
look `warn`, running or queued `brand`, stopped or skipped short and quiet. One label for screen readers: “Last 8 runs:
6 done, 1 failed, 1 skipped”. Under it the last run as before, its status word in its colour: “#8 Done · 10:28”.

**AP-1083 — Waiting on a person.** The newest run with `waitingOn` gets a line under the tags: “Run #7 is waiting for a
yes.” (approval) or “Run #7 needs someone to look at it.” (review), with “Open” to that run. Waiting for an agent,
checks or time says nothing: the bar is amber.

**AP-1084 — The next run.** A switched-on automation with `nextRunAt` says when under its history: “Next run 09:00”
today, “Next run Mon 09:00” this week, “Next run 3 Nov” later.

**AP-1085 — On and off in the list.** People who manage automations (the list's `canManage`) get the switch with
“On”/“Off” next to it, named after the automation; `automations.setEnabled` as on its page, the list and its page
updated from the answer, “Switched on.”/“Switched off.” and a refusal's words as a toast. Everyone else, and drafts,
keep the pill.

**AP-1086 — The row.** *Superseded by automation-page.md AP-6380: the row is one link with the name, what starts it
and a status line.* The name is the row's link and its `::after` covers the row (hover and focus ring on the row);
the switch, “…” and “Open” are raised above it so they take their own clicks. Chips: what starts it (the source's small
mark and `glance.trigger`), → the agent's face and name (left out when the roster doesn't know it), → the room with a
muted “#”. Tags in `glance.does` order with an icon each; `changes` in the warn colour, `merges` in the bad colour,
both as a tinted pill (`color-mix` of the token). Under 640 px the right column moves under the text.

## Android

The phone's Automations list draws the same approved design as the web, in Android's grouped-list language
(`AutomationGlanceRow` in `screens/AutomationRow.tsx`, the view model in `data/automations.ts`). Only on a Whombat with
`automations.glance` and for an automation whose `glance` isn't null; otherwise the row stays as it was (`ListRow`, the
summary sentence and “Last run #4 · Done · 09:02”).

| ID | Decision | Why |
|---|---|---|
| AP-1090 | **The tile says what starts it**: 40dp, radius 12, `sf2` with a `line` hairline. GitHub: the owner's picture (`github.avatar` through `useGitHubAvatar`, kept six hours, never retried) filling it at radius 11, with an 18dp round badge (`ink`, the mark in `bg`, a 2dp ring in the card's `sf`) 5dp past the bottom-right corner; until it loads, without one or when it fails, GitHub's mark (20dp, `ink`) and no badge. The tracker: its bird, drawn in its own colours (the crown dark on light, light on dark), 24dp. The rest: Lucide in `ink2` at 18dp — Clock, MessageSquare, Smile (Lucide 1.47's `face-slightly-smiling`), Link, Play. The marks live in `ui/sourceMarks.tsx` (the web's Octicons path, the design's bird), not `@whombat/brand`, whose GitHub mark and the tracker tile are other drawings. Its label: “GitHub · DigitalPals/Fusebox”, “The tracker”, “Schedule”, “Message”, “Reaction”, “Webhook”, “Started by hand” (as on the web). | The picture tells repositories apart at a glance; the mark stands in offline, as a person's photo falls back to initials. |
| AP-1091 | **Superseded on the phone by automation-page.md AP-6330:** **Trigger → agent → room as chips** under the name: the source's glyph and `glance.trigger`, the agent's 16dp avatar and name from the roster (left out when `agentId` is null or the roster doesn't know it), and the room with its “#” in `mut` (“a private room” as it comes). 24dp at least (they grow with the font), fully rounded, `sf2`, a `line` hairline, 12.5 `ink2`, one line each, ellipsized; each “→” (`mut`) wraps with the chip after it, so no line ends in an arrow. | Who does what where, in the order it happens, without reading a sentence. |
| AP-1092 | **Superseded on the phone by automation-page.md AP-6330:** **What it may do as tags**, in the server's order: 22dp at least, radius 7, 12/500; `plain` in `ink2` on a `line2` border, `changes` in `warn` and `merges` in `bad`, each on a 7 % wash with a 35 % border. The tokens are plain hex and React Native has no `color-mix`, so `tint` (`ui/glanceColors.ts`) adds an alpha byte to the token. No icon per tag on the phone: the words carry it, and the row stays narrow. | What reaches outside the chat stands out; what merges code stands out most. |
| AP-1093 | **Superseded on the phone by automation-page.md AP-6330, and its failed `bad` by docs/decisions/automations-final.md AF-04 (`warn`):** **The last ten runs as bars**, oldest left: 6dp wide, 16dp tall, 3dp apart, radius 2 — done `ok`, failed `bad`, waiting, paused and needing you `warn`, running and queued `brand`, stopped and skipped `line2` and 10dp tall; fewer than ten are padded on the left with 4dp dashed `line2` slots, and no runs at all keeps the ten empty slots beside “No runs yet”. Beside them `#8 Done · 10:28` (`RUN_STATUS_COPY`'s word in its bar's colour, `mut` for a quiet one since `line2` isn't readable as text; `formatRecent`). TalkBack: “Last 8 runs: 6 done, 1 failed, 1 skipped”, counted in a fixed order with the list's words (“2 need you”, “1 stopped”). An older list with `lastRun` alone shows that one bar. | How it has been going, read in one look; the row keeps its shape before the first run. |
| AP-1094 | **Superseded on the phone by automation-page.md AP-6330:** **A run that waits for a person says so under the row**: the newest of `recentRuns` with `waitingOn`, a `warn` dot, “Run #7 is waiting for a yes.” (approval) or “Run #7 needs someone to look at it.” (review) and “Open”; the whole line is one 44dp link (“Run #7 is waiting for a yes. Open.”) to the run page, as a Recent runs row opens it. A run waiting for an agent, checks or time has no line. | The one thing on the list that needs someone, with the way to it. |
| AP-1095 | **Superseded on the phone by automation-page.md AP-6330:** **The switch only for people who may switch it**: with `automations.glance` the list's `canManage` decides; someone who may not sees “On” or “Off” (mono, `mut`; TalkBack hears it in the row's label) instead of a switch the Whombat would refuse. Without the feature the switch stays and the server decides, as before. The control sits beside the tile instead of centred on the taller row; ⋯, the long press for Delete, the draft button under the row and Recent runs stay as they were. | The state stays visible to everyone; nobody gets a control that only says no. |
| AP-1096 | **Superseded on the phone by automation-page.md AP-6330:** **TalkBack reads the summary as one stop**, in words and without the dots: “Assess new issues, on. GitHub, DigitalPals/Fusebox. {the one-sentence summary} Assesses, Comments on GitHub, Fixes when sure. Last 8 runs: 6 done, 1 failed, 1 skipped. Last run #8: Done, 10:28.” The sentence says the chips already, so they aren't read one by one; the switch (or ⋯) and the waiting line are stops of their own. | One stop per automation that says everything the row shows. |
