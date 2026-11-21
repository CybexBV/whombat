# Automations

Automations are work that starts on its own: when a message or a reaction lands in your Chat, on a schedule, when
something happens on GitHub (a new issue or pull request, new commits, checks, a review — read by the poller), when a
The tracker customer sends a report, or when you press Run now. Each automation is a list of steps — ask the agent, post a
message, ask you to approve, wait, check a condition, open a pull request, comment on GitHub, merge, write back to
The tracker, reply to the customer, call a URL — and every step shows on the run's page. You make and change automations by
talking to the agent; there is no form or editor. How it is built: `ARCHITECTURE.md`, “Automations”; decisions:
`docs/decisions/automation-chat.md`, `bp-automations.md`, `automation-recipes.md`, `report-trackers.md` and
`automations-final.md`.

## Make one by talking

Tell the agent what should happen on its own, in Chat or in the field at the top of **Automations**: “Tell me which new
issues on acme/web are worth fixing.” It asks only what changes what runs (which repository or connection, how often,
whether it may act outside Whombat), one question at a time, and posts a **plan** in that thread:

- What it does, written by Whombat from the automation itself (never by the agent), so it says exactly what will run:
  **WHEN** (what starts it), the agent's steps, **ASKS YOU** (what waits for your yes), **POSTS** (everything that
  leaves Whombat: comments, pull requests, merges, the tracker, calls) and **LIMIT**.
- **How I thought about it**: the agent's own words about its choices.
- **The whole automation**, folded: the agent's instructions in each step, word for word.

**Turn it on** turns on exactly that plan, with the keys its steps need. **Try it on #12** runs it once as a test on the
newest issue, pull request or report it would start on (**Try it now** for the others) before anything is on. **Not
now** sets it aside. Or reply in the thread to change it: a newer plan replaces the card.

A change comes the same way, as a card that lists what changes (`+` added, `−` dropped, `~` changed) with the whole
automation folded. The current version keeps running until you press **Use this version**; **Keep the old one** leaves
it. Only the newest card in a thread can be turned on.

**The Automations page** lists your automations with what each does, its last runs and “Waiting for you” while a plan
waits, its switch, **Talk about it** (the thread where it was made), **Run now** (or **Try it**) and **Delete**. Switching
off, Run now and Delete never need the agent, so you can always stop one. The reminders and checks the agent scheduled
for itself are listed too, marked **Only tells you**.

## What an automation may do

An automation signs as itself in the audit log, and never does more than you may do right now. On top of that it holds
its own keys, given when you turn its plan on and limited to the repositories and the tracker connections its steps name:
*Open pull requests*, *Comment on pull requests* (also issues), *Merge into main* and *Merge* (other branches), *Update
The tracker reports*, *Reply to customers* and *Message people outside your Whombat* (calling a URL). Each is at Go ahead, or
Ask me first when you asked to say yes each time; a key that asks makes the step wait for your approval. An approval is
bound to exactly what it approved (the step, the version, the input and the commit): if anything moves before it runs,
it asks again.

A run posts in its own thread in your Chat; a run about an issue, pull request or report goes on in the thread of the
first run about it. A failed run, an approval and a review always notify you. **Delete** stops runs in progress, switches
the automation off, removes its keys and takes it off every list; its past runs stay in the audit log.

## GitHub issues and pull requests

- New issues and pull requests start runs only for repositories an automation listens to, and only from the moment it
  does. Each one starts one run.
- A draft pull request starts nothing until it is ready for review, unless the automation counts drafts too; bots
  (Dependabot, Renovate, any `…[bot]`) start nothing unless it counts bots too.
- The agent gets the issue or pull request as information, never as instructions, and a read-only checkout: the pull
  request's head (from a fork too: it reads that code and never runs it) or the default branch.
- A **Comment on GitHub** step posts the agent's answer on the issue or pull request, ending “— Dusty via Whombat”.

## Fixing bugs

An automation that assesses new issues or the tracker reports can also fix what it finds, when you ask for it:

- **Only assess** (the default): nothing in the code changes.
- **Ask me before fixing**: a card in the thread asks “Fix this bug?” (or “Make this change?” for anything else the agent
  recommends) before each fix.
- **Fix it when sure**: an important enough bug (High or more by default) is fixed on its own, outside a test run and
  while fewer than 5 fixes started that day. On a GitHub issue also only when the agent is sure, the fix is small,
  someone with access to the repository opened it, nobody is assigned and no pull request links it. Anything else asks,
  as above.

The agent works on a branch of its own (`feat/issue-142`), for a bug first a test that fails and then the fix; another
look reviews it, and a pull request “Fix #142: …” is opened. Merging stays yours unless you asked the automation to
**merge the fix once its checks pass**: it then waits for the checks (a day at most), runs failed GitHub Actions jobs
once more (`WHOMBAT_MERGE_RERUN`, `docs/github.md`), and merges as itself with the same rules as your merge; otherwise
it leaves the pull request to you and says why. Once a pull request it opened is merged, its branch is deleted on
GitHub, unless someone pushed to it since.

## the tracker reports

Connect the tracker in Settings → Connections → the tracker with its address and one API token for the installation (made in
The tracker → Admin Settings → Automation, with `reports:read`, `reports:write`, `reports:platform` and `reports:assess`).
The connection is used by automations only; the agent never gets it as a tool of its own. Then ask the agent (“Assess
the new reports in Acme dev”). Whombat reads the tracker every minute for connections an automation listens to, and only
reports filed after it started listening start a run. The agent reads the whole report without the reporter's name,
email or screenshot, writes its assessment back to the tracker, can answer the customer, brings a feature request to you
as a card, and fixes a bug as above; when the fix is live where the customer is, it tells them. These turns are outsiders':
they never reach your mail, files, Vault or memory. Details: `docs/decisions/report-trackers.md`.

## Limits and safety

- Per automation: one run at once and 50 runs a day by default, a run may take 7 days (waiting for you included), and
  optionally a token budget per run and per day.
- Automations started by other automations stop after two hops, and an automation never starts itself.
- A step that reaches outside Whombat (a call, a pull request, a comment) and was interrupted by a crash is never
  repeated blindly: the run shows **Needs you**, and you say what happened.
- Webhooks can't start an automation: nothing from outside reaches a Whombat. Use a schedule, a GitHub event or Run now.
- One server process runs automations at a time (a database advisory lock).

## Schedules

Five-field cron (`minute hour day month weekday`, e.g. `0 9 * * 1-5` for weekdays at 09:00) in a time zone, or every N
minutes (at least 5). You choose what happens when clocks go forward or back, when the previous run is still going
(skip, run after it, or stop it) and with runs missed while Whombat was off (skip them, or run once to catch up).

## When something didn't happen

- **A new issue started nothing.** Issues already open when the automation was turned on never start it; bots' issues
  only when it counts bots. The poller looks every 10 seconds to 3 minutes.
- **The answer wasn't posted on GitHub.** The automation doesn't hold *Comment on pull requests* for that repository,
  or the key asks and you haven't said yes yet.
- **A run says “Blocked”.** You no longer hold a key the step needs, the automation's own key says no, or the agent may
  not write its branch. The audit log shows the Blocked event.
- **“… finished without new commits on feat/…”** The agent didn't commit (it couldn't reproduce the bug, or make the
  change safely), or the push didn't reach GitHub; what it said is in the thread.
- **It asked before fixing although it was set to fix on its own.** One of the conditions didn't hold; the run's
  *Does a person need to say yes?* step says which.
- **A run waits.** For your approval (the step links to it) or for the agent: check its AI sign-in in Settings.
