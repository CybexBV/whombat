# Checks wake the agent (HW-01…HW-08)

Finding F3 of the 2026-10-07 DEV Whombat health review, asked for by John directly. On John's box
(`wb-k2rt-8pwn-5521`), 2026-10-04…07, Banjo waited for CI by scheduling itself: 9 cards “I scheduled a turn: once, … at …”
(#reports 3, #general 6) and 8 `schedule`-triggered turns costing 2.43 M input tokens — 5.1 % of everything in three
days — each a full run-context turn (200–620 k tokens, 48–157 s) that re-read the pull request and its checks and either
posted a status line or scheduled again (2026-10-06 09:58, 10:42, 10:48, 11:18, 13:09 UTC). The looks were 20 min to 2 h
apart, so results reached John late too. Meanwhile the GitHub poller already read every check run of every open pull
request every 30 s (`pr_checks`, the failure pill in the branch room, approval conditions); How you work told agents to
schedule “what can only happen later” (RA-DR11), the run turn told them to schedule a look at “a CI run” (RC-15), and
there was nothing an agent could wait on instead.

| ID | Decision | Why |
| --- | --- | --- |
| HW-01 | **A finished round of checks wakes the agent whose work the pull request is.** Per open pull request (not local-only) the poller checks whether every mirrored check of the head has its result (passed, failed or skipped; at least one check) — `checksDue` in `poll-plan.ts`, pure — and then commits `github.checks_finished` (`github/checks-wake.ts`) as the burrow's GitHub system principal. The round counts as finished when a poll finds it finished **and unchanged** (nothing about the PR's checks mirrored in that poll), so the wake comes one poll (30 s) after the last result. The command checks everything again under the burrow's lock (still open, same head, not handled, all done), so a plan that went stale does nothing. | The poller already reads every check every 30 s; the agent read the same thing by hand 20 min–2 h apart at 200–620 k tokens a look. GitHub creates a job's check run when the job it needs has finished, so a round can look finished for a few seconds: waking on the first sight would hand the agent half a result, and once per head (HW-03) it would never hear the rest. |
| HW-02 | **Superseded by CW-01 (concise-replies.md)**: the wake is one plain line, “The checks on [PR #1](…) failed (build).”, and the commit and the counts are in the agent's brief. **The wake is an ordinary message from GitHub, naming the agent:** `@Banjo The checks on [PR #1](https://github.com/acme/whombat-app/pull/1) finished on 3d88d8: 3 passed, 1 failed (build).` — checks counted by result (passed, failed with the failing ones named, at most three then “and N more”, skipped), the head's short sha, the pull request linked to GitHub (`PR #1` when it has no URL). `checksOutcome` / `checksWakeText`. The message mentions the agent explicitly and is posted without a chat dispatch: its turn is queued in the same commit (HW-04). | The people in the thread read the same result the agent gets, where they asked; the sha says which commit it is about if the agent pushed again since; mirrored messages say what happened in one line (“Checks finished on e9f114.”). |
| HW-03 | **Once per head commit**, durably: `pull_requests.checks_handled_sha` (migration `0083_checks_wake`, expand: a nullable column) is set to the head in the commit that handles its round — also when nobody is woken, so a run started on that head later (AE-05: “deploy PR #3”) isn't woken with old news. The migration sets it for open pull requests whose head's checks are all done, so rounds that finished before the release wake nobody. A new head (a push) is a new round; re-running checks on the same head wakes nobody. | Idempotent across repeated polls, restarts and two servers: the plan is pure state, the command re-checks and writes the mark with the message and the turn. The design asked for once per head; the mark is per pull request and visible for checking on a box. |
| HW-04 | **Whose work, in this order.** (1) Each agent's newest **live** run on the pull request (its `pr_number`, or its branch while it has none): the message where the run was asked — the run's conversation, in the thread of the turn that started it when that turn was there, else the thread of the run's card, else the top (as Try again answers, RC-10) — and a turn **on the run** (`mention`, mode `run`, `runId`, so its checkout and run tools; for the run's person through `personBehind`, SUB-28). (2) A **paused** run: the same message, no turn (the claim would cancel it; the person's pause stands, and the turn that resumes it reads the message in its thread). (3) No such run: the pull request is an **agent's own** (`pull_requests.author_id`, as `open_pr` records it), its head is a commit Whombat pushed for that agent (a push grant with that sha, GP-01, live or expired), and a check **failed**: the message at the top of the branch room and a mention turn there, for the person the push was for. (4) Otherwise nobody; the head is only marked handled. Agents that can't be woken there (retired, removed, not a member, an archived room) are skipped. | A run that waits on CI is the measured case: it gets the result in its own thread and checkout. An agent's finished pull request whose checks fail on its own push is its to fix; a pass on finished work is the person's news (the branch room shows it) and would cost a full turn; a person's push (or GitHub's “Update branch”) to the agent's branch is theirs. The demo storyline (run #1907 finishes before CI goes green) is unchanged. |
| HW-05 | **AH-01 never holds the wake, nor the exchange after it.** The wake's turn is queued without the agent-chain cap (`agentMessage` unset, as for a person's message), and `chainCapped` counts a message of GitHub's system principal that names someone as a person's message — the wake, or an outside reviewer's words naming an agent. So four agent messages in a row before it don't stop it, the woken agent may ask another agent right after (Banjo: “@Waffle green now, can you look?”), and its `delegate` isn't refused as a capped chain (`wokenByCappedChain`). Amends AH-01. | The result of the checks is the outside world speaking, not an agent in a loop. A loop across wakes still needs a new head and a real CI round each time, and every wake is a visible message in the thread. |
| HW-06 | **A live run waits on checks still to come** (RC-11's `waitsOn`, `checksToCome`): its open pull request on GitHub has checks on its head whose round isn't handled yet, or the turn that just ended pushed and the repository's pull requests have checks at all (the poller reads the new head's round shortly). Then no stall wake and no attention: the checks' result wakes the agent on the run. Without checks the run is stalled as before. | Without it, an agent that stops scheduling for CI would be woken at once to “finish it or say what blocks it” and then marked as needing a person. A repository whose pull requests never had checks has no CI to wait for. |
| HW-07 | **No contract change.** `@whombat/core` stays 0.54.1: the turn is an ordinary `mention` (in mode `run` with `runId`, like the answer that wakes a run, RA-DS62), the message an ordinary message by GitHub's existing system principal, the `schedule` description amended where Whombat serves it (HW-08). | Server, web and mobile need nothing new: the message and the run's card already show what happened. |
| HW-08 | **The prompt says it.** How you work (`persona/work.ts`), every turn: “What only time can bring — a reminder, “check the deploy again in 30 minutes”, a weekly summary — schedule as a turn of your own (schedule). Don’t schedule a turn to wait for checks or CI: when the checks on a pull request you work on finish, Whombat wakes you in the run’s thread with the result.” A run turn's line (runner `prompt.ts`): “When it waits on its pull request’s checks, don’t finish it either: leave it live, and Whombat wakes you on it when they finish. When it waits on something else that takes time (a build, a deploy), schedule a turn …”; its request names the new waker (“…, its pull request’s checks finished, or a turn you scheduled on it came due”). The stall wake keeps scheduling CI and says why: “… while the run was still live, with nothing to wake you on it.” (a re-run on the same head, CI Whombat doesn't see). The `schedule` tool's description as served gains “Not to wait for checks or CI: when the checks on a pull request you work on finish, Whombat wakes you in the run’s thread with the result. Schedule only what time alone brings.” (`servedToolDescription`, `@whombat/agent-runtime/served-tools`, used by the server's `tools/list` and the prompt-size harness alike). Amends RA-DR11's promise line and RC-15's run-turn line. | The agent scheduled because the prompt told it to; it needs to know both that it shouldn't and what happens instead. One sentence each, paid on every call. |

## Prompt size

`pnpm prompt:size` (characters / 4), before → after:

| Turn | System prompt | User turn | Tool schemas | Total |
| --- | --- | --- | --- | --- |
| Pippa DM, 10 packs (Codex) | 6 424 → 6 463 ≈tok (How you work 607 → 646) | 2 802 (same) | 25 555 → 25 599 | 34 781 → 34 864 (+83) |
| Banjo run + checkout (Claude) | 8 917 → 8 981 (How you work +39, Working in Whombat 1 894 → 1 919) | 991 → 1 000 | 27 962 → 28 006 | 37 870 → 37 987 (+117) |
| Hazel personal (Claude) | 5 376 → 5 415 | 1 404 (same) | 30 383 → 30 427 | 37 163 → 37 246 (+83) |
| Dusty scheduled (Claude) | 5 658 → 5 697 | 1 321 (same) | 25 555 → 25 599 | 32 534 → 32 617 (+83) |

About 120 tokens a call on a run turn, mostly read from the cache, against the 200–620 k tokens of each scheduled look
it replaces.

## Tests

- `github/checks-wake.int.test.ts` (poller against FakeGitHub): a check still running wakes nobody; a finished round on
  a live run's pull request waits one poll, then posts exactly one GitHub message in the run's thread and queues one
  `mention` turn in mode `run` on the run, for Mara; the same head again, and a restarted poller, change nothing; a new
  head wakes once more; four agent messages in the thread hold neither the wake nor Banjo's question to Waffle after it;
  a paused run gets the message and no turn; a person's pull request wakes nobody, is marked handled, and a run started
  on it later isn't woken; an agent's own pull request wakes it in the branch room on a failure on its push and not on a
  pass; `schedule`'s served description. The breaker case is red without HW-05's `chainCapped` rule.
- `runtime/run-recovery.int.test.ts` (the real runner, bare repositories): Banjo's run turn commits and leaves the run
  live without a schedule; the runner pushes, Whombat opens the pull request, the run is not stalled (red without
  HW-06); the checks pass, two polls, and GitHub's message wakes Banjo on the run in its checkout, which finishes it.
- `github/checks-wake-migration.int.test.ts`: 0083 on a database at 0082 marks the open pull request whose checks are
  all done, not one still running, one without checks or a merged one.
- `github/checks-wake.test.ts` (unit): `checksDue`, `checksOutcome`, `checksWakeText`.
- Runner `prompt-turns.test.ts`: the run turn's line, the stall wake's line, a run turn woken by GitHub's message (same
  system prompt as any turn on the run); the prompt snapshots (`prompt-turns`, `prompt-capabilities`, `handoffs`).

## Known limits

- Commit statuses (`GET …/commits/{sha}/status`: Vercel, a CI outside GitHub) aren't polled (github-gh.md follow-up),
  so they neither count nor wake. A repository whose only CI reports statuses wakes nobody; a run waiting on it is
  stalled once (RC-11), and that prompt says to schedule.
- A check that disappears on a new head stays queued (github-gh.md follow-up): that head's round never finishes, nobody
  is woken, and a run on it waits without a stall — the limit approvals already have.
- Re-running checks on the same head wakes nobody (once per head); the agent that re-ran them is stalled once and
  schedules.
- The fallback (HW-04 (3)) needs a push grant with the head's sha: pushes by runners that didn't say what they pushed,
  and an agent's own `git push` in a trusted turn, don't wake it there.
- The wake reaches the thread's people by their notification level, like any reply.
- Migration `0083_checks_wake` may collide with another stream's 0083: renumber at merge (self-contained).
