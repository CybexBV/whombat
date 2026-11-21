# W4-SEC part 2: updates, boot, backup and recovery (independent review)

Reviewer: W4-SEC (independent; did not write this code). Date: 2026-09-25.
Head reviewed: the appliance’s `main` at **87e900c** (contains 7e36445, the nixos merge).

**Method.** Code reading of `manager/**`, `helper/**`, `release-tools/**`, `backup/**`, `recovery/**`, `nix/**`,
`provisioning/**` and `vm-tests/**` against architecture MA-11…MA-13 and MA-19, threat model T6–T11, assignment §9–§11 and
§14 items 10–13, and decisions MG-, NX- and BK-. A finding marked *confirmed* has a PoC that asserts the vulnerable
behaviour and passes (it fails once the finding is fixed). The PoCs are only in a scratch clone
(`git clone --no-local`) at `~/.cache/wb-tmp/sec2/appliance`. This repository was not modified apart from this report,
which is not committed. The backup PoC uses a throwaway `whombat_bk_test_*_sec2` database that the harness creates and
drops.

**PoC commands** (all were run and pass; `cd ~/.cache/wb-tmp/sec2/appliance`, `export TMPDIR=~/.cache/wb-tmp`):

```
go test ./recovery/internal/export/     -run TestSEC2 -v -count=1   # M-4
go test ./manager/internal/knowngood/   -run TestSEC2 -v -count=1   # M-3
go test ./manager/internal/update/      -run TestSEC2 -v -count=1   # M-2, L-1
go test ./helper/internal/ops/          -run TestSEC2 -v -count=1   # L-2
go test ./helper/pkg/netconfig/         -run TestSEC2 -v -count=1   # L-3
WB_REST_SERVER=$HOME/.cache/wb-tmp/bk-bin/rest-server WB_PG_BIN=$HOME/.cache/wb-tmp/bk-pg17/bin \
  go test ./backup/itest/ -run TestSEC2 -v -count=1                 # M-1
# C-1 (VM, KVM): scratch test vm-tests/sec2-recovery-tpm.nix (install-boot-luks setup + recovery UKI)
NIX_CONFIG="experimental-features = nix-command flakes" nix build .#checks.x86_64-linux.sec2-recovery-tpm.driver -o ../sec2-driver
(cd ../vmrun && TMPDIR=$PWD XDG_RUNTIME_DIR=$PWD ../sec2-driver/bin/nixos-test-driver)
```

## Summary

| ID | Severity | Title | Area | Evidence |
|---|---|---|---|---|
| C-1 | **critical** | The signed recovery environment opens an auto-login root shell on tty2–tty6 without the disk recovery key. Because it is signed by the same db key, PCR 7 is the same as a normal boot, so the TPM should also release /persist there | nix (recovery, storage) | root shell confirmed in VM; unsealing by analysis |
| H-1 | **high** | The TPM2 policy is PCR 7 only and never checks which volume was unlocked. Any signed image (recovery, an old generation) unseals, and so does a swapped-in attacker root volume | nix (storage, boot) | analysis |
| M-1 | medium | `quarantine.Apply` loads the old appliance's data into the live database before it writes the quarantine marker. A failure or crash leaves restored data running with no quarantine, and existing DB sessions stay writable | backup | confirmed |
| M-2 | medium | Control can move a device back to any older release that is still TUF-approved. Nothing requires versions to go forward (T8) | manager/helper (+ release custody) | confirmed |
| M-3 | medium | The known-good manager copy is only checked against a manifest in the same manager-writable directory, so a manager compromise survives host updates via `whombat-manager-recovery` | manager, nix | confirmed |
| M-4 | medium | The recovery/export tool uses manifest fields (`sources[].name`, `repos[].path`) as output paths, so a checkpoint from a compromised appliance can write outside `-out` on the machine running the export | recovery | confirmed |
| M-5 | medium | `whombat-backup-api` and `whombat-backup` run with ambient CAP_DAC_READ_SEARCH over the whole filesystem. The API unit does not hide the identity keys, and neither unit hides the Secure Boot db key | nix (backup) | analysis (unit config) |
| L-1 | low | A pre-migration checkpoint is reused after the runtime has been resumed (hold, lock, window or manager crash), so the migration names a checkpoint that misses acknowledged writes | manager | confirmed |
| L-2 | low | The helper rolls back to the previous runtime or host release without an assignment, even when custody has withdrawn that release. This lets the manager uid downgrade at will | helper | confirmed |
| L-3 | low | The helper's network validation lets newlines through in IPv6 zones (`netip`), which injects directives into the root-written networkd unit | helper | confirmed |
| L-4 | low | Nothing on the device or in the prod Nix assertion refuses the development TUF root, whose private keys are committed | nix, release-tools | analysis |
| L-5 | low | Factory reset keeps the helper state on the root volume (assignment sequence, activation records), so a re-provisioned device can refuse assignments and `seed-factory` fails | nix (appliance-tools), helper | analysis |
| L-6 | low | The helper opens manager-controlled directories (mirror, staging, assignment, candidates) through symlinks, and opens FIFOs blocking | helper | analysis |
| I-1 | info | The time floor comes only from assignment `issuedAt`, and NTP is unauthenticated | manager/helper, nix | analysis |
| I-2 | info | Restoring on a replacement cannot detect a destination that withholds the newest checkpoints (the kit carries no expected head) | backup | analysis |
| I-3 | info | Card SVGs deleted from the FAT factory medium can be recovered from the medium | provisioning runbook | analysis |

