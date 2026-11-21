# Workstream: runs and approvals (web)

TODO 8.1, the run-page half of 8.2, the web controls of 8.3, 9.1 and the UI of 9.3. Builds on
`web-shell.md` (WS-01 screens take props, WS-02 modals are URL state, WS-05 Esc order), `client.md`
(reducers, optimistic approval decisions), `core-contracts.md` (approvals display machine, run copy) and
`runtime-server.md` (what Pause / Resume / Take over do on the server).

## Layout

```
features/runs/
  RunScreen.tsx        container: runs.get + run:<id> topic, Pause / Resume / Take over mutations, toasts
  RunView.tsx          presentational page (contract types in, callbacks out) + stories
  runModel.ts          pure view model: dot, controls, notice, kicker, tests, step markers, visible log
  TakeOverDialog.tsx   confirm before taking over
  useBurrowViewer.ts   names, viewer and time zone from the cached bootstrap (also used by approvals)
features/approvals/
  ApprovalModal.tsx    container: approvals.get (kept live by approval.updated), decide / undo, toasts
  ApprovalDetails.tsx  presentational modal contents + stories
```

## Decisions

| # | Decision | Reason |
|---|---|---|
| RAP-01 | The run page streams without polling: `useRun` + `useSubscription(topics.run(id))`; the client's reducers apply `run.updated` (steps, tests, files, diff, status) and `run.log` (lines merged by `seq`). Everything the page shows is derived in `runModel.ts` from the `Run`; copy comes from `@whombat/core` (`formatRunKicker`, `formatTestsPassing`, `logLineTone`, `keyRows`, `runKeysTitle/Scope`, `RUN_LOG_VISIBLE_LINES`). | One source of truth; the same run card / plan / sidebar reducers update the rest of the app. |
| RAP-02 | **Controls follow the run status**: Pause while `live`, Resume while `paused`, Take over while `live` or `paused`; a finished, failed or taken-over run keeps only Branch room. The buttons wait for the server (disabled while a request is in flight) instead of switching optimistically, and the response's `run` is written to the cache. Toasts, in the mock's toast voice: “Paused. Banjo stopped where it was.”, “Resumed. Banjo picks up where it left off.”, “You have feat/invoice-pdf now. Banjo has stopped.” Refusals toast the server's message. | Pausing or taking over stops an agent's work; showing a state the server has not accepted would lie. |
| RAP-03 | **Deliberate deviation**: at RUN · DONE the mock still shows Pause and Take over (its buttons are static). We hide them; the visual spec masks that slot at tick 8. | Pausing or taking over a finished run means nothing. |
| RAP-04 | **Take over asks first** (not in the mock): a 560px dialog in the approval modal's language — 64px agent avatar, mono `TAKE OVER` kicker, “Take over Banjo’s run?”, sf2 explainer (“Banjo stops now and hands you feat/invoice-pdf. The steps and log so far stay on this page, and Banjo won’t push to the branch again.”), Cancel / Take over. Esc and overlay close it. | It is irreversible for the agent (runtime-server: the agent is not asked to do anything further). |
| RAP-05 | **Paused / taken over / failed, quietly**: the kicker label is the core's (`RUN · PAUSED`, `RUN · TAKEN OVER`, `RUN · FAILED`), the dot turns warn / mut / bad without the live halo, and a one-line note sits under the header on sf2 (the approval explainer's box) with a 3px left rule in the tone. Paused: “You paused this run. Banjo stopped where it was and picks up from the last step on Resume.” (or “Mara paused …”). Taken over by the viewer: “You took over feat/invoice-pdf. Banjo has stopped and won’t push to it again. Pick it up locally:” + the `git fetch origin … && git switch …` command (same as the server's `instructions`); by someone else: “Mara took over …”. Failed: the run's `summary`, else “Banjo stopped after an error. Ask again to retry.” The active step's marker becomes a warn outline (paused) or a mut outline (stopped); a step the server marks `failed` is a filled bad circle. | Not mocked (B-05): nearest pattern, same tokens, no new components. |
| RAP-06 | Live log: the last 12 lines, oldest first, bottom-anchored (`justify-content: flex-end`), `role="log"` with `aria-live="polite"`. Lines with `seq ≥ run.logCount` are hidden: after a demo rewind the client still holds the old lines, and the replay reuses their sequence numbers; every new line arrives with a `logCount` that covers it (`run.log` reducer). | Found running `pnpm demo:play` twice against a real server: the replayed page started with the previous run's last line. |
| RAP-07 | Steps are an `<ol aria-label="Steps">`; each item carries its state in screen-reader text (“· In progress”); queued steps show no time (as the mock); the 2px connector is ok when the step is done, line otherwise, absent after the last step. Key rows carry “· can” for the ✓ rows (the others already read “asks a person” / “no key”). | Accessibility without visual change. |
| RAP-08 | **Approval modal** = `ApprovalDetails` inside `<Modal width="md">` (TP-12: overlay click and Esc close; `onOpenChange(false)` removes `?approval=`). Everything is `approvalView()` for the signed-in viewer, recomputed on every render, so conditions, notes and the CTA (“Approve in advance” until the other conditions are met, then “Approve and deploy”) follow `approval.updated` live while the modal is open. The explainer is the requester's stored `approval.explainer` while pending. | README screen 9; the display machine is shared with the card, branch pane, log and mobile. |
| RAP-09 | Approve / Decline close the modal at once and toast `view.toasts` computed before the mutation (“Approved in advance. Dusty will deploy when checks are green.”, “Approved. Dusty is deploying to staging.”, “Declined. Dusty won’t deploy this commit.”), exactly like the mock's `flash()`. The decision is optimistic (`useDecideApproval`: card, modal and plan step flip together); a refusal or failure restores the cache and toasts why. | Mock behavior; client.md's optimistic contract. |
| RAP-10 | **Reopening a decided request** (the mock only ever shows the pending modal): the kicker slot shows the phase label in its tone (`APPROVED · WAITING FOR CHECKS`, `APPROVED · DEPLOYING`, `DEPLOYED`, `DEPLOY FAILED`, `DECLINED`), the explainer slot shows `view.message` (“Declined. Dusty won’t deploy this commit. Banjo and Hazel have been told.”), and the actions are **Undo** (while `view.canUndo`: decided, not executed or executing, by the decider or an owner — B-02) and Close. A viewer who is not an approver sees “Only Joris or Mara can decide this.” instead of the buttons. | Undo must be reachable from the modal too; same copy as the card. |
| RAP-11 | Decline notifications are the server's (server-core / approvals command): a thread reply under the approval card, “@Dusty, I declined “Deploy feat/invoice-pdf to staging”. Heads up, @Banjo and @Hazel.”, which dispatches the agents; every approve / decline / undo is a signed Asks event. The web adds nothing; fixture mode does not post the reply (fixtures scope, FX-12). | Verified against a real server (below). |
| RAP-12 | Loading and missing states: the run page renders an empty `aria-busy` section while loading and the shell's quiet placeholder (“This run doesn’t exist, or it’s in a room you’re not in.”) on 404; the modal says “Loading the request…” / “This request isn’t here any more, or it’s in a room you’re not in.” with Close. | B-05. |

## Changes outside the two folders (additive)

- `packages/fixtures/src/fetch.ts`: `runs.pause` / `runs.resume` / `runs.takeOver` with the server's status rules
  and event texts; 404 for run numbers other than #1907 and approval numbers other than #12 (tests in
  `fetch.test.ts`).
