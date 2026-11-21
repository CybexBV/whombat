# Reports as rows (RR-01…RR-08)

John, 2026-10-04, looking at #reports: “The reports page is taking too much space with these huge cards, I think we
should simplify this and create a summarized feedback sentence instead.” Each Whombat Feedback report was the
Feedback agent's message `Bug report FB-3B50-6X0Q · Website Feedback` over the full report card (mono label and
received time, the visitor's words in 15.5px, the assessment in an inset box, the state line and Details): two
reports filled a 1440×900 screen.

## RR-01 A report is a line in its conversation, in every state

`cardDisplay` (`packages/client/src/cardDisplay.ts`) returns `line` for `report`. This replaces the part of
card-settle.md AP-730 that kept “the report a thread starts from” a card: a report is read once, then it is a pointer
to its thread, so it needs no more room than a settled card. The message stays (reply row, unread, search, links);
only its card shrinks. Web and Android share the rule and the words (RR-02).

## RR-02 What the row says: `reportLine(card)`

One row under the author line, the settled line's anatomy (AP-731) with a second, quieter line:

- a status dot in the tone of RR-03;
- the **lead** in 600: the assessment's outcome (`FEEDBACK_OUTCOME_LABELS`: “Confirmed bug”, “Feature request”, …);
  before an outcome the report's type (“Bug report”, “Feature request” — more useful than “New report”, and the type
  is otherwise lost once the header folds, RR-04); “Assessing” while the assessment runs; “Assessment failed /
  blocked / paused” when it can't go on;
- `·` and **the sentence**: the assessment's summary once there is one (the summarized feedback John asked for),
  else the visitor's words (`card.summary`); “Content removed” (muted, italic) once an owner removed them;
- under it, in the mono meta face: the reference `FB-3B50-6X0Q`, the integration's name, the status once it isn't
  New (`Triaged`, `Resolved`), and `2 screenshots`;
- `Details` on the right (the card's small secondary button; 44dp target on Android).

The sentence wraps to **at most two lines at every width**, not one: assessor summaries run 80–200 characters, and
one line at 1440 cut the very sentence John asked for in half; most rows still take one line. The facts line wraps
rather than cutting off on a narrow column. The received time is left out of the row: it is the message's time on the
author line right above it, and the opened card says “Received …”.

The row is a `section` named `Bug report FB-3B50-6X0Q: Website Feedback · New · Confirmed bug` (type, reference and
`reportCardState`). Everything in it is plain text (React / RN text nodes): the visitor's and the assessor's words never
become Markdown, links or mentions.

## RR-03 The dot's tone

Status first: `resolved` → ok, `closed` → muted. Then the assessment: running → live (the pulsing dot), failed → bad,
blocked → warn, done as `confirmed_bug` or `likely_bug` → warn (someone should fix it), everything else (queued, not
configured, paused, a feature request, a duplicate, support, needs information, not enough evidence) → muted. The
lead stays ink in every tone (unlike a settled line's warn lead): the dot carries the tone, so a channel of confirmed
bugs doesn't read as a wall of amber.

## RR-04 The server's header folds into the row

The server posts a report with the fixed text `{Bug report|Feature request} {reference} · {integration name}`
(Whombat `apps/server/src/feedback/intake.ts`). That text only repeats the card, so it doesn't show above the row or
above the card in its thread. `reportHeaderOnly(text, card)` matches exactly that header — the type label and
reference from the card, then nothing, or ` · ` and one line of at most 60 characters (the integration's name, which
may have been renamed since) — and `textFoldsIntoCard` applies it to report cards only. Any other text stays, and so
does the header when no card renders. Search, pins and notifications keep the text: there it is the summary.

## RR-05 Details opens the whole report in place

Details (`aria-expanded`, `aria-controls` on the opened region) shows, under the row, the full report card — label and
received time, the visitor's verbatim words, the assessment block, the state line — with its details region already
open (`ReportDetails`: what they sent, context, the assessment's fields, attempts, status, retry, handoff, content
removal). The message's screenshots move there too, at the top of the details region (above the SCREENSHOTS list that
says “Shown with the message above”); the collapsed row only says `2 screenshots`. “Hide details” folds it back to
the row. Per message, local state, as a settled line's (AP-730).

On Android the opened report is the phone's existing full report view (the report's card summary: label, words,
assessment, state line); the screenshots show under it while open. The phone has no details region.

## RR-06 One component per platform, the settled line's parts

Web: `ReportLine` (`apps/web/src/features/cards/ReportLine.tsx`) uses the run line's dot and tones
(`RunLine.module.css`, `LINE_TONE`) and the card's small secondary button; it is not `SettledLine` because the row has
a second line, a two-line sentence and a labelled button instead of the chevron. Android: `ReportLineView`
(`apps/mobile/src/ui/chat.tsx`), the same dot colours as `SettledLineView`, and `ChatItem.report`.

## RR-07 In its thread the root is the whole card

A report's thread is where the report is read and worked on, so its root shows the whole card (with Details), not the
row. On the web the thread pane renders `MessageCard` with `variant="thread"`, and `ThreadView` now shows the root's
card for a report (it shows no other root's card, as before; before this the report's thread showed only the header
text). On Android `chatItems(…, { threads: false })` makes the root `display: 'full'` without a row. The header text
folds there too (RR-04). The card's header wraps “Received …” under the label in the pane's narrow column.

## RR-08 Fixture worlds and baselines

The web's settled-cards world (`VITE_FIXTURE_SETTLE=1`) posts its report with the server's header and adds a feature
request above it in #incidents, so the channel shows two report rows; the phone's settle world uses the header too.
The visual spec `report row with details` and the stories' report states show the row; their baselines
(`report-details-*`, `cards-chat-cards--report-*`) need regenerating.
