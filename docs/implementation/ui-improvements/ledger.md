# Ledger — UI improvements (2026-09-29)

| Stream | Items | Branch / worktree | State |
|---|---|---|---|
| C | contracts 0.23.0 (parser, usage) | whombat-contracts `ui-improvements` · ~/Code/.wt/contracts-ui | DONE — ff to contracts main 4bcb98d, tag contracts-v0.23.0 (local); vendored into app main e944255 |
| U1 | 1, 2, 4 | whombat-app `ui-u1` · ~/Code/.wt/app-ui-u1 | DONE — merged app main (AP-307: sidebar drops status word) |
| U5 | 5 | whombat-app `ui-u5` · ~/Code/.wt/app-ui-u5 | DONE — merged app main (no Danger zone: no fire/remove op exists, AP-386 → follow-up) |
| U6 | 6 | whombat-app `ui-u6` · ~/Code/.wt/app-ui-u6 | DONE — merged app main 127444f (test report = instructions + health re-read, AP-403) |
| R | runtime 1, 7 | Whombat `ui-runtime` · ~/Code/.wt/whombat-ui-runtime | DONE — merged Whombat main 8a189ada (migrations 0049, 0050) |
| M | 8 rendering | whombat-app `ui-m` · ~/Code/.wt/app-ui-m | running |
| S | 7 web UI | whombat-app `ui-s` · ~/Code/.wt/app-ui-s | DONE — merged app main 59574bd |
| L | 3 routes (server links keep old form; web redirects) | whombat-app `ui-l` · ~/Code/.wt/app-ui-l | running |

## Lead notes
- IN-121 (appliance `ui-web-server` 3d71cc9, worktree ~/Code/.wt/appliance-ui): web-server.ts honours `_headers`
  path blocks (for `/sandbox/*`). Prod: `deploy.sh` doesn't ship web-server.ts (copied by hand at setup, README l.40) —
  add a tools sync to `deploy.sh web` in control before deploying the web.
- Prod box is sealed (no incus agent): Swatch's message unreadable; representative test page instead.
- C hit a 529 once and was resumed.
- Message limit is 48 000 chars within 48 KiB JSON (CT-151), not 64 KiB: bigger HTML goes as an .html attachment.
- Release order: hosted web + Android on contracts 0.23 no later than the runtime (old clients reject >8000-char messages).

## Release (2026-09-29/30, release engineer)

