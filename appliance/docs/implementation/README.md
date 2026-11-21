# Implementation ledger — Whombat managed appliance

Persistent state of the rebuild, owned by the orchestrator. Resume from here after a context limit.

| File | Contents |
|---|---|
| `assignment.md` | The assignment (orchestrator prompt) as given on 2026-09-25 |
| `architecture.md` | Agreed architecture, decisions MA-01…; supersessions |
| `adr-index.md` | Index of every decision file in every repo |
| `requirements.md` | Requirements matrix R-nn with status and evidence |
| `../archive/parity.md` | Feature/permission parity matrix with the retired self-hosted monolith (archived, HE-48) |
| `tasks.md` | Task graph, owners, branches, integration order, cross-repo procedure |
| `threat-model.md` | Threat model and key-custody table |
| `provider-evidence.md` | Provider × auth mode × workflow eligibility with dated evidence |
| `manifest.md` | Exact tested version manifest (machine-readable copy in `manifest/`) |
| `verification.md` | Verification evidence V-nn: commands, versions, conditions, outcomes |
| `blockers.md` | Remaining blockers and external release gates |
| `release-checklist.md` | Release/pilot checklist |

## How to resume
1. `git -C ~/Code/<repo> log --oneline -5` for each of Whombat (branches `managed/*`), whombat-contracts,
   whombat-app, control, the relay, the appliance (branches `main`, `manager`, `nixos`, …).
2. Read `tasks.md` status column; relaunch or continue the next wave.
3. Never merge Whombat `managed/*` into Whombat `main`, never deploy, never touch live domains (assignment §1).