Counts: **critical 1 · high 1 · medium 5 · low 6 · info 3**.

---

## Findings

### C-1 (critical): recovery environment gives a keyless root shell, and PCR 7 lets it unseal the disks
- `nix/profiles/recovery.nix:154-157`: `services.getty.autologinUser = "root"` applies to every `getty@`/`autovt@`
  instance (evaluated: `getty@.service` runs `agetty --autologin root $TTY`), but the menu is exec'd only when
  `tty == /dev/tty1`. On any other VT the result is a plain root shell.
- `nix/modules/boot.nix:185-216` signs `whombat-recovery.efi` with the device db key. `nix/modules/storage.nix:38-41, 255-260`
  seal both LUKS2 TPM tokens to PCR 7 only. PCR 7 records the Secure Boot policy and the db authority that verified
  the images. That authority is the same for the recovery UKI, so the recovery boot should produce the same PCR 7 as
  a normal boot.
- **Scenario (T11, thief with the device):** at power-on the thief holds Space, picks "Whombat Recovery" and presses Alt+F2.
  That gives a root shell. From there the TPM token can very likely be used to open `whombat-persist` and `whombat-root`
  with no recovery key. NX-13 ("every data-touching action needs the disk recovery key") is therefore met only by the
  tty1 menu, not by the recovery environment as a whole.
- **Evidence.** Scratch VM test `vm-tests/sec2-recovery-tpm.nix`: install + OVMF Secure Boot + swtpm, PCR 7 seal, recovery
  UKI signed by `whombat-recovery-install`, `bootctl set-oneshot whombat-recovery.efi`, reboot, Alt+F2. The screenshot
  `~/.cache/wb-tmp/sec2/vmrun/sec2-tty2-0.png` shows `[root@whombat-recovery:~]#` on tty2 (auto login, no key).
  **Not demonstrated:** the TPM unseal inside the recovery environment. That run was stopped before it got a result, so
  this half rests on the PCR 7 analysis above.
- **Fix (owner: nixos).** (1) Recovery: no auto-login on any VT (`services.getty.autologinUser = null`), run the menu as
  the only session on tty1, and disable the other VTs (`NAutoVTs=0`, `ReserveVT=0`). (2) Make the recovery boot unable
  to unseal. Bind the TPM policy to something the recovery UKI does not produce, e.g. a signed PCR 11 policy for the
  normal UKIs plus `systemd-pcrphase` (see H-1). Or extend a PCR in the recovery initrd before any userspace runs.
  (3) Add a VM regression test: in recovery, the TPM token must fail to open `whombat-persist`.

### H-1 (high): the TPM policy doesn't bind boot path or volume identity
- `nix/modules/storage.nix:38-41` (`tpm2Pcrs = [ 7 ]`), `:199-215` (`tpm2-device=auto` for both volumes, independently).
- With PCR 7 alone, **every** image the device's db key signed unlocks: the recovery UKI (C-1) and any older generation
  still on the ESP (up to `configurationLimit = 8`, including ones with fixed vulnerabilities).
- Nothing ties the persist unlock to the root volume that was actually opened. This is the publicly documented weakness
  of TPM-only unlock without volume binding (the root-volume substitution class). An attacker who replaces the root
  partition with their own volume keeps an unchanged PCR 7, because the initrd is still the signed one, so `/persist`
  would still auto-unlock.
- The keys generated on the device are sound. The weakness is the choice of policy. NX-12 already names signed PCR 11
  policies / `systemd-pcrlock` as "the next step". This review asks for that step before production.