| Step | State |
|---|---|
| app 0.13.0 | `653ddde` (release commit on main), tag `app-v0.13.0`; `pnpm check` 1600 tests green |
| Whombat checks | `pnpm check` green (1289 passed, 13 skipped); `test:server` green (1171 passed, 21 skipped); main `83843b36` pushed |
| appliance | `ui-web-server` merged into main `da90dbb` (decision renumbered IN-121 → **IN-122**: main had taken IN-121 for pve-20260929.4); harness `pnpm check` 105 tests green |
| api | `ui-web-server-sync` merged into main `12c51ff` (HZ-46, now citing IN-122) |
| pushed | contracts main `4bcb98d` + `contracts-v0.23.0`; app main `653ddde` + `app-v0.13.0`; Whombat main `83843b36`; appliance main `da90dbb` → `c3f98e6` (candidate) → `efe4f9c` (result docs); api main `12c51ff` |
| candidate 0.20.0 | product `2026.09.29-rc.7`, release `rt-2026.09.29-rc.7` (IN-123); own environment `~/.cache/wb-tmp/v0200-env.sh` (mgd-0200, `whombat-mgd-pg-v0200` :55494, ports 6100…6140, web 6190); build 8/8, manifest valid; validate 2026-09-29-2054: gates 17/17, scenarios 132 passed (6 `k` skipped by design); demo 1/2 → harness fix IN-124 (burrow-less URLs) → 2/2 (V-75). Flake input `whombat` → `83843b36`, `nix/packages/runtime` names 0.20.0, new pnpm hash (`--rebuild` identical), `runtime-pin` green. Appliance main `c3f98e6` pushed. Logs `~/.cache/wb-tmp/rel-0200/` |
| DEV instance | backup `~/.cache/wb-tmp/rel-0200/devbackup-20260929T212728Z/` (3 dumps + env; also `stack-dev.env.bak-0200`); `WB_MGD_PINS=manifest/candidates/0.20.0.json`, restarted 21:28 UTC: all services healthy, runtime `rt-2026.09.29-rc.7`; https://dev.whombat.com/version.json 0.13.0 (build 13000, API level 23, contracts 0.23.0); `/sandbox/html-frame.html` CSP `connect-src 'none'` … `frame-ancestors 'self'`; `/` `frame-src 'self'` |
| Android APK | 0.13.0, versionCode 13000, arm64-v8a, session transport, `api.whombat.com` / `app.whombat.com`; signer SHA-256 `85:C4:44:97:…:66:D3` = assetlinks.json; sha256 `9b7923a7…c227aa`; https://jonathan-kingdom-therapeutic-contributing.trycloudflare.com/Z1yb71XcnPcJpU0/whombat-0.13.0.apk |
| box release | `release/ship all pve-20260929.5 --reuse-host pve-20260929.4` started 21:28:55 UTC (unit `wb-ship-0200`, log `~/.cache/wb-tmp/rel-0200/ship-all.log`). Build ok (twin `pve-dev-20260929.9`, runtime `0.2.0-20260929204917.83843b3`, schema 49 → 51, both `expand`). harness/validate 17/17 gates, 132 scenarios; live agents 6/6; demo ok; skew ok. **Blocked:** VM upgrade gates 4 (rollback from pve-20260929.4) and 5 (`update-migration`) FAILED, and the DEV box waited `checkpoint` for 30 min: `0050_subscription_usage` declares floors `0049_hired_doing` (and 0049 `0048_capabilities`), so after 0049+0050 in one update the box's current runtime (schema 49) could no longer write → the manager demands a verified backup checkpoint (CT-134); boxes without a backup destination (the PROD box has none) wait for ever. DEV rollout `ro_cm0mabtkn4zsp9ht6swgz5yt2q` stopped; DEV box stays Healthy on `pve-dev-20260929.8`. **Not promoted; hosted web not deployed** (its order was “after validate is green, before the promote”). Fix prepared, not merged: Whombat branch `ui-compat-floors` (worktree `~/Code/.wt/whombat-compat-floors`): floors of 0049 and 0050 → `0047_delegation` (UI-R17) + a compat test for 48/49 → 51 |
| hosted web / embed | **not deployed** (production web stays `app-v0.12.2`, embed `app-v0.12.0`): the web was to go “after validate is green, before the promote”, and validate failed. Embed needs no deploy for this release (`git diff app-v0.12.2 app-v0.13.0 -- apps/widget` is empty; admin unchanged too). HZ-47 not written (nothing deployed) |
| final status (22:15 UTC) | `release/ship status`: pve-20260929.5 build ok · gates ok · upgrade-gates FAILED · dev-soak FAILED. `deploy.sh status`: control `1c832c5`, relay `0865cdb`, web `app-v0.12.2`, embed/admin `app-v0.12.0`, 1 live box (`wb-old0-prod-0002`) Healthy on `pve-20260929.4` (manager 0.2.0), no open rollouts, no alerts. DEV box Healthy on `pve-dev-20260929.8`, still holding `pve-dev-20260929.9` as a waiting candidate (rollout stopped; `dev/devbox rebuild` if it blocks the next twin) |
| to finish | merge Whombat `ui-compat-floors` (UI-R17; `pnpm check` 1290 + `test:server` 1171 green), push; new candidate (0.20.1: runtime = that merge) with the flake pin, the pnpm hash (unchanged if the lockfile is) and `runtime-pin`; `release/ship all pve-2026093?.N --reuse-host pve-20260929.4`; then `deploy.sh web app-v0.13.0` (+ HZ-47), `release/ship promote-prod … --yes`, follow to Healthy |

### Second attempt: candidate 0.20.1 (2026-09-29 22:16 – 09-30 00:30 UTC)

