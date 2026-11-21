# A job's result as a message (AP-9352…AP-9366)

John, 2026-11-17, on a cleanup T3 Code did for him: “I need to see in the thread what the outcome was, directly, without
having to open a card”, and “I would like to see ui/ux improvements, so it’s nice to read what happened”. He approved a
mockup (an open report, the card shrunk to one line of facts) and asked that choices are marked first and sent together.
The box's side is Whombat `docs/decisions/t3code.md` T3-55…T3-61 (`Message.jobResult`, `Handoff.resultMessageId`,
`messages.jobAnswers`); the progress while a job works is [job-view.md](job-view.md).

## Shared words and logic

| ID | Decision | Why |
|---|---|---|
| AP-9352 | **A message with `jobResult` is drawn as T3 Code's report**, on the web and the phone alike, from `@whombat/client`'s `jobResult.ts` (`jobResultView`, `JOB_RESULT_WORDS`): T3 Code's mark and name over it, never the assistant's. An ended job whose hand-over names its result message (`jobInMessage`) draws no receipt, answer, plan, changes or checks, and no line: the message says it. | One report, said once, in the words of the program that did the work. |
| AP-9353 | **The report is read by its headings** (`jobReport`): the words before the first heading are the outcome; then What changed (areas with their changes), What I decided, What the council decided (a word such as Removed or Kept, the point, the reason), Left for you (numbered points with advice and choices) and any other section under its own title; Technical detail is taken out and folded. A line that is only bold counts as a heading. A part without rows, and a report without headings, is shown as the text it is: nothing is dropped. | T3 Code is asked for this shape (T3-57) but writes markdown; a report in another shape must still read. |
| AP-9354 | **Everything is open except Technical detail.** No “Read the answer”. | He had to open a card to see what was fixed. |
| AP-9355 | **The facts are one quiet line under the report** (`jobResultFacts`): Ran into a problem or Stopped when it didn't complete, Tests passed or failed, the files and the lines fewer or more when a pull request gives them, the pull request as a link, how long it took, the AI; then Technical detail and Open in T3 Code as a group of their own, and “The rest is in T3 Code” when the box kept only the report's start. A fact the box doesn't know isn't shown. | What the card was for, without the card. |
| AP-9356 | **A point left for the person is answered on the message**: its choices are buttons of equal weight that mark (pressed, with a tick; again takes it back), “Reply in words” opens a field whose text is the answer; a point takes a choice or words, not both. One bar under the points sends them together (“Send 2 answers”, off until one is marked) and says how many stay open; nothing is sent before. The council's advice sits in a tinted block over the buttons and is never a pre-picked button. | One sending is one run of T3 Code; a wrong tap can be taken back; the advice must not decide for him. |
| AP-9357 | **While T3 Code works on a sending** the answered points say “You chose …” (or that he answered in words) in place of their advice and buttons, the bar becomes one line (“2 answers sent to T3 Code. It’s on them · 2m”, the minutes ticking), and open points wait, dimmed. When the run ended, one line says “Done at 23:44. The report above is updated.”, or that it ran into a problem or was stopped. No message is posted for it. | The point updates where he answered; the thread stays short. |
| AP-9358 | **Marks are kept per message in memory**: through a re-render, an update that leaves the points as they were and leaving the thread; cleared after a sending, kept after one that failed (a toast says so), reset when the points change. | A half-made choice shouldn't vanish, and shouldn't be sent against other points. |
| AP-9359 | **A result message can't be edited**; reactions, copy and pin stay. | It is T3 Code's report. |
| AP-9360 | **The council's faces** (three elders' heads) stand beside “What the council decided”, in a point's advice when the report says the council gave it, and on a job's line in place of T3 Code's mark while its step is `HANDOFF_COUNCIL_STEP` (which no box sets yet, T3-61). | Who decided, at a glance. |

## Web

| ID | Decision | Why |
|---|---|---|
| AP-9361 | **`features/messaging/JobResult`**, drawn by `ThreadView` in place of the message's text: the outcome's first paragraph in 17px `--ink`, the rest in 16px; section titles 16/700 as `h3` with a thin rule between sections; What changed with the areas in a label column (stacked under 560px); a decision as a row of status (tick in `--ok-text`, an open ring in `--mut` for kept), the point in 600 and its reason; Left for you with an amber dot and the count of open points; point titles as `h4`, choices a `fieldset` named by the point; the send hint is `role="status"`. | The approved mockup, in the app's tokens. |
| AP-9362 | **The facts line**: a dot follows a fact instead of leading the next, so a wrapped line never starts with “·”; under 560px the dots become gaps and the links are 44px tall. Technical detail is a disclosure whose chevron turns. | Reads as one line at any width. |
| AP-9363 | **T3 Code's line at the thread's end is one calm row**: the mark, “T3 Code”, what it does now in lower case, the minutes (`38m`), Open in T3 Code at the end; asked, needs your OK and checks keep their words, with the long text on a second line; the steps still fold out. | The mockup's line while it works; no second box. |
| AP-9364 | **Fixture mode** (`VITE_FIXTURE_CODE=jobs`): three threads, the result, the same with two answers sent, and a job on the council step; sending answers there puts the message into the sent state. | Every state without a box. |

## Phone

| ID | Decision | Why |
|---|---|---|
| AP-9365 | **`ui/jobResult.tsx` `JobResultMessage`**, drawn by `MessageRow` in place of the message's text and cards: the author line as other messages (a 24pt T3 mark), the body full width under it; outcome lead 17, text 15.5, section titles 16/700 as headers, areas' labels over their bullets, hairlines between sections; choices at least 44pt / 48dp tall and wrapping, selected told to a screen reader; the send bar a full-width button with the hint under it; the sent line is announced once, not every minute; the facts wrap as whole facts without dots; Technical detail and Open in T3 Code are rows at least 44pt / 48dp tall. No Edit in its menu. | The 390px mockup in the phone's own type and targets. |
| AP-9366 | **The demo world** has a thread with the result message and one with a job on the council step; `messages.jobAnswers` there records the sending and refuses a second while one is with T3 Code. | Every state on the phone without a box. |
