# Robust updates — verification

Evidence per assignment §8 (and §9 for PROD). Newest last. “Agent” = who ran it.

## Unit, integration and repository checks (merged trees)

| What | Result | Where / agent |
|---|---|---|
| contracts 0.22.0…0.22.4 | `pnpm check` 1137, `go vet`/`go test`, `gen:check` clean, `pnpm release` byte-identical double build, smoke consumer 33 subpaths; vectors: `versions` 59 (incl. the full `0.1.0-<hex>` → `0.2.0-…` transition), `compatible` 7, `retryable` | C |
| control | `pnpm check` 76, `pnpm test:int` 250 (throwaway DBs), shellcheck clean, stand-in e2e ALL OK (release with waves/record, custody rollback refused without and signed with `--allow-downgrade-from`) | A |
| Whombat (runtime) | `pnpm check` 1239, `pnpm test:server` 1158; skew test with the previous (0.20.3) protocol both ways (MD-16); tolerant `/facts` (MD-19) | R |
| whombat-app | `pnpm check` 1429 (admin 126), Playwright managed 100 (+ `updates.spec.ts` 7), hosted CSP 1, visual 229; admin panel 118 screenshots and a smoke against A's real control | W1, W2 |
| appliance Go | `go vet ./... && go test ./...` 59 packages on the merged tree (orchestrator, 2026-09-28); transition test over 19 recorded field tuples (MG-49); ordering/refusal tests (MG-44, MG-50); exit-0 floors custody rollback (MG-45, fails without the fix); failure detail and old-control fallback (MG-46, MG-52); waiting reason (MG-53); retryable failures never quarantine (MG-54); rollback backoff (MG-55) | M, orchestrator |
| appliance backup | `go test ./backup/... ./recovery/...`; integration against a real sshd, MinIO, a disk dir and a fresh box; VM `backup-destinations` 7 subtests incl. an attack subtest reproducing then refuting security review 2's symlink findings; `sandbox-backup` | B |
| harness | `pnpm check` 81 (ship records chain, notes, twin id, promote-prod moves pins and the gates' previous releases) | P |

## VM upgrade gates (UP-C2, UP-F2) — agent G

Previous releases rebuilt from their recorded commits (`pve-20260928.6` @ `6723564`, `pve-20260928.4`), runtime and manager
store paths equal to the published ones (`matchesPublished: true`). Real `nix-store --export` streams through TUF.

| Candidate | 1 N−1→cand | 2 N−2→cand | 3 fresh ISO | 4 bad→rollback | 5 migrations + custody | 6 runtime-only / host-only | 7 restore drill | Wall |
|---|---|---|---|---|---|---|---|---|
| `pve-dev-20260928.903` (before BK-26…29) | ok | ok | ok | ok | ok | ok | ok | 46 min |
| `pve-dev-20260928.904` (latest tree) | 127 s | 173 s | 68 s | 1557 s | 221 s | 141 s | 57 s | 35 min |
| self-test `.905` (runtime never starts) | **FAILED** as it must | | | | | | | |
| self-test `.906` (helper can't roll back) | | | | **FAILED** as it must | | | | |

Before UP-A1 gate 2 reproduced the incident's ordering bug: `runtime 0.1.0-195421a < 0.1.0-2be6fc1`. Records:
`~/.cache/wb-tmp/gate-candidate-90{3,4}/upgrade-gates.json`, `gate-candidate-905/selftest-runtime.json`,
`gate-candidate-906/selftest-rollback.json`.

## Reviews

- Security review 1 (contracts, control, runtime, app): no critical/high; 2 medium, 4 low, 2 info — all fixed (UP-X07…X10;
  CL-91…CL-93, HZ-37/38, MD-17, AP-264…AP-267, contracts 0.22.1).
- Security review 2 (appliance): 1 high, 2 medium, 5 low, info — all fixed (BK-26…BK-29, MG-50…MG-52); the high one
  reproduced in a VM before the fix. No way found for a box to go backwards without custody.
- Operations review: F1…F14 fixed (CL-94…CL-96, HZ-39, AP-269, MG-53/54, IN-99/104, runbooks, contracts 0.22.4).

## The first release of the pipeline

- `release/ship build pve-20260928.7` from appliance main `dbbadbe` (candidate 0.19.0, product `2026.09.29-rc.1`):
  the first attempt was refused by the new-release check (the twin id `pve-dev-20260928.2` didn't sort after the published
  `.3`; ship's default fixed in IN-96), then built with twin `pve-dev-20260928.4`: runtime
  `0.2.0-20260928220050.e3a4d66`, manager `0.2.0-20260928233154.dbbadbe`, host class, schema 49 → 49, no migration, 54
  changes since `pve-20260928.6`; `build.json` sha256 `013d79f2…`. PROD and DEV newer checks ok.
- DEV instance moved to candidate 0.19.0 (orchestrator, 2026-09-28 23:33 UTC): control `fd51016` (contracts 0.22.4,
  migrations 0010…0012), runtime `e3a4d66e`, app `b6acb36`, appliance `5ef3755`; fleet endpoint answers.
- `release/ship validate pve-20260928.7` (isolated env `~/.cache/wb-tmp/mgd-ship-0190`, ports 5500–5590):
  - run 1 (2026-09-28 23:37 UTC, scripted): gates 17/17, scenarios 132 passed / 6 skipped (k needs live agents), skew
    ok (new web × runtime N−1 `195421a4` and N−2 `2be6fc15`, previous web `app-v0.11.1` × new runtime); **demo failed**
    (it didn't know the new “Protect your Whombat” claim step, AP-260) → gates.json failed. **Upgrade gates on the
    real release: 7/7** (1 = 118 s, 2 = 164 s, 3 = 71 s, 4 = 1562 s, 5 = 216 s, 6 = 141 s, 7 = 55 s).
  - run 2 (live agents): k 6/6 but the scripted-agent parts (r-browser, the demo's approval, the skew slice) failed —
    one environment can't be both (IN-108).
  - run 3 (2026-09-29 ~02:15 UTC, scripted + a separate live environment for k, IN-108): **gates.json ok** —
    validate gates 17/17, scenarios 132 passed (k skipped there), live k 6/6 (Claude Code 2.1.284 and Codex 0.157.1
    installed from a seeded channel), demo ok, skew ok; **upgrade-gates.json ok** (the passing run of the same build
    reused).
- `release/ship publish-dev pve-20260928.7 --soak 2h`: started 2026-09-29 03:04 UTC; DEV box `wb-0a53-dmvw-6r2n`
  Healthy on `pve-dev-20260928.1` (the twin of `.6`, manager 0.1.0) → `pve-dev-20260928.4` with the default waves.
- **DEV soak of the candidate passed** (2026-09-29 05:27 UTC): `pve-dev-20260928.4` delivered to `wb-0a53-dmvw-6r2n`
  (from `pve-dev-20260928.1`, manager 0.1.0) through DEV control, rollout `ro_y0pnaznkv2j4bbb0ygzm28kmfe` with the
  default waves; the box took the assignment and was Verifying at 450 s, Healthy at 1351 s (drain, host staging, reboot,
  verify); rollout paused at wave 0 for the soak; soak 7213 s, 120 samples, no health drops, no session drops, no status
  failures, smoke ok at start and end; rollout stopped `dev_soak_done`; `dev-soak.json` 883d7769 ok, chain complete
  (`build.json` 013d79f2 → `gates.json` 400dbdd5 → `upgrade-gates.json` 87f626c9 → `dev-soak.json` 883d7769).

## PROD (assignment §9) — John's yes on 2026-09-29 for steps 1 and 2 (control HZ-40, HZ-41)

- Step 1 (05:55–05:58 UTC): snapshot `pre-robust-updates-hosted-20260929`, dump `control-20260929T055529Z.dump`;
  `deploy.sh updates` (tufrepo from appliance `f33369c`), `control.env` + `TUF_PUBLIC_URL`, `OPERATOR_PANEL_URL`,
  `OPERATOR_ALERT_EMAILS=john@whombat.com`; `deploy.sh control` (`fd51016`, migrations 0010…0012); `web`, `embed`,
  `admin` `app-v0.12.0` (build 12000, API level 22). Fleet check ok. Not needed: snapshot, dump.
- Step 2 (05:58–06:19 UTC): snapshot `pre-robust-updates-release-20260929`, dump `control-20260929T055824Z.dump`;
  `release/ship promote-prod pve-20260928.7 --yes`; rollout `ro_d47c2yg4sbyf9s6bdx1csgw8kx` (default waves; 1–4 empty);
  box `wb-old0-prod-0002`: Assigned 06:16:24 → Downloading 06:16:58 → Verified 06:18:00 → Verifying 06:18:31 →
  **Healthy 06:18:49**, rollout completed 06:19; status 06:33: release `pve-20260928.7`, manager
  `0.2.0-20260928233154.dbbadbe`, runtime `0.2.0-20260928220050.e3a4d66`, every health check ok. VM restarted at 06:16:34
  on John's request (the box had polled 10 s earlier by itself). Pins promoted to 0.19.0 (`eeafbe3`), `promote.json`
  26d72d45. Not needed: snapshot, dump.

## DEV proofs (assignment §8) — agent P, 2026-09-29, box `wb-0a53-dmvw-6r2n`, default waves, 30-min soaks

| Proof | PROD id (never published) → DEV twin | Rollout | Outcome | dev-soak.json |
|---|---|---|---|---|
| (b) host release | `pve-20260929.901` → `pve-dev-20260929.1` | `ro_h07jnabm30jkwm0x0dsfhpknh1` | Healthy after 1171 s, soak ok | `cf819b66` |
| (a) runtime-only | `.902` → `pve-dev-20260929.2` | `ro_4drf5f1a4gq4n7rgc84zwn5ckt` | Healthy after 961 s, soak ok | `ddb3fc10` |
| bad (server throws at start) | `.903` → `pve-dev-20260929.3` | `ro_gaq3f4pmy9cag3hesf424tc1gj` | rolled back automatically (`unhealthy`: runtime, database, session endpoint), rollout paused `device_failed`, alert `rollout_paused` (critical); the pause shown in the DEV admin panel (`evidence/dev-bad-release-rollout.png`) | `28d5026e` (failed, as intended) |
| (c) expand migration (`0049_dev_proof`) | `.904` → `pve-dev-20260929.4` | `ro_g2y4ent9np3nyb1qfghyy2wheg` | migrated without a checkpoint on a box without a backup destination, Healthy after 991 s, soak ok | `bdb7a27c` |

Found by the proofs and fixed: the manager re-activated the bad release once more by itself before control's hold
arrived (two outages: ~07:17–07:19:50 and ~07:21–07:31:18 UTC) → MG-56 (no local re-activation after a verification
failure; control decides); a stale status report made publish-dev refuse a settled box (6655951); the rehearsals ran
ahead of the PROD line → UP-X11, `--dev-allow-downgrade-from`, `--ahead-of-line` (IN-110, IN-111); the DEV box rebuilt
on `pve-dev-20260928.4` (device `wb-z9wb-5gpy-2168`, smoke 9/9).

## PROD step 3 — John's yes, 2026-09-29 (control HZ-42)

- Candidate 0.19.1 (`pve-20260929.1`) was superseded before publishing: its validate hit a flaky runner test (Whombat
  DG-49 fixed the cause: tests shared one scratch folder) and the upgrade gates didn't take runtime-only candidates yet
  (NX-118). Candidate 0.19.2 → `pve-20260929.2 --reuse-host pve-20260928.7` (twin `pve-dev-20260929.6` with DEV-only
  custody past the rehearsals, UP-X11).
- validate: `gates.json` eacc0cf8 ok (gates 17/17, scenarios 132, live k 6/6, demo, skew); upgrade gates first failed
  gate 5 on a VM test that predated MG-56 (NX-125 fixed it; gates 5 and 7 now run the runner's tests on the box's
  stack), rerun reusing gates.json (IN-114): `upgrade-gates.json` 28dcbdfd ok (1, 2, 4, 5, 7 ok; 3, 6 not applicable).
- DEV: `pve-dev-20260929.6` on the rebuilt DEV box (`wb-z9wb-5gpy-2168`), Healthy after 630 s, smoke ok, no soak period
  (John removed it, IN-113); `dev-soak.json` 5195ae84.
- PROD: snapshot `pre-robust-updates-runtime-20260929`, dump `control-20260929T112827Z.dump`; rollout
  `ro_hmr875ctwsszq6qcfxq0kwfxs3` (default waves), **Healthy 11:35:28 UTC**, completed; status 11:42:40: release
  `pve-20260929.2`, runtime `0.2.0-20260929090117.a7fa2b1`, manager `…dbbadbe`, uptime 19 432 s (no reboot), all
  health ok; `promote.json` f590329b; pins 0.19.2 (`dacf949`). Not needed: snapshot, dump.

## Faster shipping (UP-X12) — the first `release/ship all`, 2026-09-29

`release/ship all pve-20260929.3` (candidate 0.19.3: host release with MG-56 and MG-57, runtime kept at `a7fa2b12`;
twin `pve-dev-20260929.7`; DEV instance on 60 s polls), 13:34:27 → 14:10:19 UTC: **build 4 min, validate 32 min
(gates.json 2c94522f ok, upgrade-gates.json 88d34277 ok — all VM gates alongside the scenarios), publish-dev 22 min
alongside (DEV box Healthy on the host twin after 1261 s, smoke ok, dev-soak.json 100e7bde); 36 min in all**, then it
stopped before production as designed. Before UP-X12 the same kind of release took about 2.5–3 h serially.
Upgrade gates alone: runtime-only 7 min 55 s, host ~10–11 min (were 54 and 35 min). MG-57's regression (host
candidate against runtime-only N−1 `.2`) passes.
