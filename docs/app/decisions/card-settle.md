# Cards that settle into a line (AP-730…AP-739)

John, 2026-10-04, about #reports thread `msg_NrGdVFbIh9qR` (report FB-3B50-6X0Q): 13 of its 25 messages were cards
and none of them needed him any more (5 runs, 4 “learned a skill” — one twice —, a schedule, an approval, an
assessment, the report). “Only when something is active it should be a card and when it's done the card should be
removed (the post should be updated).” He likes the subtle signs that an agent is at work (the run line's bar).
He asked for my opinion and then: “Build this fully with your recommendations.” Contracts CT-261 (0.45.2); Whombat
`docs/decisions/card-settle.md` (QC-01…).

## AP-730 A card shows by its state: full, live or a line

One pure rule, `cardDisplay` / `runDisplay` in `packages/client/src/cardDisplay.ts`, shared by web and Android:

| Card | Card (`full`) | Line |
|---|---|---|
| run that changed something | paused, failed, live and needing a person (`attention`) | done, taken over |
| run that changed nothing | — | always the run line (AP-668, unchanged) |
| approval | pending, or its action executing | approved / declined and settled |
| plan | any step still to do | every step done or cancelled |
| skill | a proposal waiting for approval | learned, approved, rejected, removed |
| schedule | — | always (when, and Cancel while to come) |
| assessment | a decision still to choose | chosen, or none to choose |
| turn failed | until retried | after “Try again” |

A live run that changed something is the third form, `live`: the compact live card (AP-733). Content cards
(research, review, commits, pill, answer, digest), the report a thread starts from and guide steps (which already dim
when done, AG) stay cards: they are what the message says, not a status.
(Since report-rows.md RR-01 a report is a line in its conversation too, and the whole card at the root of its thread.)

**Shrink, never remove.** The message stays — reply counts, unread, search, links, audit and the agent's own sentence
all keep working — and only its card turns into one line. The line opens the card in place (local state, per
message); closing it again returns the line. A card that becomes active again (a run resumed, a retry) is a card again
by the same rule.

## AP-731 What a settled line says

Same anatomy as the run line (a status dot in the tone, a bold lead, a muted detail, a control on the right):

- Run: the run line's own text (`Run #3 · Done in 6m 12s` · summary), plus `PR #3` and `+12 −8` chips (`runChips`).
- Approval: `Approved by John` / `Declined by John` · the approval's title.
- Plan: `Plan · 5 of 5 done` · title (`Plan · Cancelled` when every step was cancelled).
- Skill: `Banjo learned a skill` · name (`… · Removed`); a decided proposal `Skill proposal · Approved|Rejected`.
- Schedule: `Banjo scheduled a turn · Once, Sun 4 Oct at 15:23` · what it will do, with Cancel where the card had it;
  ended `… · Done|Cancelled|…`, paused `… · Paused`.
- Assessment: `Assessment · FB-3B50-6X0Q` · headline · `chose “…”`.
- Turn failed: `Turn failed` · `Tried again at 13:02`.

## AP-732 What a run did shows inside the run

A learned (or decided) skill and a schedule that carry `runId` (CT-261) show as indented sub-lines under their run's
line or card when that run's message is in the same list above them (`foldIntoRuns`); the list leaves their own
messages out. Without the run in the list (an older page, another thread, an older server without `runId`) they are
lines of their own. A skill proposal waiting for approval is never folded: it needs someone.

## AP-733 A live run is a compact card

While a run that changed something works: the title (`Run #5 · Verify and deploy`), the 6px bar, `Now: …` and how
long it has run (`3m 12s`, ticking), the PR and diff chips, Watch run, and a control that opens the full card. It
becomes the full card by itself when it needs a person and a line when it is done.

## AP-734 What the agent is doing, beside “is thinking”

`activity.updated` (topic `conv`, WS-12) already reaches every chat. The client keeps each agent's newest action per
conversation and thread (`queryKeys.agentNow`, `useAgentNow`) and the thinking line reads
`Banjo · Editing Layout.astro · 1m 12s` (`workingLabel`; the clock from 10 s, measured from the turn's first action).
Without a recent action (3 min) it stays `Banjo is thinking`. Only shown while the agent's thinking indicator is.

## AP-735 A thread's reply row shows work in it

In the channel, a thread's reply row adds the agent's avatar and `Banjo is working · 38%` with a small bar while a live
run's card is in that thread (`Run.threadRootId`, CT-261; `threadWork`), `Banjo needs you` (warning tone) when that run
needs a person, and `Banjo is thinking` with the pulsing dots while it thinks there. Nothing when the thread is quiet.

## AP-736 Release 0.36.0

whombat-app 0.36.0 ships AP-730…AP-735 on the web and AP-746…AP-749 on Android (`card-settle-android.md`), with
contracts 0.45.2 (CT-261). A runtime without `Run.threadRootId` or the cards' `runId` (before Whombat's QC-01…QC-05)
simply shows no thread progress and no folding; everything else follows the state the cards already carry.