- **Fix (owner: nixos).** Seal to a signed PCR 11 policy (`ukify --pcr-private-key`, phase-bound via `systemd-pcrphase`),
  measure the unlocked volume key into PCR 15 (`tpm2-measure-pcr=yes`) and bind `/persist` to the expected PCR 15 state,
  or use one encrypted volume unlocked once. Consider a TPM PIN for high-value deployments. Remove failed and old
  generations from the ESP.
- **Hardware-only:** actual PCR values on real firmware, option-ROM measurements, and dbx updates.

### M-1 (medium): quarantine marker is written last
- `backup/internal/quarantine/quarantine.go:186-233`. `restore.Run` restores into the **live** database first (pg_restore,
  then `default_transaction_read_only`). Only after all verification steps, git relocation and the renames does
  `state.WriteJSON(Path(c), m)` write the marker. Any error before that (verification step, rename, crash or power
  loss) leaves the replacement running on the old appliance's data with no marker. The runner starts, and nothing tells
  the runtime to hold schedules or outbound effects. The error message "nothing was put in place" is then wrong.
  `ALTER DATABASE … default_transaction_read_only` affects only new sessions, so the runtime's existing pool can still
  write.
- **PoC (confirmed):** `backup/itest/sec2_poc_test.go` `TestSEC2QuarantineMarkerWrittenLast` makes the `/persist/secrets`
  rename fail. The result: `apply` errors, there is no marker, 250 restored rows are present, and a connection opened
  before `apply` inserts successfully.
- **Fix (owner: backup).** Write and fsync the marker **before** touching the database or files, and remove it only in
  `Release`. Terminate existing sessions (`pg_terminate_backend`) after setting read-only, or restore with the runtime
  stopped. Make the runtime's quarantine check fail closed while the marker exists or a restore is in progress.

### M-2 (medium): control can move a device back to older approved releases
- `manager/internal/update/offer.go:23-44`, `engine.go` Offer/`checkSchema`: any TUF-approved tuple that passes
  `CheckActivation` is accepted. Nothing requires release versions to move forward.
- **Scenario (T2/T8):** a compromised control moves the fleet back to an older release that is still in `targets.json`
  and has a known vulnerability. Withdrawing it (runbook step 4) helps only if custody removes every superseded release
  promptly.
- **PoC (confirmed):** `manager/internal/update/sec2_poc_test.go` `TestSEC2ControlDowngradeToOlderApprovedTuple`:
  the device goes `rt-4-host` (host 26.05.2) → `rt-2` (host 26.05.1), Healthy.
- **Fix (owner: manager + release custody).** Add a TUF-signed ordering (release sequence or minimum-release floor) in
  targets custom metadata. Manager and helper refuse a candidate older than known-good unless targets marks it as an
  allowed rollback target. Make routine withdrawal part of the release ceremony.

### M-3 (medium): known-good copy can be replaced by the manager uid
- `manager/internal/knowngood/knowngood.go:110-152` checks the binary against `manifest.json` in the same directory.
  Both live under `/persist/manager/known-good` (manager-owned, `nix/modules/manager.nix:269`). `recovery.Launch`
  execs whatever `Select` returns (`manager/internal/recovery/recovery.go`). The decision doc's "a tampered copy is
  never executed" covers corruption, not tampering.
- **Scenario:** code execution as `whombat-manager` (management key, helper socket) plants a binary with a matching
  manifest. Later host updates fix the original bug, but any manager failure triggers `OnFailure=` recovery, which
  execs the plant again. Reliable repeated failures can be caused through manager-owned state.
- **PoC (confirmed):** `manager/internal/knowngood/sec2_poc_test.go` `TestSEC2KnownGoodSelfConsistentTamper`: `Select`
  returns the replaced binary.
