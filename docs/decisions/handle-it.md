# The assistant handles what needs a look (HDL)

Part of the “effortless” work of 2026-10-30 for John (stream handle-it; the review's flows.md 2.2–2.4, 2.7, 4.2,
Direction rules 2–3 and Top 10 #2, visual.md #3). John asked that Whombat take the work off a person who isn't a
developer: “Ask {assistant} to handle these” stops being a question typed for them and becomes one plan they say yes
to once. Decided for the stream, and recorded here: research covers every active line of a thing in one turn (one
budget unit, LR-S01's key widened to the thing), it stays quiet in Chat (LR-04) and only a finding with a step that
needs the person pushes, and the assistant still asks before anything that always asks (this Whombat's own server,
deleting, restoring).

Contracts 3.11 (additive): `LookResearch.plan`, `LookPlanView`, the `look_plan` card, `look_report`'s `steps`,
`LookDispatchContext.lines`/`asked`/`plan`/`waiting`, `looks.handle`, `looks.get`, `ApprovalView.ask`. Migration
`0017_look_plans`. It changes LR-03, LR-04, LR-07, LR-12, LR-S01, LR-S04 and LR-S18 (marked there).

## What happens

| # | Decision | Why |
|---|---|---|
| HDL-01 | **One research covers every line of a thing.** A thing's research (one live row per thing, as before) keeps every problem and only-you line it had when it began (`look_researches.lines`, at most 12, never heads-ups); the turn reads them all as data and looks into all of them at once. It counts once against the day's budget. | flows.md 2.4: a server with seven lines got one paragraph about the worst. One turn per thing is cheaper than one per line and gives one answer. |
| HDL-02 | **A new problem is a worse look or a line it didn't look into.** A line that went isn't one. A row from before (no lines) compares its own line as it did; two passes in a row means the same thing, rank, line and set of lines. | Once per problem (LR-02) still holds for the thing: a line clearing shouldn't cost another turn, a new one should be looked into. |
| HDL-03 | **One plan, with defaults chosen.** When several things need doing, `look_report` ends with `steps` (at most six): each as the person reads it with the defaults the assistant picked (“Add the 6 machines to a nightly backup at 02:00, keeping a week”) and what exactly it will do. One step stays `fix`, its own button (LR-07). A plan is never offered on Look only. Screens get the steps as `LookResearch.plan`, never together with `fix`, so a screen that doesn't know plans offers no button for steps it doesn't show. | flows.md 2.3: the person decides once; the assistant chooses the settings a person would otherwise fill in a form. |
| HDL-04 | **The plan is one card.** Its first plan posts one `look_plan` message in the thing's thread (its text the assistant's title); a later report changes what that card says (it resolves on read and is sent again when the research moves). It reads “Here’s what I’ll do on {thing}:”, the steps, **Go ahead** and **Change something**; while the steps are taken “I’m on it.”; once done green, “Here’s what I did on {thing}:” with the steps ticked; once the problem went first, one line, “No longer needed”. The thing's page (LookCard) draws the same card with the title and the assistant's words. | One place says what will happen and then what happened; the thread keeps the story (LR-04). |
| HDL-05 | **Go ahead is the yes for exactly those steps.** `looks.fix` on a plan posts the person's “Go ahead.” in the thread and wakes a `look_fix` turn carrying the steps; it takes them in order, checks each, and reports. What always asks still asks with its own card: this Whombat's own server, deleting, restoring. Fixed goes to Done today, as before. | LR-08's rule, for several steps: the press is the approval; the rules that always ask are the person's own. |
| HDL-06 | **Change something is a reply.** It opens the thing's thread (on the card in the thread, the reply box). The person's own reply there while a plan or step waits is served `look_report`, its turn knows the plan (`waiting`), and a changed plan changes the same card. | “Change something” must change the plan, not start a second one. |
| HDL-07 | **Ask {assistant} to handle these hands the thing over now** (`looks.handle`, as the person): the thing's look read now (no two passes), “Please take care of what needs a look on {thing}.” as the person in the thing's thread, and a `look` turn that knows they asked. While it looks or takes steps, or a step or plan waits, the same research comes back. Otherwise (it found nothing to press, fixed what was there, or failed) that research ends and a new one begins. It never counts against the watcher's day. Nothing needs a look there: 404. | flows.md 2.3, 4.2: one press instead of a question in the Ask pane; the person asking isn't the watcher's budget to spend. |
| HDL-08 | **The group button says what is happening.** Worth a look's one button (two or more lines that ask) is “Ask {assistant} to handle these”; while the assistant looks into them it is the line “{assistant} is looking into these”, while it takes the steps “{assistant} is on it”, and while a step or plan waits it is gone (the card above has Go ahead). A Whombat without `looks.handle` (`unknown_op`) or a 404 opens the Ask pane with today's question. | Shared words: a problem being researched has no button, one line. Older boxes keep working. |
| HDL-09 | **A server's page shows the research too** (lifts LR-12's first item): `looks.get {key}` reads a thing's research for the pages the apps build themselves; the web's and the phone's server Summary draw the LookCard at the top, as a connection's page does, and `home.changed {things}` reads it again. | flows.md 2.4, 7.4: the server page was the one place the finding never showed. |
| HDL-10 | **A finding the person must say yes to pushes, once.** When a research reports `found` with a step or a plan, the person gets one Needs you notification, which opens the plan's card (else the thread): “pve-02’s disk is full of old backups. I can remove the 3 oldest.” or “… I have 3 steps ready for your OK.” Once per research (`pushed_at`). A fixed problem never pushes (Done today says it); the thread's messages stay quiet. | flows.md 2.7: push the finding, not the alert; the assistant filters noise before it interrupts. |
| HDL-11 | **Superseded in part by care-plan.md CPL-10**: Tonight runs when the quiet hours for changes start, not at a fixed 03:00. **An everyday approval asks in plain words.** A server's or connection's call, a message, an invite, a file or a `custom` ask reads “{assistant} needs your OK” under its title, with **Yes, do it** · **Tonight** (approve now, run at 03:00) · **No** (and “Don’t ask again on {server}” or Always allow where offered); the tool, its target and what it sends fold under **Technical details**. Code (deploys, merges, pushes, refunds), a command's allow choices and key requests keep their words, as does the shared label lists and the log use. | visual.md #3: the most important thing the assistant ever asks used a tool name and API wording. |
| HDL-12 | **Older parts.** Every new field is optional. A client without plans sees the research's words without a step button and Ask {assistant} opens the thread; the desk shows the title and summary of a plan's research, no step. | The runtime, the console and the apps don't update at the same moment (LR-11). |
| HDL-13 | **Superseded in part by care-plan.md CPL-01**: the care plan when a server is added is built. **Not now:** ticks per step while they are taken (the card says “I’m on it.” until the report), Go ahead as an action on the push itself, Go ahead on the desk, and the care plan when a server is added (flows.md 4.1). | Smallest useful first. |

