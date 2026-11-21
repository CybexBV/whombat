# Robust updates — plan (orchestrator)

Assignment: `assignment.md` (this directory). Decisions: `docs/decisions/updates.md` (UP-…). Progress: `ledger.md`.
Evidence: `verification.md`. Resume from `ledger.md`.

## Worktrees and branches

Every repo has `robust-updates` in `~/Code/.wt/<repo>-robust-updates` (made from `main` on 2026-09-28: appliance
`6723564`, control `b9ecec2`, Whombat `195421a4`, contracts `dea86b8`, app `af43090`). Where two agents work in one
repository, the second works on a sub-branch in its own worktree and the orchestrator merges it into `robust-updates`:

| Agent | Repo / worktree (branch) | Owns | Ids |
|---|---|---|---|
| C contracts | contracts `…/whombat-contracts-robust-updates` (`robust-updates`) | everything in contracts; cuts 0.22.0 | CT-135…CT-149 |
| M manager | appliance `…/whombat-appliance-ru-manager` (`ru-manager`) | `manager/`, `helper/`, `release-tools/`, `nix/packages/{go.nix,runtime/}`, version plumbing in `flake.nix` (`releaseRuntime`, `proxmoxRelease`), `third_party/whombat-contracts-go`, `docs/decisions/manager.md`, `docs/runbooks/updates*.md`, `rollback.md` | MG-44…MG-59, NX-105…NX-109 |
| G VM gates | appliance `…/whombat-appliance-ru-gates` (`ru-gates`) | `vm-tests/upgrade-gates/**`, `vm-tests/update-migration.nix`, `vm-tests/default.nix` + the checks wiring in `flake.nix`, `release/upgrade-gates` | NX-110…NX-119 |
| P pipeline + DEV box | appliance `…/whombat-appliance-ru-pipeline` (`ru-pipeline`) | `release/ship`, `harness/src/ship/**`, `dev/devbox`, `harness/src/devbox/**`, `dev/publish-release` + `harness/src/dev/publish-release.ts`, `harness/scenarios` skew, `docs/runbooks/{shipping,dev-instance,release-build}.md`, `manifest/pins.json` (promotion code only) | IN-94…IN-109, NX-120…NX-124 |
| B backup | appliance `…/whombat-appliance-ru-backup` (`ru-backup`) | `backup/**`, `nix/modules/backup*.nix`, `docs/decisions/backup.md`, `docs/runbooks/{backup,restore}.md` | BK-18…BK-29 |
| A control | control `…/whombat-api-robust-updates` (`robust-updates`) | everything in control incl. `infra/hetzner/deploy.sh` | HZ-30…HZ-39, CL-82…CL-99 |
| R runtime | Whombat `…/Whombat-robust-updates` (`robust-updates`) | everything in Whombat | MD-13…MD-19 (+ other files' ids as needed) |
| W1 clients | app `…/whombat-app-robust-updates` (`robust-updates`) | `packages/client`, `apps/web`, `apps/mobile`, `apps/widget` | AP-255…AP-279 |
| W2 admin | app `…/whombat-app-ru-admin` (`ru-admin`) | `apps/admin/**` | AP-280…AP-299 |

The orchestrator owns `docs/decisions/updates.md`, this directory, merges, contracts/app releases' vendoring order, the
DEV deploy and every PROD step.

## Order

1. C cuts contracts 0.22.0 first (the shapes are in the brief); everyone else starts on what doesn't need it and links
   the contracts worktree during development (`scripts/link-contracts.sh`, `go.work`), vendoring the release when cut.
2. Parallel: M, G, P, B, A, R, W1, W2.
3. Integrate: merge sub-branches into each `robust-updates`; Whombat vendors app 0.12.0 and contracts 0.22.0; appliance
   pins; candidate 0.19.0 built by `release/ship build` (first release of the pipeline: no migration, UP-X04).
4. Reviews (security, operations), fixes.
5. DEV: deploy control/web/stack, DEV box, three releases (runtime-only, host, additive migration) + one bad release.
6. PROD (John's yes before each step), merge + push, report.

## Shared-machine rules (every agent)

- `TMPDIR=~/.cache/wb-tmp`. Never `docker compose down -v`, never stop shared services (`whombat-stack-dev`,
  `whombat-dev`, the shared Postgres :55432, Mailpit), never touch `whombat-prod-box` or production.
- **Heavy work under one lock**: every NixOS VM test, ISO build and full `harness validate` runs as
  `flock ~/.cache/wb-tmp/robust-updates-heavy.lock <command>` (the machine has 188 GB RAM, most in use).
- Ports: A 5600–5649, W1 5650–5699, W2 5700–5749, R 5750–5799, P 5800–5849 (+ its harness env), B 5850–5899; Postgres
  databases are throwaway (`*_ru_<agent>_*`).
- Push/fetch only with the maintainer account’s token per command (see assignment §3); never change the global gh account.
  Agents don't push; the orchestrator does.
- Commits: imperative, one concern each, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
