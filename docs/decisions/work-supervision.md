# Work supervision: shared plans, observed activity, searchable outcomes

Workstream `work-supervision` (2026-09-26). Three improvements on top of existing plans, runs, approvals,
automations, canvases and notifications, with no new project-management system or workflow engine: a person
delegates a request, sees who owns each step, understands actual progress, intervenes, and later retrieves the
decisions and evidence. Buzz (`VISION_ACTIVITY.md`) is the reference for interaction patterns only: one row per
action that updates through its lifecycle, outcome first, loud failures and writes, quiet reads, honest fallbacks.

Contracts: whombat-contracts 0.12.0 (CT-84…CT-88). Settled decisions elsewhere are unchanged; AS-03 (agent status is
Whombat's), TR-01…04 (turn retries), BP-C31/C35 (agent audience), BP-06 (no private bodies in the audit log) and
approval redaction (`approvalForViewer`, `whatHappensOutside`) bind everything below.

## Plans

- **WS-01 A plan is a shared checklist in one conversation, created explicitly.** People (members of the
  conversation) create plans from the product (a message's “Make a plan”, the plan pane) and agents with the
  existing `tasks.create` key (“Hand work to other agents by creating plan steps and mentioning them”, until now
  unused) through `plan_create`. Creating a plan posts its plan card in the thread of the message it came from
  (or top level) and records `source {messageId, threadRootId}`, `createdById`, `createdAt` and the card's
  `messageId`. Creating a plan never starts a step.
- **WS-02 The smallest step state model.** `queued | active | gate | blocked | done | cancelled`
  (`gate` = needs a person, drawn as the mock's warn diamond; `blocked` = can't go on until someone acts, drawn in
  `bad`; `cancelled` = dropped, kept for history, struck through and not counted). `stateLabel` stays the short
  human word and `note` (≤ 280) says why and what's next (“Run #1907 failed. Retry or reassign.”). Progress is
  done ÷ (steps − cancelled). Order is the array order.
- **WS-03 Steps link to the work that carries them out**: `runId`, `approvalId`, `automationRunId`, `dispatchId`
  (the turn that was asked to do it, until it starts a run). A link is set by starting the step, by the agent's
  `start_run` in a turn started for that step (automatic), by an agent's `plan_update` with `link`, or by a person
  linking an existing run / approval / automation run by number. Links are only replaced, never silently dropped:
  the previous link is in the step's signed `plan.updated` event payload.
- **WS-04 Starting work is explicit and reuses dispatch and automations.** `plans.startStep` (people) and
  `plan_start_step` (agents, `tasks.create`):
  - an agent-owned step: the starter posts a message in the plan's thread that @mentions the owner
    (“@Banjo, please take step 2 of “Invoice PDF export”: Build the export endpoint”), so the ordinary mention
    dispatch applies (who may wake whom, personal agents only by their owner, the agent-handoff cap AH-01, one turn
    in flight). The dispatch is linked to the step and carries `DispatchContext.planStep`; a run the agent starts in
    it is linked automatically.
  - an automation (people only): “Run now” of an automation started by hand, with its existing rules; the run is
    linked (`automationRunId`).
  - a person-owned step: it becomes `active` (“In progress”); only the owner or a plan editor marks it done.
- **WS-05 Linked work drives the state; the projection is pure and idempotent** (`projectPlanStep` in
  `@whombat/core/domain`). The server loads the linked object's *current* status (never the event's), projects,
  and writes only when the projection key (`<kind>:<id>:<status>`, kept on the stored step as `followKey`) changed.
  So repeated and out-of-order events and restarts can't corrupt a plan, and a manual change after a projection
  stands until the linked work changes again. A startup reconcile re-follows every open step with a link.
  Precedence: an unfinished run or automation run, else an approval, else a finished run, else the dispatch.

  | linked work | step |
  |---|---|
  | dispatch queued / claimed / running | active “Asked” / “Working” |
  | dispatch done, no run, step still active | gate “Check result” — the agent answered without finishing; a person marks it done or asks again |
  | dispatch failed / cancelled | blocked “Couldn’t start” / “Stopped” |
  | run live | active “In progress” |
  | run paused | blocked “Paused” (resume or take over) |
  | run done | done “Done” |
  | run failed | blocked “Run failed” — never done, never left active |
  | run taken over | active “Taken over”, owner = the person who took over (never done) |
  | approval pending / approved, waiting | gate “Needs a person” / “Approved” |
  | approval executed | done (the approval's own word: “Deployed”, “Done”) |
  | approval declined / execution failed | blocked “Declined” / “Failed” |
  | automation run queued / running / waiting / paused | active “Running” |
  | automation run succeeded | done “Done” |
  | automation run needs review | gate “Needs review” |
  | automation run failed / cancelled / skipped | blocked “Automation failed” / “Stopped” / “Skipped” |

  A step a person or agent set to `done` or `cancelled` by hand isn't moved by later events of the same link.
- **WS-06 Handoff and reassignment make the next owner and action explicit.** Changing a started step's owner
  unlinks its dispatch (not its run history), sets it `queued` with label “Handed off” and note “Next: {name}
  starts it.”; the new owner (a person) gets one needs-you notification. A takeover is not completion (WS-05).
- **WS-07 Editing after work started never loses work.** Steps have stable ids; title, owner, due and order edit
  freely. Removing a step is allowed only while it is `queued`, unlinked and was never started; anything else is
  cancelled instead (the API answers 409 `step_started`). The canvas plan block follows the same rule: a started
  step removed in the canvas is kept (the block is re-synced), a new line in the block is a new queued step.
- **WS-08 Plan canvases.** `plans.createCanvas` / `canvas_create {planId}` create a canvas bound to the plan
  (`canvas.write`, as `create_canvas`), with the plan block, and set `plans.canvas_id` / `canvases.plan_id`. One
  canvas per plan.
- **WS-09 Where plans live in the UI.** The plan card (mock) gains the extra states, a link row under blocked / gate
  steps and “Open plan” next to “Open plan canvas”. “Open plan” opens the **plan pane** (a right pane like the
  thread pane, `?plan=<id>` on the conversation route, `&step=<id>` to focus a step): steps with owner, state, note,
  links to run / approval / automation run, and the step's next actions (Start, Mark done, Retry, Reassign, Cancel);
  add, edit, reorder; create or open the plan canvas. Messages get “Make a plan” in their menu; the plan pane and
  the conversation header's “Plans” list have working empty states on an unseeded burrow. Mobile gets a plan
  screen from the plan card. `LinkRef` gains `plan {planId, in, stepId?}`.
- **WS-10 Visibility.** **Superseded in part by one-person.md OP-S71**: a plan is still visible to its conversation's members; in the person's turns the agent reads plans in any room it is in, with no audience rule. A plan is visible to the members of its conversation (REST, realtime `plan.updated` with
  `audienceConversationId`, search). Agents: their dispatch conversation's audience (BP-C35) for plans of another
  room. Audit: `plan.created` / `plan.updated` signed; text names the plan only in channels and branch rooms (a DM's
  plan title stays out of the burrow-wide log), payloads hold ids and old/new links, never notes' bodies.

## Activity

- **WS-11 Activity is observed, not declared.** The runner turns the provider's own events into activity reports:
  the neutral turn contract (`@whombat/agent-runtime`) now carries the provider's tool-call id, the result's outcome
  (ok, exit code, error kind) and permission decisions. Claude: `tool_use.id` / `tool_result.tool_use_id`,
  `is_error`, `can_use_tool` answers. Codex: `item.id`, `status`, `exitCode`, declined approvals. ACP: `toolCallId`,
  `status`, `kind`, `locations`, permission requests. The scripted provider emits the same shape for its real MCP
  calls. Agents' `run_step` / `run_log` / `set_status` stay and still work; activity doesn't replace them.
- **WS-12 One row per action, updated through its lifecycle.** Key = `<attempt>:<provider tool id>` per dispatch
  (a provider without ids gets the runner's sequence number). Reports carry a per-dispatch `seq`; the server
  upserts by `(dispatch, key)` and ignores a report whose `seq` isn't newer than the row's, so duplicates and
  out-of-order batches are harmless. Reports ride on the existing lease-fenced `progress` beat (`ProgressBody.
  activity`), flushed early (≈ 300 ms) when there is something new; a runner that lost its lease changes nothing.
- **WS-13 Row states and copy.** `running | waiting | done | failed | interrupted`. Kinds: `read`, `edit`,
  `command`, `search`, `web`, `whombat` (Whombat's MCP tools), `tool` (other MCP / pack / connector tools),
  `delegate` (a subagent), `permission`. Titles are action + object + outcome, from facts the provider gave:
  “Reading invoice.ts” → “Read invoice.ts”; “Editing invoice.ts” → “Edited invoice.ts” / “Couldn’t edit
  invoice.ts”; “Running pnpm test” → “Ran pnpm test” / “Command failed · exit 1”; a Whombat tool that answered
  `pending_approval` → waiting “Waiting for approval” (linked; it follows the approval's state when read); `blocked`
  → failed “Blocked · needs {key}”; a denied permission → failed “Not allowed: {tool}”. Nothing is inferred from
  output text: no diff counts, test counts or success unless the provider reported them.
  Approval transitions also advance the linked rows' revisions and publish their derived status in the same commit,
  with strictly increasing update times for equal-sequence reports (`run-reconciliation.md` RCN-05).
- **WS-14 Evidence is expandable, redacted and bounded.** A row may carry `evidence {input, output}` (input ≤ 1 KB,
  the tail of output ≤ 4 KB), after the runner's redactor (tokens, keys, bearer headers, `*_TOKEN=`-style
  assignments, private-key blocks, URL credentials) and path shortening (workdir-relative, `~`). Never: thinking,
  reasoning or assistant text, connector tool inputs/outputs (mail, calendar, files: only “Searched mail”), file
  contents of reads, a feedback assessment's anything beyond kind and state. Activity is never signed into the
  audit log; it is runtime telemetry written by the server's runtime service in one transaction with its outbox
  frame (`activity.updated`).
- **WS-15 Interrupted, not invented.** When a dispatch is requeued, finalized, lost its lease or the server
  restarts, rows still `running` for that attempt become `interrupted` (“Interrupted · the turn stopped” / “·
  restarted”), never done. A provider that reports no tool events (or an old runner) produces no rows; the UI then
  says “This agent’s provider doesn’t report its steps.” instead of an empty success.
- **WS-16 Visibility.** Activity is visible to the members of the dispatch's conversation (a personal agent's DM:
  its owner). Realtime on `conv:<id>` and `run:<id>`; REST `activity.list` by run, dispatch or conversation.
- **WS-17 Noise.** Consecutive finished reads/searches of one turn collapse into one group row (“Read 4 files”),
  failures, edits, commands, permissions and Whombat actions stay single and are marked important
  (`collapseActivity`, pure, shared by web and mobile). Repeated updates of one row never add rows.

## Supervision

- **WS-18 One Work view from existing state**, no new source of truth: `work.overview` builds, for the viewer,
  sections **Needs you** (approvals they can decide, plan steps at `gate` they own or created, agents' open
  questions to them, automation runs needing review), **Running** (claimed/running dispatches and live runs, with
  their latest activity row), **Queued** (queued dispatches, with why: waiting for a runner / provider not ready /
  retry at), **Blocked** (blocked plan steps, paused runs, runs waiting on an approval), **Failed** (failed runs,
  dispatches and automation runs, last 24 h) and **Done** (last 24 h). Every item has its link and next actions
  from the existing mechanisms: approve/decline, pause/resume/take over, retry/reassign a step, open. Web:
  `/:burrow/work` (the sidebar's “Needs you” row opens it); mobile: the Inbox's Work section and a Work screen.
- **WS-19 Heartbeat, waiting and progress are different things.** An item shows `health`: `progressing` (an
  activity row or run log line in the last 2 minutes), `quiet` (the runner's heartbeat is current but nothing new
  — “Working quietly · last step 6 min ago”, never called failed), `waiting` (an approval or question), or
  `stalled` (no heartbeat for longer than the lease: “No word from the runner for 3 min”; the lease sweep then
  retries or fails it as today). Clients refetch the overview on reconnect and on the relevant realtime events;
  `dispatch.updated` (conv topic) exposes a turn's queued / running / done / failed transitions.
- **WS-20 Notifications don't repeat.** Notifications gain an optional dedup key (unique per recipient): a step
  handed to someone, a step that became blocked or needs a person, notify once per (step, projection key).

## Search

- **WS-21 New document types in the existing Postgres index**: `PLAN` (title, steps with owner names, states and
  notes; link to the plan pane), `DECISION` (an approval: title, question, the outside-safe “what happens”
  (`whatHappensOutside`, never pack-tool arguments), state, who decided and when, the decline note; link opens the
  approval), `AUTOMATION` (an automation run's outcome: automation name, run number, status, the step names and
  states, its error; never step inputs/outputs; link to the run page). Filters `plans`, `decisions`, `automations`;
  tags `PLAN`, `DECISION`, `AUTOMATION`.
- **WS-22 Authorization stays at retrieval.** **Superseded in part by one-person.md OP-S71**: results are still re-checked against the viewer's rooms; the agent's audience and the target room's other members no longer count. Documents keep their conversation; results are re-checked per viewer:
  membership (as today), plus for `DECISION` `approvalVisible` (private approvals of personal agents), plus the
  agent's audience (BP-C31). Automation step content never enters the index, so step redaction can't be bypassed.
  Feedback-assessment approvals and messages index no assessment content. Receipts and `post_answer` re-check the
  asker, and posting an answer re-checks every cited document against the target room (members of the target who
  couldn't read a source make the post refuse).
- **WS-23 Duplicates.** A message whose card is a plan or an approval is not indexed by itself: its text is folded
  into the `PLAN` / `DECISION` document (replies stay messages). Automation notices stay messages (they are the
  thread's history) and the `AUTOMATION` document is the outcome.
- **WS-24 Kept current in the write transaction**, not a best-effort hook: plan, approval and automation-run
  changes upsert their document inside the commit; removing access needs nothing (retrieval re-checks). An
  idempotent backfill (`0045_search_work`, class `backfill`, resumable by id) indexes existing plans, approvals and
  finished automation runs and removes the card messages' now-duplicate documents.
- **WS-25 Cited answers.** Agent `search` and answer mode get the new types with the same audience; receipts carry
  the result's link (approval, plan step, automation run), so a receipt opens the exact decision, step or result.

## Compatibility

- **WS-26 Ships together.** Contracts 0.12.0 widens closed unions (step states, link types, search types, realtime
  events, `LinkRef`), so runtime, web and mobile move together (CT-83 precedent); older runners ignore the new
  optional fields and the server accepts progress without `activity`. Historical plans get the new optional fields'
  defaults; historical runs, approvals and automation runs are indexed by the backfill; no provider event format
  change is needed for old runs (they simply have no activity rows).

## Implementation decisions (runtime, plans and search)

- **WS-27 Migrations.** Plans and notifications: `0042_plans_work` (expand: `plans.created_by_id`, `created_at`,
  `source_message_id`, `source_thread_root_id`, `message_id`; `dispatches.plan_id`, `plan_step_id`;
  `notifications.dedup_key` unique per recipient where set; a GIN `jsonb_path_ops` index on `plans.steps` so
  following linked work finds its plans). Search: `0044_search_work` (backfill `search_work`: adds
  `search_documents.status`; WS-24's “0045” is this one, 0043 is the activity workstream's). The backfill writes
  plain SQL with text casts, since the pool it runs on may or may not carry drizzle's type serializers.
- **WS-28 Server-only step bookkeeping.** The stored step JSON carries `followKey` (the projection key last applied,
  WS-05) and `startedAt` (first started, linked or marked in progress). Neither leaves the server (`loadPlans`
  parses them away). A step with either is never removed (`stepRemovable`, also fed to `mergePlanEdits`), so a
  handed-off step that is `queued` again is still cancelled, not removed.
- **WS-29 Who signs what.** A person's or agent's change signs `plan.updated` (`plan.created`) as them, with text
  “Made the plan “…”” / “Updated the plan “…”” in channels and branch rooms and “Made a plan” / “Updated a plan”
  in a DM. Following linked work, linking a turn or run, and canvas block syncs are hidden (`text: null`), signed by
  whoever's work moved the step: the command's actor, else the run's agent, the approval's requester, the
  automation's principal or the dispatch's agent (the startup reconcile uses the same rule). The payload holds ids,
  states, owners and old/new links (`[old, new]`), `added` / `removed` / `reordered`, and `title: true` / `note:
  true` flags — never titles or notes.
- **WS-30 Starting a step.** An agent owner is asked with “@Banjo, please take step 2 of “Invoice PDF export”:
  Build the export endpoint” (the starter's extra words after a blank line), explicitly mentioning only the owner,
  in the plan's source thread, else under its card. The step says active “Asked” in the same commit; when the
  mention wakes nobody (the agent-handoff cap, the owner can't be woken there) it becomes blocked “Couldn’t start”
  with a note. Starting replaces the step's links (the previous ones are in the signed payload). An active step
  whose turn, run or automation run is still going answers 409; a blocked step or one at a gate can be started
  again (Retry). The owner must be in the room; someone else's personal agent can't be handed work (403). A queued
  turn carries at most one plan step: a mention for another step doesn't coalesce into it.
- **WS-31 Links by number** (`link` in `plans.updateStep` / `plan_update`): the run, approval or automation run must
  be in this burrow and its room must include every member of the plan's room (or be the plan's room), so a plan
  never shows the state of work some of its readers can't open; a personal agent's private approval only in its
  own DM. Linking marks the step started and follows the link at once.
- **WS-32 Needs-you notifications** (WS-20 keys): a handoff `plan-step:<step>:handoff:<owner>:<followKey>` to the new
  person owner; a step that became blocked or needs a person `plan-step:<step>:<state>:<followKey|label>` to the
  plan's creator and the step's person owner. Never the person who made the change, only members of the plan's
  room. A plan's creation notifies nobody (the card is in the room).
- **WS-33 Search pills and labels** are stored with the document (`search_documents.status`, written at index time,
  nothing computed at read): PLAN “2 OF 4 DONE” (tone bad when a step is blocked, warn when one needs a person, ok
  when all are done), DECISION “WAITING FOR A PERSON” (warn), “APPROVED BY MARA” (ok), the executed word
  (“DEPLOYED”, ok), “DECLINED” / “FAILED” (bad), AUTOMATION the run's status (“SUCCEEDED”, “FAILED”, “NEEDS
  REVIEW”, “STOPPED”…). `where`: “Plan · #billing-v2”, “Approval #12 · #billing-v2”, “Automation run #31 · Nightly
  check”. AUTOMATION documents exist for non-test runs once they started (updated on every status change; the
  backfill takes finished ones). A Feedback handoff approval's document is its title, question and decision only.
  The decline note comes from the signed decline event, never for a private approval.
- **WS-34 Retrieval of decisions.** **Superseded in part by one-person.md OP-S71**: a DECISION result still needs the room's membership; the asker and audience rule (`within`) goes. A DECISION result needs the conversation's membership (as every result) and
  `approvalVisible` for the viewer, and every principal the results are for (`within`: the asker, the dispatch's
  audience) must pass the private-approval rule. An agent with “Search messages, canvases and runs” doesn't reach
  decisions of rooms it isn't in.
- **WS-35 Posting an answer** **Superseded in part by one-person.md OP-S71**: posting an answer is still the asker's own and checks only that the cited sources are still the poster's. (“Post to #…”) is the asker's own (others get 404), and refuses (403) when any cited
  document is no longer readable by the poster or isn't readable by every member of the target room (their
  membership of its conversation, and a private decision's rule).
- **WS-36 Plan canvases.** `plans.create {canvas: true}` is for people; agents use `canvas_create {planId}` (its own
  `canvas.write` key). A plan canvas's first text is `# {plan title}`, the agent's Markdown, then `## Steps` and the
  plan block; its title is “{plan title} · plan” unless given. A second request returns the plan's canvas.
- **WS-37 The plan card's message** says “Here’s the plan.” (the mock's words; the card shows the rest). A
  message's text is empty only with files, so the card isn't sent bare.

## Implementation decisions: activity and the Work view (branch `ws-activity`)

Numbered from WS-40 so they don't collide with the plans / search implementation's own additions.

- **WS-40 Only denials make permission rows.** The neutral turn contract carries every answer (`permission` events:
  Claude `can_use_tool`, ACP `session/request_permission`, Codex approval requests, always declined under approval
  policy `never`), but an allowed call shows as its own row. A denial takes the action's row (same key, when the
  provider named the call) and reads “Not allowed: {tool}” (the host for a sandbox network request); a later error
  result of the same call doesn't overwrite it. ACP's fake `tool_call{name:'permission'}` is gone.
- **WS-41 What evidence each kind keeps.** Commands: the command (≤ 1 KB) and the redacted tail of their output
  (≤ 4 KB). Reads and searches: what was read or searched for, never the output (file contents). Edits: the paths,
  output only when the edit failed (the provider's reason). Web: the URL or query. Whombat, pack, connector and other
  MCP tools and subagents: no object and no evidence — their arguments and results may belong to another room
  (SEC-PACK-ARGS) or to the owner's services. A Feedback assessment: kind and state only, enforced by the runner and
  again by the server. Connector tools are kind `tool`, named `<service>.<verb>` (“Used mail.search”); core 0.12's
  `describeActivity` has no “Searched mail” copy, so that wording waits for a contracts change.
- **WS-42 Provider bookkeeping and subagents.** The provider's own to-do list and plan mode (`TodoWrite`,
  `ExitPlanMode`, `update_plan`) make no rows. A Claude subagent's (`parent_tool_use_id`) calls are rows of their
  own (with their parent in the turn events); its text never is. Codex's `collabAgentToolCall` is a `delegate` row;
  items of the subagent's own thread aren't followed.
- **WS-43 The server's clock.** `startedAt`, `updatedAt` and `finishedAt` are the server's time when it took the
  report; the report's `at` is the runner's and only informational, so a skewed runner clock can't make a turn look
  progressing or stalled.
- **WS-44 Interrupted only what was running.** Requeue, finalize, the lease sweep and boot interrupt rows still
  `running` (and a `waiting` row without an approval); a row waiting on an approval follows the approval when read
  (pending → “approval #12”, approved → “approval #12 · approved”, executed → done, declined or failed execution →
  failed). Turns ended outside `finalize` (a take over, an automation or assessment cancel) are caught by the sweep
  (“the turn stopped”); at boot the same reconcile says “restarted”. An interrupted row never changes again.
- **WS-45 `activity.list` paging.** The cursor is the row's `rev`, a sequence renewed on every write, oldest change
  first, so a client catching up sees new and updated rows alike. Run scope: rows on the run plus the rows of the
  turns that started or controlled it; conversation scope: its 20 turns with the newest activity. Always filtered to
  the viewer's rooms. A turn or conversation the viewer can't see answers 404 (not revealing it exists); a run keeps
  `readableRun`'s 403. `reported` is false when none of the turns in scope has a row.
- **WS-46 `dispatch.updated` at every state write**: enqueue (mentions, automation steps, assessments), claim, the
  first beat (running), finalize (including a requeue → queued), run-control cancels at claim, take over, automation
  and assessment cancels. `reason` is a short fixed phrase from the error code (“The runner stopped”, “Taken over”),
  never the raw error.
- **WS-47 Work view choices.** Only the viewer's rooms (an approver outside the room keeps the inbox's approval
  notice, not a Work item). Needs you: pending approvals they can decide; `gate` steps they own or whose plan they
  made (the author is read with `to_jsonb(plans)->>'created_by_id'`, so the view works with or without the plans
  column); agents' unanswered questions (AS-03) in their rooms from the last 7 days, `ownerId` the viewer when the
  question mentions them; automation runs needing review. Blocked: every blocked step in their rooms, paused runs,
  live runs whose latest important row waits on an approval. A turn on a run folds into the run's item (a live run
  whose turn is queued shows as queued). Done turns count only when they reported activity (every chat reply would
  flood it). Queued says why in this order: retry soon, on hold (maintenance / licence), no runner, provider not
  ready, after the agent's current turn here, else waiting for a runner. Caps: 60 rows per source, 25 items per
  section, `counts` before the cut. Step actions come from `planStepActions` for people in the room; `cancel` stays in
  the plan pane.
- **WS-48 Migration position.** `0043_activity` (expand; `activities`, `runs_dispatch_idx`) sits between `0042_plans_work` and
  `0044_search_work` (journal idx 42, 43, 44): readers/writers `0042_plans_work`; `0044`'s floors
  stay `0042_plans_work` (both are additive) and its snapshot includes `activities`.
## Integration decisions (merge of both halves, end-to-end test)

- **WS-49 An approval asked for in a step's turn gates that step.** Like a run (WS-03), an approval the agent requests
  with `request_approval` in a turn handed a plan step is linked to the step automatically (only while the step is
  still that turn's), and the step follows it at once (“Needs a person”). Agents without `tasks.create` (an
  operator) can thus carry a step through an approval without editing the plan.
- **WS-50 Asking is waiting.** `request_approval` answers `ok` with the request it made; the runner's row for it is
  `waiting` “Waiting for approval” with the approval, exactly like a keyed tool that answered `pending_approval`.
- **WS-51 One decision, one Work item.** A plan step at a gate whose approval is already the viewer's Needs-you item
  is not listed a second time; a working turn's detail is only what its activity adds (the health line already says
  “No word from the runner yet” / “Working quietly …”).
- **WS-52 Connector tools in plain words.** The personal assistant's connector tools read “Searched mail”, “Sent an
  email”, “Checked the calendar” (core `describeActivity` since contracts 0.12.1, CT-89), never what was searched or sent.
- **WS-53 Whoever started a step checks its result.** A step at a gate is in the Needs-you of its owner, the plan's
  maker, and the person whose message handed the step out (the author of its turn's trigger), so “Check result” after
  an agent answered without finishing reaches the one who delegated it. Approval items say what they wait for (the
  inbox's sentence), not the question again.
- **WS-54 Bookkeeping is routine.** With contracts 0.12.1 a run's `run_step` / `run_log` / `run_files` /
  `set_status` rows (and reads of what the agent can already see) fold like reads; the server now takes all copy,
  including the connector tools' plain words (WS-52), from core.
- **WS-55 A step waiting for the person's word has “Go ahead”** (2026-11-01, John: a plan step “Switch lumio.example.net …
  (after John's go)” showed “Needs a person” with nothing to press). A gate step with no approval, run or automation
  run to decide it (core `stepGoesAhead`) offers `retry` first, labelled “Go ahead” on the web card in the thread, in
  the plan pane, on the phone's plan screen and in Needs you; it is `plan.start_step`, whose message in the plan's
  thread then tells the agent to go ahead with that step. The action keeps its `retry` / `retry_step` name, so apps
  that don't know the label still work. Needs you also lists a gate step of a plan made from the person's own request.
- **WS-56 A plan shows buttons only where the person is needed** (2026-11-01, John: a plan Dusty was carrying out showed
  Start, Mark done and Cancel on every step on the iPhone). Core `planStepControls`: a step at a gate or blocked keeps
  its buttons (Go ahead or Open work; Retry and Open work), a step under way keeps Open work, and the rest — Start,
  Mark done, Cancel — moves to the step's ⋯ menu, on the phone's plan screen (iOS's own menu, a sheet elsewhere) and in
  the web plan pane. A plan the agent is carrying out reads as its progress; Start would have queued a second turn for
  a step the agent was already getting to.
