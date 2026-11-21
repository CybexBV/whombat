# Delegation — verification

| Check | Where | Result |
|---|---|---|
| contracts `pnpm check` | whombat-contracts `delegation` | pass (63 files, 822 tests) |
| contracts release smoke | `pnpm release` 0.16.0 | pass |
| whombat-app `pnpm check` | whombat-app `delegation` (web + Android merged) | pass (155 files, 1130 tests) |
| web visual vs mocks | `pnpm visual cards.spec.ts messaging.spec.ts` (app-web agent) | pass (30, light + dark) |
| runtime Work view tests | `read/work-overview*.int.test.ts` | pass (9) |
| Whombat `pnpm check` | runtime `delegation` (server + prompts + work merged) | pass (130 files, 954 tests) |
| Whombat `pnpm test:server` | runtime `delegation` | pass (1024 passed \| 15 skipped (1039)) |
| contracts 0.18.0 `pnpm check` + release smoke | `contracts-v0.18.0` | pass (823 tests) |
| whombat-app `pnpm check` after review fixes | whombat-app `delegation` | pass (155 files, 1135 tests) |
| Whombat `pnpm check` after review fixes + main merge | `delegation` b3a8807 | pass (131 files, 972 tests) |
| Whombat `pnpm test:server` after review fixes + main merge | `delegation` b3a8807 | pass (1043, 15 skipped) |
| security review (F1…F7 + minors) | all fixed: CT-117, DG-47 | fixed, tests added |
| product review (P1…P15 + nice) | fixed: CT-117, DG-48, AP-176…AP-190 | fixed, tests added |
| candidate 0.16.0 `harness validate` | appliance, own env | 17/17 gates; 118 scenarios incl. q-delegation 8/8; demo 2/2; k-live-agents blocked by design |
| dev deploy | managed stack 0.16.0 + monolith | healthy, migration 0047 in place |
| live handoff, two live Claude agents | dev monolith, burrow “Delegation check” | plan, lane, report_back done, delegator's summary (see ledger) |
| whombat-app 0.9.1 `pnpm check` + visual | app main cd6a1f8 | pass (1135 tests; visual 30/30) |
