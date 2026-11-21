# Workstream: runtime-server (runner protocol, MCP server, runner, scripted agents, demo)

TODO 5.6, 5.7 (scripted stub + adapter wiring), 8.2, 8.3 and 9.2 (the demo executor path). ARCHITECTURE.md
("Agent runtime"), DECISIONS.md, REFERENCE_NOTES.md §6 and `core-contracts.md` / `server-core.md` still apply;
this file records what they left open.

## Layout

```
apps/server/src/
  runtime/   service.ts   RunnerRuntime: claim / lease / progress / complete / heartbeat / sweep
             context.ts   DispatchContext builder (persona, window, thread, principals, run, search, workspace, facts, token)
             routes.ts    /internal/runner/* (runner token)          git.ts  git credentials, FakeGitHost
  mcp/       server.ts    /mcp (streamable HTTP)  tools.ts  tool → command  rate-limit.ts  token buckets
  commands/  agent-runs.ts  start_run … finish_run   agent-tools.ts  cards, status, answers, actions, PRs, pushes, canvas, search
  domain/plan-follow.ts   plan steps follow runs and reviews
  demo/      director.ts  DemoDirector (play / rewind / after-run world)   routes.ts  /internal/demo/*
apps/runner/src/  api.ts  runner.ts (claim loop)  turn.ts (TurnEvent mapping)  prompt.ts  registry.ts  workspace.ts
packages/agent-runtime/src/scripted/  provider.ts  storyline.ts  mcp.ts (client)
```

## Runner protocol (`/internal/runner/*`)

- **Tokens**: `Authorization: Bearer <RUNNER_TOKEN>`; `RUNNER_TOKEN` may list several tokens (comma-separated, one
  per runner). Outside production an unset token means `dev-runner-token`; production refuses without one.
  Compared in constant time. Agent tokens never work here.
- **Claim** long-polls up to `waitMs` (≤ 30 s): it re-checks every 500 ms and wakes at once when a dispatch is
  queued (the dispatch's "thinking" frame). A runner that hangs up stops the wait before anything is leased.
  Claims are serialized by one advisory lock, so **the in-flight invariant cannot race**: the candidate is the
  oldest queued dispatch past its `not_before`, whose agent's provider is in the claim's `providers`, and whose
  agent has no `claimed`/`running` dispatch in the same conversation. Run-control dispatches for a run that is
  no longer live (paused, taken over, finished meanwhile) are cancelled at claim (`error: run_<status>`).
- The claim leases the dispatch (`claimed`, 60 s lease, `attempts + 1`), inherits the run's previous provider
  session for run control, and returns the `DispatchContext` with a fresh agent token (`issueDispatchToken`).
- **Providers in the claim**: in scripted mode the runner claims `claude`, `codex` and `scripted` (it runs every
  agent scripted — `resolveProvider`); live it claims `scripted` plus the live providers that are available.
- **Coalescing** keeps server-core's rule (one queued dispatch per agent, conversation and mode) and adds the
  in-flight invariant above: a mention during a turn queues exactly one follow-up, claimed when the turn ends.
  Its window carries everything since; the prompt tells the agent "N new messages … answer them together".
- **Progress** renews the lease, marks the dispatch `running`, stores the provider session and answers
  `{cancel, reason}`: `paused` (its run was paused), `taken_over` (run taken over / dispatch cancelled by take
  over), `cancelled`. "{name} is thinking" is refreshed only for reply-mode turns that have not posted yet
  (or act again after posting, working-signal.md WG-01); everything else clears it (runs and answers never show it).
- **Complete**: `done` and `cancelled` are final. **`failed` is retried once**: the dispatch is requeued with a
  10 s `not_before`; a second failure is final. `attempts` counts claims (`maxAttempts` 2). On the final
  failure the dispatch's live runs stop as failed (signed by the agent: "Stopped run #N: Stopped after an
  error.") and the agent posts a quiet note where it was asked (in the thread when it was a reply, no mentions,
  no follow-up work): "I couldn’t finish this. Something went wrong on my side, so I stopped. Ask me again to
  retry." Answer-mode turns post no note; their answer turns `failed` (or `none` when a turn ended without
  answering), so the search screen never waits forever.
- The runner cannot say whether a failure is retryable (`CompleteBody` has no flag and the contract stays as
  is), so the **server owns the retry policy**. `complete {outcome: failed, error: RUNNER_SHUTDOWN}` (a runner
  shutting down) requeues at once without counting an attempt.