- **Fix (owner: manager/nixos).** Run known-good from the read-only store: record the manager store path of the
  known-good host (from the helper's TUF-verified records) and exec that path. Or have root own the copy and pin its
  hash in root-owned state. Also add `NoExecPaths=/persist` to the manager units.

### M-4 (medium): export tool writes outside `-out` based on manifest fields
- `recovery/internal/export/export.go:100-136`: `filepath.Join(o.Out, "files", s.Name)` and
  `filepath.Join("git-bundles", name+".bundle")` use `sources[].name`, `sources[].snapshotPath` and `repos[].path`
  from the signed manifest without validation. The manifest key and repository password live on the appliance, so
  a compromised appliance produces "authentic" checkpoints.
- **Scenario:** after an incident, the customer runs `whombat-recovery export` on their laptop or in the recovery
  environment. A crafted manifest moves attacker-controlled trees to paths such as `~/.ssh` or autostart directories.
- **PoC (confirmed):** `recovery/internal/export/sec2_poc_test.go` `TestSEC2ExportManifestNameEscapesOut`: the name
  `../../victim-home/.ssh` places `authorized_keys` outside `-out`.
- **Fix (owner: backup/recovery).** Accept only the known source names (`home|workspaces|credentials|secrets`) and
  `snapshotPath == "files/<name>"`. Require `repos[].path` to be a clean relative path under `files/`, with no `..`.
  After joining, check the result is still inside `Out`. Apply the same checks in `restore`/`quarantine`.

### M-5 (medium): backup units read more than they need
- `nix/modules/backup.nix:300-307, 373-376`: both units have ambient `CAP_DAC_READ_SEARCH`. `whombat-backup-api`'s
  `InaccessiblePaths` is only `confined` (`/persist/{whombat,secrets,manager,postgres}`), so
  `/persist/identity/management.key` and `content.key` stay readable. Neither unit hides `/var/lib/sbctl` (Secure Boot
  PK/KEK/db private keys) or other root-only state.
- **Scenario:** a compromise of the backup API (which parses restic output and talks to a customer-chosen destination)
  yields the content identity key, i.e. the ability to impersonate the appliance's Noise identity. It also yields the
  db signing key, which combines with H-1 for anyone with physical access.
- **Fix (owner: backup/nixos).** Drop the capability from the API unit (it serves status, destination and material only).
  For the checkpoint unit, have snapd make the staged snapshots readable to the backup user instead of granting a
  capability. At minimum, add `/persist/identity`, `/var/lib/sbctl`, `/var/lib/whombat-update-helper` and
  `/run/credentials` to `InaccessiblePaths` of both units.
- Not verified in a VM (analysis of the unit definitions).

### L-1 (low): stale pre-migration checkpoint
- `manager/internal/update/engine.go:897, 974`. Once `CheckpointRef` is set, it is reused after the runtime was resumed
  by a hold, a lock, the maintenance window, or a manager restart past the drain lease.
- **PoC (confirmed):** `TestSEC2StaleCheckpointAfterResume`: one checkpoint, runtime resumed, and the later migration
  still uses `ckpt-rt-11-contract`.
- **Fix (owner: manager).** Clear `CheckpointRef` whenever the drain ends (resume, window end, boundary lost, restart
  with an expired lease), or have the backup service attest that no writes happened since the checkpoint.

### L-2 (low): helper rollback needs no assignment and ignores withdrawal
- `helper/internal/ops/ops.go:315-352` (`rollback-runtime` with no `releaseId` is unconditional) and `:358-376`
  (`activate-host-on-reboot` of the recorded current or previous host skips TUF and the assignment check).
- **PoC (confirmed):** `TestSEC2RollbackToWithdrawnReleaseWithoutAssignment`: rt-1 is withdrawn from TUF and
  `activate-runtime rt-1` is refused, yet `rollback-runtime` switches to rt-1.
- **Fix (owner: helper).** Allow rollback only while an activation is unfinished (a pending host record, or the runtime
  activated within the verify window). When metadata is fresh and names the target as withdrawn, refuse and escalate.

### L-3 (low): newline injection in the rendered networkd unit
- `helper/pkg/netconfig/netconfig.go:106, 117` use `netip.ParseAddr`, which accepts IPv6 zones containing any bytes.
  `RenderNetworkd` then writes them verbatim. The contract schema on the runtime path blocks this; the helper's own
  validation (its boundary against the manager) does not.
- **PoC (confirmed):** `TestSEC2ZoneInjectsNetworkdDirectives` renders `IPv4Forwarding=yes` and `[Match] Name=*`.
- **Fix (owner: helper).** Reject addresses with a zone (`a.Zone() != ""`) and reject any value containing control characters.

### L-4 (low): development root not rejected in prod
- `nix/modules/manager.nix:229-232` checks only that `tufRoot != null`. `release-tools/fixtures/dev/repo/keys/` holds
  committed private keys. Nothing on the device detects a development root.
- **Fix (owner: nixos/release-tools).** Add a prod assertion against the fixture root hashes and a key blocklist in the
  helper and manager for env `prod`.

### L-5 (low): factory reset leaves helper state
- `nix/packages/appliance-tools/default.nix:118-145` erases /persist, the network files and the journal, but not
  `/var/lib/whombat-update-helper/state.json`. The kept `maxAssignmentSeq` can make the helper refuse the new identity's
  lower sequences (depending on how control numbers them). `SeedFactory` refuses ("already seeded"), and under
  `pipefail` that aborts `whombat-factory-provision` before the units are started.
- **Fix (owner: nixos/helper).** Reset helper assignment/time state on factory reset, and make `seed-factory` accept a
  new device id.

### L-6 (low): helper path handling on manager-controlled directories
- `helper/pkg/trust/fetch.go:392-431` and `ops.go:152-191, 457` use `O_NOFOLLOW` on the last path component only.
  The manager can make `tuf/mirror`, `staging`, `assignment` or `network/candidates` symlinks, which makes root read
  fixed-name files elsewhere (limited information in error text). A FIFO in staging blocks the helper while it holds
  its mutex.
- **Fix (owner: helper).** Open with `openat2(RESOLVE_NO_SYMLINKS)` or check the directory owner and type, and open
  files with `O_NONBLOCK`, then `fstat` to require a regular file.

### I-1, I-2, I-3 (info)
- **I-1:** the floor only rises when an assignment arrives. With unauthenticated NTP, a backwards clock can make
  metadata that expired after the last floor look fresh again. Consider NTS and also raising the floor from
  `timestamp.expires − max lifetime`.
- **I-2:** the recovery kit could record the latest known checkpoint sequence, so a restore can report a destination
  that withholds newer checkpoints.
- **I-3:** the runbook's "delete the SVGs" on FAT leaves them recoverable. Use an encrypted station medium or overwrite
  the files.

## Checked and found sound
- Helper protocol: strict one-line JSON of at most 1 KiB, a closed op set, and regex-validated release, candidate and
  checkpoint ids. No field carries a path, URL, command or Nix expression. The peer uid is taken from `SO_PEERCRED`,
  and operations run serially under a mutex.
- The helper re-verifies independently: its own TUF cache and pinned root, releases resolved from its own metadata, the
  assignment checked against TUF-published keys with its own sequence floor, and artifacts copied while hashed into a
  root-only directory before import (no check-then-use race). Store paths match a strict regex, and every program path
  comes from root-owned config.
- TUF: go-tuf v2.4.2 workflow, consistent snapshots, custom tuple canonical bytes bound to the target hash,
  `AssignmentKeyMap` scoped by environment. Torn cache files are handled.
- Assignment handling: holds, replay, quarantine digest match, renewal of an in-flight release, and queueing in recovery mode.
- Journal: two slots, fsync + rename + directory fsync, checksum, `minReader`. Every effect is idempotent.
- Nix settings: `max-jobs=0`, no substituters, `allowed-users = trusted-users = [root]`.
- Backup git inventory: system/global config disabled, hooks, fsmonitor and filters neutralised, `GIT_ATTR_SOURCE`
  empty, no network protocols.
- snapd confinement: `ProtectSystem=strict` limits writes and deletions to `/persist/backup/staging`.
- Manifest authentication: signature, `mf:`/`ck:` tags, and the hash chain.
- Provisioning: keys generated on the device, the recovery key passed through the environment (not argv), nothing
  secret in logs, identity files 0600.
- Kernel command line: `editor=false`, and the UKIs embed their command line.

## What only hardware can verify
- Real PCR 7/11 values across firmware and dbx updates, option ROMs, TPM clear, and board swap.
- Actual Secure Boot enforcement and firmware setup-password lockout.
- Power loss during journal, TUF cache, `switch-to-configuration` and LUKS operations.
- Watchdog resets and boot-counting fallback on real firmware.
- Whether the recovery-environment unseal (C-1) behaves as analysed on real firmware.

## Test runs
- All PoC tests listed above pass.
- `go test -race -count=1 ./helper/... ./manager/... ./release-tools/... ./recovery/... ./provisioning/...`
  (including the PoCs): the first run printed an overall `FAIL`, but the failing package's line was cut off by my
  output capture (`tail -40`), so I can't name it. Re-running `./helper/...`, then
  `./manager/... ./release-tools/... ./recovery/... ./provisioning/...`, with `-race` passed with no failures and no
  data-race reports. Treat this as a possible flaky test that still needs to be identified.
- Not run by me: `vm-tests` `install-boot-luks`, `appliance-basic`, `manager-units`, `sandbox-backup` (only the scratch
  `sec2-recovery-tpm` test described in C-1).

---

## Re-review (branch `security-fixes-2`, e6e67d6…a646ed8)

Reviewer: W4-SEC (independent). Date: 2026-09-25. I reviewed a scratch clone
(`~/.cache/wb-tmp/sec2r/app`) and did not modify the worktree. I re-ran the original PoCs against the branch. The
PoC files were copied into the clone. The `knowngood` PoC no longer compiles because that API was replaced, so I
reviewed that change by reading the code instead. The owner's VM test `recovery-tpm` was run with KVM from
`nix build .#checks.x86_64-linux.recovery-tpm.driver`. `go test -race -count=1 ./helper/... ./manager/...
./release-tools/... ./recovery/... ./provisioning/...` passes on the branch (exit 0).

### Verdicts

| ID | Verdict | Evidence |
|---|---|---|
| C-1 | **fixed** (see N-3 for hardening) | No getty or autologin on any VT or serial line, no emergency shell, SysRq off. The only session is the tty1 menu service (`Restart=always`); every action except status, restart and power-off first checks the recovery key against the data volume with `cryptsetup --test-passphrase`, and the key is passed on stdin. The recovery UKI is not in the signed PCR 11 set. VM: see "VM run" below |
| H-1 | **fixed for the reported cases**; design gaps in N-1, N-2 | root: PCR 7 + device-signed PCR 11; /persist: the same + PCR 15 bound to the root volume key (`tpm2-measure-pcr=yes`, root opened first). VM: see "VM run" below |
| M-1 | fixed | PoC `TestSEC2QuarantineMarkerWrittenLast` now fails: the marker exists after the failure ("the appliance stays in quarantine"). The marker is written before `restore.Run`, and other sessions are ended after read-only is set |
| M-2 | fixed | PoC fails: "release is older than the installed release … allowDowngradeFrom". Residual: installed records that carry no versions are not compared (N-5) |
| M-3 | fixed | Recovery execs `bin/whombat-manager` of a store path reported by the helper's records (TUF-verified tuple). The path must be directly under `/nix/store` and resolve inside it, and nothing under /persist is executed |
| M-4 | fixed | PoC fails: "path outside the checkpoint layout: source …" |
| M-5 | fixed (by reading the unit config; not run in a VM here) | The backup units get an empty read-only tmpfs over `/persist/identity` (only the public files bound in) and over `/var/lib`, plus other units' credentials and `/boot` made inaccessible |
| L-1 | fixed | PoC fails: a second checkpoint is taken after the resume |
| L-2 | fixed | PoC fails: `rollback_refused: rt-1 was withdrawn by release custody` |
| L-3 | fixed | PoC fails: `bad DNS server` |
| L-4 | fixed | Nix assertion (prod root must not share key ids with the committed development roots) plus a key-id blocklist in `trust`, and the dev keys moved out of the served fixtures |
| L-5 | fixed | Factory reset removes the helper `state.json` |
| L-6 | fixed | `safeopen`: `openat2(RESOLVE_NO_SYMLINKS)` (walk fallback), `O_NONBLOCK`, regular files only |
| I-1 | addressed | chrony with NTS, and the helper floor also rises from `timestamp.expires − 7 d` |
| I-2 | addressed | The kit carries a head, and restore reports withheld checkpoints |
| I-3 | addressed (see N-4) | ECIES (X25519 + HKDF-SHA256 + AES-256-GCM, magic bound as AAD) to the station key. Clear cards are rendered in `/run` only. Construction reviewed and sound |

### New findings

**N-1 (medium): the PCR 11 signer signs whatever boot stubs are on the ESP, so removal is not revocation.**
`helper/pkg/tpmpolicy/tpmpolicy.go:149-163, 177-242` (`Stubs`/`Sign`) and `nix/modules/storage.nix` (`whombat-tpm-sign`,
run after every `lzbt install` and at every boot) take the list of generations from the ESP directory. The ESP
is unencrypted. The signer checks that thin-stub kernel and initrd files match the stub's hashes, but it doesn't
check that a stub is one of the generations this device installed (the system profile or the helper's
activation records). A systemd-measure PCR policy signature also has no expiry or revocation. So an older
generation of this device that is signed by the device's db key keeps being able to unseal the disks after it has
left the ESP, and the signer re-signs it if it reappears there. NX-12 says the opposite: "revoking one = removing
it from the ESP (it is not re-signed)". Under Secure Boot, PCR 7 still limits this to images this device signed,
so it is about rolling back to old generations, not about foreign images.
**Fix (owner: nixos/helper):** build the signed set from root-owned state rather than the ESP: the generations in
`/nix/var/nix/profiles/system-*-link` (or the helper's host records), whose stubs lanzaboote renders. Refuse to sign
any other stub. Treat revocation of a generation as rotating the policy key (re-enrol, re-sign the kept set) or
use an NV-index-based policy (`systemd-pcrlock`) once available. Correct NX-12.

**N-2 (low): every boot phase is signed, including `ready`.** The signed set covers `enter-initrd`,
`leave-initrd`, `sysinit` and `ready`. Any root process in the running system can therefore use the TPM to unseal.
NX-12 lists this as a residual. The usual hardening is to sign only the `enter-initrd` phase for disk unlock, so
the key is unavailable once the initrd is left. This review recommends that, because nothing needs the disk keys
after boot. Owner: nixos.

**N-3 (low): harden the recovery menu's environment.** I found no path to a shell. `systemd-cryptenroll` opens a
pager only for `--help`, and pagers started from a system service run in systemd's secure mode. Two small changes
remove the dependence on those details:
- set `SYSTEMD_PAGER=cat`, `PAGER=cat` and `SYSTEMD_PAGERSECURE=1` in `whombat-recovery-menu.service`;
- print file names found on the attached disk (the kit list) through a filter that strips control characters, so
  a crafted file name cannot rewrite the console.

Owner: nixos.

**N-4 (low): card sealing is enforced only in the station path.** The `station` command refuses prod without
`cardRecipient`, but `provision.Options` (the `provision --env prod …` path) does not, and there the cards are
written in the clear to `--card-dir`. Move the check into `Options` validation. Owner: provisioning.

**N-5 (info):** `CheckForward` skips components whose installed version is unknown. Helper records written before
this change carry no versions, so a device upgraded from an older helper is not downgrade-protected until its next
activation. Seed the versions from the verified tuple when a record lacks them. Owner: helper.

**N-6 (info): one signature file on the ESP is a single point of availability.** A torn or corrupted
`EFI/whombat/tpm2-pcr-signature.json` makes every generation ask for the recovery key at the console. Keep the
previous file as a fallback that the initrd unit tries, and check the new file parses before replacing it. The
write is tmp + fsync + rename on vfat, which is not journaled. Owner: nixos.

**PCR 7 change:** both volumes fall back to the recovery key. Re-sealing is available only through the key-gated
menu, and it restores PCR 15 binding for /persist at the next normal boot. Behaviour is as documented. Which PCR 7
changes happen in practice is hardware-only (HQ-TPM).

### VM run (owner's `recovery-tpm`, KVM)
All nine subtests passed (driver exit 0, run log `~/.cache/wb-tmp/sec2r/rt-run.log`):
- The normal boot seals root to PCR 7 + signed PCR 11, and /persist additionally to PCR 15.
- A new generation installed by `switch-to-configuration boot` is signed at install time and unlocks without the
  recovery key.
- In the signed recovery UKI the TPM refuses both volumes (`TPM-PROBE root/persist: refused`).
- tty2–tty6 give no shell: the typed commands never reached the scratch disk, and the screenshot shows only the
  menu on tty1.
- A wrong recovery key is refused, and the export works with the right key.
- Positive control: a slot bound to PCR 7 only does unseal in the recovery environment (the probe sees
  `UNSEALED`). This shows the probe would have noticed a working unseal, and that the signed PCR 11 policy is
  what stops it.
- A swapped-in root volume does not get /persist (`PERSIST-PROBE: not opened`).

My own C-1 PoC (`sec2-recovery-tpm`) is replaced by this test, which covers the same console paths and also
checks unsealing.

### Summary of the re-review
All 16 original findings are fixed or addressed. New: medium 1 (N-1), low 3 (N-2, N-3, N-4), info 2 (N-5, N-6).
Before production, N-1 should be fixed (sign only the generations recorded in root-owned state, and revoke by
rotating the policy key), along with N-2 (sign only the `enter-initrd` phase). Everything about real PCR values,
firmware, dbx updates and power loss remains hardware-only.

---

## Re-review 2 (commits ccaf47c…96a90c5 on `security-fixes-2`)

Reviewer: W4-SEC (independent). Date: 2026-09-25. I reviewed a scratch clone (`~/.cache/wb-tmp/sec2r/app2`) and did
not modify the worktree. The updated `recovery-tpm` VM test was run once with KVM: all 11 subtests passed, exit 0,
log `~/.cache/wb-tmp/sec2r/rt2-run.log`. The subtests cover N-6 (second copy used), N-1 (a generation removed from
the profile no longer unlocks after the key rotation), the recovery UKI being refused, no shell on tty2–tty6, the
positive control, and a swapped root being refused.

| ID | Verdict | Notes |
|---|---|---|
| N-1 | fixed | `Sign` accepts only stubs whose command line is exactly `init=<top>/init <top/kernel-params>` for a system in `/nix/var/nix/profiles/system-*-link` (root-owned), with the ESP kernel and initrd equal to that system's files. Revocation rotates the policy key (a `signed.json` record is written before signing, and the rotation is resumable). VM-verified. Residual (documented): a generation still in the profile keeps unlocking, and there is a window of seconds to 6 h between a removal and the next reseal run |
| N-2 | fixed, but see N-7 | Only `enter-initrd` is signed. Re-enrolment now uses a per-volume maintenance keyslot |
| N-3 | fixed | The menu unit sets `SYSTEMD_PAGER=cat`, `PAGER=cat`, `SYSTEMD_PAGERSECURE=1` and `LESSSECURE=1`. Disk names, labels and kit names are passed through a filter that strips C0 characters and DEL and caps them at 120 bytes |
| N-4 | fixed | `provision.Options` refuses prod without `CardRecipient` (`ErrClearCardsInProd`), for every caller |
| N-5 | fixed | A record without versions is backfilled from its verified tuple. If that tuple can't be resolved, the helper refuses unless custody lists the installed release in `allowDowngradeFrom` |
| N-6 | fixed | Two validated copies on the ESP; the initrd uses the first one that passes `whombat-tpm-policy check`. VM-verified with a damaged first copy |
| (d) provisioning unit | acceptable | `wantedBy` the medium instead of `bindsTo`, so a re-announced device no longer kills a running provisioning. `ConditionPathExists=!device.json` still prevents a second provisioning, and a removed medium fails and runs the existing cleanup. No security change |

### Maintenance keyslot (N-2): scrutiny
- **Storage:** `/var/lib/whombat-storage/maint-<volume>.key` holds 48 random bytes (base64). The file is 0600 root
  (umask 077, VM-asserted) in a 0700 StateDirectory on the encrypted root. It is written as `.new`, then moved into
  place once the keyslot exists, so it is crash-safe.
- **Exposure:** it is passed to cryptenroll through `NEWPASSWORD` or `--unlock-key-file` and is never logged.
  Backup units see an empty read-only `/var/lib` (M-5), and checkpoint sources don't include `/var/lib`, so it is
  not in backups. The recovery environment has no shell, and the menu opens root only after the recovery key.
- **H-1/C-1:** not weakened for the reported cases. A swapped-in root volume doesn't contain the key. The recovery
  UKI can't unseal root. /persist's key stays behind the real root, which is equivalent to the PCR 15 binding.
- **Factory reset / RMA:** a factory reset creates the new /persist with a new maintenance key (the old /persist
  and its slots are erased). `secure-erase --all` erases root, and the keys with it. **But see N-7.**

### New finding

**N-7 (medium): after a customer factory reset, the previous owner's disk recovery key still opens the system
volume, and the system volume now holds the new /persist's maintenance key.**
- A factory reset (`nix/packages/appliance-tools/default.nix` `whombat-factory-reset`, recovery menu option 4) erases
  and recreates only `whombat-persist`.
- The root volume keeps the old owner's recovery passphrase slot. Nothing removes it: provisioning only adds the new
  recovery key (`provisioning/cmd/whombat-provision/main.go` `EnrollRecovery`), and `WipeRecovery` runs only as
  rollback of a failed enrolment.
- Since N-2, root contains `maint-whombat-persist.key` for the new volume. Before N-2, opening root did not give
  /persist. Now anyone holding the previous card and physical access can open root with it, and root holds the key
  to the new owner's /persist.
- This matters in the transfer path the runbook allows (factory reset, then re-provisioning with a station sent to
  the new owner) and for any re-provisioning after a reset.
- **Evidence:** analysis only. There is no removal code, and `install-boot-luks` only asserts that the old key no
  longer opens /persist. Not VM-demonstrated.
- **Fix (owner: nixos/provisioning):** in `whombat-factory-reset` (which has the typed key), remove that key's slot
  from `whombat-root`. More robustly, at provisioning wipe every passphrase slot on root other than the maintenance
  slot before enrolling the new recovery key, and rotate `maint-whombat-root.key`. Add a VM assertion that the old
  recovery key no longer opens `whombat-root` after reset + re-provisioning.

Summary: N-1 to N-6 are fixed. One new medium finding (N-7). Hardware-only items are unchanged.
