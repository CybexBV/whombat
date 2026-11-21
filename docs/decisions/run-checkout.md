# Workstream: run checkout (a run always works in a checkout of its branch, and doesn't get stuck)

Asked on 2026-10-01 by John, in the main checkout, on FB-8QQQ-9R26 (“House Rules” numbers 01 and 02 share a color):
the approved handoff woke Banjo, Banjo started Run #1 on `feat/fb-8qqq-9r26-house-rules-colors`, and the run failed at
its first step because “the supplied workspace has no repository files”. The handoff is a plain mention; a mention turn
has no checkout (`DispatchContext.workspace` comes from the run, an automation step, an approved push or a branch room),
and only an *approved* `start_run` woke a run turn with one (bp-automations.md BP-C29). Banjo holds “Read and write
feat/* branches”, so its `start_run` needed nobody and its run was left with an empty scratch folder. John: “We should
use ~/Code to clone the repo and work in the directory of that project”, and “We should always be able to see what a
developer agent is doing”.

## Decisions

- **RC-01 A run started in a turn without a checkout of its branch goes on in a run turn that has one.** After a
  `start_run` that committed without an approval, Whombat computes the starting turn's checkout (`turnWorkspace`, the
  same function the dispatch context uses) and, unless it is already the run's repo and branch, queues a
  `run_control` / `run` turn for the agent with the run (`continueInCheckout`). That turn answers where the agent was
  asked: the starting turn's message and thread (else the run's card), so a Feedback handoff's report, assessment and
  screenshots still reach it (FB-24, FB-F3-12), and the same person's subscription (`onBehalfOfAccountId`). It starts
  when the starting turn ended (one turn per agent and conversation). A Feedback assessment never starts one. The
  approved path (BP-C29) is unchanged.
- **RC-02 A queued run turn carries one run.** Coalescing a new request into a queued turn of the same agent,
  conversation and mode now also needs the same run (`dispatches.run_id`): a second run's turn (or a Resume) no longer
  disappears into another run's queued turn.
- **RC-03 Finishing a run drops its queued run turn; a failed run turn stops its run.** `finish_run` cancels the run's
  still-queued turns (the starting turn finished it after all); `runtime.fail_dispatch_runs` also stops the run a
  failed turn belonged to (`dispatches.run_id`), not only the runs it started, so a refused run turn (a dirty clone,
  a working directory outside the roots) does not leave the run live forever.
- **RC-04 The prompt says so.** A turn without a checkout (not in run mode, not read-only) is told: start the run on a
  feature branch, say in one short line that you are on it, end the turn; you carry on in the run, in a checkout of
  its branch. The run turn's line names who made it live: “you started it, a person approved it, or a person resumed
  it after a pause”.
- **RC-05 Where the checkout is: the agent's working directory when it has one.** Nothing new in the runner: with a
  working directory (the agent's own or the burrow's default, BS-02) the run turn finds the clone there by name or by
  origin, or clones into `<workdir>/<repo name>` (RS-04), and works in it — `direct` checkout: on the run's branch in
  that clone, so people see the files change where they keep the project; `worktree`: a worktree under the workspaces
  root that shares the clone's objects. Without one (a managed box, G-09) it is Whombat's mirror and a worktree, as
  before. On the public dev instance (appliance IN-145) the developer agent has the working directory `~/Code` and the
  `direct` checkout, which is how “we can always see what a developer agent is doing” is met there. Its own setting,
  not the burrow's default: a default would give every agent's turns all of `~/Code` to read. Direct
  mode still refuses a clone with uncommitted changes or a merge or rebase in progress (S-12) — a person working in the
  same clone holds the agent off, by design.
- **RC-06 Landing a direct turn moves the clone's index with `read-tree --reset`** (2026-10-01, Banjo's Run #2 on
  `~/Code/Whombat_Website`: “could not land … git read-tree failed: Entry 'design/Home.dc.html' not uptodate”). In
  direct mode the agent's git uses Whombat's index, so every tracked file it edits is out of date against the clone's
  own index, and `read-tree -m` refuses; the branch had moved but the index stayed at the old commit, so the clone
  looked dirty and the next turn would have been refused. `--reset` without `-u` sets the index to the landed commit
  and never touches the working tree; `update-index -q --refresh` rereads the stats. The tests only ever added new
  files; they now edit a tracked one too.
- **RC-07 A writable checkout's prompt says how a change is proposed.** Banjo committed, then asked for “Browse the
  web” “to push the feature branch and open the PR”, though the runner had pushed it and Banjo holds “Open pull
  requests”. The checkout line now says the runner pushes after the turn and before a pull request opens, to open it
  with `open_pull_request`, and that pushing and GitHub need no network key.

### Runs that don't get stuck (2026-10-01, contracts 0.30.0 CT-197, whombat-app AP-596, AP-597)

John, after the two blocks above: “For future runs, how can we make Banjo (or any other agent) not get stuck at this?”,
then “Implement this fully”. The rule behind all of it: Whombat does what an agent could forget or never learn about,
and says so when its own steps fail, instead of relying on the prompt.

- **RC-08 Whombat opens the pull request for pushed work.** When a run turn ends (`done`) and the runner reports pushed
  commits (`WorkspaceReport.pushedCommits`), each run of the turn (live or done) on a feature branch of a GitHub repo
  without a pull request gets one: the ordinary `open_pr`, committed as the agent, so its “Open pull requests” key
  decides (can: opened; ask: a person approves; no: nothing). Title = the run's title, body = its summary and steps,
  base = the repo's default branch. `open_pr` now also sets `runs.pr_number` of the runs on that branch (by anyone), so
  the run page shows its pull request. `afterRunTurn` (runtime/run-recovery.ts) runs after the runner's `complete`,
  off its request.
- **RC-09 The runner reports what it could not do, and people see it.** `CompleteBody.workspace` carries the pushed
  commits and up to five problems: `checkout` (the clone or fetch failed, the turn ran in scratch), `push` (refused or
  failed; waiting on an approval is not a problem), `land` (a direct checkout's commits could not land in the clone).
  The runner now lands a direct turn's commits after the turn's processes are gone and *before* it completes (`land()`,
  once; `release` doesn't land again), so a landing problem is in the report. The server commits
  `runtime.report_workspace` as the agent: a `✗ Whombat couldn’t …` line in each live run's log, the run's “Latest”
  set to it (the agent's next turn on the run reads it), and the same lines posted where the turn was asked.
- **RC-10 Try again on a failed run** (`runs.retry`, `retry_run`): a person; the run goes live, its stopped step is
  active again, summary and attention cleared; signed `run.retried` “Tried Banjo’s run #2 again”; a run turn queued
  where the run was asked (the starting turn's message and thread, so a handoff's data goes with it), for the person
  who pressed it (like Resume, SUB-29). Licence `agentTurn`.
- **RC-11 Superseded by run-reconciliation.md RCN-01…RCN-04.** Recovery remains bounded to one wake and then
  attention, with dependencies and wake creation rechecked in the commit and a periodic pass over durable live runs.
- **RC-12 “Browse the web” in a run turn is answered once.** An agent in a run turn on a repo that asks for
  `web.browse` gets, the first time in that turn, a refusal saying pushing and pull requests need no network key and to
  ask again if it needs the network for something else; asked again, the request goes ahead. (In-memory per turn;
  a server restart forgets it, which only means asking once more.)
- **RC-13 A coding check that does the real thing.** `run-recovery.int.test.ts`: a mention in a thread, the run
  started without a checkout, its run turn editing a *tracked* file in the owner's clone (direct), the runner's push and
  landing, Whombat's pull request, a clean clone on the branch; plus the landing problem, the stall, Try again and the
  network answer. It runs with `pnpm test:server`, which every candidate's validation runs (manifest gate
  `test-server`). The DEV box smoke can't run one: the box has no AI provider signed in (its agent turn proves the round
  trip only, devbox UP-D2), so a live coding run there needs a provider sign-in on the box first.
- **RC-14 What Whombat posts for an agent's turn goes into the thread it was asked in** (2026-10-01, John: “In the
  #reports channel we are working in a thread per report … Banjo shows the run cards in #reports and not in the
  thread”). A run's card (`start_run`) and an agent's approval card (`createApproval` without an explicit thread: key
  requests, asks for a branch, a push, an action) go into the thread of the agent's turn (`turnThread`: the dispatch
  `start_run` names, else the MCP call's dispatch scope) when that turn works in the same conversation; top level
  otherwise, as before. On #reports a key request had started a second thread under its own card, and Run #3 carried on
  there, away from the report. A caller that says where (a Feedback handoff's approval) keeps its own thread. The yes
  and no to a card in a thread already answer in that thread (`wakeForApproval`, `postMessage`'s root).

*Amended 2026-10-04 (resourceful-agents.md RA-DS53…RA-DS55, from John's box): `start_run` refuses a run whose checkout
can't be made, with what is missing and where it's fixed; a run turn whose checkout can't be made is refused before the
model starts, its run fails in those words and Try again on that failure tries the run again (RC-03, RC-09, RC-11,
EA-09 for run turns); what the runner could not do is said once per run, with one period.*

*Amended 2026-10-04 (resourceful-agents.md RA-DS62): a run whose goal waits on a person is left live with the agent's
question (`asks: true`) as its attention, not woken by RC-11; the next message of the person it is for, in its thread,
wakes the agent on the run; Work lists a run with attention as BLOCKED · NEEDS A PERSON.*

- **RC-15 A run that waits on something that takes time stays live, and the turn it scheduled continues it**
  (2026-10-04, John's box, Banjo's run #6 on whombat-app PR #1: after merging `main` into the branch the shared CI was
  still pending; Banjo scheduled a look for 15 minutes later and ended the turn with the run live, RC-11 woke it as a
  run left with nothing to wait on, and that wake's prompt said “when something else blocks you … finish_run as
  failed”, so the card read RUN · FAILED for work that was going fine). Now: a still-active schedule made in a turn of
  the run (`agent_schedules.created_by_dispatch_id` → that turn's run, `dispatchRun`) is something the run waits on
  (`waitsOn`), so no RC-11 wake and no attention; when it comes due and the run is still live and its agent's, the
  ticker queues the `schedule` turn as a turn on the run (`mode: 'run'`, `runId`; `liveRunOfSchedule`), in the run's
  checkout, with the schedule's own words. A run no longer live gets an ordinary scheduled turn, as before. The run
  turn's line and the RC-11 wake say so: “When it waits on something that takes time (a CI run, a build, a deploy),
  don’t finish it either: schedule a turn for when to look again and leave it live; that turn continues this run.”
  No migration, no contract change: the card shows the run as live with its latest log line. Test:
  `run-recovery.int.test.ts` (red without the change: the stall wake), runner `prompt-turns.test.ts`.

*Amended 2026-10-07 (health-checks-wake.md HW-06, HW-08): a run doesn't schedule a turn to wait for its pull request's
checks — their result wakes the agent on the run, and checks still to come count as something the run waits on (RC-11);
the run turn's line says so and keeps scheduling for other things that take time (a build, a deploy). The stall wake
still schedules CI: it comes only when nothing will wake the agent on the run.*

## Known limits

- A run turn is a new provider session: what the starting turn read is not carried over (the run's title, steps and
  latest activity, the thread and the handoff data are).
- Making `direct` the default checkout for every developer agent is not done: on a box there is no clone people see,
  and on a shared self-hosted machine a worktree keeps the owner's checkout untouched. It is set per agent (Configure
  agent) or for the dev instance's agents.
