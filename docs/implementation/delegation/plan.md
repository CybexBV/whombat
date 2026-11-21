# Delegation — implementation plan

Assignment: `assignment.md` (this folder). Decisions: `docs/decisions/archive/delegation.md` (DG-01…).

## Phases

| # | Phase | Owner | State |
|---|---|---|---|
| 0 | Read, decide (`delegation.md`), ledger | lead | done |
| 1 | Contracts 0.16.0 (CT-113…115): schemas, pure rules, fixtures, release, vendor | lead | done |
| 2a | Runtime server: commands, MCP, dispatch/lane, limits, budget, sweeps, notifications, search | agent `rt-server` (branch `delegation-server`) | |
| 2b | Runtime context + prompts: teammates, handoff contexts, both builders, runner | agent `rt-prompts` (branch `delegation-prompts`) | |
| 2c | Runtime Work view (`work.overview`) | agent `rt-work` (branch `delegation-work`) | |
| 2d | App web: plan card, plan pane, add step, report back, Work view, visual check | agent `app-web` (whombat-app `delegation-web`) | |
| 2e | App Android: PlanScreen | agent `app-android` (whombat-app `delegation-android`) | |
| 2f | Appliance scenario `q-delegation` (draft on fixtures) | agent `appliance` (appliance `delegation`) | |
| 3 | Integrate branches into `delegation`, full checks, docs | lead | |
| 4 | Candidate 0.16.0: app 0.9.0 vendored, runtime pinned, validate, demo | lead + agent | |
| 5 | Review: security lens, product lens; fix | agents | |
| 6 | Ship: merge, push, tags, deploy dev (managed stack + monolith), live handoff | lead | |

## Shared foundation (lead, on `delegation` before the split)

- `apps/server/src/db/migrations/0047_delegation.sql`: `dispatches.handoff_result` jsonb, `dispatches_plan_step_idx`,
  `dispatches_thread_idx`; `compat.json` expand, runtime floors 0047.
- `StoredHandoff` / `StoredPlanStep` in `db/schema/work.ts` (server-only: `onBehalfOfAccountId`, `fromDispatchId`,
  `reportMisses`, `woken`).
- `apps/server/src/runtime/readiness.ts` `agentReadiness()` (teammates block and `delegate` refusals).
