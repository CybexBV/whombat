# The runner's turn, in phases

`apps/runner/src/turn.ts` held one 1,845-line module whose `runDispatch` prepared, confined, credentialed, ran,
finished and cleaned up a turn through about fifty shared local variables. It is now a coordinator over phases and
state owners in `apps/runner/src/turn/`. Runtime-only: no contract, permission check, signing, write path, event, lease,
fencing, prompt or visible word changed.

- **RRT-01 — `runDispatch` coordinates, phases do the work.** In order: confine (feedback, reflection), follow the
  runner's signal, `preflight` (assessment, managed, gateway route, provider; a refusal stops following before it
  completes), `guardTask` (managed wall time, the task's kill on any stop), interval beats, `prepareTurn`, the ready
  beat, `runProvider`; then stop the timers, stop following, `endWithProvider`; the last word unless the lease was lost,
  `verdict.settle`, the asking beat for a failure that may be a stop, `finishTurn`, and `release` whatever happened.
  `prepareTurn` runs, in the old order: `shapeOf`, `requeueBeforeSetup` (TE-06), `buildTurnInput`, `planSession`
  (reflection fork PE-11, resume/fork/fresh PE-03, TE-02, TE-03), `denySignIns`, `placeFiles` (FS-09, FS-10),
  the scratch line, review changes, `signInFor` (client, gateway, self-hosted), `managedOwner` and `openSandbox`
  (computer, gh, gateway forwarder, sandbox), the model's effort and fast replies, `decideAccess`, then activity and
  follow-ups.
- **RRT-02 — One owner per part of the turn's state, no shared bag.** `TurnStop` (abort, first reason, the runner's
  signal), `TurnSession` (session id, prompt hash, fork reported), `TurnReply` (posted, thinking, final text, usage,
  handoff calls: the one place that decides what is posted, so nothing is posted twice), `TurnVerdict` (failure,
  refusal and its codes, managed outcome, credential signal, prompt changed; classification), `RateLimitReadings`,
  `TurnRan` (model fallback, what it ran on), `TurnProgress` (beats, flushes, previews, lease loss, access and the
  computer's start until reported), `TurnResources` (everything acquired, released in a fixed order) and `TurnCheckout`
  (pushes, landing, the workspace report). `TurnScope` holds them; each phase takes `Pick<TurnScope, …>` and its own
  typed inputs, so what a phase reads and writes is in its signature.
- **RRT-03 — Cleanup and order are the old ones, by construction.** A resource is put in `TurnResources` the moment it
  is acquired (working directory, Files, attachments, computer, gh, gateway forwarder, sandbox, follow-ups), as the old
  locals were, so a later failure still releases it. `endWithProvider` (gh, gateway forwarder, computer; AC-21) runs
  where the old first `finally` did; the sandbox stays open until its violations are read and, for a direct checkout,
  closes before landing; `release` keeps the old order, the conversation's Files after the computer (FS-09). A managed
  limit records its outcome before it aborts (`stopManaged`), so the task's kill sees a lost lease and kills at once.
  The model fallback still needs attempt 1, nothing acted or posted and no credential signal (ME-05), and resets only
  the model's effort and fast replies, the follow-ups, the session and the final text.
- **RRT-04 — The public surface stays.** `turn.ts` re-exports `runDispatch`, `TurnDeps`, `TurnOutcome`, `StopReason`,
  `buildTurnInput` (and its `BuiltTurn` result type), `confinementFor`, `hostFromEnv`, `reviewChanges`, `reflectFork`,
  `reflectTools`, `ReflectFork`, `confineReflect`, `handoffPosted`, `finalThreadOf`, `postsFinalText`, `effortsOf`,
  `completionUsage` and `isAppErrorCode`; `lib.ts`, the runner and every test import them as before. The `TurnDeps`
  comment about computers now sits on `computers`.
- **RRT-05 — One difference, unreachable from the runner.** A signal already aborted with `cancelled` when
  `runDispatch` starts now gets the beat that asks the server why (pause / take over) before the turn stops. Before,
  that beat read a variable declared further down the function (its temporal dead zone), failed as “progress failed”,
  and the turn ended `cancelled` without asking. The runner gives every dispatch a fresh signal and aborts it only after
  launch, so no real turn changes; `turn/stop.test.ts` pins the intended behavior.

Validation: the runner's unit tests (487 before, the same 487 plus 12 focused ones after) and the runner, server, CLI and
prompt-size typechecks pass. Every string, log line and comment of the old module was compared mechanically with the new
modules; the differences are renamed variables inside identical text and comments moved to the code they describe. New
tests: `turn/stop.test.ts` (first reason, asking before a cancel, letting go of the runner's signal, a turn stopped
before it began), `turn/progress.test.ts` (a reading that arrives during a beat goes with the next, access until a beat
reaches the server, the last word never stops a turn), `turn/resources.test.ts` (release order and that one failure
doesn't keep the rest). The parent runs the full check after integration.