- `tools/visual`: `waitFor` option / `--wait-for` flag on the reference harness, to shoot the mock at an exact
  live tick.
- `apps/web/src/app/router.test.tsx`, `shell/keyboard.test.tsx`: the run page and the approval modal now have real
  headings (“Address review on PR #482”, “Deploy feat/invoice-pdf to staging?”).
- `apps/web/visual/`: `run.spec.ts`, `approval.spec.ts`, and `mockRun.ts` / `mockApproval.ts`, which patch the
  cached data to the mock's at a given tick (the fixture run carries the seed's two steps and two files; the
  server lays out the five storyline steps when the run plays).

## Verification

- `pnpm visual` (fixture mode, 1440×900, frozen clock, light and dark):
  - `run.spec.ts`, main column (x ≥ 256) vs `--screen run` at ticks 0, 3, 5 and 8: 33–34 px (0.003 %) at every
    tick in both themes — avatar anti-aliasing (AV-02); at tick 8 the header buttons are masked (RAP-03).
  - `approval.spec.ts`, the dialog vs `--screen channel --click Details`, pending (“Approve in advance”) and
    ready (“Approve and deploy”, reference shot once its live modal says so): 219–220 px (0.06–0.07 %), the 64px
    avatar and a corner pixel.
- Real server on a throwaway database (`whombat_ra_*`, own ports, scripted runner): `demo play` streams the page
  from tick 0 to RUN · DONE (a line every 2.6 s, steps advancing, 38 → 41 of 41, diff +214 → +250); Pause →
  RUN · PAUSED with the note and Resume; Resume continues from the next line; Take over → confirm → TAKEN OVER
  with the command; approve in advance → toast, APPROVED · WAITING FOR CHECKS, Undo → pending; decline → toast,
  DECLINED, the thread reply in #billing-v2 and signed events for every decision; with the modal open the
  conditions turn green live and the CTA becomes “Approve and deploy”; approving then deploys (DEPLOYED, no Undo).
