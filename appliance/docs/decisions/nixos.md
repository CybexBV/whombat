# NixOS appliance host (workstream W2-NX, branch `nixos`)

Decisions `NX-nn` refine MA-03, MA-10 … MA-14 (`docs/implementation/architecture.md`) and never override
them. Files: `flake.nix`, `flake.lock`, `nix/**`, `provisioning/**`, `vm-tests/**`, runbooks
`docs/runbooks/{hardware-qualification,provisioning,factory-reset,rma}.md`.

## NX-01 Pinned stable Nixpkgs: `nixos-26.05`
`flake.lock` pins `github:NixOS/nixpkgs/nixos-26.05` at `c508844df6c28fa6dabc1b6af70f3ccbd65c5201`
(2026-09-24; `.version` = 26.05; systemd 260.4, PostgreSQL 17, Go 1.26.7). 26.05 is the current stable
release on 2026-09-25 (26.11 is not released). No input follows `nixos-unstable`; lanzaboote's `nixpkgs` input
`follows` ours, so every package — including lanzaboote's Rust tool and stub — is built from the pinned
revision. Bump deliberately (`nix flake update nixpkgs`) and re-run every check; a bump is a host (class 2)
release.

## NX-02 Outputs
`nixosConfigurations.appliance-x86_64` (the device system), `appliance-dev-x86_64` (plain-storage dev image),
`appliance-aarch64` (evaluated only, NX-15), `installer-x86_64` (ISO), `recovery-x86_64` (recovery UKI).
Packages: `appliance-toplevel`, `installer-iso`, `recovery-uki`, `dev-image` (raw), `dev-image-qcow2`,
`whombat-provision`, `whombat-appliance-tools`, stand-ins, `whombat-runtime` (the real bundle, NX-41).
`checks.x86_64-linux`: VM tests, the provisioning unit tests, the toplevel build, `image-no-secrets`, `eval-aarch64`,
`runtime-pin` (NX-42). `devShells.default`. `nixosModules.appliance`.

## NX-03 The device never builds, fetches or evaluates
`nix.settings`: `max-jobs = 0` (no local builds at all), `substituters = []`, `builders = ""`,
`allowed-users = trusted-users = [root]` (only the update helper talks to the store; manager and runtime cannot),
`require-sigs = true`, `trusted-public-keys` = `whombat.nix.trustedPublicKeys` (our release cache key; empty in
dev), no channels, empty `NIX_PATH` and registry, no experimental features, no automatic GC. Closures arrive only
as TUF-verified `nix-store --export` streams that the helper imports (MA-11); the flake is evaluated and built
centrally. Nothing on the device evaluates project Nix, and root never runs `nixos-rebuild`.
**VM finding (recorded in V-NX):** `nix-store --import` is exercised by `install-boot-luks` against this
configuration; see its result for whether `require-sigs` affects the import path.

## NX-04 Boot counting on 26.05: lanzaboote's native counting, not a systemd-boot backport
Checked in the pinned tree: `nixos/modules/system/boot/loader/systemd-boot/` has no boot-counting code
(`systemd-boot-builder.py` 452 lines, no `bootCounting` option); nixos-unstable (26.11 pre-release) has
`boot.loader.systemd-boot.bootCounting` and its release notes (`rl-2611`) announce it. So 26.05 has no upstream
integration. Options considered: (a) vendor the unstable systemd-boot module + builder (688 lines, it also
renames every entry to `nixos-<hash>.conf`) as a backport; (b) our own loader-entry writer; (c) lanzaboote
v1.1.0, which we need anyway for Secure Boot (NX-11) and which **replaces** the systemd-boot installer — so (a)
would never run on a Secure Boot device. Lanzaboote v1.1.0 (tag, 2026) ships `boot.lanzaboote.bootCounting.
initialTries` (UKI names `nixos-generation-N-<hash>+T.efi`, systemd-boot decrements, `systemd-bless-boot`
removes the counter) with its own VM test. Decision: **(c)**, pinned by tag in `flake.lock`, built against our
nixpkgs. When 26.11 is adopted, nothing changes (lanzaboote remains the installer). Qualification: our
`install-boot-luks` VM test (candidate never blessed → known-good after N attempts) plus the hardware procedure.

## NX-05 Meaningful local blessing, bounded attempts, known-good ordering
- New generations get `whombat.boot.tries` (default 3) attempts. The factory generation is pre-blessed by the
  installer (it passed factory QA), so a device always has one blessed entry.
- `whombat-boot-assessment.service` (runs every boot after `multi-user.target`, `DefaultDependencies=no` to
  avoid an ordering cycle) is `RequiredBy=boot-complete.target`, which `systemd-bless-boot.service` requires.
  It passes only when, continuously for `settleSec` (60 s): PostgreSQL is active with its socket, the
  manager is active with zero restarts, server/runner/PostgreSQL have zero restarts, and the runtime's local
  `/health` says `ok` **including its own database query** (`checks.db.ok`). Relay, control and providers are
  never part of it (MA-11, no paid probes). Timeout `assessmentTimeoutSec` (900 s).
- On failure, `whombat-boot-failed.service` reboots **only** if the booted entry is still counted
  (`LoaderBootCountPath` EFI variable present), so the next attempt or the known-good entry follows unattended;
  on a blessed entry it never reboots (no loops; the manager decides).
- systemd-boot sorts entries whose counter reached `+0` after all others, so the newest blessed generation (the
  known-good) boots. `configurationLimit = 8` on a 1 GiB ESP. **Manager obligation:** delete a failed
  candidate's system generation before staging another, so a run of bad candidates can never push the
  known-good generation off the ESP.
- The helper's `bless-boot` op runs `systemd-bless-boot good` too (idempotent); it records the host activation
  in the helper's state. Both paths agree because both require the booted entry to be the pending one.
- A manager binary broken by a host update keeps the assessment failing (manager not active or restarting), so
  boot counting returns to the generation with the previous manager (MA-11 "known-good recovery survives a
  broken manager").

## NX-06 Persistent-state layout (MA-12) and root filesystem
`/persist` is its own filesystem; owners/modes enforced by `systemd-tmpfiles` (`d` entries: fixes the directory
itself, never recursive) on every boot:

| Path | Owner | Mode |
|---|---|---|
| `/persist` | root:root | 0755 |
| `identity/` | root:root | 0711 (traverse, not list) |
| `identity/management.key` | whombat-manager | 0600 (PKCS#8 PEM Ed25519) |
| `identity/content.key` | root | 0600 (libp2p protobuf Ed25519; runtime via `LoadCredential`) |
| `identity/claim.json` | root | 0600 (claim secret hash; runtime via `LoadCredential`) |
| `identity/device.json`, `management.pub`, `content.peerid` | root | 0644 (public) |
| `postgres/17/` | postgres | 0700 |
| `whombat/home/` (WHOMBAT_HOME) | whombat | 0700 |
| `whombat/workspaces/` | whombat-runner:whombat-workspaces | 2770 |
| `whombat/credentials/` | whombat-runner | 0700 (`<account>/<provider>/` by the runtime) |
| `manager/` | whombat-manager | 0700 (journal, tuf-mirror, staging, assignment.json, network-candidates, known-good) |
| `backup/` | root | 0700 (W3-BK decides the service user) |
| `secrets/master.key` | root | 0600 (base64 32 bytes; server via `LoadCredential`) |

MA-12's "0700 manager/runtime split" is implemented per file: root-owned secrets reach the runtime only through
systemd credentials (`$CREDENTIALS_DIRECTORY`, never environment or store); only the management key is owned by
its service user because the manager's loader requires owner = euid.
**Root is not ephemeral.** The root filesystem (encrypted, NX-07) holds `/nix`, profiles, `/var/log`,
`/var/lib/{sbctl,whombat-update-helper,whombat-storage,nixos,systemd}`. An impermanent root would need a
persisted list of every stateful path (helper state, Secure Boot keys, timesync clock, journal) and adds a boot
mechanism with its own failure modes for no gain here: root has no customer data and is encrypted. Factory reset
cleans the few root paths that hold customer-adjacent metadata (committed network, journal).

## NX-07 Disk layout and installation
GPT: `whombat-esp` (vfat, 1 GiB), `whombat-root` (LUKS2 → ext4, 40 GiB default), `whombat-persist` (LUKS2 →
**btrfs**, rest). `/persist` is btrfs so the backup service takes millisecond read-only subvolume snapshots
inside its quiesce instead of pausing writes for a full copy (BK-04): `whombat/home`, `whombat/workspaces`,
`whombat/credentials`, `secrets`, `manager` and `backup` are subvolumes (created idempotently on every boot by
`whombat-persist-layout.service`, before tmpfiles; existing plain directories are left alone and logged),
`postgres` is its own subvolume with copy-on-write disabled (`chattr +C`) for the database files. Mount options
`noatime,nosuid,nodev,user_subvol_rm_allowed` (the runner may delete per-task subvolumes it creates). Both LUKS volumes are created on the device by `whombat-install` (installer image) with a random
bootstrap key that is wiped after a TPM2 token is enrolled — the image contains no volume key. Root is encrypted
too: with a plain root, anyone with the disk could replace a store path and the TPM would still unseal
`/persist` for the modified system. `/persist` is separate so factory reset/secure erase destroy customer data
without reinstalling. The dev image (`appliance-dev-x86_64`, `whombat.storage.mode = "plain"`, refused for
prod) is prebuilt with systemd-repart for trying the host in QEMU.

## NX-08 Fixed ids
`whombat-manager` 950, `whombat` 951, `whombat-runner` 952, group `whombat-workspaces` 953; sandbox range
2000000 + 65536 as subordinate ids of `whombat-runner`. Fixed so that a fallback generation reads the same
`/persist`.

## NX-09 See NX-03.

## NX-10 No remote login, no support account
No SSH daemon, no sudo, root password locked (`!`), `users.mutableUsers = false`,
`users.allowNoPasswordLogin = true` (deliberate). The console shows a banner only. The only interactive path is
the signed recovery environment at the local console (NX-13), and every data-touching action there needs the
customer's disk recovery key. There is no vendor key or account that can log in, locally or remotely. *Since NX-411
(2026-10-21): none that works without an owner's grant — remote help lets Whombat support in for a limited time when an
owner turns it on.*

## NX-11 Secure Boot: lanzaboote with per-device keys
Lanzaboote v1.1.0 supports our pinned release (built against 26.05; `boot.lanzaboote.*`). Keys (PK/KEK/db) are
generated **on each device** at its first boot (`autoGenerateKeys`, `sbctl`) into `/var/lib/sbctl` on the
encrypted root and enrolled by systemd-boot while the firmware is in setup mode (`autoEnrollKeys`, Microsoft
keys included for option ROMs). No fleet signing key exists on devices or in the store; the device signs the
generations the helper installs. Consequences: offline store tampering needs the root volume key (NX-07); a
root compromise can sign — but root already reads everything. The factory must leave firmware in setup mode and
lock the firmware setup with a password (hardware runbook). Real enforcement is hardware-qualified only.

## NX-12 TPM2 unlock policy, recovery key, capacity reservation
- `whombat-install` enrols TPM2 tokens **without** PCRs (firmware still in setup mode, PCR 7 not final).
  `whombat-tpm-seal.service` (`ConditionSecurity=uefi-secureboot`) re-enrols both tokens once Secure Boot is
  enforced (marker `/var/lib/whombat-storage/tpm-seal`, `v2 …`). **Policy since W4-SEC part 2 (H-1, MA-21b):**
  - *root*: PCR 7 (literal: Secure Boot state and the db authority) **and** PCR 11 under a policy signed by the
    device's own RSA-2048 policy key (`/var/lib/whombat-storage/pcr-policy.key`, generated on the device, root-only,
    on the encrypted root). lanzaboote v1.1.0's stub measures the UKI sections into PCR 11 exactly like
    systemd-stub (kernel and initrd *files* for its thin `.linux`/`.initrd`), and pcrphases are enabled in initrd
    and system. lanzaboote has no `.pcrsig` support and its pcrlock integration covers PCRs 0–7 only, so the device
    signs itself: `whombat-tpm-policy sign` signs **only the generations of the root-owned system profile**
    (`/nix/var/nix/profiles/system-*-link`): an ESP stub is signed only if its command line is exactly
    `init=<system>/init <system's kernel-params>` and the kernel and initrd it loads are that system's (hashes);
    any other stub on the (unencrypted) ESP is refused (re-review N-1). It signs **only the `enter-initrd`
    phase** (N-2): the TPM releases the disk keys in the initrd and never after it. It runs after every
    `lzbt install` (lzbt is wrapped: `whombat.boot.lzbtPackage`) and in `whombat-tpm-seal` (every boot, and
    `whombat-tpm-reseal` whenever `/nix/var/nix/profiles` changes, plus a 6-hourly timer). The document goes to
    `/boot/EFI/whombat/tpm2-pcr-signature.json` and a second copy `…signature.copy.json`, each validated and
    written tmp + fsync + rename; the initrd unit validates (`whombat-tpm-policy check`) and uses the first valid
    copy (N-6), after `enter-initrd` and before cryptsetup. The recovery UKI is never signed.
  - *persist*: the same, **and** PCR 15 as it is right after the root volume was opened: the root's crypttab has
    `tpm2-measure-pcr=yes` (HMAC of the root volume key extended into PCR 15), `/persist` is opened after root, and
    the expected value comes from the userspace measurement log (`whombat-tpm-policy pcr15`, which refuses if
    anything was measured into PCR 15 first). A swapped-in root volume therefore never gets `/persist`.
  - **Revocation = rotating the policy key** (N-1). A signature has no expiry, so removing a stub from the ESP
    revokes nothing. `signed.json` records every system each key signed (written *before* signing, under a lock).
    When a signed system is no longer in the profile (a generation was deleted, e.g. by the helper's
    `prune-host-generations`), `whombat-tpm-seal` creates `pcr-policy.next.key`, signs the kept generations with
    both keys, re-enrols both TPM slots to the next key (each enrolment adds the new slot before wiping the old),
    renames the next key over the current one and re-signs with it alone. Every step is resumable: a crash leaves
    documents signed by both keys and at least one working slot per volume. After the rotation no token trusts the
    old key, so no old signature (on the ESP, in a copy an attacker kept) unlocks anything.
  - **Maintenance keyslots.** Because the running system cannot unseal (N-2), re-enrolment (first seal, rotation,
    adding PCR 15 after a recovery re-seal, provisioning's recovery-key enrolment) unlocks with a per-volume
    maintenance key, `/var/lib/whombat-storage/maint-<volume>.key` (0600 root, on the encrypted root; a passphrase
    slot). `whombat-tpm-seal` creates it while the TPM slot is still unbound/PCR 7 (the first sealed boot);
    `whombat-storage-init --maint-key-file` creates it for a new /persist (factory reset). It gives only what root of
    the running system already has (both volumes are open) and is gone with a factory reset / secure erase.
    Devices sealed by the first H-1 build (all phases signed) get it on their next boot, from the TPM slot that
    still unseals under the old signature.
  - Enrolment without the running system's TPM: factory reset and the recovery menu use
    `whombat-tpm-enroll-args` (unbound without Secure Boot or before the device has a policy key; from the recovery
    environment /persist gets PCR 7 + signed PCR 11 and the next normal boot adds PCR 15 with the maintenance key).
  - Residual limits: an attacker who runs code in the normal boot's initrd owns the device; a generation left in
    the profile keeps unlocking (keep the profile short: `configurationLimit`, helper pruning); between a
    generation's removal and the next `whombat-tpm-reseal` run (seconds with the path unit, at most 6 h) it still
    unlocks. Real PCR 7/11 values, option ROMs, dbx updates and TPM behaviour are hardware-only (HQ-TPM); a PCR 7
    change (db/dbx update) makes the console ask for the recovery key and the recovery menu re-seals.
  VM-verified: `install-boot-luks` (seal, maintenance slots, update to a new generation, fallback, factory reset)
  and `recovery-tpm` (no TPM unseal in the running system, damaged document → second copy, recovery UKI refused,
  positive control with a PCR-7-only slot, a generation deleted from the profile no longer unlocks after the
  rotation, swapped root refused).
- Disk recovery key: 256-bit, systemd modhex format, generated by `whombat-provision` on the device, enrolled as
  a passphrase keyslot on both volumes, printed on its own card (separate from the claim card). Not stored
  anywhere else. Rotation after claim needs a helper op (open item).
- Initrd: a password prompt times out after 300 s and the initrd reboots instead of waiting at an unusable
  emergency shell, so an unattended device keeps cycling to the known-good entry (or keeps asking at the
  console for the key).
- Capacity: btrfs quotas. Every subvolume except `postgres` is in qgroup `2/100` (since NX-150; `1/100` before it),
  limited to the filesystem size minus `whombat.storage.persistReserveMiB` (4 GiB, at least 5 %): Whombat's own
  subvolumes through `1/100`, the agents' computers through `1/101` (their own limit, NX-150). Staging, workspaces,
  home, credentials, secrets, backup or the computers filling up therefore get `EDQUOT` while PostgreSQL keeps writing
  (VM-verified, `appliance-basic`; the computers' part in `computers`). Counts btrfs calls inconsistent are rescanned
  at once (`whombat-qgroups`, NX-150): until a rescan btrfs counts no writes against any limit. This replaces the ext4 reserved-blocks grant of the first layout. Root and `/persist` are
  separate filesystems; journald is capped on root (NX-16). The manager still checks capacity before staging.
  Per-task workspace quotas (W3-SBX): quotas are on and workspaces is a subvolume; a per-task subvolume with its
  own qgroup limit needs CAP_SYS_ADMIN for the limit, so it needs a typed root operation (open item).

## NX-13 Signed recovery environment
`recovery-x86_64`: a netboot-style NixOS (whole system as squashfs in the initrd) packed into one UKI
(`ukify`), installed as `EFI/Linux/whombat-recovery.efi` (lanzaboote garbage-collects only `nixos-*` there)
and signed with the device's db key by `whombat-recovery-install.service`. Chosen by holding Space at power-on
(timeout 0, editor off). **Since W4-SEC part 2 (C-1, MA-21a):** there is no login anywhere — no getty on any VT or
serial line (`getty@`, `serial-getty@`, `container-getty@` masked, logind `NAutoVTs=0`, `ReserveVT=0`), no
autologin, no emergency/rescue shell, root locked, SysRq off. The only interface is `whombat-recovery-menu`, a
systemd service on tty1 (`StandardInput=tty-force`, restarted on exit): export this appliance's data to an
attached disk (chosen from a list, never the appliance's own; `export-disk` as the unprivileged `whombat-export`
user), verify a backup with a kit on an attached disk, re-seal the TPM slots, factory reset (typed `ERASE`),
secure erase (`ERASE EVERYTHING`), enable wired network, status, restart, power off. Every action except
status/restart/power off first asks for the disk recovery key (no echo) and checks it against the data volume;
a wrong key touches nothing. Actions are logged to the kernel log. The menu runs with `SYSTEMD_PAGER=cat`,
`PAGER=cat`, `SYSTEMD_PAGERSECURE=1`, and names read from an attached disk (labels, kit files) are shown through a
filter that strips control characters (re-review N-3; `checks.recovery-menu`). The TPM is never used there and cannot unseal
(NX-12). VM-verified in `recovery-tpm` (tty2–tty6 give no shell, wrong key refused, export works with the key).

## NX-14 Runtime and manager wiring (class 1 updates)
See NX-20/NX-23. Runtime units run from `/nix/var/nix/profiles/whombat-runtime` (seeded once from
`whombat.runtime.package`); the helper switches the profile and restarts `whombat-runtime.target`.

## NX-15 aarch64
`appliance-aarch64` is evaluated in `checks.eval-aarch64` (forces the full system derivation) but not built or
VM-tested here (no aarch64 builder); hardware selection (X-04) decides whether it matters.

## NX-16 Logging
journald persistent on root, `SystemMaxUse=512M`, `SystemKeepFree=1G`, 30 days, 2000 msgs/30 s per service;
core dumps disabled (`systemd.coredump.enable = false`, `core_pattern` → false, `LimitCORE=0`); PostgreSQL logs no
statements, parameters or connection lines. Content-free logging inside the runtime is the runtime's duty.

## NX-17 Time
chronyd with **NTS** (authenticated NTP, RFC 8915; W4-SEC part 2 I-1) against NTS-capable servers
(`time.cloudflare.com`, `nts.netnod.se`, `ptbtime1.ptb.de`, `ntppool1.time.nl`); NTS-KE (TCP 4460) is allowed for
chronyd's uid only, NTP UDP 123 as before. `whombat-clock-floor` (hourly) touches
`/var/lib/systemd/timesync/clock` while chrony is synchronised: PID 1 never starts the clock before its mtime (a
board without RTC battery never starts before the last good time). TUF freshness uses the helper's own time floor
(MA-11), which also rises from verified timestamps (`expires − 7 d`, MG-25), so neither a stale clock nor a
spoofed time source makes expired metadata acceptable. Limit: NTS needs working TLS to the NTS-KE servers (CA
store, reasonable clock); a device whose clock is far off and whose RTC is lost relies on the floors. Hardware
qualification checks RTC loss.

## NX-18 PostgreSQL 17
Data in `/persist/postgres/17` (major in the path; major upgrades are a separate manager-driven class, MD-09).
`listen_addresses = 127.0.0.1,::1`, `local whombat whombat peer`, `local all postgres peer`, loopback
`scram-sha-256`, nothing else; `IPAddressDeny=any` except localhost; `fsync`/`synchronous_commit` on.
Runtime connects as `postgresql://whombat@/whombat?host=/run/postgresql`.

## NX-19 Slices
`whombat-critical.slice` (PostgreSQL, manager, server): CPUWeight/IOWeight 1000, `MemoryMin=MemoryLow=1G`,
oomd avoid. `whombat-tasks.slice` (runner and sandboxes): weight 50, `MemoryHigh=70%`, `MemoryMax=80%`, no
swap, `TasksMax=8192`, oomd kills on pressure; optional CPUQuota. Knobs under `whombat.slices.*`.

## NX-20 Runtime bundle contract (for W2-RT's packaging)
A bundle is a store path with `bin/whombat-server` and `bin/whombat-runner`. Units: `whombat-server`
(User whombat, critical slice, `RuntimeDirectory=whombat` 0711 for `/run/whombat/admin.sock`) and
`whombat-runner` (User whombat-runner, tasks slice, cgroup delegation), both `PartOf=whombat-runtime.target`,
`Restart=always`, hardened (`ProtectSystem=strict`, empty capability set, `@system-service` filter, etc.),
`Type=notify` + `WatchdogSec=30` (set `whombat.runtime.watchdogSec = null` until the runtime sends
`WATCHDOG=1`). Environment: `WHOMBAT_MODE=managed`, `WHOMBAT_ENV`, `WHOMBAT_HOME=/persist/whombat/home`,
`WHOMBAT_WORKSPACES`, `WHOMBAT_CREDENTIALS_ROOT=/persist/whombat/credentials`,
`WHOMBAT_MANAGER_SOCKET=/run/whombat-manager/api.sock`, `HOST=127.0.0.1`, `WHOMBAT_RELEASE_ID` (from the
helper's activation record for the profile in use, else `factory`; written by an `ExecStartPre=+` into
`/run/whombat-release/env`), `WHOMBAT_ADMIN_SOCKET=/run/whombat/admin.sock`,
`WHOMBAT_DEVICE_FILE=/persist/identity/device.json`, `WHOMBAT_CONTENT_PEER_ID_FILE`,
`WHOMBAT_PROVIDER_PROFILES=/nix/var/nix/profiles` (providers at `whombat-provider-<name>`),
`DATABASE_URL=postgresql://whombat@/whombat?host=/run/postgresql`, `NODE_ENV=production`; server only:
`WHOMBAT_MASTER_KEY_FILE=%d/master-key`, `WHOMBAT_CONTENT_KEY_FILE=%d/content-identity`,
`WHOMBAT_CLAIM_FILE=%d/claim` (the systemd credential copy of `/persist/identity/claim.json`, which stays
root-only). Runtime MR-37 (2026-09-25): `NotifyAccess=all` on both units (Node notifies through a
`systemd-notify` child); `runner-token` credential for both (`RUNNER_TOKEN_FILE=%d/runner-token`; 32 random bytes
as hex in `/persist/secrets/runner-token`, 0600 root, made by provisioning, or once by `whombat-runner-token` on
devices provisioned before); `WHOMBAT_SIGNIN_SOCKET=/run/whombat/signin.sock` for both (`/run/whombat` is 2751
`whombat:whombat-admin`: only the server's user writes there, the runner traverses; MR-34); `PUBLIC_URL` is not
set (not required in managed mode); `WHOMBAT_QUARANTINE_FILE=/persist/backup/quarantine.json` (BK-13, M-1); `WHOMBAT_APP_URL` and `WHOMBAT_BACKUP_SOCKET` (NX-30); server only, `WHOMBAT_CONSOLE_FILE=/run/whombat/console/console.json` (write it atomically in that directory, `chmod 0640`, no `chown`: NX-32; `claim.json`'s `secretHash` may be `null` on a self-installed appliance, NX-33). Migrations are never run by the server in managed mode: the helper's `migrate-runtime` runs the
bundle's `bin/whombat` as the runtime user (MD-10). Units don't start before provisioning (`ConditionPathExists=device.json`).
The runtime's admin socket (`/run/whombat/admin.sock`, create it 0660 inside the setgid directory) must
accept the manager uid; the boot assessment also runs as `whombat-manager`. Until the real bundle exists the stand-in (`nix/packages/standins`) provides the
operational surface only and is refused for prod.

## NX-21 Sandbox prerequisites (W3-SBX builds on these; MS-16 and the MS "NixOS nftables design")
Runner unit: `Delegate=cpu memory pids`, `KillMode=control-group` (a crashed runner's task sub-cgroups die
with it; VM-verified), environment `WHOMBAT_SANDBOX_CGROUP=delegated`, `WHOMBAT_SANDBOX_BWRAP`,
`WHOMBAT_RUNNER_STATE=/persist/whombat/runner`, `WHOMBAT_SANDBOX_RO_PATHS` = `whombat.sandbox.toolchain` (a
`buildEnv` of the qualified tools: bash, coreutils, git, node 22, pnpm, python3, make, …, part of the host
generation), limits `WHOMBAT_SANDBOX_{MEMORY_MB,PIDS,CPU_WEIGHT,TMP_MB,OUTPUT_MB,WALL_MINUTES}`,
`WHOMBAT_SANDBOX_EGRESS_ALLOW`, `WHOMBAT_SANDBOX_GRANTS` (from `whombat.sandbox.{limits,egressAllowHosts,grants}`).
**Wall** (`table inet whombat_runner`): loaded by the runner's `ExecStartPost=+` once its cgroup exists (nft
resolves cgroup paths at load time) and removed by `ExecStopPost=+`. Packets from sockets in
`whombat.slice/whombat-tasks.slice/whombat-runner.service` (level 3 — `-` in slice names nests) jump to a chain
that allows the runtime server on loopback and the resolver stub, granted CIDR:ports, then rejects the denied
IPv4/IPv6 sets (private, CGNAT, link-local, metadata, ULA, NAT64/6to4/Teredo, multicast) and anything but TCP
80/443. Only an equality match is used: `level N != …` does not match sockets in shallower cgroups and would
have caught every other unit. Grants also open the host egress table for the runner uid.
Previously listed prerequisites:
Unprivileged user namespaces on; bubblewrap on the runner's PATH; `whombat-sandbox-prereqs.service` checks
userns + bwrap + subuid delegation and fails closed; runner unit: cgroup delegation, namespaces allowed,
`NoNewPrivileges=false` only while `subordinateIdMapping` needs setuid `newuidmap` (else true). nftables chain
`inet whombat-egress sandbox` receives every packet from the sandbox uid range (IPv4 and IPv6) and drops it
unless `whombat.sandbox.egressRules` accepts it (DNS included: no DNS for sandboxes by default).

## NX-22 Network
systemd-networkd (the helper's candidates are networkd units). Inbound: nothing (nixos-fw default drop, no
open ports, no ping). Outbound (`inet whombat-egress output`, policy drop): loopback, established, ICMP/ICMPv6,
DHCP, DNS, NTP, TCP `whombat.network.outboundTcpPorts` (default 443: relay, control, update mirror, provider
APIs, GitHub over HTTPS); SSH-based git is not allowed. The runtime server's uid alone may also reach the
Vault's home networks, exactly the networks and TCP ports the admins listed (NX-40).
`whombat-network-restore.service` copies the helper's committed candidate to
`/run/systemd/network/10-whombat.network` before networkd on every boot; the helper's dead-man (`systemd-run`
timer) reverts an unconfirmed candidate.
Amended by NX-440 (2026-10-24, HE-51): one inbound port, the runtime's direct port 4480, from the local network's private
addresses and on `tailscale0`; tailscaled's UDP from its own port.

## NX-23 Manager, helper and recovery units (W1-MG's layout, MG-16/MG-17)
Binaries come from the root Go module (`nix/packages/go.nix`, one vendor hash): `whombat-manager`
(+ `whombat-manager-recovery`), `whombat-update-helper`, `tufrepo`, `whombat-provision`.
- `whombat-manager.service`: `Type=notify`, `WatchdogSec=120` (`whombat.manager.watchdogSec`), User
  whombat-manager, supplementary group `whombat-admin` (runtime admin socket), critical slice,
  `Restart=on-failure`, 5 starts / 10 min, then `OnFailure=whombat-manager-recovery.service`. No dependency on
  the runtime either way. Hardened (no capabilities, `@system-service`, AF_UNIX/INET only).
- `whombat-manager-recovery.service`: `Conflicts=whombat-manager`, `Restart=always` every 30 s, runs the
  verified known-good copy or its built-in recovery daemon (MG-16).
- `whombat-update-helper.socket` (`/run/whombat-update-helper/helper.sock`, `root:whombat-manager 0660`,
  directory 0755 — MG's 0750 would lock the manager out of a root-owned directory; access is still bounded by
  the socket mode and the helper's `SO_PEERCRED` check) + `.service` (root; `NoNewPrivileges`,
  `ProtectSystem=strict` with RW `/nix /boot /run` + state dir, `PrivateTmp`, `RestrictAddressFamilies=AF_UNIX
  AF_NETLINK`, `IPAddressDeny=any`, capabilities limited to import/profile/bootloader work and setuid for
  `schema-check`/`migrate-runtime` as the runtime user, `RuntimeMaxSec=6h`, no `Restart=`).
- Generated `/etc/whombat/manager.json` (MG-17 paths: `journal/`, `tuf/{cache,mirror}/`, `staging/`,
  `assignment/current.json`, `network/{candidates,state}/`, `known-good/`, API socket
  `/run/whombat-manager/api.sock`) and `/etc/whombat/update-helper.json` (`runtimeUser=whombat`,
  `RuntimeEnvFile=/etc/whombat/runtime.env` — non-secret `DATABASE_URL` for peer auth, `RuntimeCLI=bin/whombat`,
  `BlessBootCommand=systemd-bless-boot good`, runtime units `whombat-runtime.target`). Pinned TUF root at
  `/etc/whombat/tuf/root.json` from `whombat.helper.tufRoot`. Overrides: `whombat.manager.settings`,
  `whombat.helper.extraSettings`.
- Groups: `whombat-admin` (954: manager, boot assessment → `/run/whombat` 2750 `whombat:whombat-admin`,
  `admin.sock` 0660) and `whombat-api` (955: runtime, later backup → `/run/whombat-manager` 2750
  `whombat-manager:whombat-api`, `api.sock` 0660).
- Factory (MG-20): after identity provisioning the factory unit runs `whombat-manager provision
  --factory-release <station.json factoryRelease>` as the manager user, then `whombat-update-helper
  seed-factory <id>` as root (skipped with `"seedHelper": false`, used by the VM tests whose fixture release does
  not name the booted host). Without a factory release the manager has no journal and exits, so the boot
  assessment (manager active, zero restarts) does not pass.
- Supervision beyond the budget is W1-MG's recovery unit; the earlier NixOS-side timer supervisor was removed.

## NX-24 Provisioning (`provisioning/`, root Go module, contracts 0.5.0 bindings)
Runs **on the appliance** as root: triggered by a `WBFACTORY`-labelled medium (FAT label ≤ 11 characters)
carrying `station.json` + the station token (never copied to disk), or by hand. Generates management key,
content identity (libp2p), 128-bit claim secret (26 base32 characters), master key, disk recovery key from the
kernel CRNG (`getrandom`, blocks until seeded). Registration uses contracts' `DeviceRegistration` signed by both
keys (`device.SignRegistration`, CT-18) to `POST /v1/provisioning/devices`; control assigns the device id; 409
(duplicate serial/key) aborts and removes everything generated. Claim card: appliance id, claim code, the
secure-channel **fingerprint** (`fingerprint(peerId)`, 125 bits, `XXXXX-…`, checked against the
secure-channel known-answer vector; removed from the card by NX-34) and a QR code with `https://<ui>/claim#v=1&d=<id>&p=<full PeerId>&s=<secret>`
(fragment only). Control never receives the secret. Since contracts 0.5.1 (MA-19d, CT-43) provisioning then
registers the **claim verifier** `protocol.ClaimVerifier(deviceId, normalized)` (domain tag
`whombat-claim-control/1`, distinct from the appliance's `claimSecretHash`) with
`POST /v1/provisioning/devices/:device/claim-verifier {claimVerifier}` (201, or 200 for the same value; 409
`claim_verifier_exists`) **before** writing `claim.json` or printing the card; if control does not take it,
provisioning fails and removes everything it generated (the control entry is then an orphan, as for a later
failure). Normalisation (incl. U+FEFF) is `protocol.NormalizeClaimSecret`; the contracts' claim vectors
(normalize, hash, verifier) run in `provisioning/internal/claim`.

**Claim code and `claim.json` (standard; the runtime reads it via `WHOMBAT_CLAIM_FILE`).**
- Secret: 16 bytes from the kernel CRNG, RFC 4648 base32 **without padding**, upper case → exactly 26
  characters of `A–Z2–7`. Printed grouped by four with `-` (`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX`); the QR `s`
  parameter carries the 26 characters ungrouped.
- Normalisation of any typed or scanned code (same rules as `@whombat/secure-channel`
  `normalizeFingerprint`): (1) ASCII upper-case `a–z → A–Z`; (2) remove every whitespace character (Unicode
  White_Space, i.e. JS `\s`) and every `-` (U+002D); (3) map `0 → O`, `1 → I`, `8 → B`. The result is valid only
  if it matches `^[A-Z2-7]{26}$`; anything else is rejected, never repaired (no other punctuation, no
  non-ASCII, no truncation).
- `claim.json` (0600 root, `LoadCredential=claim`):
  `{"v":1,"deviceId":"<control device id>","secretHash":"<43 chars>","algorithm":"sha256-b64url(whombat-claim-secret/1)"}`
  with `secretHash = base64url_nopad(SHA-256(UTF-8("whombat-claim-secret/1\n" + deviceId + "\n" + normalized)))`
  — `\n` is a single LF byte, `deviceId` exactly as in `device.json`. The runtime compares with a constant-time
  equality after normalising the presented code, and consumes it once (MA-04).
- Implementation: the contracts' `protocol.NormalizeClaimSecret`, `IsClaimSecret`, `ClaimSecretHash`
  (0.5.0; `provisioning/internal/claim` only delegates, and runs the vendored `testdata/vectors/claim.json`).
  Registration uses `device.SignRegistration`/`VerifyRegistration`. The claim-card fingerprint stays local
  (`ident.Fingerprint`, checked against the secure-channel known-answer vector): 0.5.0 has no Go binding for it.

**Harness/dev runs.** `whombat-provision provision --env local|dev --unprivileged --persist DIR --card-dir DIR
--manager-uid $(id -u) --manager-gid $(id -g) --allow-unmounted --require-secure-boot=false --serial DEV-0001
--control-url URL --token-file F` runs the real tool as an ordinary user into a directory (refused for prod);
`whombat-provision verify --persist DIR --manager-uid N --root-uid N` checks it. `--manager-user NAME` picks
another owner by name.
Duplicate/clone checks: identity files must not exist; `/persist` must be its own mounted filesystem; control
rejects repeated serials/keys; the image carries no machine-id, random seed, SSH host key, Secure Boot key or
identity (`checks.image-no-secrets`; the installer deletes `loader/random-seed` and machine-id); prod requires
Secure Boot enforced. `systemd-random-seed` seeds are per device because the installer creates the ESP and root
on the device; systemd-boot additionally mixes the per-machine `LoaderSystemToken` into its seed.

## NX-25 Factory reset, secure erase, refurbishment, RMA
Implemented as recovery-environment/root commands (`whombat-appliance-tools`): `whombat-secure-erase`
(`cryptsetup luksErase` of `/persist`, `--all` also root; requires the typed recovery key unless `--factory`),
`whombat-factory-reset` (secure erase + fresh TPM-sealed `/persist` + forget network/journal → unprovisioned;
since re-review 2 N-7 it also removes every keyslot of the system volume except its TPM2 slot and maintenance
slot — the previous owner's disk recovery key no longer opens root — and rotates root's maintenance key, with
`whombat-provision reset-keyslots`: the new maintenance key is added before anything is removed, the TPM2 slot is
never touched, and a rerun resumes from `maint-whombat-root.key.new`; provisioning likewise keeps only TPM2,
maintenance and the new recovery key on each volume; VM: `install-boot-luks` re-provisions after a reset),
`whombat-storage-init`, `whombat-storage-status`. Proposed typed helper operations for W1-MG (same semantics,
owner-authorized via the runtime's local command, never remote-only): `factory-reset` and `rotate-recovery-key`.
Runbooks: `docs/runbooks/factory-reset.md`, `rma.md`, `provisioning.md`.

## NX-26 VM tests (`vm-tests/`)
| Check | Covers |
|---|---|
| `appliance-basic` | unprovisioned state; MA-12 layout/owners; factory-medium provisioning on two VMs of one system (unique ids/keys, contracts-verified registration, duplicate serial refused, nothing left behind); runtime/manager/PostgreSQL healthy, slices, credentials not in env; reboot + boot assessment; no inbound (full nmap from another VM); egress allowlist and sandbox-uid drop; service watchdog; journald cap under a flood; qgroup disk-full with PostgreSQL still writing; dead-man network revert; committed network restored before networkd |
| `install-boot-luks` | installer on a blank disk (UEFI + swtpm); per-device Secure Boot keys enrolled by systemd-boot; TPM2 slots sealed to a measured PCR 7; provisioning enrols the disk recovery key (card key opens both volumes, wrong key doesn't); candidate imported from a `nix-store --export` stream and made default like the helper; candidate unlocks `/persist`, fails the assessment, falls back to the known-good after `tries` (`+0-2`); factory reset with the recovery key |
| `manager-units` | real manager/helper: factory journal (MG-20) from the dev TUF fixtures; `Type=notify`; helper socket activation, peer uid across real users (manager served, root refused, runtime can't connect); manager API socket group access; watchdog kill+restart; `OnFailure` recovery |
| `sandbox-backup` | runner `Delegate`, env, toolchain (its Python's document libraries import inside bubblewrap, NX-98); orphan in a task sub-cgroup killed on runner crash; nftables wall (private, metadata, ULA refused from a task cgroup; grant allowed; other units unaffected); backup checkpoint with the btrfs snapshot driver to `rest-server --append-only`, sealed password, DELETE → 403 |
| `recovery-tpm` | MA-21a/b: seal (root PCR 7 + signed PCR 11, /persist also PCR 15); update to a new generation signed at install and unlocking; signed recovery UKI (with a test-only TPM probe and serial kernel log): TPM refuses both volumes, tty2–tty6 give no shell, the menu refuses a wrong recovery key and exports with the right one; positive control (a PCR-7-only slot does unseal there); a swapped-in root volume does not get /persist |
| `install-proxmox-vm` | NX-50…NX-59, NX-84, NX-90…NX-92: the proxmox-vm platform end to end (the graphical installer through its API on a 128 GiB disk, read with OCR; install without LUKS/TPM, OVMF setup mode, virtio-scsi, watchdog, guest agent allow-list, self-provisioning without a disk recovery key, the claim screen straight away, an earlier image's unconfirmed key dropped at boot, host update with fallback, factory reset from the recovery menu with an earlier image's confirmed key and then with a typed ERASE) |
| `console-self` | NX-32/NX-33, NX-78…NX-84, NX-90: tty1 runs the graphical console (kiosk and server, their namespace, the token, Chromium's sandbox; the claim, backoff and claimed screens read with OCR, no key screen and no `/api/confirm`, the API against `--once --json`; server restart, a Chromium that doesn't stop (NX-87), late keyboard, three crashes → text console), no getty on tty1; a headless VM falls back to the text console (starting screen and banner, claim screens, tty2 keeps the getty banner); self-provisioning at boot against the fake control's self-register endpoint (null claim hash, no cards, factory tuple recorded); the state file's group and who can read it; a crafted file shows the starting screen; a stopped server removes the file |
| `vault-wall` | NX-40, IN-58…IN-61: `/run/whombat-vault` and the server's `WHOMBAT_VAULT_NETWORKS_FILE`; the wall as a dynamic user with `CAP_NET_ADMIN` only; no file → empty sets; a listed IPv4 address and IPv6 ULA address on a listed port is reachable from the `whombat` uid, the same port on an unlisted address and another port on the listed address are not, and the runner, root, nobody, the manager and a sandbox uid gain nothing; covered and duplicate networks merged; removing the entry closes new and open connections (reset), a change that keeps it leaves an open one alone; 15 invalid files (malformed JSON, version, unknown field, loopback, link-local, metadata, multicast, documentation, public, too wide, 33 networks, 17 ports, port 0) and a symlink, a foreign owner and a 0666 file each empty the sets with the reason in the journal; `nftables` reload and restart refill them, a stopped wall empties them, a killed one comes back |
| `browser` | NX-94…NX-99, IN-87: the agents' browser host with the stand-in host: uid 961 and the server's user in its group; the unit from the runtime profile in `whombat-browser.slice` (cap, tasks, weight), its credentials and seccomp, nothing of `/persist` or the runtime's sockets in its mount namespace, its own Chromium policies instead of the kiosk's; socket 0660, status 0640 and the environment for the server only; Chromium started in the unit with its own sandbox (renderers under seccomp in their own pid and user namespaces) loads a public page over IPv4 and IPv6 and no private, link-local, ULA or wrong-port one; the uid's wall (public 80/443 only, no UDP 443, no DNS but the stub, private/metadata/ULA refused at once while root reaches them on 443, this box's own LAN address refused, the Vault's listed network and port opened and closed again, loopback only to its own listeners: PostgreSQL, the server's port and a closed port time out, nobody else reaches its listener); a hog killed at the slice's cap with the host up; the gate off below the minimum (status and reason, no socket, not restarted), forced on, on above it; a killed host back with an empty HOME |
| `browser-real-runtime` | NX-100, NX-101, IN-87: the real browser host (a Whombat with `apps/server/src/browser/host`; registered only then, `--override-input whombat …` until the pin has it): Node on the bundle's `app/browser-host.mjs`, hello (protocol 1, Playwright 1.63.0, Chromium 153, 2 contexts), Chromium in the unit's cgroup without `--no-sandbox` and its renderers in their own pid and user namespaces, the real server logging “browser available”; pages by IPv4, IPv6 and a name from `/etc/hosts`, snapshot, text, a 1280-wide PNG; a Vault network refused by the host without it in `networks`, unreachable while the kernel's sets don't list it, loaded once both do, refused on another port and after the list is emptied; loopback (the server's port, PostgreSQL by name, `::1`, this box's LAN address), metadata, ULA and `file:` refused; sign-in on a form (`still_asks` with a wrong password, `signed_in`, the password in no snapshot, text or journal, the session pinned: `other_site`); a page past the slice's cap: the kernel kills its renderer, the host, its PID and Chromium's browser process stay, the session answers “The page crashed…”, a new one works; Chromium killed → the host exits, the unit restarts it, the server reconnects; no Chromium → exit 3, no restart, status and server say why; the gate off → the server reports it off with the reason |
| `runtime-real` | NX-48: the real runtime bundle (PI-07): profile seeded with it; first-boot schema (NX-46); server and runner `Type=notify` with Node as main PID, watchdog pings over several periods, a SIGSTOPped server restarted; admin socket and `/health` as the manager (runner, nobody refused); boot assessment; the console file written by the real server and read by the console; the helper's `check-schema`/`migrate-runtime` (TUF-verified, assigned `rt-real-1`) migrating an emptied database with the bundle's `bin/whombat`, then a healthy runtime on it |
| `wifi` | NX-240…NX-247, MG-100…MG-104: four mac80211_hwsim radios, three of them access points in a namespace (Office WPA2, Home WPA2, Cafe open without a way to control) with dnsmasq, the fake control and the TUF fixtures behind them; a profile written as the installer writes it brings the box online at route metric 600; provisioning over Wi-Fi; through the manager's socket as the runtime's uid: the state (eth1 a cable without an address), a scan, a wrong password that fails and keeps nothing, a join that commits, a join without internet that reverts and loses its profile (and the dead-man timer armed meanwhile), forgetting, `in_use`, `not_saved`; no passphrase in the journal or the manager's and helper's state |
| `bluetooth` | NX-350…NX-363: two virtual controllers (bluez's `btvirt` on `hci_vhci`), hci0 the box's and hci1 a test-only mouse (`bt-peer`, HCI user channel, Just Works, no services); the socket's mode and peers; `no_adapter` without a controller; only root, whombat-bluetooth and pipewire reach org.bluez (D-Bus `AccessDenied` for the server's user and others), PipeWire's A2DP endpoints registered; through the socket as the server's uid: the mouse found (named, `mouse`, 4 bars), paired to `done`, trusted and bonded, connected, disconnected, forgotten; every state the contract's; no address in the journal |
| `appliance-basic-real-runtime`, `manager-units-real-runtime`, `sandbox-backup-real-runtime`, `vault-wall-real-runtime` | NX-49: the same suites with the real bundle on their appliance nodes |
| `image-no-secrets`, `provision-unit`, `appliance-toplevel`, `eval-aarch64` | image/closure carry no per-device state; Go unit tests; the system builds; aarch64 evaluates |

Run: `nix build .#checks.x86_64-linux.<name>` (Nix sandbox) or, with KVM as the user,
`nix build .#checks.x86_64-linux.<name>.driver && ./result/bin/nixos-test-driver` (`TMPDIR`/`XDG_RUNTIME_DIR`
set to a writable directory). Test VMs add `-no-user-config` so QEMU ignores the host's `/etc/qemu`. On this
host the build users are not in the `kvm` group, so sandboxed runs fall back to TCG (slow); the recorded runs
used the driver with KVM. A VM run never qualifies hardware behaviour.

## NX-28 Backup service units (W3-BK) — one source
`nix/modules/backup.nix` is the only Nix definition of the backup units (the backup workstream's former
`backup/nix/whombat-backup.nix` folded in and deleted, approved by the orchestrator); `nix/profiles/recovery.nix`
carries the former `backup/nix/recovery-image.nix` (`whombat-recovery`, `whombat-export`, restic, git,
PostgreSQL 17 in the recovery UKI). The backup workstream changes them through the cross-owner procedure.
Defaults: enabled, `btrfs` driver, uid/gid 954 (`whombat.ids.whombat-backup`), `whombat-backup-clients` 958;
the socket groups are `whombat-admin` 956 and `whombat-api` 957. Fixes applied relative to the original snippet
(found in the `sandbox-backup` VM test):
1. *Sealing as its own unit.* systemd resolves `LoadCredentialEncrypted=` before any `ExecStartPre=` runs, so
   sealing inside the service could not feed its own credential (first run 243/CREDENTIALS), and a `-` prefix
   does not make a credential optional. `whombat-backup-seal.service` (root oneshot, `Before=`/`RequiredBy=` the
   backup, drill and API services) seals `repository-password` into `repository-password.cred` and restarts the
   API, or leaves an empty placeholder credential while no destination is set.
2. *Role grant ordering.* `whombat-backup-pgrole` is `After=`/`Requires=postgresql-setup.service` (where
   `ensureUsers` creates `whombat_backup`).
3. *`/persist/backup` is `root:whombat-backup 0771`*: systemd-tmpfiles refuses a root-owned `staging/` under a
   user-owned parent ("unsafe path transition").
4. The `pg_hba` peer line is part of `postgres.nix`'s forced `authentication`; `btrfs-progs` on the snapd and
   service PATH; the CLI installed; the drill `Wants=network-online.target`; the runner needs both
   "provisioned" and "no `/persist/backup/quarantine.json`".
Provisioning stages files per target directory because `identity` and `secrets` are different subvolumes.

## NX-29 Provider runtimes (W3-PV, provider-bundles.md)
`nix/packages/providers.nix`: Codex 0.157.0 (static-pie release tarball, layout kept) and Claude Code 2.1.278
(`@anthropic-ai/claude-agent-sdk-linux-x64@0.3.278`) fetched by the published digests, installed with
`dontFixup`/`dontPatchELF`/`dontStrip` (no patchelf, no wrapper), and the executables' sha256 checked at build.
Claude is glibc-linked: `programs.nix-ld` (libraries: glibc only) provides `/lib64/ld-linux-x86-64.so.2`; the
runner unit sets `NIX_LD`/`NIX_LD_LIBRARY_PATH` itself (nix-ld's are session variables). Each provider runs
from `/nix/var/nix/profiles/whombat-provider-<name>` (seeded once, then switched by the helper with the runtime,
MA-11 class 1); runner env `WHOMBAT_PROVIDER_PINS=claude=2.1.278,codex=0.157.0`, `WHOMBAT_{CODEX,CLAUDE}_PATH`,
`DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`; `WHOMBAT_CREDENTIALS_ROOT` only on the
runner (credential homes are `whombat-runner` 0700; the server has no access). aarch64 bundles are not packaged
(no executable hash recorded upstream). Commercial eligibility is gated separately (X-01/X-02).

## NX-27 Old generations are not data snapshots
Boot counting and profile rollback switch **code** only. `/persist` (database, files, workspaces) is never
rolled back by a generation change. Compatibility is the schema reader/writer model (MD-01…MD-07): a fallback
runtime must be within the database's reader/writer floors or it starts read-only/refuses; incompatible
migrations need a verified checkpoint first; after newer acknowledged writes only compatible code rollback or
forward repair is allowed, never a silent rewind. **Manager obligation after a host fallback:** the helper's
`activate-host-on-reboot` switched the runtime profile before rebooting; if the boot fell back
(`bless-boot` → `boot_mismatch`), the manager must re-activate the known-good tuple (the helper handles
"booted == target host" as runtime switch + restart) before the fallback host runs a runtime it wasn't paired
with for long.

## NX-30 Hosted UI origin and the backup API for the runtime and manager (2026-09-26)
- **`whombat.runtime.appUrl`** sets `WHOMBAT_APP_URL` on `whombat-server` and `whombat-runner` (runtime MR-45:
  links the server writes are `<appUrl>/appliances/<device id>/…`). The appliance has no per-environment profiles,
  so the default follows `whombat.environment`: dev `https://dev.whombat.com`, prod `https://app.whombat.com`,
  local (the dev harness) `null` (unset: relative links). Overridable per image. Evaluation asserts an origin only
  (`https?://host[:port]/?`, which is what the runtime's config accepts) and, for prod, an https origin, so a
  wrong value fails the build instead of the device's start.
- **Backup API wiring** (found while checking the runtime's environment): the server now gets
  `WHOMBAT_BACKUP_SOCKET=/run/whombat-backup/api.sock` (owner backup ops, MR-19) and `/etc/whombat/manager.json`
  `backupSocket` the same path (pre-migration checkpoints, MG-18/BK-17, and backup status in `status.report`,
  MG-23), both only while `whombat.backup.enable`. Before this both were unset on the appliance (only the dev
  harness set them, IN-26), so owner backup ops answered `backup_unavailable` and a contract migration waited for a
  checkpoint forever. Access is the existing `whombat-backup-clients` group (NX-28); the runner doesn't get it.
- MR-47's bundled packs need nothing here: `WHOMBAT_APP_DIR` is set by the bundle's own entry points, and
  `packs/` is inside the verified runtime component. MR-37…MR-47 need no other host setting.
- `appliance-basic` checks both units' `WHOMBAT_APP_URL`, the server-only backup socket, the manager config, and
  that the server's and the manager's users reach `GET /v1/status` on the backup API.

## NX-31 `whombat.runtime.appUrl` is required (2026-09-26; changes NX-30)
The runtime now refuses to boot in managed mode without `WHOMBAT_APP_URL` or with anything but an https origin
(http only on loopback outside production; the appliance runs `NODE_ENV=production`), because it no longer writes
relative links (runtime MR-45). So the option is a plain string, always set: dev `https://dev.whombat.com`, prod
`https://app.whombat.com`, and local now also `https://dev.whombat.com` (it was `null`); evaluation asserts an
https origin for every environment. The dev harness sets `WHOMBAT_APP_URL=http://localhost:<web port>` (its own
hosted UI).

## NX-32 The tty1 console shows the claim code (2026-09-26; CC-08, MA-22)
- **Program.** `whombat-console` (`console/cmd/whombat-console`, `console/internal/screen`; root Go module, package
  `pkgs.whombat-console`, tests in its build) reads the console state file once a second and redraws the whole screen
  when the frame changes (and once a minute regardless, to repair anything else that wrote to the VT): clear, plain
  text, no colours. The file is parsed strictly (`{v:1, state, code?, url, retryAt?}`, unknown fields refused, one
  object, at most 4 KiB, opened with `O_NOFOLLOW`, regular files only): `code` only and always in `claimable`, matching
  `^[A-Z]{2}-[0-9]{4,6}-[A-Z]{2}$`; `url` in every state, a plain `host[:port]/path` after the scheme is dropped (no
  userinfo, query, fragment or spaces, ≤ 100 characters); `retryAt` required in `backoff` (an RFC 3339 string or epoch
  seconds/milliseconds until contracts 0.7.0 fixes its type). A string with any control or format character (C0, DEL,
  C1, bidi overrides) is refused, not repaired, and the footer text is filtered the same way. A missing, unreadable or
  invalid file shows the starting screen. The struct mirrors contracts 0.7.0 `ConsoleState` and is replaced by the
  generated Go type when 0.7.0 is vendored.
- **Words** (CC-08, verbatim): `starting` “Starting Whombat…”; `waiting` “Connecting to Whombat…” / “Check the
  network cable. The claim code appears once this Whombat is online.”; `claimable` “Claim this Whombat” / “Open {url}
  and enter” / the code / “The code changes after a wrong try.”; `backoff` “Too many wrong codes. Try again in {n}
  min.” (whole minutes to `retryAt`, rounded up, at least 1); `claimed` “This Whombat is set up.” / “Open {url} to use
  it.”. The code is drawn in 5×5 block letters (`█`, two or one column apart, whichever fits) with the plain code
  underneath; too narrow a screen, or a letter outside CC-01's alphabet, gives the plain code only. *In part amended by
  console-gui.md CG-432: the footer is one plain line of its own, `whombat.console.footer`; the getty banner stays on the
  other VTs.* The footer is the getty banner (“Whombat appliance. There is no login on this console. …”), one text in `whombat.console.banner`
  used for both `services.getty.helpLine` and `--footer-file`; the program's built-in default is the same text
  (`checks.console` compares them).
- **Unit.** `whombat-console.service` on tty1: `User=whombat-console` (a static system user/group, uid/gid 959,
  NX-08 style; it owns nothing persistent, but a fixed id keeps `/run` ownership readable across generations),
  `StandardInput=null` (it never reads the keyboard; since NX-54 `tty-force`, for the recovery key screen only), `StandardOutput=tty`, `TTYPath=/dev/tty1`, `TTYReset`,
  `TTYVHangup`, `TTYVTDisallocate`, `Restart=always`. Hardened: no capabilities, `PrivateNetwork`,
  `RestrictAddressFamilies=none`, `IPAddressDeny=any`, `ProtectSystem=strict`, `PrivateDevices` with
  `DeviceAllow=/dev/tty1 rw` (systemd opens the tty under the closed device policy before the private `/dev`
  exists; without it the unit fails with 209/STDOUT), `MemoryDenyWriteExecute`, `@system-service` minus
  `@privileged @resources`. No getty on tty1: `getty@tty1` and `autovt@tty1` are masked and `getty.target` no
  longer wants `autovt@tty1` (NixOS's static tty1 pull-in; logind never spawns tty1 itself); tty2–tty6 keep the getty
  banner (NX-10). Terminus 16×32 (`console.font = "ter-v32b"`, `whombat.console.font`) so the code reads from a
  distance. Hardware-qualification builds (`whombat.qualification.consoleShell`) keep their root shell on tty1:
  `whombat.console.enable` defaults to off there.
- **File and permissions.** `/run/whombat` stays 2751 `whombat:whombat-admin` (admin.sock's group must not change,
  and the console must not join `whombat-admin`). The state file therefore lives in its own directory:
  **`WHOMBAT_CONSOLE_FILE=/run/whombat/console/console.json`** (this refines CC-08's `/run/whombat/console.json`),
  directory `/run/whombat/console` 2750 `whombat:whombat-console` from tmpfiles (always, also without the unit).
  The runtime writes atomically in that directory (temporary file, `chmod 0640` explicitly because its `UMask` is
  0077, rename); the setgid bit gives the file the group `whombat-console`, so the runtime needs no `chown` and no
  extra group. The console user reads that one file and can't list `/run/whombat`; runner and manager can't read it
  (`console-self` checks all three). `ReadWritePaths=/run/whombat` of the server already covers the directory.
  `whombat-server` gets `ExecStopPost=-rm -f <file>`: a stopped or restarting server leaves no stale code on the
  console, which falls back to “Starting Whombat…”.
- `checks.console` (evaluation asserts on the unit, the masked gettys, the server's `WHOMBAT_CONSOLE_FILE`, the
  banner; the binary's starting screen, footer and a crafted file with an escape sequence) and VM test
  `console-self` (below and NX-33).

## NX-33 Self-provisioning (2026-09-26; CC-10)
- `whombat-provision self` makes the factory's identities and on-disk layout (management key, content identity,
  master key, runner token, `device.json`, all through the same staging and commit) and registers the same signed
  `DeviceRegistration` at **`POST {control}/v1/devices/self-register` without any credential** (`control.SelfClient`;
  403/404 → “self-registration is not enabled here”, 429 → rate-limited, 409 as in the factory), with **model
  `self-installed`**. It writes **`claim.json` with `"secretHash": null`** (same `v`, `deviceId` and `algorithm`
  fields, so only a console-code claim can succeed), registers no claim verifier, writes **no cards** and enrols
  **no disk recovery key**, and says so on its output: the disk recovery key for self-installed appliances (today on
  the factory card) and hardware qualification of arbitrary machines are deferred to the ISO work (CC-10). Because
  prod never runs without a recovery key, **self-provisioning refuses prod** (library, and a NixOS assertion) until
  that work lands (it landed: NX-53, NX-57). `verify` accepts a null hash only for model `self-installed` and requires one otherwise.
- **Serial.** `--serial`, else the firmware DMI serial when it fits the contracts' `HardwareSerial`
  (`^[A-Z0-9-]{4,64}$` after upper-casing), else `MID-` + 20 hex digits of HMAC-SHA256 keyed with `/etc/machine-id`
  over `whombat-hardware-serial/1` (stable per installation; the machine id itself never leaves the box).
- **Settings.** Like factory mode takes them from `station.json`, self mode takes them from
  **`/etc/whombat/self-provision.json`**, generated by NixOS in the same `Settings` format (`v`, `environment` =
  `whombat.environment`, `controlUrl` = `whombat.provisioning.selfControlUrl`, default the manager's
  `whombat.manager.controlUrl`, `model`, `requireSecureBoot`); factory-only fields (token, card recipient, LUKS
  devices, claim URL, factory release, seedHelper) are refused. Flags (`--env`, `--control-url`, `--serial`,
  `--unprivileged`, `--manager-uid`, …) override it for development runs.
- **Unit.** `whombat.provisioning.selfRegister` (default off) adds `whombat-self-provision.service`: wanted by
  `multi-user.target`, after `whombat-persist.target`, `network-online.target`, `whombat-tpm-seal` and
  `whombat-factory-provision` (a factory medium wins when both are present), `ConditionPathExists=!device.json`, and
  `Restart=on-failure` with a growing delay (2 min … 1 h, `RestartSteps=5`, no start limit) so an unreachable control
  or a spent per-address budget (5/h) is retried without hammering it. Afterwards it records the installed tuple like
  a factory medium (MG-20; `whombat.provisioning.selfFactoryRelease`, null = the manager stays unprovisioned, and
  `selfSeedHelper`) and starts the manager and runtime; the factory unit shares that step. `selfRequireSecureBoot`
  (default true) gates on Secure Boot like the station's `requireSecureBoot`.
- `whombat-fake-control --self-registration` serves the endpoint (no `Authorization`, model `self-installed`,
  `origin: "self"` in `/test/devices`); the unit tests use the same shapes.
- VM test `console-self`: an unprovisioned VM with `selfRegister` provisions itself at boot, `verify` passes,
  `claim.json` has a null hash, control saw one `self` registration, the manager journal holds the tuple, a second
  start is skipped by its condition.

## NX-34 The claim card has no fingerprint (2026-09-26; CC-02)
The card (`provisioning/internal/card`) keeps the title “Claim your Whombat”, the appliance id, the claim code (the
26-character secret) and the QR code, and the privacy lines; the fingerprint block (“Appliance fingerprint (check it
matches on screen)”) is gone, because the claim PAKE authenticates the appliance. The instruction reads “Scan the
code, or open {host} and choose “Claim with a card”:” on two lines (a single line ran under the QR code), and the
claim code is set at 4 mm so all 32 characters stay left of the QR code. `device.json` keeps its `fingerprint`
field (the pairing and support tools read it). NX-24's card description is superseded in this one point. The
harness twin's `claim-card.txt` prints the same words (IN-33).

## NX-35 A retired, never-claimed self-installed appliance registers again (2026-09-26; MG-30, CL-33/CL-34)
With `whombat.provisioning.selfRegister`, `whombat-self-reregister.path` watches the manager's request
`/persist/manager/reregister.json` (MG-30) and starts `whombat-self-provision.service`, which now runs when either
`device.json` is absent or the request exists (triggering conditions). With an identity it re-checks everything
itself: it asks the runtime's admin socket `GET /facts` as the manager's user (the socket answers only that user) and
acts only on `claimed: false` (no answer: retry later; anything else: the request is dropped). It then stops the
manager and runtime, and `whombat-provision self --reregister REQUEST --manager-claim-state
/persist/manager/journal/claim-state.json` reads the request without following links, requires model `self-installed`
and the request's device id in `device.json`, refuses when the manager recorded a claim, and registers new keys
(management key, content identity) at the self-register endpoint with the same serial, replacing the identity files
(device.json last) and **keeping `secrets/`** (master key, runner token), so the runtime's never-claimed database stays
readable; the runtime takes the new `claim.json` because it is unclaimed (MR-09 `provisionClaim`). Refusals exit 3 and
drop the request; any other failure keeps it and the unit retries with its growing delay. Manager and runtime are
started again either way. A crash in the middle of the renames leaves a mixed identity (verify fails): for a box that
was never claimed that means a factory reset, nothing is lost. Residual: a claim completed in an already-open session
between the runtime check and the stop (control had cancelled the device's claims when it retired it) would be lost
with the old identity; the manager's claim record, checked after the stop, closes most of that window. VM test
`console-self` covers both paths (re-registered with new keys, same serial; refused while the stand-in reports
claimed). The stand-in runtime now answers `GET /facts` (claimed when `/run/whombat-standin/claimed` exists) and
accepts the manager's pushes.

## NX-36 The console shows the four letters (2026-09-26; CC-13, contracts 0.8.0; amends NX-32)
`ConsoleState.code` is the four letters (`^[ABCDEFGHJKMNPQRTVWXY]{4}$`, validated by the contract's schema). The
claimable screen says “Claim this Whombat” / “On a computer or phone on this network, open {url} and enter” / the
letters / “The code changes after a wrong try.”; the letters are drawn in 5×5 block letters with two columns per
pixel (square on the VT's 1:2 cells) when the screen is wide enough, else one, else plain, with the plain letters
underneath. The console never shows the lookup number. Since 0.7.1 the file is parsed with the contract
(`local.ParseConsoleState`, which ignores members it doesn't know, and `ConsoleStateValid`); `retryAt` is an RFC 3339
string (the numeric fallback of NX-32 is gone); the console's own plain host/path check of `url` stays.

## NX-37 AI clients are installed by the manager, not baked into the image (2026-09-26; SUB-09, CT-72…CT-74, MG-33; supersedes NX-29's packaging)
Claude Code and Codex left the image: `nix/packages/providers.nix`, the `whombat-provider-profiles-init` seeding and
`whombat.providers.packages` (now a removed option with a pointer here) are gone, and the image sets neither
`WHOMBAT_PROVIDER_PINS` nor `WHOMBAT_{CLAUDE,CODEX}_PATH` (an operator pin would win over the installed bundle,
Whombat SUB-25). The GitHub CLI is unchanged (in the runtime closure). `nix/modules/providers.nix` is now the clients
module (`whombat.clients`):
- **Install root** `/persist/whombat/clients` (`whombat.clients.root`, read-only option): `whombat-manager` 0755 by
  tmpfiles, in the manager's `ReadWritePaths` (its `NoExecPaths=/persist` still covers it: the manager never runs a
  client). Layout `<provider>/<version>/…` (the vendor's package, read-only) and `<provider>/current`. Plain segments
  only — the contract's executable path pattern refuses dot-directories. `/persist` is not `noexec`.
- **Manager** `clients.{root, stateDir=/persist/manager/clients (0700), channelKeys=/etc/whombat/tuf/client-channel-keys.json}`
  in `manager.json`, only when `whombat.clients.channelKeys` (the environment's pinned channel key document, public)
  is set; without it the manager installs nothing and a prod image warns at build time. No production channel key
  exists yet (`docs/runbooks/updates-release-signing.md`).
- **Status for the runner** `WHOMBAT_CLIENTS_FILE=/run/whombat-clients/clients.json` for server and runner: the
  directory is 2750 `whombat:whombat-runner` (tmpfiles) and in the server's `ReadWritePaths`; the server writes the
  file atomically with mode 0640 (explicit: its UMask is 0077), the runner only reads it (Whombat SUB-25). The runtime
  gets no `WHOMBAT_CLIENTS_ROOT`: paths come in the status.
- **Pins** come from the installed bundles: the runner runs `installed.executable.path` after checking
  `installed.executable.sha256` (the drift check with the bundle's pin instead of the image's, CT-73).
- **Tasks** see the install root read-only: `WHOMBAT_SANDBOX_RO_PATHS=<toolchain>:/persist/whombat/clients`
  (colon-separated).
- **Sign-in** hosts of the Claude console (`claude.ai`, `console.anthropic.com`, `platform.claude.com`,
  `api.anthropic.com`; `whombat.clients.signInHosts`) are added to `WHOMBAT_SANDBOX_EGRESS_ALLOW`; the host wall and
  the runner's nftables wall already allow public TCP 443.
- **Kept:** `programs.nix-ld` (libraries: glibc only) and the runner's `NIX_LD`/`NIX_LD_LIBRARY_PATH` for Claude
  Code's glibc binary (never patched, never launched through ld.so), `DISABLE_AUTOUPDATER=1`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `WHOMBAT_CREDENTIALS_ROOT` (runner only).
- **Runtime bundle (NX-20 addition, for the runtime's packaging):** the runner now hosts the Claude sign-in console
  under `node-pty` 1.1.0 (Whombat SUB-20), which has no Linux prebuilds: the runtime derivation must build its addon
  with node-gyp (`python3`, `gnumake` and a C++ compiler as build inputs; nothing extra at run time). The stand-in
  runtime has no product and needs nothing. `WHOMBAT_PROVIDER_PROFILES` stays set for tuples that still carry
  provider bundles (the helper's `ProviderProfilePref`); a runtime that installs bundles leaves the tuple's
  `providers` empty (CT-74).
Checks: `checks.x86_64-linux.clients` (evaluation: no provider env or seeding, the clients file for both units, the
RO path, the manager's write path, the sign-in hosts, nix-ld) and the `sandbox-backup` VM test (the status file's
directory permissions between server, runner and manager; a manager-owned read-only install the runner runs but can't
change; nix-ld's loader present).

## NX-38 The licence key set is pinned in the image (2026-09-26; LC-03, LC-04, MG-34, runtime MR-55)

`nix/modules/licence.nix`: option `whombat.licence.keys` (a path to a `LicenceKeySet {v: 1, env, keys}`, public keys
only; default null), installed at `/etc/whombat/licence-keys.json` (`whombat.licence.file`, root 0444, as the client
channel keys of NX-37). With it:

- `whombat-server` gets `WHOMBAT_LICENCE_KEYS_FILE=/etc/whombat/licence-keys.json` (the runtime requires it in managed
  mode, MR-55). The runner doesn't: it verifies no licence.
- The manager's `/etc/whombat/manager.json` gets `licence {keysFile: /etc/whombat/licence-keys.json, stateFile:
  /persist/manager/licence.json}` (MG-34; `/persist/manager` is already the manager's writable directory). Without a
  key set the block is empty and the manager renews nothing.
- The dev overrides of the runtime (`WHOMBAT_LICENCE_GRACE_S`, `WHOMBAT_LICENCE_CLOCK_OFFSET_S`, MR-60) are never set
  by the module; they exist for the harness only.

Assertions (evaluated with the other prod assertions of `manager.nix`):

- **prod needs a key set.** There is none until the production key ceremony (LC-04, X-05), so a prod image doesn't
  build before it, like a prod image without a TUF root.
- The file must look like a `LicenceKeySet` (v 1, 1–8 OKP/Ed25519 keys, kids `lic-…`); the full schema check is the
  manager's and the runtime's at start.
- Its `env` must be the image's environment for prod, and anything but `prod` elsewhere (a dev image may pin a `test`
  set; a dev image with prod keys would accept tokens meant for prod boxes).
- prod refuses development and test kids (`lic-local-…` from control's dev-init, `lic-dev-…`, `lic-test…`).

A non-prod image without a key set evaluates with a warning (the real runtime then refuses to start in managed mode).
The default dev configurations (`appliance-x86_64`, the dev image) pin none: the cloud `dev` control has no licence
key yet, and the local dev instance runs from the harness, which writes its own (IN-39).

VM tests pin a fixed TEST key set, `vm-tests/common/licence-keys.test.json` (env `test`, kid `lic-test-1`; its seed
`sha256("whombat/test-licence-key/1")` is public — the runtime's `managed/__fixtures__/licence-keys.json`), through
`vm-tests/common/manager-dev.nix`, so every appliance VM carries it. It holds no private key (`image-no-secrets`
stays green). Checks: `checks.x86_64-linux.licence` (evaluation: file mode, server-only environment, the manager's
configuration with and without a key set, the prod assertions: one failure without a key set, two with the TEST
set) and `appliance-basic` (“runtime, manager and database are healthy”: root 0444, readable by the runtime and the
manager users, server environment only, the manager configuration).

## NX-39 The Feedback widget's origin reaches the runtime (2026-09-27; Whombat FD-31, FD-37, IN-53)

`nix/modules/runtime.nix`: option `whombat.runtime.embedUrl` (null or an https origin), per environment
`dev`/`local` = `https://embed.whombat.com` (the dev instance's embed origin), `prod` = null. When set, server and
runner get `WHOMBAT_EMBED_URL` next to `WHOMBAT_APP_URL`: it is the base of the snippets the Feedback tab shows and
the only `Origin` the runtime files a dropped report from (FD-23, FD-31). null leaves it unset, and the runtime uses
the origin of `appUrl` (FD-30's fallback; control allows it while `FEEDBACK_DROP_UI_ORIGINS` is on, FD-40), which is
what production does until an embed origin is hosted there (`docs/runbooks/cutover.md`). An assertion refuses
anything but an https origin, like `appUrl`. `WHOMBAT_FEEDBACK` is not set: the runtime's default in managed mode is
`on`, which means the drop (FD-25); the drop needs no new egress, socket or credential on the appliance (the runtime
reaches control through the manager's socket, and the drop keys are sealed with the existing master key).
`vm-tests/appliance-basic.nix` checks the variable on both units.

## NX-40 The Vault's home networks in the egress table (2026-09-27; Whombat VT-12, VT-59; IN-58…IN-61)

The runtime server (uid `whombat`) may reach exactly the networks and TCP ports the admins list for the Vault, updated
without a reboot; every other uid is unchanged. Why a daemon and how it validates: IN-58, IN-59.
- `nix/modules/network.nix`: `inet whombat-egress` gains `set vault4 { type ipv4_addr . inet_service; flags interval; }`
  and `vault6` (`ipv6_addr`), empty in the image, and, before the final drop,
  `meta skuid <whombat> ip daddr . tcp dport @vault4 ct mark set 0x5641554c accept` (and `ip6 … @vault6`). The conntrack
  mark sends every later packet of such a connection through `vault_established` (before `ct state established
  accept`), which lets it pass only while its address and port are still in a set and otherwise answers
  `reject with tcp reset`: removing a network ends the connections already open to it. A connection to a listed network
  on a port every uid may use (443) is accepted by the earlier port rule, is not marked and is not affected.
- `nix/modules/vault-wall.nix`: `/run/whombat-vault` (tmpfiles, `0755 whombat:whombat`, in root's `/run`, so the runtime
  can't replace the directory); `whombat.vaultWall.{package, file (read-only: /run/whombat-vault/networks.json),
  resyncSec (60)}`; `whombat-vault-wall.service`: `Type=notify` (ready after the first transaction), `DynamicUser`,
  `AmbientCapabilities=` and `CapabilityBoundingSet=CAP_NET_ADMIN`, `RestrictAddressFamilies=AF_NETLINK AF_UNIX`,
  `IPAddressDeny=any`, `InaccessiblePaths=/persist`, `ProtectSystem=strict`, `@system-service ~@privileged
  @resources`, `MemoryDenyWriteExecute`, no `PrivateNetwork`/`PrivateUsers` (it must change the host's table);
  `Requires=`/`After=`/`PartOf=nftables.service` and `ReloadPropagatedFrom=nftables.service` (a reload recreates the
  table and empties the sets; the propagated reload, SIGHUP, re-applies after it, ordered by `After=`);
  `Restart=always` (2 s); `ExecStopPost=- whombat-vault-wall --flush` (a stopped wall leaves nothing open).
- `nix/modules/runtime.nix`: the server (not the runner) gets `WHOMBAT_VAULT_NETWORKS_FILE=/run/whombat-vault/networks.json`
  and `/run/whombat-vault` in `ReadWritePaths`.
- **systemd finding:** under `RestrictSUIDSGID=` (which `DynamicUser=` implies) systemd's seccomp filter answers
  `openat2()` with `ENOSYS`, because it can't inspect openat2's flags. The daemon therefore walks the path with
  `openat(O_NOFOLLOW|O_DIRECTORY)` one name at a time instead of `openat2(RESOLVE_NO_SYMLINKS)`; the first VM run, with
  openat2, refused every list (fail-closed) and showed it.
- Checks: `packages.whombat-vault-wall` runs `go test ./vaultwall/...` in its build (the real-nft test runs in a user and
  network namespace where the sandbox allows it, else skips); `checks.vault-wall-config` (evaluation: environment only on
  the server, the directory's owner and mode, the unit's credentials, the `@vault` accept rules name the server's uid, and
  `--check` refuses a link-local network); VM `vault-wall` (NX-26). The build-time `nft --check` of the ruleset
  (nixpkgs' `checkRuleset`) accepts the sets and rules.

## NX-41 The runtime bundle derivation (2026-09-27; PI-07, NX-20)

`nix/packages/runtime` (`pkgs.whombat-runtime`, `packages.<system>.whombat-runtime`) builds the real bundle from the
pinned Whombat source (NX-42) with the workspace's own `pnpm bundle:runtime` (Whombat MR-37: esbuild bundles of server,
runner, CLI and the feedback image worker, the migrations and their journal/compat, the packs):
- **pnpm and Node from the pinned nixpkgs:** `pnpm_12` (12.3.4, exactly Whombat's `packageManager`; evaluation fails if
  they drift) on `nodejs-slim_24` (24.21.0; Whombat's `engines.node` is `>=24`). The same Node runs the bundle.
- **Dependencies:** `fetchPnpmDeps` (`fetcherVersion = 4`, fixed-output hash; `--force`, so every platform's optional
  packages) and `pnpmConfigHook` (offline `pnpm install --frozen-lockfile --ignore-scripts`). A pin bump that changes
  `pnpm-lock.yaml` needs the new hash (set `""`, build, take the reported one).
- **node-pty** (NX-37): its addon is compiled with `node-gyp rebuild --nodedir=<nodejs-slim_24>` (node-gyp, python3,
  stdenv's make and C++ compiler as build inputs only); `bundle:runtime` ships it as `node_modules/node-pty` (MR-72).
- **git** questions of the bundler (sha, commit time, dirty) are answered by a shim from the flake input (`rev`,
  `lastModified` as `SOURCE_DATE_EPOCH`, dirty when `patches` are applied).
- **Output** (NX-20): `bin/whombat-server`, `bin/whombat-runner`, `bin/whombat` are `makeBinaryWrapper` wrappers that
  exec `nodejs-slim_24` on `app/{server,runner,cli}.mjs` (the unit's main PID stays Node: its sd_notify and watchdog
  are that process's), with `gitMinimal` appended to PATH (the workspace manager runs git; the unit's PATH comes first,
  so `systemd-notify` is systemd's). `app/`, `migrations/`, `packs/`, `node_modules/node-pty/` and
  `share/whombat/{bundle.json, release-manifest.json, THIRD-PARTY-NOTICES.txt, LICENSE}`; the bundles find
  migrations and packs through `WHOMBAT_APP_DIR`, which they set to their own release directory.
- **Install check:** no path of the build (source, bundle output, the unpacked pnpm store, `$HOME`) in the output;
  `bin/whombat --help` works; `whombat-server` and `whombat-runner` get past their imports to their configuration
  checks (the MR-72 and MR-76 failures); the shipped addon runs a PTY. `disallowedReferences`: pnpm, python3,
  node-gyp and the pnpm store.

## NX-42 The Whombat pin and how a release bumps it (2026-09-27; PI-07)

Flake input `whombat = { url = "git+https://github.com/<account>/Whombat.git?ref=main&rev=<commit>"; flake = false; }`,
locked in `flake.lock` (579455c, `lastModified` 1790503531; since NX-65 a2abeeb, `lastModified` 1790514497; since NX-86 843d1ba, `lastModified` 1790543565). The repository is private: Nix fetches it with the
builder's own git credentials (on the build host the `gh` credential helper for github.com; `git+ssh` is not
configured there). A builder without access to the repository can't evaluate the runtime and anything that depends on
it. The rev lives in `flake.nix`, not only in the lock, so it is reviewable next to the candidate it must match:
`nix/packages/runtime` names the manifest candidate (`passthru.candidate = "0.14.0"`, since NX-65 `"0.15.3"`, since NX-86 `"0.17.0"`), and `checks.runtime-pin` fails
unless the input's rev is that candidate's `whombat-runtime` commit (`manifest/candidates/<candidate>.json`).
**Bump for a release:** set the rev in `flake.nix` and the candidate in `nix/packages/runtime/default.nix` together,
`nix flake lock`, refresh the pnpm hash if `pnpm-lock.yaml` changed, drop the patches the new commit contains (NX-43),
build `.#whombat-runtime` and run `checks.runtime-pin` plus the VM suites of NX-48/NX-49.

## NX-43 Whombat fixes carried as patches until the pin contains them (2026-09-27)

At the pinned commit the bundle can't run on the appliance. The fixes are commits on Whombat's branch
`prod-image-runtime` (not merged); the derivation applies their code (tests and docs left out) as `patches`, in order:
MR-72 (node-pty shipped, not bundled: before it every entry point failed at import), MR-73 (`--env` takes
`DATABASE_URL` from `WHOMBAT_ENV_FILE` and loads no server configuration: before it the helper's migrate could never
run), MR-74 (0440 files in the unit's private credentials directory: before it the runner refused its token), MR-75
(libpq's unix-socket URL, NX-18's `DATABASE_URL`: before it every database call failed with `Invalid URL`), MR-76
(the fixtures imported statically: before it the bundled server failed while loading). `bundle.json` says
`"patched": true` and the release manifest's `gitDirty` is true while any patch applies. Each patch goes when the pin
moves to a Whombat main commit that contains it; a patch that no longer applies fails the build. *All five gone
with NX-65.*

## NX-44 What the bundle's closure holds (2026-09-27)

Bundle path 18.3 MiB (the esbuild bundles are 6.9 MiB); closure 337 MiB: `nodejs-slim_24` (85.4 MiB itself, 225.6
MiB with its closure, of which 24.1 MiB only because `bin/node` embeds `process.config` with its build's `-dev`
include paths; not stripped, it is nixpkgs' Node as built), `gitMinimal` (52.2 MiB), glibc, `gcc-lib` (libstdc++ of
the node-pty addon). Not in it: pnpm, the dependency store, node-gyp, Python, the compiler, the web app and widget
(a managed server serves neither, MR-04), Claude Code or Codex (NX-37), and the embedded Postgres of the self-hosted
CLI, which `bundle:runtime` ships and the derivation removes (`whombat init` only; the appliance has PostgreSQL 17,
NX-18; its FHS binaries couldn't run here). `share/whombat/release-manifest.json` is the bundler's manifest as built:
its file list still names the removed embedded Postgres. On the appliance the real bundle adds 64.6 MiB to the host
closure (3117.8 → 3182.3 MiB; the bundle and gitMinimal; Node 24 is already there). `pkgs.git` instead of gitMinimal
would share the sandbox toolchain's git on the host but grow the runtime's own closure, which is what a runtime (class
1) update ships.

## NX-45 Notify, watchdog and what the real runtime needs from the units (2026-09-27; MR-37)

- **Notify and watchdog verified with the real bundle** (`runtime-real`): server and runner are `Type=notify`, their
  main PID is Node, READY arrives (Node runs `systemd-notify`, hence `NotifyAccess=all`, unchanged), and pings keep them
  up for several watchdog periods without a restart; a SIGSTOPped server misses them and systemd kills and restarts
  it (`Watchdog timeout`). `whombat.runtime.watchdogSec` stays 30 (VM tests 10). The pings run on a timer every half
  period while the event loop turns.
- **The helper's env file** `/etc/whombat/runtime.env` is now a copy owned by the runtime user, mode 0400 (was a 0444
  store symlink): the runtime reads it under `NODE_ENV=production`, where an env file must not be readable by group
  or others (MR-73). It holds no secret (peer authentication).
- **Credentials:** `LoadCredential=` files are 0440 in a directory only the unit opens; the runtime now accepts that
  (MR-74). Nothing changes in the units.
- **`DATABASE_URL`** stays NX-18's libpq form `postgresql://whombat@/whombat?host=/run/postgresql`; the runtime now
  parses it (MR-75).
- **systemd finding (the helper could never run the runtime's CLI):** `whombat-update-helper` had `User=root`
  next to `NoNewPrivileges=` and seccomp settings. With an explicit `User=` systemd installs the filters after its
  user change and leaves `CAP_SETUID` out of the permitted set (seen in the VM, systemd 260.4: the helper's permitted
  set `0x20006f` against its bounding set `0x2000ef`; the cause isolated with `systemd-run` on systemd 257: any one
  seccomp setting together with `User=root` and `NoNewPrivileges=yes` drops it, without `User=` the set is complete). Go's child then failed `setuid(951)` with EPERM, so `check-schema` and
  `migrate-runtime` answered `fork/exec …/bin/whombat: operation not permitted`. The helper unit now runs as root
  without `User=` (the default); every other setting is unchanged. No earlier test ran a helper operation that
  starts the runtime's CLI, and the stand-in has no CLI.
- The admin socket (0660 `whombat:whombat-admin`), `/health` for the manager's user (runner and nobody refused), the
  boot assessment and the console file (`whombat:whombat-console` 0640, a contract state, readable by the console)
  work as NX-20/NX-32 describe.

## NX-46 The factory runtime's first schema: `whombat-runtime-schema-init` (2026-09-27; MD-10)

In managed mode the server only validates the schema and exits 10 (`migration_required`) on a database that needs
migrating; migrations are the manager's, through the helper's `migrate-runtime`, which needs a TUF-verified,
**assigned** release and runs at an update's boundary (MG-18). A new appliance has an empty database and its factory
runtime has no assignment, so nothing ever created the schema (the stand-in needed none). The oneshot
`whombat-runtime-schema-init` (runtime target, after PostgreSQL and the profile seed, before server and runner, which
`want` it) runs the runtime profile's own `bin/whombat` exactly as the helper does (the runtime user, the helper's
environment and env file): `schema-check --json --env`, and **only** when that says `migration_required` with database
version 0 (no Whombat schema at all) `migrate --json --env`. Any other state (current, behind, newer, refused) is
logged and left to the manager. It is skipped before provisioning and for bundles without `bin/whombat` (the
stand-in). An empty database has nothing to checkpoint or roll back, so the manager's single-authority rule (MD-10)
is about every migration after this one. Verified in `runtime-real` (the schema of 47 migrations created in ~2 s,
then the server starts).

## NX-47 Which bundle an image gets (2026-09-27; PI-07)

`whombat.runtime.package` defaults to `pkgs.whombat-runtime` when `whombat.environment == "prod"` and to the stand-in
otherwise (dev images, `appliance-x86_64`, the VM tests), so building or testing a dev image never needs the private
Whombat source. The prod assertion is unchanged: a prod image whose package is marked `whombatStandIn` fails
evaluation. VM tests opt in with `vm-tests/common/real-bundle.nix` (the bundle, 3 GiB memory unless a test sets its
own). `checks.runtime-pin` evaluates it: prod gets the real bundle, prod forced onto the stand-in fails its
assertion, the dev image keeps the stand-in.

## NX-48 VM test `runtime-real` (2026-09-27; PI-08, runtime half)

`vm-tests/runtime-real.nix` boots the appliance with the real bundle against the fake control. The control node
(`vm-tests/common/real-runtime.nix`) republishes the development fixture repository (`release-tools/fixtures/dev/repo`,
signed with its committed DEVELOPMENT keys, root v1 = the pinned root of every VM test) at boot, with one more release,
`rt-real-1`: rt-fixture-1's tuple with the real bundle as its runtime (store path, NAR hash computed at build time,
version, the bundle's schema version) and no providers, plus a runtime artifact target whose file is a placeholder (the
bundle is in the VM's store, so the helper never stages it). Republishing in the VM keeps the timestamp fresh (dev
metadata signed at build time would expire a day later). The test covers: the profile seeded with the bundle; factory
provisioning with factory release `rt-real-1`; NX-46's first schema (47 migrations); server and runner `Type=notify`,
`NotifyAccess=all`, `WatchdogUSec=10s`, main PID Node from `nodejs-slim-24`, no restart over 35 s of pings, no failed
notification; the admin socket 0660 `whombat:whombat-admin`, `/health` `ok` with `checks.db.ok` for the manager's
user, the runner and nobody refused; the boot assessment passing; the console file written by the server
(`whombat:whombat-console` 0640, state `waiting` with the fake control, rendered by `whombat-console`); a SIGSTOPped
server killed on `Watchdog timeout` and back healthy; then, on an emptied database, the helper over its socket as the
manager with control's assignment for the device (signed in the control VM with the development assignment key):
`check-schema` → exit 10, database version 0; `migrate-runtime` → exit 0, `current`, read-write, all 47 applied, run
by the bundle's `bin/whombat` as the runtime user; the runtime healthy on the migrated database.

## NX-49 The existing suites with the real bundle (2026-09-27; PI-08, runtime half)

`vm-tests/common/real-bundle.nix` puts the real bundle on a suite's appliance nodes (`whombat.runtime.package`, memory
3 GiB unless the test sets its own); `vm-tests/default.nix` registers `appliance-basic-real-runtime`,
`manager-units-real-runtime`, `sandbox-backup-real-runtime` and `vault-wall-real-runtime`. `appliance-basic` was made
runtime-agnostic: it asks `/health` as the manager's user (the real runtime checks the peer; the stand-in answered
anyone), compares the profile with `whombat-runtime-profile-init`'s store path instead of the stand-in's name, and
hangs the server with SIGSTOP instead of the stand-in's `hang` fault. Stays on the stand-in only: `console-self` (it
writes the console file by hand and uses the stand-in's `claimed` fault; with the real server writing the same file the
screens would race; `runtime-real` covers the real server's file). `install-boot-luks` and `recovery-tpm` (boot chain,
disk, TPM) were not run with the real bundle; PI-08's `install-proxmox-vm` installs the real image.
Recorded runs (2026-09-27, the final tree, each driver with KVM as the user, NX-26): `runtime-real` 8/8,
`appliance-basic-real-runtime` 13/13, `manager-units-real-runtime` 6/6, `sandbox-backup-real-runtime` 6/6 (the
checkpoint drains the real runtime: writes paused 98 ms), `vault-wall-real-runtime` 8/8; with the stand-in
`appliance-basic` 13/13, `manager-units` 6/6, `sandbox-backup` 6/6, `vault-wall` 8/8, `console-self` 7/7,
`recovery-tpm` 11/11. `install-boot-luks` fails at "factory reset with the recovery key" (`device-mapper: remove ioctl
on whombat-persist failed: Device or resource busy`, `whombat-factory-reset` exit 5) on this branch **and** on its base
f49de9f alike: not caused by this work; fixed by NX-64 (`whombat-release-device`).
## NX-50 `whombat.platform`: hardware or a Proxmox VM (2026-09-27; PI-02, PI-09)
`nix/modules/options.nix`: `whombat.platform` ∈ `hardware` (default: the design so far, a UEFI machine with a TPM 2.0)
and `proxmox-vm` (the qualified Proxmox VE 9 VM of PI-09). The platform picks defaults, never overrides an explicit
setting: `whombat.storage.mode` (`luks-tpm2` / `host-encrypted`), `whombat.boot.secureBoot.autoEnroll` (on / off),
`whombat.provisioning.selfRequireSecureBoot` (true / false). `nix/profiles/proxmox-vm.nix` sets the platform and the
VM's devices (NX-52). The system records `"<platform> <storage mode>"` in `/etc/whombat/platform`, which the installer
reads (NX-51). Checks: `checks.proxmox-config` (evaluation), VM `install-proxmox-vm` (NX-59).

## NX-51 Storage mode `host-encrypted` (2026-09-27; PI-02, PI-03)
- **Layout:** NX-07's GPT (`whombat-esp`, `whombat-root`, `whombat-persist`) with ext4 and btrfs directly on the
  partitions, mounted by partlabel (same options, `/persist` `neededForBoot`). `whombat-persist-layout` makes the same
  subvolumes, the nodatacow `postgres` subvolume and the qgroup limit (NX-12) as on hardware.
- **No LUKS, no TPM:** no `boot.initrd.luks.devices`, no `whombat-tpm-seal`/`-reseal` (unit, path, timer), no PCR
  signature, no pcrphases, lanzaboote's plain `lzbt` (no policy signing wrapper), no maintenance keys.
- **Assertions:** `host-encrypted` needs `proxmox-vm` (in every environment: no guest encryption is acceptable only
  where the VM's host encrypts the disk); `proxmox-vm` never uses `luks-tpm2` (no TPM to unseal); `plain` stays refused
  in prod. So prod is `luks-tpm2` on hardware or `host-encrypted` on proxmox-vm, nothing else.
- **Installer:** `whombat-install` reads `$system/etc/whombat/platform`; `--platform` may only repeat it (a disk laid
  out for another platform wouldn't boot); `host-encrypted` needs no TPM and creates the file systems with
  `whombat-storage-init --host-encrypted`.
- **Tools tell the layouts apart on the disk** (`cryptsetup isLuks whombat-persist`), not from the image: the recovery
  environment is one UKI for both platforms (NX-56).

## NX-52 Boot and devices of the Proxmox VM (2026-09-27; PI-02, PI-09)
- **Secure Boot keys generated, not enrolled.** Lanzaboote stays the boot loader (boot counting, fallback, NX-04/05);
  `generate-sb-keys` makes per-device keys that sign every generation and the recovery UKI, but
  `autoEnrollKeys` is off and OVMF stays in setup mode (Secure Boot off). Enrolling would buy little without guest
  encryption (whoever can change the disk can change anything) and would tie the VM to its EFI vars disk: a firmware
  reset or a moved VM without its EFI disk would not boot. The keys are ready if a later profile enrols them (PI-12).
- **Devices:** `virtio_scsi`, `virtio_blk`, `sd_mod`, `sr_mod` in the initrd; the `i6300esb` watchdog module, petted by
  PID 1 (`RuntimeWatchdogSec`, NX-05); ballooning off in the VM spec.
- **Guest agent:** `services.qemuGuest` with `qemu-ga --allow-rpcs=` an allow-list (sync, ping, info, shutdown,
  fsfreeze-*, fstrim, get-fsinfo/-osinfo/-host-name/-time/-timezone, network-get-interfaces) instead of PI-09's
  `--block-rpcs`: an allow-list keeps `guest-exec`, the file, user, password and SSH-key RPCs *and whatever a newer QEMU
  adds* closed. Checked against the pinned `qemu-ga` 10.2.4 (every name exists) and in the VM test (`guest-exec`
  refused, `guest-info` lists nothing else enabled).

## NX-53 A disk recovery key for self-installed appliances (2026-09-27; PI-04; closes CC-10's deferral)
- `whombat-provision self` generates the key like the factory (256 bits from the kernel CRNG, systemd modhex, 8 groups
  of 8). It **always** stores its Argon2id hash root-only in `/persist/secrets/recovery-key.argon2id` (PHC string
  `$argon2id$v=19$m=65536,t=3,p=4$<16-byte salt>$<32-byte hash>` over the canonical key; a reader bounds the
  parameters so a crafted file can't exhaust the recovery environment). On encrypted hardware it also enrols it as a
  keyslot: the self settings list `luksDevices` when the storage is `luks-tpm2` (as the factory's station.json does),
  and the same N-7 clean-up of other slots applies. `device.json`'s `recoveryKeyEnrolled` keeps meaning “a LUKS
  keyslot”.
- The plaintext goes to the console once (NX-54) and nowhere else: not to control, not to the journal (the tool only
  says a key was created).
- `internal/recoverykey` holds the format, normalisation (ASCII case, whitespace, dashes, U+FEFF; nothing repaired),
  hash and the hand-over files; provisioning and the console share it. `whombat-provision recovery-key check`
  (key on stdin; exit 0, 4 for a wrong key) is what the host-encrypted tools and the recovery menu use.
- Re-registration (NX-35) keeps the key (it may be written down already); a box self-installed before this gets one
  then. `verify` requires the hash for model `self-installed`.
- Self-provisioning in prod: allowed when the platform is `proxmox-vm` (library, NixOS assertion; NX-57).

## NX-54 The console hands the key over once (2026-09-27; PI-04, CC-14)
- **Files.** Provisioning commits `/persist/console/recovery-key.json` (`{"v":1,"key":"…"}`, root:whombat-console
  0440, directory 0750 root:whombat-console by tmpfiles) before `device.json`, so a provisioned box never lacks it
  before it was confirmed, and it survives reboots until then. The console confirms by writing the typed group to
  `/run/whombat-console/confirm` (0600, directory 0700 whombat-console, the unit's only `ReadWritePaths`; written as
  a temporary file and renamed). `whombat-recovery-key-confirm.path` (root, `PathExists`) starts
  `whombat-provision recovery-key confirm`, which reads the confirmation without following links, and removes the
  plaintext (zeroed, unlinked, directory fsynced) only when the group is the pending key's last group **and** the
  pending key matches the stored hash; it records `secrets/recovery-key.confirmed` and always removes the confirmation.
- **Why this split.** The console is unprivileged and must stay so (no capabilities, no network). Alternatives:
  (a) a pending file owned by the console user, which the console deletes itself: a buggy or subverted console could
  then destroy or alter the only copy of the key, and root could not tell a confirmation from a deletion; (b) a root
  daemon with a socket for the console: a new privileged listener for a one-time event. The chosen design gives the
  console read access to one file and write access to one empty directory; root decides, re-checks, and never loses a
  key it hasn't seen confirmed. A subverted console can at worst confirm without the operator (it can read the key),
  which is the same power as the person at the console.
- **Screen.** While the pending file exists the console shows the recovery key screen and **nothing of the claim**
  (the runtime's state file is not read for display). Words: “Write down this recovery key. It is shown only once.”,
  the groups (up to four per line, a trailing dash on a continued line), “You need it to recover this Whombat or to
  reset it to factory settings.”, on host-encrypted storage “Keep this VM’s disk on encrypted storage, and never
  restore a snapshot or backup of it.” (PI-03's console notice), “Type the last group of the key and press Enter:”,
  `> …_`; refusals “That isn’t the last group. Check what you wrote down.” and “That didn’t work. Type the last group
  again.” (root took the confirmation but kept the key); “Saving…” while root checks. The QR code (`rsc.io/qr`, level
  L, byte mode: version 4, 33 modules) is drawn dark-on-light with half blocks and a 2-module quiet zone, beside the
  text when the screen is wide enough (80×25 and 64×24 fit), else above it, else left out; the banner footer goes
  first when the height is short. A pending file that exists but can't be read or parsed shows “The recovery key
  can’t be shown. Install this Whombat again from the installer.” and still hides the claim (fail closed). The QR
  code of the rendered screen decodes to the key (checked with zbar).
- **Keyboard (amends NX-32).** `StandardInput=tty-force` on tty1; the console puts the tty in raw mode (no echo, no
  line editing, no signal keys, no XON/XOFF) and reads it all the time, but key presses count only on the recovery key
  screen (and not while root checks): modhex letters (either case), Backspace, Enter; ESC-introduced sequences (CSI,
  SS3, OSC/DCS/APC/PM up to BEL or ST) are consumed whole, so an arrow key is never a letter; every other byte is
  dropped. What reaches the screen is modhex only; the pending key is validated to modhex before display (N-3 holds).
- After the confirmation the console moves on to the runtime's claim states at once; a reboot before it shows the same
  key again.

## NX-55 Erasing on host-encrypted storage is not cryptographic (2026-09-27; PI-02, PI-03)
`whombat-secure-erase` hands over to `whombat-host-erase` when `whombat-persist` is not LUKS: the disk recovery key is
checked against the hash (a never-provisioned box has nothing to protect; a provisioned one without a hash is refused
unless `--factory`), then every btrfs subvolume (deepest first) and file on `/persist` is deleted, the signatures are
wiped and the partition is discarded (`blkdiscard`), or zeroed where the disk can't discard; `--all` does the same to
the system volume from the recovery environment. `whombat-factory-reset` then makes a new empty btrfs and does the
same clean-up of the system volume as on hardware; the box provisions itself again. Written down honestly
(`factory-reset.md`, `install.md`): copies in Proxmox snapshots, backups, replicas and not-yet-reused host
blocks survive; the host must destroy those. Likewise the recovery key's plaintext, once confirmed, is zeroed and
unlinked, but on btrfs (copy-on-write) and a virtual disk the old blocks may keep it until reused; the host's
encryption covers them. The VM test asserts only that no file holds it.

## NX-56 One recovery environment for both layouts (2026-09-27; NX-13)
The menu detects the layout per boot (`cryptsetup isLuks`). With LUKS nothing changes. On host-encrypted storage
“asks for the disk recovery key” means: mount `/persist` read-only, `whombat-provision recovery-key check` against the
hash, unmount; the data volume is the partition itself; factory reset mounts the system partition directly; re-seal
says there is nothing to seal. The prompt is “Disk recovery key:” and the menu “Every action except 7-9 asks for this
Whombat's disk recovery key.” (the card is not the only place a key comes from any more). The factory reset logs
`factory reset finished|failed` to the kernel log. The recovery UKI's initrd gains `virtio_scsi` (Proxmox's
controller). `whombat-storage-status` reports a non-LUKS partition and whether a recovery key is stored/confirmed.

## NX-57 Self-provisioning on proxmox-vm and in prod (2026-09-27; PI-02, PI-10; amends NX-33)
- `self-provision.json` gains `platform` (and `luksDevices` on luks-tpm2 hardware, NX-53). The tool forces
  `requireSecureBoot` in prod **except** on `proxmox-vm`, which has no Secure Boot by design (NX-52); the NixOS default
  of `selfRequireSecureBoot` follows the platform.
- The prod assertion of NX-33 becomes: `selfRegister` in prod only with `platform = "proxmox-vm"`. The library refuses
  self-provisioning in prod on other platforms, LUKS volumes on proxmox-vm, and factory provisioning (`provision`,
  `station`) on proxmox-vm.
- The Proxmox images turn the factory medium off (`factoryMedium = false`): a stick labelled `WBFACTORY` must not
  provision a self-installed box.

## NX-58 A VM's serial and factory reset (2026-09-27; CL-34)
Proxmox gives the VM no DMI serial, so the serial is `MID-` + HMAC of the machine id (NX-33), stable for the life of the
installation. Factory reset keeps `/etc/machine-id` (on the system volume), so a reset box registers again **with the
same serial** and control refuses it (`device_exists`) until the old device is retired (CL-34: serials are unique among
live devices). Decision: keep the serial (one VM is one unit, as on hardware); the owner releases the old device in
the app and an operator retires it, as `factory-reset.md` already says for hardware. The VM test retires it through
the fake control. Open item for control/manager: retire on a device-signed factory reset notice instead.

## NX-59 VM test `install-proxmox-vm` (2026-09-27; PI-08)
`vm-tests/install-proxmox-vm.nix`, in `checks.x86_64-linux`: an installer VM runs `whombat-install` on a blank disk
(refuses `--platform hardware`; no LUKS); the target boots it as Proxmox would: q35 + OVMF with Secure Boot in setup
mode (no keys), **no TPM**, the disk on **virtio-scsi** (`-device virtio-scsi-pci` + `scsi-hd`, not the driver's
virtio-blk), `-device i6300esb`, the guest agent on a virtio-serial port. It checks: keys generated and not enrolled,
Secure Boot disabled, no TPM units, subvolumes and qgroup; the watchdog is active; the guest agent pings, freezes
status, refuses `guest-exec`; self-provisioning against the fake control (MID serial, `origin: self`), the hash and
pending file modes, only the console reads the key and can't change or remove it; the console shows the key and not
the claim code, the same key after a reboot, refuses a wrong group, ignores arrow keys, and after the right group
(typed in upper case) the plaintext is gone and the claim screen follows (also after a reboot); a host update whose
assessment fails falls back to the known-good after 2 attempts; factory reset refused with a wrong key in the running
system and in the recovery menu, done from the recovery menu with the right key, after which the box provisions
itself again with a new key. NX-26's table gains this row.

## NX-60 An image for the public dev instance (2026-09-27; PI-10)
`nixosConfigurations.appliance-proxmox-x86_64`, `installer-proxmox-x86_64`, `packages.installer-iso-proxmox`
(`whombat-installer-proxmox-dev.iso`) = proxmox-vm + `nix/profiles/dev-instance.nix`: control
`https://api-dev.whombat.com`, TUF `https://updates-dev.whombat.com/{metadata,targets}/`, app `https://dev.whombat.com`,
embed `https://embed-dev.whombat.com`, `selfRegister`. **Environment `local`, not `dev`:** the dev instance's control
runs `CONTROL_ENV=local` (a `dev` registration is refused, `wrong_environment`), and its TUF repository
(`tufrepo --env local`), licence set and client channel keys are `local` as well. Trust is pinned from the repository:
`manifest/dev-instance/{tuf-root,licence-keys,client-channel-keys}.json`, copies of the instance's public documents
(README there: provenance, refresh after an instance reset). The instance needs `WB_MGD_SELF_REGISTRATION=1`. It runs
the stand-in runtime until the runtime bundle (PI-07) is the image's runtime, so it can't be claimed before that.
Finding recorded there: the dev instance serves its TUF private keys publicly (`/keys/` under updates-dev).

## NX-61 The prod image's inputs (2026-09-27; PI-10)
`nixosConfigurations.appliance-prod-proxmox`, `installer-prod-proxmox`, `packages.installer-iso-prod-proxmox`
(`whombat-installer-proxmox.iso`) = proxmox-vm + `nix/profiles/prod-instance.nix`: environment `prod`, control
`https://api.whombat.com`, TUF `https://updates.whombat.com/{metadata,targets}/`, app `https://app.whombat.com` (the
prod default), no embed origin (NX-39), `selfRegister`. `whombat.helper.tufRoot` and `whombat.licence.keys` are read
from `manifest/prod/tuf-root.json` and `manifest/prod/licence-keys.json`; while either is missing, evaluation throws a
message naming the file and what publishes it (PI-05, PI-11). With both present, the remaining failure is the
stand-in assertion (“prod needs the real Whombat runtime bundle”, PI-07) — checked with stand-in files. Not pinned
yet: client channel keys (no prod channel, a build warning) and `selfFactoryRelease` (null: the manager's journal
stays unprovisioned and takes no updates until the ISO build names the release it was built from; publishing
workstream, PI-10/PI-11).

## NX-62 The installer ISO's volume id (2026-09-27)
26.05 asserts ISO 9660's 32-character volume id; the default `nixos-whombat-installer-26.05-x86_64` is 36, so no
installer ISO (the generic one included) evaluated. `isoImage.volumeID = "WHOMBAT-INSTALLER"`; the flake names each
ISO file (`whombat-installer`, `whombat-installer-proxmox-dev`, `whombat-installer-proxmox`).

## NX-63 Installed disks get their `/persist` subvolumes (2026-09-27; fixes NX-07)
Found by `install-proxmox-vm`: on a disk written by `whombat-install`, `/persist/{postgres,secrets,manager,backup,
whombat/home,whombat/workspaces,whombat/credentials}` already exist as plain, empty directories at the first boot
(installation's activation creates them), and `whombat-persist-layout` left every existing path alone, so an installed
box had **no subvolumes and no qgroup limits** (backups fell back to copies, NX-12's reservation didn't apply). This
affected the hardware (LUKS) install as well; the direct-boot tests never saw it because their `/persist` is formatted
at boot. `whombat-persist-layout` now turns a path that holds nothing but empty directories (no file, no link, no
nested subvolume; `find -xdev ! -type d -o -inum 256`) into a subvolume; tmpfiles restores owners and modes after it.
A directory with anything in it is still never converted (logged, as before). Devices installed before this get their
subvolumes at the next boot only where those directories are still empty.

## NX-64 Two install-path defects the Proxmox work surfaced (2026-09-27)
- **The recovery UKI was corrupted on the first boot of every ISO install.** The installer copies the unsigned
  recovery UKI (~575 MB) to the 1 GiB ESP; at first boot `whombat-recovery-install` signed it into a second copy
  next to it, which doesn't fit, and the truncated result was renamed into place and marked signed (systemd-boot:
  “Error loading EFI binary … Unsupported”). `recovery-tpm` never saw it because its installer doesn't pre-copy the
  UKI. Now the unit removes the old copy first when the ESP can't hold two, verifies the signed file (`sbverify`)
  or the plain copy (`cmp`) before the rename, and writes the marker only after it. `install-proxmox-vm` checks the
  installed copy verifies and boots the recovery menu from it.
- **Factory reset in the running system could not close `/persist`.** Sandboxed units (the backup units'
  `TemporaryFileSystem`/`BindReadOnlyPaths` under `/persist`, `ProtectSystem`) keep their own mount of `/persist`
  after the host unmounted it, so `cryptsetup close` (hardware) or the wipe (host-encrypted) found it busy; it became
  visible once installed disks really had subvolumes (NX-63). `whombat-release-device DEV` (appliance tools) finds
  every process whose mount namespace still has the device mounted (by source, `findmnt --task`: btrfs shows an
  anonymous device number in mountinfo), stops their units, and retries; `whombat-secure-erase` and the host erase run
  it before closing or wiping. Verified by `install-boot-luks` (hardware) and `install-proxmox-vm`.

## NX-65 The pin moves to Whombat main a2abeeb; no patches left (2026-09-27; PI-07, NX-42, NX-43)
Whombat main `a2abeeb` is the merge of `prod-image-runtime` (MR-72…MR-76). `flake.nix` pins that rev
(`lastModified` 1790514497), `nix/packages/runtime` names candidate `0.15.3` (IN-77), and the five patch files and the
`patches` list are gone: each reverse-applies cleanly to `a2abeeb` (`git apply --check -R`), so the tree is the commit.
The git shim answers a clean `status`, `bundle.json` says `"patched": false` and the release manifest's `gitDirty` is
false. `a2abeeb` changes no `package.json`, `pnpm-lock.yaml` or `pnpm-workspace.yaml` against `579455c`, so the pnpm
dependency hash stays (re-fetched with `--rebuild` to confirm). A later pin that needs a fix again adds a `patches`
list back (and the shim's dirty answer with it).

## NX-66 A release of the Proxmox image: one id, one tuple, one ISO (2026-09-27; PI-10, PI-11; closes NX-61's `selfFactoryRelease`)
- **The ISO's installed system is a published release.** `lib.proxmoxRelease { env; releaseId; runtimeLabel ? null; }`
  (flake) builds the dev (`dev-instance.nix`) or prod (`prod-instance.nix`) Proxmox appliance with
  `whombat.provisioning.selfFactoryRelease = releaseId`, and its installer ISO. The id is chosen first: the toplevel
  contains it, so it can't name the tuple's hash, only its id. Every host release sets its own id, so a box that took
  release N and is then reset provisions again with the tuple of the system it runs.
- **`release/build-proxmox <dev|prod> <releaseId> [--reuse-host build.json] [--runtime-label L] [--out DIR]`**
  builds toplevel, manager and runtime from a commit (`git+file://…?rev=`; prod refuses a dirty tree), fills the
  `ReleaseTuple` from the bundle (`schemaWrites` = migrations in `migrations/compat.json`, `schemaReads.min` = the
  1-based position of its `runtime.readsFrom`, `max` = `schemaWrites`; protocol `{major*1000, major*1000+minor}` of
  the server's `SESSION_PROTOCOL`; host ABI 1 on both sides; no providers, NX-37), runs `tufrepo export-release`,
  copies the ISO with `SHA256SUMS` and writes `build.json` (source commit, Whombat pin, class, tuple, artifacts with
  store path, NAR hash and closure size, ISO store path/size/sha256). `host.version` is the release id (the host has
  no version of its own), `manager.version` the Go module's, `runtime.version` the bundle's.
- **Runtime-only releases** (`--reuse-host`) take host and manager (and their NAR hashes) from the earlier
  `build.json`; `export-release --reuse-host` leaves the host out and `publish-release` finds it in the repository. No
  ISO. `--runtime-label` (dev only) rebuilds the same bundle as `<version>.<label>` (NX-71) so the runtime-only path
  can be proven without a Whombat pin bump, or a dev host release avoids a bundle version the repository already holds.
- The dev image runs the real runtime bundle (`dev-instance.nix`), not the stand-in NX-47 gives non-prod images: a box
  installed from it is claimed and used on dev.whombat.com.
- Reproducible: `nix build --rebuild` of `pve-dev-20260927.1`'s ISO from its commit reported no difference (V-63).

## NX-67 Release ids of the Proxmox image (2026-09-27)
`pve-YYYYMMDD.N` for production, `pve-dev-YYYYMMDD.N` for the dev instance: the UTC day the release is built and a
counter from 1 that day (the script checks the pattern and that the day is a date). Within the helper's release-id
pattern (`^[a-z0-9][a-z0-9._-]{2,79}$`), sortable per environment, visibly not a candidate (`rt-…`) or a fixture, and
the prefix keeps a dev tuple from ever being mistaken for a prod one in logs (the keys already keep them apart,
MA-14). An id is never reused.

## NX-68 Real releases on the dev instance (2026-09-27; PI-11's dev analogue)
`dev/publish-release <release-dir> [--rollout <device>]` (`harness/src/dev/publish-release.ts`) does for the dev
instance what control `deploy.sh release [--rollout]` does on production: checks `SHA256SUMS`, `tufrepo
publish-release` into `$WB_MGD_HOME/env/manager/tuf` (environment `local`, the instance's development keys; the tool
re-verifies every stream), registers the tuple with control's operator API and checks both digests agree. Control has
no per-device assignment, only rollouts over cohorts, so `--rollout <device>` marks that device internal and starts a
one-wave rollout to the internal cohort; it refuses while another live device is internal or a rollout is open (the
instance's own appliance is `general` and must never be swept along). `harness/src/dev/releases.ts` keeps publishing
the fake runtime releases of the scenarios.

## NX-69 The runner reaches the server, and agents are live (2026-09-27; found end to end, V-63)
The real bundle's runner never took a turn on an appliance; `runtime-real` checked unit readiness, not that the
runner connects. Found on the dev Proxmox image, in the order they showed:
- **Port.** The server listened on the bundle's default 4400, but the runner's nftables wall (`sandbox.nix`, MA-14)
  lets it reach only `whombat.sandbox.serverPort` (4620) on loopback and rejects the rest of 127.0.0.0/8; and the
  runner's default origin `http://localhost:$PORT` resolved to `::1` first while the server listens on `127.0.0.1`
  only. Every heartbeat and claim failed (`TypeError: fetch failed`) and agents answered “Whombat’s agent runner isn’t
  running on the host”. The runtime units now set `PORT` = `WHOMBAT_SERVER_URL`'s port = `sandbox.serverPort`.
- **Agents.** The bundle defaults to `WHOMBAT_AGENTS=scripted`, which never starts the managed runner (sandbox,
  installed clients, people's sign-ins) that `sandbox.nix` and `providers.nix` configure: now `live` (server and
  runner; `whombat.runtime.environment` can still override).
- **Sandbox.** bubblewrap reads `/proc/sys/kernel/overflowuid`, which the runtime's `ProcSubset=pid` hides (“sandbox
  unavailable … every live turn is refused”): the runner gets `ProcSubset=all` (other units' processes stay hidden,
  `ProtectProc=invisible`). The sandbox's network proxy needs `socat`: now on the runner's `PATH`.
- **Still open (the sandbox workstream decides):** with these fixes the runner connects (`→ http://127.0.0.1:4620 ·
  agents=live`, an agent's reply names the missing provider instead of the missing runner), but the managed sandbox
  still can't start: `bwrap: Can't mount proc on /proc: Operation not permitted`, so every live turn is refused. Most
  likely the kernel refuses a new procfs because the unit's `/proc` isn't fully visible (`ProtectProc=invisible`, and
  the read-only overmounts of `ProtectKernelTunables`/`ProtectKernelLogs` from the runtime's shared hardening). The
  choice is between relaxing those for the runner (the sandbox is its isolation) and a bwrap that binds `/proc`
  instead of mounting one. No VM suite runs a live turn through the real bundle; one should.
- Also open: the runner can't read `/persist/whombat/home/acp-runtimes.json` (the server's 0700 home; EACCES), which
  only matters for ACP agents.
- *Both closed by NX-73 (the sandbox), NX-76 (the runner's own home) and NX-77 (two runtime fixes); `runtime-live-turn`
  runs a live turn (NX-75).*

## NX-70 The prod image pins the AI client channel keys (2026-09-27; NX-37, NX-61)
`prod-instance.nix` sets `whombat.clients.channelKeys` from `manifest/prod/clients-channel-keys.json` (kid
`clients-prod-f48fce374ded`, committed with the prod root and licence set, PI-14) and names it when missing. Without
it the prod image warned “installs no AI clients”: no Claude Code or Codex, so no agent could run a turn.

## NX-71 A release's runtime reports its Nix version (2026-09-27; found end to end, V-63; MG-09)
The manager accepts a candidate (and, after a rollback, the known-good) only when the runtime's `/health` version is
the tuple's `runtime.version`. The bundle compiles in package.json's version (`0.1.0` at every pin so far) while the
package is `0.1.0-<rev>`: a tuple naming either one fails. Naming the Nix version failed every health check (dev host
release `pve-dev-20260927.2` stayed `Verifying` for its 30 minutes, rolled back, and the rolled-back known-good,
`pve-dev-20260927.1`, failed the same check, so the journal stays `Verifying`/`known_good_unhealthy` for good: the
box runs, but takes no update until it is reset or reinstalled). Naming `0.1.0` would collide in TUF at the next pin
bump that leaves package.json alone (`runtime/<version>/whombat-runtime.closure`, and `publish-release` refuses
different bytes under a published path). So the release path builds the bundle with `bundle:runtime --version <Nix
version>` (Whombat's `ReleaseVersion`: `x.y.z[-pre]`, no `+build`), follows the renamed bundle directory in the install
step and writes the version into `bundle.json` (`lib.proxmoxRelease`, an override that fails evaluation if the runtime
derivation's lines move); `release/build-proxmox` refuses a bundle whose `release-manifest.json` version isn't the
Nix version. `--runtime-label` makes `<version>.<label>`. Dev releases `.1` and `.2` are unusable (`.2` quarantined in
control; don't install `.1`'s ISO). Proposed for `nix/packages/runtime` itself (owned by the pin work): pass
`--version ${version}` there, so every image's runtime reports what its tuple will say.

## NX-72 What the first end-to-end run on the dev instance left open (2026-09-27; V-63)
- *The QR code and the boot status lines: fixed by NX-74.*
- **The QR code of the recovery key can't be scanned on the VT.** The console draws it with ▀/▄ half blocks; the
  console font (`ter-v32b`, 512 glyphs) has █ but neither half block, so the kernel draws `#` for them (zbar finds no
  code in a VT screenshot; NX-54's zbar check decoded the rendered text, not the VT). The key's text is fine. Fix
  options: a console font with U+2580/U+2584 (Terminus' 512-glyph `ter-v*` sets lack them), or full-block modules at
  one module per cell with a smaller font.
- **Boot status lines overwrite the console** until its minute refresh (the recovery key screen at first boot is
  unreadable for up to a minute). Candidate: `systemd.settings.Manager.ShowStatus = "error"` on the appliance.
- **After a factory reset the console says “Starting Whombat…” indefinitely** while control refuses the same serial
  (`409 device_exists`, NX-58) until an operator retires the old device; nothing tells the person at the console why.
- **A prod box can't run a live agent turn yet** (NX-69's open sandbox item): claim, updates and the runtime work;
  agents answer, but only to say why they can't.
- **Control's device status lags.** The status control keeps was mostly the one sent about 10 s after each boot (the
  manager reports status on a slow cycle, about 15 minutes), so the operator API showed `Verifying` for many minutes
  after the box logged `Healthy`; rollout counters (progress reports) were current. Those early reports all say
  `clockSynced: false`, although chrony synced seconds later (NTS and NTP sources, the clock stepped 1.3 s). A status
  report after the first sync and after an update's last transition would make both right.
- **A failed first-boot `manager provision` is permanent:** `whombat-self-provision` fails after `device.json` exists,
  its restart exits at the `device.json` condition, and the journal stays unprovisioned until a reset. Publishing the
  release before installing its ISO avoids it (`release-build.md`); a retry of the factory-tuple step alone would fix it.

## NX-73 The runner's unit lets bubblewrap build its sandbox (2026-09-27; NX-69's open item, NX-21, Whombat MS-03/MS-04)
**Cause, reproduced in a VM** (kernel 6.18, systemd 260; a unit with the runner's hardening running
`bwrap --unshare-all --proc /proc true`, one variant per option): from a user namespace the kernel mounts a new procfs
only when the caller's `/proc` is fully visible, i.e. no locked mount covers anything under it (`fs/namespace.c`
`mount_too_revealing`). Three options of the runtime's shared hardening put such mounts there:
`ProtectKernelTunables` (read-only `/proc/{sys,sysrq-trigger,acpi,bus,fs,irq,mtrr,scsi}`, inaccessible
`/proc/{kcore,kallsyms}`), `ProtectKernelLogs` (`/proc/kmsg`) and `ProtectHostname` (read-only
`/proc/sys/kernel/{hostname,domainname}`). Any one of them is enough to fail (`bwrap: Can't mount proc on /proc:
Operation not permitted`); `ProtectProc=invisible`, `ProtectClock`, `ProtectKernelModules` are not involved. Behind it
two more blockers showed: `sethostname` is outside `@system-service`, so bubblewrap's `--hostname whombat-task` (both
stages) is killed with SIGSYS; and `ProtectControlGroups=yes` mounts `/sys/fs/cgroup` read-only, so the runner can't make
its task cgroups in its delegated subtree (`supervisor/`, `tasks/<task>`; EROFS, “no task cgroups”).
**Decision (runner unit only, `sandbox.nix`):** `ProtectKernelTunables=false`, `ProtectKernelLogs=false`,
`ProtectHostname=false`, `ProtectControlGroups=private` (a cgroup namespace with a writable mount of the unit's own
subtree only; the rest of the hierarchy is out of sight; the nftables wall matches the real cgroup path), and
`sethostname` added to the allow list. Everything else stays: `ProtectSystem=strict`, `PrivateDevices`,
`ProtectKernelModules`, `ProtectClock`, `ProtectProc=invisible` (other units' processes stay hidden), `ProcSubset=all`
(NX-69), the empty capability bounding set, the syscall filter (`syslog(2)`, what `ProtectKernelLogs` also denied, stays
outside it: `dmesg` dies with SIGSYS in the unit), `RestrictSUIDSGID`/`NoNewPrivileges` as NX-21 sets them. What the
three guarded is root's or a capability's to change (`/proc/sys`, `/proc/sysrq-trigger`, the hostname), and the runner
has neither on the host; `kernel.dmesg_restrict`, `kptr_restrict=2` and `sysrq=0` still hold. The server and every
other unit keep their hardening (`checks.runner-sandbox`).
**Not a bound `/proc`:** a bubblewrap that binds the runner's `/proc` instead of mounting one would show each task the
runner's pid namespace: every `whombat-runner` process — the runner, and the other turns, which run as the same uid
for other people — with their command lines and, as the same uid, their environments (each turn's working directory,
credential home and MCP endpoint), their open files and their cgroups. A fresh procfs shows a task its own pid namespace
only (`runtime-live-turn`: 2 processes, pid 1 bwrap). The sandbox is the runner's isolation; relaxing the runner's own view of
`/proc` gives a task nothing (a task never sees the runner's `/proc`), binding it would.

## NX-74 The console draws the QR code, and nothing draws over it (2026-09-27; NX-72 follow-up)
- **Font:** `whombat.console.font` defaults to `whombat-v32b` (`nix/packages/console-font`): Terminus 16×32 bold
  (`ter-v32b`, 512 glyphs) with ▀ (U+2580) and ▄ (U+2584) in place of the shades ░ (U+2591, glyph 5) and ▒ (U+2592,
  glyph 7), cut from Terminus' own █. Where they go matters: `/dev/vcsN` gives the glyph index as one byte per cell, so
  the first choice (the double-line crossings ╬ ╪, glyphs 13 and 18) turned every ▀ into a carriage return in the
  screen's text and `console-self` could no longer read tty1; the build now refuses a drawn character whose index's
  low byte reads as `\b \t \n \r`. No 16×32 Terminus set has both the half blocks and the console's typography
  (`… ’ “ ” × é €`): the 512-glyph set lacks the half blocks, the CP437 set (`ter-i32b`) has them and none of the rest.
  The build fails unless the font maps every character the console draws. Any `ter-*` name still works.
- **Quiet tty1:** `systemd.show_status=error` on the kernel command line (PID 1 shows failures only, in the initrd too;
  password prompts aren't status lines) and `boot.consoleLogLevel = 3` (mkDefault; only emerg, alert, crit reach the
  console; the VM tests' instrumentation keeps its verbose serial console). Everything stays in the journal.
- Checked by `checks.console` (font, `systemd.show_status=error`, `loglevel=3`) and `install-proxmox-vm`, which reads
  the QR code from a screenshot of the VT with zbar and compares it with the key.

## NX-75 A live agent turn in a VM test (2026-09-27; `runtime-live-turn`)
`vm-tests/runtime-live-turn.nix` runs a turn through the real bundle: provisioning as in `runtime-real`, the real server
and runner units, the managed sandbox (both bubblewrap stages, delegated task cgroups, the nftables wall), and an agent
CLI inside it. No real provider and no model:
- **The CLI** is `common/live-turn/fake-claude.js`: Claude Code's stream-JSON protocol for one turn (answers
  `initialize`, prints a `result`), whose reply is what it saw of its sandbox (pid namespace, `/proc/1/cmdline`,
  processes, uid, hostname, seccomp, no_new_privs, which appliance paths exist, whether control's port is reachable).
  The test installs it as the manager installs a client (`/persist/whombat/clients/claude/0.0.0-fake/claude`,
  `whombat-manager`, 0555) and announces it as the manager does (`POST /clients` on the admin socket, as
  `whombat-manager`); the manager itself is stopped (it has no client channel in the VM and would replace the status).
- **The message:** a managed runtime takes people's writes only through the encrypted session (control, relay, a
  claimed box). `common/live-turn/world.ts`, bundled with esbuild from the pinned Whombat source (the runtime
  derivation's source, patches and pnpm store), loads the server's integration-test world (`seed/test-world`, as
  `useManagedRuntime({ seed: true })` does; the agent Pippa on `claude` with the `requester` credential source) and
  commits “@Pippa …” through the commit pipeline, as the int tests do. It runs as a oneshot unit with the server unit's
  environment and credentials, server and runner stopped. The running server hands the queued dispatch to the runner
  like any other. A test-only artifact, never in an image.
- **The sign-in:** the requester's Claude home planted as the runner keeps them (`subscription_cli`, as the harness's
  `k-live-agents` K5 does).
- **Shown:** the dispatch is `done`; the agent's reply is the CLI's report, posted by the runner through the server's MCP
  endpoint; pid 1 of the CLI's pid namespace is bwrap and that namespace isn't the runner's, it sees 2 processes, uid
  1000, hostname `whombat-task`, seccomp filter and no_new_privs on, no `/persist/whombat/home`, `/persist/secrets` or
  `/run/whombat`, and control's port unreachable (the host reaches it). Also the unit facts of NX-73, NX-76.

## NX-76 The runner has a home of its own (2026-09-27; NX-69's EACCES, NX-20, NX-37)
The runner's `WHOMBAT_HOME` was the server's (`/persist/whombat/home`, 0700 `whombat`). The runner derives its own
state from its home: the ACP runtimes it looks for at start (`acp-runtimes.json`: EACCES logged at every start), the
empty `gh` config directory of guarded agents (`guarded/gh`: EACCES, **every guarded turn failed**, found by
`runtime-live-turn`), workspace locks (`locks/`, for direct checkouts), and defaults the appliance already sets
explicitly (credentials, runner state, workspaces). The runner now gets
`WHOMBAT_HOME=/persist/whombat/runner/home` (`whombat.runtime.runnerHome`, 0700 `whombat-runner`, tmpfiles, inside its
state directory, not in the backup set: nothing there outlives a turn); the server keeps `/persist/whombat/home`. The
runner reads nothing of the server's home. Tasks never saw either (the sandbox mounts nothing of `/persist` but the
clients root, the turn's credential home and its workspace; both homes are also on the sandbox's denied list).

## NX-77 Two Whombat fixes carried as patches (2026-09-27; NX-43, NX-71; Whombat branch `pi-sandbox`)
`runtime-live-turn` found two runtime defects that stop every live turn on an appliance; both are fixed on Whombat branch
`pi-sandbox` (from main `26fc244`, not merged; `pnpm check` and `pnpm test:server` green) and carried in
`nix/packages/runtime` as code-only patches (NX-43), since the pin must stay at candidate 0.15.3's `a2abeeb`
(`checks.runtime-pin`):
- **SUB-54** (`whombat-sub54-clients-file-mode.patch`): the server wrote the runner's clients file with the create mode
  0644, which the unit's `UMask=0077` made 0600: the runner never saw an installed client. Now 0640, set explicitly.
- **MR-77** (`whombat-mr77-sandbox-shim.patch`): the release never shipped the managed sandbox's stage-1 shim
  (`app/shim.mjs`, opened next to the runner bundle): every sandboxed turn failed with `MODULE_NOT_FOUND`, while the
  probe (which doesn't start the shim) passed. The runtime derivation's install check now requires `app/shim.mjs`.
A patched bundle is other bytes than the commit's, so its Nix version says so: `<version>-<rev>.p<first 7 hex of the
sha256 of the patches>` (now `0.1.0-a2abeeb.p26a328c`); it never takes a published `runtime/<version>/` target of the
unpatched commit (NX-71). `bundle.json` says `"patched": true` and the release manifest's `gitDirty` is true. The
candidate file is unchanged: a new candidate names the patched runtime (or a Whombat main commit with `pi-sandbox`
merged, which drops both patches). *Both gone with NX-86.*

## NX-78 The graphical console's server: the same program, a loopback of its own, a token per start (2026-09-27; CG-03, CG-06)
- **Program and authority.** `whombat-console --serve 127.0.0.1:8411 --ui <pkgs.whombat-console-ui>/share/whombat-console-ui
  --token-file /run/whombat-console-ui/token` (unit `whombat-console-server`, `Type=notify`) is the text console's
  program with the same user (`whombat-console`), the same files and the same validation (`console/internal/source`:
  bounded reads, no final symlink, regular files only; `screen.Parse`). The recovery key's state machine moved into
  `console/internal/screen` (`KeyScreen.Sync`, `Press`, `Submit`): the text console's key presses and
  `POST /api/confirm` go through the same code into the same confirm file and root path unit (NX-54). The text
  console is unchanged (CG-05) and gained `--once --json`, which prints the Console API's state from the same files
  (the VM tests compare the two).
- **Network.** `PrivateNetwork=true`: the server listens on the loopback of its own network namespace; the kiosk joins
  it (`JoinsNamespaceOf=`, NX-82) and nothing else on the box can connect (`console-self`: the host's `127.0.0.1:8411`
  refuses, the namespace has `lo` only and no route out). `IPAddressAllow=localhost`, `RestrictAddressFamilies=AF_INET
  AF_UNIX` (the loopback and the notify socket); everything else of the text console's hardening stays, including
  `MemoryDenyWriteExecute` and the empty capability set. `ReadWritePaths` = the confirm directory and the token directory.
- **Token.** 32 bytes from the kernel CRNG, base64url (43 characters), new at every start. The server listens first,
  then writes `/run/whombat-console-ui/token` (a new file next to it, `O_EXCL|O_NOFOLLOW`, `fchmod 0640` whatever the
  umask, fsync, rename), then sends `READY=1`; it removes the file when it stops. The directory is
  `2750 whombat-console:whombat-kiosk` (tmpfiles, kiosk.nix): the setgid bit gives the file the kiosk's group, so the
  kiosk reads it and no other unprivileged user does (`console-self` checks `whombat`, the runner, the manager and
  the backup user). The kiosk's launcher reads it once and opens `http://127.0.0.1:8411/#t=<token>`; the page sends
  it as `Authorization: Bearer`. It is in Chromium's command line, visible to root and to what can see the kiosk's
  processes (the appliance's services run with `ProtectProc=invisible`); the loopback it opens is the kiosk's alone
  anyway, so the token guards against the page's own mistakes (a stray page in the kiosk), not against other users.
  A restarted server has a new token: its `ExecStartPost=` restarts a running kiosk (`reset-failed` first, so that
  restart doesn't count against the kiosk's start limit, NX-82).
- **HTTP front** (`console/internal/web`, shared with the installer, NX-79): only a loopback address can be served;
  only `Host: 127.0.0.1:<port>` or `localhost:<port>` is answered (403 otherwise: no DNS rebinding); `/api/` needs the
  token (constant-time compare, 403); files: GET/HEAD only, no directory listing, no dot files, any `..` segment,
  backslash or NUL refused (404), a path without an extension that names no file is the page (`index.html`). Every
  response: `Cache-Control: no-store`, `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a CSP
  (`default-src 'self'`, no inline script). Bodies ≤ 1 KiB (installer 4 KiB), `application/json` only (415), one
  value; `ReadHeaderTimeout` 5 s, `ReadTimeout` 10 s, `WriteTimeout` 30 s, `IdleTimeout` 60 s, 8 KiB headers.
- **API details** (CG-29): `footer` is the banner's lines joined by `\n` (hard-wrapped at 80 columns for the VTs;
  the page may reflow); `claimUrl` is the file's `url` without its scheme and `appUrl` its host (the file names no
  other URL); `code`, `retryAt`, `burrows` are omitted outside their states. `burrows` comes from the contracts 0.17.0
  bindings (`local.ConsoleState.Burrows`, CT-116); a file that is valid only without its burrows keeps its claim state
  and drops them (a runtime that gets a name wrong never blanks the console), and the name is cleaned again (C0, C1,
  Cf, Zl, Zp) and cut to 64 code points before the page gets it.

## NX-79 `whombat-installer-ui` (2026-09-27; CG-11…CG-14)
`console/cmd/whombat-installer-ui` (package `pkgs.whombat-installer-ui`; its tests run with the console's in
`go test ./console/...`), unit `whombat-installer-ui` on the installer ISO (`installer-base.nix`, `whombat.installer.gui`,
default on): root (it erases and installs a disk), the host's network namespace (the pre-flight reaches the image's
hosts), `127.0.0.1:8412`, the token of NX-78 in `/run/whombat-installer-ui/token` (`2750 root:whombat-kiosk`). It
reads what it installs from `<system>/etc/whombat/image.json` (NX-80) and runs the checks once at start.
- **Checks** (CG-13, concurrently, re-run by `POST /api/preflight`): `uefi` = `/sys/firmware/efi` exists (value
  `UEFI`/`BIOS`); `cpu` = the CPUs the process may run on (`N cores`); `memory` = MemTotal rounded to the nearest GiB
  (NX-80); `disk` ok with the names of the eligible disks, fail without one; `network` = the first global IPv4
  address of an interface that is up (else a global IPv6 one), waiting up to 20 s for one (DHCP may still run when the
  installer starts), warn without; `reach-*` = a TLS handshake with `<host>:443` verified against the ISO's CA bundle,
  8 s, warn when it fails or the image names no host (value = the host).
- **Disks:** `lsblk --json --bytes --tree -o NAME,PATH,TYPE,SIZE,MODEL,MOUNTPOINTS,LABEL,FSTYPE,RO`, type `disk` only
  (no ROMs, loop, zram, RAM disks). Not eligible, first match: `installer-medium` (a file system labelled with the
  ISO's volume id `WHOMBAT-INSTALLER`, or mounted at `/iso`, anywhere on it); `in-use` (anything on it mounted,
  including swap, a device-mapper/LVM/RAID/crypt device on top of it, or read-only); `too-small` (< 128 GiB, exactly
  128 GiB passes). Models are cleaned like names (NX-78).
- **Install:** `POST /api/install {disk, confirm}`: 409 while an install runs or is done or while the checks run;
  400 `check-failed` (any check `fail`, or no checks yet), `not-eligible` (not in the list, not eligible, or no longer
  eligible when the disk is looked up again right before), `confirm` (not exactly the disk's name). Accepted again
  after `failed` (CG-20). It runs `whombat-install --disk <path> --yes-erase-disk` with stdout and stderr as one
  stream: `@@progress` lines move the bar (NX-81), every other line goes to the log (the last 200, cleaned, at most
  300 characters) and to the journal (`journalctl -u whombat-installer-ui` has the whole output). On failure `error`
  is the installer's last line that isn't a `== step` heading, else the exit status. `POST /api/restart` (202 only
  when done) runs `systemctl reboot` half a second later. `POST /api/preflight` is refused (409) while installing and
  once done.
- **Shell:** the ISO's autologin getty leaves tty1 (`getty.target` wants none; the kiosk conflicts with
  `getty@tty1`); tty2 and up keep the autologin shell and `sudo whombat-install …` works from it as before. If the
  kiosk fails for good, `getty@tty1` (the shell) takes tty1 (`OnFailure=`).

## NX-80 `/etc/whombat/image.json`: what the installer installs (2026-09-27; CG-13, CG-14)
`nix/modules/image-info.nix` writes `{"v":1, platform, storage, environment, release, appUrl, hosts:{api, updates,
relay}}` into every appliance system: platform and storage as in `/etc/whombat/platform` (NX-50), `environment` as
configured (the installer shows `local`/`dev` as `dev`), `release` = `selfFactoryRelease` (null without), `appUrl` =
`whombat.runtime.appUrl`, `api`/`updates` = the hosts of `whombat.manager.controlUrl` and the TUF metadata URL, and
`relay` = the new option `whombat.relayHost` (control hands out the relay at runtime, so the image didn't name it):
`relay.whombat.com` in `prod-instance.nix`, `relay-dev.whombat.com` in `dev-instance.nix`, null (the check warns)
otherwise. The installer refuses a file it can't validate (it couldn't say what it installs); a host that isn't a
plain name is dropped. **Memory:** MemTotal is what the kernel keeps after its own reservations (an 8 GiB VM reports
about 7.75 GiB), so the check rounds it to the nearest GiB before comparing with CG-13's 8 GiB (warn) and 4 GiB
(fail); a 4 GiB VM warns, 3 GiB fails.

## NX-81 `whombat-install` reports progress and fails cleanly (2026-09-27; CG-12)
Besides its unchanged log it prints `@@progress <step> <percent>` (0 and 100 around `partition`, `filesystems`,
`copy`, `boot`, `finish`). `copy` is measured while `nixos-install` runs: every 2 s, `du --apparent-size` of
`<target>/nix/store` against the system closure's `total-nar-size` (`pkgs.closureInfo`, known at build time), capped at
99 until `nixos-install` returns (apparent sizes track NAR sizes; directories make it slightly larger, hence the cap).
`boot` covers the factory generation's blessing and the recovery UKI copy, `finish` sync and unmount. The installer
server maps the steps onto the bar as partition 0–3 %, filesystems 3–6 %, copy 6–90 %, boot 90–98 %, finish 98–100 %
and never moves it backwards. Two fixes came with it: `umask 0022` (whombat-installer-ui's first run failed with
“path /mnt should have permissions 755”, its unit's `UMask=0077` having reached `mkdir -p /mnt/whombat-target`), and
a failure after the disk was touched unmounts the target and closes LUKS on the way out, so “Try again” finds the disk
not in use; a refusal before (wrong platform, disk in use) touches nothing, not even another install's mounts.

## NX-82 The kiosk: cage and Chromium in a seat, and what Chromium needed relaxed (2026-09-27; CG-01, CG-03, CG-04, CG-05)
`nix/modules/kiosk.nix` (`whombat.kiosk.*`), used by `console.nix` (appliance: joins the server's namespace, fallback
the text console) and `installer-base.nix` (host namespace, fallback `getty@tty1`).
- **Seat.** User `whombat-kiosk` (uid/gid 960 on the appliance, NX-08; no other groups). The unit has `TTYPath=/dev/tty1`
  and `PAMName=whombat-kiosk`: `pam_systemd` (class `user-light`, so no `systemd --user` for it) registers a logind
  session on seat0/VT 1, and cage opens the DRM and input devices through logind (libseat `TakeDevice`), as nixpkgs'
  `services.cage` does. **Consequence:** pam_systemd moves the processes into the session's scope, so cgroup-bound
  unit settings (device and IP filters, accounting, `journalctl -u`) don't follow; the kiosk's own lines are in the
  journal under `-t whombat-kiosk`, its CPU in `user-960.slice`. Everything below is per process and does follow.
- **Compositor:** cage 0.3 (wlroots 0.20) with `WLR_RENDERER=pixman`, `WLR_NO_HARDWARE_CURSORS=1`, `-d -s` (no
  client decorations; VT switching allowed, so tty2 is reachable on the installer). XWayland fails to start (no
  X socket directory) and isn't needed.
- **Chromium 153** (`--ozone-platform=wayland --disable-gpu`, software compositing): the page opens as an **app window**
  (`--app=`, with `--kiosk`), not incognito: Chromium doesn't put an incognito window into kiosk mode (tabs and the
  address bar stayed), so the profile is new at every start instead (`--user-data-dir` under the unit's
  `RuntimeDirectory` on tmpfs, removed before every launch), which keeps nothing either (CG-28). Policies in
  `/etc/chromium/policies/managed/whombat-kiosk.json` (Chromium reads them as machine policies; seen in
  `chrome://policy` during development): `URLBlocklist` `*` plus Chromium's own schemes (`chrome://*`,
  `chrome-untrusted://*`, `chrome-extension://*`, `chrome-search://*`, `devtools://*`, `view-source:*`, `file://*`,
  `javascript://*`: `*` alone left `chrome://newtab` and `chrome://policy` open), `URLAllowlist` the origin only;
  DevTools, downloads, file dialogs, printing, password manager, autofill, extensions, translate, sync, sign-in,
  guest/new profiles, incognito, notifications, geolocation, clipboard, serial/USB/HID/Bluetooth/file-system access,
  capture, autoplay, safe browsing, component updates, metrics, search suggestions, network prediction off. **Keys:**
  a page can't stop Chromium's own shortcuts: Ctrl+N or Ctrl+T open a window that shows only “This page is blocked”
  (Ctrl+W closes it); a window closed with Ctrl+W or Alt+F4 exits 0 and the launcher opens the page again at once
  (inside cage, not a unit restart). **Ctrl+Alt+Del no longer reboots** from the console: cage holds the keyboard in
  raw mode, so the kernel never turns the combination into `ctrl-alt-del.target` (the text console's VT did). Found by
  `install-proxmox-vm`, whose reboots were Ctrl+Alt+Del; they are `systemctl reboot` now. On Proxmox, Reboot/Shutdown
  go through the guest agent or ACPI, which still work; on the text fallback Ctrl+Alt+Del works as before. Ctrl+Alt+F2
  still switches VTs (`cage -s`).
- **Reduced motion** (`--force-prefers-reduced-motion`): the avatars' idle motion rendered in software took ~97 % of one
  core on the claim screen (KVM VM, 2 vCPUs, 1280×800); with reduced motion the avatars stand still (they honour it)
  and the kiosk uses ~3 % there and on the claimed screen (`console-self` measures it). CG-16's idle motion is
  therefore off in the kiosk (CG-28).
- **Hardening kept:** `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateNetwork` (the
  appliance), `ProtectKernelTunables/Modules/Logs`, `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`,
  `ProtectProc=invisible`, `LockPersonality`, `RestrictRealtime`, `RestrictSUIDSGID`, `RemoveIPC`, empty capability
  sets, native syscalls only, no core dumps, `UMask=0077`. **Relaxed, and why:** `MemoryDenyWriteExecute=false` (V8
  compiles JavaScript to writable+executable memory); `RestrictNamespaces=user pid net` (Chromium's own sandbox);
  `SystemCallFilter=@system-service @sandbox chroot` with `SystemCallErrorNumber=EPERM` (the sandbox installs
  seccomp filters and chroots into an empty directory; Chromium copes with EPERM where SIGSYS would kill it); no
  `PrivateDevices=` (libseat stats the `/dev` nodes for their numbers before logind opens them);
  `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK` (D-Bus to logind, the page, udev enumeration).
  **Chromium's own sandbox holds:** the kernel allows unprivileged user namespaces (sandbox.nix, and the ISO's
  defaults), so its renderers run in their own user and pid namespaces under seccomp mode 2 (`console-self`).
- **Fallback** (CG-05): the launcher waits up to 15 s for a DRM device of a real driver (a firmware framebuffer —
  simpledrm, efidrm, vesadrm — only if nothing else appears) and exits 3 without one (`RestartPreventExitStatus=3`:
  no retry). Otherwise `Restart=always`, `RestartMode=direct` (systemd 260 runs `OnFailure=` at every failure
  otherwise, which started the text console at the first crash) and `StartLimitBurst=3` in 300 s: the restart after the
  third failure in a row is refused, the unit fails for good and `OnFailure=` starts the fallback (`console-self`: the
  first two crashes don't). Every restart from outside (the server's new token, a late keyboard) resets the count
  first (`reset-failed`); the kiosk only `Wants=` the server, so the server's own restarts don't restart it behind that
  back (with `Requires=` they did, and the count depended on the path).
  The text console `Conflicts=` the kiosk, is no longer wanted by `multi-user.target` with the GUI, and is unchanged.
- **Late keyboards:** in the server's network namespace the kiosk receives no udev events (udevd's netlink messages
  stay in the host's namespace), so cage never saw a keyboard plugged in after it started (checked: its input
  descriptors stayed at 6 after `device_add usb-kbd`). A udev rule (`ID_INPUT_KEYBOARD` added) starts
  `whombat-kiosk-replug`, which restarts a running kiosk (not counted against its start limit); the new cage opens the
  keyboard (7 descriptors). The installer's kiosk is in the host's namespace and doesn't need it. *Since NX-400 no
  restart: whombat-kiosk-udev passes udevd's input events into the kiosk's namespace, and the replug unit is gone.*

## NX-83 Displays (2026-09-27; CG-01, CG-05)
The VM GPUs are in the initrd (`bochs`, `virtio_gpu`, `qxl` in `availableKernelModules`, appliance with the GUI and the
ISO), so the firmware framebuffer is handed over before the kiosk starts; real GPUs (i915, amdgpu, nouveau, ast,
mgag200, …) load from the system's modules as udev finds them, with `hardware.enableRedistributableFirmware`. **Seen
working in VMs** (KVM, OVMF and SeaBIOS): Proxmox's *Default* display (std VGA → bochs, 1280×800 preferred, the
qualified setting), *VirtIO-GPU* (`virtio-gpu-pci`, 1280×800). **Not seen:** *SPICE* (QXL: the test QEMU has no
SPICE), real GPUs, a monitor plugged in after boot. No display at all (`-vga none`, a headless box, a serial-only
host): the text console within 15 s (`console-self`'s headless node).

## NX-84 VM tests of the graphical installer and console (2026-09-27; CG-17)
- **`console-self`** (three VMs): `machine` runs the GUI (std VGA): kiosk and server units, the logind session, the
  namespace and token checks of NX-78, Chromium's sandbox, self-provisioning, the recovery key screen read with OCR
  (`enableOCR`, tesseract) and its last group typed into the page (a wrong one first), the claim/backoff/claimed
  screens with the burrow's name and a crafted file read with OCR, every state compared between the API and
  `--once --json`, the kiosk's CPU on the claim and claimed screens, a restarted server (new token, kiosk restarted), a
  late keyboard, three crashes → the text console; `headless` (`-vga none`): the kiosk gives up after 15 s and the
  text console shows its screens and the banner as before, tty2 keeps the getty banner.
- **`install-proxmox-vm`**: the installer VM boots through OVMF (the `uefi` check) with the qualified 128 GiB target
  disk (sparse) and runs the kiosk; the test drives the Installer API with curl and the token: the Welcome screen
  (OCR), the checks and disks (target eligible, the installer's disk `in-use`, the transfer disk `too-small`), refusals
  (a wrong or upper-case confirmation, ineligible disks, restart before done, a second install, checks during the
  install), progress that never moves backwards and passes through the copy, Done (OCR), and `POST /api/restart`
  reboots it. The target's console is the GUI: the key screen (OCR, the API agrees with `--once --json`, zbar decodes
  the page's QR code from a screenshot), the same key after a reboot, a wrong group typed into the page, the right one
  in upper case, the claim screen with the code, again after a reboot, and the new key after the factory reset.
- The service-level suites (`appliance-basic`, `manager-units`, `sandbox-backup`, `vault-wall`, `runtime-*`) set
  `whombat.console.gui = false` through `vm-tests/common/appliance-vm.nix` (mkDefault): nothing in them reads tty1, and
  Chromium would take a fifth of their 2 GiB VMs. NX-26's table is updated.
- `install-boot-luks` keeps the GUI on its hardware target, which now has 3 GiB (in 2 GiB the candidate's
  `nix-store --import` was OOM-killed next to Chromium; the hardware has 8 GiB), and both install suites reboot with
  `systemctl reboot` instead of the driver's Ctrl+Alt+Del (NX-82).
- **Runs** (2026-09-27, branch `cg-os`, drivers with KVM as the user): `console-self` 13/13, `install-proxmox-vm` 14/14
  (progress seen: copy 6 → 9 → 13 → 33 → 65 → 84 %, boot 90, finish 98 → 100; zbar decodes the GUI's QR code),
  `install-boot-luks` 8/8, `appliance-basic` 13/13, `recovery-tpm` 11/11; the other suites' drivers build
  (`manager-units`, `sandbox-backup`, `vault-wall`, `runtime-real`, `runtime-live-turn`, the four `*-real-runtime`),
  not run. Checks: `console`, `proxmox-config`, `runtime-pin`, `clients`, `licence`, `runner-sandbox`, `recovery-menu`,
  `vault-wall-config`, `provision-unit`, `appliance-toplevel`, `eval-aarch64`, `image-no-secrets`. `go vet ./...` and
  `go test -race ./...`: all packages pass (`manager/internal/daemon` `TestRuntimeRestartBetweenProbes` failed once
  under the load of four VM suites and passed on three reruns; the manager is untouched here).

## NX-85 The ISO's size (2026-09-27; CG-01)
`nix build .#installer-iso-proxmox` (the dev Proxmox ISO): **2,318,368,768 bytes before** (appliance main `7692fed`,
the text console) and **2,707,292,160 bytes after** (`cg-os`: the GUI in the installed system and on the ISO), +389 MB
(+16.8 %). Chromium 153 (1.88 GB of closure uncompressed) and cage's wlroots/mesa are in the ISO once, shared by the
installer's kiosk and the installed system; the squashfs compresses them to about a fifth. The installed system's
closure grows by the same packages (CG-01 accepted ~1.9 GB).

## NX-86 The pin moves to Whombat main 843d1ba; NX-77's patches go (2026-09-27; NX-42, NX-43, NX-77; IN-85)
Whombat main `843d1ba` (candidate 0.16.1's runtime: `009fb2a`, the delegation merge, plus whombat-app 0.9.1 in
`vendor/whombat-app`) contains `50bbf70`, the merge of `console-burrows` (MR-78, MR-79: the runtime writes the burrows
into the console file, which the graphical console's claimed screen reads, CG-08), and `6a3df33`, the merge of
`pi-sandbox` (SUB-54, MR-77). `flake.nix` pins `843d1ba` (`lastModified` 1790543565), `nix/packages/runtime` names
candidate `0.17.0` (IN-85), and both NX-77 patch files are gone: each reverse-applies cleanly to `50bbf70`
(`git apply --check -R`) and no longer applies forwards. The `patches` machinery stays with an empty list (a later pin
that needs a fix adds one back), so the version is `0.1.0-843d1ba` without a `.p` tag, `bundle.json` says
`"patched": false` and the release manifest's `gitDirty` is false. Contracts 0.18.0 changed `package.json`,
`pnpm-lock.yaml` and `pnpm-workspace.yaml` against `a2abeeb`, so the pnpm dependency hash is new (`sha256-qei5HEKO…`,
from Nix's mismatch report; `843d1ba` changes no dependency manifest against `009fb2a`). The install check still requires
`app/shim.mjs` (MR-77), and `runtime-live-turn` passes without the patches. The branch pinned `50bbf70` first (hash
`sha256-A1oraIP6…`, VM 9/9, V-67), then `009fb2a` (V-68), each time moving on when a newer candidate reached appliance
main and the dev instance, so the image never ships a runtime older than dev's.

## NX-87 A kiosk stop kills Chromium first (2026-09-27; NX-82, CG-05; found by `console-self`, V-68)
`console-self` failed once in five runs of an unchanged driver: after the console server was killed, its restart
restarted the kiosk, cage got SIGTERM and broke Chromium's Wayland connection (“Fatal Wayland communication error:
Broken pipe”), and Chromium never exited. cage waits for its child, so the stop hung for systemd's default 90 s; the
timeout then fails the unit, and `OnFailure=` hands tty1 to the text console until the next boot. A box would show a
dark screen for 90 s and then the text console after any server restart that hits it. Now the kiosk's `ExecStop=`
SIGKILLs every process of `whombat-kiosk` whose command line names `chromium` (not cage, not the browser loop, which
exits with Chromium's status), so cage ends at once, and `TimeoutStopSec=5` is the backstop. Nothing is lost: the
profile is new at every start. A subtest reproduces it deterministically (every Chromium process SIGSTOPped, then a
restart): without the change the kiosk isn't back after 30 s (the timeout path, then the text console); with it cage
is new within seconds and no stopped process is left.

## NX-88 The kiosk has fontconfig, and survives a switch to another VT (2026-09-28; CG-01, CG-05, CG-11; John's first install of `pve-20260928.1`)
John's first install from the production ISO (`pve-20260928.1`, an Incus VM) showed the welcome title, the logo,
Clover and the Start button, but empty boxes where the text belongs, and Start seemed to do nothing. The installer
system imports NixOS's minimal installation profile, which sets `fonts.fontconfig.enable = false`: Chromium then has no
font configuration at all (“Fontconfig error: Cannot load default config file”), and in the kiosk it drew no text in
the page's regular and medium weights (the page's own Bricolage Grotesque and DM Mono web fonts included; the bold
title and button came out). The next screen was just as empty, so Start looked dead. The appliance was not affected
(its profile keeps fontconfig), which is why `console-self` passed; `install-proxmox-vm` read only the title with OCR.
Reproduced in a local QEMU (VirtIO GPU and standard VGA alike) and fixed there by hand with a `fonts.conf`: all text,
and Start opens the checks. The kiosk module now forces `fonts.fontconfig.enable = true` next to its DejaVu fallback.

The same session found a second defect: Ctrl+Alt+F2 (the installer's shell) takes the display from cage, Chromium
crashes (SIGTRAP after the failed atomic commit), cage exits, and every restart while tty2 is active waits 10 s for its
logind session, fails, and three of those give tty1 to the fallback for good. Now the browser loop treats a Chromium
exit while tty1 is not the active VT as a pause (it waits for tty1 and starts Chromium again inside the same cage), and
the launcher waits for tty1 to be active before it starts cage. `install-proxmox-vm` now reads the welcome text,
presses Start through the page and switches to tty2 and back.

## NX-89 The recovery menu waits for the appliance's disk (2026-09-28; NX-10, NX-25, PI-04; found by `install-proxmox-vm`)
`install-proxmox-vm` failed three times in a row in “recovery menu: a wrong key touches nothing, the right one
resets”: the right disk recovery key was refused (“no volume was touched”). The recovery system's SCSI scan took 18 s
in those runs (under 1 s in the earlier green ones), so `whombat-recovery-menu` started before
`/dev/disk/by-partlabel/whombat-persist` existed. The menu decides the storage mode once at start (LUKS or
host-encrypted); with no volume it assumed LUKS, and every key then failed `cryptsetup open --test-passphrase` on a
plain btrfs partition. A slow disk on a real host would do the same and make the recovery key look wrong. The menu now
waits up to a minute for the data volume before it decides (and says “Looking for this appliance's disk…”); a box
whose disk really is gone still reaches the menu and refuses keys as before. The `recovery-tpm` probe (test only) had
the same race, and its “refused” could have meant “no disk”: it now waits for the three partitions too.

## NX-90 No disk recovery key on self-installed appliances (2026-09-28; PI-19, CG-31; supersedes NX-53, NX-54, NX-74's font)
- **Provisioning:** `whombat-provision self` creates no key, no Argon2id hash, no `/persist/console/recovery-key.json`
  and no keyslot; the library refuses LUKS volumes for a self-installed box (on any platform), `self-provision.json`
  has no `luksDevices`, and the tool has no console group any more. `verify` no longer requires the hash for model
  `self-installed`, but checks one that exists (an earlier image's; the recovery menu relies on it). Factory
  provisioning (card, keyslots) is unchanged.
- **An earlier image's key:** a confirmed key (hash, no pending file) stays and keeps gating the recovery menu and
  erase. A key still pending for the console (never confirmed) is removed at boot with its hash by
  `whombat-recovery-key-drop` (`whombat-provision recovery-key drop-pending`: the plaintext zeroed and unlinked, the
  hash removed, `/persist/console` removed when empty; `ConditionPathExists` the pending file, so it runs once). This
  image can't show it, so nobody could ever confirm it. `recovery-key confirm`, its path unit and service,
  `/run/whombat-console` and the `/persist/console` tmpfiles rule are gone.
- **Console:** the text console and `whombat-console --serve` read only the runtime's state file (CG-31); the text
  console keeps `StandardInput=tty-force` and raw mode to read and drop key presses, so nothing typed shows on tty1,
  and has no `ReadWritePaths`. The server writes only its token. `internal/recoverykey` keeps the key format and the
  hash (Hash, ParseHash, Verify) for `recovery-key check`; the hand-over code, the key screen's state machine and
  input decoder, and the QR code are removed.
- **Font:** with no QR code, the patched `whombat-v32b` (NX-74) goes; `whombat.console.font` defaults to Terminus
  `ter-v32b`, which has every character the console draws (the patch only replaced two shade glyphs).
- **Banner:** the console footer and getty banner say “(you will need your disk recovery key)” only on `luks-tpm2`
  storage (`whombat.console.banner` default); the console's built-in default stays the `luks-tpm2` text
  (`checks.console` compares it with `appliance-x86_64`'s).
- Checked: Go unit tests, `checks.console`, `checks.proxmox-config` (no confirm units, the drop unit and its
  condition, no key in the banner, no `luksDevices` for self-registration on hardware either). VM tests updated, not
  run (NX-26 rows).

## NX-91 The recovery menu and erase without a key (2026-09-28; PI-19; amends NX-55, NX-56)
On host-encrypted storage the menu checks once, at start, whether `/persist` holds a key hash (mounted read-only; a
volume that doesn't mount counts as none). Without one, every action that asked for the key asks for a typed word
instead: `EXPORT` (1), `VERIFY` (2), `NETWORK` (6); factory reset (4) and secure erase (5) keep their `ERASE` /
`ERASE EVERYTHING` prompt as the only authority, and hand `ERASE` to the erase tool. The header says “This Whombat has
no disk recovery key: actions 1-6 ask you to type a word to confirm.” The kernel log line is `confirmed with <WORD>
(no disk recovery key on this appliance)`. `whombat-host-erase` on a provisioned box without a hash reads a line and
erases only on `ERASE` (it refused before, unless `--factory`). Rationale (John, 2026-09-28): the disk is plaintext in
this machine, so whoever is at its console or holds its disk can read the data anyway; a typed word guards against
slips, not against an attacker. With a hash (an earlier image) and on LUKS boxes nothing changes. Re-seal (3) on
host-encrypted storage says there is nothing sealed (no VM wording). Checked by evaluation only; `install-proxmox-vm`
covers both paths (not run).

## NX-92 Dedicated x86_64 machines with the self-install ISO (2026-09-28; PI-18, CG-34)
The prod ISO (`installer-prod-proxmox`, platform `proxmox-vm`, storage `host-encrypted`) also installs a dedicated
x86_64 UEFI machine. The platform id stays; what changed for hardware:
- **initrd:** `vmd` (NVMe behind Intel VMD/RST, on by default on many recent desktops and NUCs: the installer would
  see the disk, udev loads `vmd` later, but the installed initrd would not find its root and loop), `sdhci_pci`,
  `sdhci_acpi`, `mmc_block` (eMMC), next to `nvme`, `ahci`, `xhci_pci`, `usb_storage`, `uas`, `sd_mod` (appliance.nix,
  both platforms). NICs (r8169, e1000e, igb, igc) and GPUs (i915, amdgpu, nouveau) are in-tree modules loaded by udev
  after the switch to the system; `hardware.enableRedistributableFirmware` is on in the appliance and the installer
  (rtl_nic, i915/amdgpu firmware). Nothing blacklists them; `nomodeset` is not set.
- **Display:** the kiosk needs only DRM dumb buffers (cage with pixman, Chromium `--disable-gpu`, NX-82): it waits up
  to 15 s for a real driver, then takes the firmware framebuffer (simpledrm), and without any DRM device the text
  console takes tty1 (CG-05). No GL, no mesa drivers needed.
- **Disks** (CG-34): USB drives are not eligible (`lsblk` `TRAN`), minimum 110 GiB. `whombat-install` refuses while
  another disk already has `whombat-esp/-root/-persist` partitions: the partitions are found by partlabel, in the
  installer and at every boot, so a second Whombat disk would make them ambiguous (mkfs could hit the wrong one). Its
  first log line no longer names the platform (`== installing Whombat on <disk>`), and `whombat-storage-init` says
  `(no LUKS)`, not “inside the VM”.
- **VM devices on hardware** (checked by evaluation): `qemu-guest-agent` has no `wantedBy`; only nixpkgs' udev rule for
  the `org.qemu.guest_agent.0` virtio port starts it, so on hardware it never starts and never fails. `i6300esb` is a
  PCI driver: loading it without the device succeeds, so `systemd-modules-load` doesn't fail. The boot assessment
  (`whombat-boot-assessment`, NX-04/NX-05) looks at PostgreSQL, the manager, the runtime's health and restarts only,
  not at failed units, the guest agent or a watchdog. `RuntimeWatchdogSec` without a watchdog device only logs.
- **Network:** networkd DHCP on `en*`/`eth*` (any wired NIC, including USB ones); no Wi-Fi on the appliance
  (*superseded by NX-240, 2026-10-20: Wi-Fi with iwd, a cable still wins*).
- **Verified:** `nix build` of both prod toplevels (`appliance-prod-proxmox`, `installer-prod-proxmox`), evaluation of
  the initrd modules and firmware, Go unit tests of the disk list with an NVMe/SATA/USB/eMMC machine.
  **Not tested on real hardware** (no machine): the install and first boot on NVMe (with and without VMD), SATA and
  eMMC; the kiosk on i915/amdgpu/nouveau/simpledrm; r8169 and Intel NICs; firmware that keeps Secure Boot on (the ISO
  and the appliance are signed with keys the firmware doesn't know: Secure Boot must be off) or boots only the fallback
  path. Known gaps: on Intel machines there is **no hardware watchdog** (`iTCO_wdt` stays blacklisted on this platform
  because q35's ICH9 TCO would take `/dev/watchdog0` from the i6300esb; AMD's `sp5100_tco` may autoload); Wi-Fi-only
  machines get no network (until NX-240); the recovery UKI carries no firmware (its menu is text; option 6 on a NIC that needs
  firmware may fail).

## NX-93 The image's runtime moves to Whombat 2be6fc1 (2026-09-28; NX-86, NX-42; candidate 0.17.2)
John couldn't sign in to Claude or Codex on his production box (“This appliance has no place for provider sign-ins
yet.”): the server gated sign-ins on a credentials root of its own, which the image gives to the runner alone
(NX-20). Whombat SUB-56 lets a managed server offer them through the runner's sign-in bridge; SUB-55 keeps a refused
client install visible. The flake input `whombat` moves to `2be6fc1` (no lockfile change, same pnpm hash) and
`manifest/candidates/0.17.2.json` (0.17.1 plus that runtime and whombat-app 0.10.1) names it for `checks.runtime-pin`.
The candidate was not run through its gates and scenarios (John: no test suites now); each change's unit and server
tests passed (Whombat `pnpm check`, `pnpm test:server` 1043 tests).

## NX-94 The agents' browser host: its unit, uid and hardening (2026-09-28; Whombat BT-01, BT-09, BT-D01; IN-87)
`nix/modules/browser.nix` (`whombat.browser.*`, on by default; `enable = false` leaves out the user, the unit, the slice,
the egress rules and the server's environment, and the runtime reports the browser off by itself).
- **User** `whombat-browser`, uid/gid **961** (NX-08; the egress table names it), no other groups. The server's user
  `whombat` joins group `whombat-browser` (and the server unit's `SupplementaryGroups`); the runner doesn't.
- **Program:** `ExecStart=/nix/var/nix/profiles/whombat-runtime/bin/whombat-browser-host`, the runtime *profile* (NX-20):
  every runtime update brings its host, and `PartOf=`/`WantedBy=whombat-runtime.target` makes the helper's restart of the
  target restart it. Conditions: provisioned (`device.json`, as server and runner) and the entry exists in the profile, so
  a runtime from before the browser leaves the unit *skipped*, not failed. `Requires=`/`After=nftables.service`: its uid's
  wall (NX-97) is loaded before any page. `Type=exec` (the host doesn't speak sd_notify; the server connects when the
  socket answers).
- **Environment:** `WHOMBAT_BROWSER_SOCKET=/run/whombat-browser/host.sock`, `WHOMBAT_BROWSER_BIN=<chromium>/bin/chromium`
  (`whombat.browser.chromiumPackage`, default the kiosk's `whombat.kiosk.chromiumPackage` = `pkgs.chromium` 153.0.8010.52:
  one Chromium in the closure; the nixpkgs wrapper is a bash script that `exec`s Chromium, so Playwright's pipe fds pass
  through), `WHOMBAT_BROWSER_MAX_CONTEXTS=2` (`maxContexts`), `WHOMBAT_BROWSER_SANDBOX=on` (IN-87), `NODE_ENV=production`,
  `LANG=C.UTF-8`, `HOME=/var/lib/whombat-browser` (`StateDirectory`, 0700, emptied by the gate at every start) and
  `XDG_CACHE_HOME=/var/cache/whombat-browser` (`CacheDirectory`, 0700: fontconfig's cache). Playwright's throwaway profiles
  go to the private `/tmp`, which goes with the unit.
- **Directory:** `RuntimeDirectory=whombat-browser`, 0750 `whombat-browser:whombat-browser`, `RuntimeDirectoryPreserve=yes`:
  the gate's `status.json` must outlive a skipped start and a stop (NX-95). `UMask=0077`; the host makes the socket 0660.
- **Restart:** `Restart=always` with backoff (`RestartSec=1s`, `RestartSteps=6`, `RestartMaxDelaySec=60s`) and
  `StartLimitIntervalSec=0`: it never gives up, and never spins. `KillMode=control-group` (Chromium goes with the host),
  `TimeoutStopSec=15s`, `OOMPolicy=continue` (a renderer the kernel kills at the slice's cap doesn't stop the host; the
  default `stop` would), `OOMScoreAdjust=500` (as the runner: a box short of memory loses the browser before the server).
- **Hardening** (as the runtime's units): `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
  `PrivateDevices` (headless Chromium needs no device; systemd binds the host's `/dev/shm` into the private `/dev`),
  `ProtectKernelTunables/Modules/Logs`, `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`
  (not `ProcSubset=pid`: Chromium reads `/proc/meminfo`, `/proc/stat` and `/proc/sys`), `LockPersonality`,
  `RestrictRealtime`, `RestrictSUIDSGID`, `RemoveIPC`, empty capability sets, native syscalls, no core dumps,
  `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`. `InaccessiblePaths`: `/persist` (the runtime's home,
  workspaces, credentials, identity, secrets), `/run/postgresql`, `/run/whombat` (admin and sign-in sockets, console),
  `/run/whombat-{manager,backup,update-helper,vault,clients,console}`.
- **Chromium's own sandbox stays on** (the question the assignment left open). The unit relaxes what it needs exactly as
  the kiosk does (NX-82): `MemoryDenyWriteExecute=false` (V8, and Node's JIT), `RestrictNamespaces=user pid net`,
  `SystemCallFilter=@system-service @sandbox chroot`, `SystemCallErrorNumber=EPERM`; the kernel already allows
  unprivileged user namespaces for bubblewrap (sandbox.nix). Rejected: `--no-sandbox`. A renderer is where a hostile page
  runs; without the sandbox a renderer exploit runs as the host's uid next to the host's socket, its proxy's per-context
  credentials and, during one `signIn` op, a Vault password (BT-06), and it reaches whatever the uid's wall allows. The
  user-namespace attack surface this keeps is already open on the appliance. Seen in the VM (`browser`): renderers under
  seccomp mode 2 in their own pid and user namespaces, in the unit's cgroup. Playwright adds `--no-sandbox` unless the host
  launches with `chromiumSandbox: true` (IN-87).
- **The kiosk's machine policies are hidden.** The kiosk writes `/etc/chromium/policies/managed/whombat-kiosk.json`
  (URLBlocklist `*` but the console's origin, NX-82), and every Chromium on the box reads that directory, the browser
  host's too: every page would be blocked on an appliance with the graphical console. The unit mounts a tmpfs over
  `/etc/chromium` (`TemporaryFileSystem=`) and binds its own `whombat-browser.json` into `policies/managed`: `file://`,
  `view-source:` and `javascript:` blocked; QUIC, DNS-over-HTTPS and the built-in DNS client off; WebRTC
  `disable_non_proxied_udp`; no network prediction, password manager, autofill, extensions, sync, sign-in, metrics, Safe
  Browsing, component updates, background mode, translation, spellcheck or search suggestions; geolocation,
  notifications, serial/USB/HID/Bluetooth, file-system access and capture blocked. Nothing the host drives through CDP
  (downloads into memory, printing to PDF, the DevTools protocol over the pipe) is restricted; the host's flags do the rest
  (BT-05). Seen in the VM with a kiosk-like `URLBlocklist *` file in place: pages load in the unit.
- **Fonts:** DejaVu (already there with the kiosk) and Liberation (metric-compatible Arial, Times New Roman, Courier;
  +4.2 MiB), so a page without web fonts renders text in screenshots (BT-D04).
- Checked by evaluation: `checks.browser-config`.

## NX-95 The memory gate and the status file (2026-09-28; BT-09; IN-87)
`whombat.browser.minMemoryGiB` (8) and `whombat.browser.force` (false). The unit's `ExecCondition=whombat-browser-gate
<min> auto|force` runs as the unit's user before every start (with the unit's runtime and state directories set up):
- It reads `MemTotal` from `/proc/meminfo`. **Below `min` GiB with a tenth of margin** (`MemTotal < min × 0.9 GiB`, i.e.
  7.2 GiB for 8) and not forced, it writes `{"state":"off","reason":"This Whombat has less than 8 GB of memory."}` and
  exits 1: the unit is skipped (inactive, result `exec-condition`), not failed, and `Restart=always` doesn't retry a
  skipped condition. Otherwise it writes `{"state":"available","reason":null}`, empties HOME and exits 0. Forced below the
  minimum, it logs “browser forced on”. Either way it first removes a `host.sock` a previous host left behind.
- **Why the margin:** firmware, the kernel and integrated graphics keep part of the RAM; a machine or VM with 8 GiB reports
  about 7.3–7.8 GiB as MemTotal. Without the margin the browser would be off on exactly the boxes BT-09 turns it on for.
  A Proxmox VM with ballooning reports what it has when the host starts.
- **The file:** exactly `{state, reason}` (no version or other fields, BT-09), written temp + rename, 0640
  `whombat-browser:whombat-browser` in the preserved runtime directory (0750): the server's user reads it through its
  group, the runner and others don't. What the runtime makes of it: IN-87.
- Evaluated at every start, not at build time: the same image runs on 4 GB and 16 GB boxes. `force` is for small test VMs
  and for an owner who accepts the risk (no UI for it; an image setting).
- Checked: `checks.browser-config` runs the gate against the build machine's memory (on at 1 GiB, off with the reason at
  100000 GiB, forced on, the stale socket removed, HOME emptied, the file's mode); the VM test runs it through the unit.

## NX-96 The browser's cgroup slice (2026-09-28; BT-09; amends NX-19)
`whombat-browser.slice` (under `whombat.slice`, next to the critical and tasks slices; knobs `whombat.slices.browser.*`):
`MemoryMax=1536M`, `MemorySwapMax=0`, `TasksMax=512`, `CPUWeight=25`, `IOWeight=25` (critical 1000, tasks 50: under
contention a page load gets the smallest share, idle it takes what it needs). No `MemoryHigh` (throttling a browser near
its cap turns into the host's 30 s deadlines) and no oomd: at the cap the kernel's OOM killer acts inside the slice, and
picks a renderer first (Chromium raises its renderers' `oom_score_adj` itself); the unit's `OOMPolicy=continue` keeps the
host. Only the unit runs in the slice. Seen in the VM: a 2 GiB allocation in the slice is killed at 1536 MiB
(`oom-kill`), the host keeps answering. **VM-test note:** NixOS's test instrumentation sets `vm.panic_on_oom = 2`, which
panics the whole VM at a *cgroup's* OOM too (the first run did); the appliance leaves it at 0, and the `browser` test sets
0 on its appliance node.

## NX-97 The egress wall for the browser uid (2026-09-28; BT-05; amends NX-22, NX-40)
In `inet whombat-egress` (network.nix), only with `whombat.browser.enable`:
- `output` sends every packet of uid 961 to chain `browser` first, before `oifname "lo" accept` and the port rules every
  other uid gets. `browser` then allows, in this order: on loopback, a connection it opened (conntrack mark `0x42524c4f`,
  “BRLO”), the resolver stub (127.0.0.53 and 127.0.0.54, port 53, UDP and TCP) and new TCP connections to 127.0.0.1 (which
  it marks); anything else on `lo` is rejected: `::1`, other 127/8 addresses, this box's own LAN and public addresses
  (they route through `lo`), and answers to connections other users opened. Then Vault connections still listed
  (`vault_established`, unchanged), established/related, **the Vault sets** (`@vault4`/`@vault6`, marked `0x5641554c`),
  then the not-public reject — IPv4 set `browser_denied4`: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24,
  192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/3 (multicast, reserved, broadcast) and
  168.63.129.16 (Azure's wire server, a public address); IPv6: everything outside global unicast `2000::/3` (unspecified,
  loopback, v4-mapped and -translated, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, discard, ULA `fc00::/7` with AWS's
  `fd00:ec2::254`, link-local, site-local, multicast, `5f00::/16`) and inside it `2001::/23`, `2001:db8::/32`, `2002::/16`
  (6to4), `3fff::/20` — then **TCP 80 and 443**, then reject. No UDP leaves the uid but to the stub: no QUIC, no DNS to any
  other server. Rejections are ICMP admin-prohibited, so a refused connect fails at once (EHOSTUNREACH, EACCES on IPv6).
- **Loopback only to itself** (chain `browser_lo_reply`, jumped to from `output` for `ct mark 0x42524c4f ct direction
  reply`): until conntrack marks the connection assured (the handshake completed), an answer passes only when a socket of
  uid 961 sends it. PostgreSQL's or the runtime server's SYN-ACK, and the kernel's reset for a closed port, are dropped:
  their connect times out, so a closed port looks like a filtered one and loopback can't be probed. The host's proxy may
  listen on any port; neither its port nor the unit's cgroup path is needed (the runner's wall needs its cgroup at load
  time, NX-21; this is static in the table). Other users can't reach the browser's listeners either (its answers to them
  hit the `lo` reject).
- **The Vault networks are the server's list** (IN-58…IN-62): the same two sets `whombat-vault-wall` fills from
  `WHOMBAT_VAULT_NETWORKS_FILE`, validated there exactly as for the server, so the daemon is unchanged: a change applies
  to both uids in one transaction, and a removal also resets the browser's open connections to that network. The host
  checks the same list (the server sends it with every `open`) with core's `browserDestinationProblem` before the kernel
  sees a packet (BT-05); the kernel holds when the host is wrong. Unlike the server's rules, which come after the port rule
  (a listed network on 443 isn't marked, IN-60), the browser's Vault rules come before it: every Vault connection of the
  browser is marked and ends when its network is removed.
- **DNS:** the host resolves through the system resolver (nss-resolve's varlink socket, AF_UNIX, or the stub); resolved
  asks upstream under its own uid. A name rebound to a private address fails at the proxy (every resolved address is
  checked) and at this wall.
- **Not covered:** public addresses that belong to the owner's own network (a LAN on public space, a provider's network)
  are public to the wall; the host's list is the only guard there, as for every other uid on 443 (IN-60).
- Checked: `checks.vault-wall-config` counts six `@vault` lines (two of them the browser's); `checks.browser-config`: only
  uid 961 jumps to `browser`, and nothing of it exists with the browser disabled. The build-time `nft --check` accepts the
  table. VM `browser`: see NX-99.

## NX-98 The sandbox toolchain's Python libraries (2026-09-28; Whombat SL-11)
`whombat.sandbox.toolchain`'s `python3` is now `python3.withPackages` with **python-docx 1.2.0, openpyxl 3.1.5,
python-pptx 1.0.2, pypdf 6.15.0 and Pillow 12.3.0** (Python 3.13.15 of the pinned nixpkgs), which bring lxml 6.0.2,
XlsxWriter 3.2.9, et-xmlfile 2.0.0, typing-extensions 4.15.0 and Pillow's libavif, libimagequant, libraqm and libyuv. Tasks
see it under the toolchain's store path as before (`WHOMBAT_SANDBOX_RO_PATHS`).
**Closure growth** (`nix path-info -S`, `appliance-x86_64` with the stand-in runtime, before = appliance `9b82d4f`):

| | before | after | growth |
|---|---|---|---|
| `whombat-sandbox-toolchain` | 688,057,672 B | 789,985,952 B | +101,928,280 B (+97.2 MiB) |
| appliance toplevel (the whole change, browser included) | 4,681,098,008 B | 4,732,879,936 B | +51,781,928 B (+49.4 MiB) |

The toolchain grows by more than the host because half of what the libraries pull in (freetype, libjpeg, libpng, libwebp,
zlib, …) is already in the host closure through Chromium and others. Of the host's +49.4 MiB (`nix store diff-closures`):
+45.2 MiB are the Python libraries and their native libraries (libimagequant 10.7, lxml 6.4, pypdf 5.4, Pillow 4.7,
libyuv 3.9, python-pptx 3.6, openpyxl 3.0, python-docx 3.0, XlsxWriter 2.4, libavif 1.1, the rest under 0.5 each), +4.2
MiB the Liberation fonts (NX-94), and the units, the gate, the policies and the stand-in's new role together under 0.1
MiB. A host (class 2) release ships it. Checks: `checks.toolchain` makes and reads back a .docx, .xlsx, .pptx, .pdf and
.png with the toolchain's `python3`; `sandbox-backup` imports the five inside bubblewrap as the runner user (6/6, 2026-09-28).

## NX-99 The host in the runtime bundles, and the VM test (2026-09-28; IN-87)
- **Real bundle** (`nix/packages/runtime`): when the pinned Whombat's `bundle:runtime` ships `app/browser-host.mjs`, the
  derivation adds `bin/whombat-browser-host` (`makeBinaryWrapper` → the bundle's `nodejs-slim_24` on
  `app/browser-host.mjs`; no git on its PATH). `playwright-core` is expected in the bundle's `node_modules` (like node-pty;
  the derivation copies `node_modules` whole). At the current pin (`843d1ba`) there is none, so a real-bundle image skips
  the unit. When the pin moves to a Whombat with the host (phase 2): the new pnpm hash, an install check that the entry
  gets past its imports, `browser-real-runtime`.
- **Stand-in** (`nix/packages/standins`, `standin-runtime` linked as `bin/whombat-browser-host` in the stand-in bundle):
  listens on `WHOMBAT_BROWSER_SOCKET`, removes a stale socket first, makes it 0660, and answers BT-D01's framing: `hello`
  → `{version, standIn: true, chromium: "<chromium --version>", limits: {maxContexts}}`, `stats`, `bad_request` for a
  line that isn't JSON, `unavailable` for every other op. A test-only `standin.dumpDom {url}` runs
  `$WHOMBAT_BROWSER_BIN --headless --dump-dom` (http/https only, a throwaway profile, the sandbox on) so the VM test sees
  Chromium start under the unit. Dev images and VM tests have a host that answers `hello`; prod refuses the stand-in
  bundle as before.
- **VM test `browser`** (NX-26; two VMs: the appliance with 3 GiB, the browser forced on, a kiosk-like `URLBlocklist *`
  policy file in `/etc/chromium`, and a control node with the fake control, the TUF fixtures and a web server on a
  “public” 1.2.3.4 / 2a00:1:2:3::1, its test-network 192.168.1.1, 169.254.169.254 and fd42::1). **Run 2026-09-28 with KVM as
  the user, 10/10 subtests** (script 102 s; driver `nix build .#checks.x86_64-linux.browser.driver`). Seen: the gate as the
  unit's user with its runtime and state directories set up (“browser forced on with MemTotal 3044544 KiB”); Chromium
  153's renderers under seccomp 2 in their own pid and user namespaces in `whombat.slice/whombat-browser.slice/
  whombat-browser.service`; a public page over IPv4 and IPv6 (Chromium first tries HTTPS on 443 for an `http:` IP URL,
  then falls back), none from the private, metadata, ULA or port-8123 addresses; refused connects fail at once
  (EHOSTUNREACH/EACCES), loopback ones to other users time out (`browser_lo_reply` dropped 15 answers: PostgreSQL's, the
  4620 listener's and a closed port's resets); the Vault grant opened and closed for uid 961 and the server's uid alike; a
  2 GiB allocation in the slice `oom-kill`ed with `constraint=CONSTRAINT_MEMCG, oom_memcg=/whombat.slice/
  whombat-browser.slice` while the host kept answering; `64 auto` → inactive, `{"state":"off","reason":"This Whombat has
  less than 64 GB of memory."}`, no socket, not restarted; `64 force` and `2 auto` → running. The first run stopped at the
  memory subtest: the test instrumentation's `vm.panic_on_oom = 2` panicked the VM at the slice's OOM (NX-96); every
  subtest before it had passed. **`sandbox-backup` 6/6** the same day, with NX-98's import check; its appliance (3 GiB,
  not forced) shows the default path on a real boot: skipped before provisioning (`ConditionPathExists=…/device.json`),
  then “browser off: MemTotal 3044544 KiB, the browser needs 8 GiB (7549747 KiB with the margin)”, `Skipped due to
  'exec-condition'`, and the rest of the suite unaffected. Not run: any suite with the real bundle (the pin has no host
  yet), the other service suites (they carry the unit the same way).

## NX-100 The real browser host in a VM test before the pin has it (2026-09-28; Whombat BT-D05…BT-D16; phase 2a)
- **Which Whombat:** first `capabilities-browser` `bbee559` (the host, playwright-core 1.63.0 in the bundle's
  `node_modules`, `app/browser-host.mjs`, contracts 0.20.0, migration `0048_capabilities`), then, once it was merged and
  its branch deleted, Whombat `capabilities` `9fd7cc4d` (the host, the tools behind `/mcp`, the Vault's login). Not on
  GitHub yet, so the flake input can't name it for everyone; the pin (`843d1ba`, candidate 0.17.0; since NX-93 `2be6fc1`, 0.17.2) doesn't move before
  the candidate that ships the browser (0.18.0, NX-42). The test runs on a command-line override instead:
  `nix build .#checks.x86_64-linux.browser-real-runtime.driver --override-input whombat
  'git+file:///home/me/Code/Whombat?ref=capabilities&rev=9fd7cc4db994ac14d48cdaa542f34013456e8c75'` (the objects are
  in the main checkout's repository; `flake.lock` isn't written).
- **pnpm hash by rev:** another rev's `pnpm-lock.yaml` gives another fixed-output hash, so `nix/packages/runtime` keeps
  `pnpmDepsHashes` (rev → hash, used when `src.rev` matches) next to the pinned rev's hash. `bbee559`'s is
  `sha256-lL+lAAZCtgDVBmltCseyPQetEH7CRxiws/3dcH3OIM4=`, and `9fd7cc4d`'s is the same (no lockfile change between them;
  the table names `9fd7cc4d` now). Not a pin: nothing ships it; the entry goes when the pin moves past it. The bundle built from it has `bin/whombat-browser-host` (NX-99's wrapper, no change needed) and passes the
  install checks.
- **Registration:** `vm-tests/default.nix` adds `browser-real-runtime` (= `runReal ./browser-real.nix`) only when the
  built source has `apps/server/src/browser/host/main.ts`, so the checks at the current pin all evaluate and build
  (`checks.x86_64-linux` lists `browser` and `browser-config` there) and the check appears with the override.
- **Shared network:** `vm-tests/common/browser-lan.nix` holds both browser suites' control node (fake control, TUF
  fixtures, a web server on 1.2.3.4 / 2a00:1:2:3::1 / 192.168.1.1 / 169.254.169.254 / fd42::1 with `/`, `/slow`,
  `/login`, `/hog`, UDP echo), the appliance's addresses and `public.test`, provisioning and the helpers.
- **Run 2026-09-28 with KVM as the user: `browser-real-runtime` 9/9** (script 75 s, 4 GiB VM). What the real host
  needed from the unit beyond NX-94: nothing — DNS through nss (`public.test` from `/etc/hosts`), the fonts, user
  namespaces for its sandbox (it launched with `WHOMBAT_BROWSER_SANDBOX=on`, no `--no-sandbox` on the command line) all
  worked as configured. The host's refusals read, e.g., “127.0.0.1 is this computer’s own address, which the browser
  doesn’t open.”, “169.254.169.254 is a cloud metadata address, which the browser doesn’t open.” and, for a home
  address the list lacks, “192.168.1.1 is on your network. Ask an admin to add 192.168.1.0/24 port 8123 to the home
  network list in Settings → Vault.” The memory case: `oom-kill:constraint=CONSTRAINT_MEMCG … oom_memcg=/whombat.slice/
  whombat-browser.slice … task=chromium` killed the renderer (anon-rss 1.3 GB, `oom_score_adj` 500 inherited from the
  unit), the op answered `navigation_failed` “The page crashed (it may have used too much memory), so Whombat closed the
  session.”, and NRestarts, the host's PID and Chromium's browser process were unchanged. The stand-in suite `browser`
  (moved onto the shared file) passed 10/10 again the same day. **Again on `capabilities` `9fd7cc4d`: 9/9** (script
  84 s), the same observations.
- **Protocol 2, candidate 0.18.0 (IN-92).** Whombat's host protocol moved to version 2 (session budgets, `pinSite`,
  `signedIn` and `usage` in the page state, longer titles and notes; BT-D44); the server refuses a host with another
  version, so the stand-in's `hello` answers 2 and both suites check it. `pnpmDepsHashes` gained the candidate's runtime
  `e8474971` (`sha256-Bpgu6gP1…`, the same store as `541bced4`: their lockfiles differ only in the vendored contracts
  tarballs' names). Runs 2026-09-28 with KVM: `browser-real-runtime` 9/9 on `b6701a5a` (a draft of the candidate),
  on `541bced4` and on `e8474971` (the candidate's runtime; Playwright 1.63.0, Chromium 153.0.8010.52, protocol 2);
  `browser` 10/10 on the branch before and after appliance main (candidate 0.17.2) was merged in.

## NX-101 The host's exit codes in the unit (2026-09-28; Whombat BT-D05, BT-D13, BT-D15; amends NX-94, NX-95)
The real host exits 0 (stopped), 1 (failed, or Chromium went away), 2 (bad settings), 3 (no Chromium), 4 (Chromium
didn't start, e.g. its sandbox). The unit now has `RestartPreventExitStatus=2 3` (a restart can't fix a setting or a
missing binary; BT-D15 asked for exit 3 not to loop), keeps `Restart=always` with backoff for 1 and 4, and an
`ExecStopPost=` (`whombat-browser-stopped`, as the unit's user) that writes `status.json`
`{"state":"unavailable","reason":…}` for 2 (“The browser’s settings are wrong on this Whombat. Its log says which.”),
3 (“The browser can’t find Chromium on this Whombat.”) and 4 (“Chromium didn’t start on this Whombat; trying
again.”); the runtime reads an `unavailable` file's reason when the socket doesn't answer (BT-D13), so Settings says
why. Any other stop leaves the file alone, and the gate writes `available` at the next start. Seen in
`browser-real-runtime`: `WHOMBAT_BROWSER_BIN` pointed at nothing → exit 3, `failed`, no restart in 5 s, the file's
reason, and the server's log `browser not available … can’t find Chromium on this Whombat`. `checks.browser-config`
asserts the two settings.
## NX-102 The image's runtime moves to Whombat e8474971; candidate 0.18.0 (2026-09-28; NX-42, NX-93, NX-100; IN-92)
Whombat main `18f39551` (pushed) contains `e8474971`, candidate 0.18.0's runtime (the browser, the skills library, six
roles and spend; migration `0048_capabilities`), so the flake input `whombat` moves from 0.17.2's `2be6fc1` to
`e8474971` (`nix flake lock --update-input whombat`) and `nix/packages/runtime` names candidate `0.18.0`
(`checks.runtime-pin` compares the rev with the candidate's `whombat-runtime` commit). The lockfile changed since
`2be6fc1`, so the pinned pnpm hash is new: `sha256-Bpgu6gP1XsHlikRAP7YFivhczBQ20LFPAtnYe0h/2IY=` (found with the
override runs, NX-100). `pnpmDepsHashes` is empty again: its `capabilities` entries led up to this pin. The bundle built
from the pin is the store path the override run tested (`1i8g76m9…-whombat-runtime-0.1.0-e847497`, the same NAR hash
`sha256-d26PVEAr…`), so `browser-real-runtime` 9/9 (V-72) holds for it; the check is now registered at the pin
(`checks.x86_64-linux` lists `browser`, `browser-config`, `browser-real-runtime`). A prod image built from this commit
ships the browser host (`bin/whombat-browser-host`) and so starts `whombat-browser` where the memory allows it (NX-95).
Checked: `.#whombat-runtime` (install checks), `checks.{runtime-pin,browser-config,eval-aarch64,vault-wall-config,
proxmox-config,licence,clients}`; `manifest/build` and `manifest/validate` of the candidate with its runtime and app on
`ref: main` (same product manifest, same digests).
## NX-103 `update-migration`: a release that migrates the database, with real runtimes (2026-09-28; MG-43; Whombat MD-12)
Superseded in part by IN-416 (HE-52): `rt-old` is the baseline Whombat `14057e5a`, schema 1.
`checks.x86_64-linux.update-migration` (`vm-tests/update-migration.nix`) runs MG-43 end to end: the real manager,
helper, backup service and PostgreSQL, the fake control serving assignments (`whombat-fake-control` gains
`update.assignment` from an assignment the test puts, `POST /test/assignment/{device}`, and records `update.progress`,
`GET /test/progress`; device requests aren't verified there) and the development fixture repository republished with
four releases whose runtimes are real bundles (placeholder artifacts: the bundles are in the VM's store). The tuples
name the VM's own system and manager, published with a placeholder host artifact: the helper activates a runtime only
on the host its tuple names and seeds its records from a factory tuple only when it names the booted system (the
fixture host of `runtime-real` never activated anything, hence its `seedHelper: false`). Releases: `rt-old` = Whombat
`2be6fc1`, schema 48 (what production ran), the factory release — `builtins.fetchGit` of the rev, its pnpm hash in
`pnpmDepsHashes`, version set to `0.0.48-2be6fc1` so the forward check doesn't depend on how commit hashes sort (it
orders the part after `-` as text); `rt-new` = the pin, schema 49 (`0048_capabilities`, an expand with floors 48/48);
`rt-new-bad` = its own store path over the new bundle's entries under a tuple whose runtime version the bundle doesn't
report (it migrates, activates, then fails verification: a rollback without a broken build); `rt-contract` = the pin
plus a synthetic `contract` migration (schema 50, floors 49/50) added in `postPatch`. The box has no backup destination.
Policy overrides keep it short (poll 5 s, verify 90 s, health every 3 s, one attempt). `vm-tests/default.nix` takes
`releaseRuntime` and registers the test only when the pinned Whombat's schema check reports targets (`SchemaTarget` in
`compat.ts`, MD-12); until the pin moves there it runs with `--override-input whombat <a rev with it>`.

Run 2026-09-28 with KVM, `--override-input whombat git+file:///home/me/Code/Whombat?ref=update-migrations&rev=
42beff19…` (Whombat `update-migrations`, MD-12): provisioning on `rt-old` creates schema 48, the helper seeded with it;
**`rt-contract`** — plan `rollbackAccess none`, target 50 (49/50), `needsCheckpoint [0049_vmtest_contract]`; at the
safe boundary the backup service answers `412 unprotected`, the candidate waits: “Update needs a verified checkpoint
before migrating the database (backup service: HTTP 412 unprotected: no backup destination is configured: this
appliance is unprotected); it will retry at the next window. Nothing was changed.”, schema 48, `rt-old` running and
resumed, the rows kept; **`rt-new-bad`** (replaces it) — plan `rollbackAccess read-write`, target 49 with floors 48/48, no
checkpoint; migrated to 49 and activated (`checkpointRef` empty), unhealthy, rolled back after the known-good's own
check said read-write, quarantined (`unhealthy`, `knownGoodAccess read-write`); `rt-old` healthy on schema 49
(`newer_compatible`, `read-write`; its `schema-check` shows the recorded floors 48/48), the rows kept; the database
recreated at 48 by `rt-old` and populated again; **`rt-new`** — migrated 48 → 49 without a checkpoint, activated,
`Healthy`, `current` verdict read-write, the rows kept, the contract's table never created, control's last
`update.progress` `Healthy` on `rt-new`.

## NX-104 The image's runtime moves to Whombat 195421a4; candidate 0.18.1 (2026-09-28; NX-102, NX-103; MG-43; Whombat MD-12)

Whombat main `195421a4` merges `42beff19`: `whombat schema-check` names the schema it migrates to and that schema's
floors, which the fixed manager (MG-43) uses to judge a migrating release. The flake input `whombat` moves there from
`e8474971`; the runtime package names candidate 0.18.1 (0.18.0 with the runtime pin moved, product `2026.09.28-rc.4`);
the pnpm hash is unchanged (the lockfile didn't change since `e8474971`). `update-migration` (NX-103) now registers
without an override and passed at the pin: the synthetic contract release waits for a checkpoint on an unprotected box
and changes nothing, the expand release migrates 48→49, activates and is healthy without a checkpoint, and the failed
verification rolls back to the old runtime running read-write on 49. The production box on `pve-20260928.4` (whose
manager predates MG-43) is reinstalled from this release's ISO rather than updated (Whombat-api HZ-28, HZ-29).

## NX-105 Versions that order by build: commit time in the runtime's and a release's manager's version (2026-09-28; UP-A1, UP-A2, NX-71)
`0.1.0-<shortrev>` compared revs as text (and a rev of digits only as a number), so about every other runtime-only
release would have compared older than the one before it and been refused as a downgrade (known issue 1); the
manager's version was a constant `0.1.0` in every tuple (known issue 11).

- **Runtime:** `nix/packages/runtime` is `"${package.json version}-${src.lastModifiedDate}.${shortRev}${patchTag}"`:
  the flake input's commit time (UTC `YYYYMMDDHHMMSS`) orders builds, the rev tells them apart, `.p<digest>` marks a
  patched bundle (NX-71) and `releaseRuntime` still appends `.<label>` for a dev runtime-only release. The commit
  time is fixed by the pinned source, so the build stays pure and a rebuild gives the same version.
- **Manager and helper:** the appliance semver `applianceVersion = "0.2.0"` is defined once in `flake.nix`.
  `proxmoxRelease` overrides the manager's and the helper's version to `0.2.0-${self.lastModifiedDate}.${self.shortRev
  or self.dirtyShortRev}` (`releaseGo`, keeping the same vendored `goModules`); every other build of the Go packages is
  `0.2.0-0.dev` (`nix/packages/go.nix` takes `version`; UP-X09), so VM tests and dev images don't rebuild on every commit. The
  version reaches `manager.json` (`managerVersion`, reported in `status.report`) and the tuple (`release/build-proxmox`
  reads `manager.version`).
- **Release builds check the runtime:** `proxmoxRelease`'s runtime asserts the pinned Whombat's package.json is a
  plain `MAJOR.MINOR.PATCH` of at most 19 digits each (MG-50: a `+` would make the whole runtime version build
  metadata, so every runtime compared equal; a pre-release core misorders; longer numbers compare as text; the
  appliance semver is checked the same way and a release runtime version never has a `+`), at least `0.2.0` — so every new runtime has core `0.2.0` and compares newer than every `0.1.0-<rev>` in the field
  whatever follows the `-` (UP-A2, MG-49) — and that the version fits the contracts' `VersionString` (64 characters).
  At the current pin (package.json `0.1.0`) a release build stops with “the pinned Whombat's package.json says 0.1.0;
  release runtimes need 0.2.0 or later …”: intended, until the pin moves to Whombat 0.2.0 (MD-13).
- **`checks.runtime-pin`** also checks the forms: the runtime `<package.json>-<14 digits>.<rev>`, a release's manager
  and helper `0.2.0-<14 digits>.<rev>`, the dev build's `0.2.0-0.dev`.
- **Ordering notes.** Every new manager version is a pre-release of `0.2.0`, so each compares **below** `0.2.0`: a
  threshold “at least 0.2.0” (control's UP-E6) is `0.2.0-0`. The dev and test builds' version is `0.2.0-0.dev`
  (UP-X09, orchestrator after the security review), not `0.2.0-dev`: a pre-release segment with letters sorts after
  every number, so `0.2.0-dev` compared newer than every `0.2.0-<commit time>` and a box on a dev-built manager
  would have refused every pipeline release. The order is `0.1.0` < `0.2.0-0` (control's floor) < `0.2.0-0.dev` <
  `0.2.0-<commit time>.<rev>` < `0.2.0`: a box installed from a non-release image passes the floor and takes
  releases normally (`helper/pkg/trust/transition_test.go`). Raise `applianceVersion` when a manager must compare
  newer than every one before it whatever its commit time.

Checked: `nix eval` of `lib.proxmoxRelease { env = "dev"; releaseId = "pve-dev-20260929.1"; }`: `manager.version` =
`0.2.0-20260928175446.1f54d24-dirty` (this worktree), `runtime.version` stops with the assertion at the pin; with
`--override-input whombat` of a throwaway clone of the pin whose package.json says `0.2.0` (commit `5b92166`, committed
2026-09-28 18:07:06 UTC): `0.2.0-20260928180706.5b92166`, with `runtimeLabel = "r2"` `…5b92166.r2`, the helper the same
as the manager. Non-release builds: manager and helper `0.2.0-0.dev`, runtime `0.1.0-20260928171414.195421a`.
`nix build .#checks.x86_64-linux.runtime-pin` passes.

## NX-110 Upgrade gates: the candidate installed as an update of the releases boxes run (2026-09-28; UP-C2, UP-F2)
Superseded in part by IN-415 (HE-52): the previous releases start at the migration baseline, and may be none.
The gate missing on 2026-09-28: nothing installed a candidate as an **update** of the release boxes actually ran.
`lib.upgradeGates { candidate = { build }; previous = [ { build; flake } … ]; }` (flake.nix, `vm-tests/upgrade-gates/`)
and the runner `release/upgrade-gates --candidate <build.json> [--previous <build.json|id> …] [--gates 1,…] [--out F]
[--jobs N] [--no-lock]` do it, in seven NixOS tests:

| Gate | What | Test |
|---|---|---|
| 1 | N−1 → candidate, through the box's manager, helper, TUF and the fake control, with the owner's data | `update.nix` |
| 2 | N−2 → candidate (a box that skipped one; its manager may predate MG-43) | `update.nix` |
| 3 | a fresh install from the candidate's ISO: self-registration, first boot healthy | `install.nix` |
| 4 | a candidate that fails verification rolls back to N−1 by itself; data kept | `update.nix` |
| 5 | migration classes on the candidate's runtime | `checks.update-migration` (NX-115) |
| 6 | a runtime-only release on N−1's host, then a host release that keeps that runtime | `update.nix` |
| 7 | restore drill: a failed contract migration's checkpoint restored onto a fresh box | `checks.restore-drill` (NX-116) |

- **Previous releases are built from their recorded sources**, not taken from their published closures (those pin
  production's TUF root and endpoints, so no test repository could update them): `builtins.getFlake
  "git+file://<repo>?rev=<build.json source.rev>"`, that commit's `lib.proxmoxRelease { env = "dev"; releaseId; }`,
  then `appliance.extendModules { modules = [ gate-env.nix ]; }`. Manager, helper and runtime are the commit's own, so
  their store paths are the published ones; the runner records `matchesPublished` per release (runtime and manager
  store paths equal to `build.json`'s) and a mismatch fails the run. Verified: `pve-20260928.6` (appliance `6723564`)
  runtime `01nxl6f5…-whombat-runtime-0.1.0-195421a`, manager `0cz0cqy1…-whombat-manager-0.1.0`; `pve-20260928.4`
  (`4e69899`) runtime `8jm3gjd0…-0.1.0-2be6fc1`, manager `5bvfa6jd…` — all equal to the published. The host differs
  from the published one by the environment module only (and prod's profile: the gates build the dev image, whose
  runtime and manager are the prod image's). A previous release that is runtime-only (`--reuse-host`) is refused: gate
  the release whose host it runs. The default previous releases are `vm-tests/upgrade-gates/previous.json`: N−1
  `pve-20260928.6` (production), N−2 `pve-20260928.4` (`.5` was refused on every box, MG-43); moved when a release is
  promoted to production.
- **The candidate** is its build.json's commit (`git+file://<repo>?rev=`), or this working tree when the build was
  `--allow-dirty` (then HEAD must be the build's commit and the gate's runtime and manager must be the build's store
  paths, else the runner refuses: the tree changed since the build).
- **The gate environment** (`vm-tests/upgrade-gates/gate-env.nix`), the only difference from a release's dev image:
  environment `dev` with the committed development TUF fixtures (pinned root, fixture keys: the gate repository is the
  fixture repository with the releases published into it; the dev instance's `local` repository has no committed
  keys), control at `control:4600` (the fake control, self-registration on), the TEST licence key set, no AI client
  channel (the fixtures have no clients role), no relay host, the test network (the box is 192.168.1.1 matched by the
  test driver's MAC for node 1, `control` 192.168.1.2: gates name their nodes `box` < `control` < …), nixpkgs'
  test-instrumentation from the release's own nixpkgs (the driver's backdoor; root stays locked), jq and curl for the
  test script, a 10 s boot-assessment settle, and short manager timings (poll 5 s, health every 5 s, verify 4 min, one
  attempt: a failed candidate is quarantined at once). It sets only options every gated release has, and only manager
  settings keys the oldest one's configuration knows (it refuses unknown keys).
- **The runner** evaluates the gates (`record`: the candidate's and previous releases' commits and store paths),
  builds every selected gate's driver in one `nix build` (disk images, the gate repository, the ISO, runtimes:
  derivations, cached across runs), then runs each test driver **outside the Nix sandbox**: the daemon builds in
  `/tmp`, a 95 GB tmpfs on this machine, and a gate writes several GB into its box's disk overlay (a download of the
  host stream, the helper's verified copy, the imported paths). Drivers get their state in `~/.cache/wb-tmp/ug/XXXX/g<n>`
  (short: the driver's QEMU sockets must fit an AF_UNIX path) with `TMPDIR` and `XDG_RUNTIME_DIR` (the driver prefers
  it) pointing there, up to `--jobs` (default 2) at a time. The whole run holds `~/.cache/wb-tmp/robust-updates-heavy.lock`
  (`--no-lock` for a caller that holds it, `release/ship validate`). It writes `upgrade-gates.json` next to the
  candidate's build.json — `{v: 1, releaseId, buildSha256, previous: [{releaseId, rev, runtimeStorePath,
  matchesPublished}], gates: [{id, name, ok, seconds, log}], ok, at}`, `ok` when every selected gate passed and every
  previous release matches its published one — and the gates' logs in `upgrade-gates.json.logs/`; exit 1 when a gate
  failed. The gates are also plain derivations (`.gates."<n>"`) for a sandboxed build.

## NX-111 A release's installed disk, and the box that boots it (2026-09-28; UP-C2; PI-02, PI-09)
- `vm-tests/upgrade-gates/image.nix`: the release's own installer (`installer-base.nix` of its commit, its packages,
  the graphical installer off) runs `whombat-install --disk … --yes-erase-disk` (what the ISO's shell and its graphical
  installer run) onto a blank 128 GiB disk; the disk, converted to qcow2 (~6 GB), is the test's output: one derivation
  per release (and gate environment), about 3 minutes, cached. It is never booted: every gate boots a copy-on-write
  overlay of it, so the first boot — Secure Boot keys, `/persist`, self-registration with that gate's control, the
  factory tuple from that gate's repository, the helper seeded, the runtime creating its schema — happens in the gate.
- The box (`nodes.nix`) is the qualified Proxmox VM as install-proxmox-vm has it: q35, OVMF with Secure Boot in setup
  mode, no TPM, the disk on virtio-scsi, the i6300esb watchdog; the node's own NixOS configuration only makes QEMU's
  command line. A host update reboots the box for real (systemd-boot, the UKI of the new generation, boot counting).
- Reboots: the update helper schedules `systemctl reboot` through the transient `whombat-reboot.timer` (10 s). The
  test polls it with the journal and, when it is active, reconnects to the next boot's backdoor; a shell lost any other
  way (a boot assessment that fails on a counted entry reboots at once) is followed the same way.

## NX-112 Artifacts move as real `nix-store --export` streams through TUF (2026-09-28; MG-09, MG-41)
- **Decision: real streams for everything a box downloads** (the candidate's host ~4.8 GB and runtime ~0.37 GB, the
  variants' runtimes); **placeholders only for the previous releases' hosts**, which boxes boot from their disks and
  nobody downloads (as in update-migration). Reason: it is the whole path a box takes — the manager's resumable
  download against TUF target hashes, the helper's verified copy and `nix-store --import` of a real closure into the
  box's own store, the host generation from it — and it is cheap on this machine: in gate 1 the host stream came over
  the test network in 38 s (~127 MB/s, darkhttpd on the control node reading the store), the runtime in 5 s, and the
  whole host update N−1 → candidate (download, verification, staging, safe boundary, activation, reboot, verification)
  took 94 s.
- `vm-tests/upgrade-gates/repo.nix`: `tufrepo export-release` runs in a derivation against a private Nix database of
  the closure (`closureInfo`, `nix-store --load-db` into `NIX_STATE_DIR`, as nixpkgs' make-disk-image does), and
  `tufrepo publish-release` signs each directory into a copy of the fixture repository — both the candidate's own
  release tools, the path a release takes. A previous release is a placeholder host artifact (`add-artifact`) plus a
  runtime-only publish of its release; the variants that reuse a published host are exported `--reuse-host`. Built once
  per candidate (~7 GB of streams; 3.8 GB on this ZFS) and cached; the control node copies its metadata, links its
  targets from the store, and re-signs snapshot and timestamp at boot (`tufrepo refresh`: a timestamp signed at build
  time expires in a day; targets in 90).
- **Ids in the gate repository.** It is a development repository, which signs `pve-dev-YYYYMMDD.N` (ordered) and ids
  outside the ordered families, never a production id (MG-50). The candidate is published under its DEV twin's id (a
  production build's `pve-` becomes `pve-dev-`, as `release/ship` builds the twin, UP-C1); a previous release under
  `rt-<its id>` (`rt-pve-20260928.6`), built as that id (its image's factory release), its tuple keeping its published
  host version so the boxes compare versions as in the field — the field's history can't be signed in order anyway
  (N−1's runtime `0.1.0-195421a` sorts before N−2's `0.1.0-2be6fc1` as text, known issue 1, MG-44); the variants as
  `rt-<what>.<candidate id>`. `upgrade-gates.json` keeps the real ids (`previous[].releaseId`).

## NX-113 Gates 1, 2, 4 and 6 (2026-09-28; UP-C2, UP-E6, MG-43)
*Superseded in part by Whombat one-repo.md OR-63 (2026-11-20): a box takes the newest release its update channel lists,
so a step is published into a channel of the gate repository, not assigned through the fake control; control hears
nothing from a box that isn't linked; the detour for managers before MG-43 is gone.*

`update.nix`: a box installed from a previous release boots, provisions itself and gets the owner's data — two
accounts, a burrow, a channel and 40 messages (curly quotes, the middle dot, €), written as the runtime's database user
and fingerprinted (counts and an md5 over the messages). Then a series of assignments through the fake control; after
each, per its expectation: **healthy** — the release is current, known-good and the helper's current, the box booted
its host and runs its runtime (profile and `/health` version), the schema is its `schemaWrites`, it rebooted exactly
when its host changed, and control's last `update.progress` says Healthy on it; **rolled-back** — quarantined after a
rollback with the expected failure code, the box on what it ran before (booted host, runtime, version), the schema not
below it; **refused** — quarantined with the expected code before anything changed (same boot, host, runtime and
schema). The fingerprint is unchanged after every step. The variants (NX-112's ids):

- **1** `N−1 → <id>`, healthy.
- **4** `N−1 → rt-bad.<id>`: the candidate's host with a runtime whose tuple names a version the bundle doesn't report (its
  own store path over the candidate bundle's entries, as update-migration's `rt-new-bad`): the box reboots into the
  candidate's host, the runtime is healthy but not the version the tuple says, after the verify timeout the manager
  rolls back (a reboot into N−1's host), N−1's manager verifies the known-good and quarantines it (`unhealthy`). The
  verify timeout of a host candidate runs from its activation, not from its reboot: the deadline set at activation is
  the reboot timeout (20 minutes, not configurable) plus the verify timeout, and the reboot doesn't reset it (the
  `rebooted` reset in `activating` only applies when the manager restarts before it persisted `Verifying`). So a host
  candidate that is unhealthy after a one-minute reboot is rolled back about 24 minutes after activation in the gates
  (30 with production's 10-minute verify timeout); the gate waits for it.
- **6** `N−1 → rt-g6rt.<id>` (N−1's host and manager, runtime R6; runtime-only, no reboot) `→ rt-g6host.<id>` (the
  candidate's host and manager with R6; a reboot, the runtime unchanged). R6 is the candidate's runtime when it
  differs from N−1's, else the same source rebuilt as `<version>.g6` (`--runtime-label`).
- **2** from N−2. When the candidate migrates from N−2's schema and N−2's manager predates MG-43 (its source has no
  `CheckMigratingActivation`), the old manager refuses it whatever it reports, so: `rt-direct.<id>` (the candidate under
  another id) must be **refused** `schema_incompatible` with nothing changed (UP-E6's premise: control must not assign
  it); `rt-bridge.<id>` — the candidate's host and manager keeping N−2's runtime, a host release without a migration —
  healthy; then the candidate itself (from the bridge a runtime-only update, migrated by the new manager) healthy.
  Otherwise the candidate directly, healthy.

## NX-114 Gate 3: a fresh install from the candidate's ISO (2026-09-28; UP-C2 3; CG-11…CG-14)
*Superseded in part by Whombat one-repo.md OR-63 (2026-11-20): the box makes its own identity and control records no
device; its first start reads its release from its update channel.*

The ISO is the candidate's installer (`installerWith` of flake.nix, the dev ISO's name) of the candidate's gate image,
with the test driver's backdoor added to the installer (test-instrumentation), so the test uses the installer's shell as
a person at the console would; the graphical installer runs the same `whombat-install`. The box boots it from a
virtio-scsi CD-ROM (boot index 0) next to a blank 128 GiB disk, installs, powers off, and boots the disk with the CD-ROM
empty: self-registration (control records one device, origin `self`), `whombat-provision verify` (self-installed),
the factory tuple (the helper's current release, the journal Healthy on the candidate), its runtime healthy on its
schema, the platform `proxmox-vm host-encrypted`, the boot assessment passed; the owner's data survives a runtime
restart. **No claim**: the fake control has no claim flow (a claim goes through control's claim endpoints and the relay,
neither in the test); the gate prints the console's claim state instead. The real claim is the DEV box's (UP-D1).

## NX-115 Gate 5: the migration classes, in `update-migration` (2026-09-28; UP-C2 5, UP-B2; extends NX-103)
`update-migration` stays the direct-boot test with real runtimes and placeholder artifacts (its releases name the VM's
own system); its runtimes move to `vm-tests/common/migration-runtimes.nix` (the restore drill uses them too) and it gains
the classes it lacked. S is the pin's schema (49), from its migration journal:

- `rt-expand` = the pin plus a synthetic `expand` (schema S+1, floors S/S): migrates without a checkpoint on a box
  without a backup destination, healthy, verdict `current`, rows kept.
- `rt-custody` = the pin's runtime published by custody as a rollback from `rt-expand` (`add-release
  --allow-downgrade-from rt-expand`, MG-44; release tools without the flag publish it plain, and the forward check then
  refuses it): activates on the expanded database without a migration (its own check: `newer_compatible`,
  read-write), healthy, schema still S+1, rows kept (UP-B2, MG-45). Before MG-44/MG-45 the forward check refused the
  plain release (`0.1.0-…195421a < …m1expand`); the step is recorded when it fails and the test goes on to step 6,
  failing at the end.
- `rt-contract` = the pin plus that expand and a synthetic `contract` (S+2, floors S+1/S+2; it was one contract at S+1):
  step 1 still waits for a checkpoint on the unprotected box with nothing changed (target S+2); at the end, with a
  backup destination — an append-only restic rest-server on the control node, `whombat-backup destination set` — the
  manager takes the verified checkpoint, migrates S+1 → S+2 and is healthy; the checkpoint is listed by the backup
  service and in the repository, rows kept.

Synthetic versions are labelled along the chain (`<pin version>.m1expand` < `.m2contract`), so they order by the
forward check whatever the pin's version scheme.

## NX-116 Gate 7: the restore drill (2026-09-28; UP-F2; BK-13)
`checks.restore-drill` (`vm-tests/upgrade-gates/restore-drill.nix`): box A (factory release the pin) gets the owner's
data and a backup destination (the rest-server, append-only); `rt-fail` — the pin plus a `contract` whose SQL fails —
needs a verified checkpoint, the manager takes it at the safe boundary, the migration fails and leaves the database as
it was (all pending migrations apply in one transaction), the known-good check says read-write, A stays on the pin with
its data, `rt-fail` is quarantined (`migrate_failed`). A fresh box (its own factory release) is provisioned, then
restored the way `restore.md`/`replacement.md` describe it: the recovery kit (A's `kit-material`) joins the repository
(`destination adopt -kit`), what the fresh install created is set aside (`quarantine prepare`), the checkpoint the
manager took is restored (`quarantine apply -snapshot <checkpoint> -kit`: every drill check first, the files, then the
database, read-only), the data is A's exactly (fingerprint), writes are refused, the reconciliation items are resolved,
the quarantine released, and the runtime starts on the restored data, healthy and writable. Every backup command runs as
root at the console, as the runbooks say (BK-24). The fresh-box restore itself (`quarantine prepare`, the adopted
manifest key, subvolumes filled in place, the root→postgres peer map) is the backup workstream's (BK-24); before it the
gate failed at the first `destination set`.

## NX-117 The gates' self-test, their run time, and the first candidates through them (2026-09-28; UP-C2)
- **Self-test**: `release/upgrade-gates --break-candidate runtime|rollback` gates a candidate broken on purpose: its
  runtime server never starts (gate 1 must fail), or its update helper can't set a boot generation, so the rollback
  fails (gate 4 must fail) — the gates are not a tautology. The record says `breakCandidate` and is never `ok`. Run on
  `pve-dev-20260928.905`: **runtime** — gate 1 failed as it must, after 26 minutes: “pve-dev-20260928.905 was not
  installed: unhealthy … whombat-server.service is failed; runtime health unreachable …”, the box back on N−1 (boot
  counting rebooted the counted entry while the manager's deadline ran, then the manager rolled back). A first
  **rollback** mode — the candidate's manager verifying for a day — did *not* fail gate 4: a host candidate's deadline
  is set at activation by the manager of the release it replaces and survives the reboot (NX-113), so N−1's four
  minutes applied and the rollback happened; the mode now breaks the helper instead. Run on `pve-dev-20260928.906`:
  gate 4 failed as it must — “timed out after 2700s waiting for: rt-bad.pve-dev-20260928.906 rolled back and
  quarantined (phase Verifying)”, the candidate's manager logging “host rollback failed; retrying … activation_failed”
  every few seconds, the box left on the bad candidate.
- **The latest tree**: `pve-dev-20260928.904` (robust-updates a41c45d with MG-50…MG-52 and BK-26…BK-29, this
  workstream's gates, the Whombat pin moved as above): every gate passed again (1 = 127 s, 2 = 173 s, 3 = 68 s, 4 =
  1557 s, 5 = 221 s, 6 = 141 s, 7 = 57 s; 35 minutes). `checks.update-migration` at this tree's own pin (Whombat
  195421a4), `checks.sandbox-backup` and `checks.backup-destinations` pass in the sandbox.
- **Run time** on this machine (64 cores; the lock shared with other agents): the first build of a candidate's gates
  (its gate host, the ~5 GB export and the repository, the ISO, the three synthetic migration runtimes) 5–10 minutes;
  the previous releases' disks ~3 minutes each, once per gate environment; a re-run of an unchanged candidate only
  evaluates. Gates on `pve-dev-20260928.903`: 1 = 122 s, 2 = 163 s, 3 = 69 s, 4 = 1558 s (the host verify deadline,
  NX-113), 5 = 215 s, 6 = 139 s, 7 = 57 s; with `--jobs 3` the run took 46 minutes, gate 4 the long pole.
- **Candidates**: the robust-updates tree with the Whombat pin moved to Whombat `robust-updates` 2332f23 (package.json
  0.2.0, runtime `0.2.0-20260928190632.2332f23`, schema 49; NX-105 wants 0.2.0 or later) — built by
  `release/build-proxmox dev pve-dev-20260928.90N` from a scratch commit that only moves the pin (build-proxmox has no
  `--override-input`; the runner had one until NX-118). Against `pve-20260928.6` and `.4` rebuilt from their commits (runtime and manager
  equal to the published): every gate passed (`upgrade-gates.json` `ok`). Gate 2 showed the incident's failure and the
  way out: `.4`'s manager refused the migrating candidate `schema_incompatible` (`candidate_cannot_read_schema`, schema
  48) with nothing changed; the bridge (the candidate's host keeping `2be6fc1`) installed with a reboot; the candidate
  then migrated 48 → 49 as a runtime-only update under the new manager. Before UP-A1 the same gate stopped at the forward
  check (`runtime 0.1.0-195421a < 0.1.0-2be6fc1`), known issue 1.

## NX-118 Runtime-only candidates; the gates are the runner's, the candidate its own commit's (2026-09-29; UP-C2, IN-109)
The first runtime-only release through the pipeline, `pve-20260929.1` (`release/build-proxmox --reuse-host`: the host
and manager of `pve-20260928.7`, Whombat `af3f32c2`), stopped `release/ship validate` at “is a runtime-only release …:
gate the release whose host it runs”. UP-C2 wants the gates for every PROD candidate.

- **The candidate's host is the reused release's.** A candidate with `class: runtime` names `reusedHostFrom`; the
  runner finds its build.json (`--reused-host`, default `~/.cache/whombat-releases/<id>/build.json`) and the gates build
  that release from its commit as they build a previous one (`rt-<id>`, the gate environment; the same derivation when
  it is also N−1). The candidate's runtime comes from the candidate's commit (`proxmoxRelease … .runtime`, as
  build-proxmox built it). Its gate tuple is its build's (versions, schema facts) with the reused release's gate host
  and manager. The runner refuses when the runtime isn't the build's, the manager isn't the build's, or the reused
  release rebuilt from its commit isn't the published one (runtime and manager store paths); the record has
  `runtimeOnly` and `reusedHost {releaseId, rev, hostStorePath, matchesPublished}`. It is published `--reuse-host` into
  the gate repository after the reused release, whose host is a **real stream** there (NX-112's placeholders are only
  for hosts nobody downloads): a box on another host (gate 2) downloads it, as it would from production's repository.
  With a placeholder the first run's gate 2 failed exactly there (`import host/pve-20260928.7/whombat-host.closure: input
  doesn't look like something created by 'nix-store --export'`).
- **Which gates.** 1 (N−1 → candidate: when N−1 is the reused release, a runtime-only update, no reboot), 2 (N−2 → the
  candidate: a host and runtime update, the tuple names the reused host), 4 (a runtime that fails verification, on the
  reused host: rolled back to N−1's runtime), 5 and 7 (on its runtime; since NX-125 this tree's tests on the stack it
  runs on). 3 (it has no ISO: boxes
  are installed from the reused release's) and 6 (it is itself the runtime-only case) are recorded
  `{ok: true, notApplicable: "not applicable: runtime-only (…)"}` and not run. The self-test (`--break-candidate`)
  breaks a candidate's host, so it is refused for a runtime-only one.
- **The gates are the runner's.** `pve-20260929.1` was built from `7454cac`, whose gates had no runtime-only case: gates
  taken from the candidate's commit could never gate it. The runner now evaluates `legacyPackages.x86_64-linux.upgradeGates`
  of its own tree (its commit when clean, else `path:`; the record says `runner {rev, dirty}`) and gives it the
  candidate's commit as a flake, like every previous release: the candidate's release (its `proxmoxRelease`), its
  runtime, its release tools (export, publish, and the control node's refresh and assign: NX-112's “the candidate's own
  release tools”), its checks (gates 5 and 7) and its installer profile (gate 3's ISO, rebuilt as its flake's
  `installerWith` does) are the candidate's; the test framework, the fake control and the gate environment are the
  runner's. `--override-input` goes (`builtins.getFlake` takes none; the Whombat pin is pushed).
- **The bridge of gate 2** (and its refused `direct` twin) is built only when it is needed (N−2's manager predates MG-43
  and the candidate migrates from N−2's schema).
- **A box that never starts its kernel** fails its gate after 15 minutes: every boot waits for “Linux version” on the
  serial console before the driver's `connect()`, which waits for ever. On a host at a load of 200, two boxes stopped in
  the firmware's boot stub (after lanzaboote's “Secure Boot is not active!”, nothing more) and held their gates.
- **Run** (`release/upgrade-gates --candidate ~/.cache/whombat-releases/pve-20260929.1/build.json --previous
  pve-20260928.7 --previous pve-20260928.6`, runner `5ed7af2`): `ok`. Candidate runtime `ij2nvf6a…-0.2.0-20260929063524.af3f32c`
  and manager `vxx3lirq…-0.2.0-20260928233154.dbbadbe` are the build's; `.7` rebuilt from `dbbadbe` and `.6` from
  `6723564` match the published. Gate 1 (43 s): `.7` → the candidate, a runtime-only update (`activated`, no reboot),
  healthy, data intact. Gate 2 (116 s): `.6` → the candidate, a host and runtime update with a reboot into `.7`'s host.
  Gate 4 (434 s): the bad runtime on `.7`'s host rolled back to `.7`'s runtime (`unhealthy`), quarantined by `.7`'s
  manager at its single gate-environment attempt, not re-activated in the 150 s after. Gates 5 (208 s) and 7 (54 s) are
  `7454cac`'s checks on Whombat `af3f32c2`. Gates 3 and 6: not applicable. 14 minutes with `--jobs 3`, the repository
  (with `.7`'s host stream) built once. A host candidate (`pve-20260928.7` against `.6` and `.4`) still evaluates all
  seven gates.

## NX-119 Gate 4 and MG-56: the rollback's end, and no re-activation (2026-09-29; MG-56)
MG-56: a release that failed after activation is never re-activated from local state; the manager rolls back and waits
in `RolledBack` (the candidate kept, `failure.afterActivation`) for control to assign it again. The manager that ends a
rollback is N−1's (a runtime rollback runs on N−1's host; a host rollback reboots into it), so gate 4 now accepts either
end — quarantined (managers before MG-56, with the gate environment's single attempt) or waiting for control — asserts
the waiting state when N−1's source has MG-56 (`afterVerificationFailure`; the record's
`previous[].verifyFailureWaitsForControl`), and then watches the journal for 150 s (thirty of the gate environment's
5-second retry and idle intervals): no step of the release after its `RolledBack`, the box still on N−1. With N−1 =
`pve-20260928.7` (`dbbadbe`, before MG-56) the release is quarantined at its first failure because the gate environment
allows one attempt; production's policy allows three, so a box on `.7` would re-activate a runtime-only release that
failed verification up to twice by itself (the DEV finding MG-56 fixes), and no runtime-only release on `.7`'s host can
change that: MG-56 reaches boxes with the next host release. The gate becomes the MG-56 check itself once N−1 carries it.

## NX-125 Gates 5 and 7 are the runner's tests on the candidate's stack; update-migration and MG-56 (2026-09-29; UP-C2, MG-56)
`release/ship validate pve-20260929.2` (a runtime-only release on `pve-20260928.7`'s host, built at `ad9a1a7`, which has
MG-56) failed gate 5 after 636 s: gate 5 was the candidate's own `checks.update-migration`, which ran `ad9a1a7`'s
manager (not the one boxes run with this release) and still waited for `rt-new-bad` to be quarantined, which MG-56's
manager no longer does. (NX-120…NX-124 are the pipeline's block; this entry takes the next free id.)

- **update-migration and MG-56.** `rt-new-bad` fails verification after activation; the test now accepts either end:
  rolled back and waiting for control (the release kept as the candidate, `failure.afterActivation`) when the manager's
  source has MG-56 (`afterVerificationFailure`), quarantined otherwise — and asserts the one its manager must reach —
  then watches for 90 s that nothing re-activates it. The next assignment (`rt-new`, another release) starts as before
  (MG-56's `afterVerificationFailure` lets a queued assignment of another release through). The pin's schema is `S` in
  the assertions that meant it (they said 49).
- **Gates 5 and 7 are this tree's tests on the candidate's stack**, like the other gates: `update-migration.nix` and
  `upgrade-gates/restore-drill.nix` of the runner, run as NixOS tests with the pkgs, modules, manager, update helper and
  backup service of the host the candidate runs on (its own commit's; a runtime-only candidate's reused release's —
  what boxes run with it), the candidate's runtime (its pin, `migrationRuntime`, made into release bundles by its own
  `releaseRuntime`, which the flake now exports as `lib.releaseRuntime`; the runner's for candidates from before), and
  the candidate's release tools on the control node. The tests take `migrationRuntime` and `managerSource` as module
  arguments; `vm-tests/default.nix` passes this tree's for `checks.update-migration` and `checks.restore-drill`. A stale
  test in a candidate's commit can no longer fail or pass a gate. The record's `stack {host, runtimeStorePath,
  runtimeIsCandidates, releaseRuntimeFrom}` says whose host stack ran and whether `rt-new` is the candidate's published
  runtime (for `.2` it is: the runner's `releaseRuntime` builds the same bundle as `ad9a1a7`'s).
- **Proved** (runner `8151146`): gates 5 and 7 on `pve-20260929.2` (`--gates 5,7`, previous `.7`, `.6`) `ok` — gate 5
  (307 s) on `.7`'s host stack (`dbbadbe`, before MG-56): `rt-new-bad` rolled back and quarantined at its single
  attempt, `rt-new` next, every later step as before; gate 7 (56 s). `checks.update-migration` (645 s) and
  `checks.restore-drill` (240 s) at this tree (MG-56's manager): `rt-new-bad` rolled back and left waiting for control,
  not re-activated in 90 s, then `rt-new` assigned from `RolledBack` and healthy.

## NX-126 Faster upgrade gates; runtime-only previous releases (2026-09-29; UP-C2, MG-55, MG-56)
John asked for faster shipping. On `pve-dev-20260928.904` gate 4 took 26 of the run's 35 minutes: a host candidate that
fails verification is rolled back at the deadline N−1's manager set at its activation — the 20-minute host reboot
timeout plus the verify timeout — whatever happens after the reboot (NX-113).

- **Short host timers where the manager takes them.** The gate environment verifies for 3 minutes (was 4), and
  `./release.nix` adds `hostRebootTimeoutMs` = 3 minutes to a release whose manager's configuration has the key (MG-55;
  `pve-20260928.7`'s `dbbadbe` on): such a host candidate is rolled back 6 minutes after its activation. Older managers
  (`.6`, `.4`) refuse unknown keys and keep 20 minutes. The deadline is N−1's manager's, so the gate's wait is derived
  from N−1 (`rollbackAfterS` + 10 minutes; the record's `previous[].hostTimers`). 3 minutes are enough on this machine
  for a host reboot and a healthy real runtime (both under a minute and a half when the host isn't overloaded) and short
  enough that a failed candidate costs little.
- **Watches only as long as they prove something.** The MG-56 no-re-activation watches (gate 4, update-migration) are
  30 s: a manager that retries by itself does so after its retry interval, 5 s in the gate environment, so 30 s is six
  of them (they were 150 s and 90 s).
- **One evaluation, a pipelined pool.** The runner evaluated the gates three times (record, drivers, build); now once
  (the record with every gate's driver derivation), then runs up to `--jobs` gates (default 3, was 2) longest first
  (4, 5, 7, 2, 6, 1, 3), each building its own driver (`nix build <drv>^out`: what gates share is built once, the
  others wait on Nix's lock) and starting as soon as a slot frees, instead of one build for all and batches that waited
  for their slowest gate. Gates 5 and 7 need no disk and no repository, so they run while the others build. The record
  has `buildSeconds` next to `seconds` per gate. The run holds the heavy lock from its first build to its last gate: it
  is 10–15 minutes now.
- **Shared across runs**: the previous releases' disks (one per release and gate environment), their exports (named by
  release id, so a release's host and runtime streams are built once whatever role it has) and the migration runtimes
  of a runtime pin. Per candidate: its gate host, export, repository, ISO.
- **Runtime-only previous releases.** Promoting `pve-20260929.2` made it the default N−1 (`previous.json`): a
  runtime-only release on `pve-20260928.7`'s host, which the gates refused as a previous release. It is now built as its
  runtime on the reused release's gate host (the same construction as a runtime-only candidate, `releases.runtimeOnly`):
  its box boots the reused release's disk, provisions itself on it and reaches the release by a runtime-only update
  (assignment 1), as boxes did, then the gate's steps follow. Its manager facts (MG-43, MG-56, timers) are the reused
  release's. The runner passes each runtime-only previous release with its reused host's build.json
  (`previous: [{build, reusedHost}]`); the repository publishes the reused release first.
- **What it found at once (MG-57).** The first host candidate gated against N−1 = `pve-20260929.2` failed gate 4: the
  bad candidate booted, failed verification, and the rollback to the known-good `rt-pve-20260929.2` was refused by the
  helper (`not_assigned: assignment does not match the approved tuple`) and retried for ever — the helper looked for a
  runtime-only release among its recorded hosts. Production's box runs `pve-20260929.2`: any host release failing
  verification there would have stayed on the bad candidate. Fixed in the helper (MG-57, appliance `06af79d`); this gate
  4 case (a host candidate against a runtime-only N−1) is its regression test and passes with the fix.
- **Measured** on this machine, `--jobs 3`, whole runs including the evaluation and every gate's build (previous
  releases' disks rebuilt once for the new gate environment in the first run):

  | Run | Before | Now |
  |---|---|---|
  | runtime-only `pve-20260929.2` against `.7`, `.6` | 14 min (`.1`, NX-118) | **7 min 55 s** — 4: 254 s (+178 s build), 5: 243 s, 2: 118 s, 7: 59 s, 1: 43 s |
  | host `pve-dev-20260929.901` against `.7`, `.6` | 35 min (`.904`, NX-117) | **9 min 58 s** — 4: 510 s, 5: 255 s, 6: 147 s, 1: 124 s, 2: 119 s, 3: 66 s, 7: 54 s |
  | host `pve-dev-20260929.902` (main with MG-57) against `.2`, `.7` (the defaults) | — | **10 min 51 s** — 4: 545 s, 5: 248 s, 6: 170 s, 1: 148 s, 2: 121 s, 3: 64 s, 7: 52 s |

  The self-tests still fail the gates they must: `--break-candidate runtime` failed gate 1 (“was not installed:
  unhealthy … whombat-server.service is failed”, 9 min 16 s), `--break-candidate rollback` failed gate 4 (“timed out
  after 960s waiting for: rt-bad… rolled back (phase Verifying)”, 18 min: the wait is the rollback deadline plus ten
  minutes). The candidates were built with `--runtime-label fast` (dev), so their runtime differs from N−1's as a real
  host release's does; a candidate whose runtime is N−1's adds one runtime rebuild for gate 6 (NX-113).

## NX-127 Production's Feedback widget origin is embed.whombat.com (2026-09-29; amends NX-39; FD-31, FD-50, HZ-03)

`whombat.runtime.embedUrl` defaults to `https://embed.whombat.com` for `prod` and `https://embed-dev.whombat.com` for
`dev` and `local` (the dev instance's origin since IN-57; `dev-instance.nix` already set it). NX-39 left `prod` null
“until an embed origin is hosted there”; production has hosted one on the Hetzner host since 2026-09-27
(`whombat-embed`, control `CONTROL_EMBED_ORIGINS=https://embed.whombat.com`), but the image was never changed. A prod
box therefore expected drops from `https://app.whombat.com` (FD-30's fallback) and refused every report the widget
sent from `embed.whombat.com` as `origin` (FD-50): the visitor saw a reference, control delivered the drop, the box
refused and acknowledged it, and nothing reached the channel (first seen with FB-J3X7-SJGQ on `wb-old0-prod-0002`).
The app origin never worked as a fallback in production either: `app.whombat.com` serves no embed tree. Ships as a
host release (`pve-20260929.4`).

## NX-120 The dev image writes the console's state to the serial console (2026-09-28; UP-D1, UP-D3; IN-94)

The DEV box (`dev/devbox`, an Incus VM on the build machine, IN-94) is claimed with the four letters of its console,
and the graphical console draws them on the screen, which a program on the host can't read (Incus gives the VGA output
only as SPICE). `nix/profiles/dev-instance.nix` adds `whombat-dev-serial-console`: every 2 s it reads the console file
(`/run/whombat/console/console.json`, CC-08) as the console's own user and writes one line per change to `/dev/ttyS0`,
`whombat-dev-console: state=claimable code=ABCD`, which `incus console whombat-dev-box --show-log` returns. Only the state
and the letters: no burrow names, no ids. systemd opens the port for the unit (the console's own pattern, NX-32), which
otherwise has no network, no capabilities and read-only everything. Nothing else uses the serial port on this image (the
kernel console and the gettys are on the VTs), and a VM without one (Proxmox's default) fails the unit three times and
leaves it failed. Dev only: `prod-instance.nix` has no such unit, so a PROD build and its DEV twin differ in their host by
this unit and the environment profile, never in the runtime or the manager (their store paths stay equal, UP-C1).
Because `pve-20260928.6`'s source (`6723564`) predates it, the first DEV box is installed from a twin built at the
`ru-pipeline` commit that adds this unit (IN-95), not from `6723564` itself.

## NX-128 Vault SSH: the runtime server reaches public addresses on the SSH ports (2026-10-01; Whombat VT-S06, VT-S14; IN-150)

The Vault's SSH keys are used by the runtime server itself (VT-S01: `ssh2` in the server, nothing in the runner or a
sandbox), so the egress table opens SSH to the server's uid only. `whombat.vault.sshPorts` (in `vault-wall.nix`, next to
the home networks: default `[ 22 ]`, ports 1–65535, at least one and at most 16, no duplicates; assertions say which) is
the one list: `runtime.nix` exports it sorted as `WHOMBAT_VAULT_SSH_PORTS` (`22`, `22,2222`) and `network.nix` adds,
after the home-network rules, `meta skuid <whombat> tcp dport { <ports> } jump vault_ssh`. The chain `vault_ssh` returns
for a non-public destination (`nonpublic4`, `ip6 daddr != 2000::/3`, `nonpublic6`) and accepts the rest; a returned
packet falls to the output chain's final drop, so private, loopback, link-local, CGNAT, metadata (including
168.63.129.16), documentation, benchmarking, multicast, NAT64, 6to4, Teredo and ULA destinations are reachable only when
the admins listed them as a home network on that port (VT-12; the `vault4`/`vault6` sets and their conntrack mark,
NX-40). No conntrack mark on the public path: a public destination can't be “unlisted” except by changing the option,
which reloads the table. The non-public sets are the browser's (NX-97) under a neutral name, now defined
unconditionally (`browser_denied4/6` → `nonpublic4/6`); the browser chain is unchanged otherwise. An SSH port that is
also in `whombat.network.outboundTcpPorts` (443) was open to every uid already; that is unchanged and not a reason to
list it. No empty list: a box without public SSH is an app-level choice (no SSH entries), and an empty variable would be
ambiguous to the runtime.

## NX-129 Incus inside the appliance, for the agents' computers only (2026-10-02; Whombat AC-00, AC-01, AC-04, AC-07, AC-23; IN-155)

*Superseded by NX-455 (2026-10-25; Whombat one-person.md OP-04): the agents' computers and Incus are gone.*

Each agent gets an unprivileged Incus system container inside the appliance (AC-01; never a VM, no KVM needed, so the
same on bare metal and under any hypervisor, PI-21). `nix/modules/computers.nix`, option `whombat.computers.enable`
(default false in the module, `mkDefault true` in `nix/profiles/appliance.nix`, so every appliance configuration has it
and VM tests opt in).

- **Not the NixOS `virtualisation.incus` module.** It puts QEMU, OVMF, swtpm, virtiofsd, criu, skopeo/umoci, lego,
  LVM and `spice-gtk` (with GTK and GStreamer) into the closure for VMs and features computers never use: the toplevel
  grew by **1.09 GB** (4.734 → 5.821 GB, `nix path-info -S`, `appliance-x86_64` at `4b70f14`). The module writes its
  own units instead: `incus.service` runs **incusd alone** — a copy of `incus-lts`'s `bin/incusd` (no reference to its
  own package, checked; the package's other 240 MB are the VM agent for four platforms, migration tools, the
  benchmark) — with a PATH of what containers on a `dir` pool and a bridge need (tar and the compressors, unsquashfs,
  tar2sqfs, acl/attr, iproute2, nftables, dnsmasq, rsync), `INCUS_LXC_HOOK`/`INCUS_LXC_TEMPLATE_CONFIG`, lxcfs (only
  with Incus), and `incus-instances.service`, which stops the computers cleanly (`incusd shutdown`) before the host
  goes down; restarting the daemon alone leaves them running (`KillMode=process`, `stopIfChanged=false`). No web UI, no
  `incus-user`, no socket activation (its socket would be created before `/var/lib/incus` is mounted), no network
  listener (`core.https_address` unset). The client (`incus-lts.client`) is in the system path for operators.
  Result: **+107 MB** (4.734 → 4.841 GB): incusd 65 MB, the client 27 MB, lxc 11 MB, the rest small.
- **Incus 7.0 LTS** (`incus-lts` of the pinned nixpkgs): nftables only (7.0 has no xtables driver), which is what the
  appliance runs. The design spike ran 6.0.4 on the development host; nothing used differs.
- **Started by computerd, never on its own.** `whombat-computerd` wants `incus.service`; Incus and its storage carry
  computerd's conditions (`/persist/identity/device.json` and the profile's `bin/whombat-computerd`), because `Wants=`
  enqueues them even when computerd's own conditions then skip it. A box whose runtime has no computerd (every runtime
  before agent computers) runs no Incus and mounts nothing.
- **Subordinate ids.** Incus maps containers into root's `/etc/subuid` range; NixOS's module uses 1000000 + 10⁹, which
  contains the runner's sandbox range (2000000 + 65536, MA-12). Root gets **1000000000 + 1000000000** here, and an
  assertion refuses any overlap with `whombat.sandbox.uidRange`.
- **Kernel and sysctls.** `overlay` (Docker on a computer; an unprivileged container can't load it) and `veth` are
  loaded at boot; no `br_netfilter` (per-NIC ACLs filter between computers without it, and it changes how every bridged
  frame is filtered). Incus's recommended inotify and keyring limits as defaults.

## NX-130 The computers' storage: /persist, set-uid allowed, a `dir` pool with a limit of its own, not backed up (2026-10-02; Whombat AC-01, AC-05, AC-06; IN-155)

*Superseded by NX-455 and NX-458 (2026-10-25): no computers; the containers' storage is /persist/containers in 1/101.*

**Amended by NX-150 and NX-151 (2026-10-10):** on btrfs the computers are on Incus's btrfs pool `computers`
(`/persist/incus-computers`), in a qgroup of their own (1/101) inside 2/100; the `dir` pool below stays only where
/persist isn't btrfs, and existing boxes' computers move off it at boot. Where this entry says otherwise, those two win.

- **Where.** Incus's state (`/var/lib/incus`: its database, images, network state) is the subvolume `/persist/incus`;
  the storage pool is the subvolume `/persist/incus-pool`. Both survive host and runtime updates and live in the
  limited qgroup 1/100 with home, workspaces and the rest (`whombat.storage.extraSubvolumes`, a new internal option of
  storage.nix, created and assigned by `whombat-persist-layout` like the others), so computers can never eat the
  database's reserve (NX-12). *Since NX-150:* only `/persist/incus` is in 1/100; the pool's subvolume (the btrfs pool's
  `/persist/incus-computers`, and the old `/persist/incus-pool` until it is gone) is in 1/101, inside 2/100.
- **Bind mounts without nosuid.** `/persist` is mounted `nosuid,nodev`. An unprivileged container's root file system is
  a bind mount of its directory and keeps the flags of the mount it lives on: on `/persist` itself, `sudo` and every
  set-uid program on a computer fail (AC-01 promises sudo). `whombat-computers-storage` (a root oneshot before Incus)
  bind-mounts `/persist/incus` on `/var/lib/incus` and `/persist/incus-pool` on `/var/lib/incus-pool`, each in its own
  peer group (private, then shared: what Incus mounts below never propagates back into `/persist`), remounted
  `suid,nodev,exec`. A unit, not an fstab entry: the subvolumes exist only after `whombat-persist-layout`, which runs
  after local-fs.target, and a failed fstab mount would stop the boot.
- **`dir`, not `btrfs`** — *superseded by NX-150 on btrfs.* The `assigning … and rescanning` job this rejected exists
  now: incusd's `btrfs` puts each new subvolume into 1/101 as it is made (`-i`), whombat-qgroups catches the rest and
  rescans when btrfs loses the counts; Incus enforces each computer's `size` there. The original reasoning:
  Incus's btrfs driver makes every container a nested subvolume. A nested subvolume is in no
  qgroup but its own (btrfs doesn't inherit), so the computers would escape 1/100 and the database's reserve, and keeping
  them in it would need a job assigning each new subvolume and rescanning. Loop files (btrfs in a file on btrfs) would
  be copy-on-write twice and fail with I/O errors when the outer limit is hit. The `dir` driver keeps everything in one
  subvolume, which is in 1/100 and has its own limit: **`whombat.computers.storagePercent`** (default 50) of /persist's
  usable size, a qgroup limit on the pool's subvolume set at every start. Trade-offs: no per-computer disk quota (Incus
  logs that the file system has no project quotas and skips `size`; `WHOMBAT_COMPUTERS_DISK_GB` stays the intended size,
  and one full computer can fill the pool for the others, never for Whombat), and a new or reset computer unpacks the
  base image instead of snapshotting it (seconds to a minute for a ~2 GB image; zstd is the publishing compression,
  `images.compression_algorithm`, the fastest to unpack). Incus requires a pool's source outside `/var/lib/incus` (or
  exactly its own directory there, which must not exist yet) — hence the second subvolume and mount point.
- **The rescan.** `whombat-persist-layout` rescanned the qgroups at every boot; a rescan walks every extent of /persist,
  which computers make many of, and it holds up everything behind `whombat-persist.target` (PostgreSQL included). It
  now rescans only after it assigned a subvolume or when btrfs says the counts are inconsistent. *Since NX-150:* only
  when btrfs says the counts are inconsistent (an assignment btrfs can't carry the counts over for marks them so; one of
  an empty subvolume doesn't), and whombat-qgroups does the same after boot.
- **Not backed up.** Neither subvolume is a backup source (BK-04: home, workspaces, credentials, secrets): a restored
  or replaced box rebuilds each computer from the base image on the agent's next turn (as Reset does, AC-06); what an
  agent kept only on its computer is gone. The backup coverage inventory (`backup/pkg/coverage`) should list this as a
  class `computers` (not covered); its ids are the contract enum `BackupScope` (`@whombat/protocol`) and the app's
  labels, so the class waits for a contracts release that adds `computers` (follow-up, not in candidate 0.32.0).
- **Settings.** Remote images are not refreshed in the background (`images.auto_update_interval=0`: the remote image
  is used once, to build the base image, AC-05). The preseed (`incus admin init --preseed`, at every start, after
  `incusd waitready`) creates the pool and a default profile with only the root disk; **no network** — computerd
  creates its bridge (AC-07). *Since NX-150:* the preseed holds the server's settings and the profile's config only;
  the preseed script makes the pool and the profile's root disk once (NX-151 says why).

## NX-131 The appliance's wall around the computers (2026-10-02; Whombat AC-10, AC-11, AC-12; IN-155)

*Superseded by NX-455 and NX-460 (2026-10-25): no bridge; `computers_out`'s rules are `agent_wall`'s, for the commands' proxy and the containers.*

computerd's per-computer ACLs (allow rules only, default reject; AC-10) are the wall inside; these rules hold whatever
the ACLs say. All in `nix/modules/computers.nix`, appended to `inet whombat-egress` (they use its `nonpublic4`, `vault4`
and `vault_established`) and one bridge table. The bridge is `wbc<install>` (AC-07), computed here as computerd does —
`wbc` + the first 8 hex of sha256 of `/persist/whombat/home` (`wbc2d4e27ee`) — and also passed to computerd as
`WHOMBAT_COMPUTERS_BRIDGE`, so the two can't differ.

- **This host (input, `computers_to_host`):** from the bridge only DHCP (UDP 67) and DNS (TCP/UDP 53) to an address of
  the bridge itself (`fib daddr . iif type local`), i.e. the bridge's dnsmasq; everything else is rejected — every
  address of this host (LAN, public, the gateway), and a service the host's own firewall admits from the LAN. The NixOS
  firewall's input chain lists the same ports for the bridge (`networking.firewall.interfaces.<bridge>`), since its
  drop would otherwise win.
- **From this host (output, `computers_from_host`):** only DHCP answers, dnsmasq's address probes (ICMP echo) and
  established traffic; nothing on this host opens a connection to a computer (the runtime server and every other uid
  included).
- **Forwarding (`computers_forward`, policy drop):** Incus turns on IPv4 forwarding for its NAT, which would also make
  the box a router for its LAN. Only the computers' own connections are forwarded: from the bridge, not back into it,
  no IPv6, the Vault's home networks (the server's `vault4` set and conntrack mark, VT-12: exactly the listed network and
  TCP port pairs, closed again with their connections when unlisted; a private destination opens only there — the same
  list the runtime gives computerd as `homeNetworks`, so the two walls agree; where computerd's ACL opens a home network
  on every port, this wall still opens only the listed ports), then nothing non-public
  (`nonpublic4`: RFC 1918, CGNAT, link-local and metadata, loopback, documentation, multicast, …), nothing in
  `whombat.computers.deny` (`computers_deny4`), never TCP 25, and only TCP, UDP and ICMP; the answers back. Everything
  else forwarded is dropped (a LAN host routing to the computers' subnet through the box, the box as anyone's router).
- **Between computers (`bridge whombat-computers`):** frames from one port of the bridge to another are dropped
  (`meta ibrname`); without br_netfilter they never reach the inet hooks, and the per-NIC ACL turns its rejects into
  drops there anyway. Frames for the host (DHCP, DNS) are local, not forwarded.
- **Incus's own tables coexist.** Incus adds `table inet incus` (its bridge's NAT, its DHCP/DNS accepts, the ACL
  chains); `nftables.service` deletes only its own tables on reload (`flushRuleset` is off since stateVersion 23.11 with
  `networking.nftables.tables`), so Incus's survive. Incus's accepts don't override these drops (a packet must pass
  every base chain of its hook). The daemon's own traffic passes the output chain like any root process: HTTPS to the
  image server (443, every uid), DNS from dnsmasq to the resolver stub (loopback). The incus *client* in computerd also
  fetches the image server's index itself (443, allowed).
- **What the VM test proves** (`computers`): DHCP and DNS from dnsmasq; a public address on 80, 443, 8123 and ICMP; not
  TCP 25 (an HTTP server on 25 answers others); not a private, metadata or denied address; not this host's LAN
  addresses (a service its own firewall admits to the LAN included) or its address on the bridge; not another computer
  (from a computer or from the host); not a computer from outside through the box; a private address on a listed
  home-network port opens and closes again. Public reachability from a real box (no test network) is the DEV box's
  (stream 7).
- **Proved** (2026-10-02, KVM as the user): `checks.computers` **12/12 subtests** (61 s after provisioning) on this
  branch; `checks.computers-real-runtime` **5/5** with Whombat `c3babc97` (`agent-computer-runtime`, built with
  `--override-input whombat 'git+file:///home/me/Code/Whombat?ref=agent-computer-runtime&rev=c3babc97…'`): the real
  computerd under this unit is available, a session creates and starts a computer with its labels, nesting, its ACL on
  its NIC and the bridge it made (`wbc2d4e27ee`, NAT, no IPv6); a share under the runner's TMPDIR appears at the same
  path and a file the computer's uid 952 writes is 952:952 on the host; a path outside the roots is refused; the
  computer reaches a public address and its DNS, not a production address, a private one, TCP 25 or this host; stop
  and remove leave no instance and no ACL. Stopping the test image takes Incus's timeout (its busybox init ignores
  SIGPWR); a Debian computer stops at once. `appliance-toplevel`, `runner-sandbox`, `clients`, `browser-config` (which
  had failed since NX-128: a comment named the browser), `vault-wall-config` (now 7 `@vault` lines: the computers'
  one), `proxmox-config`, `licence`, `console`, `toolchain`, `runtime-pin`, `eval-aarch64` and `image-no-secrets` build.
  Not proved in a VM: a live turn with the runner's new TMPDIR (NX-133). `runtime-live-turn` with computers on passes the
  runner's start and its sandbox probe, then fails where it fails on main too (the test's world seeding: “Cannot
  determine intended module format because both '__dirname' and top-level await are present”, a Node/test defect
  unrelated to computers); the DEV box's live check (stream 7) covers a real turn.

## NX-132 The computers' gate and status (2026-10-02; Whombat AC-23; IN-155)

*Superseded by NX-455 (2026-10-25): no gate and no status file.*

Like the browser's (NX-95), a gate decides at every start whether Incus runs, and a status file says why not:
`/run/whombat-computerd/status.json`, `{"state":"starting"|"available"|"unavailable","reason":string|null}`, 0640
root:whombat-computers (the server and computerd read it; `WHOMBAT_COMPUTERS_STATUS_FILE`).

- **The gate** (`ExecCondition=` of `incus.service`, as root; exit 1 skips Incus, not a failure): user namespaces
  (“This Whombat’s kernel doesn’t allow user namespaces, which computers need.”), cgroup v2 (“This Whombat doesn’t run
  cgroup v2, which computers need.”), memory below `whombat.computers.minMemoryGiB` (default 8, with the browser's
  tenth of margin; “This Whombat has less than 8 GB of memory.”, unless `force`), and the storage mounts (“The
  computers’ storage isn’t ready on this Whombat.”). It writes `starting`; Incus ready and preseeded writes
  `available`; Incus's stop writes `unavailable` (“Computers are stopped on this Whombat.” after a clean stop,
  “Computers didn’t start on this Whombat; its log says why.” after a failure).
- **The runtime's side** (stream 2): computerd starts whatever the gate said (it only wants Incus) and answers
  `status`; when Incus doesn't answer, its reason should be the file's (`WHOMBAT_COMPUTERS_STATUS_FILE` is computerd's
  too). The server shows computerd's `status` as `HostInfo.computers` and, when computerd's socket doesn't answer, the
  file's state and reason.
- **Memory.** A computer may use up to `WHOMBAT_COMPUTERS_MEMORY_MB` (4 GiB) and is stopped after 30 idle minutes; an
  idle one uses little. 8 GiB boxes run them (the gate's minimum, as the browser's); **16 GiB is recommended** when
  agents use their computers (install.md). The containers' cgroups are Incus's (`lxc.payload.*`, outside the
  `whombat-*` slices): their caps are per computer; the critical slice's `MemoryMin` keeps protecting PostgreSQL and the
  server.

## NX-133 computerd's unit and what the runner and server get (2026-10-02; Whombat AC-02, AC-03, AC-04, AC-07; IN-155)

*Superseded by NX-455 and NX-456 (2026-10-25): computerd's uid 962 is the commands' network daemon's; the runner's TMPDIR stays (sandbox.nix).*

- **The program** is the runtime bundle's `bin/whombat-computerd` (`node app/computerd.mjs`, added to
  `nix/packages/runtime` when the bundle has `app/computerd.mjs`, as the browser host's), run from the runtime profile,
  `PartOf=whombat-runtime.target` (it moves with every runtime update), `WantedBy` it.
- **User and groups.** `whombat-computerd` (uid/gid 962), primary group of the process `whombat-computers` (gid 963,
  also the group of the server's and the runner's users), supplementary `incus-admin` (gid 964, the Incus socket's
  group; nobody else is in it). The socket `/run/whombat-computerd/computerd.sock` is made by computerd, 0660, so its
  group is whombat-computers; `/run/whombat-computerd` is 0750 whombat-computerd:whombat-computers (tmpfiles, kept
  across restarts, so the status stays).
- **Hardening.** `incus-admin` is root-equivalent (Incus mounts what it is told into a container); the unit keeps a
  mistake small, not a compromised computerd: `ProtectSystem=strict`, `PrivateTmp`, `PrivateDevices`, `NoNewPrivileges`,
  the kernel/clock/hostname/cgroup protections, `ProtectProc=invisible`, `ProcSubset=pid`, `RestrictNamespaces`,
  `@system-service` without `@privileged @resources`, and nothing of Whombat's own data in sight (`InaccessiblePaths`:
  `/persist/{secrets,identity,postgres,manager,backup}`, the server's home, the credentials, the runtime's, manager's,
  backup's, update helper's, Vault's, clients' and browser's `/run` directories). One capability:
  **`CAP_DAC_READ_SEARCH`**, because computerd resolves every path it shares (only under `WHOMBAT_COMPUTERS_ROOTS`,
  AC-04) and the runner's directories are 0700; it writes only its runtime directory and its state directory
  (`/var/lib/whombat-computerd`: `HOME` and `INCUS_CONF` of the incus client). Network: the client fetches the image
  server's index itself (HTTPS), so AF_INET/AF_INET6 (and AF_NETLINK for its own addresses), with every private,
  link-local, multicast and loopback address denied but the resolver stub.
- **Environment** (computerd): `WHOMBAT_COMPUTERD_SOCKET`, `WHOMBAT_HOME=/persist/whombat/home` (only hashed for the
  install id, AC-07; computerd can't read it), `WHOMBAT_COMPUTERS_INCUS=<incus-lts client>/bin/incus`,
  `WHOMBAT_COMPUTERS_POOL=default`, `WHOMBAT_COMPUTERS_BRIDGE=wbc<install>`, `WHOMBAT_COMPUTERS_ROOTS=
  /persist/whombat/workspaces:/var/lib/whombat-runner/tmp` (+ `extraRoots`), `WHOMBAT_COMPUTERS_UID/GID=952` (the
  runner's: the user `agent` owns shared files as the runner, AC-03), `WHOMBAT_COMPUTERS_{CPUS,MEMORY_MB,DISK_GB,
  IDLE_MINUTES}` (2, 4096, 40, 30) and `WHOMBAT_COMPUTERS_DENY` from the options, `WHOMBAT_COMPUTERS_STATUS_FILE`,
  `HOME`, `INCUS_CONF`.
- **The runner** gets `WHOMBAT_COMPUTERS=incus`, `WHOMBAT_COMPUTERD_SOCKET`, the group whombat-computers and
  **`TMPDIR=/var/lib/whombat-runner/tmp`** (0700 whombat-runner, emptied at every boot like a /tmp). Its temporary root
  (`<TMPDIR>/whombat-runner-952`: turn files, read-only exports, pack skills) is shared into computers at the same
  path (AC-03), which the private /tmp of `PrivateTmp=` is not: Incus would see another directory. On the root file
  system, where that /tmp was. Everything else stays (PrivateDevices, its slice, its walls).
- **The server** gets `WHOMBAT_COMPUTERS=incus`, `WHOMBAT_COMPUTERD_SOCKET`, `WHOMBAT_COMPUTERS_STATUS_FILE` and the
  group; nothing else changes.

## NX-134 Each Go package builds from the sources it imports (2026-10-02; UP-X14)

Every Go package was built from one source set holding all of the module's directories, so any commit changed every
Go binary's store path. A manager-only host release (`pve-dev-20261002.3`, MG-60) therefore also shipped a new
recovery tool, console, backup service and provisioning tool, and with them a new recovery UKI
(`whombat-recovery.efi`, 576 MB, already compressed): 49 new paths, 590 MB of blobs instead of a few MB.

Now `nix/packages/go.nix` gives each package `dirs`, the top-level directories its packages import (`go list -deps`;
plus `go.mod`, `go.sum` and `third_party/`, which holds the contracts' Go module): the update helper `helper`; the
manager `helper manager`; the release tools `helper manager release-tools`; backup `backup`; recovery
`backup recovery`; console and installer UI `console`; the Vault wall `vaultwall`; provisioning
`provisioning internal`. The vendored modules are built once from all directories (same `vendorHash`) and shared
through `goModules`. A change in `manager/` now changes only the manager's path (checked by evaluating the packages
before and after a manager-only edit). A new import from another top-level directory fails the build with Go's
“cannot find package”: add the directory to that package's `dirs`.

## NX-135 The runner has `gh` on its PATH (2026-10-03; Whombat AGH-03)

`providers.nix` said the GitHub CLI was “in the runtime closure”, but nothing put it on the runner's PATH: the runtime
package wraps its binaries with `gitMinimal` only, and the runner unit's `path` held bubblewrap, util-linux and socat.
The runner needs gh twice — people's GitHub sign-ins (Whombat PV-06, the sign-in executor's `gh auth login`/`gh auth
token`) and, since Whombat agent-gh.md, agents' `gh` commands, which the runner runs for them outside the task sandbox
with the token Whombat hands it for that one command (AGH-03). `pkgs.gh` joins `systemd.services.whombat-runner.path`.
It stays out of the tasks' toolchain: in a task an agent's `gh` is Whombat's stand-in, bound at `/usr/local/bin/gh`. A
host change (the runner unit), so a box gets it with its next host release.

## NX-136 Stale Incus pid files go before Incus starts, once per boot (2026-10-03; Whombat GF-07)

*Superseded by NX-455 (2026-10-25): no Incus.*

On the DEV box two host updates rolled back (`manager_recovery`, pve-dev-20261003.3 twice): 342 ms after the new
manager started it was killed with SIGKILL, 9 ms after Incus brought up an agent computer's bridge, and its OnFailure
recovery put the previous host back. Incus keeps its subprocesses' pids on `/persist/incus` (`networks/<bridge>/
dnsmasq.pid`, `forkdns.pid`, proxy devices under `devices/`) and, starting, kills the pid in such a file to start that
subprocess again. After a reboot the pid is whoever has it now: here a thread of the manager (manager pid 1115; the
file still held the last boot's dnsmasq, 1130), and a kill on a thread id kills the whole process. Which process it hits
is chance, so any appliance with agents' computers could roll back a host update, or lose another service, after any
reboot.

`whombat-computers-storage` (oneshot, once per boot, before Incus) now deletes every `*.pid` under `networks/` and
`devices/` of Incus' state before binding it on `/var/lib/incus`: nothing Incus started can be running yet. A daemon
restart without a reboot keeps them (KillMode=process keeps dnsmasq running, and Incus needs its pid then). A host
change: a box gets it with its next host release, and that release's own boot is already protected.

## NX-137 The computers reach this Whombat's own networks (2026-10-03; Whombat RA-41, RA-DN01, RA-DN02)

*Superseded by NX-455 and NX-460 (2026-10-25): `computerslan/` is gone; the local network (NX-144) or the Vault's home networks open private addresses.*

John: “LAN by default is fine.” A burrow setting (`agentsReachLan`, on by default) lets computerd add allow rules for
the appliance's own IPv4 networks to each computer's ACL (the inner wall, per burrow; Whombat stream K). The appliance's
forward rule (NX-131, the outer wall) must allow the same networks for every burrow, so it lets them through and
computerd's ACL decides.

- **The set.** `inet whombat-egress` gains `computers_lan4` (`ipv4_addr`, interval), empty in the ruleset. It holds
  the networks of the interfaces that carry an IPv4 default route in the main table (every next hop of a multipath
  route): of each IPv4 address there with universe or site scope and a prefix of at least /8, the network of
  `IFA_ADDRESS` (on a point-to-point link the peer's, which is what that link reaches), minus what is never a LAN
  (`0.0.0.0/8`, loopback, link-local `169.254.0.0/16` — cloud metadata lives there — and everything from `224.0.0.0/3`)
  and minus every IPv4 address of this host (any interface, the computers' bridge included). A /32 from a cloud
  provider therefore gives nothing, a /31 the other end, a /24 at home the /24 without the box. Elements are written
  as ranges (`192.168.1.0/31, 192.168.1.3-192.168.1.255`). The Vault's home networks stay what they were (extra
  networks with their ports, VT-12); production servers stay closed by computerd's ACL (AC-11), which the appliance
  can't know.
- **The rule.** `computers_out` is now: established, not between computers, no IPv6, the Vault's home networks, the
  deny list (`whombat.computers.deny`), **TCP 25 reset**, then `ip daddr @computers_lan4 meta l4proto { tcp, udp, icmp }
  counter accept` (“computers: this Whombat's networks”), then everything else non-public refused, then the public
  internet. The deny list and SMTP moved up so that neither can be opened by the LAN rule; for a private destination
  outside the set nothing changes except that port 25 there is now a TCP reset instead of “admin prohibited”. The
  appliance's own addresses are never reached this way anyway: a packet for them is local and `computers_to_host`
  refuses it (unchanged). Broadcast and multicast aren't forwarded (no directed broadcast, no multicast routing).
- **Who keeps it: `whombat-computers-lan`** (new Go program, `computerslan/`, package `whombat-computers-lan`; RA-DN01).
  It reads the default routes and addresses from the kernel (rtnetlink dumps, no privilege needed), computes the
  set, and replaces its elements in one `nft -f` transaction (`flush set` + `add element`), like whombat-vault-wall
  (NX-40): on every rtnetlink announcement of an IPv4 address or route (coalesced: it waits a second for the rest of
  a DHCP lease), on SIGHUP (`ReloadPropagatedFrom=nftables.service`: a reload replaces the table and empties the set),
  and every 60 s whatever happened (repairs a set emptied by something else and covers a lost announcement). It
  applies only what changed (forced on reload and resync) and logs one line per change (“the computers may reach
  192.168.1.0/31, 192.168.1.3-192.168.1.255 (192.168.1.0/24 on enp1s0; not this Whombat's own addresses)”, also its
  systemd STATUS). Fail closed: a kernel it can't read or a failed transaction empties the set; the unit's
  `ExecStopPost` empties it (`--flush`); `--print` shows what this host gives without applying it. The unit
  `whombat-computers-lan.service`: wanted by multi-user.target whenever `whombat.computers.enable` (cheap, and the set
  is ready before the first computer), `Requires`/`PartOf` nftables.service, `Type=notify`, `Restart=always`, a dynamic
  user with `CAP_NET_ADMIN` only, the host's network namespace, `AF_NETLINK`/`AF_UNIX`, `IPAddressDeny=any` and the
  vault wall's other protections. Why a daemon and not a timer: the set follows a new lease within a second, a reload
  within milliseconds, and the code is unit-tested (range arithmetic, rtnetlink parsing of synthetic messages, the
  sync loop) and tested against a real kernel and nft (dummy links, addresses and a default route in a user and network
  namespace, skipped where a build sandbox has none; CI's `check.sh` now also requires `ip`).
- **computerd's side** (stream K, its own rules, refreshed every minute): it computes the same networks itself. On
  the appliance computerd runs with `ProcSubset=pid` (NX-133): `/proc/net/route` doesn't exist for it,
  `/proc/self/net/route` does. Where the two computations differ the stricter wins (a packet passes both walls).
- **Checked** (2026-10-03, quick checks only, IN-132): `go vet` and `go test -race` of `computerslan/...` (with the
  namespace test against the real kernel and nft 1.1.7); `checks.computers-config` (new: the unit, the rule order,
  the set), `browser-config`, `vault-wall-config`; the appliance's nftables ruleset builds with NixOS's `nft --check`;
  and, by hand, the generated ruleset loaded into a real kernel in three namespaces (a computer behind `wbc2d4e27ee`,
  the appliance, a LAN host) with the real daemon: no default route → the LAN host refused; a default route via the
  LAN card → the set filled within a second, the LAN host's port 8123 reached, its port 25 and the appliance's own LAN
  address refused; the route deleted → the set emptied and the LAN host refused; the set flushed by hand → restored on
  SIGHUP; `--flush` empties it (the two `fib` matches replaced, as this kernel has no `nft_fib` for a user namespace).
  `vm-tests/computers.nix` gains the subtest (a default route on eth1 opens 192.168.1.1:8123, not port 25, this host or
  169.254.169.254; it closes with the route; stopping the unit empties the set): evaluated and linted, not run.

## NX-138 Ports agents publish: from private networks only (2026-10-03; Whombat RA-43, RA-DN03)

*Amended by NX-461 (2026-10-25): the ports are the agent's containers' (OP-19), the same rule.*

`whombat publish <port>` on a computer makes computerd add an Incus proxy device
`listen=tcp:0.0.0.0:<host port> connect=tcp:127.0.0.1:<port>` (forkproxy, not NAT: incusd's helper listens on this
host and connects inside the computer's own network namespace, so nothing crosses the bridge). The host ports are
**`whombat.computers.publishPorts`** (`from` 20000, `to` 20099; 1024 ≤ from ≤ to < 32768 — below the kernel's ephemeral
range, where a listener could take the port of an outgoing connection — and at most 1000 ports; assertions say so),
computerd's `WHOMBAT_COMPUTERS_PUBLISH_PORTS=20000-20099`.

- **The NixOS firewall** admits new TCP connections to the range from private sources only
  (`networking.firewall.extraInputRules`: `ip saddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12,
  192.168.0.0/16 }` and `ip6 saddr { fc00::/7, fe80::/10 }`, should a listener ever take IPv6). Everything else stays
  dropped by its input policy (the appliance has no other inbound port, NX-22).
- **The guard** (`computers_input`, input priority filter − 1, before the NixOS firewall): `tcp dport 20000-20099 ct
  state new jump computers_published`, which rejects anything arriving on `lo` (“published ports: not from this host”:
  nothing on this host opens a connection to a computer, NX-131 — the runtime server included, also through the
  LAN address, which is local too), returns private sources and drops the rest (“published ports: private
  networks only”). So the range is closed to the internet even if another rule ever opened it, and only new
  connections are judged (replies of the host's own connections are never affected). From a computer the input wall
  refuses it first (`computers_to_host`): a computer can't open a published URL, its own included — it checks
  `http://127.0.0.1:<port>` inside; people open `http://<LAN address>:<host port>`.
- **Checked:** `checks.computers-config` (the guard's order, the firewall's sources, other ports with another
  `publishPorts`, the limits); by hand in the three namespaces above with a listener on 20000 and 20100: the LAN host
  from 192.168.7.1 reached 20000; from a public source (1.2.3.4 → 1.2.3.5) dropped, counted; 20100 (outside) dropped;
  the appliance itself to 127.0.0.1:20000 and to its LAN address refused, counted; the computer to the appliance's
  20000 refused. The VM test's new subtest does the same with a real proxy device on a test computer: evaluated and
  linted, not run.

## NX-139 A computer's memory by the machine's memory; computerd's per-agent sockets (2026-10-03; Whombat RA-45, RA-47, RA-DN04, RA-DN05)

*Superseded by NX-455 (2026-10-25): no computers.*

- **Memory (RA-45, RA-DN04).** `whombat.computers.memoryMB` is now `null` by default: by the machine's memory,
  min(4096, a quarter of it) and at least 512 MiB, with the memory counted in **whole GiB, MemTotal rounded up**
  (firmware and the kernel keep a few percent of what is installed, so 8 GiB show as about 7.7): 2048 on 8 GiB, 3072 on
  12 GiB, 4096 from 16 GiB, 768 in a 3 GiB VM. `whombat-computers-memory.service` (root oneshot, `WantedBy=` and
  `Before=` computerd, once per boot) writes `WHOMBAT_COMPUTERS_MEMORY_MB=<n>` to `/run/whombat-computerd/memory.env`
  (0644, temp file and rename), computerd's `EnvironmentFile=-…` (read when computerd starts; without the file
  computerd starts anyway and sizes computers itself, RA-45's fallback in computerd). A number in `memoryMB` keeps the
  old way: a fixed variable, no oneshot, no file. The gate's 8 GiB minimum (NX-132) is unchanged; install.md's
  requirements say what a computer gets. Checked: `checks.computers-config` runs the script against eight fake
  `/proc/meminfo` files (and one without MemTotal, which fails and writes nothing).
- **Per-agent sockets (RA-47, RA-DN05).** `/run/whombat-computerd/agents`, **0700 whombat-computerd:whombat-computerd**
  (tmpfiles, inside computerd's runtime directory and its `ReadWritePaths`): computerd listens on
  `<instance>.sock` there, and each computer's `bind=instance` proxy device connects to it. incusd and its forkproxy
  run as root (no `security.uid`/`security.gid` on those devices), so they connect whatever the mode; the server and
  the runner (group whombat-computers, which may traverse `/run/whombat-computerd`) can't: a socket there speaks for
  one agent's computer.
- **A host change.** All three decisions (NX-137…NX-139) reach a box with its next host release (`release/ship all
  <id>` with candidate 0.39.0); a box without computerd in its runtime runs only the LAN daemon (a few MB, harmless)
  and the firewall rules, with nothing listening on the published range.
- **Whombat's rows** (stream N's implementation decisions for Whombat `docs/decisions/resourceful-agents.md`, recorded
  there by the lead):

| ID | Decision | Why |
| --- | --- | --- |
| RA-DN01 | **The appliance's LAN set is kept by a daemon**: `whombat-computers-lan` (appliance `computerslan/`) fills `inet whombat-egress` `computers_lan4` from rtnetlink — the main table's IPv4 default routes (every next hop), their interfaces' universe- or site-scope addresses with a prefix of at least /8, the network of each — minus `0.0.0.0/8`, loopback, link-local `169.254.0.0/16` and `224.0.0.0/3`, minus every address of the host; again on every address or route announcement, on an nftables reload and every 60 s; empty on any failure and when stopped. NX-137. | The set follows a DHCP lease within a second; link-local (cloud metadata) is never a LAN; fail closed. |
| RA-DN02 | **The forward rule's order**: the Vault's home networks, the deny list, TCP 25 reset, this Whombat's networks (TCP, UDP, ICMP), everything else non-public refused, the public internet. NX-137. | Neither the deny list nor port 25 can be opened by the LAN rule. |
| RA-DN03 | **Published ports from private networks only**: host ports `whombat.computers.publishPorts` 20000–20099 (`WHOMBAT_COMPUTERS_PUBLISH_PORTS`); new TCP connections from RFC 1918, CGNAT and link-local (ULA, IPv6 link-local) sources are admitted, all others dropped; from this host (`lo`, its LAN address included) rejected, from a computer rejected by the input wall: a computer checks its service at `http://127.0.0.1:<port>`. NX-138. | “Private networks only (never the internet)”; the host and the computers stay apart as before (NX-131). |
| RA-DN04 | **Memory in whole GiB**: `WHOMBAT_COMPUTERS_MEMORY_MB` = min(4096, MemTotal rounded up to whole GiB × 1024 / 4), at least 512, written at boot by `whombat-computers-memory` to `/run/whombat-computerd/memory.env`, computerd's `EnvironmentFile` (without it computerd sizes computers itself). NX-139. | MemTotal is a few percent below what is installed; rounding up gives RA-45's 2 GiB on 8 GiB and 4 GiB from 16 GiB. |
| RA-DN05 | **computerd's per-agent sockets** are in `/run/whombat-computerd/agents`, 0700 whombat-computerd (tmpfiles); incusd and its forkproxy connect as root (no `security.uid`/`security.gid` on those proxy devices); the server and the runner can't. NX-139. | A socket there speaks for one agent's computer. |

## NX-140 A turn may run eight hours (2026-10-03; Whombat RA-14)

- **`whombat.sandbox.limits.wallMinutes` defaults to 480** (was 120), so `WHOMBAT_SANDBOX_WALL_MINUTES` on the appliance
  matches the runner's and the server's default since Whombat RA-14 (no round-trip cap; long deploys, builds and runs end
  at their wall time or lease, not halfway). Memory, pids and output limits are unchanged. A host change: it reaches a box
  with its next host release.

## NX-141 One memory pool for the computers (2026-10-05; Whombat MP-01; supersedes NX-139's rule, RA-DN04)

*Superseded by NX-455 (2026-10-25): no computers; the containers share the tasks' slice (NX-457).*

- **`whombat-computers-memory`** writes the pool, not a slice: the machine's memory in whole GiB (MemTotal rounded up,
  as NX-139) less a reserve for Whombat of a quarter of it, at least 3 GiB and at most 8 GiB; at least 512 MiB. 5120 on
  8 GiB, 9216 on 12, 12288 on 16, 15360 on 20, 24576 on 32, 57344 on 64, 122880 on 128, 1024 in a 4 GiB VM, 512 at
  3 GiB and below. Every computer gets it as `limits.memory`: a cap per computer, not a reservation; they share it.
  Whombat's `computerMemoryMb` (`@whombat/computer`, computerd without the variable) is the same rule:
  `max(512, gib × 1024 − min(8192, max(3072, gib × 256)))`, gib = ⌈MiB / 1024⌉. `memoryMB` still fixes a size.
- Checked: `checks.computers-config` runs the script against twelve fake `/proc/meminfo` files (the table above, 7.6
  and 15.6 GiB MemTotal among them) and one without MemTotal.
- A host change (the reboot of a host release). computerd applies a new size to a stopped computer at its next start.

## NX-142 Whombat comes first when memory runs out (2026-10-05; Whombat MP-02, MP-D02…MP-D04; amends NX-19, NX-96, NX-133)

*Amended by NX-456 and NX-457 (2026-10-25): incusd and computerd leave the core; the commands' network daemon joins it; the containers' processes are at 500.*

The computers may together ask for more than the box has (NX-141). When the kernel must kill, it picks the highest
`oom_score_adj` first (points = resident memory + adj × total memory / 1000, so 500 on 8 GiB adds 4 GiB):

| Who | `oom_score_adj` | Where |
| --- | --- | --- |
| Every process in a computer (containers, `incus exec`, Docker in them) | 500 | the default Incus profile's `raw.lxc` `lxc.proc.oom_score_adj = 500` (preseed), and computerd's own on each computer (MP-D02) |
| The browser host and Chromium | 500 | unchanged (NX-95) |
| Other host services (journald, networkd, the backup API, …) | their own (mostly 0) | unchanged |
| The provider CLIs of a turn (their tools and MCP servers) | -500 | raised by the runner itself when it starts them (MP-D04) |
| PostgreSQL, the server, the runner, the manager (and its recovery), the update helper, computerd, Incus | -900 | `OOMScoreAdjust=` |

- **Core units, `MemoryMin`** (whombat-critical.slice, knobs `whombat.slices.critical.units`, MiB): PostgreSQL 320
  (shared_buffers 256 MB and a few backends), whombat-server 384 (about 310 MB resident idle on the dev stack at
  `b3b36891`, peak 530), whombat-manager 48 (38 MB there), computerd 128 and Incus 128 (estimates: incusd with a few
  containers about 100 MB — 205 MB on this machine's Incus with three instances, VMs among them; computerd a small Node
  service). **1008 MiB together**, a third of the smallest reserve (3 GiB on 8 GiB); the rest of the reserve is for the
  runner and its CLIs, the browser (capped at 1536 MiB), the kernel and the other services. `MemoryMin` keeps their
  memory from being reclaimed for the computers; it doesn't stop the OOM killer, the scores do.
- **whombat.slice carries the protection too** (`MemoryMin`/`MemoryLow` = the critical slice's = the sum of the units,
  or `whombat.slices.critical.memoryMin` when set, as the small VM tests do). A cgroup's `memory.min` counts only up to
  its parent's (cgroup v2; systemd.resource-control), and whombat.slice had none: NX-19's `MemoryMin=1G` on the critical
  slice protected nothing until now. The tasks and browser slices get none of it.
- **Incus and computerd move into whombat-critical.slice** (CPU and IO weight 1000 with the rest of the core). The
  computers' cgroups are Incus's own, `lxc.payload.<name>` at the root of the hierarchy (seen on this machine's Incus),
  not under incus.service: the slice, the `MemoryMin` and the -900 are incusd's, forkproxy's and the monitors'.
- **The runner at -900** (was 500; Whombat MP-D04): it is core. The CLIs it starts would inherit -900; the runner raises
  them to -500 (raising needs no privilege, lowering below the unit's value is refused). Without computers (the gate off,
  below 8 GiB) the sandboxed task commands run under the runner too: Whombat's runner decides their score (MP-D04).
- **Why the default profile, not only computerd:** containers and every `incus exec` are forked by incusd and would
  inherit its -900. Checked on this machine's Incus (6.0.4, a throwaway Alpine container, then deleted):
  `raw.lxc: lxc.proc.oom_score_adj = 500` (on the instance, and again from a profile) gives the container's init 500
  and an `incus exec` process 500 (LXC's attach applies it), and that process can't lower it (`echo 100 >
  /proc/self/oom_score_adj`: permission denied — LXC writes the value as host root, which sets the floor). The
  preseed merges the key into the existing default profile at every Incus start; computerd starts computers without a
  profile of their own (the default one), and its instance key (MP-D02) has the same value.
- **The first boot after this release:** Incus starts kept-awake computers (`boot.autostart`, RA-44) before it answers,
  so before the preseed can add the key; they would run, and get every `incus exec`, at -900 until their next start.
  `incus-oom-check` (incus.service `ExecStartPost=-`, after the preseed) restarts each running computer whose init's
  `oom_score_adj` isn't 500 — only while the machine is booting (`systemctl is-system-running` initializing/starting),
  seconds after Incus started it; a later daemon restart leaves running computers alone. From the second boot the
  profile has the key before autostart.
- Docker in a computer (`docker.service` OOMScoreAdjust=-500, containerd -999) can't lower its score, and doesn't need
  to: checked on this machine's Incus with a throwaway computer from base image 5 (`raw.lxc` as above, nesting, the
  syscall intercepts, then deleted), init, dockerd and containerd at 500 and active, `docker run hello-world` works and
  a container's process is at 500. Whombat's image 8 (MP-03) starts Docker on demand.
- Checked: `checks.computers-config` asserts the five units' slice, `MemoryMin` and -900, both slices' 1008M, the
  runner's -900 in the tasks slice, the helper's -900, the browser's 500, the check after the preseed and never fatal,
  and the preseed's `raw.lxc`; `checks.appliance-toplevel` builds. No VM test run (IN-132: DEV fast). A host change: it
  reaches a box with its next host release (a reboot, so every computer starts with 500).
- **Whombat's rows** (Whombat `docs/decisions/memory-pool.md`):

| ID | Decision | Why |
| --- | --- | --- |
| MP-DN01 | **The pool on the host**: `whombat-computers-memory` writes MemTotal in whole GiB (rounded up) less a reserve of a quarter clamped to [3 GiB, 8 GiB], at least 512 MiB; the same table as `computerMemoryMb`. NX-141. | One rule, written twice, tested against one table. |
| MP-DN02 | **Core units**: PostgreSQL, whombat-server, whombat-runner, whombat-manager (+ recovery), the update helper, computerd and incusd get `OOMScoreAdjust=-900`; all but the runner and the helper run in whombat-critical.slice with `MemoryMin` 320/384/48/128/128 MiB (1008 MiB), carried by whombat.slice too. NX-142. | Whombat itself is never the OOM killer's choice, and its memory isn't reclaimed for the computers. |
| MP-DN03 | **Every computer process at 500 from the host**: the default Incus profile's `raw.lxc` `lxc.proc.oom_score_adj = 500`, and on the first boot with it the kept-awake computers Incus started early are restarted. NX-142. | incusd's -900 would otherwise reach the containers and `incus exec`, whatever computerd's version. |

## NX-143 The DEV image has the Incus agent: a root shell from the host that runs it (2026-10-07; amends NX-120)

John, 2026-10-07: “give this session or the titan access to the developer appliance so we can check logs and actually
do something and see what's happening on the box itself”. Until now nothing could: no SSH or sudo (NX-10), no getty on
the serial port, no `incus exec` (no agent in the image), and the DEV Whombat (`whombat-dev-box`, John's box
`wb-k2rt-8pwn-5521` since IN-189) sits on a macvlan NIC on `enp174s0`, which its host can't reach. Reading its journal
meant a ZFS snapshot clone of the stopped disk (2026-10-04).

- **What:** `nix/profiles/dev-instance.nix` sets `virtualisation.incus.agent.enable` (nixpkgs' loader: a udev rule
  starts `incus-agent.service` when Incus's virtio port `org.linuxcontainers.incus` appears, its setup mounts the
  config drive Incus attaches to every VM (9p, tag `config`) and runs the agent Incus put there). Whoever runs Incus on
  the host gets `incus exec`/`incus file` as root in the box, and `incus list` shows its addresses again.
- **Who can reach it:** the host's Incus only, over vsock (the VM's `vhost-vsock-pci`). No TCP port, nothing in the
  firewall changes (NX-22 stands), nothing on the LAN or the internet. On The Titan that is the people and sessions
  in `incus-admin`, who could already read the box's disk.
- **DEV only:** never in `prod-instance.nix`; `base.nix` asserts it off whenever `whombat.environment == "prod"` and
  `checks.proxmox-config` asserts the DEV image has it, the hardware image doesn't, and a prod build with it fails. On
  Proxmox or hardware the port never appears, so the unit never starts. NX-10's promise (nobody logs in to a customer's
  appliance) is untouched: every box claimed on dev.whombat.com is ours.
- **The twin (amends NX-120, UP-C1):** a PROD build and its DEV twin now differ by two host units, the serial
  console's and the agent; their runtime and manager store paths stay equal, which is what the twin proves.
- **The tool:** `dev/devbox shell [-- cmd]`, `logs [unit…] [-f] [-n N] [--since T]` (`manager` means
  `whombat-manager`), `diag [--out dir]` (units and failures, the Whombat units' journal for 2 h, warnings for 24 h,
  boots, memory/disk/pressure, the box's computers, its network: state, not conversations; kept under
  `~/.local/state/whombat-devbox/diag/`), `port <port> [path]` (GET from inside the box, plus the LAN URL). They act on
  the VM `whombat-dev-box` whatever Whombat is in it, so they work on John's box, which the rest of `dev/devbox` doesn't
  know (no `state.json` owner).
- **PATH:** `incus exec` hands the command Incus's default PATH (`/usr/bin`, `/bin`: only `env` and `sh` on NixOS).
  The VM gets `environment.PATH=/run/wrappers/bin:/run/current-system/sw/bin` (`dev/devbox create` sets it; John's box
  set by hand 2026-10-07) and the tool passes the same with `--env`.
- **Changes made inside don't last:** NixOS rebuilds `/etc` and the units at every activation, and the next release
  replaces the system. The shell is for looking and trying; what should stay goes into a release.
- **Not chosen:** SSH on vsock (the same reach plus a key to keep, worth it only for a DEV box outside Incus); a host
  macvlan shim so The Titan reaches the box's LAN address (it needs this machine's LAN address or a second one on a
  sibling interface of `enp174s0`, whose ARP answers could disturb the NIC the tunnel connector for dev and production
  uses; `dev/devbox port` from inside plus the LAN URL from any other machine covers the need). The deploy and RA
  checks' `10.62.52.1` defaults still assume the old `incusbr0` box; they apply to a tool-made box only.
- Checked: `checks.proxmox-config`; the DEV image's `systemd.services.incus-agent` evaluates on, the prod Proxmox
  image's `virtualisation.incus.agent.enable` off; harness `pnpm check`. Reaches a box with its next DEV host release:
  John's box with `pve-dev-20261007.1` (IN-222), agent answering 586 s after the rollout started, manager Healthy on
  it, `dev/devbox logs|shell|diag|port` checked there.

## NX-144 The local network open by default (2026-10-08; Whombat local-network.md LN-01…LN-08; amends NX-40, NX-97, NX-131, NX-137)

*Amended by NX-460 (2026-10-25): what the computers got, the agent's commands (through their proxy) and containers get.*

John: Whombat appliances and agents reach the local network by default (adding Home Assistant at `10.100.0.x:8123` asked
for a home network first). The egress table gets `local4` (10.0.0.0/8, 100.64.0.0/10, 172.16.0.0/12, 192.168.0.0/16) and
`local6` (fc00::/7), filled at build time from the new option `whombat.network.localNetwork` (default true; empty sets
when false), and three accepts, each with the metadata address inside them left out (`100.100.100.200`,
`fd00:ec2::254`):

- the runtime server's uid: TCP and UDP to the local network, any port, before the Vault's rules (so those connections
  carry no Vault mark);
- the browser host's uid: TCP to the local network, before its `nonpublic` rejects;
- the computers' forward chain: TCP, UDP and ICMP to the local network, after the deny list and the SMTP reset, next to
  `computers_lan4`.

The burrow's switch (“Agents may reach your local network”, on by default) decides inside: the server's destination
rules, computerd's per-computer ACLs and the runner's guard. Every other uid, loopback, link-local, metadata and the
reserved ranges stay as before; whombat-vault-wall, its file and `vault4`/`vault6` are unchanged and still open the
listed networks when an owner switched the local network off. The VM tests of the closed wall (vault-wall,
browser-real, computers, computers-real) set `localNetwork = false` and check what they checked; the open default is
not covered by a VM test yet (DEV: no VM tests, IN-132).

## NX-145 The server may open netlink sockets (2026-10-08; Whombat connections-setup.md CS-14; amends the server's unit)

John's box, Settings → Connections: “Couldn’t look at your network just now. Scan again in a moment.” every time. The
server's `connections.discover` reads this machine's interfaces with Node's `os.networkInterfaces()` (the networks to
look in, its own addresses never scanned), which asks the kernel over a netlink socket; `whombat-server` allowed only
`AF_UNIX AF_INET AF_INET6`, so `uv_interface_addresses` failed with errno 97 (EAFNOSUPPORT) and every scan answered
500. The Tailscale listener's own-address check (`localAddresses()`) calls the same function and would have failed the
same way. `/proc/net` is no way round it: the server has `ProcSubset=pid`.

`whombat-server` gets `AF_NETLINK` next to the three it had, as the runner, computerd, the browser host and the
manager's helper already have for the same call. Netlink without `CAP_NET_ADMIN` (the server has no capabilities)
reads addresses and routes and changes nothing. The flake check `runner-sandbox` asserts it. A host release.

## NX-146 Swap in RAM: zram, and nothing capped may use it (2026-10-10; DEV box health check; amends NX-19, NX-96, NX-142)

*Amended by NX-457 (2026-10-25): the containers, not the computers, have no swap.*

John's DEV box (16 GiB, 4 vCPU, kernel 6.18.53, systemd 260.4) had no swap, and systemd-oomd said so at every boot
(“No swap; memory pressure usage will be degraded”). Cold memory (idle Node heaps, an idle kiosk) had nowhere to go
but RAM, and under pressure the kernel could only drop file cache.

- **What** (`whombat.slices.swap`, on by default, slices.nix): nixpkgs' `zramSwap` (zram-generator 1.2.1), one
  `/dev/zram0` of `min(25 / 100 * ram, 4096)` MiB of MemTotal, zstd, priority 5: about 1.9 GiB on 8 GiB, 3.9 GiB on
  John's 16 GiB, 4 GiB from 16 GiB of MemTotal up. The size is uncompressed: zstd keeps anonymous memory at about 3:1,
  so a full device holds about 1.3 GiB of RAM. **Never a disk**: no writeback device, no swap partition or file, so no
  memory content reaches storage (NX-16).
- **Kernel:** the image's kernel (nixpkgs' default, 6.18) has `CONFIG_ZRAM=m` with the zstd backend built in and zstd
  as its default; the module is in the system's module tree, and zram-generator loads it (nixpkgs patches its modprobe
  path) and swaps on before `swap.target`. The initrd needs nothing (no swap before the switch to the root).
  zswap is built in and off by default (`CONFIG_ZSWAP_DEFAULT_ON` unset); `zswap.enabled=0` keeps it off whatever a
  later kernel defaults to: in front of zram it would compress every page twice.
- **`vm.swappiness = 180`, `vm.page-cluster = 0`** (mkDefault). The kernel weighs reclaim as anon : file =
  (200 − swappiness) : swappiness, and its sysctl documentation advises values above 100 for in-memory swap. A zram
  fault is a decompression at RAM speed (microseconds); a dropped file page is re-read from the disk (about 100 µs on
  NVMe behind virtio, more on Proxmox storage), 10–20 times dearer, which gives 180–190; 180 is the value Pop!_OS and
  the Arch wiki's zram tuning use. So cold anonymous pages compress before file cache (PostgreSQL's tables, the Nix
  store's code pages) is dropped. `page-cluster` 0 reads one page per swap-in: readahead (8 pages by default) pays on
  seeking disks and would only decompress pages nobody asked for. Watermarks stay the kernel's.
- **Who may swap.** A page in zram is charged to no cgroup (zram's pool is the kernel's; zswap's would be the
  cgroup's): a cgroup that swaps out frees its charge, so it can pass its `memory.max` by what it put into zram, and
  that comes out of Whombat's reserve (MemTotal − the pool, NX-141). So nothing with a cap swaps:
  - **whombat-tasks.slice** (the runner and every sandboxed task): `MemorySwapMax=0`, there since NX-19 and without
    effect until now; kept. Its tasks' memory pressure, which oomd watches (80 % for 30 s), is the RAM's alone.
  - **whombat-browser.slice**: `MemorySwapMax=0` (NX-96), kept.
  - **The computers**: their cgroups are Incus's `lxc.payload.<name>` at the root (NX-142), out of reach of any slice.
    Incus 7.0.1 writes `memory.swap.max = 0` for every container with `limits.memory`, whether `limits.memory.swap` is
    `true` (its default) or `false`; only a byte size gives swap (`driver_lxc.go`, start and live update). Seen in
    John's box's `/run/incus/<computer>/lxc.conf`: `lxc.cgroup2.memory.swap.max = 0` next to the 12 GiB `memory.max`.
    The default profile now says `limits.memory.swap: false` too (the preseed), so a later Incus that gives `true` swap
    can't hand the computers any. On cgroup v2 `false` also asks for swappiness 0, which Incus skips there. A computer
    already running when the first boot's preseed adds the key gets it as a live update (`swap.max` stays 0).
  - Everything else may page its cold memory out: whombat-critical's units above their `MemoryMin` (`memory.min`
    protects anonymous and file pages alike, swap included, up to the 1008 MiB of NX-142), system services, the
    console's kiosk. The critical slice gets no `MemorySwapMax`: its cold heap is better in zram than its file cache
    on the disk.
- **oomd unchanged.** No `ManagedOOMSwap=` anywhere: it kills the cgroup with the most swap, and with the computers and
  the tasks holding none that would be one of Whombat's own services, against NX-142's order. `enableRootSlice` stays
  false. systemd-oomd is `After=swap.target`, so it starts with swap and its warning goes. The kernel's OOM killer
  picks as before: a computer (500) first; its swap is 0, so its badness is its resident memory.
- **MemTotal is unchanged by zram** (only MemFree and MemAvailable move): `whombat-computers-memory` (NX-141), the
  computers' gate (NX-132) and the browser's (NX-95) compute what they did; `incus-oom-check` reads only
  `oom_score_adj`. Inside a computer lxcfs shows its swap as 0.
- **Platform-neutral:** a block device in RAM; the same on hardware, Proxmox and Incus VMs, nothing in the hypervisor.
- Checked: `checks.computers-config` (the zram settings and the generator's size expression, the sysctls, the zswap
  parameter, the slices' `MemorySwapMax`, oomd, the preseed's key, `CONFIG_ZRAM` and its zstd backend in the image's
  kernel config and `zram.ko` in its module tree, and nothing of it with the option off); `checks.appliance-toplevel`
  and the DEV Proxmox system build. No VM test (IN-132). A host release; zram-generator runs at boot, so it takes the
  release's reboot. Not seen on a box yet.

## NX-147 The graphical console sleeps on a claimed box (2026-10-10; DEV box health check; CG-36; amends NX-82, NX-83)

On John's claimed box `whombat-kiosk` held about 630 MB around the clock: the kiosk's session scope had 668 MB charged,
151 MB anonymous, 53 MB shmem (Chromium's profile on tmpfs) and 500 MB file cache; Chromium's twelve processes about
355 MB PSS (950 MB RSS summed), cage 13 MB PSS. Nobody looks at a claimed box's screen most of the time.

- **What** (`whombat.console.sleepAfterSec`, 600; `whombat.kiosk.sleepAfterSec`, null by default: the installer never
  sleeps): once the box is claimed and nobody has used the console for 10 minutes, Chromium stops and its profile goes;
  cage keeps running without a window, so the screen is black (a pointer shows while the mouse moves). The next key
  press, pointer movement, button, scroll or touch starts Chromium again: the page is back in the 2–4 s Chromium takes
  to start with software rendering. **Blank, not the text console or a “Press any key” screen:** the lightest, the best
  for burn-in (CG-09), and the wake needs no device access of its own.
- **Idle input is cage's own.** cage 0.3.0 creates wlroots' `ext-idle-notify-v1` notifier and reports activity for
  every key, modifier, pointer motion, button, scroll and touch event, with or without a window (`seat.c`). swayidle
  1.9.0 runs inside cage (`swayidle -C /dev/null timeout 600 "kill -USR1 <loop>" resume "kill -USR2 <loop>"`) and
  talks to logind only for its sleep or lock hooks (none here), so it needs nothing but cage's Wayland socket. An idle
  inhibitor in the page (video, a wake lock) would keep the console awake; the page holds none.
- **Claimed, from the console server's API.** The kiosk can't read the console file (NX-78), so the browser loop asks
  `GET /api/state` with the page's own token every 10 s (curl reads the header from stdin, so the token is on no new
  command line). It sleeps when idle and `claim.state` has been `claimed` in 12 polls in a row: 2 minutes, so the
  celebration and the claimed screen still show when a box is claimed from the app while nobody touches the console.
  **Never while unclaimed** (starting, waiting, claimable, backoff); a sleeping console whose box stops being claimed
  (released, factory reset) shows again within 10 s. No answer from the API: no sleep, and a sleeping console stays
  asleep (a restarted server restarts the kiosk, which is then awake).
- **Why cage stays:** 13 MB keeps the logind session, the DRM master, the VT and the input devices, so waking is
  Chromium's start alone, and nothing changes at the unit level: no stop and start of whombat-kiosk per sleep (its
  `StartLimitBurst=3` in 300 s counts starts), no second unit on tty1, no reader of our own on every keyboard's evdev
  node.
- **Plugged in later.** In the server's namespace cage never gets udev events (NX-82), so a keyboard, a mouse or a
  display connected after it started is never used. `whombat-kiosk-replug` (keyboards, NX-82) now takes mice too; a DRM
  hotplug event (`ACTION=="change"`, `HOTPLUG=1`: a display plugged in or out, on some virtual GPUs a viewer resized)
  starts `whombat-kiosk-display`, which restarts a running kiosk after 2 s (a burst is one restart) and not within 15 s
  of the kiosk's start (a new cage's mode set can't loop). A new cage is awake. This also covers NX-83's “not seen: a
  monitor plugged in after boot”. *Keyboards and mice no longer restart it since NX-400; displays still do (NX-402).*
- **The protections stay.** The unit is unchanged: `Restart=always`, `RestartMode=direct`, three failures in 300 s and
  `OnFailure=` the text console, `RestartPreventExitStatus=3` with no display, NX-87's `ExecStop` (`pkill -f chromium`:
  the loop's command line names the profile `/run/whombat-kiosk/chromium`, so it takes the loop and cage too, as before;
  swayidle ends with cage's socket) and `TimeoutStopSec=5`. The loop stops Chromium itself with SIGTERM, and after 10 s
  SIGKILLs every whombat-kiosk process under `/libexec/chromium/` (a hang like NX-87's can't keep it awake). A Chromium
  crash still ends cage with its status, Ctrl+W still reopens the page, NX-88's VT handling is the same, and the
  loop's EXIT trap takes swayidle along (cage ends only once every holder of its child's pipe has). The installer's loop
  is byte-identical (the same store path as today's).
- **Log** (`journalctl -t whombat-kiosk`): “nobody used the console for 10 min; it sleeps until a key press or pointer
  movement”, “the console was used; it shows again”, “this Whombat isn't claimed any more; the console shows again”.
- **What goes at once:** the anonymous memory and the tmpfs profile (about 200 MB). Chromium's file pages (about 500 MB)
  stay cached until the kernel needs the memory (MemAvailable counts them), and the next wake starts faster for it.
- Checked: `checks.console` (the options, the udev rules, the display unit, the kiosk's protections, the loop's syntax
  and contents, the installer's loop without swayidle); shellcheck (the loop is a `writeShellApplication`); and the loop
  run locally with stand-ins for Chromium, swayidle, the API and the VT (1 s polls, 2 of them): it sleeps when idle and
  claimed, wakes at once on input, wakes when the box is no longer claimed, stays awake while unclaimed or while the API
  doesn't answer, stays asleep while the API doesn't answer, reopens after exit 0, exits with a crash's status, and
  leaves no swayidle behind. That run found `wait -n -p` leaving its variable unset when a signal ends it (fatal under
  `nounset`); fixed. Not checked: the real cage, swayidle and Chromium together, and the hotplug paths: John's box (its
  VNC display) is the live check. No VM test (IN-132). A host release.

## NX-148 Incus's double-close warnings stay out of the journal (2026-10-10; DEV box health check)

*Superseded by NX-455 (2026-10-25): no Incus.*

incusd 7.0.1 closes a client's connection twice and logs the second close as a warning: `time="…" level=warning
msg="Failed to close connection" err="close unix /var/lib/incus/unix.socket->@: use of closed network connection"`
and `msg="Failed to close remote connection"` with the same `err` on every call computerd makes, and `err="close unix
@->/proc/self/fd/<n>/forkfile.sock: …"` for file operations. On John's box: 2,101 of incus.service's 2,106
`level=warning` lines in two days (973 + 564 + 564 of the three shapes), nearly all of the box's warnings. They come on
incusd's stdout at priority 6, so `journalctl -p warning` never showed them; anything that greps for warnings did.

- incus.service gets `LogFilterPatterns=~level=warning msg="Failed to close (remote )?connection" err="close unix
  [^"]*: use of closed network connection"$` (computers.nix `incusCloseNoise`). systemd 260 (the setting is from 253):
  PID 1 takes the value verbatim, no unquoting and no specifiers (`config_parse_log_filter_patterns`); journald matches
  it with PCRE2 (in the image's `libsystemd-shared` RUNPATH) against `MESSAGE` of every stream line from the unit's
  cgroup, its children under `Delegate=yes` included (`cg_path_get_unit_path`). A deny pattern only, so every other line
  is kept: other `err`s, other levels, `msg="Failed closing connection"` (one in two days), the QEMU and AppArmor
  start-up warnings.
- Checked: on The Titan's systemd 257, a transient system unit with the pattern printing the three shapes and five
  neighbours: the three dropped, the five kept; `checks.computers-config` runs the pattern with `pcre2grep` over the same
  lines. A host release.

## NX-150 The computers on Incus's btrfs pool, in a qgroup of their own (2026-10-10; amends NX-12, NX-130; supersedes NX-130's `dir` on btrfs)

*Superseded by NX-455 and NX-458 (2026-10-25): 1/101 is the containers' qgroup; no btrfs pool, no shim.*

On John's box (16 GiB, /persist 87 GiB btrfs, `pve-dev-20261010.8`) three computers held 3.6, 4.1 and 7.7 GiB on the `dir`
pool, about 10 GiB of it the same base-image files (the pool's qgroup 0/264: 14.84 GiB referenced, 14.57 exclusive): the
`dir` driver unpacks the ~1 GiB image into ~3.2 GiB for every new or reset computer. With Incus's btrfs driver a
computer is a snapshot of the image's volume: made and reset in a moment, the base stored once, and Incus holds each
computer to its root `size`. NX-130 turned btrfs down because its nested subvolumes are in no qgroup but their own and
would escape the reserve; this is the job it said that would need.

- **The qgroups** (whombat-persist-layout, every boot). `2/100` holds every subvolume but PostgreSQL's and has NX-12's
  limit (usable size minus `persistReserveMiB`, at least 5 %), which moves there from `1/100`. In it: `1/100`, Whombat's
  own subvolumes (home, workspaces, credentials, secrets, manager, backup, Incus's state `/persist/incus`), no limit of
  its own; and `1/101`, the computers': the pool's subvolume `/persist/incus-computers` and every subvolume in it, limited
  to `whombat.computers.storagePercent` (50) of the usable size, the same number the `dir` pool's own limit had. A
  computer's subvolume has exactly one parent, 1/101: btrfs carries the counts over to a snapshot only then (below).
  PostgreSQL stays in none. New internal options: `whombat.storage.qgroups` (the ids, read-only),
  `whombat.storage.computers.{subvolumes,moved,percent}` (computers.nix: `incus-computers`, the old `incus-pool`, 50).
- **Never outside a limit it was in.** On a box laid out before this, the script goes: create 1/101 and 2/100; 2/100
  gets the reserve's limit before anything joins it; 1/100 (which had that limit) joins 2/100, and only once it is in
  does 1/100's own limit go; 1/101 gets its limit before a subvolume joins it; the old `dir` pool's subvolume joins 1/101
  before it leaves 1/100 (`qgonly`: join first, leave after, stay put when joining fails), and its own limit (the same
  50 %) goes only after that. The limits keep the numbers they had: 2/100's is 1/100's, 1/101's the old pool's.
- **Rescans only when btrfs says the counts are off** (`/sys/fs/btrfs/<uuid>/qgroups/inconsistent`, else the warning
  of `btrfs qgroup show`): a relation btrfs can't carry the counts over for marks them so (`quick_update_accounting`:
  the member's exclusive must equal its referenced); joining an empty subvolume, or 1/100 into 2/100 when 1/100 shares
  nothing outside it (John's box: 26.94 = 26.94 GiB), doesn't. At boot the rescan runs before PostgreSQL and the server,
  so nothing writes while the counts are being rebuilt. John's box needs one, once: its old pool shares 0.27 GiB with
  the workspaces (0/258: 7.49 referenced, 7.22 exclusive), so moving 0/264 into 1/101 marks the counts.
- **incusd's `btrfs`** (`btrfsShim`, first in incus.service's PATH). Incus 7.0.1 makes every subvolume with the btrfs
  CLI (`driver_btrfs_volumes.go` `btrfs subvolume create`, `driver_btrfs_utils.go` `btrfs subvolume snapshot`, and a
  missing pool source in `driver_btrfs.go` `Create()`), so the shim adds `-i 1/101` to `subvolume create` and
  `subvolume snapshot` when the destination is under `/var/lib/incus/storage-pools/` or is (or is under)
  `/persist/incus-computers`, and passes everything else to btrfs-progs unchanged (an `-i` already given included).
  The new subvolume is in 1/101 from the moment it exists, in the same ioctl. After each one it starts whombat-qgroups.
  `checks.computers-config` runs the shim against a stand-in btrfs.
- **Where the counts get lost anyway, and what then.** btrfs carries counts over to a snapshot only when the source has
  that one parent and the parent shares nothing outside itself (kernel 6.18 `qgroup_snapshot_quick_inherit`:
  `parent->excl == parent->rfer`). A computer that shares data with a workspace breaks the second: an agent's `cp`
  between the shared folder and its own disk makes a reflink (`copy_file_range` clones on one btrfs, across mounts too),
  which is where John's 0.27 GiB came from. Then the next snapshot into 1/101 (a new or reset computer, a publish) marks
  the counts inconsistent, and since 6.x inconsistent also means `NO_ACCOUNTING`: btrfs counts no writes against any
  limit, the reserve's included, until a rescan. The same happens to every snapshot made without `-i` of a subvolume
  that has a parent (the backup's checkpoints, BK-04: until now each one left NX-12's accounting off until the next
  boot; found here), to deleting a subvolume whose shared tree reaches `drop_subtree_threshold` (3), and to a stray
  subvolume's assignment. **whombat-qgroups** (storage.nix; a oneshot every minute by a timer, at
  whombat-computers-storage's start and after every subvolume incusd makes; `LogLevelMax=notice`, so only what it does
  is logged): every subvolume in the computers' trees not in 1/101 alone is moved there (one made by `btrfs receive`, by
  an agent inside its computer — unprivileged users may create subvolumes — or by an incusd without the shim), and when
  the counts are inconsistent and no rescan runs, it starts one. Cost: while 1/101 shares data with the rest, each new or
  reset computer costs a rescan (all of /persist's extents: seconds to a minute on a box like John's, an estimate), and
  the limits lag until it ends; while it shares nothing, none. Proved on a loop file (kernel 6.12, this branch): one
  reflinked file between a workspace and a computer, and the next snapshot into 1/101 was inconsistent; with it removed,
  quick again.
- **Not chosen.** The computers straight in 1/100 (one closed parent, so every snapshot quick, no rescans): no limit
  of their own, so full computers could fill Whombat's home, workspaces and the manager's staging. Simple quotas
  (`btrfs quota enable --simple`: no rescans ever, nested subvolumes inherit their parent's qgroups by themselves): on an
  existing file system the data written before goes uncounted, so the reserve wouldn't see what boxes already hold; a
  candidate for fresh installs later, with a decision of its own.
- **The pool.** `computers`, driver btrfs, source `/persist/incus-computers` (an empty subvolume, which Incus accepts),
  `btrfs.mount_options=user_subvol_rm_allowed,nodev`, `rsync.compression=false`. whombat-computers-storage mounts the
  subvolume on itself, in a peer group of its own, `suid,nodev,exec`, as NX-130 did for the others; Incus bind-mounts it
  on `/var/lib/incus/storage-pools/computers` and remounts that with the options above (its remount clears nosuid;
  `nodev` stays as on the `dir` pool). The source sits under /persist rather than at a second mount point, so a release
  from before this one, booted after a fallback, still mounts the pool itself (its incusd has btrfs-progs; its
  subvolumes then escape 1/101 until this release's whombat-qgroups puts them back). A box that never had computers gets
  no `dir` pool and no `/persist/incus-pool`. Not btrfs (another platform, a plain /persist): the `dir` pool `default`,
  as NX-130.
- **Preseed and computerd's pool.** The preseed merges into what exists at every Incus start, and the old one set the
  profile's root disk to `default` each time: it would have pointed it back, and recreated the `dir` pool once deleted.
  It now holds the server's settings and the profile's config only; the preseed script creates the btrfs pool once
  (when `/persist/incus-computers` is mounted; if that fails it keeps a `dir` pool that exists, else Incus fails as
  before), the `dir` pool only where there is no btrfs pool, the profile's root disk once (on the pool new computers go
  to; NX-151 moves it), and writes `/run/whombat-computerd/pool.env` (`WHOMBAT_COMPUTERS_POOL=computers`, or `default`),
  an EnvironmentFile of computerd that overrides the unit's `default`. computerd itself needs no change: it creates
  with `-s <pool>`, and on btrfs (its `QUOTA_DRIVERS`) with `-d root,size=<WHOMBAT_COMPUTERS_DISK_GB>GiB`; it has no
  path into a pool, and the gate and status file are unchanged.
- **The size.** Incus's btrfs driver applies `size` as a referenced limit on the computer's qgroup 0/<id> and clears any
  exclusive one (`SetVolumeQuota`). Referenced counts the shared base, as a 40 GB disk holding the image would, though it
  is stored once: `diskGB` 40 stays what a computer sees. Incus reports a btrfs computer's disk usage as its exclusive
  bytes, so computerd's `diskUsedBytes` is what the agent added, not the base.
- **Images.** The pool keeps a volume per image it made a computer from (`images/<fingerprint>`, ~3.2 GiB unpacked for
  the base, in 1/101) while the image exists. Deleting an image (computerd keeping the current and previous base,
  Whombat box-health) deletes that volume; computers made from it keep working: btrfs snapshots are subvolumes of their
  own sharing extents, and the driver's `DeleteVolume` refuses only Incus snapshots of the image volume itself. The
  shared data stays counted in 1/101 while a computer refers to it. Kernel 6.18 removes a dropped subvolume's qgroup by
  itself and refuses to destroy a live one's (Incus tries before each delete and ignores the answer), so no stale
  qgroups pile up.

## NX-151 Computers on the old `dir` pool move to the btrfs pool at boot (2026-10-10; NX-150)

*Superseded by NX-455 and NX-463 (2026-10-25): what was left of the pools is deleted after the first blessed boot.*

`whombat-computers-move` (a root oneshot, wanted by computerd, after `incus.service`, before `whombat-computerd`): at
boot no turn can use a computer while it moves. It does nothing without both pools, and nothing while computerd runs (a
start outside a boot logs that the move waits for the next one).

- **Each computer on the dir pool**, smallest first: its size is `du -sxl` of its directories (hard links counted each
  time: Incus copies between pools with rsync without `-H` or `-A`, `internal/rsync`'s `-ar --devices --numeric-ids
  --partial --sparse --xattrs`, so a moved computer can hold more than before, and POSIX ACLs on it are lost —
  systemd-tmpfiles makes the ones it manages again). It moves only if the size plus a tenth plus 64 MiB fits in 1/101,
  in 2/100 and on the disk (the copy stands beside its original until Incus deletes the original), and only while this
  boot's budget lasts: 15 minutes, estimated at 25 MiB/s. The runtime target waits for computerd, and with it the boot's
  assessment (NX-05, which only starts after it) and the update's health (the manager rolls back after
  HostRebootTimeout + VerifyTimeout, 30 minutes from the activation). A running computer (kept awake or with published
  ports: Incus starts those at boot) is stopped first (30 s, then forced) and started again after. Then
  `incus move <name> --storage computers` (Incus's copy under a temporary name `move-of-…` into a new subvolume, the
  shim's `create`, so in 1/101; the original deleted; the copy renamed back). A moved computer keeps everything on it;
  it shares the base with the others again from its next reset. It gets the root size of a new one
  (`root size=<diskGB>GiB`) unless it already holds more than nine tenths of that. While computers move, the status
  file says “The computers are moving to new storage on this Whombat; they’re back in a few minutes.”
- **What fails, and how it recovers.** No room or no time left: the computer stays on the dir pool and works as before,
  and moves at a later boot or goes with its next reset (logged with its size and the room). A failed move (`incus move`
  exits non-zero): Incus deletes its unfinished copy; the computer stays where it was and works (checked by asking
  Incus which pool its root disk is on), and the next boot tries again. A move cut short (the power goes) after Incus
  deleted the original and before it renamed the copy back: the name is written to
  `/var/lib/whombat-computers-move/moving` before each move, and the next run renames a `move-of-…` copy back to it, or
  deletes the copy when the original is still there. The unit's own failure leaves computerd starting anyway (Wants=),
  with `pool.env` already written by Incus's start.
- **The profile and the dir pool.** The preseed runs at every Incus start while computers may still be on the old pool,
  so it never moves the profile's root disk; computerd's computers have their own root disk (its `-s`), so the
  profile's pool decides nothing for them, and new and reset computers go to the btrfs pool through `pool.env` at once.
  When no computer is left on the dir pool, this unit sets the profile's root disk to `computers`, deletes the `default`
  pool, unmounts `/var/lib/incus-pool` and deletes `/persist/incus-pool` (only if Incus left nothing in it; a later boot
  finishes what an earlier one couldn't). Until then the old pool's subvolume is in 1/101 with the btrfs pool, so the
  computers' limit counts both.
- **John's box at the first boot of the release** (estimates): persist-layout makes 1/101 and 2/100 and moves the
  limits (no write is outside a limit at any step), moves the old pool into 1/101 and rescans once (the 0.27 GiB it
  shares with the workspaces; seconds to a minute, before PostgreSQL); whombat-computers-storage mounts the old pool and
  the new subvolume; Incus starts, the preseed makes the btrfs pool; the move unit copies the 3.6, 4.1 and 7.7 GiB
  computers one after the other (1/101: 42.1 GiB limit, 14.8 GiB used, so the largest needs 8.5 GiB of 27; at 50 to
  200 MB/s each takes about half a minute to two and a half minutes, at the budget's 25 MiB/s 2.5 to 5.3 minutes; the
  disk needs at most the largest computer's size extra, 7.7 GiB, at any moment), sets their size, deletes the dir pool
  and its subvolume, and computerd starts. Their next reset makes them snapshots of the base image.
- **Proved** (2026-10-10, KVM as the user, branch `btrfs-pool`): `checks.computers` **17/17 subtests**, 404 s after
  provisioning (8 min 14 s with the build), and again after merging main (box-health, NX-146…NX-148; candidate
  0.75.0): 17/17, 378 s (7 min 49 s). New in it: the btrfs pool, set-uid on its mounts, 2/100 ⊃ 1/100 and 1/101
  with their limits, the shim in incusd's PATH; two computers as snapshots of the image volume in 1/101 alone with
  the counts kept (no rescan), a stray subvolume put into 1/101 by whombat-qgroups, a root size of 64 MiB holding;
  an older box (the dir pool `default` on `/persist/incus-pool` in 1/100 with its own limit, 1/100 with the reserve's,
  no 1/101 or 2/100, a kept-awake computer with a file reflinked from a workspace and one too big to fit) rebooted:
  the layout migrated with one rescan at boot, the kept-awake one moved (running again, its files, its size), the big
  one stayed on the dir pool and started there, the move waited while computerd ran, a failed move (Incus couldn't
  make the copy's subvolume) left it working with no `move-of-…` left, the next run moved it and deleted the dir pool,
  its subvolume and mount; a write past 1/101's limit failed while Whombat's home could still write. It took three
  runs: the first stopped at a stale RA-45 memory assertion (MP-01 had changed the rule, NX-141; fixed), the second at
  the test's error text (the image's musl busybox says "Quota exceeded"). Also, on the merge too,
  `checks.computers-config` (with the shim's cases), `proxmox-config`, `eval-aarch64`, `runner-sandbox`,
  `vault-wall-config`, `browser-config`, `appliance-toplevel` and `image-no-secrets` build, and the prod and DEV Proxmox
  images evaluate. On the loop file
  (kernel 6.12) the new persist-layout migrated a layout made by main's, idempotently, and the shim and whombat-qgroups
  behaved as here. Not run: `computers-real-runtime` (the real computerd's `-d root,size=` on the btrfs pool) and a
  real box; John's box's numbers above are estimates. Seen in the VM test, not changed: NX-142's boot-time check
  restarted the kept-awake test computer (“started without oom_score_adj 500”) before the move.

## NX-152 The hosts service on the DEV image: the pin, the package, the account (2026-10-17; Whombat ONE-11…ONE-15)

John, 2026-10-17: one Whombat, with Rackoon folded in (Whombat `docs/decisions/one-whombat.md`). Rackoon's Go code is
now a repository of its own, the hosts service's; its hub runs **headless inside the box** and the Whombat server talks to it over a Unix
socket with one service token (ONE-11); every screen, account and permission is Whombat's (ONE-12). Stream N of the
build (`one-hosts`); stream H changes the binary on `one-headless`.

- **The pin.** Flake input `whombat-hosts` (`flake = false`, private like `whombat`). Until stream H's branch is merged
  and pushed it is `git+file:///home/me/Code/whombat-hosts?ref=one-headless&rev=…` (built on this machine only); the
  lead sets it to that repository's `main` on GitHub at the merge (`?ref=main&rev=<merge>`; the TODO in `flake.nix`).
  The candidate gets a component `whombat-hosts` (repository `whombat-hosts`, now in `harness/src/manifest/pins.ts`'s
  enum) with the same commit. `checks.hosts-pin` (one candidate per image: the one the runtime package names, NX-42)
  fails when they differ or the candidate has none, and `release/ship build` runs it after `runtime-pin` whenever the
  flake locks `whombat-hosts` (`checkPins` compares `flake.lock` and the candidate first, both ways). CI's nix checks
  list gains `hosts-pin` and `hosts-config`. The strict product manifest (`@whombat/release` 0.25.0's
  `RepositoryName`) can't name `whombat-hosts`: `manifest/build` leaves it out of `repositories` (its build, artifacts
  and pin stay in the build report and the annotations) until the contracts list it — a contract gap for stream C.
- **The package** `nix/packages/hosts` (`pkgs.whombat-hosts`, also `packages.<system>.whombat-hosts`):
  `buildGo127Module` (nixpkgs' Go 1.27.1; the hosts service's `go` directive is 1.27.1 since H's `98a5ad8`), `CGO_ENABLED=0`,
  its own `vendorHash` (a separate module from NX-134's). One derivation builds `bin/whombat-hosts` (`cmd/whombat-hosts`,
  no `embedweb` tag: no web UI) and `share/whombat-hosts/agent/whombat-agent-linux-{amd64,arm64}` (`cmd/whombat-agent`,
  cross-built: buildGoModule's own phases build only for the host platform, its GOARCH overriding `env`).
  `-X main.version=0.0.0-<commit time>.<shortrev>` (whombat-hosts has no tags; ordered by commit time like NX-105).
  The install check runs `whombat-hosts version`, checks each agent's ELF machine and that the only store paths in the
  binaries are the three nixpkgs' Go patches in (tzdata and mime.types first in their search lists, iana-etc instead of
  /etc/services and /etc/protocols): harmless on a server without them, since Go falls back to /usr/share/zoneinfo and
  its built-in port and protocol tables (https, icmp…).
- **Unsigned agents on DEV.** No `-X …agent.UpdatePublicKey`, no `manifest.json` in the agent directory: the hub says
  “no signed agent build”, so it offers no agent self-update, and a server takes a newer agent by running its install
  command again (the installer upgrades in place). Follow-up before production: a signing key kept like the release
  keys, the manifest written at release, self-update on. *Superseded on DEV by NX-157…NX-159 (2026-10-20): the agents
  are signed with the DEV agent key and the hub offers self-update; a production key is still to come.*
- **The module** `nix/modules/hosts.nix`, `whombat.hosts.enable` (default off), on in `dev-instance.nix` only, refused
  when `whombat.environment = "prod"` (“whombat.hosts is for the DEV Whombat … never prod”). The account
  `whombat-hosts`, **uid/gid 965** (`whombat.ids`, NX-08), no login, not a DynamicUser (/persist/hosts keeps its
  owner across host generations).
- **Checked** (2026-10-17, quick checks only): `nix build .#whombat-hosts` at one-headless `77524b1` (the hub
  `whombat-hosts 0.0.0-20261017125857.77524b1`, both agents, 36 MB with what they refer to), the DEV image's toplevel
  (`appliance-proxmox-x86_64`, no ISO), `checks.hosts-config`, `checks.hosts-pin` against a candidate with the component
  added locally (and failing with “candidate 0.85.0 has no whombat-hosts component…” without), and `runtime-pin`,
  `proxmox-config`, `computers-config`, `eval-aarch64`, `runner-sandbox`, `browser-config`, `vault-wall-config`.
- **The PROD image is unchanged**: `appliance-prod-proxmox`'s and the hardware image's toplevel derivations are the
  same as before the change (checked); only the DEV image (and its twin) differ. So `release/ship build` can't tell from
  the PROD host that the DEV twin's host changed: the first release with the hosts service is a host release by
  `--host` (later ones decide as usual when the PROD host changes; a DEV-only hosts change needs `--host` again).

## NX-153 The hub's unit, its data, and the server's way to it (2026-10-17; ONE-11)

- **`whombat-hosts.service`**: `whombat-hosts serve --headless --data /persist/hosts --listen
  unix:/run/whombat-hosts/api.sock --agent-listen :8443 --agent-url auto --agent-dist
  <pkg>/share/whombat-hosts/agent --service-token-file /persist/hosts/service-token`, `Type=exec`, `Restart=always`
  with backoff to 60 s. Wanted by `multi-user.target`, **not** the runtime target and not in the boot assessment (NX-05:
  postgres, manager, runtime health): a box is healthy whatever its servers do, and a failing hub never rolls an update
  back (`checks.hosts-config` greps the assessment). After and requiring `whombat-persist.target` and
  `nftables.service` (its egress rules before its first check), after `network-online.target` (`--agent-url auto` and
  the agents' certificate take the LAN address at start), `ConditionPathExists` on the device identity.
- **Data**: `/persist/hosts`, its own subvolume in Whombat's qgroup (`whombat.storage.extraSubvolumes`, NX-12), mode
  **0710** whombat-hosts:whombat-hosts (tmpfiles): the group may open a file whose name it knows, not list. The hub's
  files are 0600 (database, CA, the agents' listener key); the service token it writes at its first start is **0640**
  (an explicit chmod in the hosts service, so `UMask=0077` doesn't take the group bit) and it keeps only the hash. Not
  backed up yet (the backup sources are home, workspaces, credentials, secrets; BK-04): losing the CA means
  re-enrolling every server — follow-up (done: NX-407, BK-31).
- **Sandbox** (computerd's, NX-133, where it applies): `TemporaryFileSystem=/persist:ro` + `BindPaths=/persist/hosts`
  (+ `ReadWritePaths`): of /persist it sees only its own directory (tried with a transient unit: writes there, nothing
  else visible, the rest read-only); the other services' sockets and credentials, `/var/lib` and `/boot` inaccessible;
  `RuntimeDirectory=whombat-hosts` 0750 (the socket is the hub's, 0660, `--socket-mode`); no capabilities;
  `ProtectSystem=strict`, `ProtectProc=invisible`, `ProcSubset=pid`, `MemoryDenyWriteExecute`, `@system-service` without
  `@privileged @resources`; `AF_UNIX AF_INET AF_INET6 AF_NETLINK` (netlink for the default route's interface address);
  `IPAddressDeny=localhost` but the resolver stub; `MemoryMax=512M`; `LimitNOFILE=65536` (an agent and a console are a
  connection each); `UMask=0077`; in system.slice (not core: NX-142's protection is for Whombat itself).
- **Tried** with the package's hub as a transient unit with this sandbox (`PrivateUsers` added, as a user manager needs;
  no `IPAddress*`, no capability settings there): it starts, keeps /persist/hosts at 0710, writes the token 0640 and its
  other files 0600, the socket 0660, answers `/healthz`, finds the LAN address (`wss://10.100.0.7:<port>`) and serves
  `install.sh` (CA and TLS key pinned, both agents' sums) and `/download/whombat-agent-linux-arm64` on the agents' port.
- **Pings without CAP_NET_RAW**: the hub's checks open unprivileged ICMP sockets; NixOS's `net.ipv4.ping_group_range`
  is `0 2147483647`, which `checks.hosts-config` asserts covers gid 965.
- **`--agent-url auto` under `ProcSubset=pid`**: whombat-hosts reads `/proc/net/route`, which the unit can't see (NX-137:
  `/proc/self/net/route` it can), and falls back to the source address of a UDP socket connected to a documentation
  address — the default route's interface address on a box with one default route. Suggested to stream H: try
  `/proc/self/net/route` first.
- **The Whombat server**: `WHOMBAT_HOSTS_SOCKET=/run/whombat-hosts/api.sock`,
  `WHOMBAT_HOSTS_TOKEN_FILE=/persist/hosts/service-token`, `SupplementaryGroups=whombat-hosts` (and the user in the group).
  Read directly, not through `LoadCredential`: the hub writes the token after the server may have started, and rotates
  it by rewriting the file. No ordering between the two units: the server says the service is missing while it is
  (ONE-DH). The runner gets nothing.

## NX-154 Agents from private networks only; the hub's own egress (2026-10-17; ONE-15; NX-138, NX-144)

- **Inbound 8443** (`whombat.hosts.agentPort`, at least 1024 and never in the computers' published range: asserted):
  the NixOS firewall's `extraInputRules` admit TCP to it from RFC 1918, CGNAT and link-local (ULA, IPv6 link-local),
  NX-138's sources; a guard chain `hosts_input` (input, priority filter − 1) sends every new connection to it through
  `hosts_agents`: from `lo` rejected (“not from this host”: nothing on the box dials it, and the hub's PROXY-protocol
  trust for loopback peers is unreachable that way), private sources returned to the firewall, the rest dropped
  (“private networks only”) whatever another rule opens. Agents dial the box (the hub never dials them), so this is the
  only inbound path.
- **Its egress** (`inet whombat-egress` output, before `oifname "lo" accept`): `meta skuid 965 jump hosts`, where on
  this host only the resolver stub answers (127.0.0.53/54, port 53) and everything else on `lo` is rejected (the
  box's LAN address goes out on `lo` too, so no check can reach PostgreSQL, the server or any listener here), then TCP
  and UDP to the local network (`local4`/`local6` without the metadata addresses, NX-144; empty with
  `whombat.network.localNetwork` off) for its HTTP, TCP and DNS checks; everything else is the rules every uid has
  (443, DNS, ICMP — pings —, replies to agents). HTTP checks of public addresses on port 80 are refused (443 only, as
  every other uid): decided, not needed for servers on the LAN.
- `checks.hosts-config` asserts the rules (the whole `hosts` and `hosts_agents` chains, the jump before the loopback
  accept, the firewall lines) and that the hardware image has none of them. The DEV image's ruleset builds with NixOS's
  `nft --check`.

## NX-155 The dev stack's hosts service (2026-10-17; ONE-11)

- `dev/up` runs a service `hosts` before the runtime when the pins have a `whombat-hosts` component (older candidates:
  skipped, “the pins have no whombat-hosts”): the hub `goBuild` makes from the pinned clean clone
  (`./cmd/whombat-hosts`) and the agents for amd64 and arm64 (`goBuild`'s new `goarch`/`dir` options: Linux cross
  builds named `whombat-agent-linux-<arch>` in `<bin>/whombat-hosts@<commit>-agents/`), stamped `0.0.0-dev.<rev>`;
  the box's flags (`hostsArgs`), with the data and token under `env/hosts/`, the socket `env/run/hosts.sock`, the
  agents' port `ports.hostsAgent` (`WB_MGD_HOSTS_AGENT_PORT`, 4643 by default, **4743** on the dev stack:
  `dev/instance/dev-whombat.env`; shifted with the other ports for the live and scenario environments) on every
  interface (`WB_MGD_HOSTS_AGENT_HOST` binds one), `--agent-url auto` (this machine's LAN address). Healthy when
  `GET /healthz` on the socket answers 200 and the token exists. The runtime gets `WHOMBAT_HOSTS_SOCKET` and
  `WHOMBAT_HOSTS_TOKEN_FILE` while it runs. `dev/restart hosts`, `dev/logs hosts`, `--without hosts`; `dev/down` stops
  it after the runtime.
- Go: whombat-hosts wants Go 1.27.1 and this machine's `go` is 1.26.8, so `GOTOOLCHAIN=auto` fetches go1.27.1 into the
  module cache at the first build (cached since 2026-10-17).
- Checked (2026-10-17): harness `pnpm check` (new tests: the hub's arguments, the pins' hosts check both ways, the live
  environment's port); `startHosts` against H's tree with a scratch `WB_MGD_HOME`: built the hub and both agents, the
  hub made its token (`wbh_…`, 0640) and socket (0660), `/healthz` 200, the install URL `wss://10.100.0.7:<port>`;
  by hand with the box's flags, `GET /api/v1/servers` 401 without the token and `[]` with it and an actor; both
  stopped by their pids.

## NX-156 Mail from the runtime server (2026-10-19; Whombat CM-23)

- John, 2026-10-19: Email (IMAP) connections (Whombat `connections-more.md` CM-19…CM-27) read and send mail for the
  assistant. The egress table let the server's uid reach public addresses on 443 only, so a public mail server's IMAP
  and SMTP ports were dropped (“egress not allowlisted”) on every appliance.
- The server's uid jumps to a new chain `mail` for TCP 143, 465, 587 and 993: a public address is accepted, a non-public
  one returns to the output chain, where only the local network (LN-06) and the Vault's sets can let it through — the
  same shape as `vault_ssh` (NX-128). Port 25 stays closed: Whombat submits mail as the account (587/465), it never
  delivers it. No other uid gets these ports (the runner, the browser and the computers don't send mail).
- Checked: `checks.x86_64-linux.vault-wall-config` asserts the jump, the chain's four rules in order, and no port 25.

## NX-157 The DEV agent-signing key (2026-10-20; Whombat AU-01, AU-10)

John, 2026-10-20: server agents keep themselves up to date (Whombat `docs/decisions/agent-updates.md`). The hosts service
already had signed agent self-update; nothing used it, because the appliance built the agents without a key (NX-152's
follow-up).

- **The key**: a raw 32-byte Ed25519 seed at `~/.config/whombat/agent-signing-dev.key` (0600, john) on The Titan, made
  2026-10-20 by the hosts service's `rackoon-sign pubkey` (`RACKOON_SIGNING_KEY=<that path>`; it creates the file on first
  use). Fingerprint **`40f47772ee26385e`** (the first 16 hex digits of SHA-256 of the public key, what agents report as
  `AgentInfo.UpdateKey` and the manifest's `key`). It never enters a build, a box, an image or the repository.
- **Its public half** (base64) is committed as `nix/packages/hosts/agent-update-key.pub` and built into every agent;
  agents then take only updates it signed, so a compromised box can push only genuine Whombat agents (AU-01).
- **DEV only.** It signs the agents of the DEV image, where the hosts service runs (`whombat.hosts` is refused in prod,
  NX-152). A production key, kept like the release keys, comes with hosts in production (AU-10); the two are distinct
  (MA-14), so the prod refusal stays.
- **Lost or leaked**: make a new key (`rackoon-sign pubkey` with a new path, or the old file moved away), commit its
  public half, `dev/sign-agents`, ship. Agents built with the old key refuse the new builds (the hub says “trusts a
  different signing key”, Whombat's “Needs one more install”): each server runs its install command once more (or
  Whombat's **Update the agent**, AU-07), then updates itself again. A leaked key is replaced the same way at once.

## NX-158 Signatures committed, the build checks them: dev/sign-agents (2026-10-20; Whombat AU-02)

- **`dev/sign-agents`** (no arguments): builds `.#whombat-hosts-agents` and `.#whombat-hosts-sign` (rackoon-sign from
  the pinned whombat-hosts), refuses a missing key (it never lets rackoon-sign make a new one) or one whose public half
  isn't `agent-update-key.pub`, signs both agents (`rackoon-sign manifest --version <the agents' version>`, then
  `verify`), writes `nix/packages/hosts/agent-manifest.json`, `git add`s it and builds
  `checks.<system>.hosts-agent-manifest`. Ed25519 is deterministic and the agents reproducible, so running it again on
  the same pin writes the same bytes. `$WHOMBAT_AGENT_SIGNING_KEY` overrides the key's path.
- **`dev/candidate --hosts <rev>`** runs it in its worktree right after the vendorHash step (the flake input and
  `vendorHash` already moved), reads the manifest back (`signedAgents`: the version ends in the rev's short sha, a key
  fingerprint, exactly both agents), and commits it with the candidate; the IN row names the key. Step 1 builds
  `checks.hosts-agent-manifest` beside `runtime-pin` and `hosts-pin` on every candidate. Nothing to pass: the key is
  on The Titan at its default path.
- **The check** `nix/packages/hosts/manifest-check` (stdlib Go, its own module and unit tests, built with `vendorHash =
  null`): the manifest's version is the agents' version, its key is the committed key's fingerprint, it names exactly
  the `whombat-agent-linux-*` files built, and each one's arch, size and sha256 match and its signature verifies against
  the committed public key. Any difference fails with “… run dev/sign-agents”. The hub's package runs it before it
  installs the manifest and again after the fixup phase; `checks.hosts-agent-manifest` runs it alone (CI's nix checks
  list has it). Why committed and not signed at build time: Nix builds are pure (no key inside), prod and DEV images get
  the same verifiable bytes, and a stale signature fails the build instead of switching updates off quietly.
- A missing manifest fails evaluation with “agent-manifest.json is missing: run dev/sign-agents (and git add it)”.

## NX-159 The hosts package in three derivations (2026-10-20; amends NX-152)

- `nix/packages/hosts/default.nix` is still `pkgs.whombat-hosts` (the hub, what `whombat.hosts.package` and
  `checks.hosts-pin` use) and now has:
  - **`passthru.agents`** = `pkgs.whombat-hosts-agents` = `.#whombat-hosts-agents`: `whombat-agent-linux-{amd64,arm64}`
    at its top, with `-X rackoon/internal/agent.UpdatePublicKey=<agent-update-key.pub>` beside `-X main.version`
    (the hub's version, `0.0.0-<commit time>.<shortrev>`). Its install check is NX-152's (ELF machine, no store paths but
    tzdata/mailcap/iana-etc) plus the key in each binary. Bit-reproducible: `nix build --rebuild` passes.
  - **`passthru.sign`** = `.#whombat-hosts-sign`: `cmd/rackoon-sign`, for `dev/sign-agents` only (never on an image).
  - **`passthru.manifestCheck`** = `checks.hosts-agent-manifest`.
- The hub's derivation builds only `cmd/whombat-hosts`, copies the agents in (not a link: the image carries the hub's
  path only) and installs `share/whombat-hosts/agent/manifest.json` after the check. The three Go derivations share one
  vendored-modules path (`overrideModAttrs` names it `whombat-hosts-<version>-go-modules`), so `vendorHash` and
  `dev/candidate`'s `.#whombat-hosts.goModules` step are unchanged.
- `checks.hosts-config` also asserts the manifest is in the agent directory. The PROD images don't change (the hosts
  service is DEV only).
- **Checked** (2026-10-20, pin `d2098f2`): `dev/sign-agents` (both agents, version `0.0.0-20261019212356.d2098f2`, key
  `40f47772ee26385e`); `nix build .#whombat-hosts` and `checks.hosts-pin`, `hosts-config`, `hosts-agent-manifest`;
  `rackoon-sign verify --dir <out>/share/whombat-hosts/agent` OK; the agent binary carries the public key and its
  `collect` reports `Policy.Update: true` (true only with a key built in); a manifest with one size changed fails the
  build with “run dev/sign-agents”; harness `pnpm check`.

## NX-160 The desk socket: the console's server dials the runtime (2026-10-20; Whombat DK-12, brief §2.3/§2.5)

The desk display (Whombat `docs/decisions/desk-display.md` DK-01…DK-15) shows Whombat on a paired box's own screen. The
runtime is its one authority (what may show, what may be done); the console stays without network (CG-03) and shows only
what the runtime gives it (CG-08 moves as little as possible).

- **The socket.** The runtime's server opens `/run/whombat/console/desk.sock` (`whombat.console.deskSocket`, read-only;
  contracts `DESK_SOCKET_DEFAULT`) when it has `WHOMBAT_DESK_SOCKET`, which runtime.nix sets only where a graphical
  console runs (`console.enable && console.gui`). The directory is the console file's (2750 `whombat:whombat-console`,
  NX-32), so the runtime's 0660 socket gets the group `whombat-console`: the runtime and the console's user connect, nobody
  else does (the kiosk, the runner, the manager and the backup user can't even traverse the directory; `console-self`).
  `WHOMBAT_VOICE_SOCKET=${whombat.voice.socket}` goes to the server too when `whombat.voice.enable` (voice.nix,
  NX-184). The runner gets neither.
- **The client** (`console/internal/desk`) is the graphical console's server only (`--desk-socket … --desk-peer-uid
  <whombat's uid>`, and `--once --json` with the same flags, so the VM test can still compare the two). The text console
  never dials it and keeps `RestrictAddressFamilies=none`. Nothing in the server's unit changed: a path socket works from
  its private network namespace (only abstract sockets and IP are per namespace) and under `ProtectSystem=strict`
  (connect needs write permission on the socket inode, not a writable mount); `ReadWritePaths` stays the token directory.
- **The peer is checked**: `SO_PEERCRED` of the dialled connection must be the runtime's uid (Node can't read its own
  peer, so the socket's mode and group are the runtime's side, as for the admin socket, MR-15). A socket served by anyone
  else (root included) is no desk (“the desk socket isn't the runtime's”, logged once).
- **The state** (`GET /v1/desk/state`) is asked at most once a second, whatever polls (the page's every second, the
  kiosk's loop every 10 s), with a 1 s timeout; an answer that isn't `local.ParseDeskState` + `DeskStateValid` (schema,
  then consistency), a timeout, no socket or the wrong peer is `desk: null`, and the page shows the console as before.
  Every display string is then cleaned again (`screen.CleanName`, trimmed, cut to the contract's length), as the burrow's
  name (NX-78): whatever a future schema allows, the page gets one line of plain text. Changes are logged once, never
  the contents.
- **The Console API** gains `desk` (always present, null without a desk) and `POST /api/desk/unlock {pin}`,
  `/api/desk/unlock/phone`, `/api/desk/lock`, `/api/desk/touch`, `/api/desk/decide {number, decision}`,
  `/api/desk/talk {text | audioWav, continue}`, `/api/desk/talk/get {id}` and `GET /api/desk/talk/audio?id=`, behind the
  token. The server builds every runtime request itself from the named fields (anything else the page sends is dropped)
  and checks it first (a 6-digit PIN, an ask number and approve/decline, one line of text ≤ 500 characters or a 16 kHz
  mono 16-bit WAV ≤ 30 s, an id of the contract's pattern): a bad one is 400 `bad_request`/`bad_audio` and never reaches
  the socket. Answers are checked with the generated parsers (an unexpected one is 502 `failed`); the spoken answer only
  as `audio/wav` that starts `RIFF…WAVE`, ≤ 8 MiB. Refusals keep the runtime's status (400, 403, 404, 409, 413, 422, 429,
  503; another 4xx is 400, a 5xx 502) and its LocalError code, answered as `{"message": "<code>"}` like the console's
  other errors; no answer is 503 `unavailable`; without `--desk-socket` the routes are 404. A request that changes the
  state drops the 1-second cache. Body limits: `/api/desk/talk` `DESK_TALK_REQUEST_MAX_BYTES` (1.5 MiB), everything else
  the API's 1 KiB (`web.Options.Limits`). Since contracts 3.3 also `/api/desk/hear {audioWav}` (Talk's mic, ≤ 5 minutes,
  `DESK_HEAR_REQUEST_MAX_BYTES`) and `spoken` on `/api/desk/talk`, with a question of up to 1000 characters
  (console-gui.md CG-363).
- **CSP**: `media-src 'self' blob:` (the page fetches the answer with its token and plays a blob).
- Tests: `desk.TestStateCache`, `TestStateCleaned`, `TestStateRefused` (schema and consistency), `TestUnavailable`
  (no socket, another uid, a runtime that doesn't answer), `TestRequests`, `TestCheckTalkWav`, `TestTalk`,
  `TestCleanState`; `consoleapi.TestReadOnly`, `TestDesk`; `web.TestAPIBody` (per-path limit), `TestStatic` (CSP).

## NX-161 The kiosk draws with the graphics chip on real hardware (2026-10-20; DK-11; amends NX-82, NX-92)

*Off in the image since NX-169: the option and its path stay, as described here.*

- `whombat.kiosk.gpu` (default off, NX-169; the installer: off). The launcher looks at the DRM cards' drivers: one of
  `amdgpu`, `i915`, `xe`, `nouveau`, `radeon` (and `/run/opengl-driver/lib/dri` present) is a real graphics chip, and the
  kiosk then leaves `WLR_RENDERER` unset (wlroots picks GLES2, else Vulkan) and Chromium runs without `--disable-gpu` and
  without `--force-prefers-reduced-motion` (the avatars' motion and the page's transitions are back). Anything else
  (`bochs`, `virtio_gpu`, `qxl`, the firmware framebuffers) is as before: pixman and both flags (`WHOMBAT_KIOSK_RENDER`
  tells the browser loop). The policy `HardwareAccelerationModeEnabled` follows the option (it would override the flag).
- `hardware.graphics.enable` with the option: nixpkgs' full mesa 26.1 (radeonsi, iris, nouveau, … and their Vulkan
  drivers), from the binary cache. **Closure +843 MB** uncompressed (mesa 277 MB, LLVM 21's library 566 MB); the ISO's
  squashfs and the per-path update blobs (UP-X14) carry it once. Accepted for now: a trimmed mesa (only the gallium
  drivers above, no Vulkan) would be built locally for every nixpkgs bump; worth it only if the size starts to matter.
- No GPU-specific fallback: a kiosk whose GPU path fails three times in a row gives tty1 to the text console like any
  failing kiosk (CG-05). **Not seen on real hardware** (no machine here): amdgpu on the Z13's Radeon 8060S, i915/xe,
  nouveau; whether the kiosk's session gets the render node (`/dev/dri/renderD*` is 0666 on NixOS by default).

## NX-162 The kiosk follows the desk: never asleep in the day, dim or black at night (2026-10-20; DK-08, DK-09; amends NX-147)

`whombat.kiosk.desk` (the appliance). The sleeping loop (NX-147) asks the Console API every 10 s as before and now reads
one mode from it: the desk's when a screen is paired (`day`; `dim` or `black` inside quiet hours, the person's `night`),
else the claim state.

- **The runtime away:** while the API has no `desk` at all (the runtime restarting, an update at night) a paired
  screen's last mode holds for 10 minutes (`deskHoldSec`), so a dark bedroom screen stays dark and dimmed; a runtime
  that answers “nobody paired” (`desk.paired` null) ends it at once. A box whose runtime has no desk socket (older
  runtimes) never had a desk mode, so it behaves as NX-147.

- **Idle time:** swayidle signals after a minute without input (`timeout 60`, or `sleepAfterSec` if shorter) and on the
  next input; the loop counts from there (bash's `SECONDS`), so one swayidle serves every threshold.
- **Asleep** (Chromium stopped, cage black, NX-147): a claimed, unpaired box after `sleepAfterSec` without input and 12
  claimed polls (unchanged); a paired screen at night set to Black a minute after the last input (`blackAfterSec`),
  never while it is unlocked (NX-170). A paired screen never sleeps in the day or with Dim. Asleep, it wakes on input,
  or when the mode no longer sleeps (the quiet hours end, the screen is unpaired, the box isn't claimed); a mode that
  sleeps too keeps it asleep. Log lines:
  “quiet hours; the screen is black until it is touched”, “the desk screen shows again”, “this screen isn't paired any
  more; the console shows again”, and NX-147's.
- **The backlight** (only for a paired screen; an unpaired box's is never touched, as today): night (Dim, or Black while
  shown) `brightness.night` (10 % of the maximum, at least 1), Black asleep 0; leaving the night it goes back to the level
  it had before the loop first took it down, or `brightness.day` (80 %) when the loop doesn't know it (a kiosk restarted
  during the night). Set with logind's `SetBrightness` on the kiosk's own session (`busctl …/session/auto`): logind lets a
  session's owner set its seat's backlight, so the kiosk needs no root and no sysfs write. The device is the first of
  type firmware, then platform, then raw (systemd-backlight's order). Only changes are written, each logged.
- The page does its own 10-minute dim (CG-24) and the new-ask wake (DK-08); the loop only stops and starts Chromium and
  sets the backlight.
- **Checked:** `checks.console` (the loop's syntax, the thresholds, the mode query, the hold, SetBrightness), the loop run
  locally with stand-ins for Chromium, swayidle and the API (the day stays on while idle, Black sleeps, the runtime away
  at night keeps it dark, the morning wakes it, Dim stays on, a touch wakes it, an unpaired, unclaimed box stays on),
  and `console-self` (NX-168).
- **Not seen on real hardware:** the backlight (a VM has none), logind's SetBrightness from a `user-light` session.

## NX-163 The page may listen and speak (2026-10-20; DK-06, DK-07, DK-08)

*The sound path is superseded by NX-255 (2026-10-20; HD-04): Chromium plays and records through system-wide PipeWire's
PulseAudio socket, not ALSA's `default` device. The policies, the flag and `alsactl init` stand.*

- With `desk`, Chromium's policies add `AudioCaptureAllowedUrls` and `AutoplayAllowlist`, each exactly the page's origin.
  `AudioCaptureAllowed` stays false (no prompt, nothing else may), `VideoCaptureAllowed` false; and Chromium gets
  `--autoplay-policy=no-user-gesture-required` (stream P: WebAudio's chime after a kiosk restart, before any touch; the
  kiosk opens its one origin only). The page records only
  while a person holds to talk (getUserMedia) and plays the spoken answer and a new ask's soft sound without a preceding
  touch. The installer has neither.
- **Through the sound server (NX-255; was “ALSA, no sound server”):** Chromium plays and records through system-wide
  PipeWire's PulseAudio socket (`PULSE_SERVER`), whose WirePlumber picks the microphone and the speaker among all the
  cards (ALSA's `default` was card 0 only, and the Z13's microphone is a card of its own, NX-179); ALSA clients go
  through PipeWire too. logind still gives the active session on seat0 (the kiosk's) the sound devices (uaccess ACLs),
  which nothing of the kiosk opens now. A udev rule runs `alsactl -g init <card>` when a card appears: the card's UCM
  boot sequence (alsa-ucm-conf, already in the closure) or alsa's generic init, so speakers and microphone are unmuted at
  a sane level. alsa-utils brings alsa-plugins and ffmpeg's libraries: **closure +39 MB**, accepted. Nothing is kept
  between boots (no `alsactl store`; WirePlumber stateless, NX-255).
- **Not seen on real hardware:** sound at all on the Z13 (SOF/ACP with UCM), which source WirePlumber makes the default
  there; capture and playback in the kiosk's sandbox are seen in a VM with an emulated HDA card (`console-self`,
  NX-258).

## NX-164 A portrait panel is turned to landscape (2026-10-20; DK-11)

`whombat.kiosk.transform` (`auto`, `normal`, `90`, `180`, `270`, `flipped`, `flipped-90/-180/-270`; default `auto`). Both
loops (the appliance's and the installer's) run `whombat-kiosk-output` before Chromium opens: `wlr-randr --json` through
cage's wlr-output-management; `auto` turns each enabled output whose current mode is taller than wide (and not yet
turned) by 90°, a fixed value turns every display. A kiosk restarted for a display plugged in (NX-147) does it again.
wlr-randr 0.5.0 adds 0.1 MB. **Not handled:** which way a portrait panel is mounted (the kernel's panel-orientation
property isn't in sysfs; set `transform` for such a machine) and touch on a turned panel (libinput isn't told; the Z13's
panel is landscape). Not seen on real hardware.

## NX-165 A laptop never suspends; the power button (2026-10-20; DK-11)

`nix/modules/power.nix` (`whombat.power`, on with the appliance's modules; not on the installer):

- logind ignores the lid (`HandleLidSwitch`, `…ExternalPower`, `…Docked`), the suspend and hibernate keys (short and
  long), and idle; `HandlePowerKeyLongPress=poweroff` (held 5 s, logind's own threshold) everywhere; systemd's sleep
  verbs are off (`AllowSuspend`/`Hibernation`/`HybridSleep`/`SuspendThenHibernate=no`: logind's `CanSuspend` says `no`).
- **The short press** only wakes the screen, on a machine with a battery or a lid only: `whombat-power-key` (before
  `systemd-logind`, no default dependencies) writes `/run/systemd/logind.conf.d/50-whombat-power-key.conf`
  (`HandlePowerKey=ignore`) when the firmware's ACPI namespace has a present battery (`PNP0C0A`, `_STA` bit 0) or lid
  (`PNP0C0D`): the namespace exists before any driver loads, so this can't race udev. cage gets the key as input
  (libinput opens the power button), which wakes a sleeping console. **Everywhere else the short press still powers off**
  (logind's default): Proxmox's “Shutdown” without the guest agent is an ACPI power button press, and a mini PC in a
  cupboard is shut down that way.
- **Not seen on real hardware:** the Z13's firmware may cut power on its own after a 4 s hold (before logind's 5 s);
  whether its keyboard cover reports a lid or tablet-mode switch.

## NX-166 UPower shuts down cleanly at 10 % (2026-10-20; DK-10)

`services.upower` with the percentage policy: low 20 %, critical 15 %, action at `whombat.power.shutdownAt` (10 %) on
battery: `PowerOff` (through logind, a clean shutdown). The manager reads the battery itself for the runtime (MG-69);
UPower is only the shutdown, and `ignoreLid` (logind owns the lid). Whether the machine starts again when the power
returns is its firmware's (DK-10, DK-15). Closure +4 MB (upower, polkit, libimobiledevice). In a VM UPower sees only its
display device; **not seen with a real battery**.

## NX-167 The battery is held at 80 % (2026-10-20; DK-10)

`whombat.power.chargeLimit` (80; null leaves the firmware alone): `whombat-charge-limit` (oneshot after udev's trigger)
writes it to `charge_control_end_threshold` of every system battery that has one (asus-wmi, thinkpad_acpi, dell-laptop,
huawei-wmi, lg-laptop, msi-ec, system76, …), and a udev rule does the same for a battery added later. Both: asus-wmi adds
the threshold to the battery after the battery's own `add` event, which a rule alone misses. A firmware that refuses the
value is logged. The manager reports the threshold as `chargeLimit` (MG-69). **Not seen on real hardware** (the Z13's
asus-wmi threshold, whether its firmware keeps it across reboots).
## NX-168 How the desk's host side is checked, and what it adds (2026-10-20; NX-160…NX-167)

- **Go:** `go vet ./... && go test ./...` of the root module against contracts 0.100.0 (every package, the manager's
  included); the desk client, the Console API, the web front and the manager's power reading have their own tests
  (NX-160, MG-69).
- **checks.console** (`nix build .#checks.x86_64-linux.console`): the desk socket for the server only (the runtime's uid
  as peer, the text console without it, the runtime's env only with a graphical console, not the runner's); GPU,
  microphone, autoplay and sound setup on the appliance and none of it on the installer; the launcher's driver list and
  pixman fallback; the loop's thresholds, mode query, hold and SetBrightness; logind, sleep.conf, UPower and the charge
  limit; `--once --json` with no desk socket says `desk: null`.
- **console-self** (`nix build .#checks.x86_64-linux.console-self`, three VMs; 19/19 subtests, the script 438 s), new:
  a VM's kiosk draws in software (cage's `WLR_RENDERER=pixman`, Chromium's `--disable-gpu`) and cage turns its output
  through wlr-output-management; logind gives the kiosk's `user-light` session the sound card (an emulated HDA: rw ACLs
  on the PCM and control devices, the runner can't open them); logind's lid/power-key settings (a VM keeps
  `HandlePowerKey=poweroff`), `CanSuspend` = `no`, UPower's policy; the runtime's sandbox reads
  `/sys/class/drm/*/status`; a desk socket served by root is not believed, the runtime's (a fake as `whombat`) is
  0660 `whombat:whombat-console`, only the console's user connects (not the kiosk, the runner, the manager or the backup
  user), the API's `desk` and `--once --json` agree, the page's requests arrive as the contract's (unknown fields
  dropped, `v: 1` added) and refusals come back with their status and code; at night with Black the console sleeps a
  minute after the last input, a key wakes it, it sleeps again a minute later, the end of the quiet hours wakes it, the
  day and Dim stay on. Everything it checked before still passes.
- **Image:** with the GPU path on (NX-161), the appliance's system closure (`.#appliance-toplevel`) grew from
  4,888,192,640 to 5,775,406,920 bytes with NX-160…NX-167 alone (+887 MB, +18 %): mesa 277 MB and LLVM's library
  566 MB (NX-161), ffmpeg's libraries and the ALSA tools 39 MB (NX-163), UPower 4 MB (NX-166), wlr-randr and the scripts
  under 1 MB. With the GPU path off (NX-169) see there.

## NX-169 The graphics chip stays off for now (2026-10-20; the desk display's lead; amends NX-161)

`whombat.kiosk.gpu` defaults to false and the appliance doesn't set it: no `hardware.graphics`, so no mesa drivers and
no LLVM in the closure, and the kiosk always draws as before (pixman, `--disable-gpu`, `--force-prefers-reduced-motion`,
`HardwareAccelerationModeEnabled` false). The option with `true` is exactly NX-161.

- **Why off:** +843 MB (mesa 277 MB, LLVM's library 566 MB) on every image, VMs included, for a path nobody can try until
  Whombat runs on a real desk machine, while software rendering is proven (CG-01, NX-82, `console-self`). On the Z13 that
  means the avatars stand still and the page has no transitions (reduced motion), as on every box today.
- **Covered both ways:** `checks.console` asserts the image has neither the drivers nor Chromium's GPU and that the
  launcher only knows pixman; it also evaluates the whole system with `gpu = true` (never built into an image) and builds
  that launcher: the drivers on, the policy on, the driver list, the drivers' check and the pixman fallback.
- **Follow-up:** try `gpu = true` on the Z13 (a DEV image with the option set). Then, to make it cheap enough to ship,
  a Vulkan-only mesa without LLVM: RADV and ANV only (`galliumDrivers = [ ]`, `vulkanDrivers = [ "amd" "intel" ]`,
  LLVM off), wlroots' Vulkan renderer for cage (`WLR_RENDERER=vulkan`) and Chromium's ANGLE on Vulkan
  (`--use-angle=vulkan`, `--enable-features=Vulkan`); built here for every nixpkgs bump, not from the binary cache.
- **Image:** the appliance's system closure is 4,888,192,640 bytes before the desk display and 4,932,438,544 bytes
  with NX-160…NX-169 (+44 MB, +0.9 %; measured with `whombat.voice.enable = false`): ALSA's tools with alsa-plugins
  and ffmpeg's libraries 39 MB (NX-163), UPower 4 MB (NX-166), wlr-randr and the scripts under 1 MB. With the voice
  service merged (NX-182): 5,621,171,936 bytes. No mesa drivers and no LLVM in either (mesa's libgbm was there before).

## NX-170 Never black while the desk is unlocked (2026-10-20; review of the desk display; amends NX-162)

The kiosk loop's desk mode is `dim`, not `black`, while the API's `.desk.lock.state` is `unlocked`: in quiet hours with
“Black”, a screen someone unlocked keeps Chromium running at the night backlight, and once Whombat locks it again (2
minutes after the last touch, DK-04; the page tells Whombat about touches and about a talk sent or answered, CG-46) the
mode is `black` and the loop sleeps a minute after the last input as before. A `phone` or `backoff` lock is not unlocked.

```
… elif .desk.paired.quiet then (if .desk.paired.night == "black" and .desk.lock.state != "unlocked" then "black" else "dim" end) …
```

- **Why:** the loop counts idle time from swayidle (input only). A Talk waits up to 90 s for its answer without a touch
  (Whombat DK-T06), and reading an answer is no input either: a minute after the last touch the loop stopped Chromium
  in the middle of it.
- **Checked:** `checks.console` finds the query in the loop and runs it with jq: quiet Black locked → `black`, with a
  phone request → `black`, unlocked → `dim`; Dim → `dim`; out of quiet hours → `day`; unpaired; no desk → `none`.

## NX-175 Speech on the box: the voice service (2026-10-20; Whombat DK-06, DK-07, DK-12; stream V of the desk display)

John, 2026-10-20: the desk display (Whombat `docs/decisions/desk-display.md`). Talk turns held-to-talk speech into a
Chat question and speaks the answer, on the box (DK-06), keeping nothing (DK-07), in a service of its own with no
network and the models in the image (DK-12).

- **`whombat-voice`** (`voice/`, a package tree of the root Go module like `console/` and `manager/`; built by
  `nix/packages/go.nix` as `pkgs.whombat-voice` = `.#whombat-voice`, its `go test ./voice/...` in the build): HTTP/1.1
  JSON on `/run/whombat-voice/voice.sock` for the runtime server (§2.4 of the build brief, NX-177), in front of two
  programs it runs once per job: whisper.cpp's `whisper-cli` (NX-176) and Piper (NX-178).
- **`nix/modules/voice.nix`**, `whombat.voice.enable` (default off; **on in the appliance profile**, so on every
  appliance, hardware and Proxmox, DEV and PROD). Options: `package`, `whisper.{package,model}`,
  `piper.{package,voice}`, `threads` (0), `timeouts.{stt,tts}` (90 and 60 s), `memoryMax` ("1G"), `socket`
  (read-only, for the runtime's env).
- **On demand.** The socket is systemd's (`whombat-voice.socket`, in `sockets.target`); the service has no `wantedBy`
  and starts at the runtime's first request, then stays (a small Go process; the programs run only during a job). A
  box nobody talks to, every VM, runs only the socket.
- **The contract**: the shapes are the brief's §2.4 (`VOICE_SOCKET_DEFAULT`, `VOICE_PATHS`); the service has its own Go
  types for them until contracts 0.100.0 is vendored (`third_party/whombat-contracts-go` is K's, still 0.78), and
  answers errors as the local contracts' `LocalError`.

## NX-176 Speech to text: whisper.cpp with small.en q5_1 (2026-10-20; DK-06)

**Superseded by NX-470 and NX-473 (2026-10-26):** whisper.cpp 1.9.5 with Parakeet and Whisper large-v3-turbo, downloaded
after install; small.en is no longer in the image. The silence rule, the prompt and the threads below hold.

- **Program**: nixpkgs `whisper-cpp` 1.8.4 (MIT) built without SDL and cut to `bin/whisper-cli` and its libraries
  (`pkgs.voice-whisper`, `nix/packages/voice-engines`; NX-182). The CPU backends stay as nixpkgs builds them
  (`GGML_CPU_ALL_VARIANTS`: x86-64 builds for 14 CPU generations, the best one the machine supports loaded at run
  time).
- **Model**: `ggml-small.en-q5_1.bin`, **190 098 681 bytes, sha256 `bfdff4894dcb76bb…8e478ad30`** (the Hugging Face LFS
  object id, checked against the download), from `huggingface.co/ggerganov/whisper.cpp` at revision `5359861c`
  (2024-10-29, the newest on 2026-10-20), a fixed-output `fetchurl` (`pkgs.voice-whisper-model`,
  `nix/packages/voice-models`). OpenAI's Whisper weights, MIT. English only (`.en`): Whombat speaks English. Named
  without `whombat-` so `image-no-secrets` doesn't scan 181 MiB of weights.
- **A job**: the speech is written as a canonical 16 kHz mono WAV into the job's directory, padded with silence to
  1.1 s (whisper.cpp ignores anything under a second), then `whisper-cli --model M --file F --language en --threads N
  --no-timestamps --no-prints --suppress-nst [--prompt P]`. `--prompt` is the runtime's (the assistant's name, the
  servers' and things' names, ≤ 400): it makes “pve-02” come out as `pve-2` instead of “PvE2”. Threads: the CPUs the
  service may use, at most 8 (`whombat.voice.threads` overrides): 4 → 8 threads cuts the time by 40 % (below); the
  cap leaves the other cores to the rest of the box while a job runs.
- **Silence never reaches whisper.** Speech whose peak stays under −45 dBFS (nobody spoke, a muted microphone) is
  answered `text: ""` at once: whisper.cpp makes up polite phrases (“Thank you.”) in silence, and an empty text is the
  runtime's `not_heard`. The transcript drops whisper.cpp's non-speech marks (`[BLANK_AUDIO]`, `(music)`, `*coughs*`,
  `♪`), becomes one line without control or format characters (the console's rule) and is cut to 500 code points.
- **Measured** on The Titan (Threadripper 9970X), a 4.7 s clip (“Is pve two okay? How much memory is the Plex server
  using?”), model load included: **1.6 s** with whisper-cli's default 4 threads, **0.95 s** with 8, 0.58 s with 16;
  1.6–1.8 s pinned to 4 CPUs with 4 threads (`taskset`, a small box's budget). Through the service with 8 threads:
  1.7 s of speech in 0.87–0.92 s. Peak memory 464 MB.

## NX-177 The voice socket (2026-10-20; desk display §2.4)

*Amended by NX-186 (2026-10-20): the contract's own types and rules (contracts 0.100.0): strict requests, `seconds` in
whole seconds, a failed job is 503 `unavailable`, wrong paths and methods `bad_request`.*

- `GET /v1/voice/health` → `{v:1, stt, tts, microphone, speaker}` (NX-179); `POST /v1/voice/stt` `{v:1, audioWav,
  prompt?}` → `{v:1, text, seconds}`; `POST /v1/voice/tts` `{v:1, text}` → `{v:1, audioWav}`.
- **`seconds`** is the length of the speech received (two decimals), not the time the job took.
- **Speech in**: base64 of a RIFF/WAVE file, 16-bit PCM (format 1, or EXTENSIBLE with the PCM sub-format), **16 kHz
  mono only** (what the console page records), other chunks (LIST, fact) skipped, odd chunks padded, the data chunk
  whole. At most 30 s. **Speech out**: Piper's WAV re-encoded canonically (44-byte header, 16-bit mono, the voice's
  22 050 Hz), base64.
- **Limits and errors** (`LocalError {error: {code, message}}`): body over 1.5 MiB (STT) or 16 KiB (TTS), speech over
  30 s, or text over 600 code points → **413 `too_large`**; not JSON, `v` ≠ 1, a prompt over 400, empty text → **400
  `bad_request`**; not base64, not a WAV, not 16 kHz mono → **400 `bad_audio`**; a program or model missing → **503
  `unavailable`**; the queue full → **503 `busy`**; a program failing or timing out (STT 90 s, TTS 60 s) → **500
  `failed`**; other paths 404 `not_found`, wrong method 405. The timeouts are `whombat.voice.timeouts` (a slow machine,
  or a VM test without KVM, gets more). Text in (prompt, text) is made one line first (line breaks
  to spaces, control and format characters out), then counted.
- **One job at a time, two waiting** (`voice/internal/jobs`): a fourth request is refused at once with `busy` rather
  than queued (one person talks to a desk; a full queue means something is stuck, and the runtime says so). A caller
  that goes away leaves the queue.
- **Who may connect**: the socket's mode (NX-180) lets in the server (group `whombat`) and root; the service checks
  `SO_PEERCRED` too and answers 403 `forbidden` to any uid but root's and the server's (`--allow-uid 0,951`): a
  later member of the group gets nothing. (Unlike the desk socket, the server is the client here, so the check is the
  service's.)
- **Nothing heard or said is logged**: a line per job with the speech's length, the characters' count and the time
  (`stt: 1.7 s of speech in 870ms, 12 characters`).

## NX-178 Text to speech: Piper with the public-domain “ljspeech” voice, a process per answer (2026-10-20; DK-06)

*The program is superseded by NX-185 (2026-10-20): Piper's C++ library through `piper-speak`, without Python. The voice,
its choice and a process per answer stand.*

- **Program**: nixpkgs `piper-tts` 1.4.2 (OHF-Voice/piper1-gpl, GPL-3.0) without the `train`, `http` and
  `alignment` extras, on an `espeak-ng` whose own program isn't wrapped with `alsa-plugins` (`pkgs.voice-piper`,
  NX-182). Not nixpkgs' `piper` (a mouse configuration tool).
- **Voice: `en_US-ljspeech-medium`** (US English, female, 22 050 Hz, 60.6 MiB + config) from `rhasspy/piper-voices`
  at revision `c10ece1a` (2026-09-17), fixed-output (`pkgs.voice-piper-voice`, `piper-voice-en_US-ljspeech-medium/`
  with the `.onnx`, its `.onnx.json` and `MODEL_CARD`). **Public domain**: trained from scratch by Bryce Beattie on the
  LJ Speech dataset (public domain) and released by him into the public domain; the repository is MIT. Most English
  Piper voices are fine-tuned from “lessac” (Blizzard 2013 data under a research licence agreement) or trained on
  CC BY-NC data, so they are out. Of the three public-domain voices trained from scratch (ljspeech, Cori en_GB, Kristin
  en_US), five sentences of Whombat's kind spoken by each and heard back by whisper.cpp came out best with ljspeech
  (“NAS 1 is using 91% of its storage. I'd clear the old snapshots.”; Cori: “Nas, one is using ninety. One per
  cent…”, Kristin: “Flex will restart…”). Attribution: `voice/NOTICES.md`.
- **A job**: `piper --model <voice>.onnx --output-file <job>/answer.wav`, the text on **stdin** (one line, never an
  argument, so “-5 °C” can't read as an option); the file must be a 16-bit mono WAV with samples, at most 16 MiB.
- **A process per answer, not a warm one.** Measured: Piper's start (Python, onnxruntime, the voice) takes **0.72 s**
  and two sentences (“pve-02 is fine. It has been up for 41 days and its disks are healthy.”, 6.3 s of audio) **0.78–
  0.82 s** in all, the same pinned to 4 CPUs; through the service 0.77–0.89 s. Under the brief's 2 s line, so no warm
  process or server mode: no memory held between answers (Piper peaks at 216 MB) and nothing to restart. The first
  answer after boot reads Piper's libraries from disk and is slower (32 s in the VM test, whose store is a 9p share
  read by two slow CPUs; a real disk is far quicker).

## NX-179 Microphone and speaker from /proc/asound/pcm (2026-10-20; DK-07, desk display §2.4)

- `stt`/`tts` in the health answer: the program is an executable file and its model (and the voice's config) a
  non-empty file. `microphone`/`speaker`: a PCM device with at least one capture/playback substream in
  `/proc/asound/pcm` (no ALSA userland in the image). Only the trailing ` : playback N` / ` : capture N` fields of a
  line count (the kernel's `snd_pcm_proc_read` format), so a device *named* “capture 1” is not a microphone; a missing
  file (a VM without sound) is neither. The Z13's microphone is a card of its own (`acp-pdm-mic`): any capture device
  counts.
- Read at every health request (cheap); the runtime caches health for 60 s (T). The unit keeps `/proc/asound` visible:
  `ProtectProc=invisible` but no `ProcSubset=pid` (asserted by `checks.voice-config`).

## NX-180 The account, the socket and the unit (2026-10-20; NX-08, NX-146)

- **`whombat-voice`, uid/gid 966** (`whombat.ids`, the next fixed id after the hosts service's 965), no login, no
  other groups. It owns nothing on /persist; a fixed id keeps the socket's owner and the peer check the same in
  every generation.
- **Socket** `/run/whombat-voice/voice.sock`, made by `whombat-voice.socket`: **0660 whombat-voice:whombat**,
  directory 0755. The server runs as `whombat`, whose primary group it is: no group change for the server
  (`SupplementaryGroups`) and no group for the service. The runner, the browser, computerd and the console can't
  connect.
- **Sandbox**: `PrivateNetwork`, `IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX`, no capabilities,
  `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateDevices`, kernel tunables/modules/logs, control
  groups, clock and hostname protected, `ProtectProc=invisible`, /persist inaccessible, `MemoryDenyWriteExecute`,
  `LockPersonality`, `RestrictRealtime/SUIDSGID/Namespaces`, `RemoveIPC`, native syscalls only, `@system-service`
  without `@privileged @resources` with **`SystemCallErrorNumber=EPERM`** (onnxruntime's and ggml's thread pools may
  try to pin threads: refused, not killed), `UMask=0077`. Python, onnxruntime and whisper.cpp run in it unchanged (the
  `voice` VM test).
- **Limits**: `MemoryMax=1G` (whisper-cli with the small model peaks at 464 MB, Piper at 216 MB, one at a time),
  `MemorySwapMax=0` (capped units don't swap, NX-146), `TasksMax=256` (onnxruntime starts a thread per core),
  **`CPUWeight=20`, `IOWeight=20`** (below the tasks' 50 and the browser's 25: an answer may take a moment longer,
  the server and PostgreSQL never wait), in `system.slice` (not Whombat's core, NX-142). `Type=notify`,
  `Restart=on-failure`.

## NX-181 Nothing kept (2026-10-20; DK-07)

- The service's `/tmp` is a tmpfs of its own (`TemporaryFileSystem=/tmp:size=64M,mode=1777,noexec`, `TMPDIR`), gone
  when the service stops. Each job makes a fresh directory in it and removes it when the job ends, whatever happened
  (failure, timeout, a caller gone): the speech is gone once it is text, the answer's file once its bytes are in the
  reply. The service holds neither afterwards; the runtime keeps an answer's audio in memory for a replay (10 min, T).
- No words in the journal (NX-177). The programs' stderr reaches the journal only as the last line of a failure.
- The microphone is never the service's: the console's Chromium records only while someone holds to talk (DK-07,
  stream K/P) and sends the WAV through the runtime.

## NX-182 What it adds to the image, and the licences (2026-10-20)

*Superseded by NX-187 (2026-10-20): +341 MiB with `piper-speak` instead of piper-tts' Python.*

- **+657 MiB** to the appliance's system closure (4.55 → 5.19 GiB; the DEV and PROD images and the installer ISO
  grow the same): the models 242 MiB (whisper 181, the voice 61), Piper's Python side 434 MiB (onnxruntime's C
  library and Python module 114, `blas-3` and `lapack-3` 133 — two copies of OpenBLAS's runtime-dispatch library —,
  OpenBLAS 33, numpy 49, protobuf 19, eSpeak NG 18.5, gfortran's runtime 13, Piper 5), whisper.cpp 16 MiB,
  `whombat-voice` 6 MiB. Python itself was already there. A host release that adds voice downloads it once; later
  ones only what changed.
- **Cut down from nixpkgs' defaults**: whisper-cpp with SDL is 1.09 GB with what it refers to (X11, Wayland, PipeWire),
  without it and its downloader 62 MiB; piper-tts with its extras is 2.8 GB (torch), without them 839 MiB, and 600
  MiB once eSpeak NG's program wrapper no longer pulls `alsa-plugins` → ffmpeg and every codec. Neither build is in the
  binary cache; both build from source on The Titan in minutes.
- **Later, if the size matters**: Piper's C++ library (`libpiper` in piper1-gpl) with onnxruntime's C library and
  eSpeak NG, without Python, numpy and BLAS, would save about 450 MiB, at the cost of a small program of our own and a
  patched CMake build (it downloads its dependencies). Not now: the brief names nixpkgs' piper-tts, and it works.
- **Licences** (`voice/NOTICES.md`, installed as `share/whombat-voice/NOTICES.md`): whisper.cpp MIT, the Whisper
  weights MIT, Piper GPL-3.0-only, eSpeak NG GPL-3.0-or-later, ONNX Runtime MIT, the voice public domain. The
  service runs the GPL programs as separate programs (no linking); they are unmodified nixpkgs builds with optional
  parts left out, their source the pinned nixpkgs and upstream. The model derivations carry free `meta.license`s
  (`allowUnfree` is off), asserted by `checks.voice-config`.

## NX-183 How it is checked (2026-10-20)

- **Go** (`go test ./voice/...`, in the package's build): WAV parsing and encoding (chunks, extensible, truncated,
  partial frames, padding, silence), the queue (one runs, two wait, the rest busy, a caller that leaves), the PCM
  list, the text rules and the transcript's cleanup, the engines against the test binary as a fake whisper-cli and
  Piper (arguments, padding, the job directory removed after success, failure and timeout), and the socket (every
  error, the limits, silence that never reaches whisper, busy, the peer check on a real socket).
- **`checks.x86_64-linux.voice-speech`** (`nix/checks/voice.nix`, the build sandbox, no VM): the service with the real
  programs and models; Piper says “Is pve two okay?”, the answer is a 16-bit mono 22 050 Hz WAV, and resampled to
  16 kHz whisper.cpp hears `pve`, `2`/`two` and `ok` in it (it heard “is pve2 okay”); silence is `""`; 22 kHz speech is
  `bad_audio`; the jobs' directory is empty after.
- **`checks.x86_64-linux.voice-config`**: on in the hardware, DEV and PROD appliances and gone when off; the socket's
  path, mode and owners; the account's ids (unique); the unit's sandbox, limits and arguments; free model licences and
  names outside the secret scan's prefix.
- **`checks.x86_64-linux.voice`** (VM test `vm-tests/voice.nix`, a small VM with only the accounts and this module):
  socket 0660 whombat-voice:whombat and the service inactive until asked; the server's user and root get in, the
  runner can't open the socket, a member of the group who isn't the server gets 403; the round trip in the unit's real
  sandbox; nothing in its /tmp after, no network interface but `lo`, the right user and `MemoryMax`, no heard words in
  the journal. With KVM (its driver under an `agent-resource run` lease, 4 vCPUs): Piper's first answer 2.24 s (its
  libraries read cold over the test's 9p store), whisper.cpp 3.71 s for 1.7 s of speech (the model read cold too), heard
  “is pve-2 okay”; the whole script 14 s. `nix build` runs it without KVM on The Titan (the build users aren't in the
  `kvm` group, so QEMU falls back to TCG and a job takes minutes): the test gives the jobs 900/600 s, and passed so
  (Piper 32 s, whisper.cpp 3 min 17 s, heard “is pve2ok”, the script 293 s).
- CI: `voice-config` and `voice-speech` join `scripts/ci/nix-checks.sh`'s list, `voice` the VM drivers of
  `scripts/ci/virtual-machines.sh` (with KVM there).

## NX-184 What the runtime gets (2026-10-20; for stream K)

- The runtime **server** (not the runner) gets `WHOMBAT_VOICE_SOCKET=${config.whombat.voice.socket}`
  (`/run/whombat-voice/voice.sock`) when `whombat.voice.enable` is on, and nothing else: no group (the socket's group
  is its own), no path in `ReadWritePaths` (connecting to a socket under `ProtectSystem=strict` needs none), no
  ordering (the socket exists from `sockets.target`; the service starts on the first request). Unset, the runtime has
  no voice (Talk off). That line is in `nix/modules/runtime.nix` (stream K's).
- The dev stack runs no voice service; the runtime's fake voice (stream T) stands in.

## NX-185 Text to speech through Piper's C++ library: `piper-speak` (2026-10-20; supersedes NX-178's program)

The lead, after NX-182: the 657 MiB matter (every image, ISO and first update carries them); try Piper's C++ library,
and if it builds, passes `voice-speech` and keeps the 0.8 s answer, drop the Python stack. It did.

- **`piper-speak`** (`pkgs.voice-piper`, `nix/packages/voice-engines`): libpiper (`libpiper/src/piper.cpp` of the same
  pinned piper1-gpl source nixpkgs' piper-tts 1.4.2 builds from) and `piper-speak.cpp` (ours, about 150 lines),
  compiled with the stdenv's C++ compiler in one step, linked against nixpkgs' onnxruntime 1.24.4 (shared) and eSpeak
  NG (static, built as Piper's own CMake builds it: no async, Klatt, MBROLA, pcaudio, sonic or speech-player; with
  its `ucd-tools`). libpiper's CMake isn't used: it downloads onnxruntime and clones eSpeak NG.
- **The same interface as Piper's Python program** for the service: `piper-speak --model VOICE.onnx --output-file
  OUT.wav`, the text on stdin (at most 64 KiB), the voice's `.onnx.json` beside it; a 16-bit mono WAV at the voice's
  rate. Each sentence is peak-normalised and converted to 16 bit as the Python `piper` does (`normalize_audio`, volume
  1), so the voice sounds the same. Errors: a line on stderr, exit 1. The engine and its tests didn't change beyond the
  program's name (`--piper .../bin/piper-speak`).
- **eSpeak NG's English data only**: `share/espeak-ng-data/` of `piper-speak` holds `phontab`, `phonindex`, `phondata`,
  `intonations`, `en_dict`, `lang/` and `voices/` (1.5 MB of 14); the program is built with that directory as its data
  path. The static library's built-in default path names eSpeak NG's store path; `piper-speak` always passes its own,
  so `remove-references-to` drops that reference and eSpeak NG's 18.5 MiB leave the closure.
- **Measured** (The Titan; the two sentences of NX-178, 6.3 s of audio): **0.79–0.81 s** per answer, the same pinned to
  4 CPUs (Python: 0.78–0.82 s); of that, creating the ONNX session takes 0.70–0.80 s and the synthesis 0.12 s. Peak
  memory 179 MB (Python: 216). Through the service in the build sandbox 0.67–0.91 s. In the VM test with KVM the first
  answer took 1.59 s (Python: 2.24 s).
- **Not taken**: the session's 0.7 s doesn't come from graph optimisation (level 0 to 99 all 0.78–0.85 s) or weight
  prepacking (off: 0.78 s) but from loading the model; an ORT-format model saved at build time loads in 0.47–0.54 s.
  0.3 s of a talk that waits several seconds for the assistant isn't worth a build step that runs onnxruntime and a
  model format tied to onnxruntime's version (and, saved at the highest level, to the build machine's CPU). A warm
  process stays unneeded (NX-178's reasoning).
- **Licence**: `piper-speak` links libpiper (GPL-3.0-only) and eSpeak NG (GPL-3.0-or-later), so `piper-speak.cpp` is
  **GPL-3.0-only** (`SPDX-License-Identifier` in the file), the one file of this proprietary repository under the GPL;
  its corresponding source is that file, its derivation and the pinned nixpkgs sources (`voice/NOTICES.md`).
  `whombat-voice` runs it as a separate program and stays ours. To review with the licence work (source-review).

## NX-186 The voice socket on contracts 0.100.0's types (2026-10-20; CT-532; amends NX-177)

- `voice/internal/api` uses contracts-go 0.100.0's `local` package: `VoiceHealth`, `VoiceSttRequest`/`VoiceSttAnswer`,
  `VoiceTtsRequest`/`VoiceTtsAnswer`, `LocalError`, the paths (`VoicePath*`), `VoiceSocketDefault`,
  `VoiceQueueMax` (the `--queue` default), `VoiceTtsTextMax`, `VoiceTtsWavMaxBytes` (Piper's largest answer, 6 MiB),
  `DeskAudioSampleRate`, `DeskAudioMaxSeconds`, `DeskAudioBase64Max`, `DeskQuestionMax` (the transcript's bound) and the
  error codes. The service's own copies of the shapes are gone.
- **Requests are strict**, as the contract says: `local.ParseVoiceSttRequest`/`ParseVoiceTtsRequest` (the JSON Schemas:
  no unknown members, `v` = 1, base64 audio of 60…1 280 060 characters, a prompt and a text of printable characters on
  one line). A prompt or text with a line break, a control or format character is now **400 `bad_request`** rather than
  cleaned (the runtime builds them with the contract's `deskTextSchema`). Audio longer than the schema allows and text
  over 600 code points stay **413 `too_large`** (looked at before the schema).
- **`seconds` is whole seconds**, the speech's length rounded, at most 30 (`VoiceSttAnswer.seconds` is an integer):
  1.72 s of speech answers 2.
- **Codes are the contract's `VOICE_ERRORS`**: a job that fails or times out is **503 `unavailable`** (NX-177's 500
  `failed` isn't a contract code; the health's `stt`/`tts` mean “there and runs”); a wrong path (404) or method (405)
  answers `bad_request`. 403 `forbidden` (the peer check) stays outside the list: the runtime never meets it.
- Tests check every answer against the contract's schema (`local.Parse…`).
- **Vendoring**: K's re-vendoring of contracts-go 0.100.0 (`desk-host` 54d4422, “deps: contracts-go 0.100.0 … tree
  708906f”: `third_party/whombat-contracts-go`, `go.mod`, `vendorHash`) wasn't on `desk` yet, so this branch carries the
  same commit cherry-picked (`614059f`, identical tree and vendor hash): the lead's merges see the same change twice.

## NX-187 What voice adds to the image now (2026-10-20; supersedes NX-182's size)

- **+341 MiB** to the appliance's system closure (4.55 → 4.89 GiB; NX-182: +657): the models 242 MiB (whisper 181,
  the voice 61), onnxruntime 50.5 MiB with protobuf 18.6 and Abseil's headers 4.0 (nixpkgs' onnxruntime refers to
  them), whisper.cpp 16.2, `whombat-voice` 7.5 (the contracts' schemas came in with NX-186), `piper-speak` 1.7 (with
  its English eSpeak data). Python, numpy, OpenBLAS, LAPACK, gfortran's runtime, eSpeak NG's own path and piper-tts are
  no longer in it. What stays big is the whisper model (half of it).
- Licences as `voice/NOTICES.md` now lists them (NX-185 for `piper-speak`); the model derivations are unchanged.

## NX-188 Checked again (2026-10-20)

- `go vet` and `go test -race ./voice/...` (the contract's answers validated), `checks.voice-speech` (Piper says
  “Is pve two okay?” through `piper-speak`, a 16-bit mono 22 050 Hz WAV; whisper.cpp heard “is pve2ok”; silence is
  `""` with `seconds` 2), `checks.voice-config` (also `/bin/piper-speak` in the unit), `checks.eval-aarch64`, the
  appliance toplevel, and the `voice` VM test with KVM (its driver under an `agent-resource run` lease, closed with
  nothing left): `piper-speak` runs in the unit's full sandbox (`MemoryDenyWriteExecute`, the syscall filter, no
  network), the first answer 1.59 s, whisper.cpp 2.98 s for 1.8 s of speech, heard “is pve2ok”, the script 12.4 s.

## NX-189 Watchdogs on every machine (2026-10-20; PI-22)

- **The chipset's watchdog on a self-installed machine.** `proxmox-vm.nix` loaded only the i6300esb and blacklisted
  `iTCO_wdt`, and the Intel and AMD TCO drivers were loaded only for the factory platform, so a self-installed Intel
  machine had no watchdog at all (install.md's “known gap”). Now `nix/modules/boot.nix` (next to `RuntimeWatchdogSec`)
  loads `i6300esb` and `iTCO_wdt` on every x86_64 platform (both register without their device; `sp5100_tco` loads by
  its PCI id on AMD), and nothing is blacklisted. In the module, not in `profiles/appliance.nix`: the VM tests build
  the appliance from `nix/modules` without that profile, so a setting there is never tested (a first try put it there,
  and `install-vm` found the TCO loaded beside the i6300esb).
- **One watchdog where a VM has an i6300esb.** q35's ICH9 has a TCO too; with both, `/dev/watchdog0` would depend on
  load order, and the i6300esb's action is the hypervisor's. modprobe's `install` hook for `iTCO_wdt`
  (`whombat-itco-unless-i6300esb`, shell builtins only) loads nothing when an 8086:25ab device is on the PCI bus, else
  the module as usual. A q35 VM without one (Incus' default) gets its TCO: QEMU's ICH9 resets the guest (q35 8.0 and
  later, `noreboot` off), seen in `install-machine` (NX-190). The VM settings keep the i6300esb as optional.
- Checked by `checks.self-installed-config` (both platforms list `i6300esb` and `iTCO_wdt`, none blacklisted, the hook
  in modprobe's config), `install-vm` (the i6300esb is the only watchdog) and `install-machine` (the TCO is).

## NX-190 `install-machine`: the ISO on a dedicated machine, in QEMU (2026-10-20; PI-21, PI-22)

- A VM test of its own, not a variant of `install-vm` (whose GUI, OCR, recovery and boot-counting steps stay there):
  `whombat-install` from the installer puts the self-installed image on a 128 GiB disk; the machine boots it with
  OVMF in setup mode, no TPM, the disk on **NVMe**, one **Intel e1000e** card on QEMU's own network (its DHCP gives
  10.0.2.15; no test VLAN), no i6300esb and no guest agent. It checks root on NVMe, the platform, the card's driver
  and DHCP address, the guest agent inactive, the TCO the only watchdog and active, and a reset: PID 1 lets go
  (`RuntimeWatchdogUSec` 0 over D-Bus), a process opens the device, pets it once and closes it without the magic
  character, and the machine comes back with a new boot id and the TCO active again (about 70 s).
- In `scripts/ci/virtual-machines.sh` (the daily VM job), so the bare-metal path runs every day; `install-vm` stays
  on request. It doesn't replace hardware qualification (`hardware-qualification.md` “Dedicated machines”, SQ-00…SQ-09).
- Locally under `agent-resource run` with the driver's sockets in its workspace through a short `/tmp` symlink (the
  workspace path is longer than a Unix socket's).
- **Run 2026-10-20** with KVM under `agent-resource run` leases (all closed, nothing left): `install-machine` passes
  (NVMe root, e1000e 10.0.2.15 by DHCP, `iTCO_wdt` the only watchdog, reset 70 s after PID 1 let go), and
  `install-vm` passes end to end for the first time since it was written for PI-19 (2026-09-28, “not run”): two stale
  checks fixed (the installer's target disk is virtio, `/dev/vdb`, not `/dev/sda`; the text console is compared with
  the footer file its units get, which names no recovery key), the i6300esb the only watchdog (NX-189).

## NX-240 Wi-Fi with iwd; supersedes NX-92's “no Wi-Fi on the appliance” (2026-10-20; Whombat HD-05, HD-06)

- `nix/modules/wifi.nix` (`whombat.wifi.enable`, on; in `nix/modules`, so the VM tests have it): iwd
  (`networking.wireless.iwd`) with `General.EnableNetworkConfiguration=false` and `Settings.AutoConnect=true`, and
  networkd's `91-whombat-wifi` for every `wl*` interface: DHCP and IPv6 router advertisements like the cable,
  `IgnoreCarrierLoss=3s` (a roam between access points of one network keeps the addresses; iwd's advice for networkd),
  no LLMNR or mDNS. iwd's NixOS module keeps kernel names (`80-iwd.link`), so the interfaces are `wlan*`.
- **iwd, not wpa_supplicant.** iwd needs nothing beside it (wpa_supplicant wants NetworkManager or its own
  configuration file to be told networks), has a D-Bus API the helper and the installer both use (NX-243), and keeps
  each network in a file of its own. `networking.wireless.enable` stays false everywhere: it is NixOS's
  wpa_supplicant, which the iwd module refuses next to iwd (one daemon per card).
- **Saved networks are iwd's** (`/var/lib/iwd`, root only, 0600 files in a 0700 directory, on the system volume, not
  in backups): on the appliance only the update helper writes there (NX-244). `wait-online` stays “any interface”.
- **The egress table needs nothing:** it matches uids and ports, never interfaces, and the 4-way handshake is layer 2
  (EAPOL), which `inet` tables don't see; DHCP is allowed already.
- **Not now** (HD “Not now”): company (802.1X) networks and WEP (listed, not joinable), captive portals, a hotspot,
  static addresses over Wi-Fi (the guard's wired candidates stay as they are, MG-15), the box's own country for
  channels (the access point's is used; wireless-regdb comes with `enableRedistributableFirmware`).

## NX-241 A cable at route metric 100, Wi-Fi at 600 (2026-10-20; HD-05)

`90-whombat-default` (`en* eth*`) gets `RouteMetric=100` for DHCPv4 and router advertisements, `91-whombat-wifi`
`600` (`whombat.wifi.routeMetric`): with both up, the default route is the cable's, and Wi-Fi takes over when the cable
goes. networkd's default for both was 1024. The helper's committed wired candidates (`10-whombat.network`) are
unchanged (a static `Gateway=` has metric 0 and wins anyway).

## NX-242 The installer ISO on networkd and iwd instead of NetworkManager (2026-10-20; HD-08)

The minimal ISO came with NetworkManager, whose Wi-Fi is wpa_supplicant: the installer couldn't share the card with
it, and its connection profiles aren't the files the installed system reads. `installer.nix` now turns it off and
runs what the appliance runs: networkd (`90-whombat-wired`, `en* eth*`, metric 100), `wifi.nix` (iwd, `wl*` at 600),
resolved, and no `wait-online` (the installer's checks wait for an address themselves, CG-13; it reads addresses from
the kernel, not from NetworkManager). A network joined in the installer's Wi-Fi step is the file iwd wrote in the
ISO's `/var/lib/iwd`; the installer copies it into the target's `/var/lib/iwd` (`wifi.CopyProfile`, stream P), so the
box is online on its first boot. The shell on tty2 gets `iwctl` instead of `nmcli`.

## NX-243 `helper/pkg/wifi`: iwd over D-Bus, a passphrase agent, the profile files (2026-10-20)

- One package for the helper and the installer: `Client` (Status: adapters, devices, stations, saved networks;
  Networks and Scan, strongest first; Connect; Forget), `IWD` (the system bus), `Fake` (tests), and iwd's profile files
  (`ProfileName`/`ParseProfileName` with iwd's own encoding: the SSID when it has only ASCII letters, digits, `-`, `_`
  and space, else `=` and lowercase hex; `Write`/`Read`/`Remove`/`CopyProfile`, 0600, atomic, never following a
  symlink; values escaped as ell does: `\` and leading blanks as `\s`/`\t`, ell keeps trailing blanks).
- **An agent, not a profile written first** (the brief said “connect with a profile written first”; iwd 3.12's
  source decides otherwise): after a failed handshake iwd sets `ask_passphrase` on the network, so the next Connect
  asks an agent even when a profile is there (no agent: `NoAgent`), and a hidden network with a profile makes
  `ConnectHiddenNetwork` answer `AlreadyProvisioned`. So Connect registers an agent of its own on its bus connection
  (it answers `RequestPassphrase` only to iwd's unique name, and cancels everything else), and iwd writes the profile
  itself when the keys are set (`HANDSHAKE_EVENT_SETTING_KEYS`): a wrong password leaves no file. A profile is written
  first only for a raw 64-digit key (an agent can hand over a passphrase only) and for a saved network given a new
  passphrase; it is put back when the join fails.
- **Errors:** iwd answers `net.connman.iwd.Failed` for a failed handshake, a refused association or authentication
  alike (`station_connect_cb`); on a psk network it is `ErrWrongPassword`, on an open one a plain failure. `NotFound` →
  `ErrNotFound`, `NotSupported` → `ErrNotSupported`, `InvalidFormat`/`NoAgent` → `ErrInvalidPassphrase`, the bus's
  `ServiceUnknown` → `ErrNoIwd`.
- **godbus/dbus v5.2.4** (pure Go, needs only `golang.org/x/sys`, already here) is the D-Bus library; the manager
  doesn't link it (`proto.ValidWifiPassphrase` for the broker). A passphrase is in no error, String or GoString.

## NX-244 The helper's Wi-Fi operations (2026-10-20; brief §2.6)

- `wifi-status` and `wifi-scan` (a fresh scan, at most 10 s, else the last one's networks) are read-only and run
  outside the operation lock: a join takes up to 75 s and the manager asks for the state every few seconds meanwhile.
- `wifi-join {changeId, ssid, passphrase?, hidden?, deadlineSec}` and `wifi-forget {changeId, ssid, deadlineSec}`
  record the network's profile file as it was and the network the station was on in the helper's `state.json` before
  anything changes (root, 0600 in a 0700 directory; it may hold the old passphrase while the change is pending, and goes
  when it is kept or undone), then join (connect ≤ 45 s, then an address from networkd ≤ 30 s) or forget. A failed one
  is undone at once and answered `wrong_password`, `not_found`, `no_address`, `not_supported`, `invalid_passphrase` or
  `wifi_failed`. With `deadlineSec > 0` (guarded) the change stays pending until `wifi-confirm` (keep) or `wifi-revert`
  (undo); `deadlineSec 0` keeps it at once. One pending change (`wifi_pending`); the same change id again is answered
  `alreadyDone` (a lost reply).
- **Undo:** the old profile back, or a network that wasn't saved forgotten through iwd (the file removed when iwd
  doesn't answer); then Connect to the previous network unless the station is on it already (iwd's autoconnect does it
  too); the dead-man disarmed. Every step is best effort.
- Names differ from the brief's list: `wifi-confirm` and `wifi-revert` are operations, `wifi-revert-deadman` is the
  command the dead-man runs (as `revert-network-deadman` is for wired candidates). The helper config gains
  `wifi {dir, bus}` (the helper's config is read only by the helper of the same generation); without `dir` every Wi-Fi
  operation answers `no_wifi`. The unit may write `-/var/lib/iwd`; AF_UNIX already reaches the system bus, and iwd's
  D-Bus policy lets root call it and lets iwd call root's agent. Requests never print or log the passphrase.

## NX-245 The Wi-Fi dead-man (2026-10-20; MG-15's pattern)

A guarded change arms `systemd-run --unit=whombat-wifi-revert --collect --on-active=N whombat-update-helper
wifi-revert-deadman` before anything changes (a timer left from an earlier change is stopped first). N is the join's
own budget (45 s + 30 s), the manager's deadline (which starts once the join is done) and 30 s, so the dead-man never
undoes a change the manager is still confirming, and still undoes it when the manager died. `wifi-confirm` and
`wifi-revert` stop the timer.

## NX-246 What Wi-Fi adds to the image (2026-10-20)

The system closure grows by 3.3 MB (5,290.1 → 5,293.4 MB, `nix path-info -S` of the toplevel before and after): iwd
3.12 is 2.5 MB (everything it needs was in the image already), its units and configuration a few KB, the update
helper 0.5 MB more (godbus and the operations).

## NX-247 A factory reset forgets the saved Wi-Fi networks (2026-10-20)

`whombat-factory-reset` already removed the committed wired network and the helper's records from the system volume;
it now also empties `/var/lib/iwd`, so a box that is reset and passed on keeps none of its old owner's Wi-Fi
passwords. A reset box is unclaimed, so its screen may choose Wi-Fi again (HD-07).

## NX-248 How Wi-Fi is checked (2026-10-20)

- Unit tests with fakes and short timeouts: `helper/pkg/wifi` (iwd's file names and ell's escaping, the object tree,
  the error mapping, the agent answering iwd only, `Fake`), the helper's operations against `wifi.Fake` and the fake
  activator (a wrong password keeps nothing, guarded and unguarded joins, revert, dead-man, no address, hidden networks,
  forget and put back, the passphrase in no error, state or String), the nix activator's dead-man argv, the manager's
  guard through the real helper over its socket (`helpertest` with `wifi.Fake`: committed, failed, `no_internet` revert,
  offline joins kept at once, a restart mid-join, forget and `in_use`, `busy`, the state from a sysfs tree, why Wi-Fi is
  missing, the online cache with an injected clock) and the broker's routes (codes, statuses, no passphrase in an answer).
- `checks.x86_64-linux.wifi` (vm-tests/wifi.nix, table above), in the flake's own VM driver: **passed 2026-10-20**
  on the final tree, nine subtests in 135 s (the revert one 44 s: 30 s to confirm, then back online). Earlier runs
  found two things since fixed: the test framework's VLAN address made the cable look connected, and a second join
  sent during the first one's checks could start after it instead of being answered `busy` (MG-100).
- Not tested here: a real card (the lead checks the Z13, MT7925 on `mt7925e`), WPA3-SAE (iwd does it with the
  passphrase the agent hands over), a hidden network in a VM, roaming between access points, a cable plugged in while on
  Wi-Fi, the installer's Wi-Fi step (stream P).

## NX-255 The desk's sound server: system-wide PipeWire (2026-10-20; Whombat HD-04; supersedes NX-163's “ALSA, no sound server”)

John's Z13 showed Talk but recorded the wrong card: its microphone is a card of its own (`acp-pdm-mic`, NX-179) and
Chromium recorded ALSA's `default`, card 0. Laptops whose microphone a UCM profile switches on (Intel SOF), and USB
headsets plugged in later, need a sound server too (HD-04).

- **`nix/modules/sound.nix`**, `whombat.sound.enable` (default off), imported by kiosk.nix and **on with
  `whombat.kiosk.desk`** (so on every appliance with a graphical console, never on the installer): `services.pipewire`
  with `systemWide`, WirePlumber, the ALSA plugin (`alsa.enable`: ALSA's `default` is PipeWire, so no client opens a card
  behind the server) and the PulseAudio socket (`pulse.enable`); no JACK. `whombat.sound.users` join the `pipewire`
  group: the desk sets `[ "whombat-kiosk" ]`. `whombat.sound.pulseServer` (read-only) is `unix:/run/pulse/native`.
- **System-wide, not per user:** the kiosk's logind session is `user-light` (no `systemd --user`, kiosk.nix), so
  nixpkgs' user units would never run. PipeWire, WirePlumber and pipewire-pulse run as NixOS's `pipewire` user (its
  static uid, groups `audio` and `video`), which opens the cards through the `audio` group. WirePlumber runs nixpkgs'
  `main-systemwide` profile: no logind (it doesn't wait for a seat session of its own user), no device reservation or
  portal (they need a session bus). The sockets are systemd's: `/run/pipewire/pipewire-0` and `/run/pulse/native`, both
  0660 pipewire:pipewire.
- **Started at boot** (`pipewire.service` wanted by multi-user.target; WirePlumber with it): the cards are set up before
  the kiosk's first sound or Talk, not at the first client's connection (socket activation alone).
- **The kiosk:** in the `pipewire` group, and the launcher exports `PULSE_SERVER=unix:/run/pulse/native` before cage
  (Chromium inherits it). A path socket works from the server's private network namespace and on the read-only /run (as
  the desk socket, NX-160); Chromium, built with PulseAudio, talks to pipewire-pulse (`client.api = "pipewire-pulse"`,
  `console-self`). logind's uaccess ACLs on the cards stay; nothing of the kiosk opens them any more. `alsactl init` on
  new cards stays (NX-163).
- **WirePlumber's choices** are the defaults: its device priorities, ACP card profiles and UCM pick the default
  microphone and speaker as on a desktop (HD-04). Off: Bluetooth and the video (camera) monitor
  (`hardware.bluetooth`, `hardware.video-capture`: HD's “not now”, and nothing on the box uses a camera). **Nothing
  kept** (`mixin.stateless`'s hooks off: profiles, routes, default nodes, stream volumes): every boot starts from
  WirePlumber's own choices, like the rest of the box's sound (no `alsactl store`). A speaker starts at **70 %**
  (`whombat.sound.defaultSinkVolume`, pactl's cubic scale; WirePlumber's own default is 40 %): nobody can turn the
  desk up yet, and the spoken answer must be heard across a room; the microphone at WirePlumber's 100 %.
- Not now: choosing the microphone in the app (HD), echo cancellation (Chromium does its own for getUserMedia).

## NX-256 The kernel stays NixOS's LTS (2026-10-20; Whombat HD-02)

*Superseded by NX-340 the same evening (Whombat HD-12): nixpkgs' newest stable kernel on every image.*

- The appliance, the self-installed images and the installer never set `boot.kernelPackages`: they boot nixpkgs'
  default, NixOS 26.05's LTS **6.18** (6.18.53 at c508844), and move when a nixpkgs bump moves it. No second
  “newer hardware” image (`linuxPackages_latest` is 7.2 there).
- A newer kernel only when a machine shows a need the LTS can't meet, and the hardware report (MG-110) says which driver
  is missing (`no_driver`), so it can be read from a customer's box.
- **Checked:** `checks.self-installed-config` asserts the self-installed DEV, the factory appliance and the installer
  all boot `pkgs.linuxPackages`' version.
- *Why:* the newest kernels change every few weeks, so each release would carry a new kernel and its regressions;
  nothing found on the Z13 points at the kernel (its Wi-Fi, sound and graphics drivers are all in 6.18); two kernels
  double what has to be tried.

## NX-257 What the sound server adds to the image (2026-10-20; NX-255)

- **+2.2 MB** to the appliance's system closure: WirePlumber 0.5.14 (2,160,536 bytes) and its configuration and unit
  files (12 KB). PipeWire 1.6.6 itself, libpulseaudio, Lua and the plugins' libraries were already in the closure:
  alsa-utils' plugins (NX-163) bring PipeWire's ALSA plugin, and Chromium links libpulseaudio. Measured on the same
  tree with `whombat.sound.enable` forced off: **5,290,423,208 → 5,292,643,776 bytes (+2,220,568, +0.04 %)**.
- The pipewire package is nixpkgs' (Bluetooth codecs, libcamera and the rest come with it, unused, already in the
  closure); a trimmed build would save nothing here and be built locally for every nixpkgs bump.

## NX-258 How the sound server and the hardware report are checked (2026-10-20; NX-255…NX-257, MG-110…MG-116)

- **`checks.console`:** the sound server with the desk (system-wide PipeWire, WirePlumber, ALSA and the PulseAudio
  socket, no JACK; Bluetooth, cameras and every state hook off; the 70 % default; started at boot; the `pipewire`
  user's groups), the kiosk's user in the `pipewire` group and its launcher exporting `PULSE_SERVER`; none of it on the
  installer or without a graphical console. **`checks.self-installed-config`:** the LTS kernel (NX-256).
- **`console-self`** (`nix build .#checks.x86_64-linux.console-self`, three VMs under TCG, the build users having no
  KVM; 23/23 subtests, the script 540 s), new:
  - PipeWire, WirePlumber and pipewire-pulse's socket up at boot; `/run/pulse/native` 0660 pipewire:pipewire; the
    kiosk's Chromium has `PULSE_SERVER`. As the kiosk's user inside the kiosk's own mount and network namespaces,
    `pactl` sees the emulated HDA card's sink and its source that isn't a monitor (`alsa_input.pci-…analog-stereo`)
    as the defaults, the speaker at 70 %, a second of the microphone (silence) recorded with `parec` and played with
    `pacat`; the runner can't connect; nothing in `/var/lib/pipewire`.
  - The page's chime for a new ask (by day) makes Chromium a client of pipewire-pulse (`client.api =
    "pipewire-pulse"`, “Chromium” and “Chromium input”), nothing records (no source output), and a Black night after
    it still goes dark once nobody has touched the screen for a minute (63 s after the night began). The chime runs
    after the nights subtest: right after a chime the kiosk's idle count starts again, so the nights' first “dark at
    the next poll” would wait a minute more.
  - The hardware report through the manager's socket as the runtime's uid (MG-113), from the VM's real sysfs: `qemu`
    (TCG), the HDA card (`8086:2668`, `snd_hda_intel`, one capture and one playback device), bochs and its connected
    `Virtual-1`, both virtio NICs with their interfaces, the virtio disks with their sizes, the tablet, the USB and
    virtio functions; the helper's `hardware-log` answered (`cfg80211`'s missing `regulatory.db` among its lines); no
    MAC address and not the SMBIOS serial in the answer; root and the runner refused.
  - Everything it checked before still passes.
- **`voice`** (`nix build .#checks.x86_64-linux.voice`, TCG; the script 225 s): with an emulated HDA card held by the
  sound server (WirePlumber has its control device open) the voice health says `microphone` and `speaker` are there;
  the round trip as before (Piper 19.9 s, whisper.cpp 2 min 59 s for 1.7 s of speech, heard “is pve2 okay”).
- **Go:** `go vet` and `go test` of `./helper/...` and `./manager/...` (MG-111, MG-114 list the tests).
- **The image:** `.#appliance-toplevel` builds; NX-257 for its size.

## NX-280 Stay unlocked while you're here: the presence service (2026-10-20; Whombat DK-28…DK-33; stream K of the presence build)

John, 2026-10-20: the desk screen stays unlocked while someone is in front of it and locks 30 s after they leave
(Whombat `docs/decisions/desk-display.md` DK-28). A face only keeps an unlock a PIN or the phone made (DK-29); the camera
is on only while the screen is unlocked with the switch on (DK-30); the box detects, it doesn't recognize (DK-31).

- **`whombat-presence`** (`presence/`, a package tree of the root Go module like `voice/`; `pkgs.whombat-presence` =
  `.#whombat-presence`, its `go test ./presence/...` in the build): HTTP/1.1 JSON on
  `/run/whombat-presence/presence.sock` for the runtime server (the contracts' presence socket, 0.103.0 CT-597), in front
  of one program that holds the camera, **`presence-watch`** (C++, NX-281), with the **YuNet** face detector
  (`pkgs.presence-model`, NX-281).
- **`nix/modules/presence.nix`**, `whombat.presence.enable` (default off; **on in the appliance profile**, as voice, so on
  every appliance; the runtime shows the switch only where health has a camera and a working detector). Options:
  `package`, `watch`, `model`, `memoryMax` ("256M"), `socket` (read-only, for the runtime's env).
- **On demand**, as voice (NX-175): the socket is systemd's, the service starts at the runtime's first request and stays
  (a Go process holding no camera); the camera program runs only while watched.
- **The contract**: contracts-go 0.103.0 is vendored (`10a25c1`, tree `333351f`; it carries 0.102.0's hardware and Wi-Fi
  types too, which this branch didn't have) and the service uses its `local` presence types directly (`PresenceHealth`,
  `PresenceWatch`, `PresenceState`, `ParsePresence*`, `PresencePath*`, `PresenceKeepS`, `PresenceRequestMaxBytes`,
  `PresenceError*`); no stand-in types were needed.

## NX-281 `presence-watch` and the model (2026-10-20; DK-31, DK-33)

- **One C++17 file of ours** (`nix/packages/presence-engine/presence-watch.cpp`, about 1 000 lines, `-Wall -Wextra
  -Werror`) linked with nixpkgs' **ONNX Runtime 1.24.4** (the build `piper-speak` links) and **libjpeg-turbo 3.1.4**'s
  TurboJPEG API (already in the image for Chromium and others): both libraries were in the closure, so the program adds
  123 KiB. Not OpenCV (`FaceDetectorYN` is what YuNet was made for, but OpenCV with its DNN module is hundreds of MiB).
- **Capture**: V4L2, four mmap buffers, at the **smallest size at least 320 wide** the camera offers in YUYV, MJPEG
  (or JPEG) or GREY (the cheaper format first at the same size: YUYV needs no decoding; when none is that wide, the
  largest), asking for 5 frames a second (a longer exposure in a dim room; a camera that can't keeps its nearest rate).
  **About two checks a second** (`--interval-ms 500`): the frames between are handed back unread. MJPEG is decoded at the
  smallest libjpeg-turbo scale still 320 wide; frames without Huffman tables get the standard ones (libjpeg-turbo does
  that by itself); a frame cut short (a warning) still counts.
- **Detection**: each frame is scaled to **320 wide** (a box filter) and put at the top left of YuNet's **fixed 640×640
  input**, black elsewhere (as `FaceDetectorYN` pads), BGR, 0–255, NCHW; the outputs are decoded as OpenCV does (score
  = √(cls × obj), clamped; the box from `bbox_*` per stride 8/16/32), boxes whose centre lies in the black ignored. No
  NMS: only the best score matters. The model's fixed shape is kept rather than edited to the frame's size: at 640×640 a
  check takes **3.5 ms** on one core of The Titan (`intra_op_num_threads` 1; 0.75 ms at 320×256, not worth a modified
  model), and 320 wide inside 640 keeps faces from 24 to about 200 px, inside YuNet's 10–300 px.
- **Output**: one JSON line per check, `{"t":…,"face":…,"score":0.91,"luma":87}` (`luma` the frame's mean brightness,
  BT.601), and one line when the camera opens (`camera`, `format`, `width`, `height`). Exits 0 when stdin closes or on
  SIGTERM (blocked except inside `ppoll`, so a check finishes), 1 on an error (one stderr line), 2 for a wrong command
  line, **3 when the camera gives no picture for 5 s (10 s for the first)**. Frames live in its memory only.
- **Test modes**: `--probe` (a line per capture device: path, name, driver, bus, formats, `kind` colour/infrared,
  `rear`, `usable`, and the format and size watching would use), `--self-test` (loads the model, checks a black frame),
  `--frames DIR|FILE [--repeat]` (binary PGM/PPM or JPEG pictures instead of a camera, a line each with `file`, the face's
  `height` and `ms`; `--repeat` goes round them at the interval until stdin closes, as a camera would).
- **Model**: **`face_detection_yunet_2023mar.onnx`**, 232 589 bytes, sha256 `8f2383e4…04ed2552fa4` (the Git LFS object
  id in both opencv_zoo and Hugging Face's opencv/face_detection_yunet), from `huggingface.co/opencv/face_detection_yunet`
  at revision `3cc26e7f` (2025-06-20, the newest on 2026-10-20), fixed-output, with its `LICENSE` (MIT, Shiqi Yu) beside
  it in `presence-model-yunet-2023mar` (no `whombat-` prefix: the secret scan skips it). Unmodified.
- **Measured** (The Titan, `--frames` on the calibration pictures): 3–7 ms per check with decoding and scaling, the same
  pinned to one CPU; **peak RSS 59 MiB** (41 MiB for the self-test); model load and self-test 30 ms.

## NX-282 What counts as a face, and as dark (2026-10-20; DK-28, DK-32)

Measured with presence-watch on public-domain and CC0 pictures (NX-287's, plus variants: the astronaut's head and
shoulders at 13–100 % of a 320×240 frame, darkened to 3–100 %, grey):

| Picture | best score | face height at 320 wide |
|---|---|---|
| a portrait, a crew of seven, grey (infrared-like), JPEG | 0.91–0.94 | 38–181 px |
| the same face 27 / 20 / 17 / 14 px tall | 0.90 / 0.86 / 0.75 / 0.70 | |
| darkened to mean brightness 6–26 | 0.87–0.93 | |
| darkened to mean brightness 3 | 0.03 | |
| a coffee cup / a cat / a rocket, black, white, noise | 0.55 / 0.42 / ≤ 0.05 | |

- **A face: a score of at least 0.7** (`--threshold`; the brief's start was 0.6, but the coffee cup reached 0.55: 0.7
  keeps 0.15 from the worst non-face and 0.16 under the faces) **and a box at least 24 px tall** at 320 wide
  (`--min-height`): about two metres from a laptop's camera; a face across the room (17 px) or on a far wall doesn't keep
  the screen unlocked. Real webcam frames are noisier and blurrier than these pictures: the Z13 is where the margin is
  confirmed (NX-289). The service can override the threshold (`--threshold`), the unit doesn't.
- **Dark: a checked frame with no face and a mean brightness under 40** (of 255; `watch.Config.DarkLuma`), decided by the
  service from the numbers. YuNet still found the synthetic darkened face at brightness 6, but a real dark room gives a
  noisy, gained-up picture where it won't: a picture that dark with no face is “can't tell”, which the runtime treats as
  no camera (DK-04's 2 minutes), the safe side. A face in a dim frame is a face (`watching`). The first frames while the
  exposure settles may read `dark` for a moment; nothing hangs on that (the infrared switch waits 10 s).

## NX-283 The socket and the camera's lifetime (2026-10-20; DK-30, DK-33; contracts CT-597)

- `GET /v1/presence/health` → `{v:1, camera, detector}`; `POST /v1/presence/watch {v:1}` → `{v:1, state, face, seenAt?,
  frameAt?}`; `POST /v1/presence/stop {v:1}` → `{v:1}`. Requests strict (`local.ParsePresence*Request`: no other member,
  `v` = 1) and at most 1 KiB (413 `too_large`); not one → 400 `bad_request`; wrong path 404 and method 405, both
  `bad_request`; a peer but root and the server 403 `forbidden` (`--allow-uid 0,951`, as voice).
- **`detector`** is `presence-watch --self-test` at the service's start; without it a watch is **503 `unavailable`**
  (nothing to watch with), so the runtime never turns the camera on for nothing. **`camera`**: the probe found a capture
  device it can stream from. A watch with none answers `no_camera`.
- **A watch** turns the camera on when it is off (`starting` until the first checked frame) and keeps it on **6 s**
  (`PRESENCE_KEEP_S`) more; **stop**, the keep running out, or the program's exit turn it off: stdin closed and SIGTERM,
  **SIGKILL after 1 s**. Stopping the service stops the program first (it waits up to 2 s). If the service dies, the
  program's stdin closes and it exits.
- **A session** is from the first watch to the stop or the keep's end. `seenAt` is the last frame with a face in the
  session, `frameAt` the last checked frame; both are the service's clock when the line arrived (RFC 3339, ms, UTC), not
  the program's `t`, and both start empty in each session: an older face never reaches a new unlock (the server's own
  rule, in `desk-display-server.md`, is that a face counts only after the unlock).
- **Failure**: the program exits on its own, gives no first picture within 10 s, or none for 5 s (the program also exits
  3 then): `failed`. **It is started again no sooner than 30 s after the failure**, at the first watch after that;
  meanwhile watches answer `failed` (the runtime falls back to DK-04's 2 minutes). The 30 s hold through a stop and a new
  session, so a camera that fails at once is opened twice a minute at most. A program that won't start (exec fails) has
  failed the same way.
- **The probe runs only when the devices change**: health and watches read the names in `/sys/class/video4linux` (no
  device opened) and re-run `presence-watch --probe` only when that list differs (a camera plugged in or out), or a
  minute after a probe that failed. The probe opens each `/dev/video*` for `VIDIOC_QUERYCAP` and the format lists, never
  streams, so no light comes on.
- **The journal** gets the camera's name and format when it opens, why it went off and after how long, failures and the
  switches between cameras; never a score, a face count or a picture (asserted by `presence-detect`).

## NX-284 Which camera (2026-10-20; DK-32)

- presence-watch's probe guesses: **infrared** when every format the device lists is a grey one (GREY, Y10, Y12, Y16,
  Y8I, Z16, …: what Windows Hello cameras send) or its name has the word “IR” or “infrared”; **rear** when its name has
  “rear”, “back” or “world”, or the sensor's `V4L2_CID_CAMERA_ORIENTATION` says back (UVC cameras have no such control).
  Metadata nodes, codecs (M2M) and output devices aren't listed; a device without YUYV, MJPEG or GREY isn't usable.
- **Order**: front colour, front infrared, rear colour, rear infrared; the probe's order (device number) within each. The
  first is the camera (an infrared one when that's all there is; a rear one only when nothing else is).
- **Colour → infrared**: when the colour camera's picture has been `dark` for **10 s** and there is an infrared camera,
  the service turns to it, **once a session**. It hands back to the colour camera when the infrared one gives no picture
  within **5 s** (its emitter may need a vendor command, DK-35), stays dark for 10 s too, exits, or won't start, none of
  which counts as a failure. A new session starts with the colour camera again. Never two cameras at once (DK-35).

## NX-285 The account, the socket and the unit (2026-10-20; NX-180)

- **`whombat-presence`, uid/gid 967** (`whombat.ids`, after voice's 966; free on every appliance branch on 2026-10-20),
  no login, no groups of its own: the camera's group is the unit's.
- **Socket** `/run/whombat-presence/presence.sock`, `whombat-presence.socket`, **0660 whombat-presence:whombat**,
  directory 0755, as voice's (NX-180).
- **Sandbox**: voice's (no network: `PrivateNetwork`, `IPAddressDeny=any`, AF_UNIX only; no capabilities,
  `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, kernel and clock protections, `ProtectProc=invisible`
  without `ProcSubset` as voice (ONNX Runtime reads the processor's description), /persist inaccessible,
  `MemoryDenyWriteExecute`, `@system-service` without `@privileged @resources`, `SystemCallErrorNumber=EPERM`), with the
  camera instead of `PrivateDevices`: **`PrivateDevices=false`, `DevicePolicy=closed`, `DeviceAllow=char-video4linux rw`,
  `SupplementaryGroups=video`** (udev makes `/dev/video*` root:video 0660). **Nothing writable**: no tmpfs, no state or
  runtime directory: it writes nothing (DK-31). `TasksMax=64`, `CPUWeight=20`, `IOWeight=20`, `MemorySwapMax=0`,
  `Restart=on-failure`, `TimeoutStopSec=10s`.
- **Memory cap 256M**: measured, the service peaks at **43 MiB** (Go and the contracts' compiled schemas) and
  presence-watch at **59 MiB**; 256M is about 2.5 times both.
- **The camera is this service's alone**: systemd's `70-uaccess.rules` tags video4linux nodes, which gives the active
  seat session an ACL on them, and the kiosk has a logind session on seat0 (kiosk.nix). `72-whombat-camera.rules`
  (`SUBSYSTEM=="video4linux", TAG-="uaccess"`, before `73-seat-late.rules` applies the tag; `udevadm verify` accepts it)
  removes that, so the kiosk can't open the camera below its browser, whose `VideoCaptureAllowed = false` stays. No
  account is in the `video` group.
- **Kernel**: the appliance's 6.18.53 has `uvcvideo` as a module (`drivers/media/usb/uvc/uvcvideo.ko.xz`), loaded by its
  USB id, and nothing blacklists it (`presence-config`).

## NX-286 What the runtime gets (2026-10-20; for stream S)

- The runtime **server** (not the runner) gets `WHOMBAT_PRESENCE_SOCKET=/run/whombat-presence/presence.sock` when
  `whombat.presence.enable` is on, in `nix/modules/runtime.nix` beside `WHOMBAT_VOICE_SOCKET`, and nothing else: no
  group, no path, no ordering (NX-184's reasoning). Unset, the runtime has no presence (no switch).
- The dev stack runs no presence service; the runtime's fake (`WHOMBAT_PRESENCE=fake`, stream S) stands in.
- What the runtime may rely on: `starting`/`dark`/`failed`/`no_camera` never carry `face: true`; `seenAt` and `frameAt`
  belong to the current session (empty after the keep ran out or a stop); an answer comes at once (the watch never
  waits for a frame); `unavailable` only when the detector failed its self-test.

## NX-287 How it is checked (2026-10-20)

- **Go** (`go test ./presence/...`, in the package's build): the watcher with a fake clock and a fake program (start,
  answers from frames, the keep, stop, a stale keep timer, late lines of a stopped program, failure and the 30 s, a
  program that won't start, no camera, no first picture, a stall, dark, colour → infrared and every way back, Close),
  the program against the test binary as a fake presence-watch (lines to events, `--threshold` passed on, stop, SIGKILL
  for one that ignores SIGTERM, the last stderr line on a failure, probe and self-test), the probe's parsing, order and
  cache, and the socket (every answer checked with the contract's `Parse…`, every refusal, 503 without a detector, the
  peer check on a real socket).
- **`checks.x86_64-linux.presence-detect`** (`nix/checks/presence.nix`, the build sandbox, no VM and no camera): the
  self-test; faces found (score ≥ 0.85) in Eileen Collins' NASA portrait, the STS-61 crew's JPEG (libjpeg-turbo) and
  its grey version (the infrared path), and the portrait about 40 px tall; none in Chelsea the cat, the coffee cup
  (both CC0), a black frame, the portrait at 1 % brightness or a face 17 px tall; then the whole service with a folder of
  pictures as its camera (`--frames`, checks only): health `{camera, detector}`, a watch `starting` then `watching` with
  a face and both stamps, a stop that leaves no presence-watch process, a strict request refused, a dark folder that
  answers `dark`, no camera at all (`camera: false`, `no_camera`), and no score in its log. The pictures are fetched by
  hash (scikit-image at `b700edc8`, images.nasa.gov) and credited in `presence/NOTICES.md`.
- **`checks.x86_64-linux.presence-config`**: on in the hardware, DEV and PROD appliances, gone when off (the runtime's
  variable too); the socket's path, mode and owners; the account's ids (unique, no groups); the server's variable and
  not the runner's; the unit's sandbox, device policy, group, nothing writable, limits and arguments (no `--frames`);
  the kiosk's camera policy; the uaccess rule; `uvcvideo` in the modules tree and not blacklisted; the model's free
  licence and name. Both join `scripts/ci/nix-checks.sh`.
- No VM test: the brief asked for none, and a VM has no camera either (a test with the kernel's `vivid` virtual camera
  would exercise V4L2 for real; noted for later).

## NX-288 What presence adds to the image, and the licences (2026-10-20)

- **+8.2 MiB** to the appliance's system closure (5 289 770 240 → 5 298 353 752 bytes): `whombat-presence` 7.6 MiB (Go
  with the contracts' embedded schemas and validator, as `whombat-voice`), the model 0.23 MiB, `presence-watch` 0.12 MiB,
  units and rules a few KiB; ONNX Runtime, protobuf, Abseil and libjpeg-turbo were already there. The other 0.3 MiB are
  contracts-go 0.103.0 in the Go programs that were rebuilt with it (manager, backup, console, helper, voice, provision).
  The DEV and PROD images and the installer ISO grow the same.
- **Licences** (`presence/NOTICES.md`, installed as `share/whombat-presence/NOTICES.md`, as voice's): YuNet MIT (its
  LICENSE also beside the model), ONNX Runtime MIT, libjpeg-turbo's IJG, BSD-3-Clause and zlib licences with the IJG
  sentence and the BSD text its TurboJPEG API asks for in binary distributions, and the check's pictures (NASA public
  domain, CC0). `presence-watch.cpp` is this repository's (nothing copyleft is linked). The appliance has no licence
  screen; NOTICES files are where voice's are listed too.

## NX-289 What only a real machine can show (2026-10-20; for the Z13)

This machine has no camera; on the Z13 (or any box with a camera), with the switch on:

- `presence-watch --probe` (as root, or `systemd-run -p SupplementaryGroups=video …`) lists the front colour camera as
  `colour`, usable, at 320×240 or the next size up, and the IR camera as `infrared`; the rear (AMD ISP4) isn't there.
- The camera's light is on exactly while the screen is unlocked with the switch on, and off within about 6 s of every
  lock (DK-30); `journalctl -u whombat-presence` shows “camera on … / camera off after …”.
- Scores in front of the screen at a desk: well above 0.7 head-on, and with the head turned or looking down at the
  keyboard (the case that would lock someone out after 30 s); nothing that keeps the screen unlocked when nobody is
  there (a poster, a photo on the desk is DK-28's known limit). Lower the threshold if a seated person drops out.
- A dim and a dark room: when the colour picture goes `dark` and after 10 s the IR camera is tried; whether its emitter
  lights without the vendor command (DK-35) and whether it gives a picture, or hands back after 5 s.
- CPU and memory on a small box (two checks a second should be about 1 % of a core), and that the unit's sandbox lets
  V4L2 and MJPEG decoding through (`MemoryDenyWriteExecute`, the syscall filter, `DevicePolicy=closed`).
- The kiosk can't open the camera (`getfacl /dev/video0` shows no ACL for whombat-kiosk).

## NX-290 The Incus agent only inside an Incus VM: skipped elsewhere, not failed (2026-10-20; amends NX-143)

John, 2026-10-20, starting the desk appliance (the Z13, bare metal on the DEV image): “Failed to start Incus - Agent”.
NX-143 said the agent never starts outside Incus because only Incus's virtio port starts it (the loader's udev rule).
NixOS's module also puts `incus-agent.service` in `multi-user.target`'s wants, so every DEV box started it at boot: the
setup found no config drive (“Couldn't mount 9p or cdrom, failing”) and `Restart=on-failure` tried again every 5 s
until the start limit (10 in 60 s), a failed line on the screen each time. Harmless (nothing waits for it: the start
job fails at once, `multi-user.target` only wants it; the manager's health doesn't count failed units), but it looked
like a fault on the screen people see first.

- **What:** `dev-instance.nix` gives the unit `ConditionPathExists=/dev/virtio-ports/org.linuxcontainers.incus`. On
  bare metal, Proxmox or any other hypervisor the unit is skipped quietly (“condition unmet”, no failure, no retries).
  In an Incus VM the port is always there: if `multi-user.target` asks before udev has made the link, the unit is
  skipped then and the udev rule starts it when the port appears, as the loader intends.
- **Not chosen:** dropping the `wantedBy` (the same result, but it overrides nixpkgs' wiring rather than adding to it);
  `ConditionVirtualization=vm` (a Proxmox VM would still fail the setup).
- Checked: `checks.self-installed-config` asserts the condition on the DEV image. Reaches a box with its next DEV host release.

## NX-291 Text to speech with Kokoro instead of Piper (2026-10-20; supersedes NX-178's voice and NX-185's program)

John, 2026-10-20: “the voice is really bad”; asked for the options with local models, then “Implement your
suggestion”. Piper's public-domain “ljspeech” voice (NX-178) was chosen for its licence, not its sound, and Piper's
VITS voices are robotic at best. Kokoro v1.0 (hexgrad/Kokoro-82M, 82 M parameters, StyleTTS 2-based, Apache-2.0
weights trained on public-domain and permissively licensed audio) sounds far more natural and still runs on the CPU of
any box, VMs included.

- **`kokoro-speak`** (`pkgs.voice-kokoro`, `nix/packages/voice-engines`): our program (`kokoro-speak.cpp`, about 200
  lines) on **sherpa-onnx's C library** (nixpkgs' `sherpa-onnx` 1.12.38, Apache-2.0, on nixpkgs' onnxruntime 1.24.4,
  the one presence-watch also uses). sherpa-onnx is built without its Python module and websocket server; only
  `libsherpa-onnx-c-api.so` (5 MiB, sherpa-onnx's own code, eSpeak NG and its other small libraries inside) is copied
  into the package, and `disallowedReferences` keeps sherpa-onnx's store path (its programs pull ALSA; 164 MiB) and
  eSpeak NG's out of the closure. Its front end looks words up in Kokoro's US English lexicon (misaki's dictionaries)
  and gives the rest to eSpeak NG; the English data is nixpkgs' eSpeak NG 1.52 data (the same subset piper-speak
  carried, 1.5 MB), which sherpa-onnx's copy of eSpeak NG reads as its own (`Wrong version of espeak-ng-data` never
  showed; numbers, “−5 °C”, “91%” and server names came out right).
- **The same interface for the service** as piper-speak: `kokoro-speak --model DIR --speaker N --threads N
  --output-file OUT.wav`, the text on stdin (at most 64 KiB, never an argument), a 16-bit mono WAV at the model's
  **24 kHz**. Curly apostrophes become straight ones first (the lexicon knows “I'd”, not “I’d”: Piper said “I clear”).
  sherpa-onnx makes one sentence at a time (`max_num_sentences` 1) with its usual 0.2 silence scale between them.
- **One gain per answer, peak at −3 dBFS** (amends NX-185's per-sentence peak normalisation): Piper's way raised every
  sentence to full scale on its own, so loudness jumped from sentence to sentence and the answer sat at 0 dBFS (sox
  clipped two samples resampling one). Now every answer is equally loud, no sentence louder than the next, with room
  for small speakers.
- **Not taken**: a warm process. Loading the model and the lexicon takes 0.72–0.74 s of every answer (“Hi.” in all),
  as Piper's session did (NX-185); held between answers it would keep 550 MB of a box that is rarely talked to, for
  0.7 s of a talk that waits seconds for the assistant (NX-178's reasoning); Pocket TTS (Kyutai, CC BY 4.0, gated download, PyTorch in the image);
  Chatterbox Turbo, Qwen3-TTS and Orpheus (they want a GPU; the image has none, NX-169); XTTS-v2, F5-TTS, Fish Audio,
  ChatTTS, OmniVoice and IndexTTS (non-commercial licences); Supertonic (use-limited licence, archived).
- **Licence**: `kokoro-speak` links sherpa-onnx's library, which carries eSpeak NG (GPL-3.0-or-later), so
  `kokoro-speak.cpp` is **GPL-3.0-only** like piper-speak.cpp before it (NX-185), still the one GPL file of this
  repository; libpiper (GPL-3.0-only) is gone. `whombat-voice` runs it as a separate program and stays ours
  (`voice/NOTICES.md`).

## NX-292 The model: Kokoro v1.0 fp32 as sherpa-onnx packs it, the voice af_heart (2026-10-20)

- **From `huggingface.co/csukuangfj/kokoro-multi-lang-v1_0` at revision `f7b96bb6`** (2026-09-08, sherpa-onnx's
  packing of v1.0, the newest on 2026-10-20), fixed-output, one `fetchurl` per file as for whisper (`pkgs.voice-kokoro-model`,
  `kokoro-v1_0-en/`): `model.onnx` (325 560 556 bytes, sha256 `b40f62b1…6305da11`, the model with sherpa-onnx's
  metadata: 24 kHz, 54 speakers, style 510×1×256), `voices.bin` (28 MiB, all 54 voices: sherpa-onnx reads the table
  whole), `tokens.txt`, `lexicon-us-en.txt` (5.7 MiB) and the repository's Apache-2.0 `LICENSE`. Left out: the Chinese
  and British lexicons, the Chinese number rules and the repository's eSpeak NG data. A Hugging Face revision is a
  commit, so the URL can't change under the hash (the GitHub release of the same files was replaced on 2026-09-08).
- **fp32, not int8**: on 4 cores of The Titan the int8 model (114 MB) took 2.5 s where fp32 takes 1.1 s for the same
  two sentences (dynamic quantisation is slow on these CPUs), and quantising costs quality. Its 300 MB less doesn't buy
  that.
- **The voice `af_heart`** (number 3; US English, female), Kokoro's best-rated voice. `whombat.voice.kokoro.voice`
  chooses another of the model's US English voices by name (`af_heart`, `af_bella`, `am_michael`, `am_fenrir`;
  `passthru.speakers`, from the model's `speaker2id`); the unit gets the number (`--kokoro-speaker 3`). A choice in
  Whombat's Settings would be a contracts change (the voice request names no voice): not now.

## NX-293 Measured (2026-10-20)

On The Titan (Ryzen Threadripper 9970X, pinned with `taskset`, 3 runs each; the DEV VM has 4 vCPUs of it, the Z13 16
Zen 5 cores), whisper.cpp hearing the answer back at 16 kHz:

| | Piper ljspeech (before) | Kokoro fp32, 4 threads |
|---|---|---|
| “NAS 1 is using 91% of its storage. I’d clear the old snapshots.” | 0.71 s for 6.2 s of audio; heard “I clear” | 1.13 s for 4.7 s; heard every word |
| “pve-02 is fine. It has been up for 41 days and its disks are healthy.” | 0.70 s for 6.2 s | 1.14 s for 4.8 s (“PVE02”) |
| “Is pve two okay?” | 0.64 s | 0.77 s |
| Peak memory | 134–244 MB | 455–551 MB |

A 503-character answer (30 s of speech, 1.4 MB): 9.9 s on 1 core, 6.0 s on 2, 4.0 s on 4, 3.2 s on 8; peak 551 MB.
The longest answer (600 code points, about 36 s) fits the contract's 6 MiB (`VoiceTtsWavMaxBytes`) and the runtime's
30 s wait (DK-T02) on any machine with two cores. `MemoryMax` stays **1G** (one job at a time: whisper near 470 MB or
Kokoro near 550 MB). Kokoro speaks a little faster than ljspeech (4.7 s against 6.2 s for the same sentence).

## NX-294 What it adds to the image (2026-10-20; amends NX-187)

The Piper voice (61 MiB) and piper-speak (1.7 MiB) leave; Kokoro's files (about 360 MiB: the model 310, the voices
27, the lexicon 6) and `kokoro-speak` with sherpa-onnx's library (about 7 MiB with its English eSpeak NG data) come
in; onnxruntime was already there. Measured on the appliance's system closure: **5 304 355 368 → 5 604 947 144 bytes,
+287 MiB** (+5.7 %). A host release downloads the new paths once (mostly the 310 MiB model).

## NX-295 How it is checked (2026-10-20; amends NX-183, NX-188)

- **Go**: the engine runs the test binary as a fake `kokoro-speak` (a model directory per mode; the speaker and the
  threads reach it; garbage, nothing, failure and a timeout are errors and leave no job files) and `Ready` wants the
  program, a speaker and each of the model's four files.
- **`checks.voice-speech`**: Kokoro says “Is pve two okay?” through the service: a 16-bit mono **24 kHz** WAV whose
  peak is −3 dBFS, and whisper.cpp hears `pve`, `2`/`two` and `ok` in it; the 24 kHz answer sent as speech is
  `bad_audio`.
- **`checks.voice-config`**: `/bin/kokoro-speak` and `--kokoro-speaker 3` in the unit, the model's free licence.
- **The `voice` VM test**: the round trip expects 24 kHz.

## NX-296 Checked (2026-10-20)

- `go vet ./voice/...` and `go test ./voice/...`; `nix build` of `voice-kokoro` (its install check), `voice-kokoro-model`,
  `whombat-voice`, the appliance's toplevel, `checks.eval-aarch64`, `checks.voice-speech` (through the service: “Is pve two okay?” in 760 ms, 1.47 s of 24 kHz audio,
  peak 0.708, heard “Is pve2 okay?”; silence `""`) and `checks.voice-config`. `kokoro-speak`'s closure is itself
  (with sherpa-onnx's library and the English data) and onnxruntime's, which the image already has.
- Not run, by the DEV rule (IN-132): the `voice` VM test. The unit's sandbox (`MemoryDenyWriteExecute`, the syscall
  filter, the 1G cap) was checked on John's DEV box instead (4 vCPUs, `whombat-dev-20261020.6`, IN-329): through the
  socket as root, the first answer after the update (63 characters) in 1.62 s cold, 543 characters (30 s of speech,
  2.0 MB of JSON) in 4.43–4.92 s; `memory.peak` 956 MiB of which 404 MiB is the model's page cache (reclaimable;
  anonymous memory about 550 MB), `memory.events` max 0 and oom 0. `MemoryMax` stays 1G.

## NX-300 Kokoro's own lexicon, not eSpeak NG for every word (2026-10-20; amends NX-291)

NX-291 set sherpa-onnx's `lang` to `en-us`. Reading sherpa-onnx 1.12.38 (`kokoro-multi-lang-lexicon.cc`) while adding
the British voices: with a language set, it hands **every word** to eSpeak NG and never looks in the lexicon; without
one it looks each word up in the lexicon (misaki's pronunciations, what Kokoro was trained on) and asks eSpeak NG only
for the words it lacks. Confirmed by output: with `lang` unset, the US and the British lexicon give different audio;
with `lang` `en-us` the lexicon makes no difference, and `en-gb` aborts in eSpeak NG. So `kokoro-speak` sets no
`lang`. whisper.cpp still hears the five test sentences word for word; an answer takes 0.1–0.4 s longer (the lexicon is
read at every start: 1.07–1.56 s for two sentences on 4 cores).

## NX-301 Six voices, two accents (2026-10-20; Whombat DK-50, contracts CT-614)

John, 2026-10-20: choose the desk's voice in Settings. The model's `passthru.deskVoices` names them as the desk does
(contracts `DESK_VOICES`), with Kokoro's number and accent: `heart` 3 (af_heart), `bella` 2 (af_bella), `michael` 16
(am_michael), `fenrir` 14 (am_fenrir), all `us`; `emma` 21 (bf_emma), `george` 26 (bm_george), `gb` — Kokoro's
best-rated voices of each kind. `kokoro-speak --accent us|gb` picks `lexicon-us-en.txt` or `lexicon-gb-en.txt`; the
British lexicon (6.4 MB, `kokoroFile "lexicon-gb-en.txt"`, same pinned revision) joins the model package. Words outside
a lexicon go to eSpeak NG's American English either way.

## NX-302 The voice socket names its voices (2026-10-20; contracts 0.105.0 CT-614)

- `whombat-voice --kokoro-voices name=speaker:accent,…` (the default first; `whombat.voice.kokoro.voice`, default
  `heart`, is put first by the module), replacing `--kokoro-speaker`. Parsed strictly (names as the contract's
  `VoiceName`, accents `us`/`gb`, no repeats).
- The health's `voices` lists them, default first, whenever text to speech works; `POST /v1/voice/tts` takes `voice`
  (one of them; another is 400 `bad_request` and never reaches the engine; absent: the default).
- contracts-go 0.105.0 vendored (tree `8d5279e`, the release's reproducible tree), its new `vendorHash`.

## NX-303 Checked (2026-10-20)

`go vet` and `go test ./voice/...` (the voices' parsing, each voice's number and accent reaching the program, an
unknown voice, the health with and without text to speech, a lexicon per accent); `checks.voice-speech` (the health
lists the six voices; Kokoro's default says “Is pve two okay?”, heard “Is pve2 okay?”; `emma` says “The backup
finished.” in 0.70 s, heard “the backup finished.”; an unknown voice 400), `checks.voice-config`, `checks.eval-aarch64`
and the appliance toplevel: **5 611 397 104 bytes**, +6.2 MiB for the British lexicon (NX-294: 5 604 947 144).

## NX-304 Awake while a sign-in's code shows (2026-10-20; Whombat signin-at-box.md BX-06; console-gui.md CG-152; amends NX-147, NX-162, NX-170)

A device that isn't let in can ask the box to show six letters on its own screen (BX-02); the screen must then be
lit wherever it was. The console server's `/api/state` carries the sign-in as `claim.signIn` while it is live (CG-151).

- The sleeping loop's mode query reads it first, paired or not: `.claim.signIn != null` → `signin` (with or without
  `whombat.kiosk.desk`). `signin` never sleeps, takes the day's backlight (a paired screen in quiet hours comes up from
  `brightness.night` or off, and goes back when the code goes), and keeps the desk's held mode as it was (a sign-in
  needs the runtime, so `held` never meets it).
- **Asleep, it wakes**: the asleep loop's 10 s poll sees a mode that doesn't sleep and starts Chromium (“a device asks
  to sign in; the screen shows its code”), so the letters show within about 15 s (the poll and Chromium's 2–4 s start).
  The page itself wakes its own dim (CG-152).
- Afterwards, as before: a claimed, unpaired box sleeps again after 12 claimed polls once idle (the panel's two
  minutes of grace); Black in quiet hours a minute after the last input.
- **Checked:** `checks.console` runs the query on a sign-in in quiet hours set to Black (locked), unpaired and without a
  desk (`signin claimed` each), finds the `signin` case in the loop, and feeds the console's own `--once --json` for a
  claimed file with a sign-in to the query (`signin claimed`).

## NX-320 The runtime gets the boot id (2026-10-20; Whombat DK-75)

*Lock again: When you press Lock* (DK-74) keeps an unlock through a runtime restart on the same boot and never through a
reboot (DK-75): the runtime writes this boot's id with the unlock and restores it only when the id matches. Its unit
has `ProcSubset=pid`, which hides `/proc/sys/kernel/random/boot_id`, so `whombat-server` gets `WHOMBAT_BOOT_ID=%b`
(systemd expands `%b` to the same id) beside `WHOMBAT_DESK_SOCKET`, only where there is a graphical console (a desk);
the runner doesn't get it. The runtime reads the variable first. **Checked:** `checks.console` asserts it on the server
with a graphical console and its absence without one and on the runner.

## NX-340 The newest stable kernel on every image (2026-10-20; Whombat HD-12; supersedes NX-256)

John, 2026-10-20: “For maximum compatibility with newer computers, laptops, and tablets, I think we should consider
using the latest kernel that NixOS provides us instead of the LTS. We don't really care about the long-term support
because we will update frequently anyway.”

- **`nix/modules/kernel.nix`**: `boot.kernelPackages = pkgs.linuxPackages_latest` (**7.2.7** at c508844; the LTS was
  6.18.53). Imported by `nix/modules/default.nix` (the appliance on every platform), the installer (`installer.nix`)
  and the recovery environment (`recovery.nix`), so all three find the same disks and cards. It moves with each nixpkgs
  bump, as the LTS's point releases did; a new major line (7.3, …) arrives the same way, when nixpkgs' stable branch
  moves `linuxPackages_latest`.
- Nothing in the image is built against the kernel: no out-of-tree modules, no ZFS (btrfs and ext4 only, `storage.nix`),
  so no bump waits for a module to catch up. The kernel and its modules are cache.nixos.org's (no local kernel build).
- A kernel that doesn't boot is undone by boot counting (the previous generation comes back); one that boots but
  loses a device shows in the hardware report (MG-110).
- *Why:* new laptops, tablets and mini PCs need the newest drivers (Wi-Fi 7 cards such as the Z13's MT7925, Intel BE200
  on `iwlmld`, Qualcomm WCN7850 on `ath12k`; AMD Strix Halo and RDNA 4, Intel Lunar Lake, Battlemage and Panther Lake
  graphics; Realtek 2.5/5 GbE and USB Wi-Fi on `rtw89`; SOF sound), and a box takes an update every few weeks, so the
  LTS's slower pace buys nothing here.

## NX-341 Every disk the installer sees boots (2026-10-20; HD-12)

The installer's ISO boots with nixpkgs' “most hardware” initrd and then loads any module udev asks for, so it lists
disks the installed system's initrd couldn't open (the same failure NX-92 fixed for Intel VMD).

- **`appliance.nix`**: `hardware.enableAllHardware = true` (nixpkgs' list: older SATA and PATA controllers, `hpsa`,
  `mptspi`, `3w-*`, `arcmsr`, the virtual disks and consoles of VMs) and, beyond it, servers' controllers and other
  hypervisors' disks: `mpt3sas` (LSI/Broadcom SAS HBAs), `mpi3mr` (Broadcom tri-mode), `megaraid_sas` (MegaRAID, Dell
  PERC), `smartpqi` (HPE Smart Array), `aacraid` (Adaptec), `ufshcd-pci` (UFS on some small x86 machines),
  `vmw_pvscsi`, `hv_storvsc`, `xen-blkfront`.
- The initrd grows from 45.6 MB (6.18.53) to **48.3 MB** (7.2.7 with these).

## NX-342 Wi-Fi: no power saving, USB sticks, on at every start (2026-10-20; HD-12)

- **No power saving** on any card (`[DriverQuirks] PowerSaveDisable=*` in iwd's `main.conf`): a box is always on and
  mostly on mains power, and power saving is behind most of the drops and slow answers some drivers have (Realtek's
  `rtw88`/`rtw89`, MediaTek's `mt7921`/`mt7925`). iwd keeps its own `DefaultInterface` list for the drivers that
  mustn't lose their default interface (`rtl81*`, `rtl87*`, `rtl88*`, `rtw_*`, `brcmfmac`, `bcmsdh_sdmmc`).
- **USB Wi-Fi sticks that start as a driver CD** (many Realtek ones) are switched to Wi-Fi: `hardware.usb-modeswitch`
  (usb-modeswitch's udev rules and its dispatcher, which brings Tcl: +7.4 MiB).
- **On at every start** (`whombat-wifi-on.service`, `rfkill unblock wlan` after systemd-rfkill): a Whombat has no
  airplane mode, so Wi-Fi switched off by a laptop's wireless key, and the state systemd-rfkill keeps of it on the
  persistent root, comes back at the next start. A hardware switch stays as it is (the network state still says
  `disabled`, MG-100).
- All three in `wifi.nix`, so the installer's Wi-Fi step (HD-08) has them too.

## NX-343 What it changes, and what it doesn't (2026-10-20)

- **Size** (`self-installed-dev`'s system closure): 5,771,647,216 → **5,794,866,576 bytes (+23.2 MB, +0.4 %)**: the
  kernel +6.0 MiB, its initrd +2.7 MiB, Tcl +7.4 MiB and usb-modeswitch with its data +0.3 MiB, the recovery UKI
  +5.7 MiB (576 → 582 MB). The ESP (1 GiB) holds the recovery (551 MB on the DEV box) and one kernel and initrd per
  distinct generation (62 MB each, shared by generations that have the same ones); the DEV box used 607 MB of 1022.
- **Already there, unchanged:** both CPU makers' microcode, `linux-firmware` 20260916 (graphics, Wi-Fi, Bluetooth,
  network cards), SOF and ALSA firmware, the wireless regulatory database (`enableRedistributableFirmware`). Unfree
  firmware stays out (`broadcom-bt-firmware`, `b43`, FaceTime HD: `enableAllFirmware` needs `allowUnfree`).
- **Bluetooth:** the kernel's drivers (`btusb`, `btintel`, `btrtl`, `btmtk`, `btqca`) and their firmware load, and the
  hardware report lists the adapter (MG-110); BlueZ stays off, so nothing pairs a device yet (Whombat hardware-support.md
  “Not now”; WirePlumber's Bluetooth monitor stays off, NX-255).
- **Checked:** `checks.self-installed-config` asserts the newest kernel on the self-installed DEV image, the factory
  appliance, the installer and the recovery environment; `enableAllHardware` and the servers' controllers in the initrd;
  iwd's `PowerSaveDisable`, usb-modeswitch and `whombat-wifi-on` on the appliance and the installer.
  `self-installed-dev`'s system, its initrd and the recovery UKI build. No VM test was run (DEV, IN-132); the DEV box
  booting it is the first boot of 7.2.

## NX-350 Bluetooth on the box: BlueZ and whombat-bluetooth (2026-10-20; Whombat bluetooth.md BT-01…BT-11; stream B of the Bluetooth build)

John, 2026-10-20: “Implement your original idea so we can pair keyboards, mice, speakers, etc”. Until now the kernel's
drivers and firmware loaded and the hardware report listed the adapter (NX-343), but BlueZ and WirePlumber's Bluetooth
monitor were off (NX-255).

- **`nix/modules/bluetooth.nix`**, `whombat.bluetooth.enable`, **on with `whombat.kiosk.desk`** (the option's default,
  so on every appliance with a graphical console, as the sound server; never on the installer). Options `package`,
  `socket` and `dbusUsers` (read-only).
- **`whombat-bluetooth`** (`bluetooth/`, a package tree of the root Go module like `presence/`;
  `pkgs.whombat-bluetooth` = `.#whombat-bluetooth`, its `go test ./bluetooth/...` in the build): the runtime server's
  Bluetooth socket (contracts 0.109.0 `local`, CT-670…) over BlueZ on the system bus with godbus (NX-243's library).
  It is the only program on the box that pairs (BT-09).
- **The contract**: contracts-go 0.109.0 is vendored (`21e6bd3`, tree `e76cc59`; the vendorHash `8f74afa`, both straight
  on 6a220a4 so they merge without the service). The service uses `protocol`'s `BluetoothState` and its parts and
  `local`'s requests, answers, parsers, paths, errors and `BluetoothSocketErrorStatus`, `HostText` for names and
  `BluetoothSignalFromDBm` for bars; stand-ins were used only until the release (`4cee109` swapped them).

## NX-351 Who reaches BlueZ (2026-10-20; BT-09)

- BlueZ's `bluetooth.conf` lets every local user call `org.bluez` (`<policy context="default"><allow
  send_destination="org.bluez"/>`). **`whombat-bluetooth.conf`** denies that by default (`send_destination` and
  `receive_sender` org.bluez) and allows both to **root** (bluetoothd itself, UPower), **whombat-bluetooth** and
  **pipewire** (WirePlumber's Bluetooth monitor, only with the sound server). So the kiosk's browser, the runtime, the
  agents and their computers can neither call BlueZ nor listen to what it finds.
- The order is the point: within the default context the last rule wins, so the file is added with `lib.mkAfter` to
  `services.dbus.packages`, whose order is `system.conf`'s `<includedir>` order (makeDBusConf); user policies come after
  every default one whatever the file. The appliance's bus is dbus-broker, which reads the same configuration with the
  same rules. BlueZ's file is in two of the include directories (bluez's and system-path's); both come first.
- Only bluetoothd (root) may call an agent (`org.bluez.Agent1` is in root's `send_interface` list, method calls are
  denied by default); the service's agent also answers only bluetoothd's unique name (read at registration).

## NX-352 BlueZ's settings (2026-10-20; BT-03, BT-05, BT-08)

- `hardware.bluetooth` with `powerOnBoot` (`AutoEnable`): every adapter powered when it appears. **Never discoverable**:
  BlueZ's default, and nothing that may set it (root, whombat-bluetooth, pipewire) does. **`AlwaysPairable=false`**
  (BlueZ's default, explicit): no default agent, no pairing, and BlueZ turns bondable off; the only agent is the
  service's, registered as the default while a pairing an owner started runs (NX-355). **`JustWorksRepairing=never`**: a
  paired device can't have its keys replaced without a code. **`ClassicBondedOnly=true`** (`input.conf`): a classic
  keyboard or mouse that isn't bonded can't connect. **`FastConnectable=true`**: page scans interlaced, so a trusted
  keyboard waking up is in quickly (the box is on mains). `ReconnectAttempts=7` (BlueZ's default, explicit): a trusted
  speaker that drops is called back. `ControllerMode=dual` (NixOS's).
- **No `Experimental`**: so a headset's battery that PipeWire reads over HFP (BlueZ's experimental BatteryProvider) isn't
  shown; HID-over-GATT batteries are (`org.bluez.Battery1`).
- **Pairings are BlueZ's** (`/var/lib/bluetooth`, root, on the system volume, not in backups, BT-08). The factory reset
  empties it (NX-359).
- **On at every start** (`whombat-bluetooth-on`, `rfkill unblock bluetooth` after systemd-rfkill and before bluetoothd),
  as Wi-Fi's (NX-342): a laptop's wireless key switched it off once, the next start has it back. A hardware switch stays;
  the state then says `disabled`.
- bluetoothd runs when the kernel has a controller (udev's `bluetooth.target`); without one nothing starts it: the
  service doesn't ask BlueZ (NX-353) and WirePlumber's monitor waits for the name without activating it (the VM test:
  inactive with the monitor loaded).

## NX-353 What the service reads from BlueZ (2026-10-20; BT-01, BT-10)

- **The adapter** is the first `org.bluez.Adapter1` (hci0 before hci1); its name is BlueZ's alias (the machine's name or
  “BlueZ 5.86”: a name of the box's own is BT's “Not now”). **`missing`**: no controller in `/sys/class/bluetooth` →
  `no_driver` when a USB interface of class e0/01/01 has no driver bound (the hardware report's rule, MG-110), else
  `no_adapter`, and BlueZ isn't asked (it would start for nothing); a controller BlueZ doesn't show (its firmware didn't
  load) → `no_driver`; not powered → `disabled`. bluetoothd not answering is `503 unavailable`.
- **Kinds**: BlueZ's `Icon` first (`input-keyboard`, `input-mouse`/`input-tablet` → mouse, `input-gaming`,
  `audio-headphones`, `audio-headset`), then the LE `Appearance` (HID keyboard, mouse, pen, touchpad, gamepad; audio
  sinks → speaker; earbuds and headphones, headset), then the `Class` of Device (audio/video headsets, headphones,
  loudspeakers, portable, car and HiFi audio; peripherals' keyboard and pointing bits, gamepads, tablets), then
  `audio-card` → speaker; everything else `other`. **Phones and computers** (icons `phone`, `computer`, `modem`; class
  majors 1 and 2; appearance categories 1 and 2) never cross the wire (BT-01), whatever the icon says.
- **Paired devices** (`Paired` or `Bonded`): connected first, then by name, at most 32, no bars. **Found devices**: only
  while looking, not paired, with a name the device gave itself, seen in this round (BlueZ gives an RSSI only then and
  clears it when looking stops), strongest first, at most 64. Names through `local.HostText` (80 code points); a paired
  device without a name of its own gets BlueZ's alias. `battery` from `Battery1.Percentage`.
- **Logs** name devices and kinds, and BlueZ errors by their name only: never an address, a device path or BlueZ's text
  (BT-10; the unit tests and the VM test check the journal).

## NX-354 The socket and the unit (2026-10-20; brief §2.3)

- The contract's paths and shapes; requests through `local.ParseBluetooth*` (strict, ≤ 1 KiB, 413 `too_large`), statuses
  from `BluetoothSocketErrorStatus`; a wrong path 404 and method 405, both `bad_request`; a peer but root and the server
  403 `forbidden` (`--allow-uid 0,951`). Answers satisfy `BluetoothStateValid` (the tests check every state they read).
- **`whombat-bluetooth`, uid/gid 968** (`whombat.ids`, after presence's 967), no groups. **Socket**
  `/run/whombat-bluetooth/bluetooth.sock`, systemd's, **0660 whombat-bluetooth:whombat**, directory 0755; the service
  starts at the runtime's first request and stays (it holds the D-Bus connection BlueZ ties discovery and the agent to).
- **Sandbox**: no network (`PrivateNetwork`, `IPAddressDeny=any`, AF_UNIX only: the system bus is a path socket),
  `PrivateDevices`, no capabilities, `NoNewPrivileges`, `ProtectSystem=strict` and nothing writable (pairings are
  BlueZ's), `ProtectProc=invisible` with `ProcSubset=pid`, /persist inaccessible, `MemoryDenyWriteExecute`,
  `@system-service` without `@privileged @resources`; `MemoryMax=64M`, `TasksMax=32`, low CPU and IO weights.
- **The runtime server** gets `WHOMBAT_BLUETOOTH_SOCKET=/run/whombat-bluetooth/bluetooth.sock` only where
  `whombat.bluetooth.enable` is on (runtime.nix, beside presence's); the runner never. Unset, the server says
  `not_managed` and doesn't advertise `host.bluetooth`. The dev stack runs the server's fake instead
  (`WB_MGD_BLUETOOTH=fake` → `WHOMBAT_BLUETOOTH=fake`, harness `services.ts`, NX-363).

## NX-355 Looking and pairing (2026-10-20; BT-03, BT-04, BT-07)

- **Looking**: `StartDiscovery` with this client's filter (`Transport=auto`: classic and LE; no duplicate data), 60 s
  from the last scan request (asked again, it runs on; BlueZ asked to start again only when it stopped by itself), then
  `StopDiscovery`. Refused (`busy`) while a pairing runs; a pairing stops it first, so a state never has a scan beside
  a running pairing.
- **A pairing**: the device must be in BlueZ's list for the adapter, named and of an allowed kind (else `not_found`);
  one at a time (`busy`). The agent is registered (`DisplayYesNo`) and made the default, `Device1.Pair` runs in the
  background, the answer is 202 with phase `pairing` and a deadline 90 s on. Then `Trusted=true`, phase `connecting`,
  `Connect` (≤ 15 s), phase `done`; the agent is dropped as soon as the pairing has ended either way. A device already
  paired is only trusted and connected.
- **The agent's answers**, for the device being paired only (everything else, and everything after the pairing:
  `org.bluez.Error.Rejected`): `DisplayPasskey` → `code` (six digits) and `typed` as BlueZ reports the keys pressed (at
  most 6); `DisplayPinCode` → `code` (4–6 digits, else refused); `RequestConfirmation` → `confirm`, waiting for the
  owner, the deadline or BlueZ's `Cancel`; `RequestAuthorization`/`AuthorizeService` → yes; `RequestPinCode` → `0000`
  once; `RequestPasskey` → refused, and the pairing fails `failed` whatever BlueZ says next (BT-04).
- **Failures**: `AuthenticationRejected`, `AuthenticationFailed` (a wrong code typed), `AuthenticationCanceled` →
  `rejected`; `AuthenticationTimeout`, `ConnectionAttemptFailed` (page timeout: not in pairing mode, or gone) →
  `timeout`; the device object gone → `not_found`; anything else → `failed`. The 90 s deadline → `timeout`, the dialog
  closed (`cancel`) → `canceled`, both with `CancelPairing`. **The owner's No** to “Does {name} show {code}?” →
  `failed`, not `rejected` (the device didn't refuse; the numbers didn't match): the app says “Pairing with {name} didn't
  work. Try again.”
- godbus gives up a call when its context ends, so after a cancel or a timeout the service reads whether BlueZ paired
  the device anyway and removes it then: nobody is left with a device the owner stopped.
- An ended pairing stays in the state 60 s (`BLUETOOTH_RESULT_KEEP_S`), then `pairing` is null.

## NX-356 Connect, disconnect, forget (2026-10-20; BT-05)

- **Connect** a paired device (`not_paired` for one only found, `not_found` for an unknown or left-out one) waits at
  most 15 s and answers the device as it then is: one that doesn't come (switched off, out of range) is answered **not
  connected**, not as an error (there is no word for a failed connect; the row says “Not connected”). The same after a
  pairing: paired and trusted is `done` even when the first connect fails (a mouse or keyboard connects itself when
  used; the row has Connect).
- **Disconnect** keeps it paired and trusted (it comes back when switched on again); a BlueZ failure is 503.
- **Forget** is `Adapter1.RemoveDevice` (its keys go: it has to be paired again); refused (`busy`) for the device a
  running pairing is for.

## NX-357 Sound through Bluetooth (2026-10-20; BT-06; amends NX-255)

- `whombat.sound.bluetooth` (set by bluetooth.nix with the sound server): WirePlumber's **`hardware.bluetooth`
  required** (NX-255 had it disabled), as upstream's `main` has it: a virtual feature that only *wants*
  `monitor.bluez` and `monitor.bluez-midi`, so a monitor that can't start doesn't stop the sound. **Not `optional`**:
  WirePlumber loads an optional feature only when another component pulls it in, so the monitor never ran (the VM
  test's first runs: no `monitors/bluez.lua`, no endpoint registered). Seat monitoring is off already in
  `main-systemwide`. **Roles** `a2dp_source hfp_ag hsp_ag`: the box plays to speakers and
  headphones and is the gateway for headsets; no `a2dp_sink`/`hfp_hf`/`hsp_hs` (a phone playing through the box, BT-01)
  and no LE Audio (“Not now”). Nothing kept (`bluetooth.use-persistent-storage=false`, as `mixin.stateless`).
- **A connected speaker or headphones is the default sink**: `monitor.bluez.rules` gives `bluez_output.*` priority
  3000. ALSA's sinks are at most 1609 (WirePlumber's alsa.lua: 1000, +500 pro, +9 analog, +100 USB) and BlueZ's own 1010
  would lose to a USB card's 1109. With WirePlumber stateless, when it disconnects the highest left is the box's speaker.
- **Talk listens with the box's own microphone while it has one**: with `autoswitch-to-headset-profile` (WirePlumber's
  default, kept) a headset gets a source that switches it to HFP while something records from it, hard-coded at
  priority 2010 (bluez.lua), above a card's analog microphone (2009). A small default-node hook
  (`whombat/box-microphone-first.lua`, after find-best and before apply) replaces a Bluetooth default source with the
  best other source when there is one; without one the headset's microphone is the default and Talk switches it to HFP
  while it listens (back to A2DP after).
- **Size**: WirePlumber's Bluetooth parts and BlueZ were in the closure already (NX-257); the hook is 2 KB.

## NX-358 What Bluetooth adds to the image (2026-10-20)

- **+10.06 MB** to the appliance's system closure, measured on the same tree with `whombat.bluetooth.enable` forced off:
  **5,635,242,512 → 5,645,302,784 bytes (+10,060,272, +0.18 %)**: `whombat-bluetooth` 10.0 MB (Go with godbus and the
  contracts' embedded schemas, as presence's 7.6 MiB), units, policy, configuration and the hook a few KB, `system-path`
  and `hwdb.bin` rebuilt. **BlueZ 5.86 was in the closure already** (UPower and PipeWire's plugin bring it), so its
  daemon, tools and udev rules add nothing.

## NX-359 A factory reset forgets the paired devices (2026-10-20; BT-08)

`whombat-factory-reset` empties `/var/lib/bluetooth` beside `/var/lib/iwd` (NX-247): a box that is reset and passed on
has no paired keyboard of its old owner's, and no keys to one. Checked by `checks.bluetooth-config` (the script's line).

## NX-360 A Bluetooth keyboard or mouse restarts the kiosk when it connects (2026-10-20; known, not changed)

*Fixed by NX-400 (2026-10-21): whombat-kiosk-udev passes udevd's input events into the kiosk's namespace, and a
keyboard or mouse that connects or wakes works in the running kiosk; nothing restarts it for input any more.*

The kiosk's cage lives in the console server's network namespace and never gets udev's events (NX-82), so input
devices that appear later are taken by restarting the kiosk (`whombat-kiosk-replug`, NX-147). A Bluetooth keyboard or
mouse is a new input device at every connection, also when it wakes from its own sleep and reconnects: each time the
kiosk restarts (a few seconds, the page reloads). This is what makes a paired keyboard work at all; a kiosk that follows
input hot-plug without a restart is later work (the kiosk's, not Bluetooth's). To watch on the Z13.

## NX-361 How Bluetooth is checked (2026-10-20)

- **Go** (`go test ./bluetooth/...`, in the package's build; `go vet` clean; also under `-race`): the service against
  `bluez.Fake` with a fake clock — the state (adapter, `missing` from sysfs fixtures, paired order, battery, phones left
  out), looking (filters, bars, order, the cap, a minute, asked again, BlueZ stopping by itself), every agent path
  (Just Works, passkey with keys typed, PIN shown, a 7-digit PIN refused, confirm yes and no, 0000 once, a passkey asked
  and refused, another device's requests refused, nothing after the end), the deadline, cancel, a pairing BlueZ finished
  after a cancel removed again, each BlueZ error to its failure, busy, not found, connect that fails answered as not
  connected, disconnect, forget, close; every state checked with the contract's `Validate` and `BluetoothStateValid`;
  no address in any log line. The kinds, names and bars tables. The socket over the real service (every path, every
  answer through its `Parse*`, ≤ 64 KiB, strict requests, statuses, the peer check on a real socket). The D-Bus layer's
  object parsing, error mapping and the agent object's sender check.
- **`checks.x86_64-linux.bluetooth-config`** (eval, in `scripts/ci/nix-checks.sh`): on with the desk on the hardware,
  DEV and PROD appliances, off without a desk and when off (no units, no variable), never on the installer; BlueZ's
  settings; the policy after BlueZ's with three users; the socket, account (968, unique, no groups), the server's
  variable and not the runner's; the unit's sandbox; the sound server's Bluetooth parts; the factory reset's line.
  `checks.console` now expects WirePlumber's Bluetooth monitor required.
- **`checks.x86_64-linux.bluetooth`** (VM test, table above; NX-362).
- **The image**: `.#appliance-toplevel` builds (NX-358).

## NX-362 The `bluetooth` VM test (2026-10-20)

- **Two virtual controllers that see each other**: bluez's emulator `btvirt -l2` on `hci_vhci` (nixpkgs' bluez doesn't
  build it; the test builds `--enable-testing` and keeps only that program). Both would be the box's adapters, and the
  default agent answers for every adapter, so the box's agent would get the far side's requests too (and refuse them).
  So **`bt-peer`** (`vm-tests/common/bt-peer`, standard library only, test only) takes hci1 through the **HCI user
  channel** (after `btmgmt --index 1 power off`): bluetoothd no longer sees it, and it plays a mouse — named, Class of
  Device 0x000580, connectable and discoverable, Secure Simple Pairing with NoInputNoOutput (Just Works), link keys
  kept, every L2CAP channel refused (no services).
- **Passed 2026-10-20** on the final tree (`nix build .#checks.x86_64-linux.bluetooth`, TCG; seven subtests, the script
  56–66 s over the last runs, at 12411c5): the socket's mode, owners and on-demand start; root and the server's uid in, the runner refused, a member of
  the group refused (403); `no_adapter` with no controller, and bluetoothd not started for it (WirePlumber doesn't
  activate it either); with the controllers, hci0 powered and no `missing`; root, whombat-bluetooth and pipewire reach
  org.bluez, the server's user, another user and the runner get `AccessDenied`; PipeWire's A2DP endpoints registered
  with BlueZ and the box's-microphone hook loaded; looking finds “Whombat Test Mouse” (`mouse`, 4 bars), pairing it runs
  to `done` in seconds (BlueZ: paired, bonded, trusted; the peer: SSP complete, a link key), the first connect answers
  `ProfileUnavailable` and the pairing is `done` all the same (NX-356); connect and disconnect answer the device, forget
  removes it (and a second forget is `not_found`); every state follows the contract's rules; the journal names the mouse
  and has none of its address's forms.
- Earlier runs found two things, fixed: WirePlumber's Bluetooth monitor never ran with `optional` (NX-357), and two
  of the test's own checks (an answer file shared between users in /tmp; “scan while pairing is `busy`” racing a Just
  Works pairing that was already over: the unit tests check `busy`).
- **Not covered here**: a passkey, PIN or confirmation pairing (btdev answers SSP for its host, the peer has no keyboard
  or screen; the unit tests cover every agent path), LE devices, a real HID or A2DP connection (no profiles on the
  peer), sound on a Bluetooth sink, a real adapter's firmware, rfkill.


## NX-363 The dev stack, the DEV VM and the Z13 (2026-10-20; for the lead)

- **The dev stack** runs no BlueZ and no service: `WB_MGD_BLUETOOTH=fake` gives its runtime the server's in-process
  fake (`WHOMBAT_BLUETOOTH=fake`, refused in production; harness `services.ts`, beside `WB_MGD_VOICE`). The runtime
  advertises `host.bluetooth` only with `WHOMBAT_BLUETOOTH_SOCKET` (NX-354) or its fake.
- **The DEV VM** has no adapter: BlueZ and the socket are there, the state says `adapter: null, missing: no_adapter`
  (the app hides the section), and the box stays Healthy; bluetoothd doesn't run there (NX-352).
- **Only a real machine shows** (the Z13: John pairs a keyboard, a mouse and a speaker): the adapter powered at start
  (MT7925's Bluetooth on `btmtk`/`btusb`, its firmware from linux-firmware); a keyboard's code typed with the digits
  marked (`typed` needs keypress notifications; many keyboards don't send them, then only the code shows); a mouse and a
  speaker without a code; Talk's answers on the speaker while it is connected and back on the box's speaker after;
  Talk still hearing the box's microphone with headphones connected (the hook, NX-357), and a headset's microphone on a
  box without one; a trusted keyboard coming back by itself after it sleeps, and the kiosk *not* restarting when it does
  (NX-360, fixed by NX-400; NX-404); batteries (HID-over-GATT shows one; a headset's over HFP doesn't, NX-352); `journalctl -u whombat-bluetooth`
  naming devices and no addresses.

## NX-400 Keyboards and mice plugged in later reach the running kiosk (2026-10-21; amends NX-82, NX-147; fixes NX-360)

The kiosk's cage runs in the console server's network namespace (NX-82). udevd announces a finished device on group 2
of the uevent netlink family, and the kernel delivers those messages only inside the sender's namespace (its own
uevents, group 1, reach every namespace the initial user namespace owns, but libinput listens for udevd's). So cage
never added an input device that appeared after it started, and `whombat-kiosk-replug` restarted the kiosk for every
new keyboard or mouse: a few seconds, the page reloaded. A Bluetooth keyboard or mouse is a new device at every
connection, also each time it wakes from its own sleep (NX-360), so the kiosk restarted often.

- **Now:** `whombat-kiosk-udev` (Go, `kioskudev/`) receives udevd's messages in the host's namespace, keeps those of the
  `input` subsystem and sends the same bytes to group 2 inside the server's namespace, where libudev in cage takes them
  as udevd's: systemd 260's `sd_device_monitor_receive` trusts a sender of uid 0 (no PID check on group 2), and the
  bytes are udevd's own (the header's magic and filter hashes, so libudev's socket filter matches as on the host).
  libinput then adds the device, which it opens through logind (`TakeDevice`) as at start. No restart: the kiosk's
  MainPID, cage and the page stay. Removals are passed too (a keyboard going to sleep), so cage lets go of the old node.
- **Weighed: cage in the host's namespace, Chromium alone in the server's.** Chromium would have to be a second unit
  (cage can't start a client in another namespace) talking to cage's Wayland socket; the browser loop's swayidle
  signals, the backlight through logind's `session/auto` (only the session's own processes), NX-87's stop and the
  start limit would all be reworked; and cage, in the session scope where the unit's IP filter doesn't follow (NX-82),
  would sit in the host's network. Much larger, and it weakens “the kiosk reaches no network at all” (CG-03).
- **Weighed: a relay that enters the namespace itself** (`setns` on a locked thread, from the server's MainPID): it would
  need CAP_SYS_ADMIN and CAP_SYS_PTRACE besides CAP_NET_ADMIN, and follow the server's restarts. systemd makes both
  sockets where they belong instead (NX-401), so the relay needs neither and makes no socket at all.
- **Only input.** Displays plugged in or out keep their restart (`whombat-kiosk-display`, NX-147, NX-402).

## NX-401 The relay's units (2026-10-21; NX-400)

- `whombat-kiosk-udev-host.socket`: `ListenNetlink=kobject-uevent 2` (udevd's group; `nl_groups` is a mask, and group 2
  is mask 2), `PassCredentials=yes`, `ReceiveBuffer=8M` (a `udevadm trigger` is every device's event at once),
  `FileDescriptorName=host`. Made by PID 1 in the host's namespace.
- `whombat-kiosk-udev-kiosk.socket`: `ListenNetlink=kobject-uevent` (no group: it only sends), `PrivateNetwork=yes`,
  `JoinsNamespaceOf=whombat-console-server.service`, `FileDescriptorName=kiosk`: systemd's listener stub enters the
  server's namespace and makes it there, as systemd documents for socket units. An active socket unit holds that
  namespace, as the kiosk did: a restarted server comes back into the same one.
- **`PrivateTmp=yes` on that socket too.** systemd shares one runtime between units that join a namespace, and the unit
  that creates it decides what it holds: a joining unit without `PrivateTmp=` that started first would leave the server
  and the kiosk without a private /tmp, silently (systemd 260 `exec_shared_runtime_make`, `append_private_tmp_one`).
  So every unit that joins has it, whoever comes first.
- **Both sockets start with the relay, after the server** (`DefaultDependencies=no`; `After=sysinit.target` and the
  server, `Conflicts=`/`Before=shutdown.target`), so the server makes its namespace as before. Not before
  `sockets.target`, the default: the host's socket would queue the boot's every device event for a relay not yet
  running, and its first one would socket-activate the relay early.
- `whombat-kiosk-udev.service`: `Sockets=` both (fds by name, checked at start: the uevent family, the host's on
  udevd's group, the kiosk's on none, the two in different namespaces through `SIOCGSKNS`, or it refuses to run: in one
  namespace it would hear and pass its own messages forever). Wanted by and before the kiosk, `Restart=always`.
  **Root** (libudev believes uid 0, or its own uid) with **CAP_NET_ADMIN alone** (a send to a group of this family needs
  it); `PrivateNetwork=yes` (an empty namespace of its own: it joins none), `RestrictAddressFamilies=none` (it can make
  no socket, so not the rtnetlink one that could link the namespaces), `IPAddressDeny=any`, `NoNewPrivileges`,
  `ProtectSystem=strict`, `PrivateDevices`, `PrivateTmp`, `ProtectProc=invisible`, `ProcSubset=pid`,
  `MemoryDenyWriteExecute`, `RestrictNamespaces`, `SystemCallFilter=@system-service ~@privileged @resources`,
  `MemoryMax=32M`, and the other protections of the console server.
- **What it can and can't do.** It reads udevd's group (any user can) and checks each message: sent to group 2, by uid 0,
  not truncated, ≤ 64 KiB, libudev's header and magic, `ACTION` and `SUBSYSTEM` present; it passes `input` only. The
  kiosk can't reach it: sending on this family, to a group or to a port, needs CAP_NET_ADMIN, and the relay never reads
  its kiosk-side socket. Nothing gains network: the relay has no address family, the server stays the only listener on
  the shared loopback, the kiosk's namespace is unchanged. A send to group 2 also goes to the kernel's own uevent socket
  of that namespace, which ignores it (the bytes aren't a netlink message; injecting a uevent would need CAP_SYS_ADMIN),
  as with udevd's sends. The residual risk of the relay itself compromised is forged udev messages on the host's group
  (it holds that socket and CAP_NET_ADMIN), not network access.
- **Log** (`journalctl -u whombat-kiosk-udev`): “passing udev's input events into the kiosk's network namespace” at
  start, “passed add event7” / “passed remove event7” per device node, “udev events were lost (the receive queue was
  full)” after an overflow; never a device's name or its Bluetooth address (`UNIQ`), which the messages carry (BT-10).
  The kiosk's namespace gets them too, as any process on the host can read them from udevd's group and from /sys.

## NX-402 What still restarts the kiosk (2026-10-21; NX-147, NX-400)

- **A display plugged in or out** (`ACTION=="change"`, `HOTPLUG=1` on `drm`): `whombat-kiosk-display` as before. A new
  cage lights the new monitor at its preferred mode and turns a portrait one (`transform`, NX-164); a running cage
  would get neither (it turns outputs only at start, and wlroots doesn't change a connected output's mode), and a
  virtual GPU's resized viewer wants the new size. Monitors change rarely, unlike a Bluetooth keyboard's wakes, and a
  VM test can't plug one (std VGA has no hotplug), so `drm` isn't passed.
- **A restarted server** (its new token, NX-78) and the kiosk's own failures, as before.
- **Gone:** `whombat-kiosk-replug` and its two udev rules (`ID_INPUT_KEYBOARD`, `ID_INPUT_MOUSE`). No restart as a
  fallback for input: it couldn't tell a missed event from one cage took, and it was what made a Bluetooth keyboard
  restart the screen. If the relay stops, systemd starts it again within a second; events while it is down are lost
  (a device plugged in exactly then works after it is plugged again or the kiosk's next start).

## NX-403 How it is checked (2026-10-21; NX-400…NX-402)

- **Go** (`go vet`, `go test ./kioskudev/...`, also in the package's build): the message parser against udevd's layout
  (a keyboard's properties with a Bluetooth address; kernel-format messages, wrong magic, offsets, lengths, missing
  keys refused); the per-message checks (another uid, no credentials, truncated, too long, the kernel's group, unicast,
  another subsystem); and **the kernel path**: the test binary again under `unshare -rn`, a second network namespace
  on a locked thread, a stand-in udevd sending a disk and a keyboard on group 2, and only the keyboard arriving in the
  other namespace, byte for byte, from uid 0; `Check` refusing two sockets in one namespace and swapped sockets.
- **`checks.console`**: no replug unit or rules; the relay wanted by and before the kiosk with its two sockets, root
  with CAP_NET_ADMIN alone, its own network namespace, no address family; the host socket on udevd's group in the
  host's namespace; the kiosk socket in the server's (`JoinsNamespaceOf=`) with `PrivateTmp=`; both after the server,
  without default dependencies, wanted by nothing; none of it on the installer.
- **`console-self`**, subtest “a keyboard and a mouse plugged in later work in the running kiosk, without a restart”
  (replaces NX-82's restart subtest): the relay as root with CapEff `CAP_NET_ADMIN` only, in a namespace of its own with
  `lo` only, the kiosk still in the server's after the restarts before it; `device_add usb-kbd` and `usb-mouse`: cage
  holds both new nodes and the relay logged them; `device_del` the keyboard (cage lets go, “passed remove”) and
  `device_add` it again (cage takes the new node), as a Bluetooth keyboard that sleeps and wakes; with a paired, locked
  desk (the fake again, `hasPin`) six digits typed on that keyboard open the PIN pad and the page sends them (the fake
  logs `/v1/desk/unlock` with them), and the keyboard's and the mouse's nodes had the events (QEMU types on the
  keyboard added last); the kiosk's MainPID and cage unchanged throughout. The crash subtest after it now begins with
  a restart from outside (`reset-failed`, restart, as the server's `ExecStartPost=` does): it counted on the late
  keyboard's restart to have reset the start limit, and NX-87's plain restart before it still counts.
  **Passed 2026-10-21** (`nix build .#checks.x86_64-linux.console-self`, the final tree): 22 of 22 subtests, the script
  556 s, the new one 19 s; cage held the new keyboard and mouse 2.2 s after `device_add`, the page sent the PIN 1.3 s
  after the last digit on the first attempt, 864 bytes came from the keyboard's node and 72 from the mouse's
  (`mouse_move`; printed, not asserted); no kiosk restart since boot. The first run (before NX-405) failed on the
  test's own readers (a transient unit has no `sh` on its PATH) after the PIN had passed, and showed NX-405's boot race.
- **Image:** `.#appliance-toplevel` 5,645,495,240 → 5,647,260,072 bytes (**+1.7 MB**, the static relay; units ε).

## NX-404 What only a real machine shows (2026-10-21; for the lead; NX-363)

On the Z13 with a Bluetooth keyboard and mouse: pairing, then the keyboard asleep and awake again, its keys working
each time without the screen going dark or the page reloading (`systemctl show -P MainPID whombat-kiosk` unchanged,
no new “whombat-kiosk” start in `journalctl -t whombat-kiosk`), and `journalctl -u whombat-kiosk-udev` with a “passed
add eventN” per connection; HID-over-GATT (BLE) keyboards and mice, which appear through uhid; Caps Lock's light on such
a keyboard (libinput writes it through the fd logind gave); the keyboard cover attached and removed (a USB device);
nothing lost in a burst (`udevadm trigger` writes “udev events were lost” at most). A monitor plugged in still restarts
the kiosk (NX-402).

## NX-405 No input device yet is no failure (2026-10-21; NX-400; found by `console-self`; amends NX-82)

The first `console-self` run with the relay showed cage starting at 44 s of the VM's boot while udevd was still
finishing the coldplug of the input devices (their `add` came at 49–52 s): wlroots found none (“libinput initialization
failed, no input devices”), cage aborted, and the kiosk failed twice before its third start found them. That was so
before too, but the replug unit's restart for the keyboard's late `add` began with `reset-failed`, which hid the two
failures from the start limit; without it a slower boot reaches the third failure and the text console takes tty1 for
good. The launcher now exports `WLR_LIBINPUT_NO_DEVICES=1` (wlroots' own switch for this check): cage starts without
an input device, and every keyboard, mouse or touchscreen that comes later reaches it (the appliance's through the relay,
the installer's in the host's namespace, which always had them). A box with a display and no input device at all now
shows the GUI instead of failing three times (it can't be touched until something is plugged in, as the text console
couldn't). A relayed `add` for a device cage already enumerated is dropped by libinput (`filter_duplicates`, by
syspath), so the boot's late events can't double a keyboard. Checked: `checks.console` greps both launchers;
`console-self` finds the variable in cage's environment and no “libinput initialization failed” in the kiosk's journal.

## NX-406 The runtime package carries the shipped skills (2026-10-21; Whombat skill-store.md SST-03; amends NX-41)

From the skill store on (Whombat contracts 0.113), `pnpm bundle:runtime` puts the shipped skills in `skills/<category>/
<name>/` of the release directory instead of `packs/`, and a managed server reads them only from there
(`WHOMBAT_APP_DIR/skills`, the verified runtime component, as MR-47 had it for packs). `nix/packages/runtime` copied
`packs/` alone, so a runtime of the skill store would have reached the box without a single shipped skill. It now copies
whichever of `skills/` and `packs/` the bundle has (a pin from before keeps working), and the build stops when the
pinned source has `skills/` and the output doesn't (“the runtime bundle lacks the shipped skills”), so this can't pass
silently again. Nothing else on the host changes: the version store under `$WHOMBAT_HOME/skills/<sha256>/` is in the
server's home (`/persist/whombat/home`, already in the `home` snapshot, BK-30), the runner's skills folder is where it
was (`<TMPDIR>/whombat-runner-<uid>-skills`, under the shared runner temporary root, NX-133), and no unit needs a new
path or variable (`WHOMBAT_PACK_MCP_COMMANDS` was never set here). Checked: the package evaluates
(`.#packages.x86_64-linux.whombat-runtime.drvPath`); not built against a skill-store runtime here (the candidate's
build does that).

## NX-407 The hub's backup for the box's checkpoints (2026-10-21; Whombat BF-18; BK-31, BK-32; amends NX-153)

- **`/persist/hosts-backup`**: a subvolume of its own (`whombat.storage.extraSubvolumes` after `hosts`, in Whombat's
  qgroup), 0700 whombat-hosts (tmpfiles): where the hub's own backup is made, the backup's `hosts` source, which the
  btrfs driver snapshots like the others. In root's `/persist`, not nested in `/persist/hosts`: the hub's user may
  delete subvolumes in directories it writes (`user_subvol_rm_allowed`) and could swap a nested one for a directory,
  which would stop every snapshot. Boxes that have the hosts service get it at their next boot (whombat-persist-layout
  before tmpfiles).
- **`whombat-hosts-backup.socket`**: `/run/whombat-backup/hosts.sock`, root:whombat-backup 0660, `Accept=yes`, one
  connection at a time, wanted by `sockets.target`. **`whombat-hosts-backup@.service`**, one per connection: as
  whombat-hosts, with the hub's sandbox (now one `sandbox` attribute set in hosts.nix for both; the hub's unit is
  unchanged but for NX-409) and both directories bound, `PrivateNetwork`, `AF_UNIX` only, `RuntimeMaxSec=30min`, low
  CPU and IO weight; stdin and stdout are the connection, stderr the journal. Its script removes leftovers (`.hub-*`),
  runs `whombat-hosts backup --data /persist/hosts --out -` into a temporary file, syncs it, renames it to
  `hub.tar.gz` and answers `ok`; on a failure it answers `failed: ` and the first 300 characters of the message (all of
  it in the journal), and the previous `hub.tar.gz` stays. Only with `whombat.backup.enable` (the backup's group and
  directory). Not the hub's API: its token is admin over every server, which the backup user must never hold (BK-32).

## NX-408 The backup's side of it (2026-10-21; BK-31…BK-33)

- `whombat-backup.json` gains `hosts {backupSocket, uid, gid}` only where `whombat.hosts.enable`: prod's file is byte
  for byte what it was, and its checkpoints have no `hosts` source.
- The checkpoint job, the API (its pre-migration checkpoints) and the drill can't see `/persist/hosts` or
  `/persist/hosts-backup`: they read the staged snapshot only. The job and the API want the socket and start after it.
  The snapshot helper can't see `/persist/hosts` (it snapshots the backup only).

## NX-409 The hub waits for the release after a console restore (2026-10-21; BK-34; as BK-13's runner)

`whombat-hosts.service` gets `ConditionPathExists=!/persist/backup/quarantine.json` (with the backup enabled) beside
the device identity's: a box in quarantine after `quarantine apply` doesn't start the hub, so the servers it restored
(staged at `/persist/hosts/restore-staged.tar.gz`) aren't applied, and nothing acts on them (agent updates), before the
owner released the box. A hub that runs when the marker appears keeps running with what it had (conditions are checked
at start); a restart or a boot during the quarantine leaves it stopped. `systemctl restart whombat-hosts` after the
release applies the servers (`restore.md` step 6).

## NX-410 How it is checked (2026-10-21; NX-407…NX-409)

- **`checks.hosts-config`** (built): the subvolume and its tmpfiles; the socket (path, owner, group, mode, `Accept`, one
  connection); the instance (its user, stdio on the connection, no network, `AF_UNIX`, the hub's sandbox, both binds,
  wanted by nothing); the hub's two conditions; the backup units' hidden paths and wants, the snapshot helper's; both
  images' backup configuration with `jq` (DEV: the socket and uid/gid 965; prod: no `hosts`); the script (`bash -n`,
  the backup command, the rename, `ok`); none of it in prod. The `whombat-backup` package builds with it. The
  toplevels of `self-installed-dev` and `appliance-x86_64` evaluate; the generated units of the backup differ from
  before only by the paths, wants and configuration above.
- **The script** was run inetd-style (`systemd-socket-activate --inetd`, paths pointed at a scratch directory) against
  the pinned `whombat-hosts` (53ba825) with a data directory made by `whombat-hosts user add`: it answered `ok` and left
  an archive with `manifest.json` (schema 12) and `hub.db`, which `hosts.Export` and `restore.CheckHostsBackup`
  accept; without `hub.db` it answered `failed: whombat-hosts: stat …/hub.db: no such file or directory` and the
  previous archive stayed. Not run inside the unit's sandbox (no VM here): the lead's first DEV checkpoint is that
  test (`journalctl -u 'whombat-hosts-backup@*'`).
- **Go**: BK-31…BK-35's tests (`go test ./backup/... ./recovery/...`).

## NX-411 No vendor login that works without an owner's grant (2026-10-21; Whombat RH-01, RH-05; amends NX-10)

John, 2026-10-21, after the remote help proposal: “Yes implement this fully”, and on the records: “Build as designed”.
NX-10's last sentence becomes: **there is no vendor key or account that can log in without an owner's grant**, locally
or remotely. Still no SSH daemon, no sudo, a locked root password and no standing key or account. What is new: an owner
can turn on remote help for an hour, a day or a week (Forever only on images whose environment isn't prod), and while
it runs Whombat support may connect through the box's own outgoing relay line with a short-lived certificate from the
support CA the image pins, for this device, and on prod with the help code the owner sees (RH-05). Owners see who is
connected and what they did, and can stop it at once. `services.openssh` stays forced off (`checks.support-config`).

## NX-412 The support service is root and almost unsandboxed (2026-10-21; RH-02)

`whombat-support.service` runs as root without `User=`, `NoNewPrivileges`, `ProtectSystem`, `ProtectHome`,
`PrivateTmp`, `PrivateDevices`, capability bounds or a system call filter. “Look and fix” is a root command line,
restarts and connections to the box's own ports and sockets (RH-02); systemd's sandbox would follow every command it
runs (a private `/tmp`, a read-only `/usr` and `/etc`, no setuid wrappers), so a Fix that restarts a unit or edits a
file would quietly fail, and the help would mislead. What keeps it safe is who gets in, not what root may do once in:
nothing listens on any network (NX-22 unchanged; it dials out only while a grant runs, NX-417), the socket is local and
checked by uid (NX-414), every visit is recorded. Kept: `StateDirectory=whombat-support` 0700, `UMask=0077`,
`LimitCORE=0` (its memory may hold a help code), `KillMode=control-group`, `Restart=always`. Started at boot as well as
by its socket: a running grant (Forever on a DEV box) dials the relay without anyone asking first. Look and fix see the
commands a root login would (`PATH=/run/wrappers/bin:/run/current-system/sw/bin`).

## NX-413 The grant (2026-10-21; RH-03…RH-05; `support/internal/grant`)

- **One file**, `/var/lib/whombat-support/grant.json` (0600, replaced atomically): level, since, until (none:
  Forever), who granted it, the help code, the wrong codes so far. On the root volume: it survives reboots and updates,
  not a reinstall.
- **The service is the only judge.** Durations 3600/86400/604800 s; Forever only where `whombat.environment` isn't
  `prod` (`forever_not_allowed` otherwise, whatever the runtime sends); a help code only on prod, six characters from
  crypto/rand, new for each grant that starts from off. A change while on (another level or time) keeps the start, the
  code and the wrong-code count, as the contract says (`SupportGrantRequest`); the brief's “new one each Start” would
  have cut support off at every change.
- **Help codes**: compared normalised, in constant time, never logged. Every wrong one counts and is saved; the fifth
  ends the grant (`locked_out`). Without a grant nothing passes; where no code is required any user name does.
- **Expiry**: a grant whose `until` has passed is over the moment anything asks (level, code, state), so a wall clock
  that jumps forward (the first time sync) closes it at once; a timer sleeping at most a minute ends it when nobody
  asks. One that ran out while the service was down ends at its start, with its `expired` event.
- **Fail closed**: a file it can't read, or a grant this image wouldn't give (Forever on prod, no code on prod, a code
  off prod, five wrong codes), is dropped. A start that can't be saved isn't made; a stop is in force in memory at once,
  and when the file can't be rewritten it is removed, so what is off doesn't come back after a restart.
- **Changes are told**: `Changed()` (closed and replaced on every start, change and end: the relay worker and A2's
  connections look again) and the event log (`grant`, `stop`, `expired`, `locked_out`).

## NX-414 The support socket (2026-10-21; contracts 0.120.0 `local` SUPPORT_PATHS, CT-938…CT-942)

`/run/whombat-support/api.sock`, systemd's (socket activation), `0660 root:whombat-support`; group `whombat-support`
(gid 970, `whombat.ids`) has two members, the runtime server's user and the manager's. The service checks the peer's
uid as well: the runtime (951) and root everything; the manager (950) `GET /v1/state` only, and without the help code
(control never gets it, RH-09); anyone else 403 `forbidden`. Bodies at most 1 KiB, parsed with the contract's generated
validators (`v: 1`, a duration's name, no other member); queries strict (`before` a visit id, `limit` 1…20, default 20;
`after` a seq, `waitS` 0…25). The state comes from memory only (the manager asks about every 30 s); nobody is shown
connected without a grant. Events answer at most 100, the oldest; `next` is then the last one sent, so asking from
`next` misses nothing. `WHOMBAT_SUPPORT_SOCKET` goes to the runtime server, not the runner.

## NX-415 Look's user (2026-10-21; RH-02)

`whombat-support-look`, uid/gid 969 (`whombat.ids`), in `systemd-journal` and nothing else, no login, owns nothing.
Look's commands run as it: it reads the journal (content-free, NX-16) and what the system shows everyone; not the
service's state directory (0700 root), not `/persist`'s data (each service's directory is 0700 or 0750 to its own
user), not the sockets of the runtime, the manager or this service. The manager's reads Look shows (hardware, network,
updates, host metrics) are made by the service itself as root over the manager's socket (MG-118).

## NX-416 The support CA each image pins (2026-10-21; RH-05, RH-10)

`whombat.support.caKeys` (path or null) becomes `/etc/whombat/support-ca.pub` (0444): OpenSSH public key lines,
`ssh-ed25519` only. `dev-instance.nix` pins `manifest/dev-instance/support-ca.pub` (a placeholder with comments only
until the lead puts DEV control's public line there); `prod-instance.nix` pins `manifest/prod/support-ca.pub` once the
prod host has made it, else nothing (no throw: the image is complete without it); the factory image pins nothing. An
assertion refuses a prod image with the DEV file or any key in it. Remote help is `available` only with at least one
key; a file with anything else in it (another key type, broken base64, more than 16 keys) is refused whole: a broken
pin lets nobody in rather than some. A grant left from before on an image that no longer pins a CA ends at start
(`expired`): a grant nobody can use isn't shown as on.

## NX-417 The relay worker only while a grant runs (2026-10-21; RH-06)

The service's supervisor starts the relay worker (A2's `relay.Run` with the manager's support tickets and the SSH
server's `ServeConn`) when a grant starts and cancels it the moment `Changed()` shows the grant ended; a level change
keeps the worker. A worker that returns early is started again after 2 s, doubling to a minute. Without a pinned CA it
never runs. The device's id (the certificates' principal) is read from `/persist/identity/device.json` when a
connection needs it: a self-installed box gets it at registration, after the service started.

## NX-418 What a visit left running ends with the grant (2026-10-21; RH-02)

When a grant ends (stopped, expired, locked out), after the relay worker has stopped, the service ends every open visit
(`records.EndOpen`) and then kills every process left in its own cgroup and the cgroups below it, but itself (a command
a Fix command line put in the background, a Look still reading): up to ten sweeps, since a dying process may fork.
Processes elsewhere (a unit support restarted, a transient unit it made) are the system's and stay. Stopping the unit
kills its whole cgroup.

## NX-419 Reaching the manager's socket (2026-10-21; MG-118)

`/run/whombat-manager` is `2750 whombat-manager:whombat-api` (MG-11). The service runs with
`SupplementaryGroups=whombat-api`; as unsandboxed root it would pass the directory anyway, the group says so on purpose.
Stream B's broker allows uid 0 on `POST /v1/support/ticket` and on the reads Look uses.

## NX-420 Visits as events (2026-10-21; RH-08)

The record (`support/internal/records`) reports a visit's first connection and its end; the service turns them into
`visit_start` (`visitId`, `who`, `level`) and `visit_end` (also `startedAt` and `steps`) events for the runtime's
follower. `steps` counts every step support took, also those past the record's 2000 (`StepsDropped`): the signed
`remote_help.visit` says how much was done. Visits a crash left open are ended and told when the service starts (the
event log opens before the record).

## NX-421 The socket's shapes are contracts 0.120.0 (2026-10-21; CT-930…CT-942)

`third_party/whombat-contracts-go` is the 0.120.0 release (tree 775f704). `support/internal/wire` aliases the generated
types (`wire.State` = `local.SupportState`, `Grant`, `GrantRequest`, `StopRequest`, `Visits`, `Event`, `Events`;
`Person`, `Connected`, `Visit`, `Step` = `protocol.RemoteHelp*`), takes paths, codes, statuses and limits from the
generated constants, and keeps the enum values as untyped constants (tested against the generated lists) so they
compare with plain strings and assign to the generated enums. Optional members of the generated shapes are pointers:
`wire.Ptr`. Differences from the brief: grants and events carry `duration` (`hour`|`day`|`week`|`forever`), not
seconds; every body has `v: 1`; `forever_not_allowed` is 403; `visit_start` has no `startedAt`.

## NX-422 The service before the SSH server is merged (2026-10-21; for the lead)

`support/cmd/whombat-support` reaches the SSH server and the relay worker through `newSSH` (`ssh.go`). Until branch
`rh-ssh` (`support/internal/{sshd,relay,managerclient}`) is merged, `ssh_stub.go` builds a service that keeps the
grant, the socket and the record and lets nobody in (its worker waits; `hostKey` is null). `ssh_rhssh.go` (build tag
`rhssh`) is the real wiring, written against the announced signatures: after the merge, align it with sshd's
constructor, delete `ssh_stub.go` and the tag. The host key is the SSH server's (made at its first start in the state
directory, never in the image; `image-no-secrets` unchanged).

## NX-423 Options, paths and ids (2026-10-21; summary of NX-411…NX-422)

`whombat.support.{enable (appliance profile: on), package, caKeys, socket (read-only)}`; `pkgs.whombat-support`
(`nix/packages/go.nix`, its Go tests in its build); ids `whombat-support-look` 969, group `whombat-support` 970;
`/run/whombat-support/api.sock`, `/var/lib/whombat-support/{grant.json,events.json,visits/}`,
`/etc/whombat/support-ca.pub`; `WHOMBAT_SUPPORT_SOCKET` in the runtime server's environment.

## NX-424 How it is checked (2026-10-21; NX-411…NX-423)

- **Go** (`go test ./support/...`, also in the package's build): the grant (durations, levels, owners, Forever per
  environment, help codes typed every way, lock-out across a restart, expiry by timer, by a jumping clock and while
  down, persistence, fail-closed loading, `Changed`), the socket (every path for every caller, a real `SO_PEERCRED`
  socket, every refusal, the long poll and its cap; every answer through the generated parsers and `SupportStateValid`/
  `SupportEventValid`), the CA file, the leftover sweep on a fake hierarchy, the supervisor (the worker only during a
  grant, again after an early return), the visit events, the wire mirrors against the generated values.
- **`checks.support-config`**: on in every appliance image and gone when off; no openssh; the socket, the group and
  Look's user; the unit's root, state, kill mode, manager group, PATH and arguments per image (`dev`, `local`, `prod`);
  the CA each image pins; a prod image with the DEV file (or a copy of its keys, once it has one) fails its assertion.
- **`checks.support`** (`vm-tests/support.nix`, a prod image with a test CA): the socket's mode, root, each caller's
  rights and an intruder in the group refused, Forever refused, a grant with a help code the manager doesn't see, a
  process put in the unit's cgroup ended by the stop, the grant across a restart, the expiry after the clock is moved,
  Look's user without the state or `/persist`'s data, no port, no help code in the journal.
## NX-425 The support service and the manager's socket: no change to manager.nix (2026-10-21; MG-118, MG-122)

The support service (root without `User=`, NX-411…) asks the manager for its relay tickets and Look's reads on
`/run/whombat-manager/api.sock` (2750 `whombat-manager:whombat-api`, the socket 0660). Root reaches it through
`CAP_DAC_OVERRIDE`, so `manager.nix` stays as it is; the manager's peer check allows uid 0 on exactly those routes
(MG-121). Should `support.nix` ever bound the service's capabilities without `CAP_DAC_OVERRIDE`, it adds
`SupplementaryGroups = [ "whombat-api" ]` to its own unit. The manager reads the support socket's state as its own user:
the socket's group must be one `whombat-manager` is in (support.nix).


## NX-426 What a security review changed before the first DEV release (2026-10-21; RH-02, RH-05, RH-07)

An adversarial review of the support service found, and these were fixed before it shipped:
- **Any change of level closes the connections made before it**, both ways (High): a connection made at Look that saw
  Look and fix come and go could keep a root shell or forward it had opened in between until its certificate ran out.
  The support tools reconnect at the new level. A stop followed by a new grant closes them too (`Generation`).
- **Steps are cleaned to the contract before they are recorded** (Medium): the line as one line of display text
  (`local.HostText`), the target printable ASCII, units only well-formed names; a step that still isn't the contract's
  is kept as a refusal with bad arguments. The owner's list is read strictly, so a visitor's control characters would
  otherwise have hidden a page of visits.
- **`status <unit>` shows named properties and the unit's last lines, no process tree** (Medium): `systemctl status`'s
  tree carries every program's full command line, which can hold tokens; `processes` already showed names only.
- **Certificates with any critical option are refused** (`source-address` passed `CheckCert` unenforced), **at most
  four channels at once per connection**, **systemd's socket descriptor closed after use** (Look and fix's children
  no longer inherit the runtime's socket), **`UMask=0022`** (a root login's; the service's own files are 0600/0700
  explicitly).
- Known and accepted: expiry follows the wall clock (NTS-synced, NX-17; turning the clock back needs root on the box);
  a Look and fix visitor is root and could alter the records, which the signed `remote_help.*` events and their step
  counts in the runtime would show.

## NX-427 A serial port that can't be written ends the DEV console unit cleanly (2026-10-22; amends NX-120)

Through remote help, the first look at Home (John's Z13, bare metal) showed the box `degraded`: `whombat-dev-serial-console`
(NX-120) opened `/dev/ttyS0`, whose first write failed with `Input/output error` (the port's node is there, no UART behind
it), and after three tries in 15 s the unit stayed failed, on every boot. A port that can't be written has nowhere to show
the line, so the script now ends with 0 when `echo` fails: the unit is inactive, not failed, and `systemctl is-system-running`
says `running`. A VM without a serial port still fails before the script runs (systemd can't open the TTY) and stays as
NX-120 says; the Incus DEV box, which has one, is unchanged. Dev only.

## NX-430 Hermes Agent in the image: the pin and the package (2026-10-23; Whombat HE-10, HE-12, HE-28)

Whombat's engine becomes Hermes Agent (Whombat `docs/decisions/hermes-engine.md`); step 1 is a trial on the DEV box, the
runner driving `hermes acp` for the people in `WHOMBAT_HERMES_ACCOUNTS`. Stream N of that step.

- **The pin.** Flake input `hermes` = `github:NousResearch/hermes-agent/bf0203a7…` (v0.22.5, public, MIT), **not a
  flake**: its flake brings nixpkgs-unstable, flake-parts, home-manager and npm-lockfile-fix, and builds its desktop,
  TUI and web dashboard with Node. What it uses to build its Python environment comes in as three inputs of ours at the
  revisions its `flake.lock` names, following our nixpkgs: `pyproject-nix` (e3b599ca), `uv2nix` (7aba73a3),
  `pyproject-build-systems` (62c0d860). So the image keeps one nixpkgs, and the environment is built from Hermes's own
  `uv.lock` the way its package is.
- **Python 3.14 from our nixpkgs** (26.05 has 3.14.7; Hermes pins the 3.14 family in `pm/lock.json`, its own build is
  3.14.9; evaluation fails if the families differ). Taking Hermes's nixpkgs instead would have added a second glibc,
  OpenSSL and the rest under it. One change: this Python links **SQLite 3.51.3**, not nixpkgs' 3.51.2, which has the
  WAL-reset bug — Hermes then runs every database (`state.db`, the cron and project databases) in rollback-journal
  mode, and its own nixpkgs (3.53.3) doesn't. 3.51.3 is the same release line with the fix; its test suite runs, with
  one line added to its new `walrestart.test`, which left its fault hook installed and failed the next test. The
  override goes by itself when nixpkgs' SQLite is a fixed one. Cost: this Python and SQLite are built here
  (cache.nixos.org doesn't have them), once per nixpkgs bump (about 10 min on The Titan, most of it SQLite's tests).
- **The package** `nix/packages/hermes` (`pkgs.whombat-hermes`, `packages.<system>.whombat-hermes`) follows Hermes's
  `nix/hermes-agent.nix`: a uv2nix environment of Hermes's core dependencies plus the **`acp` and `mcp` extras only**
  (agent-client-protocol 0.9.0; mcp 2.3.0, httpx2, starlette), wheels preferred; Hermes's own wheel (`HERMES_NIX_BUILD=1`,
  its setup.py's guard); its package manager's environment (`nix/pm-runtime.nix`, which the install stamp names); its
  offline assembler (`scripts.build.agent`, placement `references`, no frontends) and one wrapper per entry point
  (`bin/hermes`, `bin/hermes-acp`, `bin/hermes-agent`). Left out: Hermes's `all` extras (cron, pty, uvloop, SMS, Google,
  web, YouTube) and everything of its full package (messaging, voice, TTS, Modal, Daytona, Bedrock, Matrix, …), the
  desktop, TUI and web dashboard, the optional-skills and optional-mcps catalogues, and the run-time tools its wrapper
  puts on `PATH` (Node, ripgrep, git, OpenSSH, ffmpeg, clipboard tools): Hermes's terminal and file tools run on the
  agent's computer through Whombat's plugin (HE-12), and nothing here is a UI. Kept: its bundled skills, plugins (memory,
  context engine, model providers) and locale strings, copied into `share/hermes-resources/` (the source stays out of
  the closure, `disallowedReferences`), linked from the install root `share/hermes-agent/` with `install-stamp.json`
  (`distribution: nix`, `updateMechanism: external`: Hermes never updates itself). The skills keep `#!/usr/bin/env`
  (no `patchShebangs`): they run on the computer.
- **The wrappers** set Hermes's packaging variables (`HERMES_PYTHON`, `HERMES_INSTALL_ROOT`, `HERMES_BUNDLED_SKILLS`,
  `…_PLUGINS`, `…_LOCALES`), `HERMES_BIN` (default) and **`HERMES_DISABLE_LAZY_INSTALLS=1`** (no downloads into a
  profile, as Hermes's Docker image), and not `HERMES_REVISION` (NX-435).
- **Install check:** `hermes --version` names 0.22.5, `hermes acp --help`, the entry points run the environment's
  own interpreter (one Python in the closure), `acp`, `mcp` and the ACP adapter import, the linked SQLite is a fixed
  one, and the plugin's entry point loads (NX-432).
- **Closure: 510.6 MiB** (NX-436: what it adds to the image). Largest: Python 3.14 135.5 MiB (the
  image's other Python is the toolchain's 3.13, so nothing shared), Hermes's own code 104.4 MiB (its Python and
  bytecode; 36 MiB of it `hermes_cli`), pillow-heif 26.2, nemo-relay 26.0, Pillow 21.2, cryptography 14.9, firecrawl-anydoc
  8.0, openai 8.0, the bundled resources 20.5 (plugins 9.4, locales 6.9, skills 4.2); 68 MiB of it (glibc, OpenSSL,
  gcc-lib, ncurses, …) the image has already. Pillow, pillow-heif, resvg-py, nemo-relay, browser-harness, FastAPI and uvicorn are
  Hermes's *core* dependencies (every session imports them): leaving them out would take a patch.

## NX-431 What the runner gets (2026-10-23; Whombat HE-12, HE-16; the step's “Interfaces between the streams”)

*Superseded in part by NX-483 (2026-10-28): the runner's `WHOMBAT_HERMES_BIN` comes from the runtime bundle's own
runner wrapper, not the unit; the unit keeps `WHOMBAT_HERMES_ROOT`.*

`nix/modules/hermes.nix` (`whombat.hermes`):
- **`enable`** defaults to “the factory runtime is the real one”: the DEV and PROD images (and VM tests with the real
  bundle) carry Hermes; images and VM tests with the stand-in, which runs no turns, don't. PROD carries it too: one
  image for both until step 2 makes it every turn's engine; nothing starts it unless the runner is told to
  (`WHOMBAT_HERMES_ACCOUNTS`).
- **Runner environment:** `WHOMBAT_HERMES_BIN=<store path>/bin/hermes` and `WHOMBAT_HERMES_ROOT=/persist/whombat/hermes`.
  The server gets neither.
- **The root:** `/persist/whombat/hermes`, 0700 whombat-runner (tmpfiles), in the runner's `ReadWritePaths`, and a
  **subvolume of its own in Whombat's qgroup** (`whombat.storage.extraSubvolumes`, NX-12): memory, sessions and skills
  grow inside the limit that keeps PostgreSQL writable, and step 3 snapshots it as a backup source. A plain directory
  already in its place becomes a subvolume when it is empty and stays as it is otherwise (NX-63). Kept across
  activations and updates like everything under `/persist`. The runner makes `profiles/<account id>/` and `profiles/_shared/`
  itself (Whombat HE-16).
- `/nix/store` is bound read-only into every task sandbox, so the store path is all a sandbox needs to reach Hermes.
- Checked: `checks.hermes` (evaluation, in CI's list: the pin, both images' runner environment, the root's tmpfiles,
  write path and subvolume, nothing for the server, nothing with the stand-in); `runtime-live-turn` (VM) now also checks
  the runner's environment and the root's owner, and runs `hermes acp` as the runner in a jail like the task sandbox
  (NX-434).

## NX-432 Whombat's plugin and patches come from the runtime source (2026-10-23; Whombat HE-05, HE-17)

*Superseded in part by NX-483 (2026-10-28): a plugin or patch change is a runtime change, not a host release.*

The plugin is `packages/hermes-whombat` of the pinned Whombat (flake input `whombat`; stream P's Python package
`whombat_hermes`). The overlay passes that directory to the package when it has a `pyproject.toml`:
- its **pyproject package** is built with pyproject.nix's renderer and installed into Hermes's environment; Hermes finds
  it by its `hermes_agent.plugins` entry point (the runner's `config.yaml` enables it). Its dependencies must be in
  Hermes's `uv.lock` — the environment has nothing else — and the build fails on one that isn't;
- its **`patches/*.patch`** are applied to Hermes's source in name order (`-p1`, as `git format-patch` writes them)
  before the wheel is built; a patch that doesn't apply fails the build, and one that changes `pyproject.toml`, `uv.lock`
  or `pm/lock.json` is refused (the environment is resolved from the unpatched lock at evaluation). A patched build's
  stamp says `dirty: true`;
- it is copied **by content** (`builtins.path`, caches left out), so a Whombat commit that doesn't touch it leaves the
  package and the host unchanged and `release/ship build` still finds a runtime-only release (UP-X16); a commit that
  changes the plugin or a patch changes the host: a host release.
- Without the directory (Whombat before stream P lands, e.g. the pin 14057e5a today) Hermes is built alone and the
  image evaluates with a warning (“Hermes is built without Whombat's plugin”).
Proved with a stub package and patch outside the repository
(`whombat-hermes.override { plugin = <dir>; }`): the patch is in the environment's `acp_adapter`, the entry point
`whombat = whombat_hermes:register` loads. P's own tree had no package yet. To build against a Whombat worktree:
`nix build .#whombat-hermes --override-input whombat path:<worktree>` for the package alone; an image needs
`git+file://<worktree>?rev=<commit>` (the runtime package reads the input's `rev`, which a `path:` input lacks).

## NX-433 A new Hermes pin (2026-10-23; Whombat HE-10, HE-28)

*Superseded in part by NX-483 and NX-485 (2026-10-28): a new pin is a runtime change, made by the latest-tested
Hermes job, which also moves Whombat's `pin.ts` (the two must agree).*

Hermes ships several releases a week with breaking changes, so a new pin comes only after our tests (HE-10), never
from Hermes itself. To move it:
1. Pick a tested release (Hermes's “tested SemVer stable” tag) and check the Whombat plugin and its patches against it
   (stream P's pytest against that release; patches rebased in the Whombat repository).
2. Here: set the rev in `flake.nix` (`hermes`) and `version`/`pinnedRev` in `nix/packages/hermes` together (the package
   refuses a mismatch), and the three uv2nix inputs to the revisions that release's `flake.lock` names; `nix flake lock`.
3. If its `pm/lock.json` moves to another Python family, nixpkgs must have it (evaluation says so).
4. Build `.#whombat-hermes` (install check), run `checks.hermes` and `runtime-live-turn`, then the DEV twin's toplevel.
5. It is a host change: `release/ship all <id>` (the lead).
The Whombat side (`WHOMBAT_HERMES_*`, the config writer) must still match the new release's `config.yaml` keys and ACP.

## NX-434 What Hermes needs inside the task sandbox (2026-10-23; for the runner, stream R; Whombat HE-12, HE-16)

Tried here with bubblewrap: `hermes acp` answers `initialize` (0.7 s) and `session/new` (3.3 s: it starts its gateway)
in a jail with only `/nix/store` read-only, `/etc/ssl`, fresh `/proc`, `/dev`, tmpfs `/tmp` and home, one writable
profile, no network but loopback and an empty environment; `runtime-live-turn` does the same on the appliance as
whombat-runner. What the runner must provide:
- **`HERMES_HOME`** = the person's profile, writable, mode 0700 and **owned by the uid Hermes runs as inside the
  sandbox** (its gateway refuses a home owned by anyone else, `hermes_cli/gateway_runtime_discovery.py`): with the
  task's own user (uid 1000 in stage 2) the profile on disk must belong to the host uid that maps to, or stage 2 must
  map the runner's uid; it reads `/etc/passwd` and `/etc/group` only when the home is group-writable. Mount it so that no parent inside the sandbox looks like a Hermes home: Hermes treats
  `<dir>/profiles/<name>` as one of *its* named profiles when `<dir>` holds Hermes files (`config.yaml`, `state.db`, …),
  so nothing of Hermes's goes into `$WHOMBAT_HERMES_ROOT` itself. Keep the path short: Hermes's gateway socket lives in
  it and moves to `$TMPDIR` past ~100 bytes. The sandbox's environment allowlist (MS-18) needs `HERMES_HOME`.
- **`HOME`** writable (tmpfs is enough: Hermes keeps its gateway host lock under `~/.local/state/hermes/`, or
  `HERMES_GATEWAY_LOCK_DIR`), **`/tmp`** writable, `TMPDIR` set (else Hermes makes `$HERMES_HOME/cache/scratch`).
- **Loopback TCP** inside the sandbox: `hermes acp` is only a viewer; its first request starts `python -m hermes_cli.main
  gateway run` (the environment's Python, the wrapper's environment inherited), which owns the profile and talks to it
  over a WebSocket on 127.0.0.1. The gateway outlives `hermes acp` by up to 10 minutes (`--idle-exit`) unless its pid
  namespace ends: the runner's per-task pid namespace does that. Two `hermes acp` on one profile share one gateway
  (flock): the runner's one-process-per-profile lock (HE-16) stays.
- **CA certificates:** Hermes trusts the system store (truststore); `/etc/ssl` and `/etc/static` (in the allowlist)
  are enough on the appliance; `SSL_CERT_FILE` is honoured on top. **Locale:** none needed (it repairs non-UTF-8 stdio);
  `LANG=C.UTF-8` is fine. **Time zone:** `/etc/localtime` or `TZ`, else UTC.
- **`PATH`** with `codex` / `claude` (or `model.codex_bin` and the plugin's own key); Hermes itself runs no other
  program at start or per turn here (no git without a `.git` in its working directory, `rg`/`find` on the computer).
- **The store stays read-only and that is fine:** bytecode is precompiled, the stamp's `external` writes no launchers,
  package-manager installs would go to the profile and are off (NX-430).
- **Start time:** spawn to `session/new` answered took 4.0–5.3 s with a cold gateway here and 0.9 s when the
  profile's gateway was still running (P measured 5.7 s per turn in the sandbox). Not bytecode: the store's `.pyc`
  are unchecked-hash and used as they are (imports take 0.3–0.8 s); it is Hermes's own start (home upkeep, discovery of
  64 plugins, its gateway and databases). Cheap ways are the runner's: keep a Chat's sandbox, and so its gateway, for a
  short while after a turn (Hermes's own `gateway.unmanaged_idle_exit_seconds`), and switch off bundled plugins the
  turn never uses (`plugins.disabled`).
- **Skills synced into a profile keep the store's modes** (read-only files and directories): to delete or replace a
  profile the runner `chmod -R u+w` first; Hermes edits only skills it made itself.
- **Backups (step 3):** the profile root is a subvolume already (NX-431); it joins the backup as a source (`backup/pkg/
  coverage` `Sources`, `manifest.SourceNames`, a coverage class) with the restore proof (Whombat HE-19).

## NX-435 What Hermes contacts by itself, and what turns it off (2026-10-23; Whombat HE-10)

Hermes's own traffic (not the model's: with Codex mode or the plugin the turn is the CLI's), from v0.22.5's source and
one real Claude turn (stream P's `acp_e2e.py`, this package with P's plugin) with every outbound connect traced to its
Python stack. The task sandbox does **not** catch it all: its proxy lets out the provider's endpoints and GitHub on
every turn, and any public host when the agent holds the web key (Whombat `apps/runner/src/managed.ts`
`egressPolicy`). So nothing has to be added to the allowlist for Hermes, and the runner's `config.yaml` must turn these
off:
- **`hermes acp`, each session:** models.dev (`agent/models_dev.py`; no switch; Hermes backs off 5 min and goes on
  without the metadata when it fails) — **turned off** with `models_dev.url: http://127.0.0.1:9/` (`NO_PROXY` covers
  loopback, so it fails at once): the traced turn made exactly that one refused connect and answered, resumed and
  ended normally. GitHub Copilot discovery (`hermes_cli/copilot_auth.py`): a token from `COPILOT_GITHUB_TOKEN`,
  `GH_TOKEN`, `GITHUB_TOKEN`, else `gh auth token`, exchanged at api.github.com, then its model catalogue — on this
  machine it took the host's `gh` login. In the sandbox the variables are not passed (MS-18) and `gh` is Whombat's
  stand-in, which prints tokens as `***`; the runner must keep it so (and stream R should check what the stand-in
  answers to `gh auth token`).
- **The gateway, each start, then daily:** a plugin update check that asks pypi.org about pip-installed plugins — ours
  is one (`hermes_cli/plugins_updates.py`) — `plugins.auto_update_check_hours: 0`.
- **Each gateway start, then every 20 min:** the model catalogue (hermes-agent.nousresearch.com, raw.githubusercontent
  .com, openrouter.ai, portal.nousresearch.com) — `model_catalog.enabled: false`.
- **Passive update check** (api.github.com, github.com, hermes-assets.nousresearch.com) — `updates.check: false`; and
  the wrappers don't set `HERMES_REVISION`, without which an install with no git checkout never checks (NX-430).
- **On demand:** package-manager installs (github.com, npm, nodejs.org, PyPI, …) — off by `HERMES_DISABLE_LAZY_INSTALLS=1`
  in the wrappers, also `security.allow_lazy_installs: false`; language-server installs after edits (npm, Go proxy,
  PyPI; the npm path ignores the lazy-install switch) — `lsp.install_strategy: manual` or `lsp.enabled: false`; keyless
  web search (mcp.exa.ai, search.parallel.ai, api.firecrawl.dev, api.keenable.ai) — `web.keyless_fallback: false`;
  api.osv.dev before an `npx`/`uvx` MCP server — the runner's bridge is `node`, so not reached.
- **Only with credentials Hermes holds** (it holds none: HE-09, SUB-04): provider `/models` and context probes,
  auxiliary calls (titles, background review, smart approvals) — an explicit `model.provider` (never `auto`),
  `fallback_providers: []`, `approvals.mode: manual`, titles off, the background review only through the CLI.
- Telemetry is off by default (`telemetry.shared_metrics`); no crash reporting found. Messaging platforms, relays and
  their tokens: never set.
Stream P's `config/claude.yaml` has most of these; it lacks `plugins.auto_update_check_hours: 0`, `models_dev.url` and
`web.keyless_fallback: false`.

## NX-436 How it was checked, and what it adds to the image (2026-10-23; NX-430…NX-435)

- **The DEV twin's toplevel** builds as `release/build` builds it (`lib.applianceRelease { env = "dev"; releaseId =
  "whombat-dev-20261023.1"; }`, from the commit): 6007.1 MiB against the published twin's 5564.8 MiB (same release id,
  runtime 14057e5a), **+442.3 MiB, all of it Hermes's own paths** (85 store paths; the rest of the difference is what
  every host release rebuilds: manager, helper, units, the recovery image). A box's delta download is about that (UP-X14).
  It evaluates with NX-432's warning until the runtime pin has the plugin.
- `checks.hermes` and the rest of CI's nix checks pass; `packages.whombat-hermes` builds with its install check, alone
  and with a stub plugin and patch (NX-432).
- `hermes acp` in a bubblewrap jail here (NX-434), and as the runner on the appliance in `runtime-live-turn`, whose
  new subtest passes (the runner's two variables, the root whombat-runner 0700, `initialize` and `session/new` in the
  jail, every file in the profile the runner's, no gateway left; slow in that small VM: 14 s and 62 s). The test then
  fails at its old step “one message to an agent”: its world script, bundled from the Whombat pin 14057e5a, stops at
  load (`ERR_AMBIGUOUS_MODULE_SYNTAX`: ssh2's `__dirname` beside top-level await). That bundle is the same store path
  without this change, so it fails the same way on the base commit: a test fix for whoever owns it, not Hermes's.
- With stream P's plugin (Whombat `he1-p` 9dd3f8b5, `--override-input whombat git+file://…?rev=…`): the patch
  applies, both entry points (`whombat`, `claude-cli`) load, 510.8 MiB; real Claude turns through it on this machine's
  own sign-in (P's `acp_e2e.py` steps `answer` and `resume`) pass, with models.dev refused (NX-435).


## NX-437 runtime-live-turn runs again (2026-10-23; NX-75, NX-436; Whombat step 2, stream N2)

- **The world script loads**: `vm-tests/common/live-turn.nix` bundled it with an older copy of the release bundles'
  options, without the bundle's own file and directory for CommonJS that reads `__filename`/`__dirname` at load
  (ssh2's agent module), so Node stopped at load with `ERR_AMBIGUOUS_MODULE_SYNTAX` (NX-436). It now has the release
  banner's `__wbModuleFile`/`__wbModuleDir` and the same `define`s (Whombat `scripts/package/src/build.ts` `BANNER`,
  VT-D42).
- **The Hermes probe dials once more**: with the plugin in the image (pin 06311b2e) `hermes acp`'s first `session/new`
  in the jail sometimes fails with “Gateway connection failed” — the gateway it started didn't take the viewer's
  WebSocket within Hermes's 10 s open timeout in the small, busy VM (initialize took 14 to 88 s here; four cores
  instead of two didn't help). A second `session/new` dials the running gateway and passes; the probe says when it did.
- `nix build .#checks.x86_64-linux.runtime-live-turn` passes on the pin: the Hermes subtest, then the fake Claude
  Code's turn through the runner's sandbox.
- **Not done: a real turn on the scripted Hermes in the Hermes subtest.** The pin is step 1, which has no scripted
  Hermes. When the pin moves to step 2 every turn is a Hermes turn, so “one message to an agent” runs the image's
  Hermes in Claude Code mode with `fake-claude.js` as the installed client (the plugin's stream-JSON: `initialize`,
  the user message, `result`, which the fake answers); check that subtest first at that pin. `WHOMBAT_AGENTS=live` is gone from
  `nix/modules/runtime.nix` (IN-405): on the step-1 pin the runner would default to its scripted provider, so this test
  needs the step-2 pin that ships with it.

## NX-438 Hermes's browser on the computer; our browser host goes (2026-10-23; Whombat HE-20, HE-42, HE-S137…HE-S143; step 3, stream N3)

*Amended by NX-491 (2026-11-02): agent-browser's pin is Whombat's (`agent-browser.json` beside its plugin), not Hermes's
lock, and the browser tools that run it are the plugin's.*

- **The browser host goes from the image**: `nix/modules/browser.nix` (the `whombat-browser` unit, its gate and stop
  script, Chromium's policies, its fonts), the `whombat-browser.slice` and its options, the egress chains `browser` and
  `browser_lo_reply` with their jumps, the server's `WHOMBAT_BROWSER_SOCKET`/`…_STATUS_FILE` and group, the runtime
  bundle's and the stand-in's `bin/whombat-browser-host`, the `browser-config` check and the VM tests `browser` and
  `browser-real-runtime` (CI's lists too). uid/gid 961 is retired, not reused: a box may still have files of it. The
  kiosk keeps its own Chromium; `liberation_ttf` left with the unit (the kiosk has DejaVu). The computers' VM tests keep
  the test network as `vm-tests/common/lan.nix`, without the browser's pages and helpers.
- **agent-browser beside `hermes`**: Hermes's browser tools run `agent-browser` against `browser.cdp_url` (the runner's
  relay to the computer's Chromium, HE-S138), and the runner puts the directory of `WHOMBAT_HERMES_BIN` on Hermes's PATH
  in a turn with a browser. The Hermes package carries the version and npm tarball sha256 Hermes's own `pm/lock.json`
  pins (0.26.0; Whombat's development install takes the same), its native Linux binary only (no Node, no Chromium
  download), linked against our glibc (autoPatchelf); Apache-2.0; 10.5 MiB. Checked: its install check and Hermes's run
  `agent-browser --version`; here the image's binary opened a page in a headless Chromium over CDP and read its title.
  A new Hermes pin brings its lock's agent-browser with it (NX-433).
- **bin/python beside `hermes`**: a Codex-mode turn with a browser starts Hermes's `hermes-tools` MCP server with the
  Python that runs Hermes (HE-S138, the runner's `hermesPython`: `python` beside the real `hermes`, else its shebang,
  else `python3` on the `PATH`, which isn't Hermes's). `bin/hermes` is a shell wrapper, so the package adds the
  environment's interpreter as `bin/python` with the entry points' settings (no lazy installs). Checked: its prefix is
  the environment and it serves the tools server (`initialize`, `tools/list`). Whether a Codex-mode turn runs inside the
  managed sandbox on the appliance isn't shown by any test here: `runtime-live-turn` runs a fake Claude Code only, and a
  VM has no real `codex`; that is the DEV box's `k-live-agents`/a real turn.
- **The computer needs nothing new from the image**: computerd builds the base image from Debian (`BASE_PACKAGES`,
  Whombat AC-05), which already has `chromium` (the relay's `chromiumCommand` starts the first of `chromium`,
  `chromium-browser`, `google-chrome…` on its PATH) and `nodejs` (each connection's tunnel); browsing leaves through the
  computer's own wall (NX-131). The VM tests' computer is busybox (no Internet to build the base image), so the CDP path
  is covered by stream B's runner tests on local computers, not here.
- **Not done, for the lead: the shared skills on the computer** (Whombat HE-S126 shares `$WHOMBAT_HERMES_ROOT/skills`
  read-only with the computer so a skill's scripts run there). computerd refuses it on the appliance and in the dev
  stack: the path isn't under `WHOMBAT_COMPUTERS_ROOTS` (here the workspaces and the runner's temp; local computers'
  defaults likewise), and computerd never shares a root itself (`#checkPath`: `real !== r`), so adding the skills
  directory as a root wouldn't do and the whole Hermes root would open every profile to the fence. The runner logs a
  warning and the turn goes on without them. It needs computerd to accept a read-only root shared whole (a runtime
  change); the image then adds the directory to `roots`.
- **The release's skills reach the runner as they are** (Whombat HE-S128, stream K): the runtime package copies the
  bundle's `skills/` (120 skills in 19 categories at step 3; the build fails without them, NX-406), the runner's bundle
  sets `WHOMBAT_APP_DIR` to the package and runs managed, so it syncs `$WHOMBAT_APP_DIR/skills` into
  `/persist/whombat/hermes/skills` at start (its `ReadWritePaths`; the store is readable under `ProtectSystem=strict`),
  which BK-36 backs up. The dev stack's runner runs from the checkout (no `WHOMBAT_APP_DIR`) and reads its `skills/`.
- **Shipping**: a host release (the image's units and the Hermes package change), with the step-3 runtime pin: the
  step-2 runtime's browser tools would be off on this image (no host for its server).
- NX-434's backup item is done: BK-36.

## NX-440 Tailscale in the image and the direct port: one inbound port (2026-10-24; Whombat HE-50, HE-51; reverses NX-22 for that port; step 4, stream N4)

- **tailscaled on every image** (`nix/modules/tailscale.nix`, `whombat.tailscale.enable`, default on): nixpkgs' Tailscale
  1.98.10 and NixOS's unit, **signed out** until an owner signs the box in from Settings → This Whombat with Tailscale's
  own login link (Whombat DC-13…DC-16). Nothing signs in by itself: no auth key, no `tailscaled-autoconnect` or
  `tailscaled-set`, no `extraUpFlags`. Signed out it reaches nobody (no login, no log uploads), so a box that never turns
  it on sends nothing to Tailscale.
- **Its state on /persist**: `/persist/tailscale` (0700 root, tmpfiles) is bound on the unit's own `/var/lib/tailscale`
  (`BindPaths`), so the upstream `--state=/var/lib/tailscale/tailscaled.state` and the certificates beside it live on the
  encrypted volume; the unit waits for `whombat-persist.target`. **Not in backups** (the backup sources are explicit,
  backup.nix): a node key restored onto a replacement box would be a second machine with the first one's identity; the
  new box signs in as itself. A factory reset forgets it with the rest of /persist.
- **Off in tailscaled, whatever its operator asks**: Tailscale SSH (`TS_DISABLE_SSH_SERVER=1`: `tailscale set --ssh` is
  refused, even for root — the tailnet is never a way into the box; NX-10), Taildrop, log uploads
  (`TS_NO_LOGS_NO_SUPPORT`), and UPnP/NAT-PMP/PCP towards the router (`TS_DISABLE_PORTMAPPER`; the egress wall refuses
  them anyway). `TS_DEBUG_FIREWALL_MODE=nftables`: the appliance has no iptables; tailscaled's own tables don't open
  anything, since every base chain must accept and ours drop (below).
- **Egress** (network.nix): its control, DERP and certificates go over TCP 443 like everything else; its WireGuard and
  STUN datagrams leave from its UDP port (`whombat.tailscale.port`, 41641): `meta skuid 0 udp sport 41641 accept`. Root
  only, from that port only (tailscaled holds it). **Nothing of it inbound**: NAT traversal's answers come back as
  established traffic, so the port isn't opened (a peer that can't punch through uses DERP). No HTTP (80) for its captive
  portal check.
- **The direct port, 4480** (`whombat.network.directPort`; contracts `DIRECT_PORT`, CT-1250): the only inbound port of
  the box (NX-22's “nothing inbound” stands for everything else; the ports agents publish stay NX-138's). Open
  - on the local network: `iifname` of the cable's interfaces (`defaultInterfaceMatch`, `en* eth*`) and Wi-Fi's (`wl*`),
    from private sources only — 10/8, 172.16/12, 192.168/16, 169.254/16, ULA fc00::/7, link-local fe80::/10. Never from a
    public address, whatever the interface (a box with a public address keeps nothing inbound), and not from CGNAT's
    100.64/10 on the LAN (an ISP's shared space isn't the owner's network; it is Tailscale's on `tailscale0`);
  - on `tailscale0`, from anyone tailscaled lets in (the owner's tailnet and its ACLs);
  - never from the agents' computers: their bridge is refused before any of this (computers_to_host, NX-131) and isn't
    a LAN interface.
  The runtime keeps its own rule behind the firewall (Whombat DC-03: `lan` excludes virtual interfaces; sources must be
  private, Tailscale or loopback).
- **The runtime server's environment** (runtime.nix; the runner gets none of it): `WHOMBAT_DIRECT_PORT=4480`,
  `WHOMBAT_DIRECT_INTERFACES=lan,tailscale0` (Whombat DC-03's keywords; `lan` alone with Tailscale off); the web app
  is the bundle's own `web/` (NX-442); no tailscaled socket (Tailscale is the manager's, NX-441). The server already
  has `AF_INET`/`AF_INET6`/`AF_NETLINK` and binds an unprivileged port, so its unit needs nothing else.
- Since Tailscale is on the box, the ports agents publish (NX-138, sources including 100.64/10) answer the owner's tailnet
  too. Kept: they are the owner's own devices, as on the LAN.

## NX-441 The manager operates tailscaled; nothing else on the box reaches it (2026-10-24; Whombat HE-51; contracts CT-1255)

- **The operator is the manager** (`whombat.tailscale.operator`, default `whombat-manager`): tailscaled's only non-root
  user with write access to its local API, and its only caller (contracts 1.0.0 CT-1255: the manager drives Tailscale
  for the runtime through `MANAGER_PATHS.tailscaleState|On|Off|SignIn|Cert` on its socket, and hands the runtime the
  certificate and key for the box's Tailscale name for the direct listener's HTTPS; MG-130). Set at every start by
  `tailscale set --operator=whombat-manager` (ExecStartPost, ten tries): a box that never signed in has no profile, so
  its prefs aren't kept across a restart (the VM test saw them go); once signed in they are. Write access covers the
  certificate (`/localapi/v0/cert`), so no `TS_PERMIT_CERT_UID`.
- **Nobody else reaches the socket**: the unit's `/run/tailscale` is 0750 root:`whombat-manager` (`RuntimeDirectoryMode`,
  and a `chgrp` as the last ExecStartPost: systemd sets a RuntimeDirectory's owner again before every command of the
  unit, so a chgrp in ExecStartPre was undone at ExecStart — found by the VM test; until it runs only root gets in). The
  runtime server, the runner, the agents' sandboxes and the hosts service can't read the tailnet's status; the server
  gets no tailscaled socket. Root keeps the CLI (remote help's Look and fix: `tailscale status`).
- **Why the manager, not the runtime** (the lead's choice with contracts, after the first brief said the runtime): an
  operator may change every Tailscale pref — accept routes or DNS from the tailnet, advertise routes, sign the box out
  or into another tailnet, serve TCP ports. The manager already owns the box's network (Wi-Fi, network candidates,
  MG-100…); the runtime faces the network and keeps only what it needs: the state and the certificate, through the
  manager. SSH, Taildrop and log uploads stay off in tailscaled whoever asks (NX-440).

## NX-442 The web app for direct browsers ships with the runtime (2026-10-24; Whombat HE-50)

- **What**: `web/` of the whombat-app release the pinned Whombat vendors (`vendor/whombat-app/PIN`, its
  `whombat-app-dist-<PIN>.tar.gz`, checked against the release's `SHA256SUMS`), the build the runtime serves on the
  direct port to browsers on the LAN and on Tailscale (Whombat DC-*: whombat-app's session build). `nix/packages/runtime`
  builds it as its own derivation (`passthru.web`, `whombat-app-web-<PIN>`, from `builtins.path` of that release's
  directory only) and links it as `<runtime>/web`; `share/whombat/bundle.json` names it (`"web": "<PIN>"`).
- **Why its own store path**: a new Whombat commit that keeps the app release builds the same path, so a runtime update
  (delta updates, per-path blobs) downloads none of its ~19 MB again; only an app release moves it.
- **Where the runtime finds it**: `$WHOMBAT_APP_DIR/web` (Whombat R2: the bundles set `WHOMBAT_APP_DIR` to their own
  package), no setting of the image's: it is inside the runtime the profile points at, so it moves with every runtime
  update and a rollback brings the matching web back. The stand-in runtime has none (VM tests don't serve it).
- If whombat-app 1.0.0 puts the box's build elsewhere in its artifact than `web/`, the derivation's `tar … web` is the
  one place to change. The build must not embed an environment (control or relay origins): one runtime closure serves
  DEV and production boxes.

## NX-443 How it is checked (2026-10-24; NX-440…NX-442)

`checks.tailscale-direct` (vm-tests/tailscale-direct.nix, in the CI list `scripts/ci/virtual-machines.sh`): an
unprovisioned appliance and a LAN host. tailscaled runs signed out (no login link, no addresses, WantRunning false), its
state only in `/persist/tailscale` (0700 root), `tailscale0` exists, SSH/Taildrop/log knobs set, no autoconnect unit;
the socket's directory is 0750 root:whombat-manager, the operator pref is `whombat-manager`, the manager's user changes a
pref, `tailscale set --ssh` is refused for it and for root, the runtime server, the runner and nobody can't connect; the
server's environment has the direct port and `lan,tailscale0`, no tailscaled socket, and the runner's none of them; a listener on 4480 answers the LAN host from 192.168.1.1 and ULA, not from a
public IPv4/IPv6 address or 100.64/10 on the same link, and a listener on 4481 answers nobody; the input chain opens 4480
on `tailscale0`; UDP from 41641 leaves for root only; a restart stays signed out with the operator set again. Its log
shows tailscaled contacting no Tailscale server until the manager turned it on (then, without a network, its bootstrap
DNS attempts), so a box nobody turned on sends nothing to Tailscale.
`appliance-basic` now allows exactly one listener outside loopback, on 4480 (none with the stand-in runtime). Not covered: a real
sign-in (no tailnet in a VM test; the DEV box with John's tailnet is the first), traffic over `tailscale0`, and the real
runtime's listener (stream R2's). `nix build .#whombat-runtime.web` and the runtime package's install check
(`web/index.html`).

## NX-444 The operator stays after a sign-out (2026-10-24; NX-441; manager MG-135)

tailscaled's logout deletes the box's profile and starts an empty one without an operator, so after “off and sign
out” the manager's every write to tailscaled was refused (403: not root, not the operator) until tailscaled restarted:
the owner couldn't turn Tailscale on again. `whombat-tailscale-operator.path` watches `/persist/tailscale/tailscaled.state`
(`PathChanged`: a sign-out writes it; otherwise prefs changes and key renewals, rare) and runs the same `tailscale set
--operator=whombat-manager` as root; tailscaled writes nothing when the pref is already set, so it can't trigger itself.
The manager's change of login server (MG-135) uses `start` with the whole prefs instead of a logout, so it never loses the
operator in the first place.

## NX-445 The community edition (2026-10-24; Whombat HE-24, HE-58…HE-64; manager MG-136; updates UP-X27)

One image, two editions: **`whombat.edition = commercial | community`** (options.nix), apart from `whombat.environment`.
The modules decide by it, so a profile can't build half of one; `nix/profiles/community-instance.nix` only names where
the edition's trust comes from.

- **No licence** (licence.nix asserts no key set; no warning), **no control** (manager.json `control.url` "" and
  `edition: community`, MG-136; update-helper.json `edition: community`; provisioning makes the identity on the box,
  below), **no relay** (image.json names no relay or control host; the installer checks neither), **no remote help**
  (support.nix refuses `whombat.support` on community; the profile turns it off), **no hosted UI or Feedback drop**
  (`whombat.runtime.appUrl`/`embedUrl` null: the runtime's own page stands for the app, Whombat HE-S202), **no claim
  card** (no `WHOMBAT_CLAIM_FILE` credential: claimed on the box's own page with the code on its screen, HE-59). The
  runtime and its CLI get `WHOMBAT_EDITION=community` (the server's environment and `/etc/whombat/runtime.env`); the
  image sets no `WHOMBAT_LICENCE`, licence keys file or `SMTP_URL` (the runtime decides; the owner sets a mail server).
- **Only on community, never written for commercial**: `edition` in manager.json, update-helper.json, self-provision.json
  and `WHOMBAT_EDITION`. Both parsers are strict, and a commercial box's known-good manager may be older than the
  configuration it reads (MG-130's rule).
- **Its own identity at first boot** (`whombat-provision self` with `"edition": "community"`, no `controlUrl`): the
  self-installed flow with a local registrar (`provision.LocalRegistrar`): the registration's two signatures checked as
  control would, a device id made on the box (`wb-xxxx-xxxx-xxxx`, Crockford base32 from 60 random bits, the shape
  control's ids have), the route `local`. The box is unclaimed until its local claim. No re-registration path (nobody
  retires a community box).
- **Its own update channel**: the pinned root and client channel keys are `manifest/community/` (the community test
  repository's, `release-tools/fixtures/community-test`, UP-X27), and the manager takes the newest release from it
  (MG-136). **Test keys only** (HE-62): their key ids are development keys, so a `prod` box refuses the root and
  manager.nix refuses to build a prod image that pins it; the image is therefore `environment = "dev"`, which here means
  only that (no development convenience is on: the real runtime bundle, the nix activator, the self-installed
  platform's storage). A published community edition gets keys from a custody ceremony and may then be `prod`. The
  profile's update address (`https://community-updates.whombat.com/`) answers nothing (no public channel, HE-62); a
  release built for a test names its own (`release/build community --updates-url`, applianceRelease's `updatesUrl`).
- **Tailscale on**, and **tailscaled may reach the owner's own login server on the local network on any TCP port**
  (network.nix: root to 10/8, 172.16/12, 192.168/16 and fc00::/7, community only): an owner's Headscale is usually a
  machine on their network on its own port (`http://headscale.lan:8080`), and the egress wall otherwise lets root out on
  443 only. Root, not tailscaled alone: nftables can't match a cgroup that doesn't exist when the table loads, and on a
  community box root's other processes don't dial out (the helper and support service are local; nix fetches nothing).
  A login server on a public address still needs 443.
- **Decided for community, gated by the profile**: no console shell and no Incus agent (DEV-box conveniences; base.nix
  refuses both in prod), no hosts service (DEV only, its agents unsigned; NX-152), no serial line with the claim code
  (NX-120 is the DEV box's), the desk, voice, presence, Bluetooth, computers and Wi-Fi as on every appliance.
- **Builds**: `nixosConfigurations.self-installed-community` and `installer-community`, `packages.installer-iso-community`
  (no release id), `releaseEnvs.community` (`whombat-installer-community.iso`), `release/build community
  whombat-community-YYYYMMDD.N [--updates-url URL] [--iso]` (environment `dev`; `--allow-dirty` and `--runtime-label`
  as for dev; build.json records the URL and `release/build iso` builds with it), `release/community-repo init|publish|
  status` for a working copy of the test repository. Nothing is published.
- **Checked**: `checks.community-config` (the edition's config files built and read; the assertions above refused with a
  licence, remote help or `prod`; a commercial box's configuration names no edition, its server keeps the claim file;
  a community release's id, ISO name and update address); the install test (IN-430) end to end.

## NX-446 A factory release missed at the first start is recorded at a later one (2026-10-24; MG-20, NX-33)

A self-installed box records its factory release (the manager's journal, the helper's seed) right after it made its
identity, and needs its update repository for that. When the repository was out of reach at that moment (no network
yet: a box on Wi-Fi, a cable plugged in late, a repository on a port the egress wall closed), the unit failed, and every
later start skipped it because `device.json` existed: the manager never had a journal and never ran. The unit now also
starts while neither journal record (`/persist/manager/journal/journal.{a,b}.json`) exists, records the release then
(its own retry delay as before) and starts the manager and the runtime. Found by the community install test (IN-430),
whose first image couldn't reach its repository's port; on both editions.

## NX-447 Hermes's optional skills are on the box (2026-10-24; Whombat HSK-06, NX-430)

Whombat's skills are Hermes's now (Whombat `docs/decisions/hermes-skills.md`): owners add more from Hermes's hub in
Settings → Skills, and its `official` source is Hermes's own optional skills, read from the package, not the network.
The Hermes package copies `optional-skills` into `share/hermes-resources` beside the bundled skills, plugins and
locales, so Hermes's assembler links it into the install root and the wrapper sets `HERMES_OPTIONAL_SKILLS` (checked on
a local build: the wrapper names it, 152 skills there). The optional MCP catalogue stays out.

## NX-455 The agents' computers are gone (2026-10-25; Whombat one-person.md OP-04, OP-15; the brief's stream N)

Hermes runs the agent's commands on the appliance itself, each in a thin wrapper of the runner's (OP-07); the computers
and everything under them go, with nothing kept for old releases (HE-27): `nix/modules/computers.nix` (Incus, its
storage, gate, status, move and memory units, the bridge and its tables, computerd's unit), `computerslan/` and its
package `whombat-computers-lan` (RA-41's “this Whombat's own networks” set: the local network, NX-144, covers it where
it is on, the Vault's home networks where it isn't), the VM tests `computers` and `computers-real-runtime` with
`common/computer-image.nix`, the flake check `computers-config` (now `containers-config`, NX-467), root's subordinate ids
for Incus, gids 963 (`whombat-computers`) and 964 (`incus-admin`, both retired, not reused), Incus and computerd in the
critical slice, the computerd wrapper of the runtime package (NX-456) and Incus's 107 MB in the image (NX-129).
The DEV image's Incus *agent* (NX-143) stays: it is how a DEV box running as an Incus VM is looked into, not the
agents' computers. Superseded: NX-129…NX-133, NX-136, NX-137, NX-139, NX-141, NX-148, NX-150, NX-151; amended: NX-138
(NX-461), NX-142 and NX-146 (NX-457), NX-144 (NX-460).

## NX-456 The commands' network daemon: computerd's uid, its own unit (2026-10-25; Whombat OP-07; the brief's I-4)

The agent's commands share one network namespace per pod whose `127.0.0.1:3128` leads to a proxy with the computers'
rules (Whombat stream R2). The proxy runs in `whombat-agent-net.service`: the runtime bundle's `bin/whombat-agent-net`
(the runtime package wraps `app/agent-net.mjs` when the bundle has it, as it did `computerd.mjs`; a bundle without it
leaves the unit skipped), `PartOf` the runtime target, as uid/gid **962** (computerd's, renamed `whombat-agent-net`;
NX-08's fixed ids), in the critical slice at -900 with `MemoryMin` 64 MiB (core, as the runner whose commands it
carries; NX-142). Its socket is `/run/whombat-agent-net/proxy.sock` in a directory 0750 `whombat-agent-net:whombat-agent-net`
(tmpfiles); the daemon makes the socket (`UMask` 0007, so 0660); **the runner is in the group, the server isn't**.
Environment: `WHOMBAT_AGENT_NET_SOCKET`, `WHOMBAT_AGENT_NET_DENY` (`whombat.agent.deny`, more public networks it
refuses), `WHOMBAT_AGENT_NET_SERVICE_PORTS` (20000–20099, the agent's own services it may open on 127.0.0.1, NX-461).
It lets nothing out until the runner gives it a policy (R2's `control.sock`), so at boot the commands have no network
yet. The runner also gets `WHOMBAT_SANDBOX_NSENTER` (util-linux's `nsenter`: commands join their namespace with it)
and, with the server, `WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES` (`whombat.agent.approvalWaitMinutes`, 15). The agent's
Chromium is the tools' (the kiosk's package) with the image's fonts; the kiosk's managed policy in `/etc/chromium`
(every URL blocked, DevTools off) must stay out of the commands' sight (R2's wrapper).
Hardening: no capabilities, `NoNewPrivileges`, `ProtectSystem=strict`, nothing of `/persist` and none of Whombat's
sockets in sight (`InaccessiblePaths`), `RestrictAddressFamilies` unix/inet/inet6, the usual protections; its wall is the
egress table's (NX-460), not `IPAddressDeny`, since it opens the Vault's home networks and the local network.

## NX-457 The agent's container engine: rootless Podman as `whombat-containers` (2026-10-25; Whombat OP-16; I-2)

- **Who.** uid/gid **971** `whombat-containers`, subordinate ids **3000000 + 65536** (`whombat.containers.idRange`; an
  assertion refuses an overlap with the runner's sandbox range 2000000 + 65536). A container's root is 971 on the host,
  its other users 3000000 + n. The user owns the containers' storage and nothing of Whombat's.
- **The socket.** `whombat-containers.socket`: `/run/whombat-containers/podman.sock`, 0660
  `whombat-containers:whombat-containers` in a 0750 directory; the runner and the server are in the group and get
  `WHOMBAT_CONTAINERS_SOCKET`. Docker's API (`podman system service --time=0`, socket-activated and also started at boot
  and with the runtime target, never part of it).
- **Podman 5.8.7** of the pinned nixpkgs with crun, conmon, netavark, aardvark-dns, pasta and catatonit (no runc), its
  configuration from the store (`CONTAINERS_CONF`, `CONTAINERS_STORAGE_CONF`, `CONTAINERS_REGISTRIES_CONF`;
  `/etc/containers/policy.json` accepts what registries serve, as Docker does): the overlay driver in the user
  namespace (no fuse-overlayfs), cgroupfs with `cgroups = "split"` under `Delegate=yes`, pasta for the default network,
  netavark for compose's, short names on docker.io, events and logs to files (10 MiB a container).
- **Where it runs.** The tasks' slice (with the runner: NX-19's caps), every process at **oom_score_adj 500** (the unit's
  `OOMScoreAdjust`, set as root, so nothing in a container can go lower; `oom_score_adj = 500` in containers.conf too),
  as the computers had (MP-02, NX-142), `MemorySwapMax=0` (NX-146), `TasksMax` 4096.

## NX-458 The containers' storage: /persist/containers in the qgroup 1/101 (2026-10-25; Whombat OP-16; amends NX-12, NX-150)

The engine's graph root (images, containers, their volumes), its home and its temporary files (layers being unpacked,
build contexts: `image_copy_tmp_dir` and `TMPDIR`, emptied at every boot) are the subvolume `/persist/containers`,
which `whombat-persist-layout` puts in the qgroup **1/101** — the computers' until NX-455, now the containers', with a
limit of its own (`whombat.containers.storagePercent`, default 50 % of /persist's usable size) inside 2/100, the one
that keeps the database's reserve (NX-12). The overlay driver keeps every layer in that one subvolume, so nothing
escapes the qgroup (`whombat-qgroups` still moves a subvolume made under it into 1/101 and rescans lost counts).
`whombat.storage.computers` is `whombat.storage.containers` (`subvolumes`, `percent`; `moved`, NX-151's, goes).
**Not backed up** (the backup's caches class names it): a restored box pulls its images again and the agent runs its
services again; what the agent wants to keep belongs in its home (NX-465).

## NX-459 What the engine sees: of /persist its storage, the agent's home and the workspaces (2026-10-25; OP-16)

Bind mounts reach only the agent's home and work folders (OP-16) because the engine's unit sees nothing else of
/persist: `TemporaryFileSystem=/persist:ro` with `BindPaths` of `/persist/containers`, the agent's home and
`/persist/whombat/workspaces` (writable), Whombat's sockets and the runner's state inaccessible, `ProtectSystem=strict`,
`ProtectHome`, `PrivateTmp`. `whombat-containers` is in the group `whombat-workspaces`, and containers keep the engine's
groups (crun's `run.oci.keep_original_groups`), so a container's process, whatever user it runs as, may write the
agent's home or a workspace. The workspaces' root carries default ACLs like the home's (`user:whombat-runner:rwx`,
`group:whombat-workspaces:rwx`, mask `rwx`): what a container makes there stays writable for the runner and what the
runner makes (with its umask 0077) for the containers. Rootless Podman needs the
set-uid `newuidmap`/`newgidmap`: no `NoNewPrivileges`, the bounding set `CAP_SETUID CAP_SETGID` (what those two keep);
crun mounts a container's own proc and sys, so `ProtectKernelTunables`, `ProtectKernelLogs` and `ProtectControlGroups`
are off (as the runner's bubblewrap, NX-69); `DevicePolicy=closed` with `/dev/net/tun` (pasta).

## NX-460 The agent's wall: the computers' rules for the commands' proxy and the containers (2026-10-25; OP-07, OP-16; I-4)

The egress table gets `agent_wall`, NX-131's `computers_out` in the host's output path: the Vault's home networks (the
server's `vault4`/`vault6` and its conntrack mark, so an unlisted network closes again), `whombat.agent.deny`, never TCP
25, the local network (`local4`/`local6` when `whombat.network.localNetwork` is on, NX-144), nothing else non-public,
then the public internet (TCP, UDP, ICMP; IPv6 too, unlike the computers' bridge). Two chains lead to it, jumped to by
uid before the rules every uid has (`whombat.network.uidChains`, before `oifname "lo" accept`):
- `agent_net_out` (uid 962): answers and the Vault's established connections, on this host only the resolver stub and
  127.0.0.1 TCP 20000–20099 (the agent's own services, marked for NX-461), nothing else on this host.
- `containers_out` (uid 971: the engine's pulls, pasta's and rootlessport's forwards of the containers' traffic): the
  same, on this host only the resolver stub (pasta's DNS goes there).
Commands themselves are in their own network namespace (the runner's) and reach nothing but the proxy.

## NX-461 The agent's services: published ports 20000–20099 from private networks only (2026-10-25; OP-19; I-5; amends NX-138)

A container's port published on 20000–20099 (`whombat.containers.publishPorts`) is admitted by the NixOS firewall from
private sources only (RFC 1918, CGNAT with Tailscale, link-local, ULA, IPv6 link-local), and `containers_published`
drops every other new connection to them first: never the internet; from this host only the agent's commands through
their proxy (the conntrack mark `agent_net_out` sets, "SERV"), nothing else (the server, the runner, root). A table
loaded with the engine (`inet whombat_containers`, after its cgroup exists, as the runner's wall) drops every new
connection to a socket of the engine's cgroup on any other port, and UDP to it altogether: a container publishing
127.0.0.1:4620 while the server restarts, or the direct port, takes nothing. The server lists and stops the agent's
services through the engine's socket (containers labelled `whombat.service=1`, at most 5: the runtime's rule). The hosts
service's `agentPort` stays outside the range (its assertion now names `whombat.containers.publishPorts`).

## NX-462 Containers stop cleanly and come back (2026-10-25; OP-19)

The engine's `ExecStop` stops every container with its own stop signal (10 s) before the engine goes down at shutdown;
the engine's start (`ExecStartPost`) starts the containers with the restart policy `always` or `unless-stopped` (after a
boot Podman has reset their state). `KillMode=process`: a crash of the API process leaves the containers running under
conmon; `restartIfChanged = false`: a host activation leaves the engine and its containers as they are (the new unit at
the next boot).
- **Podman's namespace first** (`ExecStartPre=podman unshare true`): the API process and the restart step would
  otherwise both make the engine's user namespace at once, and the API process, re-executed into it, lost the socket
  systemd gave it (“unexpected fd received from systemd”) on the first start.
- **Podman's path for conmon.** A Podman that joins the pause process's mount namespace from the unit's reads its own
  executable (`/proc/self/exe`) without the store's mount point: `/<hash>-podman-5.8.7/bin/.podman-wrapped`. It gives
  conmon that as the exit command (`podman container cleanup`), which then never runs: an exited container is never
  cleaned up, a `--rm` one never removed, and `docker run --rm …` waits for the removal forever (found by the VM test,
  checked in a VM: with the path resolvable the attached run returns its output and exit code and the container is
  gone). tmpfiles links `/<hash>-podman-<version>` to the package at every boot, so that path is Podman's own.

## NX-463 What the computers left goes after the first blessed boot (2026-10-25; OP-04)

`whombat-computers-cleanup.service`, wanted by `boot-complete.target` and after it (a fallback to a release with
computers finds them until this release's boot is blessed), runs when any of `/persist/incus`, `/persist/incus-computers`,
`/persist/incus-pool`, `/var/lib/incus` or `/var/lib/whombat-computerd` is there: every nested subvolume made writable,
each of those subvolumes deleted recursively (`btrfs subvolume delete -R -c`), the root file system's mount points and
computerd's and the move's state removed, stale qgroups cleared, each step logged with its size (“deleted
/persist/incus-computers (12.3 GiB), the agents' computers' storage”). Nothing is kept: the computers were never backed
up (NX-130) and the agent has none any more.

## NX-464 The agent's tools and nix-ld (2026-10-25; Whombat OP-13; I-1)

`nix/packages/agent-tools`: `tools` (a buildEnv: shell basics, git, openssh, rsync, curl, wget, jq, ripgrep, fd, tree,
file, zip/unzip, tmux, less, nano, vim, sqlite; gcc, make, cmake, pkg-config; Node 24 with npm, npx and pnpm; Python 3.13
with pip, uv and python-docx, python-pptx, openpyxl, pypdf, pdfplumber, pypdfium2, reportlab, Pillow, numpy, pygount;
ffmpeg (headless), ImageMagick, pandoc, poppler, tesseract with eng/nld/deu/fra/spa/ita/osd; Chromium (the kiosk's) with
Hermes's agent-browser; Docker's CLI with compose, no buildx) and `libraries` (for nix-ld: libstdc++, zlib, zstd, bzip2,
xz, libffi, OpenSSL, curl, expat, libxml2, libxslt, libuuid, libcrypt.so.1, ncurses, readline, sqlite, ICU, glib, dbus,
krb5, libGL, libgbm, libdrm, fontconfig, freetype, pango, cairo, GTK 3, ATK, the X11 client libraries, ALSA, CUPS, NSS
and the rest manylinux2014 wheels and a downloaded Chromium ask for; not Mesa's drivers, 843 MB with LLVM). The runner
gets `WHOMBAT_AGENT_TOOLS` (the store path; its `bin/` first on a command's PATH), `WHOMBAT_AGENT_NIX_LD` (glibc's loader)
and `WHOMBAT_AGENT_NIX_LD_LIBRARY_PATH` (the libraries' `lib/`), a command's `NIX_LD`/`NIX_LD_LIBRARY_PATH`; `/lib64`'s
loader is nix-ld's (providers.nix). The `docker` wrapper defaults `DOCKER_HOST` to the engine's socket (the commands'
wrapper sets its own), `DOCKER_BUILDKIT=0` (Docker's classic builder, which Podman's API implements; BuildKit's it
doesn't) and `COMPOSE_BAKE=false`. GitPython (pygount's) runs the tools' git, not a second minimal one.
- **The image** (`appliance-toplevel`, `nix path-info -S`): **5.708 → 7.053 GB (+1.345 GB)**: +1.457 GB added (gcc 277 MB,
  pandoc 219, numpy's BLAS/LAPACK 175, uv 69, cmake 64, Podman 57 with its helpers, vim 45, compose 45, the docker CLI 38,
  tesseract's languages 122, …), −112 MB (incusd, its client, LXC, computerslan). The tools' own closure is 3.66 GB, most
  of it already in the image (Chromium, Node, Python, glibc).
- **Not added, measured** (whole closures from the binary cache; the lead decides): LibreOffice 25.8 (`libreoffice`)
  **2.81 GB**, 26.2 (`libreoffice-fresh`) 2.85 GB; TeX Live 2025 `texliveBasic` 0.45 GB, `texliveSmall` 0.62 GB,
  `texliveMedium` 2.69 GB, `texliveFull` 6.23 GB (what each adds to the image is less: they share glibc, fonts, Python,
  ICU with it).

## NX-465 The agent's home (2026-10-25; Whombat OP-16; I-3)

`/persist/whombat/agent/home`, a subvolume in Whombat's qgroup 1/100 (`whombat.storage.extraSubvolumes`), 2770
`whombat-runner:whombat-containers` with ACLs (`user:whombat-runner:rwx`, `group:whombat-containers:rwx`, and the same
as default ACLs with the mask `rwx`): whatever a command or a container makes in it stays writable for the other, the
runner's umask notwithstanding. The runner gets `WHOMBAT_AGENT_HOME` and may write it; the engine sees it at the same
path (NX-459), so `docker run -v ./src:/app` from the home works. Backed up (NX-466).

## NX-466 Backups: one Hermes home and the agent's home (2026-10-25; Whombat OP-08; amends BK-36)

- **Hermes.** The root is the person's Hermes home in Hermes's layout (R's): the manifest's `hermes` is
  `{stores, skills}` — every `*.db` and `*.db-wal` directly in the home and in each of its named profiles
  (`profiles/_feedback/`, OP-17), hashed, and the `SKILL.md` count of `skills/` outside hidden folders. No
  `profiles/<account>`, no `sharedSkills`; `ValidatePaths` holds each store to `files/hermes/` or
  `files/hermes/profiles/<name>/`. The restore check compares the same; the marker logs one home. Transient: `locks`,
  `transfers`, `check`, `signin`, `logs` (and `logs` in each profile). A checkpoint in the old shape restores only on an
  older release (HE-27).
- **The agent's home** is the source `agent` (after `hermes`, before `secrets`), snapshotted with the others inside the
  quiesce, its `.cache` always left out, its git repositories inventoried like the workspaces'. The coverage table's
  workspaces class names it; the caches class names `/persist/containers` (never a source). Tools from before refuse
  checkpoints with it.

## NX-468 Host metrics: the containers instead of the computers (2026-10-25; contracts 3.0.0; amends MG-63…MG-66)

The manager's measurements follow contracts 3.0.0: the disk part `containers` is qgroup 1/101 (NX-458);
`HostNow.containersMemoryBytes` is the engine's cgroup (`whombat.slice/whombat-tasks.slice/whombat-containers.service`,
its conmons and every container under it) less its inactive page cache, null while the engine doesn't run; the
computers' traffic (`computersIn/OutBytes`, the `wbc…` bridge) goes. The ring files keep their version and layout:
the bytes that held the computers' traffic are written as zero and never read, so a box keeps its history. The
runtime reports Claude Code's client adapter alone (contracts 3.0.0, HN-A02): the manager selects no Codex bundle.

## NX-467 How it is checked (2026-10-25; NX-455…NX-466)

- `checks.containers-config` (in `scripts/ci/nix-checks.sh` instead of `computers-config`): nothing of the computers
  or Incus; the engine's unit (user, ids, socket, slice, OOM score, swap, Delegate, KillMode, what it sees, its
  capabilities, ExecStartPre, a PATH without systemd-run, the link of NX-462, configuration from the store and what it
  says); newuidmap/newgidmap with file capabilities; the runner's and the server's settings; the agent's home and its
  ACLs; the commands' network daemon's unit; the egress table's order; published ports; the cleanup's ordering; the
  qgroup; the core units' MemoryMin and OOM scores (816 MiB); swap; the tools (every command OP-13 names, the docker
  wrapper) and the nix-ld libraries.
- `checks.containers` (a VM test with the test network; `vm-tests/containers.nix`), **passed 2026-10-25** under an
  `agent-resource run` lease (KVM, `QEMU_NET_OPTS=restrict=on`, about 5 minutes; every lease released): nothing of
  Incus; the engine as uid 971 with its subordinate ids, its socket for the runner and the server only, its storage in
  1/101; through the socket as the runner an image loaded, a build with Docker's classic builder, attached
  `docker run --rm` (output, exit code 3 passed through, the container gone), compose up with a published port; a
  container's root as 971 and its users in 3000000+, at oom_score_adj 500, in the engine's cgroup; bind mounts of the
  agent's home and a workspace writable both ways, nothing of Whombat's (secrets, the server's home, identity,
  credentials, /run/whombat, PostgreSQL's socket, the runner's state); a published port from a private address and not
  a public one, nothing outside 20000–20099, not from this host but the commands' proxy uid, a container's listener on
  another port of this host taking no connection; from a container and as uid 962 public addresses on 80, 443 and
  8123 but never 25, no private, metadata, denied or host address (the host's other addresses, pasta's mapped gateway,
  the server's loopback port, PostgreSQL), DNS through the resolver stub; the Vault's home networks open and close; the
  commands' network daemon's unit (uid 962, no capabilities, no /persist, its socket for the runner only); the tools
  and a program not built for Nix running with the commands' NIX_LD settings; the computers' leftovers (nested and
  read-only subvolumes, the dir pool's files, computerd's state) deleted by the cleanup and logged; a reboot: a
  container stopped with its own signal, the one with `--restart always` serving again.
- Not checked here: Podman with the real runtime (R2's commands and services), the engine on a real box's encrypted
  /persist, image pulls from the internet (the test network has none).

## NX-469 Hermes's Anthropic client is in the image (2026-10-25; Whombat HE-S297; amends NX-430)

- **The environment of `nix/packages/hermes` gets Hermes's `anthropic` extra** beside `acp` and `mcp` (`anthropic`
  0.87.0 as Hermes's `uv.lock` pins it, with its own dependencies from the same lock). A turn on the person's Anthropic
  key or through the AI gateway's Claude route runs on Hermes's Anthropic client, which needs that SDK; Hermes keeps it
  in an extra for its package manager to install on first use, and the wrappers turn those installs off (NX-430). Before
  this, John's first turn through Fusebox on Home failed before it sent anything (Hermes's `errors.log`: “The
  'anthropic' package is required for the Anthropic provider … lazy installs are disabled”).
- **Install check:** `anthropic` imports with the others, and `bin/python` (lazy installs off, as in a turn) builds
  Hermes's Anthropic client for the forwarder's relay address.

## NX-470 Speech to text: whisper.cpp 1.9.5, Parakeet and Whisper large-v3-turbo (2026-10-26; Whombat DT-02; supersedes NX-176's program and model)

- **Program**: whisper.cpp **1.9.5** (MIT; nixpkgs' `whisper-cpp` recipe at that tag, `nix/packages/voice-engines`):
  `whisper-cli` for Whisper and `parakeet-cli` for Parakeet (whisper.cpp's own Parakeet TDT engine since 1.9), with
  ggml's backends as libraries loaded at run time (the CPU's in every x86-64 variant, Vulkan's, NX-472). 104 MB with
  what it refers to; 1.8.4 had no Parakeet.
- **Models** (downloaded, NX-473): **Parakeet TDT 0.6B v3** (NVIDIA, CC-BY-4.0; ggml-org's `q8_0`, 668,757,119 bytes),
  English, Dutch and 23 more European languages, which it hears without being told; **Whisper large-v3-turbo** (OpenAI,
  MIT; whisper.cpp's `q5_0`, 574,041,195 bytes), the most accurate in Dutch, told the language (or `auto`) and the
  runtime's names prompt.
- **Measured** on The Titan pinned to 4 cores (a small box's budget), 25 Dutch (FLEURS) and 25 English (LibriSpeech)
  clips of about 9 s, words wrong after normalising case, punctuation, hyphens, accents and small numbers:
  Parakeet q8_0 6.5 % / 2.4 % in 0.6 s a clip with the model's load, 0.8 GB; Whisper large-v3-turbo q5_0 3.8 % / 2.8 %
  in 8.5–8.9 s (4.6–5.0 s on 8 cores). Not chosen: Parakeet through sherpa-onnx (its int8 export, 10.7 % Dutch, 1.2 s),
  Canary 1B v2 (5.2 % / 2.0 %, 2.4 s, a community export), Qwen3-ASR 0.6B (17.6 % Dutch), Whisper small (15.9 %) and
  medium (10.7 %), small.en (English only, 3.4 %, 2.0 s). Parakeet's f16 makes no fewer Dutch mistakes than q8_0
  (6.9 %). Shrinking Whisper's 30 s window (`--audio-ctx`) halves its time and breaks its text (28–55 % wrong).
- **A job** is one program run with every piece of the recording (`--file` each, the model loaded once): Whisper with
  `--language`, `--prompt`, `--no-timestamps --suppress-nst`, Parakeet with neither; both `--no-gpu` unless the chip is
  used. The silence rule (NX-176) holds. A job may take the service's timeout and three times the speech's length more
  (Whisper on a processor takes about as long as the speech).
- **Automatic** (`auto`): Whisper when it is downloaded and the service uses a graphics chip, else Parakeet, else Whisper
  on the processor (Whombat DT-03).

## NX-471 A long recording is cut at its pauses (2026-10-26; Whombat DT-07)

- `/v1/voice/transcribe` takes up to 300 s; the service cuts it into pieces of at most 30 s (`wav.Split`), each cut at
  the quietest 200 ms in the last third of the piece, and joins their text with a space.
- **Why:** given 4 minutes at once, Parakeet dropped phrases (Dutch 9.2 %, English 5.0 % wrong, against 6.5 % and 2.4 % on
  the clips) and peaked at 2.3 GB. Cut, the same recordings scored 6.9 % and 2.4 % and took 13.6 s and 11.9 s on 4 cores,
  0.8 GB.
- The answer's text comes in `parts` of at most 1000 code points (the contract's pattern limit, RE2's largest count).

## NX-472 The graphics chip: Vulkan, RADV without LLVM and ANV (2026-10-26; Whombat DT-02, DT-03; NX-169's follow-up for speech)

- **ggml's Vulkan backend** is built into whisper.cpp (`vulkanSupport`): a library of its own (34 MB) that runs on any
  Vulkan GPU and finds nothing on a machine without one, which then runs on the processor.
- **The drivers** (`nix/packages/voice-engines/vulkan.nix`, `pkgs.voice-vulkan`): RADV (AMD) built from nixpkgs' mesa
  recipe for that driver alone, with ACO and without LLVM (`amd-use-llvm` off, every optional feature off but zstd,
  xmlconfig and the shader cache): it needs only libdrm, libelf, zstd, udev and expat; nixpkgs' own RADV links libLLVM
  (566 MB). ANV (Intel) taken from nixpkgs' mesa as it is (it links no LLVM), its one reference to the rest of mesa (the
  `drirc.d` path) removed. The voice service names both manifests with `VK_DRIVER_FILES`; the kiosk still has no
  drivers (NX-169). NVIDIA isn't covered (its driver isn't in the image).
- **The probe** (`voice-gpu-probe`, ours): ggml's devices as JSON, once a service's life. A chip is used when it is a
  Vulkan GPU or integrated GPU with at least 2 GiB. A job that fails on it runs again on the processor and the chip
  isn't used again until the service restarts; so is one slower than the speech (at least 5 s of it, after the first job,
  which compiles the shaders). The health names the chip (`gpu`) only while it is used.
- **The sandbox**: the render nodes (`DeviceAllow=char-drm rw`, group `render`) and no other device; the shader cache
  on the service's private tmpfs (`MESA_SHADER_CACHE_DIR`), for its life.
- **Not verified on a chip yet**: The Titan has none (an ASPEED controller); the only number is a published one
  (large-v3-turbo through whisper.cpp's Vulkan backend on a Radeon 8050S: 333 ms for 10 s of speech). Home (the Z13,
  Radeon 8060S) is the first box with one.

## NX-473 The speech-to-text models are downloaded after the box is installed (2026-10-26; Whombat DT-05)

- **Not in the image** (John: “download the models after the appliance is installed (not during)”): the image carries
  `voice-models.json` (`pkgs.voice-models-manifest`, `nix/packages/voice-models`): each model's id, file name, source
  (a pinned Hugging Face revision), size and sha256. small.en (182 MiB) left the image.
- **The fetcher** `whombat-voice-models` (`voice/cmd/whombat-voice-models`, uid/gid 972): the only voice service with the
  network (AF_UNIX, AF_INET, AF_INET6), of /persist only its directory, no capabilities, nothing heard. Its socket
  `/run/whombat-voice-models/models.sock` is 0660 whombat-voice-models:whombat with the peer check (the server and
  root), the runtime's `WHOMBAT_VOICE_MODELS_SOCKET`. It fetches only what it is asked (the runtime decides, DT-05), one
  download at a time, resuming with a range request, and renames a file into place only once its size and sha256
  match. No internet: it waits (`waiting`, `no_network`) and tries again after 30 s, 1, 2, 5, 10 and then every 15
  minutes. Damaged twice, no room (the model and 256 MiB more), or refused by the source: `failed` until asked again.
  What was asked for is kept in `.wanted.json`, and the service also starts at boot, so a download carries on.
- **Where**: `/persist/voice-models`, a subvolume in Whombat's qgroup (counted against its limit) and not a backup
  source (the models download again); 2750 whombat-voice-models:whombat-voice, so the files (0640) take the voice
  service's group, which reads them through a read-only bind and can't write there.
- **Measured** on The Titan: Parakeet's 637 MB from Hugging Face in about 6 s; a download cut at 300 MB resumed through
  the CDN's redirect and finished with the right sha256 in 4 s; a complete part found after a restart was checked and
  renamed without a request.

## NX-474 The voice service for voice typing (2026-10-26; Whombat DT-07; amends NX-177, NX-180)

- `POST /v1/voice/transcribe` (contracts 3.1): the recording (base64 WAV, 16 kHz mono 16-bit, at most 300 s), `model`
  (`auto`, `parakeet`, `whisper`), `language` (`auto`, `en`, `nl`), `prompt`; the answer's `parts`, `seconds`, `model`
  and `gpu`. `stt` (the desk's) takes `model` and `language` too. The health names the models that are downloaded and
  run (`models`; `stt` is true when one is) and the chip (`gpu`).
- A transcribe answer lifts the server's write deadline for itself (a job may take minutes on a processor).
- **Sandbox**: of /persist the models only, read only (an empty read-only /persist with the models bound in); the private
  tmpfs 256 MiB (five minutes of speech are 9.6 MB, the shader cache lives there); MemoryMax 2G (parakeet-cli peaks
  near 820 MB, whisper-cli with large-v3-turbo near 790 MB, kokoro-speak near 550 MB; one at a time).

## NX-475 Checks of the voice (2026-10-26; amends NX-183)

- `checks.voice-speech` (the build sandbox) runs the service with Parakeet's real file (fetched for the check only) and
  Whisper tiny.en standing in for large-v3-turbo (the same program): the desk's question heard by Parakeet (which has
  no prompt: “pve two” comes out “P V to”), 40 s of speech cut in two and heard by Whisper, silence heard as nothing.
- `checks.voice-config`: the units, sockets, accounts, the models' subvolume (not a backup source) and the runtime's
  environment as the appliance has them.
- `vm-tests/voice.nix`: the fetcher downloads tiny.en from a source on the machine, the voice service hears with it in
  its sandbox, Remove, and a download that waits through a restart. Not run for DEV (the VM gates run on request).


## NX-476 Dutch speech: Supertonic 3 through sherpa-onnx 1.13.8 (2026-10-27; John: answers in Dutch were spoken in English)

- **Why another model**: Kokoro v1.0 has no Dutch voice (its languages are English, Chinese, Japanese, Spanish, French,
  Hindi, Italian and Portuguese), so a Dutch answer was read by an English voice. Supertonic 3 (Supertone, 2026-04;
  about 99M parameters, flow matching, 44.1 kHz) speaks 31 languages with Dutch among them, from the letters themselves
  (no eSpeak data, no lexicon), with ten voices (F1…F5, M1…M5).
- **Measured** on The Titan pinned to 4 cores, five typical Dutch desk answers each, heard back by Whisper large-v3-turbo
  (`-l nl`): Supertonic 3 int8 0.08 s of work per second of speech (about 0.9 s for a five-second answer with the
  model's load), 12–18 % words heard differently across its ten voices, mostly written numbers (“twaalf procent” heard
  as “12%”); Piper's Dutch voices 0.015 s and 16–18 % (alex: “bakak”, “Kleks”, “snapsels”). Supertonic was chosen for
  how it sounds (Piper's medium voices are the kind John found poor in English, NX-291). Its full-precision files
  (398 MB) spoke no better than sherpa-onnx's int8 ones (145 MB) and took as long.
- **Digits, times and names are written out by the runtime** (Whombat desk-display-talk.md): Supertonic reads “03:00”,
  “1,2 TB” and “pve-02” badly (“Om Noritri”, “Pivino”) and the written words well (“drie uur”, “één komma twee
  terabyte”, “P V E nul twee”).
- **Not chosen**: Piper's pim, ronnie and nathalie (fine-tuned from the Lessac voice, whose data is licensed for
  research only, not for speech products); miro and dii (CC BY-NC); Chatterbox Multilingual, Parkiet and XTTS (GPU or
  non-commercial); MMS-TTS (CC BY-NC).
- **sherpa-onnx 1.13.8** (from nixpkgs' 1.12.38; Supertonic 3 came in 1.13.2, its accents stopped being dropped in
  1.13.5): nixpkgs' recipe with the source and the dependencies 1.13.8's CMake looks for (espeak-ng `ed530aa`,
  piper-phonemize `f3ff95a`, openfst 1.8.5-2026-07-09; the others as before), still on nixpkgs' onnxruntime 1.24.4 and
  Eigen 3.4.1 (1.13.8 names 1.28.2 and 5.0.1; its 29 tests pass). Kokoro on it says the same as before.
- **`supertonic-speak`** (`supertonic-speak.cpp`, GPL-3.0-only like kokoro-speak because the library carries eSpeak NG;
  the WAV and the gain shared in `speak-common.h`): `--model DIR --speaker N --lang LL --output-file OUT.wav [--threads N]
  [--seed N]`, the text on stdin; speed 1.05, eight flow steps (as clean as sixteen at half the time), one gain to
  -3 dBFS, the model's 44.1 kHz kept (an answer of 600 characters is about 40 s, under 4 MB; the contract allows 6 MB).
  Without `--seed` every answer is drawn afresh.

## NX-477 Supertonic 3 is in the image, under Open RAIL-M (2026-10-27) — superseded by NX-528: not in the image

- `pkgs.voice-supertonic-model`: sherpa-onnx's int8 packing from a pinned Hugging Face revision
  (`csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11` at `cca5a0e6`, the same bytes as sherpa-onnx's GitHub
  release) and the model's own licence from `Supertone/supertonic-3` at `3cadd1ee` (the packing's LICENSE is the sample
  code's MIT). **138.6 MiB**; the programs grow by 0.25 MB. In the image like Kokoro (the desk speaks from the first
  boot), not downloaded like the speech-to-text models (DT-05).
- **The licence is BigScience Open RAIL-M**: redistributable and usable commercially, with use-based restrictions
  (Attachment A) that must be an enforceable provision of any agreement under which Whombat distributes or offers the
  model, and a copy of the licence for every recipient. The copy is in the model's directory and the restrictions are
  in `voice/NOTICES.md`. **Before production, Whombat's terms (the Appliance Terms) must carry these restrictions**; the
  terms are John's to change and are not changed here.
- nixpkgs has no Open RAIL-M entry and it is not free in nixpkgs' sense, so the package names it in `passthru.licence`
  rather than `meta.license` (where `allowUnfree`, off for everything else, would refuse it). `checks.voice-config`
  keeps asserting a free licence for every other model and names this one as the exception.
- sherpa-onnx quantized the four ONNX files; the notice says they were changed and by whom (the licence's 4c).

## NX-478 A Dutch answer is said in Supertonic's voice of the same kind (2026-10-27; contracts 3.4)

- The health lists `languages`: `["en", "nl"]` when Supertonic and its model are there, else `["en"]` (absent without
  text to speech). A `VoiceTtsRequest` with `language: "nl"` is said by Supertonic, `"en"` or none by Kokoro; one the
  health doesn't list is 400 `bad_request`, like a voice it doesn't have.
- **The voice**: the request's `voice` is still one of Kokoro's (the person's choice, Whombat DK-50); Dutch is said in
  Supertonic's voice of its kind: a woman's (heart, bella, emma) in **F2** (speaker 1), a man's (michael, fenrir, george)
  in **M4** (speaker 8), the voices of each kind that were heard back best. The kind comes with each voice
  (`--kokoro-voices name=speaker:accent:man|woman`, from the model's `passthru.deskVoices`; a voice without one is a
  woman's). `whombat.voice.supertonic.speakers.{woman,man}` choose others; `whombat.voice.supertonic.model = null`
  leaves the box English only.
- `whombat-voice --supertonic BIN --supertonic-model DIR --supertonic-speakers 1,8`; without them, English only.
- **Memory**: supertonic-speak peaks near 400 MB for the longest answer (Kokoro near 550 MB); MemoryMax 2G holds.

## NX-479 Checks of Dutch speech (2026-10-27; amends NX-475)

- `checks.voice-speech` runs supertonic-speak with the real model: a Dutch answer in a woman's voice is a 44.1 kHz mono
  WAV whose loudest sample (either way) is at -3 dBFS, and Parakeet hears it (“ja, pv102 draait prima, de backup was
  om drie uur klaar.”); a man's voice answers; a language the contract doesn't name is 400. The health has
  `languages: ["en", "nl"]`.
- `checks.voice-config`: the unit passes `/bin/supertonic-speak`, the model and `--supertonic-speakers 1,8`, and every
  voice with its kind; the model's licence is the one named exception (NX-477).
- Go: the engine's fake program plays supertonic-speak too (`--lang`, 44.1 kHz): the speaker of each kind, English
  still Kokoro's, an unknown voice or language refused, English only without the model's files.

## NX-480 A monitor on the box is a screen of its own (2026-10-27; Whombat DK-147, appliance CG-384)

- **How**: cage already stretches the kiosk's one window over every output (its default `-m extend`: the primary view
  is sized to the output layout's box). The browser loops (both, the installer's too) read the outputs with
  `wlr-randr --json` once they are lit and turned (`whombat-kiosk-outputs`, up to four tries half a second apart) and
  put them in the page's URL beside the token: `#t=…&o=<base64url of [{n, m, x, y, w, h, mw, mh}]>` — the compositor's
  name, the monitor's model, its place and size in the layout (turned and divided by its scale) and its size in mm. The
  page draws one screen per output's rectangle (CG-384). A display plugged in or out already restarts the kiosk
  (NX-147), so the fragment is always the outputs there are; nothing when wlr-randr can't say (the page is then the whole
  window, as before). The sleeping loop reads the token before the outputs are added.
- **Considered**: one window per output. cage shows one view at a time over the whole layout and has no way to put a
  window on an output; it would take another compositor (sway, labwc) with its own configuration, input mapping and
  idle handling, a larger change to the kiosk's security model (CG-03, CG-04) for no gain the page can't give.
- **Tried** on The Titan under a headless cage 0.3.0 (wlroots 0.20, pixman) with two outputs, Debian's Chromium on
  Wayland in kiosk mode, grim for the picture: a 2560×1600 and a 1920×1080 output side by side give a 4480×1600 window,
  the fragment reads back as the two, the page draws the box's grid in the first and the monitor's in the second; with
  the second turned (`--transform 90`) the window is 3640×1920 and the monitor's rectangle 1080×1920. Not tried on real
  hardware.

## NX-481 The box's own touchscreen stays on the box's own panel (2026-10-27)

- cage maps a touchscreen to one output only when libinput names one (udev's `WL_OUTPUT`, wlroots' `output_name`);
  without it a touch lands across the whole layout, which with a monitor plugged in is the wrong place.
- A udev rule asks `whombat-kiosk-touch-output` for every touchscreen event node (`ID_INPUT_TOUCHSCREEN=1`, `add` and
  `change`): a touchscreen that is part of the machine (`ID_BUS` i2c, spi, platform, host or rmi, or USB on a port
  marked `fixed`) gets `WL_OUTPUT=<the panel's connector>` when exactly one eDP, LVDS or DSI connector is connected
  (`/sys/class/drm/cardN-eDP-1` → `eDP-1`, the name wlroots gives it); anything else gets nothing, as before. A DRM card
  that appears triggers a `change` for the touchscreens (`udevadm trigger --action=change`), so a touchscreen that came
  before the graphics driver at boot is mapped too. With one output the mapping changes nothing.
- A touch monitor plugged into the box isn't mapped (a removable USB device): its touches still land across the layout.
  Its own mapping would need the monitor's connector, which udev can't tell from the touch device.
- Tried with a copy of the helper on a made-up sysfs (I2C, fixed USB, removable USB, two panels, one connected). Not
  tried on the Z13: whether its touchscreen is I2C or internal USB, and its panel's connector name, are the first things
  to look at on the real box with a monitor plugged in.

## NX-482 Each link answers ARP only for its own address (2026-10-28; amends NX-241)

- **Why**: Home (the Z13) had its USB cable and Wi-Fi on the same network, `10.100.1.81` and `10.100.1.97` in
  `10.100.0.0/23`. With Linux's defaults (`arp_ignore=0`, `arp_announce=0`) both links answered ARP for both addresses,
  so the router sent part of the box's IPv4 traffic to the Wi-Fi card: the first connection after a pause took about
  7 s, many took 15–30 s or failed (4,778 of 30,086 TCP connections since boot), and IPv4 bound to Wi-Fi never
  connected. IPv6 was unaffected, so it showed only with IPv4-only services: GitHub's device sign-in waited and
  failed (Whombat “Waiting for you to finish signing in…”).
- **How**: `net.ipv4.conf.all.arp_ignore = 1` (answer only when the address is on the link the request came in on)
  and `arp_announce = 2` (ask with the address of the link that sends), in `network.nix`. The kernel takes the larger
  of `all` and the interface's own value, so this covers every link, also ones added later. Nothing on the box relies
  on one link answering for another's address (no proxy ARP; Tailscale and the containers' networks are their own).
- **Tried** live on Home before release: afterwards each address is answered by its own link only (a raw ARP request
  from The Titan), and connections to github.com over the cable took 14 ms every time, also after 12 s idle (7.1 s
  before).

## NX-483 Hermes ships with the runtime, not the host (2026-10-28; Whombat HU-04; amends NX-431…NX-433)

- **Why**: Hermes publishes several stable releases a week (Whombat `docs/decisions/hermes-updates.md`), and with Hermes
  and Whombat's plugin in the host image every new pin, and every plugin change, was a host release: a reboot with boot
  counting, and an image's worth of checks (`hermes-host-delivery.md`).
- **Inside the runtime bundle, not a `hermes` provider profile.** Both would make a Hermes change a runtime-class
  update (profile switch, runner restart, the manager's go-back). The bundle wins because:
  - the plugin is already the runtime source's (`packages/hermes-whombat`, NX-432): one Whombat commit is one runtime,
    one Hermes and one plugin, which is what the runner's exact pin check expects (Whombat HE-10, HE-52);
  - the pin agreement can be checked at evaluation (below), not only on the box;
  - nothing new in the tuple, TUF, the helper or control: no tuple carries providers today (`providers: []`), their
    profiles have no pruning (UP-X18), and a release would need a second version line for Hermes, which Whombat
    doesn't want (HU-01: Hermes never moves apart from what Whombat tested);
  - delta updates already download only missing store paths (UP-X14), so a runtime whose Hermes didn't change downloads
    none of it again, and one whose Hermes did downloads only Hermes's own changed paths.
- **How**: `nix/packages/runtime` takes `hermes` (the overlay passes `pkgs.whombat-hermes`, built from the same Whombat
  source's plugin) and puts it at `$out/hermes`; its `bin/whombat-runner` sets `WHOMBAT_HERMES_BIN` to that Hermes with
  `--set`, so it wins over a host that still names its own (an image from before this). `whombat-hermes.nix` no longer
  gives the runner `WHOMBAT_HERMES_BIN` (only `WHOMBAT_HERMES_ROOT`, the person's home, which stays the host's).
  `whombat.hermes.package` is the factory runtime's Hermes: the agent's `agent-browser` and tests read it; the runner
  never runs it from there. The image still contains Hermes, as part of its factory runtime.
- **Runtime-only**: `release/build host-path` evaluates this commit's host with the old release's runtime, so a host
  that differs only by its runtime's Hermes compares equal (UP-X16). `dev/candidate` no longer forces a host release for
  `packages/hermes-whombat`; a reused host built from an appliance commit without `nix/packages/hermes/check.py` (from
  before this and NX-484) gets one host release instead, by itself.
- **The pin agreement** (keeps NX-433's own check that the flake input is the package's `pinnedRev`): the runtime's
  Hermes version and commit must be what its Whombat source pins (`packages/agent-runtime/src/hermes/pin.ts`), or
  `checks.runtime-pin`, `checks.hermes` and every release runtime (`checkedReleaseRuntime`) fail evaluation. So a new
  Hermes is always a new Whombat commit and a new runtime version: TUF refuses other bytes under a published version
  (NX-71). A change to how Hermes is built here alone (`nix/packages/hermes`, its uv2nix inputs, nixpkgs) makes other
  runtime bytes for the same Whombat commit: ship it with the next Whombat commit, as any change to the runtime's
  build.
- **First release with it**: a host release (the new host drops its own Hermes and gains NX-484's check), which
  `dev/candidate` chooses by itself; from then on a Hermes or plugin change is runtime-only.
- Checked: `.#whombat-runtime` (its runner wrapper names the bundle's Hermes, the server's doesn't), `checks.hermes`,
  `checks.runtime-pin` (and a Hermes version that disagrees with Whombat's pin fails it), `runtime-live-turn` (the
  runner's environment names the runtime's Hermes, the unit none).

## NX-484 A runtime activation is healthy only when its Hermes works (2026-10-28; Whombat HU-05; MG-13)

- **What is checked**: `bin/whombat-hermes-check` of the Hermes package (`nix/packages/hermes/check.py`), on Hermes's own
  interpreter, in a throwaway home: `hermes --version` is the package's release; Hermes's plugin discovery, with
  Whombat's plugins enabled as the runner's `config.yaml` enables them, loads the general plugin (`whombat`) without an
  error, and Hermes's provider registry returns the plugin's own DirectSDK providers (`claude-subscription-directsdk-
  experimental`, `whombat-claude-gateway`: the 2026-10-26 “Unknown provider” check, at run time); `hermes acp` answers
  `initialize` (its `agentInfo` names the release) and `session/new`, which starts Hermes's gateway on that home (its
  state database, its config, the plugins again). The gateway is ended with it (its own process group; whatever got
  away is reparented to the check as a subreaper and killed). Its config turns Hermes's own fetches off (NX-435) and a
  session without a prompt calls no model. 4.1 s and 431 MB at most on The Titan; 13 s in runtime-live-turn's VM.
- **No scripted turn**: a turn needs a model, and the appliance has none to call offline: the only scripted one is
  Whombat's scripted Hermes (a stand-in for Hermes itself), and the plugin's DirectSDK providers need the Claude Code
  the manager installs. A fake model endpoint and a provider of our own for it would be new pieces to keep in step with
  Hermes; `session/new` is as far as Hermes goes without one.
- **Where it runs**: the host's `whombat-hermes-check` unit runs the runtime profile's own copy
  (`/nix/var/nix/profiles/whombat-runtime/bin/whombat-hermes-check`, a link into that bundle's Hermes) at every start of
  `whombat-runtime.target` (`WantedBy`, `PartOf`: an activation, a rollback, a boot). Oneshot, `RemainAfterExit`;
  `DynamicUser`, private `/tmp`, `PrivateNetwork` (its gateway on its own loopback), nothing of the person's
  reachable; `whombat-tasks.slice`, `MemoryMax=1G`, 5 min at most. `DefaultDependencies=no`, so the target has no
  implicit `After=` on it: the helper's `systemctl restart whombat-runtime.target` (inside its 5-minute activation
  limit) doesn't wait for the check; the manager does.
- **What the manager does**: `whombat-hermes-check.service` is one of the manager's runtime units (`runtime.units`,
  with the server and the runner) wherever there is Hermes. A unit that isn't active fails local health, so a
  candidate whose Hermes fails the check never reaches the healthy streak and is rolled back after the verify window
  (10 min, MG-07) with “runtime units not active: whombat-hermes-check.service is failed”; the known-good release's
  check runs again with its own Hermes. At other times a failed check shows as an unhealthy runtime in status reports.
  A runtime without its own Hermes or check fails it too: this host names no Hermes (NX-483).
- **Also at build time**: the Hermes package's install check runs it, so every build of a new pin (the latest-tested
  job's, NX-485) runs it before anything ships.
- No Whombat change: the runner keeps its `--version` check (`checkHermes`) for its own heartbeat.
- Checked: `checks.hermes` (the unit, its user, network and dependencies; the DEV and PROD images' `manager.json` name it,
  the stand-in image's doesn't), the Hermes package's install check, `runtime-live-turn` (the unit passed at boot as
  its own user, the manager's configuration names it, no gateway left, nothing written to the person's home).

## NX-485 The latest-tested Hermes job (2026-10-28; Whombat HU-03, HU-06; amends NX-433)

*Superseded in part by Whombat one-repo.md OR-66 (2026-11-21): the pins are in one repository and move in one commit,
pushed once; `--appliance-ref` and the `half` marker are gone, and the job runs from `~/Services/whombat-jobs`, a
clone of Whombat.*

*Amended by NX-490 (2026-11-02): its test is the install check, the pin agreement and the live turn; it runs once a
day. A new version is reviewed by an agent first (NX-492).*

`release-tools/hermes/latest-tested` (implementation `harness/src/dev/hermes-latest.ts`, runbook
`docs/runbooks/hermes-latest-tested.md`), modelled on the Claude Code job (`release-tools/clients/latest-tested`):
- **Detect**: GitHub's releases of `NousResearch/hermes-agent`: published, not a pre-release, a `vX.Y.Z` tag (never a
  `+canary` one, nor its older calendar tags `v2026.9.24`, which would sort above every SemVer release); the newest
  against the pin on both `origin/main`s (Whombat's `pin.ts`, this repository's `nix/packages/hermes`). Nothing newer,
  or both there already: done. A version with a failed marker is skipped until `--retry-failed`.
- **Move the pin** in scratch worktrees of both `origin/main`s (NX-433's steps 1–3): Whombat's `pin.ts` (version, tag,
  commit); here the `hermes` input, the three uv2nix inputs at the revisions that release's own `flake.lock` names, and
  `version`/`pinnedRev`, then `nix flake update` of those four. One commit in each.
- **Test**: in Whombat `pnpm hermes:test --hermes pin` (the plugin's tests on that release, Whombat HN-10) and
  agent-runtime's tests; here, against that Whombat commit (`--override-input whombat`, the pnpm store hash taken for
  the test when Whombat's lockfile moved since this repository's pin), `.#whombat-hermes` (its install check with
  NX-484's), `checks.hermes` (with the pin agreement, NX-483) and `runtime-live-turn`, its driver run inside
  `agent-resource run` (QEMU in that task's cgroup, its disks in the task's workspace). A failure of any of them: a
  failed marker for that version (`markers/hermes-<version>.failed`, no retry loop), nothing committed, nothing shipped,
  and the log says which step and why. A failure before the tests (GitHub, a fetch) leaves no marker: the next run tries
  again.
- **Pin on both mains**: the two tested commits, Whombat first, pushed fast-forward only (`<commit>:refs/heads/main`,
  never forced) while `dev/candidate`'s lock is held, so no candidate is made between them. A main that moved during the
  test takes the pin commit (cherry-picked) only when nothing the test covered changed there (Whombat's
  `packages/hermes-whombat` and `packages/agent-runtime/src/hermes`; here `nix/packages/hermes`, `nix/modules/hermes.nix`
  and `runtime-live-turn`); otherwise nothing is pushed and the next run tests again. A push that stops between the two
  leaves a `half` marker, and the next run tests and pushes what is missing. Checkouts on a clean `main` are
  fast-forwarded.
- **Ship to DEV**: `dev/candidate --what "hermes agent <version>" --why "Hermes Agent <version> came out and passed
  Whombat's tests."` (HU-06: the box's “Updated to …” names it), a runtime-only release (NX-483). Its failure leaves the
  pins on main and a `candidate-failed` marker; it isn't retried by the job. Never production: that stays `release/ship`
  (Whombat HE-10, HU-01).
- **Where it runs**: The Titan, as the client job: a `systemd --user` timer (`dev/instance/whombat-hermes-latest-tested.
  {service,timer}`, every 6 h at :47 plus up to 20 min, half an hour after the client job) from the dev stack's checkout
  `~/Services/whombat-appliance-dev`, its state in `~/.local/state/whombat-hermes`, two runs never at once
  (`job.lock`). Installing the units is the operator's step, as for the client job. Whombat's CI job
  `whombat-runtime-hermes-latest` (the plugin's tests on Hermes's latest, daily, report only) stays.
- `--dry-run` tests and commits nothing; `--appliance-ref <rev>` (dry runs only) tests against another appliance commit
  than `origin/main` (a change to the job or its tests); `--version x.y.z` tests that release, the pinned one included
  (a rehearsal: nothing to pin or ship); `--no-candidate` pins without shipping.

## NX-486 runtime-live-turn runs again, its turn through Hermes (2026-10-28; amends NX-437; for NX-485)

The latest-tested Hermes job runs `runtime-live-turn`, which hadn't built since the runtime's pnpm store held only its
own packages and the web app's: its world (`vm-tests/common/live-turn.nix`) installed the whole workspace offline and
failed on the mobile app's (`expo-build-properties`). Now:
- the world installs the runtime's own workspaces (`pnpmWorkspaces` of the runtime), all its server code needs;
- the runner's sandbox line is today's (`sandbox · bubblewrap …`);
- the machine runs the commands' network daemon (`whombat.agent.enable`, NX-456): every turn's pod binds its proxy
  socket, and without it the pod never started (`Can't find source path …/agent-net/proxy.sock`);
- the turn runs on Hermes (Whombat HE-01), which drives Claude Code as its model client (Claude DirectSDK): the fake
  Claude Code (`vm-tests/common/live-turn/fake-claude.js`) answers with the native stream Hermes reads (the text, the
  assistant message, `message_stop`, one `result`), as Whombat's own stand-in does
  (`packages/hermes-whombat/tests/native_directsdk.py`); its text is still what it saw of its sandbox;
- the turn's sign-in is checked by the runner's `sign-in claude · subscription`: the requester's planted sign-in is
  moved to the one person's place (Whombat OP-17), so the runner no longer names a credential owner.
- the CLI's pod holds Hermes, its gateway and their helpers too (11 processes here, the CLI's pid in the hundreds):
  the check is a fresh procfs with the pod's processes only, not “a handful”; and the guarded agents' empty `gh` home is
  gone with them (one person), so nothing checks it.

## NX-487 The box's own networks before the tailnet's routes (2026-10-30; Whombat tailnet-reach.md TN-02; for MG-140)

Tailscale on Linux keeps the routes it accepts in table 52 and asks it before the main table (rule 5270). John's tailnet
has a subnet router advertising his home LAN (BlackBox, `10.100.0.0/23`, the network Home is on): with routes accepted,
Home would send its LAN traffic, and its answers to the LAN's devices (the direct port, the phone's direct route), into
the tailnet. So the image asks the main table first, without its default routes: `ip rule 5200 lookup main
suppress_prefixlength 0`, IPv4 and IPv6 (`whombat-own-networks-first.service`, tailscale.nix, before tailscaled and
`network.target`). A route of a network the box is on (its LAN, the agents' bridges and containers) wins; everything else
goes on to Tailscale's rules (its own traffic, marked, to the main table; then table 52) and to the default route.
- networkd leaves routing rules it didn't make (`ManageForeignRoutingPolicyRules=false`): by default it removes them when
  it starts again, this one and Tailscale's own.
- A LAN that itself uses CGNAT addresses (100.64.0.0/10) wins over tailnet devices in that range: accepted, the local
  network first.
- Tried on Home before it was built (2026-10-30, rule and `--accept-routes` by hand, then taken back): with BlackBox's
  route in table 52, `10.100.0.1` and the LAN's devices stayed on the cable, `10.2.2.0/24` went to the tailnet, and The
  Titan reached the direct port on the LAN (200 in 3 ms).
- In the image before accepting routes (MG-140) is: a rollback from the release that accepts them lands on one that has
  the rule, since tailscaled keeps the preference on /persist.
- Checked by `checks.tailscale-direct`: the rule for both families, a table-52 route for the test LAN on a stand-in link
  leaves the LAN on eth1 and the direct port answering, another network goes to the stand-in, and networkd starting
  again keeps the rules.

## NX-488 Whombat's own names by the local network's resolvers (2026-10-30; Whombat tailnet-reach.md TN-03)

A tailnet that overrides local DNS (John's: NextDNS for every device) gets every lookup of the box through Tailscale
(`~.` on `tailscale0`). That is the tailnet owner's choice and stays (the tailnet's names, its split DNS and its filter
work as on their other devices), but the services the box lives by mustn't depend on it: if the tailnet's resolver fails,
the box must still reach control, the relay and its updates, so it can be reached, fixed and updated.
- The cable's and Wi-Fi's networks (network.nix, wifi.nix) carry the routing-only domains `~` + `whombat.network.ownDomains`
  (default `whombat.com`): resolved asks the longest matching routing domain, so those names go to the local network's
  resolvers (and the backup ones of the DNS fallback, dns.nix) while `~.` takes the rest. `DNSDefaultRoute=true`, since a link with
  only routing domains would otherwise stop answering other names.
- The DNS fallback (dns.nix) adds its backup resolvers only to links without scoped DNS; the own domains don't scope a
  link (`WHOMBAT_OWN_DNS_DOMAINS`, dnsfallback `Append`), any other domain still does.
- A network candidate of the update helper (a static address) has its own file without them: it keeps the earlier
  behaviour.

## NX-489 No temporary IPv6 addresses (2026-11-01; with MG-141)

Home was unreachable for 18 minutes on 2026-11-01 (19:09–19:27 UTC) while the box itself ran fine. NixOS turns on
temporary (privacy) IPv6 addresses by default (`use_tempaddr=2`) and outgoing connections prefer them; on the kernel Home runs a
temporary address is deleted two days after it was made (`temp_valid_lft` 172800). Home had run two days without a
reboot (runtime-only releases don't restart the box), so the address it got at boot was deleted at 19:08:53. The
manager's one HTTP/2 connection to control had been opened from it at boot and kept busy since; from then on every
request went into that dead connection until Linux gave up retransmitting (`tcp_retries2=15`, about 16 minutes;
“read tcp [2a02:…:a869:2cd4:91cd:c939]:34042->[2a06:98c1:3120::]:443: connection timed out”). Without control the box
got no relay tickets: phones signed in but the box never joined their sessions (relay close 4504), and remote help
couldn't connect. Tailscale's own control connection died the same way.
- No temporary addresses (network.nix): `systemd.network.config.networkConfig.IPv6PrivacyExtensions = false`, because
  NixOS writes `IPv6PrivacyExtensions=true` into networkd.conf (`mkOptionDefault`) and networkd sets every link from it
  that its own unit doesn't (the box's units don't); and `networking.tempAddresses = "disabled"` for the kernel's default.
  The first release had only the second, and Home still made temporary addresses. The box uses its stable address (the
  SLAAC one it already has) for everything; nothing it uses expires while the router keeps announcing the prefix. A
  server gains nothing from privacy addresses.
- The manager detects a dead connection to control itself (MG-141), whatever kills it: a router restart, a link that
  changes, an address that goes.

## NX-490 The Hermes job tests simply, once a day (2026-11-02; Whombat HU-07; amends NX-485)

John, 2026-11-02: “For dev I want to update Hermes agent daily … It should be tested before applying … a test that
simply installs the latest version of Hermes Agents and do some basic checks to see if it still behaves as expected.
Keep it simple, because we do not expect it to break.” Hermes 0.22.6 had just been held back by the plugin's own tests:
Hermes moved two built-in skills to its optional ones and listed a one-skill category without its heading, and the tests
named those skills. Nothing a person would notice.
- **The test is install and use**: `.#whombat-hermes` (the build and its install check, which is the activation's
  check: its version, Whombat's plugin and providers, ACP `initialize` and `session/new`), `checks.hermes` (the pin
  agreement) and `runtime-live-turn` (the runtime on a box, one turn through Hermes). No `pnpm install`, no
  `pnpm hermes:test`, no agent-runtime tests in the job: they follow Hermes's internals and run in Whombat's CI on
  Hermes's newest release (report only); a failure there is fixed there and holds no update back.
- **Once a day**: the timer runs at 04:47 (plus up to 20 minutes, a missed run at the next boot), so a tested Hermes is
  on DEV, and on Home, the morning after its release. Home's activation check and the manager's automatic go-back stay the
  safety net on the box.

## NX-491 agent-browser is Whombat's pin; Hermes 0.22.6 (2026-11-02; Whombat HE-S300; amends NX-438)

Hermes 0.22.6 removed its built-in `browser_*` tools and agent-browser (`pm/lock.json` has none), so the latest-tested
job stopped at `.#whombat-hermes` (“attribute 'agent-browser' missing”). Its only browser, `browser_exec`, runs
model-written Python in Hermes's own process, beside the sign-ins; Whombat keeps the browser as tools of its plugin that
drive agent-browser on the runner's relay and never runs `browser_exec` (Whombat HE-S300).
- **The pin moves to Whombat**: `nix/packages/hermes` takes agent-browser's version and npm tarball sha256 from
  `agent-browser.json` beside Whombat's plugin (the source it already builds the plugin from; 0.26.0, the version
  Hermes 0.22.5 pinned), else, for a Whombat from before it, from Hermes's lock as before. The binary, its place beside
  `hermes` (`bin/agent-browser`, on Hermes's PATH in the pod), the agent's tools and the install check are unchanged.
  A new Hermes pin no longer moves agent-browser; a new agent-browser is a Whombat change.
- **Hermes 0.22.6** is pinned the job's way: `flake.nix`'s `hermes` input and the three uv2nix inputs at its
  `flake.lock`'s revisions, `version` and `pinnedRev`.

## NX-492 A new Hermes is reviewed by an agent before the job tests it (2026-11-02; Whombat HU-09; amends NX-485, NX-490)

*Superseded in part by Whombat one-repo.md OR-66 (2026-11-21): the pins are in one repository and move in one commit,
pushed once; `--appliance-ref` and the `half` marker are gone, and the job runs from `~/Services/whombat-jobs`, a
clone of Whombat.*

John, 2026-11-02, after Hermes 0.22.6 replaced its browser tools: “we should involve Opus 5.5 with high effort to take a
look at it and see if it needs to adjust something like in this example before deployment … Perhaps it should be a T3
Code automation instead?” Then: “Yes build it.”
- **The job finds, the agent looks, the job gates.** With `WB_HERMES_REVIEW=1` (`~/.config/whombat/
  hermes-latest-tested.env`), the daily run that finds a new version leaves it for review
  (`markers/hermes-<version>.review`: version, tag, pinned, release, when) and ends. The T3 Code task “Hermes Agent
  release review” runs at 05:20 every day (after the job's 04:47 plus up to 20 minutes), one new thread per run, and its
  agent follows `docs/runbooks/hermes-review.md`: it finds the version waiting, reads the release against the parts of
  Hermes Whombat uses, makes what must change on branches in both repositories, and runs the job with `--version` and
  `--whombat-ref`/`--appliance-ref`. The job stays the only way a Hermes reaches `main` and DEV: same test (NX-490), same
  pushes, same `dev/candidate`.
- **A daily task, not a webhook**: T3 Code's webhook trigger was tried first (a run only when there is a release), but
  its relay accepted the requests and never delivered them to The Titan; a fixed-time task runs there reliably. A morning
  with nothing waiting costs one short reply.
- **It stops and asks** when the change touches where code runs or what it can reach, takes something away, needs a
  contract release or a migration, has failing tests it can't explain, or would reopen a decision. The version waits.
- **Fallback**: not reviewed within two days (T3 Code not running): the daily run tests the version as it is, as
  before. A version that failed its test stays held back either way.
- **Branches in the job** (all modes now, with `--version`): it tests the pin on top of the branches and pushes both onto
  `main` fast-forward only while `main` is still in the branch; a `main` that moved past it is refused (the agent
  rebases and tests again). A version that failed before is tested again with branches without `--retry-failed`.

## NX-493 Each address answers on its own link: loose reverse-path filtering (2026-11-03; Whombat NM-04; with NX-482)

- **Why**: Home (the Z13) has its USB cable `10.100.1.81` and Wi-Fi `10.100.1.97` in one `/23`. With the cable up, IPv4 to
  the Wi-Fi address timed out: `base.nix` set `net.ipv4.conf.all.rp_filter = 1` (strict), and a packet that came in on
  `wlan0` whose route back is the cable (metric 100 beats Wi-Fi's 600, NX-241) was dropped. NixOS's firewall has the
  same strict check of its own (`checkReversePath`, default on), which also covers IPv6. Servers can only move to the
  Wi-Fi address before the cable goes (Whombat NM-05) when both addresses answer.
- **How**: `rp_filter = 2` for `all` and `default` (RFC 3704 loose mode: the sender must be reachable at all, over any
  link; the kernel takes the larger of `all` and the link's own value) and `networking.firewall.checkReversePath =
  "loose"` in `network.nix`. Spoofed sources from nowhere routable are still dropped; the box routes nothing for others
  (no forwarding), so strict mode bought nothing a server needs. Replies still leave by the routing table (the cable),
  which the router accepts: the box's addresses are on the same network.
- **Checked**: `checks.wifi` (`vm-tests/wifi.nix`) puts a cable on the Wi-Fi's own network: with the cable's default
  route at metric 100, a TCP connection from the network to the Wi-Fi address is answered.

## NX-494 Wi-Fi only switches the cable off, not out (2026-11-03; Whombat NM-01)

- **What**: while the box uses Wi-Fi only, the update helper's `/run/systemd/network/05-whombat-cable-off.network`
  (`whombat.network.cableOffFile`) matches the wired interfaces (`defaultInterfaceMatch`, `en* eth*`, and a committed
  wired candidate's interface) and sorts before every other wired file (`10-whombat`, NixOS's `40-*`,
  `90-whombat-default`). It gives them no DHCP, no router advertisements and no link-local address
  (`LinkLocalAddressing=no`), and `RequiredForOnline=no`. networkd still brings each link up (`ActivationPolicy`'s
  default), so the carrier stays visible: the box still knows whether a cable is plugged in (the manager's `plugged`,
  and the cable as the backup, MG-145). Removing the file and `networkctl reload` + `reconfigure` of the wired
  interfaces gives them their usual configuration back at once.
- **Kept across restarts and host updates** the way committed wired candidates are: the helper keeps a copy in its
  network state (`/var/lib/whombat-update-helper/network/cable-off.network`, written only when the change is kept), and
  `whombat-cable-restore` installs it into `/run/systemd/network` before networkd starts. The host generation doesn't
  carry the setting, so an update or a rollback doesn't change it.
- **Why not unplug or `ip link set down`**: a link that is down has no carrier to read, and a down link set by hand
  doesn't survive a restart. A cable left in must not take over again by itself after a restart (NM-01).

## NX-495 The cable's guarded change in the helper (2026-11-03; Whombat NM-02; the Wi-Fi dead-man's pattern, NX-245)

- **Operations** (protocol 1, new ops): `cable-set {changeId, use: wifi|cable, deadlineSec 0…3600}`,
  `cable-confirm {changeId}`, `cable-revert {changeId}`, and read-only `cable-status` (no lock, beside other operations,
  like `wifi-status`). Each answers `cable {off, committedOff, pending}`.
- **Guarded** (`deadlineSec > 0`): the helper arms `systemd-run --unit=whombat-cable-revert --on-active=deadline+60
  whombat-update-helper cable-revert-deadman` and records the change (its id, `use`, and whether the cable was off
  before) in its state before anything changes; the live file changes; the kept copy doesn't until `cable-confirm`.
  `cable-revert` and the dead-man put the live file back as it was and disarm. Unguarded (`deadlineSec` 0): the live
  file and the kept copy change at once.
- **A restart while a change waits** loses the live change (the kept setting comes back at the start) and the timer:
  `cable-confirm` then finds the cable not as the change left it and keeps nothing (`cable_not_applied`), so a change
  never becomes the kept setting without having been tried and confirmed. A confirm repeated after a kept change answers
  `alreadyDone`; after one that was undone, `cable_not_applied`. Another change pending: `cable_pending`.
- **Checked**: `helper/internal/ops/cable_test.go` (the request shapes, guarded confirmed both ways, reverted, the
  dead-man, a restart mid-change, unguarded kept at once, a failed switch undone, a candidate's interface, odd
  patterns refused) and `activator` `TestNixCable` (the file, the exact commands).

## NX-496 `checks.wifi` puts a cable on the Wi-Fi's own network (2026-11-03; with NX-493…NX-495, MG-142…MG-145)

- **Topology**: a second card on the test VLAN (`52:54:00:77:00:02`) goes into the access points' namespace as `lan0`,
  in the bridge `br-home` with Home's access point (hostapd `bridge=`), which holds `10.78.0.1` and Home's DHCP. The
  box's own VLAN card is its cable, configured by the appliance's DHCP network (the test framework's addresses are
  dropped: `networking.interfaces = mkForce { }`). `lan0` stays down until the cable part, so the Wi-Fi part runs as
  before. The cable is found by its address: with two cards on the VLAN, the framework's rename to `eth1` can lose and
  it stays `eth0`.
- **Proven**: with the cable's default route at metric 100, a TCP connection from Home's network to the Wi-Fi address
  (and to the cable's) on the direct port is answered (NX-493); Use Wi-Fi only with Wi-Fi blocked from control (an
  nftables rule in `ap` on the Wi-Fi address) is confirming with the cable switched off and the helper's dead-man
  armed, then `reverted`/`no_internet`, and the cable gets its address back; Use Wi-Fi only kept: no address at all on
  the cable (not even link-local), `LOWER_UP`, the default route is Wi-Fi's, `wifiOnly`, `plugged`, the kept copy in
  the helper's state, `unchanged` and `busy` refusals; after a restart (`whombat-cable-restore` active) the cable stays
  switched off with its network's side up; Use the cable again gives it its address and the metric-100 default route
  back. Also the state's `mac` and `prefixLength`.

## NX-497 A factory reset forgets Wi-Fi only (2026-11-04; Whombat NM-01; with NX-25, NX-494)

`whombat-factory-reset` also removes the helper's kept `network/cable-off.network` beside `committed.network` and
`previous.network`. *Why:* the reset already forgets the saved Wi-Fi networks, and `whombat-cable-restore` put the
switched-off cable back at the next start, so a box reset while on Wi-Fi only came up with neither its cable nor a
Wi-Fi network: no way to provision itself.

## NX-498 A revert that fails stays pending (2026-11-04; with NX-495)

`cable-revert` and the dead-man end a pending change only once the cable is back as it was; when networkd doesn't take
it (`networkctl` fails), the change stays pending with its dead-man armed and `cable-revert` answers
`activation_failed`, so the manager (which retries a failed revert every 5 s) asks again. A switch that failed while
starting is still undone best effort and dropped. *Why:* the change used to end `reverted` while networkd kept the
switched-off cable, the state said `wifiOnly: false`, and the backup never ran: the box stayed offline until a restart.
Checked: `helper/internal/ops` `TestCableRevertThatFailsIsTriedAgain`.

## NX-499 The app's restore unit checks first and undoes what the schema step refuses (2026-11-04; backup BK-41, BK-42)

`whombat-backup-restore@<checkpoint>` holds `/persist/.whombat-restore.lock` (`flock` on fd 9) across its steps and
passes `-lock-held` to its commands. Before anything moves it reads this release's schema version from the fresh
install's `schema-check --json` (`.binary.version`, jq) and gives it to `whombat-backup restore -release-schema`. After
the restore: `schema-check` 0 starts the runtime; 10 or 13 migrate with the checkpoint, and a migrate that fails is
undone; 11 and 12 (a newer schema) and anything else are undone (`restore-end -failed newer|migration|check`), then
the runtime starts on the box as it was. A restore that is refused or fails starts the runtime itself.

## NX-500 Restores are recovered before the runtime starts (2026-11-04; backup BK-43, BK-44)

`whombat-backup-restore-recover.service` (root oneshot, `restore-recover`) is wanted by `whombat-runtime.target` and
ordered after PostgreSQL and before `whombat-runtime-schema-init` (which would create a schema in a database a restore
emptied), the server, the runner and the hosts service: a restore a crash or a power cut stopped is undone there, and
what a released restore set aside is removed. `whombat-backup-restore-cleanup.path` starts it when a release writes
`/persist/backup/restore-cleanup.json`. A running restore holds the restore lock, and the unit leaves it alone.

- Checked: `vm-tests/backup-app-restore.nix` (btrfs subvolumes): a restore that fails after prepare (a damaged pack) is
  undone (files, master key, database, subvolumes, nothing set aside, the runtime up, `failed`); the same restore
  intact, then released, leaves no set-aside folder or database; a power cut after prepare is put back at the next
  boot before the runtime starts.

## NX-503 The weekly check asks hourly; a busy one isn't a failure (2026-11-04; backup BK-60, BK-66)

- **What**: `whombat-backup-drill.timer` runs `drill -if-due` every hour (`*-*-* *:20:00`, 10 minutes' random delay)
  instead of daily at 04:00: the policy says when, in the person's time zone (04:00–07:00 their time). The drill unit
  counts exit 3 (a backup was running; the next hour tries again) as success. A check the person asked for waits for
  the running backup inside the unit instead (the request is taken only with the run lock held).
- **Why**: the box's clock is UTC; a daily timer can't follow a policy's zone, and a busy check is no fault.

## NX-504 The backup reads four files at once (2026-11-04; backup BK-69)

- **What**: the backup's configuration sets `readConcurrency = 4` (restic `--read-concurrency`).
- **Why**: `/persist` is solid state, where more parallel reads of many small files (attachments, repositories) finish
  sooner; restic's default of 2 suits spinning disks.

## NX-505 A backup opened for reading (2026-11-04; backup BK-72…BK-74, Whombat restore-one)

- **What**:
  - Group `whombat-peek` (gid 973, `ids.whombat-peek`): the backup user and the runtime server (`whombat`) are members.
    `<persist>/backup/peek` is `2750 whombat-backup:whombat-peek` (tmpfiles), so what a peek restores is the group's
    from the start; the backup service makes it 0750/0640 and never group-writable.
  - The backup's configuration gets `peek = { runtimeRole = "whombat"; gid = <whombat-peek>; }`.
  - `whombat-backup-pgrole` also runs `ALTER ROLE whombat_backup CREATEDB`: the backup role makes and drops the peek's
    database (`whombat_peek_<12 hex>`), which it owns.
  - `postgres.nix`'s `pg_hba` admits `/^whombat_peek_[0-9a-f]{12}$` for `whombat_backup` (peer, its map) and `whombat`
    (peer): the backup role loads the peek, the runtime reads it. No other database is added for either.
  - `whombat-backup-peek-sweep.service` (oneshot, the backup user, no network, after PostgreSQL) runs
    `whombat-backup peek-sweep` at boot: a peek of an earlier boot is closed, its database dropped and its files
    removed, even when nobody asks the API anything.
- **Why**: the runtime gets back one thing from a backup by reading it; the box restores it where only the runtime can
  read it, and nothing of a peek outlives a reboot.
- **Checked**: `nix eval` of `appliance-x86_64` (the `pg_hba` text, the group, the units, the timer); the regex lines
  on a throwaway PostgreSQL 17 cluster (parsed without error; `whombat` reaches `whombat_peek_0123456789ab`, not
  `whombat_peek_x`).

## NX-509 The installer ISOs evaluate, and CI evaluates every one (2026-11-04; backup and restore v2 rehearsal)

- **What**:
  - `whombat.network.ownDomains` (NX-488) and the DNS fallback's `WHOMBAT_OWN_DNS_DOMAINS` are declared in `dns.nix`,
    which `network.nix` and `wifi.nix` import: the installer imports `wifi.nix` and `dns.nix` without `network.nix`, so
    its Wi-Fi network asks the local network for Whombat's names like the appliance's, and its fallback keeps the
    backup resolvers on that link.
  - `checks.eval-installers` writes the derivation of every `installer-iso-*` package (factory, dev, prod, community);
    `scripts/ci/nix-checks.sh` builds it in CI. `checks.self-installed-config` also asserts the Wi-Fi network's domains
    and the fallback's environment on the installed system and the DEV installer.
  - `packages.default` is `installer-iso-factory` (the `installer-iso` it named went with PI-22).
- **Why**: since NX-488 (dcf2e93a, 2026-10-30) `wifi.nix` read an option only `network.nix` declared, and no installer
  ISO evaluated, DEV or PROD (`release/ship iso` and `promote-prod` build one for every host release). The checks read
  parts of the installer's configuration only, so nothing noticed. A release built from before this commit keeps its
  broken source: `release/build iso` builds from the release's own revision, so the next host release is the first
  with an ISO again.
- **Checked**: `nix eval` of the four `installer-iso-*` derivations; the DEV installer of the release function at this
  commit (`applianceRelease { env = "dev"; releaseId = "whombat-dev-20261104.4"; }`, as `release/build iso` does) built
  (`whombat-installer-dev.iso`, 3.8 GB), its installed system the release's toplevel.

## NX-510 The hosts service starts once the box is provisioned (2026-11-04; backup BK-77)

- **What**: provisioning (self-registration, the factory medium and re-registration) starts `whombat-hosts.service`
  with `whombat-manager.service` and `whombat-runtime.target` when the hosts service is on (`startProvisioned`).
  `checks.self-installed-config` asserts it on the DEV image and that the factory image, without the hosts service,
  starts the two as before.
- **Why**: `whombat-hosts` waits for `identity/device.json` at boot and is kept out of the runtime target (the box is
  healthy whatever its servers do), so on a freshly installed box it stayed skipped until the first restart: servers
  couldn't be added, the server logged that the hosts service had no token, and every backup left the servers out.

## NX-511 The community install test reads the installer's summary (2026-11-04)

- **What**: `vm-tests/community-install/install.sh` waits on the checks screen for the summary the installer shows once
  the checks are done (“All good.”, which tesseract may read as “Allgood.”, or “Read the warnings, then continue.”),
  then presses Enter (Continue has the focus then); and waits for a claim screen that doesn't also say “Whombat is
  installed”. `wait_text` takes a regex the screen must not show.
- **Why**: tesseract doesn't read the focused, light-on-dark “Continue” of the DEV ISO, so the step waited 180 s and
  failed; “Check again” is shown while the checks still run. The installed screen says “…a code to claim your Whombat”,
  so the claim step read the installed screen and found no letters.
- **Checked**: the expressions against the OCR text of the rehearsal's three installs (DEV ISO, 2026-11-04).

## NX-512 The agent's Chromium may use memory protection keys (2026-11-13; Whombat HE-42, OP-S113)

- **What**: the runner's unit allows `@pkey` (`pkey_alloc`, `pkey_free`, `pkey_mprotect`) beside `@system-service`,
  `@mount` and `sethostname` (`whombat.sandbox.runnerServiceOverrides`). `ptrace` (`@debug`) stays outside the list.
  `vm-tests/runtime-real.nix` checks the unit's list (the three in, `ptrace` out), runs `pkey_alloc` and `ptrace`
  under the runner's own filter on a transient unit as its user (the first answers, the second is killed), starts the
  agent's tools' Chromium under it with the relay's flags until it answers DevTools' `/json/version`, and finds no
  seccomp kill of `chromium` in the kernel log. It is in the nightly VM list; the agent's tools are already built for
  the image. (`--dump-dom` hangs in such a bare unit, and a transient unit on NixOS has no `PATH` or `HOME`: the probe
  sets both.)
- **Checked on Home** (`whombat-dev-20261113.4`): the runner's list has the three; the same probe under it, as
  `whombat-runner`, got `DevTools listening` and Chrome 153's `/json/version` and `/json/list`; no seccomp kill of
  Chromium since the update's boot.
- **Why**: Hermes's browser never started on Home (`wb-h7mq-2xvd-4410`, the Z13; every session since at least
  2026-11-06): every `browser_*` call ended in agent-browser's “All CDP discovery methods failed for 127.0.0.1:47105”.
  The relay on 47105 answered, but the Chromium it starts in the commands' wrapper inherits the runner's syscall
  filter, and on a CPU with memory protection keys (the Z13's `pku`) Chromium 153 calls `pkey_alloc` at start: the
  kernel killed it with SIGSYS (`audit: type=1326 … comm="chromium" … syscall=330`), so the relay answered with its
  503 text or timed out. Its crash handler was killed on `ptrace` (101) too; Chromium runs without it, so `ptrace`
  stays denied. A key guards only the calling process's own memory, so the group adds no reach outside the process.

## NX-513 The agent's Chromium may ask which of its pages are in memory (2026-11-13; Whombat OP-S113; amends NX-512)

- **What**: the runner's unit allows `mincore` beside `@system-service`, `@mount`, `@pkey` and `sethostname`.
  `vm-tests/runtime-real.nix` checks it is in the unit's list and that it answers under the runner's own filter.
- **Why**: on Home, from 15:41 CET (2026-11-13), the kernel killed the agent's Chromium processes with SIGSYS for
  `mincore` (`audit: type=1326 … comm="chromium"` / `comm="MemoryInfra"` … `syscall=27`), 38 times by evening:
  Chromium's memory accounting asks it, after a heavy page such as an order form's submission or a loop of frames. A tab
  whose renderer was killed never answered again (agent-browser: “CDP command timed out: Page.enable”); when the
  processes that start renderers were killed the browser opened no tab at all, and the relay kept handing that
  browser out until the pod stopped. NX-512's check started a browser but never got it to account for its memory, so
  it missed this. `mincore` reports which of the calling process's own pages are resident: nothing outside the process.
  The runner's watchdog (Whombat) now also closes a tab that stops answering and restarts a browser that can't serve
  pages, whatever the cause.

## NX-514 The recovery menu turns “Ask before updating” off (2026-11-16; MG-160, Whombat ask-before-updating.md)

- **What**: recovery menu choice 7, “Turn "Ask before updating" off (when the apps can't install an update that
  waits)”. It asks for the disk recovery key, or on a box without one the typed word `UPDATES` (NX-91); opens and
  mounts the data volume read-write; runs `whombat-manager ask-off --journal /persist/manager/journal` (the manager's
  package is in the menu's inputs); and logs `ask before updating turned off` (or `… failed`) to the kernel log. Status,
  Restart and Power off move to 8, 9 and 10, and the header says “actions 1-7” and “except 8-10”.
  `vm-tests/install-vm.nix` restarts with 9.
- **Why**: with the switch on, a release that breaks the apps would leave its own fix waiting for a yes nobody can
  give. The box has no console login (MA-21a), so its recovery menu is the owner's only way in at the box itself.

## NX-515 The hosts package carries the Macs' agents and Whombat Helper (2026-11-17; Whombat macos-servers.md MAC-01, MAC-07)

- **What**: `.#whombat-hosts-agents` builds `whombat-agent-{linux,darwin}-{amd64,arm64}` (cgo-free; Go signs the macOS
  builds ad hoc itself) and checks each file's machine (ELF e_machine for Linux, the Mach-O magic and CPU type for
  macOS). The hub's `agent/` folder gets all four, and, when the pinned whombat-hosts has them,
  `whombat-helper-macos.zip` and `.json` from its `macos/helper/dist/`, copied only when the zip's sha256 is the one the
  json names. Whombat Helper's zip sits beside the agents in `.#whombat-hosts-agents` and is signed in the same manifest
  (entry `whombat-helper-macos.zip`: `os` `darwin`, `arch` `universal`, its own `version`), so a Mac's agent takes it as
  an update only from the agent-update key. `manifest-check` accepts `whombat-agent-<linux|darwin>-<arch>` names and the
  helper's, checks each entry's `os` (`darwin` for a Mac's agent and the helper, absent or `linux` for a Linux agent)
  and that only the helper's entry has a `version`; whombat-ops `sign-agents` signs every agent and the helper the
  package built.
- **Why**: a Mac becomes a server through the same agent and the same signed self-update as Linux servers. Whombat
  Helper is a Swift app that only a Mac can build and Apple must notarize, so whombat-hosts commits it signed and the
  box only copies it.

## NX-516 The DEV image switches the own address on (2026-11-18; MG-161, Whombat own-address.md)

- **What**: `nix/profiles/dev-instance.nix` sets `WHOMBAT_OWN_ADDRESS=on` on `whombat-manager` and
  `whombat-manager-recovery`, so a box on dev.whombat.com registers `<label>.dev.whombat.app` and orders its certificate
  from Let's Encrypt production. `self-installed-config` reads both back and checks that the prod image has neither.
- **Why**: the manager turns the own address on by itself only for env `dev` and `prod` (MG-161), but the DEV image is
  env `local` (its control runs `CONTROL_ENV=local`), so Home stayed off after the release that brought it. Making the
  manager treat `local` as on would also switch it on for the harness's and the tests' `local` boxes, which must never
  order real certificates; the image that is really used on DEV is the one place that knows.

## NX-520 Every environment in the image; the box file picks one (2026-11-18; Whombat LNK-01, LNK-01a, LNK-50)

- **What**: `whombat.environments.<name>` (environment.nix) carries each environment's control, app and embed origins,
  relay, own-address zone, device env, support CA, clients and licence keys and its own runtime variables;
  `nix/profiles/environments.nix` defines `prod` and `dev` for the images built for Whombat's services (prod-instance and
  dev-instance import it). The image writes `/etc/whombat/environments.json` and each environment's documents under
  `/etc/whombat/environments/<name>/`. A root-owned `/persist/whombat/environment.json` (`{v: 1, env}`) picks one; absent,
  `whombat.defaultEnvironment` (prod; the DEV image dev). `whombat-environment.service` (root, oneshot, before the
  manager, the runtime, the support service and provisioning) resolves it into `/run/whombat/environment/`; one that
  doesn't resolve leaves a marker and the manager runs without Link. The runtime takes `runtime.env` last
  (`EnvironmentFile`), the support service its CA from there, self-provisioning the device env.
  `whombat.environmentBridge = "dev"` (the DEV image) writes the box file once, `--if-absent`: the bridge release.
- **Guards**: `whombat.link.possible` (an environment with a control; without environments, the edition as before)
  replaces the edition in the guards of remote help, the hosted app's URL and the Feedback drop; the licence key set is no
  longer required anywhere (LNK-04); Tailscale's own-login-server rule is on every box with Tailscale (LNK-12);
  self-provisioning always makes the identity on the box (LNK-01). Production never pins the DEV support CA (RH-05).
- **DEV-only options, and what became of them**: control, app, embed and relay origins → the `dev` environment (still set
  in dev-instance.nix too, for an older known-good manager and a box whose file didn't resolve); the support CA → the
  environment; WHOMBAT_MERGE_RERUN → the environment's runtime variables (and still in dev-instance.nix, which a flake
  check reads); `WHOMBAT_OWN_ADDRESS=on` → the environment's zone switches it on (kept, redundant, until both DEV boxes
  are past the bridge); licence and clients keys → the environment's documents for the record (the manager keeps reading
  the image's: the clients key follows the update repository, one in phase 1, LNK-26); TUF root and URLs → the update
  repository (builder U's channel work), not the environment; self-registration with control → gone (LNK-01). Image-level
  conveniences of the DEV image stay with that image: the Incus agent, the hosts service, the serial console line, the
  console shell.
- **Why**: one image for everyone, and an environment that is a box's own choice rather than its image's (LNK-01a). The
  box file names an environment and nothing else, so a file written by mistake can only move a box between environments
  its image already trusts.

## NX-521 How a box is reached: the installer writes it, the recovery menu changes it (2026-11-18; Whombat LNK-12, LNK-15)

- **What**: `whombat-install --reach link|tailscale|both [--login-server URL] [--environment dev]`, checked before the disk
  is touched, writes `/persist/whombat/reach.json` (`{v, seq, link, tailscale, loginServer?, by, at}`, root 0644) and,
  with the developer option, `environment.json` on the installed disk. The recovery menu's 11 “Change how you reach this
  Whombat” and 12 “Turn on Tailscale” run `whombat-manager reach …` on the mounted data volume. The manager acts on each
  seq once (MG-174).
- **Why**: the console's text screen takes no input (LNK-12), so the choice is asked where a keyboard is, and the
  recovery menu is the way back when no app can reach the box.

## NX-522 One Whombat image for every box (2026-11-19; Whombat ONE-01…ONE-05, ONE-17; supersedes the DEV image of NX-60, NX-520's dev-instance parts and NX-516)

- **What**: `nix/profiles/prod-instance.nix` is the image of every box (`self-installed-prod`, `installer-iso-prod`,
  `release/build prod`): environment `prod`, the GitHub repository (`releases.whombat.com`, the GitHub targets layout)
  with channels, default Production (`whombat.helper.defaultChannel = "production"`), new identities env `prod`.
  `dev-instance.nix`, `self-installed-dev`, `installer-dev`, `installer-iso-dev` and `release/build dev` are gone; the
  Hetzner repository's root and clients keys (`manifest/prod/tuf-root.json`, `clients-channel-keys.json`) went with
  them. The `dev` environment stays in `environments.nix` (a box whose file says `dev`, Home, keeps working); nothing
  writes it (no `environmentBridge`).
- **Trust documents**: the image pins the GitHub repository's root and its AI client channel keys from `manifest/prod/`
  (`tuf-root.json`, `client-channel-keys.json`) once the cutover commits them, and the same repository's interim ones
  from `manifest/dev-instance/` until then. `manager.nix` refuses a production image whose pinned root one root key can
  replace (threshold below two, or fewer keys than the threshold), unless it is `whombat.helper.interimRoot` (the
  interim root): the rule holds by itself once the rotated root is pinned. The support CA of production is
  `manifest/prod/support-ca.pub` when committed (ONE-17), none before.
- **The channel bridge**: `whombat-channel-bridge.service`, before both managers: a box whose resolved environment is
  `dev` records `development` as its channel (`whombat-update-helper set-channel development --if-unset`), so Home keeps
  Beta instead of following the new default; never over a choice made.
- **What the DEV image gave Home** is the Whombat image's: NX-523.
- **The cleanup release** (after Home's move, its own commit): the `dev` environment, `manifest/dev-instance/`, the
  channel bridge and `whombat.helper.interimRoot` go; the rotated root and the env prod clients keys must be in
  `manifest/prod/` first.
- **Why**: one environment (ONE-01): one image, one repository, one set of trust documents; Beta and Production are
  channels of it, not images.

## NX-523 What Home has is the product: the servers' hub, the Incus agent, the merge rule (2026-11-19; Whombat ONE-01, ONE-02; amends NX-143, NX-152, NX-157, NX-522)

John, 2026-11-19: no difference between DEV and production; what Home has today becomes the product.

- **The servers' hub on every box**: `prod-instance.nix` sets `whombat.hosts.enable`. `hosts.nix` takes it in production
  only when the package's agents carry the public half of the Whombat agent-signing key and its manifest was checked
  against it (`passthru.updateKey` = `nix/packages/hosts/agent-update-key.pub`, `passthru.manifestCheck`): the image
  never serves an unsigned agent or another key's. The same module, package, uid, `/persist/hosts` and port 8443 as the
  DEV image, so Home's hub, its store and its connected servers carry on; the pin and the manifest are unchanged
  (`checks.hosts-pin`, `hosts-agent-manifest`).
- **One agent-signing key** (amends NX-157): `40f47772ee26385e` (`~/.config/whombat/agent-signing-dev.key`, the file
  keeps its name; `dev/sign-agents`) signs the agents of the one environment. No second, production key (Whombat AU-10's
  “production agent key” is this one).
- **The Incus agent** (amends NX-143): in the Whombat image, started only by Incus's virtio port (NX-290); `base.nix`
  refuses it in production without that condition. Whoever runs the Incus that hosts the box as a VM can reach it, as
  they can its disk; on a machine of its own or another hypervisor it never starts.
- **The merge rule** (`WHOMBAT_MERGE_RERUN`: the tracker's repository re-runs only infrastructure faults) is not the
  image's: NX-524.
- **Not carried, DEV plumbing or a test box's rule**: the serial console line (NX-120: claim letters for whoever reads
  the serial port; only `dev/devbox` read it), DEV's control, app, embed, relay and zone, DEV's keys (licence, clients,
  support CA: production's), `WHOMBAT_OWN_ADDRESS=on` (the environment's zone switches it on), the default channel
  development (the channel bridge keeps Home on Beta) and the image environment `local`. With the image's environment
  `prod`, remote help follows production's rules (RH-03): the help code is asked for, and a Forever grant isn't kept
  (only test Whombats had one); Home is granted remote help again, with a help code.

## NX-524 The image names no repository: the merge rule isn't the image's (2026-11-20; Whombat AR-58, AGR-14…AGR-17; amends NX-523, supersedes IN-631)

Cybex's GitHub home is the organisation `CybexBV` (2026-11-20); the tracker's repository lives there under the
tracker's own name.

- **No environment sets `WHOMBAT_MERGE_RERUN`** (`nix/profiles/environments.nix`) and the image itself sets none;
  `checks.self-installed-config` checks both. Every repository on every box has the runtime's default, `once` (AR-57).
- **Why not the repository's name**: Whombat's server looks the setting up by the name the box holds for the
  repository (the automation's merge step, any case), never by GitHub's id, and a box takes a repository's new name by
  itself (AGR-14…AGR-16). So the setting would have to spell the tracker's name, which this source never does
  (public-copy.md APC-13). An environment's runtime settings are also in every box's image: one company's repository
  has no place there.
- **Why not the name it had**: `LumioHQ/development` is a name no box holds. Home's repository and its automations
  took the repository's next name on 2026-11-16, and a setting that names only an earlier name matches nothing: Home's
  merges run every failed job once more.
- **John's rule has no carrier** (2026-11-08, IN-631: the tracker's pull requests re-run only infrastructure faults).
  It needs a place on the box itself, kept with the repository so it follows a rename (Whombat's side); until then it
  is not in force anywhere.

## NX-525 Space at power-on opens the boot menu: checked in a VM (2026-11-20; a stranger's install test)

A stranger's install test couldn't open the boot menu by holding Space in a plain QEMU VM, and OVMF ignored Esc too.
Their keys went one at a time through a new remote lease each, seconds apart; systemd-boot (menu hidden, `timeout 0`)
looks for a key for only 100 ms before it boots the default entry, and QEMU's keyboard doesn't repeat a held key the way
a real one does. So the test, not the box, missed the window. The box keeps its settings (`timeout 0`, no editor).

- `checks.install-machine` (q35, OVMF with Secure Boot in setup mode, NVMe: a machine as near as QEMU gets) now ends
  with the way the screen's footer tells a person: from the restart on it presses Space every 50 ms
  (`sendkey spc 30`) for 75 s, then End and Enter (Whombat Recovery sorts last, `SORT_KEY=zz-whombat-recovery`), and
  waits for the recovery menu on the serial console. Only a boot menu that opened gets there.
- `checks.install-vm` is not where it was first put: it still presses Enter on Welcome and expects the checks, but the
  installer has asked Easy or Expert first since CG-401, so it stops there (it isn't one of the nightly checks).
- Still to try by hand, once each, before launch: on Proxmox VE in the noVNC console, and on a real PC with a USB
  keyboard, hold Space from power-on until the menu shows. A firmware that starts its USB keyboard late, or a monitor
  that wakes slowly, can hide the first seconds; the key is read from the firmware's input, so a keyboard the firmware
  doesn't know (some wireless ones) can't open the menu.

## NX-526 A first start that can't finish says why on the screen (2026-11-20; MG-182, CG-409)

- When recording the factory release fails, the provisioning units (`whombat-self-provision`,
  `whombat-factory-provision`) write `/run/whombat-start/problem.json` (`whombat.provisioning.startProblemFile`, root
  0644: `{"v":1,"problem":…,"release":…}`) from `provision`'s exit status: `release-missing` (3, no update channel
  lists the release), `offline` (4, the update repository can't be read), `failed` (anything else, `seed-factory` and
  `whombat-provision self` included). The unit still fails and tries again by itself; a success removes the file. It
  lives in `/run`, so a restart starts from nothing and tries again at once.
- Both consoles read it with `--start-file` (CG-409). Nothing in it is secret: the image's release id.
- `checks.install-vm` installs a box with update channels (production by default, the GitHub layout, metadata over
  HTTPS from the test control with a test certificate) whose release is first listed in no channel: the file, the
  console's API, the text console and the screen (OCR) say why. Then the test lists it in development only (`tufrepo
  add-fake-release --channel development`): one start of the unit records it, the box follows development (the helper's
  `channel.json`) and the server starts.

## NX-527 The appliance's own checks green again (2026-11-20; release preparation)

`checks.eval-aarch64` and five VM tests failed on `main` before the first release from the one repository; each was
looked at and none skipped or loosened.

- **aarch64 speech on the processor**: `whombat.voice.gpu` defaults to on only on x86-64. The Vulkan drivers
  (`pkgs.voice-vulkan`, NX-472) are built for x86-64 alone, so the aarch64 system refused to evaluate. The x86-64 systems
  are unchanged (same derivations).
- **The models fetcher doesn't see the voice socket**: `InaccessiblePaths=-/run/whombat-voice` on
  `whombat-voice-models`. It is the one voice service with the network; the voice test said it can't see the socket of
  the program that hears the person, but nothing hid it. `checks.voice-config` checks the setting.
- **Tests that followed the product**: `backup-destinations` writes its Hermes sessions through Hermes's storage
  interface (`persistence_assembly`), since Hermes v0.23.3 made `hermes_state` a thin layer that goes in v0.27.0;
  `runtime-real` checks a new database's whole chain by its recorded versions, which go on from the chain before the
  cut; `vault-wall` no longer counts root among the uids the Vault's list must keep out, since root reaches private
  addresses on every box with Tailscale (NX-520), and checks that this doesn't come from the list.
- **A direct-boot test VM has `/boot` from the start** (`vm-tests/common/appliance-vm.nix`, made at early boot), as a
  box has its boot partition. The first start asks the update helper for its channel (NX-526), and the helper's
  sandbox needs `/boot`; Lanzaboote's setup made it only after that in `console-self`, the helper failed and systemd
  stopped its socket.

## NX-528 Supertonic 3 is not in the image (2026-11-21; before the public launch)

*Superseded in part by NX-529 (2026-11-21): Supertonic 3 stays out of the image, and now downloads into
`/persist/voice-models` once the person agrees to Open RAIL-M in Settings.*

- `whombat.voice.supertonic.model` defaults to null, so the image carries no Dutch voice model and the voice service's
  health lists only English. `checks.voice-config` asserts that the service starts without it; `checks.voice-speech`
  still builds the model and checks Dutch speech, so the voice comes back working.
- Why: Open RAIL-M needs its use restrictions (Attachment A) in an agreement that binds the people who use the model.
  NX-477 put that on the Appliance Terms before production; they don't name it, and a self-installed box accepts no
  terms at all, so the notices that travel with the model were not enough. A council of four (three for this route)
  chose to leave the model out now and bring it back as a download the person switches on and agrees to at that
  moment, the way the speech-to-text models are fetched after install (NX-473). That download needs the fetcher to
  take a model of several files, and a switch in Settings with the restrictions to accept.
- What changes for a box: a Dutch answer at the desk is spoken by the English voice, as before NX-476. Dutch speech
  recognition (Parakeet, Whisper) is unchanged. The voice service, `supertonic-speak` and the model's package stay in
  the repository; an image that sets the option takes on the licence's terms for its users.

## NX-529 Supertonic 3 downloads on opt-in into `/persist/voice-models` (2026-11-21; Whombat desk-display-talk.md DK-T26)

- **Engine in the image, weights out of the image**: `supertonic-speak` (`nix/packages/voice-engines/supertonic-speak.cpp`,
  GPL-3.0-only, linking `libsherpa-onnx-c-api.so`) stays in the image because it contains no Supertone code or model
  weights; BigScience Open RAIL-M governs only the Supertonic 3 weights. `whombat.voice.supertonic.model` stays `null`
  by default, so the image carries no Supertonic 3 files, while `whombat-voice` always starts with
  `--supertonic ${cfg.kokoro.package}/bin/supertonic-speak --supertonic-speakers 1,8` (and passes `--supertonic-model`
  only if an image explicitly sets one).
- **Multi-file model fetcher**: `models.Manifest` (`appliance/voice/internal/models`) accepts either a single-file
  entry (`file`, `url`, `size`, `sha256`) or a directory entry (`dir`, `files: [{ name, url, size, sha256 }]`) with
  strict checks (known ids, no path traversal or `.part` names, no duplicate targets or filenames, HTTPS or loopback
  test URLs, positive sizes summing within `VoiceModelMaxBytes`, lowercase hex SHA-256). `whombat-voice-models`
  (`appliance/voice/internal/fetch`) downloads a multi-file model into staging directory `.<dir>.part` (`0o750`,
  inheriting group `whombat-voice` from `/persist/voice-models`'s `2750`), checking the model's generation, `wanted`
  flag, and context under `f.mu` (the same lock `Remove` takes before bumping the generation and moving paths aside)
  when creating the staging directory or opening any `.part` file so a cancelled download cannot recreate paths after
  removal reports `absent`. It resumes mid-file with HTTP `Range`, skips files already verified by SHA-256 across
  restarts, checks free space before starting, publishes atomically by renaming `.<dir>.part` to `<dir>` only after
  every file passes size and SHA-256 verification, removes both paths on `remove` (reporting `removing` and the
  remaining bytes on disk whenever deletion fails or leftover `.removing-<id>.*` / partial final entries survive
  startup cleanup, checking `.removing-<id>.*` trash before `.wanted.json` at startup and before starting a new
  `Fetch` so undeletable trash keeps reporting `removing` and its remaining bytes until deletion succeeds), and never
  resumes `supertonic` from `.wanted.json` at startup (the server asks again while the saved setting is on). Plain v1
  responses omit `supertonic` and map `removing` to `absent` unless the caller asks for opt-in models
  (`?include=supertonic` or a `fetch`/`remove` naming `supertonic`), so a runtime rollback whose v1 schema accepts only
  speech-recognition models and pre-`removing` states still parses the fetcher's answers.
- **Pinned manifest**: `voice-models.json` (`nix/packages/voice-models/default.nix`) lists `parakeet`, `whisper`, and
  `supertonic` (`dir: "supertonic-3-int8"`): the seven sherpa-onnx int8 files from
  `csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11` (`cca5a0e6`) plus `LICENSE` from
  `Supertone/supertonic-3` (`3cadd1ee`), totalling 145 310 775 bytes, so the Open RAIL-M licence travels with the
  model. Downloaded files live in `/persist/voice-models/supertonic-3-int8`, surviving appliance updates (subvolume
  excluded from backups; re-downloaded if needed).
- **Dynamic loading and STT guard**: `engine.Supertonic` uses `--supertonic-model` when set, otherwise resolves
  `supertonic` from `--manifest` and `--models` (`models.Present`) on each health and TTS call, so Dutch turns on as
  soon as the download completes and turns off when removed, with no service restart. `engine.STT.bin` matches only
  `parakeet` and `whisper` so `supertonic` never appears as a speech-to-text model.
- **Checks**: Go unit tests in `models`, `fetch`, and `engine`; `checks.voice-config` verifies `supertonic-speak` and
  `--supertonic-speakers 1,8` are wired with no `--supertonic-model` and that `voice-models.json` lists `supertonic`
  with `LICENSE`; `checks.voice-speech` runs `whombat-voice` without `--supertonic-model` and verifies English-only
  before placement, Dutch speech after symlinking the model directory, and English-only again after removal;
  `vm-tests/voice.nix` verifies multi-file download, permissions, dynamic health toggle, and removal inside the real
  systemd sandboxes.

## NX-530 A server that started before the box's release was recorded is restarted once it is (2026-11-22; Whombat automation-recipes.md AR-73, NX-446)

A box offline at its first start can start `whombat-server` before its factory release is recorded (NX-446): its
`WHOMBAT_RELEASE_ID` is then `factory` (`runtime.nix`), so the server can't tell which release an update would go back
to and keeps mail automations off (AR-73) until it restarts. Once the update helper recorded the release
(`seed-factory`), provisioning restarts the server if it runs (`systemctl --no-block try-restart whombat-server.service`;
one that doesn't run starts with the units after it), and the start step writes the release's own id. Only the server
reads the id, so only it restarts.
