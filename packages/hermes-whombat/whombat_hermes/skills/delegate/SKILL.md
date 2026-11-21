---
name: delegate
description: Hand a list of coding tasks to T3 Code from one checklist card, follow their progress, and check one combined candidate before a guarded merge. One T3 Code thread leads every ticked task with the same AI, splitting the work over subagents itself, in one pull request. Use for review findings, a council's suggestions or a person's list of project work.
---

# Handing tasks to T3 Code

Offer tasks on one checklist card in the thread. The person ticks them and chooses **Hand over**; Whombat hands
them to T3 Code and follows them on the card. One T3 Code thread leads every ticked task that shares an AI choice and
keep-open preference: it reads the code, plans, runs independent parts on a few subagents (as many as `atOnce`) and
does the rest itself, on one branch and in one pull request, testing only what changed (`fast-test`). A task with another AI runs in a
thread of its own. The lead ends with a line per task, which goes on its row; a task it says it didn’t do needs a
look, and so does one it says nothing about. For automatic merging, a final task combines the finished work and
checks that exact candidate before main changes. Whombat independently verifies the checks, then merges that
candidate itself, and the thread puts it on DEV. You are woken for judgment and when the work ends.

## When

- Offer a card for a list of project work: what a council's review found, the person's list or your plan for a
  bigger job. One task alone is an ordinary T3 Code hand-over. A council that improves a project builds its own plan
  in T3 Code: no card for that.
- T3 Code must be connected at Manage. If `delegate_offer` refuses, explain why in one line.
- Pass `start: true` when the person already asked to do the work; otherwise offer it for them to hand over.

## Before you offer

Look at the latest default-branch commit's checks on GitHub, including required contexts, check runs and commit
statuses. Missing or queued checks are still waiting. If a check already fails, put a task to repair it first and
name the failure in `rules` so the other tasks do not chase it independently. A failing baseline is never passing;
the combined candidate must still pass before it can merge.

## Offer

Use `delegate_offer` with:

- `title`: what the work is for, in the person's words.
- `intro`: one or two sentences above the card, saying what the person can hand over.
- `project`: the T3 Code project (`t3_project_list`); omit only for scratch-folder research.
- `tasks`: up to twelve ordinary tasks, each with:
  - `title` and `why`: a few words and one plain sentence for the checklist.
  - `brief`: the goal, what done means, relevant files or screens, and focused checks. Keep it self-contained and
    concise: the coding agent does not see this chat.
  - `picked: false` for an optional task to show without selecting it.
  - `areas`: files, folders or parts it changes, when you know them. They matter only for a task with another AI:
    overlap makes it wait for the earlier work.
  - `after`: the number of a task whose work it needs. The lead does dependent tasks after what they build on; a task
    with another AI starts from the finished predecessor's branch.
  - `provider` and `model` only when the person chose the AI. Each task uses its own choice, then the card's, then
    T3 Code's default; grouping must preserve that choice and its options.
- `rules`: the conventions every task needs: where shared strings go, migration numbering, known baseline failures.
  Testing is the same everywhere: `fast-test` in the repository's folder when it has a `.fast-test.json` (it tests
  only what changed and sends heavy tests to its build server by itself; exit 0 passed, 1 failed, 2 couldn't run), otherwise
  the quick checks its AGENTS.md or CLAUDE.md names. Never the full test suite: that runs every night and when the
  person asks. Say in `rules` when a task must not go to DEV after its merge. A requested model review can run after
  the pull request opens, alongside remote checks.
- `atOnce` (default 3), `pullRequests` (default on) and `merge` (default on), only when the person wants otherwise.
  `merge: false` leaves the pull requests for review. Automatic merging combines and checks them before merging.

Split by results the person can tick, not by files: the lead decides how the work divides. Avoid making a separate
task for each step of one change.
After offering the card, post nothing else and end with the no-reply word.

## Talking about the card

Use `delegate_update` in the person's turn, by the numbers currently shown. Each answer returns the updated list.
Say what you changed in one line; let the card carry the list. The card moves to the end of the thread when it changes,
so never point at it with “below” or “above”: call it the Tasks card.

- `change` rewords, ticks or unticks a task, or changes its dependency (`after: 0` clears it); `remove` removes
  ordinary tasks that have not started; `order` changes their display order; `add` adds work. Dependencies still
  decide execution order, and a thread at work keeps the numbers it was given.