- Unit / component tests: `runModel.test.ts`, `RunScreen.test.tsx` (header, keys, files, streaming, rewind,
  pause / resume, take over with confirm, navigation, not found), `ApprovalModal.test.tsx` (contents, live CTA,
  approve / decline / undo, toasts, Esc and overlay close, not found). Stories: `Runs/Run page` (live, running,
  done, paused, taken over, failed, take-over confirm) and `Approvals/Approval modal` (pending, ready, approved ·
  waiting, deploying, deployed, declined), light and dark.

## Merge and Deploy in three states (2026-10-01)

John: “I would like to be able to assign both merge and deploy to an agent when I want to. For both I would like to
introduce 3 states: disable / enable / ask.” This **supersedes** the mock's “people only” for Merge into main and
“always asks a person” for Deploy (John's call). Assignment: `docs/implementation/merge-deploy-keys/assignment.md`;
contracts 0.34.0 / 0.34.1 (CT-211…CT-215, `docs/implementation/merge-deploy-keys/contracts-0.34.md`); the app's rows are
whombat-app's decision log.

| # | Decision |
|---|---|
| MDS-01 | **Caps lifted.** `merge.main`, `deploy`, `deploy.staging`, `deploy.production` go up to `can` (`agentMaxTier`), their descriptions lose “People only…” / “Agents always ask a person first.”. No other cap changes. New people-only key **“Push to main”** (`branch.main.push`): `branchWriteKey(defaultBranch)` returns it, so Merge On never lets an agent push to main, get push credentials for it, or start a run on it. |
| MDS-02 | **Two rows, three states**, Off · Ask · On (`cannot` / `ask` / `can`) in Configure and the hire modal. The Merge row writes `merge` and aligns `merge.main` (`withKeyRowTier`); Deploy writes `deploy` and aligns the environment keys. A row reads the tier that decides a merge into main / a production deploy (`keyRowTier`: the most specific level wins, the strictest of the row's keys). Defaults stay Off (the Operator's Deploy reads Ask). No “not for this role” lock on these rows. |
| MDS-03 | **Ask = a card, On = no card, Off = blocked.** An agent's `merge_pull_request` / `perform_action` merge or deploy at Ask is an approval card (in the conversation and the approvers' Needs you), carried out on a yes; at On it runs; at Off it is blocked naming the key, and the agent may ask for it. The merge rules stay for everyone (open, checks green, an approving review). |
| MDS-04 | **Key requests give Ask.** `merge.main` may be asked for; an approved request for a Merge or Deploy key gives the row at **Ask** (`requestedTier`, `grantsWithRequestedKey`); a person switches it to On in Configure. Amends KR-02 (Merge into main is no longer refused as people-only) and KR-04 (these keys go in at `ask`, not `can`). |
| MDS-05 | **Deploy without a workflow.** The Deploy row can be set either way; `host.info` answers `deployWorkflow` (`approvals.hasExecutor('deploy')`, the same condition `approvals/unavailable.ts` answers “Whombat can’t deploy here” on) and the app shows the hint while it is false. Setting up deploy workflows from the UI is open. |
| MDS-06 | **Agents are told** (`packages/agent-runtime/src/persona/merge-deploy.ts`, in both prompt builders): On “You may merge pull requests, into main too, when a person asks you to…”, Ask “…posts a card… say the card is posted and stop”, Off “ask for the key with request_approval…”; the same for Deploy; always “Merge only with merge_pull_request: never push to main, and never merge with git merge, git push or gh pr merge.” Nothing for personal agents (they never hold these keys). |
| MDS-07 | **Audit unchanged.** Tier changes are the existing signed Keys events; merges (`pr.merged`) and deploys keep theirs. |