| Step | State |
|---|---|
| Whombat | coordinator merged `ui-compat-floors` → main `b26d23f6` (code = the tested `fb43ef5c`: `pnpm check` 1290, `test:server` 1171); pushed |
| candidate 0.20.1 | product `2026.09.29-rc.8`, release `rt-2026.09.29-rc.8` (IN-125, V-77): runtime `b26d23f6`, rest as 0.20.0; flake pin + `nix/packages/runtime` = 0.20.1, pnpm hash unchanged, `runtime-pin` ok. Own env (`mgd-0201`): build 8/8, manifest valid, gates 17/17, **132 scenarios**, demo **2/2**. Appliance main `157bec9` (candidate), `0f27a93` (result docs), pushed |
| DEV instance | pins 0.20.1 (backup `stack-dev.env.bak-0201`), restarted 22:47 UTC: all healthy, runtime `rt-2026.09.29-rc.8`, web 0.13.0 |
| DEV box | the old VM kept the stopped `.9` as a waiting candidate → publish-dev refused. `dev/devbox rebuild` (went to its install release `pve-dev-20260928.4`), then `dev/devbox rebuild --release pve-dev-20260929.8` → new device `wb-p3vx-9dke-6612`, Healthy on `.8` |
| box release | `pve-20260929.6` (twin `pve-dev-20260929.10`), `--reuse-host pve-20260929.4`, runtime `0.2.0-20260929221602.b26d23f`, schema 49 → 51, floors 48/48. **VM upgrade gates 1, 2, 4, 5, 7 passed.** **publish-dev ok** (run 2): DEV box Healthy on `.10` after 660 s, smoke ok. Live agents 6/6, demo, skew ok. **harness/validate FAILED twice** (17/17 gates each): run 1 `i-updates` 7 failed (`hold: true` throughout; passed 7/7 alone in `mgd-0201` straight after), run 2 `g-performance` 1 failed (handshake timeout, 20 concurrent sessions). Per the stop rule: **not promoted, hosted web not deployed** (`deploy.sh check web app-v0.13.0`: fleet check ok, nothing shipped). Logs `~/.cache/wb-tmp/rel-0200/ship-all-6{,b}.log`, `~/.cache/wb-tmp/ship/pve-20260929.6/`, reports `harness/reports/2026-09-29-2248-2`, `2026-09-29-2352-2` |
| production (00:28 UTC) | unchanged: web `app-v0.12.2`, box `wb-old0-prod-0002` Healthy on `pve-20260929.4`, no open rollouts |
| to finish | `release/ship all pve-20260929.6 --reuse-host pve-20260929.4` once more (reuses build, upgrade gates and dev-soak; reruns only harness/validate, ~45 min); if green: `deploy.sh web app-v0.13.0` + HZ-47, then `release/ship promote-prod pve-20260929.6 --yes` |

### Third validate and production (2026-09-30 00:30–01:17 UTC) — SHIPPED

| Step | State |
|---|---|
| validate | coordinator's decision: `release/ship validate pve-20260929.6 --serial` once, logs kept (`~/.cache/wb-tmp/rel-0200/ship-6c-logs/`: every environment incarnation's logs + scenario reports). **Green**: 17/17 gates, **132 scenarios, 0 failed**, live 6/6, demo, skew; upgrade gates reused. `gates.json 9076a2009e36`, `upgrade-gates.json f324fc4fd05b` (appliance IN-126, V-79) |
| hosted web | `deploy.sh web app-v0.13.0` at 01:07:16 UTC (web-server.ts from appliance `0f27a93`, HZ-46). https://app.whombat.com/version.json → 0.13.0, build 13000, API level 23, contracts 0.23.0; `/sandbox/html-frame.html` one CSP `default-src 'none'; … connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'self'`; `/` one CSP with `frame-src 'self'`, `frame-ancestors 'none'`. Embed/admin stay `app-v0.12.0` (no change). control HZ-47 `a78526b` |
| promotion | `release/ship promote-prod pve-20260929.6 --yes` 01:07:29; rollout `ro_cx55w0711evabnm6d1gxfe7j1h` (default waves; the box is `general`, waves 1–4 empty) completed 01:13:46; `promote.json 656bf0bde4f4` |
| PROD box | `wb-old0-prod-0002`: **`pve-20260929.6`, runtime `0.2.0-20260929221602.b26d23f`, manager 0.2.0, Healthy**, runtime/database/runner/sessionEndpoint/relay ok (01:17 UTC; schema 51, no checkpoint needed) |
| pins | promote-prod couldn't move them (uncommitted report); by hand: appliance `e8f0a05` (pins.json = 0.20.1, upgrade gates' previous = pve-20260929.6, .4), docs `d905687`, pushed |
| final status | `release/ship status`: pve-20260929.6 build · gates · upgrade-gates · dev-soak · promote all ok. `deploy.sh status`: control `1c832c5`, relay `0865cdb`, web `app-v0.13.0`, embed/admin `app-v0.12.0`, fleet pve-20260929.6 (API 23) Healthy, no open rollouts, no alerts |
| Android | APK 0.13.0 (versionCode 13000) still at https://jonathan-kingdom-therapeutic-contributing.trycloudflare.com/Z1yb71XcnPcJpU0/whombat-0.13.0.apk (units `wb-apk-share-http`/`-tunnel`; stop them once John has installed it) |