- `start` hands over the ticked tasks when the person asked.
- `stop`, `retry` and `send` stop, retry or give more work to a task. Rows sharing a group share these controls,
  including a launch that has not returned its thread yet. More work for an ended thread waits for a place.
- A task's `change` with `merge: false` keeps its shared pull request open and excludes it from automatic integration;
  automatic work depending on it waits too. `merge: true` includes eligible work in the combined candidate.
- Update `atOnce`, `pullRequests`, `merge`, `title` or `note` when asked. Added, retried or changed work invalidates
  the old combined check; an ended card opens again for new work.

## While they work

- Successful tasks need no intervention. They leave their source pull request open, and a task with another AI can
  start from its finished branch. While the lead works, the other tasks in its thread read “With 1” on the card. A
  task waiting for remote checks holds no running place. A thread's answer comes once, on its first task; the others
  name that task (`answerWith`).
- An item the lead didn't report on, in an `Item N` line or while it worked, needs a look like one it didn't do: read
  its thread, then retry it or send the thread the question. More work sent to a lead asks it for each item's line
  again: the task you sent it for must say how it went, and an item its new answer leaves alone keeps how it went.
- “Check everything together” is a reserved final row, beyond the twelve ordinary tasks. It is mandatory while
  automatic merging is on; do not remove or untick it. It combines eligible source heads with the latest default
  branch, preserving their ancestry, and checks the exact candidate before authorizing any merge. Kept-open and
  unlisted work stay out. Cards for the same T3 Code connection and project take turns in this final phase.
- Missing, queued or running checks mean waiting. A confident completion message, a partial set of green results or
  an empty checks list is not merge permission. Whombat must confirm the expected checks independently on GitHub.
  When the default branch requires no checks there, the final thread's `fast-test` run (or the repository's quick
  checks) is the check and CI isn't waited for (a CI failure already reported still stops it); required checks on
  GitHub bring the wait back. `fast-test` that couldn't run is said, never replaced by the full suite.
  When all the work is in one pull request, the final row checks that pull request itself instead of a copy.
- Checks that wait in the CI queue past 30 minutes wake you, with a line on the final row. Look at the CI itself:
  whether it runs and has taken them. Ask for them again, or have what holds them fixed (a T3 Code thread for a bug
  in the CI), and tell the person only what they must do.
- Whombat merges the checked candidate on GitHub itself, at the commit that was checked and only while the default
  branch is the one it was checked on, with a merge commit that keeps the source branches. A changed source,
  candidate or base needs a fresh combined check, which Whombat starts; do not work around it by merging individual
  pull requests. When GitHub refuses the merge, the final row says why and the candidate stays open: tell the person
  what would let it merge, and once they did, `retry` the final row to merge it. While it merges, a change that would replace its check, or a Stop, is refused for a moment:
  try again shortly. After the merge, the final row works on while its thread puts the work on DEV the way the
  repository's AGENTS.md or CLAUDE.md says (when they say nothing about DEV, it skips that and says so); the list waits
  meanwhile. Never production. If that fails or is stopped, the work is still merged and its row says so; `retry` the
  final row on its own to put it on DEV again (not `send`: more work on it would check merged work again).
- For a failed task, timeout, failing check or unmerged candidate, add one plain note to its row. Retry when the
  cause was a blip or is fixed, send its thread a concrete correction, or explain what needs the person's decision.
- Answer a task's question yourself when the goal and the person's words decide it; otherwise ask the person.

## Finishing

When the handed-over work and its final phase are over, use `delegate_finish`. Say briefly what is done and merged,
what is still open, and what needs the person. A failed combined check means the list is incomplete, with its source
pull requests open. Say whether merged work reached DEV, as the final row says. For work that wasn't merged, offer a
useful next step through `next`, such as “Merge it”.
Keep the visible summary plain: no ids, paths or logs. Post nothing else.

`stopped: true` ends early and stops remaining work.

## Production

A checklist, its threads and the threads you start never deploy to production. Only when the person asks you in their
own message to release a repository to production, hand exactly that request to T3 Code in that repository (its own
AGENTS.md or CLAUDE.md says how), and tell them in a sentence how it went.
