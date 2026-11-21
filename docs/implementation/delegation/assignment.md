# Whombat structured delegation — implementation orchestrator prompt

Give this entire file to the lead coding agent. It is an implementation assignment, not a study. The research
behind it is in `~/.cache/wb-tmp/research/2026-09-27-agent-platforms/whombat-vs-hermes-buzz.md`
(section 2, A-1…A-11); this prompt contains everything essential.

---

You are the lead architect and implementation orchestrator for Whombat. Use specialist sub-agents where work is
parallel; own the design, the integration, the commits and the completion yourself.

**Do the implementation. Do not stop after a plan, a spec, a contracts release or a list of TODOs.** Inspect the
real code, decide the open details, build the feature across the repositories, test it, fix what you find, ship it
to the dev instance, and report.

## 1. Goal

People and agents in a burrow can hand work to each other in a way Whombat tracks: who asked, who owns it, what
"done" looks like, how much it may cost, whether it can start at all, what came back. Today an agent can only
@mention another agent (a bounded exchange, `docs/decisions/archive/agent-handoffs.md` AH-01) or start a plan step by
mention (`plan_start_step`, key `tasks.create`, `docs/decisions/work-supervision.md` WS-04). Agents are not even
told which colleagues exist. Buzz, the reference product, has nothing better: its delegation is a mention plus
prompt rules and no loop breaker. Build the structured version on the primitives Whombat already has: plans and
steps, dispatches, activity rows, approvals, the Work view, notifications, the signed audit log.

Working name: **handoffs**. A handoff is a plan step with a brief, an owner, a lane (its own thread), limits and a
typed result. `delegate` creates one; `report_back` closes one.

## 2. What exists (rely on it, do not rediscover it)

Runtime (`~/Code/Whombat`, main at 26fc244 or newer; vendored contracts 0.14.0 under `vendor/whombat-contracts/`,
vendored app 0.7.0 under `vendor/whombat-app/`):

- Mention dispatch and the agent chain cap: `apps/server/src/domain/dispatch.ts` (`MAX_AGENT_CHAIN_MESSAGES = 4`,
  `ownerNotWoken`), `apps/server/src/domain/messages.ts` (agent-authored mentions dispatch).
- Plans: `apps/server/src/commands/plans.ts` (`startPlanStep`: an agent-owned step posts a mention in the plan's
  thread; a person's step goes "In progress"; someone else's personal agent → 403), `apps/server/src/domain/plans.ts`,
  `apps/server/src/domain/plan-follow.ts` (`followPlanWork`, core `projectPlanStep`), `apps/server/src/read/work-overview.ts`.
- MCP tools: `apps/server/src/mcp/tools.ts` (`plan_create`, `plan_read`, `plan_update`, `plan_start_step`, …),
  listing per agent in `apps/server/src/mcp/server.ts` (`mcpToolList`), rate limits in `apps/server/src/mcp/rate-limit.ts`.
- Dispatch context: `apps/server/src/runtime/context.ts` (`DispatchContext`: `principals` is a `PrincipalLite[]`
  with id, kind, name, handle, role, title; `planStep`; `credential.onBehalfOfAccountId`), claims and leases in
  `apps/server/src/runtime/service.ts` (`recordTurn` stores `dispatches.usage` = tokens and cost when the provider
  reports them; `sweepUnrunnable`; provider readiness from runner heartbeats as `host.agents`).
- Prompt builders, two that must agree: `apps/runner/src/prompt.ts` (live) and
  `packages/agent-runtime/src/persona/index.ts` (snapshot-tested). Both use `principals` only to resolve names.
- Activity: `apps/runner/src/activity.ts`, `apps/server/src/runtime/activity.ts`; `ActivityKind` already has `delegate`.
- Notifications with dedup keys (WS-20), the Work view sections and health (WS-18/19), search documents PLAN /
  DECISION / AUTOMATION (WS-21…25).
- Migrations end at `0046_vault`; yours is `0047_delegation`.