## Server details

| # | Detail | Why |
|---|---|---|
| HDL-S01 | `look_researches` gains `lines` (jsonb, default `[]`), `plan` (jsonb), `asked_by_id`, `plan_message_id` and `pushed_at` (migration `0017_look_plans`, expand). The lines come from the same verdicts the dot uses: a server's `ServerVerdict.asking`, a connection's `Verdict.asking` (the quiet rules' lines that count, worst first), kept beside the desk's look (`lookLinesOf`). | No second reading of the hosts service; the watcher and the page agree on what “needs a look” means. |
| HDL-S02 | `look_report` runs in a `look` or `look_fix` turn as before, and in the person's own reply turn (`dm`, `mention`) in a thread whose live research is `found` with a step or plan (`researchOfTurn`); there it changes that research. Its context then carries `waiting` and the plan. | HDL-06 without serving the tool in any other turn. |
| HDL-S03 | `look.handle` is a commit as the person, `licence: agentTurn`; the route reads the thing's look first (`thingLook`, outside the transaction) and passes it in. Events carry ids only (`look.handle_asked`). | All writes through the pipeline; reading the fleet doesn't hold the lock. |
| HDL-S04 | The push is a `needs_you` notification drafted in the report's commit and sent in the background (`notify`), deduplicated by `look-finding:<research>`, grouped with the thread. | One rule for pushes (quiet hours, previews, NT-17 hold for an active client); the thread's own messages stay quiet (LR-S11). |

## Rows for DECISIONS.md

| # | Decision |
|---|---|
| HDL-01…HDL-13 | **The assistant handles what needs a look**: one research covers every line of a thing and may end in one plan of steps with defaults chosen, shown as one card (in the thread and on the thing's page, server pages included) with Go ahead (one press for exactly those steps) and Change something; Worth a look's “Ask {assistant} to handle these” starts it at once and says while it looks; a finding with a step pushes once; an everyday approval asks “{assistant} needs your OK” · Yes, do it · Tonight · No with the tool under Technical details. (`handle-it.md`) |

Replacement for the LR row (`LR-01…LR-12`): **The assistant looks into a problem by itself**: a thing on the desk, Home
or its page that needs a look is looked into by the assistant without anyone asking, every line of it in one turn
(once per problem, at most 12 a day and 2 of one thing), in one thread per thing in the person's Chat that settles when
the problem goes; the card then says what is wrong in plain words, offers one step or one plan only when the assistant
can take it (its button is the go-ahead), and *Ignore*. Small, safe, undoable steps it takes by itself and says so.
(`look-research.md`, `handle-it.md`)
