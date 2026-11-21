# Delegation — ledger

Newest last. What was done, where, and what is next, so the work survives context limits.

- 2026-09-27 20:15 Worktrees: `~/Code/.wt/{whombat,whombat-contracts,whombat-app,whombat-appliance}-delegation`, branch
  `delegation` each.
- 20:30 `docs/decisions/archive/delegation.md` DG-01…DG-27 written (storage in `plans.steps` JSON; triggers `handoff`,
  `handoff_result`; `dispatches.handoff_result`; defaults 2 M / 10 M tokens; one plan per chain).
- 20:45 Contracts 0.16.0 committed (8e59ea7, ab55d24), tagged `contracts-v0.16.0`, released (`pnpm release` ok, 822
  tests). Vendored into Whombat (0f1bb81) and whombat-app (489ce69).
- 20:55 Shared foundation on Whombat `delegation`: migration 0047, stored types, readiness.
- 21:05 Shared helpers `domain/handoff-usage.ts` + config budgets committed (51904df); DG-28 scripted directives
  (4c…). Sub-worktrees `~/Code/.wt/whombat-delegation-{server,prompts,work}`, `~/Code/.wt/whombat-app-delegation-{web,
  android}`; six agents started: rt-server, rt-prompts, rt-work, app-web, app-android, appliance (draft q-delegation).
- 21:15 Lead docs: ARCHITECTURE (Agent runtime: handoffs, teammates; Plans: handoffs), DECISIONS row, `docs/delegation.md`.
- 21:50 rt-work merged (d91bd0a; DG-29…32 recorded). App: delegation-web (AP-168…175) and delegation-android
  (AP-180…185, a Thread screen) merged into whombat-app `delegation`; duplicate fixture keys fixed; app `pnpm check`
  passes (155 files, 1130 tests). Screenshots: `~/.cache/wb-tmp/delegation-shots/{web,android}/`.
- 22:40 rt-server (c13ce37) and rt-prompts merged; DG-33…DG-45 recorded; `pnpm check` and `test:server` pass.
  Appliance draft done (appliance `delegation`: acb616d, 82e2c8d, 8063b87; IN-79…IN-82; candidate 0.16.0 templated).
  Contracts main moved to 0.17.0 (CT-116, console burrows) meanwhile: plan is contracts **0.18.0** = 0.16.0 + 0.17.0,
  cut after the reviews, vendored into Whombat, app and the harness; the candidate pins `contracts-v0.18.0`.
  Security and product reviews running.
- 23:20 Reviews in. Product: 4 must-fix, 11 should-fix. Security: F1 ReDoS through schema `pattern` (fixed in
  contracts), F2 Retry/Reassign for the wrong person, F3 new chains from lane turns, F4 agent retry loops, F5 budgets
  after a result, F6 notifications to people who left, F7 run-control unlinked, minors. Contracts **0.18.0**
  (= 0.16.0 + 0.17.0 + review fixes, CT-117) tagged and released; vendored in Whombat, whombat-app and the harness.
  Fixes sent to the server, prompts, web and Android agents.
- 00:40 All review fixes merged (DG-47, DG-48); app 0.9.0 released (tag app-v0.9.0 on b8ecaf0) and vendored.
  Whombat main merged into delegation (SUB-54, MR-77…79; contracts stay 0.18.0). Checks: `pnpm check` 972 pass,
  `test:server` 1043 pass. Merged into main (not pushed): contracts 4dccfc4, whombat-app d2a6fe2, Whombat 3b07bd3.
  Candidate 0.16.0 handed to the appliance agent (pins contracts-v0.18.0, runtime 3b07bd3, app d2a6fe2).
- 01:45 Candidate 0.16.0 validated (appliance agent): 17/17 gates, 118 scenarios incl. q-delegation 8/8, demo 2/2
  (k-live-agents blocked by design, scripted). Control moved to 607dd86 and the appliance components to afc1b39 for the
  2026-09-27 terms (IN-83). Merged into main and pushed: contracts 4dccfc4 (+ tags contracts-v0.16.0, -v0.18.0),
  Whombat 98115ac, whombat-app d2a6fe2 (+ app-v0.9.0), appliance 66679c3.
- 02:00 Dev deployed. Backup `~/.cache/wb-tmp/dev-backup-pre-delegation-20260927-225453` (three pg dumps, stack-dev.env,
  env/ archive). Managed stack on candidate 0.16.0 (runtime 009fb2a, app d2a6fe2, schemaVersion 48 = 0047), all
  healthy. Monolith `whombat-dev` pulled and restarted, health ok, schema 0047_delegation.
- 02:05 Live handoff between two live Claude agents on the dev monolith (127.0.0.1:4420, WHOMBAT_AGENTS=live), burrow
  **Delegation check** (`/delegation-check`), #general: John asked Pike (architect) to hand an Ajv-vs-Zod comparison to
  Moss (researcher). Pike: plan `pln_vN0wyEptDpRf` “Ajv vs Zod comparison for Node” (card `msg_FYVR5HhGweIz` in the
  request's thread `msg_wl7dmkpL75Mh`), lane root `msg_c7N9QGDljaJc` “@Moss, over to you: …” with a brief and “Done
  looks like”. Moss: the table in the lane (`msg_BOp77o4nWLkz`), then `report_back` done (`msg__aBk0EM1ZfYN`); step
  Done, 472 722 of 2 000 000 tokens used (reported). Pike's `handoff_result` turn: “Moss is back. Pick Ajv if …” in the
  plan's thread (`msg_f6xOWpT0gO-0`). Screenshots: `~/.cache/wb-tmp/delegation-shots/live-{general,plan-pane,lane,
  plan-thread}.png`. The thread-pane screenshot showed the plan card squeezing a step title → whombat-app 0.9.1
  (AP-192), vendored in Whombat 843d1ba, monolith redeployed on it; candidate 0.16.1 (app pin) with the appliance agent.
- 02:50 Candidate 0.16.1 (app 0.9.1, runtime 843d1ba) validated by the appliance agent (17/17 gates, 118 scenarios incl. q 8/8, demo 2/2; appliance main be7a6d8, pushed); dev managed stack switched to 0.16.1, all healthy. Done.