- **Heartbeat** is runner liveness: it renews the leases of the listed dispatches the runner still holds and
  answers which to drop (unknown, finished, someone else's, or with a stop reason). The runner then asks
  progress for the reason before stopping.
- **Leases**: once a runner has connected, a sweep every 5 s treats expired leases (runner gone) as a failure
  under the same retry rule.
- Dispatch bookkeeping is operational state and is not signed (`pipeline.transactAccount`, like issuing agent
  tokens). Everything an agent *does* is a signed command.
- **Git credentials**: 501 `not_implemented` until a git host is configured. `WHOMBAT_FAKE_GITHUB=1` (and tests)
  use `FakeGitHost`; the GitHub phase plugs RealGitHub into `services.runtime.gitHost`. Fetch needs a switched-on
  repo; push is a keys decision (`runtime.authorize_git`, branch key via `branchWriteKey`): 403 Blocked with a
  signed Blocked event for main, 202 approval for shared branches, a token for `feat/*`.

## The Whombat MCP server (`/mcp`)

- Streamable HTTP, **stateless**: one SDK `Server` + transport per request, JSON responses; POST only (GET /
  DELETE answer 405). Bearer = the per-dispatch agent token, verified on every request (401 otherwise).
- The low-level `Server` (not `McpServer`) so the tool list is exactly core's: names, titles, descriptions,
  `inputJsonSchema()`, `readOnlyHint`. No `outputSchema` (outputs are unions, see core-contracts.md); the commit
  outcome is `structuredContent` (and JSON text). Errors are `isError` results with
  `{error: {code, message, fields?}}` using the REST error codes (`forbidden`, `conflict`, `validation_failed`,
  `rate_limited` …). Outside production every result is validated against core's output schema.
- **Mapping** (each tool is the command a person's click runs): `post_message`/`reply_in_thread` → `send_message`;
  `post_card` → `post_card`; `search` → `agent_search` (a read, but keyed, so a blocked attempt is logged);
  `start_run`…`finish_run` → the run commands; `request_approval` → `request_approval`; `perform_action` →
  `perform_action`; `open_pull_request` → `open_pr`; `review_pull_request` → `review_pr`; `merge_pull_request` →
  `merge_pr` (agents are always blocked: `merge.main` is people-only and `mergeBlock` refuses agents);
  `canvas_edit` → `edit_canvas`; `post_answer` → `deliver_answer`; `set_status` → `set_agent_status`.
  `read_conversation` and `canvas_read` are membership-checked reads.
- **ON BEHALF OF** for everything a dispatch does: whoever asked and where — "Hazel in #billing-v2",
  "Mara in a DM", "Mara in Search" (the person behind the trigger message, the run's asker, or the search asker).
- **Rate limits** (REFERENCE_NOTES §5): token buckets per agent (burst 240, 4/s) and per dispatch (burst 120,
  2/s); a call takes from both or neither and is refused with `rate_limited` + `retryAfter` + `scope`.
- `perform_action`: allowed → the action runs now (`create_channel` and `merge_pr` run their own commands, others
  the approvals engine's executor for the type) and logs e.g. "Refunded €24,00 on account 3310"; `ask` → an
  approval that re-runs `perform_action` once approved and every condition is met.
- `open_pull_request` works without GitHub until the adapter lands: a PR row, a placeholder head sha (the first
  mirrored push replaces it), a branch room with the agent and the people of the dispatch's conversation, and
  "Opened PR #483 · {title}".
- `canvas_edit` edits the canvas Markdown while no Y.Doc exists (the collaboration phase seeds its document from
  it) and answers `not_implemented` once one does, until TODO 11.1 edits the Y.Doc.

## Agent runs (TODO 8.2)

- Only the run's own agent writes to it, **and only while it is live**: paused, taken-over and finished runs
  answer 409 to agent writes. Pause and Take over therefore take effect at the server immediately, before the
  runner has stopped the turn.
- Signed events: "Started a run to {title}" and "Ran the billing test suite. 41 of 41 passed." (the active step
  "Run …" becomes "Ran …"; otherwise "Ran the tests") are shown with KEY USED; steps, log lines, files and a
  normal finish are hidden internals; a failed finish shows "Stopped run #N: {summary}".
- Progress = done steps + half the active one, never backwards while live, 100 when done. Activity is the latest
  log line (the card's "Now: …"); the summary shows once done.
- Realtime: every change publishes `run.updated` on `run:` and, member-gated, on `burrow:` (run card, sidebar);
  log lines publish `run.log` on `run:`.
- Plan steps follow: a step with the run's `runId` → "Done" when it finishes; a reviewer approving a PR → the
  reviewer's active step in a plan that tracks a run on that PR → "Approved" (hook in `review_pr`). Approval
  steps keep following the approvals engine.
- `record_push` is the GitHub mirror's command (signed by whoever pushed, under the branch key): "Pushed 7be20f
  to feat/invoice-pdf", head sha and commit list updated, approvals re-evaluated.

## Pause, Resume and Take over (TODO 8.3)

Buzz (REFERENCE_NOTES §6): cancellation is handled on every path, the process group dies with the turn, and a
supervisor outside the turn loop decides; a paused turn resumes on its session.

- **Pause** (a person on the run page → `POST /runs/:n/pause`): the run goes `paused` ("Paused Banjo’s run #1907").
  Agent writes to it stop at once (409). The runner learns on its next progress (≤ 2 s) or heartbeat, aborts the
  provider turn (live providers kill the whole process group) and completes `cancelled` with the provider session;
  the dispatch keeps `cancel_reason: paused`. The thinking indicator clears.
- **Resume** (`POST /runs/:n/resume`): the run goes `live` and a run-control dispatch is queued; its claim carries
  the previous session (`resumeSessionId`), so the provider continues the same session. The scripted Banjo picks up
  after the last log line it played — no line twice.
- **Take over** (people only, `POST /runs/:n/take-over`): the run goes `taken_over` ("Took over Banjo’s run #1907 on
  feat/invoice-pdf"), its dispatches are cancelled, the turn stops with reason `taken_over`, agent writes to the run
  are refused and run-control for it is cancelled at claim. The person gets the branch (the response carries the
  `git switch` instructions). The agent is not asked to do anything further.
- **Runner shutdown**: every turn is aborted and handed back to the queue (`RUNNER_SHUTDOWN`); another runner (or the
  same one restarted) continues it — the scripted run from its last line.
- The web run page calls the existing REST endpoints (`api.runs.pause / resume / takeOver`); the page itself is the
  web workstream's.

## Runner (`apps/runner`)

- Claim loop up to `RUNNER_CONCURRENCY` (4) turns; claim errors back off 0.5 → 10 s; heartbeat every 10 s; progress
  every 2 s per turn. SIGINT / SIGTERM stop claiming, abort every turn and wait (10 s) before exiting.
- **TurnInput**: the persona system prompt (name, role, job, right now, keys by tier with their mock labels,
  channels, burrow facts, how to work through MCP: pending_approval / blocked, runs, receipts, never merge), the
  prompt (conversation, window or thread with times and ids, what is new — coalesced mentions — and the mode's
  task: answer with `post_answer`, resume a run), the MCP url + agent token, `cwd`, `sandbox` (`workspace-write`
  only when the keys engine allows writing the workspace branch), `network` (only with "Browse the web"), `model`
  and `resumeSessionId`.
- `cwd`: chat turns get a scratch dir that is removed afterwards; live coding turns get
  `<WHOMBAT_WORKSPACES>/<burrow>/<repo>/<branch>`, checked out with the dispatch's git credentials (token through
  the environment, never argv); while credentials answer 501 the directory is prepared empty.
- The turn's final text is posted through MCP (in the thread when triggered in one) only when the agent did not post
  itself (`post_message`, `reply_in_thread`, `post_card`, `post_answer`).
- **Registry**: the ScriptedProvider always; with `WHOMBAT_AGENTS=live`, `ClaudeProvider` and `CodexProvider` are
  looked up by export name in `@whombat/agent-runtime` and constructed without arguments, joining when
  `available()` passes. `apps/runner/src/registry.ts` (`LIVE_PROVIDERS`) is the one place to finish that wiring
  (constructor options, binary paths) once the providers land.
- `pnpm dev` starts the runner with the server and web (scripted by default).

## ScriptedProvider (`packages/agent-runtime/src/scripted`)

| dispatch | behaviour (all through MCP with the agent token) |
|---|---|
| mention / DM | thinks ~1.6 s (`thinking` events), final text “On it. I’ll post back here when I have something worth reading.” — the runner posts it |
| declined approval | final text “Understood. I’ll hold off.” (new copy) |
| search (answer mode) | `post_answer`: the mock answer with receipts [1][2][3] (a thread, a patch and a run about rounding) when the results carry them, else a short answer citing the top results; no results → no answer (`none`) |
| run control, run #1907 on feat/invoice-pdf | plays the LIVE timeline from the last line played: per 2.6 s tick `run_tests` 41/41 while “Run the billing test suite” is active, `run_step`s, `run_files` (the card's diff grows +214 −12 → +250 −20), `run_log`; then posts “Pushed 7be20f. Rounding happens before formatting now, and there’s a test for €0,005.” in the branch room, `finish_run` (“Pushed 7be20f and asked Hazel to re-review.”) and `set_status` idle |
| run control, other runs | marks the remaining steps done and finishes |
| a reviewer woken in a branch room by a push | `review_pull_request` approve, `post_card` “Approved. Rounding order is right.” + pill “Approved · PR #482”, `set_status` idle |

Session ids are `scripted:<dispatch>`; a resumed turn keeps the session it was given.

## Demo storyline (DECISIONS B-01, TODO 9.2 demo path)

- **Who plays what**: the agents' parts are the ScriptedProvider in the runner (above). The server's `DemoDirector`
  plays the rest of the world through the same commands: it queues Banjo's run-control dispatch; when run #1907
  finishes it is the GitHub mirror and CI until the GitHub phase — `record_push` of 7be20f7 signed by Banjo under his
  branch key (ON BEHALF OF "Hazel’s review on PR #482"), `record_checks` green on it (signed by Dusty, who posts
  checks in the seed), and a dispatch for Hazel in the branch room triggered by Banjo's push note ("asked Hazel to
  re-review"). Hazel's approval re-evaluates Dusty's approval; approved in advance, it executes.
- The staging deploy goes through a demo executor (only for the storyline's deploy) that takes 1.5 s and reports the
  mock's measured 2m 14s and result URL → "Deployed to staging in 2m 14s. Try it:
  staging.burrowhq.example/invoices/2026-000142.pdf". Executors may now report their own duration (core
  `ExecutionOutcome.durationMs`), as a real deploy workflow will.
- The audit events are the commands' own: "Ran the billing test suite. 41 of 41 passed.", "Pushed 7be20f to
  feat/invoice-pdf", "Checks passed on 7be20f. 41 of 41 passed.", "Approved PR #482", "Deployed feat/invoice-pdf to
  staging". Their ids are generated (`e-<hex>`), not the mock's e-9f2c / e-9f31: event ids are never chosen by
  callers.
- **Starting**: `WHOMBAT_DEMO=1` plays it 2 s after the server starts while the storyline is ahead (at 11:22, or
  mid-run after a restart); a finished storyline stays finished. `pnpm demo:play` plays it any time: it continues a
  run that is mid-timeline, starts one at 11:22 (keeping what people did meanwhile, e.g. approve in advance — only
  the run's five storyline steps are laid out, the seed carries fewer), or replays a finished one from a rewind.
- **Rewind** (`pnpm demo:reset`, or before a replay) restores run #1907, PR #482, the seeded approvals, the plan and
  the storyline agents' status from the seed world (shifted like `--relative` seeds), removes what the demo said in
  the branch room after 11:22, cancels storyline dispatches and signs a hidden `demo.rewound` event by the owner.
  The audit log keeps what happened before: it is append-only.
- `/internal/demo/play` and `/internal/demo/reset` take the runner token and answer 404 in production unless
  `WHOMBAT_DEMO` is on. The director reacts to the storyline only after it was armed (`play`, `WHOMBAT_DEMO`); a
  server restart mid-demo without `WHOMBAT_DEMO` needs `pnpm demo:play` to carry on.

## Contract changes (`@whombat/core`, additive)

1. `RUNNER_SHUTDOWN` (`contracts/runner.ts`): the `complete` error that hands a dispatch back without counting a crash.
2. `ExecutionOutcome.durationMs?` (`approvals/transitions.ts`): an executor's own measured duration.

`packages/agent-runtime/src/contract.ts` (AgentProvider, TurnInput, TurnEvent) is unchanged.

## Schema

`0003_runner_leases`: `dispatches.lease_expires_at`, `heartbeat_at`, `attempts`, `not_before`, `cancel_reason` and an
index on `run_id`.

## Tests

- Server integration: runner protocol (tokens, long poll, DispatchContext, coalescing, concurrent claims, pause /
  resume session, take over, retry + quiet error, shutdown requeue, lease expiry, heartbeats, answer `none`, git
  credentials), the MCP server over HTTP (every tool advertised; allow / ask / blocked as the agent with signed
  events; runs; reviews advancing the plan; canvas; answers; rate limits), the scripted runner in-process (canned
  reply, thread, DM, coalescing, search answer, pause / resume / take over, run streaming) and the full demo
  storyline to its deployed end state, then rewind and replay.
- `apps/server` has `@whombat/runner` and `@whombat/agent-runtime` as **test-only** dev dependencies for those
  in-process tests; server code never imports them (ARCHITECTURE: apps never import each other).
- Unit: the scripted provider (script choice, storyline timeline and tests timing, resume from the last line,
  abort, answers, reviews), runner mapping (final text, threads, errors, cancel, shutdown, registry, prompts, keys →
  sandbox / network, claim loop), rate limiter, canvas edits, run helpers.

## Follow-ups

- Web: the run page's Pause / Resume / Take over buttons on `api.runs.*`, and the paused / taken-over states.
- GitHub phase: RealGitHub credentials and the webhook mirror replace the director's `record_push` / `record_checks`;
  `open_pull_request` through the GitHub API; a real deploy executor via `ApprovalEngine.setExecutor`.
- Canvas phase: `canvas_edit` on the Y.Doc with the agent's awareness ("Sketch is writing").
- Live providers: construction options in `registry.ts`; process-group kill tests live with the providers.
- Agent tokens last 30 minutes; re-issue on progress for longer turns. Status as a renewed lease (REFERENCE_NOTES
  §4) and self-compaction of long windows (§6) are still open.