Contracts (`~/Code/whombat-contracts`, 0.15.2, decisions `docs/decisions/contracts.md` up to CT-112):
`packages/core/src/domain/plan.ts` (`PlanStep`, `planStepActions`), `packages/core/src/domain/dispatch.ts`
(`DispatchTrigger`), `packages/core/src/domain/work.ts` (`WorkItem`), `packages/core/src/contracts/runner.ts`
(`PrincipalLite`, `PlanStepContext`, `DispatchContext`), `packages/core/src/contracts/mcp.ts` (tool schemas),
`packages/core/src/keys/catalog.ts` (`tasks.create` = "Create tasks for other agents"). Releases are vendored
tarballs: `docs/publishing.md`.

App (`~/Code/whombat-app`, 0.8.2, decisions `docs/decisions/app-managed.md` up to AP-167): web
`apps/web/src/features/{plans,work,cards,messaging,agents}`, Android `apps/mobile/src/screens/{PlanScreen,WorkScreen}.tsx`,
fixtures in the vendored `@whombat/fixtures`.

Appliance (`~/Code/whombat-appliance`, decisions `docs/decisions/integration.md` up to IN-78): harness scenarios
`harness/scenarios/*.scenario.ts` (`n-work` is the template for plans; the next letter is `q`), candidates
`manifest/candidates/` (0.15.3 validated, not promoted), the dev instance runbook `docs/runbooks/dev-instance.md`
(follow the newest "Putting the instance on …" section as the pattern).

Settled decisions that bind you (do not reopen): AH-01 (the cap outside handoffs), WS-01…WS-54, PA-05 (personal
agents are woken only by their owner), SUB-28/SUB-29 (whom a chained turn is for), VT-22 (Vault requester rule),
BP-06 (no private content in signed events), BP-07 (retrieved data is data), BP-C31/BP-C35 (an agent reads only
its audience), KR-01 (an agent asks keys only for itself), `merge.main`/`agents.manage`/`approvals.decide` are
people-only. Note the `AH-` prefix is used by two files; use the fresh prefix `DG-` in `docs/decisions/archive/delegation.md`.

## 3. Requirements

Model and storage

