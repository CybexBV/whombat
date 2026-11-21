# Ledger — shared own sign-in and feedback on the owner's sign-in (2026-09-30)

Whombat SUB-57, SUB-58 (main `8ddc53ef`); contracts 0.24.0 (CT-159, `contracts-v0.24.0` `23b7b39`); whombat-app
`app-v0.14.0` (`1dc5ff9`, AP-420…AP-426). Fixes production report FB-AX8T-89BP (`provider.no_requester`). Control
unchanged (`1c832c5`). No migration (`git diff b26d23f6..8ddc53ef`: none; schema 51).

## Release (2026-09-30, release engineer)

| Step | State |
|---|---|
| candidate 0.21.0 | product `2026.09.30-rc.1`, release `rt-2026.09.30-rc.1` (appliance IN-127, V-80): 0.20.1 with contracts 0.24.0, app 0.14.0, runtime `8ddc53ef`. Flake pin + `nix/packages/runtime` = 0.21.0, new pnpm hash (lockfile changed with contracts 0.24.0; `--rebuild` identical), `runtime-pin` ok. Own env (`mgd-0210`): build 8/8, manifest valid, gates 17/17, **132 scenarios**, demo **2/2**. Appliance main `1220a81`, pushed |
| DEV instance | backup `~/.cache/wb-tmp/rel-0210/devbackup-20260930T063735Z` (+ `stack-dev.env.bak-0210`); pins 0.21.0, restarted 06:38 UTC: all healthy, runtime `rt-2026.09.30-rc.1` (schema 51), https://dev.whombat.com/version.json 0.14.0, contracts 0.24.0 |
| box release | `pve-20260930.1` (twin `pve-dev-20260930.1`), `--reuse-host pve-20260929.6` (host + manager of pve-20260929.4), runtime `0.2.0-20260930060131.8ddc53e`, schema 51 → 51, no client floor. **publish-dev ok**: DEV box Healthy on `.1` after 270 s, smoke ok. **gates.json ok**: 17/17, 132 scenarios, live 6/6, demo, skew. **VM upgrade gates**: run 1 refused at evaluation (a runtime-only release on a runtime-only one; appliance IN-128 fix `cafb81d`); run 2: **1, 2, 4, 5, 7 ok, 3/6 n/a**. `release/ship status`: build · gates · upgrade-gates · dev-soak all ok. Logs `~/.cache/wb-tmp/rel-0210/`, `~/.cache/wb-tmp/ship/pve-20260930.1/` |
| production (07:21 UTC) | unchanged: web `app-v0.13.0`, embed/admin `app-v0.12.0`, box `wb-old0-prod-0002` Healthy on `pve-20260929.6`, no open rollouts, no alerts. `deploy.sh check web app-v0.14.0`: fleet check ok |
| to finish (John's yes) | 1. `infra/hetzner/deploy.sh web app-v0.14.0` (+ HZ entry; embed/admin need nothing: `apps/widget`, `apps/admin` unchanged since `app-v0.12.0`); 2. `release/ship promote-prod pve-20260930.1 --yes`, follow to Healthy; pins.json → 0.21.0 and the gates' previous → pve-20260930.1, pve-20260929.6 |
