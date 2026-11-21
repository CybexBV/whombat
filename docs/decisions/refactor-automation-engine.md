# Automations engine as a coordinator

Runtime-only refactor of `apps/server/src/automations/engine.ts` (about 3,000 lines that mixed lifecycle timers,
trigger scans, schedules, leases, run advancement, GitHub/the tracker/URL effects and the approval guard). No contract,
permission, signing, write path, event, lease/fencing, cadence or visible-word change. `steps.ts` and its
`steps/**` modules belong to another stream: the engine modules import the same names from it as before.

- **RAE-01 — `engine.ts` coordinates; the work lives in `automations/engine/`.** The engine keeps its lifecycle
  (the advisory lock, the handover wait, stepping down, close), the pass cadence (nudge, kicks, safety and idle ticks,
  the next schedule fire) and the pass order, and calls each phase through its own methods, so callers, spies and
  tests see the same calls. Its public surface is unchanged: `start`, `close`, `nudge`, `tick`, `isActive`,
  `checkLock`, `bootRecovery`, `skipWhileLapsed`, `scanEvents`, `scanSchedules`, `realignTimers`, `advanceAll`,
  `advanceRun`, `options`, `id`, and the exports `ENGINE_LOCK`, `EngineOptions`, `DEFAULT_ENGINE_OPTIONS`,
  `newestFires` (re-exported). The collaborators, by phase:

  | module | what it does |
  |---|---|
  | `options.ts`, `lock.ts` | the engine's knobs; taking, checking and giving back the advisory lock's session (CS-11) |
  | `event-facts.ts`, `triggers.ts` | what a signed event means to triggers and its causal depth; the per-burrow cursor scan in one transaction; the lapsed-licence cursor skip |
  | `schedules.ts` | `Schedules`: due fires under missed-run and overlap policies, realigning timers after the clock went back, the next fire for the cadence, the lapsed-licence skip |
  | `run-advance.ts` | `RunAdvancer`: claiming and renewing leases (fence), the bounded advance loop, one transition per step state, the steps this process marked for its own effect |
  | `observe.ts`, `merge-step.ts` | is a waiting step done (turns, approvals, merges' checks); a merge step's re-run and merge |
  | `external.ts`, `github-comments.ts`, `tracker-effects.ts` | doing a marked step's effect, or recovering a dead process's `running` step (reconciled, replayed, or `uncertain`) |
  | `step-ops.ts` | the `LeasedRun` port, `failure`, and `awaitingYes` |
  | `approval-guard.ts` | the guard `StartExecution` runs for an automation's approval, and `continue_step`'s reconciler |

- **RAE-02 — Narrow ports, read at use.** A step's effect gets a `LeasedRun`: the services, the run as this pass
  loaded it, its fence, the lease owner, the automation's principal (cached, looked up when first needed, as
  before) and `commit(op)`, the fenced `automationStep` commit signed by that principal. Commits of other fenced
  commands (`openPrStep`, `mergePrStep`) still name `runId`, `fence` and `owner` at the call site. Scanners and the
  advancer hold the engine's own options object (narrowed with `Pick`), never a copy, so options changed on a live
  engine count at their next use; services are read when used (the logger, GitHub and the tracker are set after the
  engine is built). The modules form a DAG and never import `engine.ts`: no new runtime import cycle.
- **RAE-03 — Same statements, same order.** Code moved verbatim apart from signatures. The three restructured
  places keep their behaviour: the external-effect dispatcher is split into “do it” and “recover it” with the same
  checks in the same order; `RunAdvancer.marking` marks a step before the commit and forgets it exactly where the
  engine did (a failed commit, an `execute` that isn't an external step or is a merge, an `already_open` that
  didn't come back `commenting`); one `awaitingYes` replaces five identical waits for a yes to a step's own request
  (an agent's branch, a comment, a merge, a tracker write or reply) — the same reads, outcomes and words, each step
  keeping its own answer to a no. The old `advanceStep`/`external` `steps` argument was unused and is gone.
- **RAE-04 — The shared wait has its own test.** `engine/awaiting-yes.int.test.ts` drives a `github_comment` step
  whose key asks: a no skips the step and the run goes on, or with `otherwise: fail` fails it, naming who said no;
  nobody deciding by the step's deadline fails it; nothing is commented. It needs Postgres for the runs, approvals and
  commit pipeline it drives, and moves the injected clock instead of sleeping.

Validation: the server typecheck and Biome on the owned files; every integration file that drives the engine (the
automations, the tracker, feedback, runtime, skills and memory ones), the approvals files (every execution passes the
guard), `managed/licence` and the new file; moved code compared with the original by function after normalising
the renames. The parent runs the full verification after integration.
