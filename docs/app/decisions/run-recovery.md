# Try again on a failed run, and a run that needs a person (AP-596, AP-597)

John, 2026-10-01, after Banjo's runs on FB-8QQQ-9R26 stopped twice: “For future runs, how can we make Banjo (or any
other agent) not get stuck at this?” — “Implement this fully”. The runtime side is Whombat
`docs/decisions/run-checkout.md` RC-08…RC-13; the shapes are contracts 0.30.0 (whombat-contracts
`docs/decisions/contracts.md` CT-197): `runs.retry` (`POST /burrows/:burrow/runs/:number/retry` → `{run}`, retry
safety `receipt` like `runs.resume`), `Run.attention?: string | null` (≤ 280, cleared when the run moves again), audit
events `run.retried` and `run.stalled` (Code), and the runtime feature `runs.recovery`.

## Decisions

- **AP-596 Try again on a failed run, where Pause and Resume are.** The run page (`apps/web/src/features/runs/`) shows
  “Try again” on a `failed` run when the Whombat advertises `runs.recovery` (`useFeature`, as `dispatches.retry` and
  `repos.create`); without it there is no button and the failure note keeps “Ask again to retry.”. The button is the
  Resume button's (`Button variant="secondary" size="lg"`, disabled while any control is in flight), and the action
  goes through the same handler: `api.runs.retry`, the run from the answer into the `runs.get` cache (and `run.updated`
  keeps it live), “Asked Banjo to try again.” as the toast (the failed turn's Try again says the same), a refusal or an
  error in the same toast as Resume's. `runControls(status, {retry})` decides it, so the rule is unit-tested.
  - **The failure note.** With Try again offered and no summary from the runner, the note says “Banjo stopped after an
    error. Try again to give it another turn.” instead of pointing to asking again. A summary is shown as it is.
  - **Where it isn't.** The run card in a conversation has no run controls (Watch run, Branch room), so it gets no
    Try again; the phone's run screen has none either (Branch room only), and the Work view's actions come from the
    server's `WorkItem.actions`, which have no run retry in 0.30.0. Each gets it when it gets run controls.
    *The conversation's run card and run line: superseded by AP-699 (run-line.md), which gives a failed one Try again.*
- **AP-597 “Needs attention · …” on a live run.** `runAttention(run)` (`@whombat/client`, shared by web and phone)
  answers the server's sentence as it is — no rewording — for a `live` run with a non-blank `attention`, and null
  otherwise (absent, null, blank, or the run no longer live, so a stale value never shows on a failed or done run).
  The label “Needs attention” comes before it, joined with the middle dot.
  - **Run page:** under the header, where the paused note goes (live and paused notes never show together), in the
    paused note's styling: the `sf2` note with the warn left rule; the label in ink, weight 600 (warn as text on
    `sf2` would fail contrast, D-A11Y-01).
  - **Run card:** a line under “Now: …” at that line's size in ink2, the label in warn, weight 600 (like the card's
    tests count, warn text on the card's `sf`).
  - **Phone:** the run screen says it under the context line (label in warn); the chat's compact run card shows it
    as its detail instead of “Now: …”, in the warn tone.
- **Audit events.** `run.retried` and `run.stalled` need nothing in the app: the activity views take an event's kind
  and text from the server, and the only exhaustive map over event types is contracts' own. `FEATURE_NAMES` names the
  feature “Try again on a run” (“Update your Whombat to use Try again on a run.”).