### Decided while implementing (runtime)

| # | Decision | Why |
|---|---|---|
| MDS-D01 | **`merge_pr` no longer refuses agents itself.** It calls core's `mergeBlock(pr, 'person')`: the keys engine has already decided who may merge (an agent at On, or a person's yes at Ask), and the rest of the rules (open, checks, an approving review) apply to agents and people alike. `MERGE_BLOCK_MESSAGES.agent` stays only for the type. | Core's `mergeBlock` still answers `agent` for any agent; a Merge On key would otherwise be dead. |
| MDS-D02 | **A yes at Ask merges as the person who said it**, however the agent asked (`merge_pull_request`, `perform_action` or `request_approval`): `merge_pr`'s key requirement sets `approvalRunsAction`, so the approval runs the `merge_pr` executor (EA-02) as the approver — GitHub's message “Merged by Mara Okafor in Whombat.”, the `pr.merged` event signed by the person — and wakes the agent under the card. At On the agent merges and signs itself. | One behaviour for every way of asking; the person who authorised the merge is the one on record for it, as before. |
| MDS-D03 | **The merge card goes where the agent was asked and waits for checks.** The MCP adapter passes the dispatch's conversation (`mergePr.conversationId`, internal), so the card is in that conversation rather than the burrow's first channel. While the PR has checks the card carries a “Checks pass on the latest commit” condition, so a person can approve in advance and it merges once green; a PR without checks has none (it would never be met). `liveState` reads a merge's PR in its own repo. | Agents are asked to merge right after opening; a card that fails because CI is still running is noise. |
| MDS-D04 | **Deploy On with a workflow that finishes later** (self-hosted, `GITHUB_DEPLOY_WORKFLOW`): `perform_action` still answers “Ask a person with request_approval to deploy: it finishes after this turn.”, because a deferred deploy's progress lives on an approval. Open (below). Managed Whombats have no deploy workflow, so there the row only changes what `unavailable.ts` answers (nothing) and what a simulated or future executor does. | Out of scope for this task; the honest answer stays. |
| MDS-D05 | **Repositories kept on this Whombat get pull requests, merged in the origin** (amends repositories.md RP-05 and its follow-up). `open_pull_request` opens a Whombat PR (`local_only`, no URL) from the branch the runner pushed to the bare origin, waiting up to 20 s for it like GitHub's; head, files, diff and commits are read with git. Merging (`merge_pr`, any actor) re-reads the head, then merges inside the bare origin with the server's git — `merge-tree --write-tree`, `commit-tree` (squash on top of the base by default, a merge commit for `method: merge`, rebase refused), `update-ref` only from the base it read — as whoever merges (a person's name and email, an agent's name and commit email), message “Merged by {name} in Whombat.”. Conflicts, nothing to merge and a base that moved refuse with a 409 and leave the origin unchanged. External effect `git.merge` (CS-01). `pr.merged` payload `onWhombat: true`. | “Merge into main” has to work on a managed appliance's own repositories too, and git's plumbing merges in a bare repository without a checkout, hooks or a new dependency. |
| MDS-D06 | **A person's merge of such a PR is its review.** People have nowhere to review a Whombat-only PR (reviews of connected repos come from GitHub), so for a local repo a person merging — or approving an agent's merge card — doesn't need a separate approving review; changes someone requested still hold it, and an agent merging at On still needs an approving review (`review_pull_request`). | Otherwise no person could ever merge a local PR without asking a reviewer agent first. |
| MDS-D07 | **The sandbox can't merge or push to main on its own** (checked, unchanged): guarded agents' `gh` has an empty config and no token, git's credential helpers are off, and the sandbox writes only the worktree and its workspace repo (`commitPaths`), never a local origin under `.origins`; the runner's push asks for credentials, which for the default branch need “Push to main” (people only). Covered by `merge-deploy.int.test.ts` (credentials and `start_run` on main blocked with Merge On). | MDS-06's rule is enforced, not only stated. |
| MDS-D07 ↳ | Amended by agent-computer.md AC-41: “Push to main” is agent-grantable (Off by default); a `git push … main` on an agent’s computer is classified `push_main` and decided by that key (Off blocked, Ask a `run_command` card, On runs), and the runner’s own push still needs it through `authorizeGit` — Merge On never implies a push to main (AC-DS20). | |
| MDS-D08 | **Copy that said “nothing merges without people”** now says the agent's keys decide: the Feedback handoff card (“…which branches it may create and push in …, and whether it may merge.”) and the reporter-assessment prompt line. | They were no longer true for an agent holding Merge. |