- DG-01 **A handoff is a plan step with a `handoff` object**: `brief` (≤ 2 000 chars), `deliverable` (≤ 500,
  optional), `outputSchema` (a JSON Schema object, ≤ 8 KB, optional), `dueAt` (optional), `budget {tokens?, minutes?}`
  (optional), `delegatedById`, `delegatedAt`, `laneRootId` (the step's thread root), `depth`, `result
  {status: done|blocked|declined, summary ≤ 2 000, data?, messageId, at}` (optional), `declineReason` (optional).
  Extend `PlanStep` additively; existing plans keep working. Choose storage (the `plans.steps` JSON plus indexes, or
  a `handoffs` table) and write the reason down.
- DG-02 **Every handoff has its own lane**: a message posted at top level in the plan's conversation by the
  delegator, mentioning the owner, carrying the brief; its replies are the lane (`threadRootId`). The plan card and
  pane link each step to its lane ("Open lane"). No agent-to-agent DMs, ever: people always see the lane.

Tools and commands

- DG-03 **`delegate`** (agents, key `tasks.create`; the same command serves people from the plan pane as
  `plans.delegate`): input either `planId` or `{conversationId, title}` to create the plan, plus `ownerId` (a team
  agent or a person), `title`, `brief`, `deliverable?`, `outputSchema?`, `dueAt?`, `budget?`, `needsWorkspace?`.
  It creates or extends the plan, posts the lane root, starts the step and returns `{stepId, laneRootId, dispatchId}`.
  The owner's turn is a dispatch with a new trigger `handoff` carrying `DispatchContext.planStep` and
  `DispatchContext.handoff` (brief, deliverable, schema, due, budget, delegator, lane). A person owner gets a
  needs-you notification with the brief and the step goes "In progress" (WS-04).
- DG-04 **`report_back`** (the owner, in a handoff turn; no catalog key, the step is its own): `{stepId, status:
  done|blocked|declined|progress, summary, data?}`. `progress` updates the step note only. `done`/`blocked`/`declined`
  post the report in the lane as the owner, update the step (declined → back to the delegator as blocked with the
  reason), sign `plan.updated` with ids and states only, and wake the delegator when it is an agent with trigger
  `handoff_result` and `DispatchContext.handoffResult` (a person delegator gets a needs-you notification). `data` is
  validated against `outputSchema`: the first mismatch is returned to the agent once as `{status: 'invalid',
  problems}`; a second mismatch posts the summary without data and notes "The report didn't match the requested shape."
  If a handoff turn ends without `report_back`, the runner's final text is posted in the lane and the step stays
  active; the delegator is not woken (no bare acknowledgements, DG-08).
- DG-05 **Where the delegator answers**: its `handoff_result` turn runs in the plan's thread (where the plan card is).
  When the plan came from a message, the prompt tells it to report the human-facing outcome in that message's thread
  (`Plan.source`), and to keep coordination in the lanes.

What agents know and are told

- DG-06 **Teammates in the context**: `DispatchContext.teammates[]` (≤ 40) computed by the server for every
  non-feedback turn: id, kind, name, handle, role, job, status and doing line, `ready` with a `readyReason` when
  false (provider not signed in, credential state, licence lapsed), up to 8 labels of `can` keys that matter for a
  handover (branch write, PR open, tests, web, deploy asks), skill names of its enabled packs, whether it has a
  working directory, and open handoffs it currently owns (count). People appear with name and title. Personal agents
  and system principals never appear. Same-burrow only.
- DG-07 **Prompt**: a "Your teammates" block after the keys section in both builders; then the rules: hand work over
  with `delegate` and a brief that says what done looks like, mention a colleague only for a quick question; when you
  finish work someone handed you, `report_back` in the lane; never post "got it" or "on it", silence is right until
  you have a result, a question or a blocker; in a handoff turn your replies go in the lane; do not hand work back to
  whoever handed it to you unless you decline. Snapshot tests for both builders.
- DG-08 **Handoff lines in the turn prompt**: the brief, deliverable, schema, due date and budget are rendered as
  delimited data (BP-07, like `[[memory …]]`), never as instructions from Whombat.

Limits and safety

- DG-09 **Depth**: a handoff made in an ordinary turn has depth 1; one made inside a handoff turn has the parent's
  depth + 1; depth 3 is refused ("Handoffs go two levels deep at most; ask the person to split the work.").
- DG-10 **No cycles, no pile-ups**: the owner may not be the delegator, any ancestor in the chain, or an agent that
  already owns an open step in the same plan. At most 8 open handoffs per plan and 4 created per turn.
- DG-11 **Budget**: `budget.tokens` defaults from `WHOMBAT_HANDOFF_TOKENS_DEFAULT` (pick a sane default and document
  it), a plan-wide cap from `WHOMBAT_HANDOFF_PLAN_TOKENS`; enforced from `dispatches.usage` before a handoff turn is
  claimed and when it completes; over budget → the step goes blocked "Budget spent" and the delegator is woken once
  (`handoff_result` with status blocked). Providers that report no usage count zero and the prompt says so on the
  step. `budget.minutes` and `dueAt`: a minute sweep (reuse the plans reconcile or the briefing ticker) blocks
  overdue steps "Overdue" with one notification. Managed appliances: the licence gate already covers agent turns.
- DG-12 **Loop breaker inside a lane**: messages between owner and delegator in a lane do not count toward AH-01's
  four-message cap; instead a lane allows at most 12 agent turns per handoff, then the step goes blocked "Too many
  turns" and a person is needed. A person's message in the lane resets that counter. Record this as AH-02 in
  `agent-handoffs.md` with a pointer to DG-12.
- DG-13 **Readiness before handing over**: `delegate` refuses, without creating the step, when the owner is not a
  member of the plan's conversation, is someone else's personal agent, has no ready provider or sign-in, has no
  working directory or enabled repo while `needsWorkspace` is true, or when the licence is lapsed. The answer is
  `{status: 'refused', code, reason}` in the words the teammates block used, so the agent picks someone else or asks
  a person.
- DG-14 **Authority never transfers**: the owner acts under its own keys and approvals; `onBehalfOfAccountId`
  follows the original requester through the chain (SUB-28); Vault rules (VT-22) are unchanged; an approval the owner
  needs links to the step as today. The brief cannot grant, unlock or promise anything, and the prompt says so.
- DG-15 **Audience and privacy**: briefs, reports and results are messages in the lane, visible to the
  conversation's members like any message; signed events carry ids, states and hashes only; `outputSchema` and `data`
  are not indexed for search (the summary text is, through the PLAN document); the owner's reads stay within its
  audience (BP-C31/C35).

Surfaces

- DG-16 **Work view and notifications**: handoff steps show owner, delegator, budget used, due, health; blocked,
  declined and overdue handoffs reach the delegator's person (the plan's creator) as "Needs you" with dedup keys;
  person-owned handoffs are "Needs you" for that person. `work.overview` fields are additive.
- DG-17 **Web**: the plan card's step rows show "Banjo, from Sketch", the brief on expand, the result summary or the
  decline reason, budget and due; the plan pane has "Open lane", Retry (re-delegates the same brief), Reassign (to a
  teammate), Cancel, and "Ask for a report" (posts a nudge in the lane); people create handoffs from the plan pane's
  "Add step" with owner and brief. Follow the nearest mocked pattern (B-05), tokens only, copy in the product's voice;
  compare touched screens at 1440×900 in both themes.
- DG-18 **Android**: `PlanScreen` shows the handoff fields and the result, opens the lane, keeps the existing step
  actions with 44 dp targets; no new editors.
- DG-19 **Appliance**: scenario `q-delegation` (scripted providers: one agent delegates to another, the report comes
  back, states and the Work view are asserted, plus refusal, depth, cycle, budget and lane-cap cases); candidate
  `0.16.0` pinned, validated (gates, every scenario, demo). No NixOS module change is expected; say so if one is needed.
- DG-20 **Docs**: `docs/decisions/archive/delegation.md` (DG-01…, each with its reason, plus the details you decided),
  `agent-handoffs.md` AH-02, ARCHITECTURE.md (Agent runtime, Plans), DECISIONS.md summary row, a short user guide
  `docs/delegation.md` (how to hand work to an agent or a person, what people see, the limits); contracts CT-113+,
  app AP-168+, appliance IN-79+.

## 4. Repositories, versions, numbering

| Repo | Branch | Version / ids |
|---|---|---|
| whombat-contracts | `delegation` | 0.16.0, tag `contracts-v0.16.0`, CT-113+; `pnpm release`; vendor the tarballs into Whombat and whombat-app (`vendor/whombat-contracts/0.16.0`, `SHA256SUMS`, lockfile) |
| Whombat (runtime) | `delegation` | migration `0047_delegation`; `docs/decisions/archive/delegation.md`; ledger `docs/implementation/delegation/` |
| whombat-app | `delegation` | 0.9.0, tag `app-v0.9.0`, AP-168+; `release:dist`; vendor into Whombat `vendor/whombat-app/0.9.0` + `PIN` |
| the appliance | `delegation` | scenario `q-delegation`, candidate `manifest/candidates/0.16.0.json`, IN-79+ |

Use worktrees under `~/Code/.wt/<repo>-delegation`. One writer at a time for contracts, lockfiles and manifests.
Other people and agents work in these checkouts: never reset shared containers (`docker compose down -v` is
forbidden), use free ports and throwaway databases, run `pnpm check` with `TMPDIR=~/.cache/wb-tmp`.

## 5. Method and order

0. Read `CLAUDE.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `docs/decisions/{work-supervision,agent-handoffs,
   bp-memory,vault,connectors,provider-subscriptions}.md` and the files in section 2. Write
   `docs/decisions/archive/delegation.md` first: the requirements above as decisions, with the details you settle (storage,
   defaults, copy, trigger names). Start the ledger (`docs/implementation/delegation/{plan,ledger,verification}.md`)
   and keep it current so the work survives context limits.
1. Contracts 0.16.0: schemas, fixtures for the mock world (a plan with two handoffs, one declined), conformance
   vectors where a Go binding exists, release, tag, vendor.
2. In parallel, on the vendored 0.16.0: the runtime (commands, MCP tools, context, prompt, limits, sweeps, Work view,
   notifications, migration, tests, docs) and the app (web, Android, fixtures, visual check). The appliance scenario
   can be drafted against the fixtures meanwhile.
3. Candidate 0.16.0: pin the merged commits, build, validate, demo.
4. Independent review, two lenses: security (authority transfer, audience, budget bypass, cycles, prompt injection
   through briefs and reports, personal agents, signed-event content) and product (copy, states, the lane pattern in
   busy channels, Android). Fix every confirmed finding and rerun the affected tests.
5. Ship (section 7).

Sub-agents get owned files, inputs, outputs, tests and a completion criterion; they do not merge each other's work
or stop shared services. More than three concurrent agents is acceptable; use judgment about cost. Report progress
to John in percentages at each phase boundary. A sub-agent's success report never replaces an integrated run.

## 6. Verification (all must pass before shipping)

- Core unit tests: the pure decisions (`decideHandoff` for depth, cycles, fan-out, readiness codes;
  `validateHandoffResult` against the schema; the lane counter), snapshot tests of both prompt builders.
- Server integration tests (real Postgres): full lifecycle agent → agent → report → delegator woken; agent → person;
  decline; invalid then valid data; budget spent; overdue; depth 3 refused; cycle refused; personal agent refused;
  non-member refused; not-ready refused with the reason; lane cap; AH-01 still applies outside lanes; signed events
  hold no brief text; search finds the summary but not the schema; Work view and notifications; the migration on a
  database with existing plans.
- Runner tests: teammates block, handoff lines as data, `report_back` fallback when the turn ends without one.
- Whombat: `TMPDIR=~/.cache/wb-tmp pnpm check` and `pnpm test:server`. Contracts: `pnpm check` and the release
  smoke. App: its `pnpm check` and the visual comparison of touched screens in both themes. Appliance: `harness
  validate` on candidate 0.16.0 (gates, all scenarios including `q-delegation`, demo).
- One real handoff between two live agents on dev.whombat.com after deployment (the dev stack runs live agents):
  a plan, a lane, a report, the delegator's summary. Put the links and a screenshot in the ledger.

## 7. Delivery

- Merge each repo's `delegation` branch into `main` with `git merge --no-ff`, check that `HEAD` moved, delete the
  branch, push `main` (and the tags). Commit messages: imperative, one concern each, with the attribution line
  `CLAUDE.md` prescribes.
- Deploy dev: back up first (`~/.cache/wb-tmp/dev-backup-pre-delegation-<timestamp>`), put the managed stack on
  candidate 0.16.0 per `docs/runbooks/dev-instance.md`, and update the monolith unit per `CLAUDE.md` (pull, install
  when packages changed, `systemctl --user restart whombat-dev`, wait for `"ok":true` on
  `http://127.0.0.1:4420/api/v1/health`).
- Production (app.whombat.com, the Hetzner host, `~/Services/whombat`) is not deployed under this assignment.
- Finish with: what changed per repo with commits and versions, where to try it on dev.whombat.com (the burrow, the
  channel, the plan), the evidence, and what was left out and why.

## 8. Out of scope, and do not

- No agent-to-agent DMs, no hidden lanes, no key or approval transfer, no auto-approval, no personal agents as owners
  or delegators, no changes to the keys catalog beyond reusing `tasks.create`.
- Do not build the browser tool, the skills library, new agent roles or cost dashboards here; leave seams (the
  `ready` computation, `dispatches.usage` sums) that they can use.
- Do not edit `docs/design-handoff/TODO.md`, the mocks, or production configuration. Do not run more agents than the
  work needs.