Amended by this section: `github.md` “Merges and pull requests” (`merge.main` people-only, agents Blocked → MDS-03,
MDS-D01), `essentials-agents.md` EA-02 (`merge.main` kept → the agent's Merge row), `key-requests.md` KR-02 / KR-04
(MDS-04), `repositories.md` RP-05 and its follow-up (MDS-D05). The mock's locked rows “people only” / “always asks a
person” are superseded by John (MDS-01, MDS-02).

Tests: `apps/server/src/approvals/merge-deploy.int.test.ts` (Banjo's DEV grants `branch.feature.readwrite can,
tests.run can, pr.open can, branch.shared.push ask, merge.main cannot, deploy cannot, web.browse can`: Off blocked and a
key request giving Ask; Configure's Ask over the stale `merge.main: cannot` → card in the conversation and Needs you, a
yes merges on GitHub as the person; On merges without a card, an unreviewed PR is refused, push and runs on main stay
blocked; Ask waiting for checks; Deploy Off / Ask / On with the simulated executor and the `unavailable.ts` answer and
`deployWorkflow: false` without one; hiring with `keyTiers`), `apps/server/src/github/local-prs.int.test.ts` (local
PRs: open, On merge after a review, Ask merged by the approver, a merge commit, a conflict refused),
`packages/agent-runtime/src/workspace/local-origin.test.ts` and `persona/merge-deploy.test.ts`.

### Open

- Deploy On with a deploy workflow that finishes after the turn (MDS-D04): run it without a card (an approval
  approved by the key, or a deploy record of its own).
- Setting up deploy workflows from the UI (MDS-05); managed Whombats have none today.
- A person's review of a Whombat-only PR in the app (MDS-D06), and refreshing a local PR's head on every push rather
  than when it is merged.
