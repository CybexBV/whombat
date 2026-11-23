# Device manager, update helper and release tooling (MG decisions)

Workstream: `manager` (branch `manager`). Owns `manager/**`, `helper/**`, `release-tools/**`, this file and
`docs/runbooks/updates*.md`. Builds on MA-03, MA-06, MA-10…MA-13 (`docs/implementation/architecture.md`) and the
contracts `whombat-contracts` 0.4.0 (vendored, MA-02). Decisions are `MG-nn`; a later entry that changes an
earlier one names it.

## MG-01 One Go module; the helper links no manager code

The repository root `go.mod` (`github.com/CybexBV/whombat/appliance`, Go 1.26) holds all Go code:
`manager/` (manager, recovery launcher), `helper/` (update helper and the packages it shares), `release-tools/`
(development TUF tooling). Shared, trust-critical code lives under `helper/pkg/` (`canonjson`, `atomicfile`,
`peercred`, `trust`, `netconfig`, `proto`): changing it is a helper change. `helper/internal/server`'s
`TestHelperDoesNotImportManager` fails if the helper binary ever depends on `manager/` or `release-tools/`.
The contracts' Go bindings are vendored unmodified in `third_party/whombat-contracts-go/` (currently 0.4.0,
tarball SHA-256 in `VENDORED.md`) with a `replace` directive (MA-02). Nix packaging: `buildGoModule` with the repo
root as `src` and `subPackages` = `manager/cmd/whombat-manager`, `manager/cmd/whombat-manager-recovery`,
`helper/cmd/whombat-update-helper` (and `release-tools/cmd/tufrepo` for development shells only). I created the
root `go.mod`/`go.sum` and `third_party/` because every Go component needs them; nothing else outside my paths.
The vendored bindings are **0.5.4** (`contracts-v0.5.4` @ `e0e74d5`; 0.5.0 adoption in MG-22, 0.5.4 in MG-26).

## MG-02 TUF: go-tuf/v2 v2.4.2

`github.com/theupdateframework/go-tuf/v2` **v2.4.2** (released 2026-05-19; checked 2026-09-25: repository not
archived, last commit 2026-09-22 (#784), releases 2.4.0/2.4.1/2.4.2 in 2026, ML-DSA support merged 2026-09-14,
maintained by the TUF project under the CNCF). Used as specified: trusted root pinned at provisioning, the
client workflow (root chain up to 256 rotations, timestamp, snapshot, targets) with rollback, freeze and
consistency checks, consistent snapshots with hash-prefixed target names. Two additions around it:

- **Time reference** (MG-14): each refresh runs with `ReferenceTime = max(now, trusted time floor)` via
  `Updater.UnsafeSetRefTime` (named "unsafe" because it lets a caller pick the time; we only ever move it
  forward from signed evidence).
- **Durability**: go-tuf writes its cache without fsync. After every refresh we fsync the cache files and
  directory; a cached `root.json` that no longer parses/self-verifies is replaced by the pinned root (the chain is
  re-walked), and torn timestamp/snapshot/targets files are dropped (they are re-fetched; valid old files are kept
  for rollback protection).

Targets are top-level only (no delegations in v1). Artifact downloads do not use go-tuf's in-memory
`DownloadTarget` (closures are large): the manager streams to `<staging>/<sha256>.part` with HTTP range resume,
never writes past the TUF length, and verifies length + every listed hash (sha256 required, sha512 optional)
before renaming it into place (`tufclient.Downloader`, `trust.VerifyFile`).

## MG-03 The helper verifies everything itself

`whombat-update-helper` never trusts the manager's verdict. For each operation it:

1. refreshes TUF **itself** — its own root-owned cache (`/var/lib/whombat-update-helper/tuf`) and its own pinned
   root — reading the files the manager mirrored (`/persist/manager/tuf/mirror`, served through a `mirror://`
   fetcher; a tampered mirror fails signature/rollback/freeze checks exactly like a hostile network);
2. resolves the release id to the approved tuple and its artifacts from **its** verified metadata;
3. for state-changing operations (`activate-runtime`, `activate-host-on-reboot` of a new release,
   `migrate-runtime`) verifies the control assignment file (`/persist/manager/assignment/current.json`) with the
   contract verifier against TUF-published assignment keys, including device, env, lifetime and sequence (the
   helper keeps its own highest sequence and time floor);
4. copies each staged artifact into its own directory **while hashing** and imports only that copy (no
   check-then-use race with the manager-writable staging file).

Rollbacks do **not** need fresh TUF metadata: the helper records every activation (release, digest, host,
runtime and provider store paths it resolved from verified metadata) in its own state and rolls back to those
records. `seed-factory <releaseId>` (a root CLI, not a socket op) records the factory tuple at provisioning.

## MG-04 Canonical JSON is RFC 8785 (JCS), integers only

`helper/pkg/canonjson` mirrors `canonicalJson` of `@whombat/core` (members sorted by UTF-16 code units,
ECMAScript string escaping, invalid Unicode rejected). Non-integer numbers are rejected (no signed appliance
document needs them). It passes the contracts' `canonical` vectors (`trust/conformance_test.go`).

## MG-05 Journal format

`manager/internal/journal`: two slots written alternately (temp file + fsync + rename + directory fsync); each
record carries `format`, `version`, `minReader`, a monotonically increasing `seq`, `writtenAt` and the SHA-256 of
the canonical state. Load takes the valid record with the highest `seq`, so a torn or corrupted newest write
falls back to the previous complete state. `minReader` lets an older (known-good recovery) manager refuse a
journal it must not act on; changes are additive unless it is raised. The state embeds the contract view
`release.UpdateJournalRecord`, validated against its JSON Schema on every write, plus the manager's own resume
data (MG-06).

## MG-06 State machine: contract states and transitions

States and transitions are `release.UpdateJournalState` / `release.CanTransition` (CT-13); the engine refuses to
persist any other transition (`ErrBadTransition`, covered by every test). Consequences:

- A rollback runs **inside** `Activating`/`Verifying` (sub-state `candidate.rollback`: decide schema access →
  switch back → verify known-good health) and ends in `RolledBack`; `RolledBack → Quarantined` after
  `MaxAttempts`, otherwise `RolledBack → Assigned` after backoff.
- `Failed` is only for failures before the installation changed (download, verification, staging, schema
  refusal, lost safe boundary, failed migration before activation); `Failed → Assigned` (retry) or
  `→ Quarantined`.
- Pause/hold/locks never move backwards (`WaitingForSafeBoundary` stays and resumes the runtime).
- **Forward repair** is the contract state `ForwardRepairRequired` (CT-31, contracts 0.5; this replaces the
  earlier `RolledBack → Quarantined` + failure mapping). It is entered from `Verifying`/`Activating` when a
  migration ran and the known-good binary cannot use the database (`check-schema <knownGood>` answers access
  `none`): nothing is rolled back or rewound, the candidate (if it activated) keeps running and becomes
  `current`, the release is quarantined locally (the same release is not retried) and only a fix-forward
  assignment leaves the state (`ForwardRepairRequired → Assigned`). A migration that fails *before*
  activation is guarded inside `Activating` (`candidate.guard`): the known-good check runs there and leads to
  `Failed` (known-good can use the database; runtime resumed) or `ForwardRepairRequired` (it cannot).

Every step performs at most one external effect and persists before the next; every effect is idempotent
(resumable downloads, `alreadyDone` helper results, intent-first helper activation, drain renewals under one
request id). Resume data: candidate release (verified metadata snapshot), class, assignment sequence and
`notBefore`, attempts, drain request id, deferral (blockers, explanation, windows), schema plan (verdict,
checkpoint ref, migrate attempted/done), activation boot id, verify deadline, health evidence, rollback progress;
installation tuples `current` / `knownGood` / `previousKnownGood`; pending (queued) assignment; last assignment
sequence; trusted time floor; local quarantine; maintenance lock; hold.

Update classes come from `release.UpdateClass(current, candidate)` (CT-35): **runtime** (runtime/provider
bundles changed; profile switch + unit restart) and **host** (`host` or `runtime+host`: host generation or manager changed; `activate-host-on-reboot` also switches the runtime profiles, reboots, boot
counting, `bless-boot` after local health).

## MG-07 Policy defaults

Max attempts 3 (download corruption, helper verification, bad health, failed migration; *not* disk space,
metadata freshness, helper/control unavailability, lock timeouts), retry backoff 1 min doubling to 1 h, disk-space
retry 30 min, drain lease 2 min (renewed every step), a probe for a quiet moment every 30 s and drain windows only
after 6 h of probing (MG-137), drain window 10 min, recheck after a window 15 min,
deferral explanation escalates after 24 h (never kills work), runtime-down grace 5 min (a stopped runtime has no
work to protect), verify timeout 10 min (host: +20 min for the reboot), health interval 10 s, 3 consecutive
healthy checks. Overridable in the config `policy` block (tests only).

## MG-08 Control API: contract device envelope and assignments

`manager/internal/controlapi` uses the vendored `device` package: `POST /v1/device/<op>` with a
`DeviceRequestEnvelope` (`aud = whombat-api:<env>`, ±300 s, 128-bit nonce). Ops used: `ticket.issue`,
`update.assignment`, `update.progress` (every journal transition), `claim.claimed`, `revocations.report`,
`push.send` (the last three on behalf of the runtime, MG-11), `status.report` (MG-23). The contract device
vectors verify and our signing reproduces their signatures. `update.assignment` answers `{result:
assigned|unchanged|none, assignment, nextCheckS}` (CT-28); an answer whose `result` disagrees with the presence of
the assignment is rejected, and only `assigned` is verified and offered. Assignments are `release.SignedAssignment` verified with `release.VerifyAssignment`
against keys **published through TUF** (`control/assignment-keys.json`, MG-21), so the offline release custody
decides which online keys may assign and key rotation is a TUF targets change. Semantics: sequence strictly
greater than the last accepted (a re-delivered one is a no-op; the helper accepts its own last sequence again);
`action: hold` = stay on the current tuple, start no activation, interrupt nothing; `notBefore` is the earliest
activation (maintenance window); an install assignment whose tuple is not TUF-approved, not compatible or locally
quarantined is refused; a newer assignment during an activation is queued; a re-issued assignment for the
release in flight keeps progress.

## MG-09 TUF repository layout for releases
Superseded in part by UP-X23 (HE-52): components are delivered by closure-index targets only.

- `releases/<releaseId>.json`: content = JCS of the `release.ReleaseTuple`; custom
  `{"whombat":{"kind":"release-tuple","tuple":{…}}}`. The client checks that the custom tuple's canonical bytes
  match the signed target hash and that `release.TupleDigest` equals `sha256:<target hash>` (so the assignment's
  `tupleDigest` is bound to TUF).
- Artifact targets `host/…`, `runtime/…`, `provider/…` (format `nix-export`: a `nix-store --export` stream),
  custom `{"whombat":{"kind":"host-generation|runtime-bundle|provider-bundle","version","format","storePath",
  "narHash","closureSize","managerStorePath"(host),"provider"(provider)}}`. Tuple components are linked to
  artifacts by store path, NAR hash and version; the host artifact must contain the tuple's manager store path.
- `control/assignment-keys.json`: the contract `AssignmentKeys` document (MG-21).
- Compatibility (contract functions, CT-35): every tuple must pass `release.CheckActivation(t, t,
  t.runtime.schemaWrites)` (host ABI in range; reads what it writes). At `Staged` the manager runs
  `CheckActivation(current, candidate, liveSchema)` (the candidate must read the live schema and not write an
  older one) and `ProtocolOverlap(current.protocol, candidate.protocol)` (a candidate sharing no protocol major
  with the installed runtime would strand every client) and fails the candidate (`schema_incompatible`, with the
  contract reasons) otherwise. Runtime-only activation additionally requires the tuple's host to be the booted
  system. `ServesClient` is not used by the manager: per-client protocol negotiation is the runtime's.

## MG-10 Manager ↔ helper protocol

Socket `/run/whombat-update-helper/helper.sock` (systemd socket activation, `SocketMode=0660`, group
`whombat-manager`); the helper checks `SO_PEERCRED` uid == manager uid and exits after 60 s idle. One JSON line
per connection, max 1 KiB, strict decoding, one response line:

```
{"v":1,"op":"<op>","releaseId":"…"}            stage-runtime | activate-runtime | stage-host | activate-host-on-reboot | check-schema
{"v":1,"op":"migrate-runtime","releaseId":"…","checkpointId":"…"?}
{"v":1,"op":"rollback-runtime","releaseId":"<candidate>"?} | {"v":1,"op":"bless-boot"} | {"v":1,"op":"revert-network"}
{"v":1,"op":"prune-host-generations"}                                                          (MG-24)
{"v":1,"op":"prune-runtime-generations"} | {"v":1,"op":"collect-garbage"}                      (UP-X18, UP-X19)
{"v":1,"op":"apply-network"|"confirm-network","candidateId":"n-…"}
→ {"v":1,"ok":true,"result":{"releaseId","alreadyDone","storePaths","rebootPending","rolledBackFrom","schema":{…}}}
→ {"v":1,"ok":false,"error":{"code","message"}}
```

Codes: `bad_request`, `forbidden`, `verification_failed`, `metadata_stale` (freshness/availability — refresh and
retry, never counted), `not_assigned`, `incompatible`, `not_staged`, `nothing_to_roll_back`, `boot_mismatch`,
`activation_failed`, `no_space`, `schema`, `internal`. Release ids match the contract `ReleaseId`, candidate ids
`^n-[a-z0-9-]+$`, checkpoint ids `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; nothing else is accepted (no commands,
paths, URLs, Nix expressions). Three ops beyond the original list, each typed and justified: `confirm-network`
(disarms the dead-man revert once connectivity is confirmed), `check-schema` (read-only, runs the release's own
`whombat schema-check --json --env`) and `migrate-runtime` (the single migration authority, MD-10; needs the same
authorization as an activation). Schema commands run as the runtime user with `WHOMBAT_ENV_FILE`, so the manager
never holds database credentials.

`activate-host-on-reboot` semantics: make the release the boot default (system profile +
`switch-to-configuration boot`) and switch the runtime profiles; reboot (scheduled, after replying) only when
the booted system differs, otherwise restart the runtime units. Allowed for the assigned, TUF-verified release
or for a host release the helper itself recorded (rollback). Activations record intent before changing
profiles, so `rollback-runtime` restores the previous runtime from any partial state. The manager sends its
candidate as `releaseId` of `rollback-runtime`: the helper then rolls back only when that release is its
recorded current runtime and otherwise answers `alreadyDone` without touching anything (an activation that
never took effect is never "rolled back" past known-good).

Activator implementations: `nix` (fixed absolute programs from the unit's config: `nix-store --import` of the
verified copy and `--check-validity`, `nix-env --profile … --set`, `<host>/bin/switch-to-configuration boot`,
`systemctl restart -- <units>`, `systemd-run --on-active=… systemctl reboot`, a configured bless command,
networkd files + `networkctl reload`) and `fake` (directory-based, tests; refused for env `prod`). The `nix`
activator is unit-tested for exact argv and value validation only; it has not run against a real Nix store as
root (VM tests, see open items).

## MG-11 Manager local API (`/run/whombat-manager/api.sock`)

Contract `local` (CT-23, `docs/local-ipc.md` in contracts), peer uid checked per endpoint:

| Endpoint | Caller | Does |
|---|---|---|
| `POST /v1/runtime/ticket {class}` → `{ticket, relayUrl, worker, expiresAt}` | runtime | `ticket.issue`, cached per class until 60 s before expiry |
| `POST /v1/runtime/claimed {claimId, claimedAt}` | runtime | `claim.claimed {claimId, claimedAt}` (CT-27: control completes exactly that claim) |
| `POST /v1/runtime/revocations {peerId, revokedAt}` | runtime | `revocations.report` with `ref = local.RevocationRef(peerId)` |
| `POST /v1/runtime/push` (PushRequest) | runtime | `push.send` |
| `GET /v1/update/status` | runtime, lock holders | state, current, known-good, candidate, explanation, failure, hold, read-only |
| `POST /v1/maintenance/lock {holder, reason, ttlS}` / `unlock {holder}` | lock holders (backup) | 409 while an update is activating/draining |
| `POST /v1/network/candidates` (netconfig candidate) / `GET /v1/network/status` | runtime | MG-15 |

Errors are `LocalError {error:{code,message}}`; control unreachable → `503 {code: unavailable}`. The management
key never leaves the manager. Since contracts 0.5 (CT-37) the last three rows are contract types too:
`UpdateStatusResponse` (state = journal enum, explanation printable ASCII), `MaintenanceLockRequest` →
`MaintenanceLock` (RFC 3339), `MaintenanceUnlockRequest` → `LocalOk`, `NetworkCandidate` (strict, MTU
576–9216) → 202 `NetworkSubmitResponse`, `NetworkStatus`.

## MG-12 Manager → runtime admin socket

`manager/internal/runtimeapi` uses the contract types: `POST /drain {v, requestId, reason, scope: "all",
releaseId, leaseMs}` (idempotent per request id, renews the lease; the runtime resumes by itself when the lease
lapses — manager crash safety; `409 busy` while another caller's drain, e.g. the backup write barrier, holds the
runtime is treated as a blocker), `POST /resume`, `GET /health` (`RuntimeHealth`, 503 still carries the body),
`POST /claim-window {required, openUntil}` (sent at start; opening the physical window is a hardware event the
image wires later), `POST /facts {update: UpdateFacts, backup: null}` (sent on every transition and at start;
`deferredReason` is a code: `hold|lock|window|boundary|checkpoint|metadata`). The fake runtime used by tests
implements the same contract and validates bodies with the generated parsers.

## MG-13 Health

Local health only: runtime units active (`systemctl show -p ActiveState`, unprivileged), runtime `/health`
reachable with status `ok`, database ok, migrations compatible with access ≠ `none`, session endpoint listening
(plus an independent connect to `runtime.sessionAddr` when configured), and the runtime reporting the candidate's
version. Relay/control/provider state (`external`) is recorded but never decides health; no check makes a model
call. Verification needs `HealthyStreak` consecutive passes before the deadline; the journal keeps the last 8
evidence records and the contract `HealthEvidence` view.

## MG-14 Freshness, clocks and offline devices

- A new assignment is accepted only against a **fresh** TUF refresh; the helper refreshes again at activation.
  Before activating (at the safe boundary) the manager refreshes; if that fails the window ends, the runtime
  resumes and the explanation says so (`deferredReason: metadata`).
- **Trusted time floor**: the journal keeps the largest `issuedAt` of accepted assignments; TUF and assignment
  checks use `max(now, floor)`. A clock reset to the past cannot make metadata that expired before the floor look
  fresh (the helper keeps its own floor). The floor cannot protect beyond the last signed time seen (inherent to
  TUF without a trusted clock); cached-metadata rollback protection covers the rest.
- A clock **ahead** makes metadata look expired: refused (no activation), the installed release keeps running,
  the error is reported; nothing is recorded as a floor from the local clock.
- Long-offline devices walk the root chain (tested with three full key rotations over 200 days) and accept fresh
  metadata; if the repository itself stopped publishing, expired metadata is refused.
- Control or repository unreachable: jittered exponential backoff (control: from the poll interval up to 30 min;
  TUF: 1 min up to the refresh interval), downloads retry without counting attempts, nothing touches the
  installed release.

## MG-15 Network change guard

`manager/internal/netguard` + helper ops. Candidates are typed (`helper/pkg/netconfig`: interface name, IPv4
dhcp/static, IPv6 auto/static/disabled, ≤ 4 DNS servers, MTU, confirm timeout 30–600 s) and rendered by the
helper into a systemd-networkd unit from parsed fields. Sequence: submit (takes the maintenance lock so no update
activates meanwhile) → persist `applying` with the deadline → `apply-network` (the helper **arms a root-owned
dead-man revert** via `systemd-run --on-active` *before* applying) → `confirming` until a TCP connect to the
control endpoint succeeds → `confirm-network` (disarms, commits) — or after the deadline `revert-network`. A
manager crash reverts on restart after the deadline; a dead manager is covered by the dead-man timer. Extended to
Wi-Fi joins and forgets, with the network state and “online”, by MG-100…MG-104 (2026-10-20).

## MG-16 Supervisor and known-good recovery

A broken manager binary must not block recovery (see "systemd units" below):

- `whombat-manager.service` is `Type=notify` with `WatchdogSec`; the engine loop is the watchdog heartbeat (a
  stuck engine stops the pings). Repeated failure → `OnFailure=whombat-manager-recovery.service`.
- **Since W4-SEC part 2 (M-3, MA-21d) no manager binary is copied.** The known-good manager is the
  `whombat-manager` of the host the update helper recorded as current (then previous): the helper stores
  `tuple.manager.storePath` from the TUF-verified tuple at activation/seed and reports it with the read-only op
  `known-good-manager`. `whombat-manager-recovery` (from the current host generation) asks the helper, checks
  that the path is a valid store path whose `bin/whombat-manager` resolves inside `/nix/store`, and execs it with
  `--recovery` from the read-only store; without an answer, a record or a usable path (or if exec fails) it runs
  the recovery daemon linked into itself. The manager uid can neither plant a binary nor choose the path, and the
  manager units have `NoExecPaths=/persist` (`ExecPaths=/nix/store`). `/persist/manager/known-good` is no longer
  written (`knownGoodAfterSec` is accepted and ignored).
- Recovery mode serves tickets and facts, reports progress, and turns an interrupted `Activating`/`Verifying`
  into a rollback (`manager_recovery`); it never starts an activation (queues assignments). The helper's own
  records let it roll back without the new manager.

## MG-25 Security review part 2 fixes (MA-21; 2026-09-25)
- **Forward-only releases (M-2, MA-21c).** `trust.CheckForward`: a tuple whose host, runtime or manager version is
  lower than the installed one (numeric dotted comparison, pre-releases before releases, build metadata ignored)
  is refused unless the tuple's TUF-signed custom metadata lists the installed release in `allowDowngradeFrom`
  (`{"kind":"release-tuple","tuple":…,"allowDowngradeFrom":["rt-…"]}`; devtuf `AddReleaseAllowingDowngrade`). The
  manager refuses such offers and queued assignments (`DecisionRefused`); the helper refuses activation and
  migration (`downgrade`). Custody-signed rollbacks are the only way back; routine withdrawal of superseded
  releases stays part of the release ceremony.
- **Records without versions (re-review N-5).** A helper record written before versions existed is backfilled
  from the verified tuple of its release (same digest) and saved; if that release can no longer be resolved, the
  installed versions are unknown and the helper refuses the tuple unless custody names the installed release in
  `allowDowngradeFrom`.
- **Helper rollbacks (L-2).** `rollback-runtime` and `activate-host-on-reboot` of a *recorded* release run without an
  assignment only while an activation is unfinished (a pending host, or the runtime activated less than 6 h ago)
  or to align with the booted host (boot-counting fallback), and never to a release that freshly verified
  metadata no longer approves (`rollback_refused`). Stale/unavailable metadata is not a verdict (offline rollback).
- **Pre-migration checkpoints (L-1).** A checkpoint is bound to the drain window it was taken in and valid for
  2/3 of the drain lease; after a resume (hold, lock, window end) or a possible lease lapse a new one is taken
  (`checkpoint_stale` before the migration starts).
- **Development roots (L-4).** `trust.Refresh{Production}` refuses a pinned, cached or rotated-to root that trusts a
  key of the committed development fixtures (`DevelopmentKeyIDs`, kept in sync by a test); the helper sets it for
  env prod, the manager for device env prod. The development private keys moved to
  `release-tools/fixtures/dev-keys` (outside the tree the VM tests serve).
- **Safe opens (L-6).** The helper reads the mirror, staging, assignment and network candidates through
  `safeopen` (openat2 `RESOLVE_NO_SYMLINKS`, O_NONBLOCK, regular files only; component walk without openat2).
- **Strict network values (L-3).** Addresses/prefixes/DNS: address characters only, no IPv6 zone; the networkd
  unit is rendered from the parsed values.
- **Re-provisioning (L-5).** Helper records carry the device id; `seed-factory` for another id starts from fresh
  records. The factory reset also deletes the helper's state, TUF cache and work directory.
- **Time floor (I-1).** After every verified refresh the helper raises its floor to `timestamp.expires − 7 d`
  (custody signs timestamps with a 24 h expiry). With NTS (NX-17) the clock itself is authenticated.
- **TUF mirror (integration harness).** Every successful refresh publishes the complete trusted set (root chain,
  `N.snapshot.json`, `N.targets.json` from the verified cache, `timestamp.json` last), so a refresh that reused a
  cached snapshot can no longer leave the helper with `metadata_stale` forever.
- **Progress redelivery (CL-22).** `update.progress` goes through `journal/progress-outbox.json`: coalesced to the
  latest report per release (≤ 16 releases), sent oldest first, retried with backoff (5 s … 5 min) also across
  restarts; a 4xx other than 401/408 drops the report.
- **Test time.** The crash and kill matrices run their worlds in parallel; the package took ~18 min under
  `-race` and hit `go test`'s 10-minute default (the review's unexplained FAIL), now about a minute.

## MG-17 Configuration and paths

`/etc/whombat/manager.json` (manager; strict JSON, unknown fields rejected) and
`/etc/whombat/update-helper.json` (helper), both generated by the Nix module. Identity from provisioning:
`/persist/identity/device.json` `{deviceId, env}` (readable by manager and helper),
`/persist/identity/management.key` (PKCS#8 PEM Ed25519, `whombat-manager:whombat-manager 0600`; the manager
refuses group/other-accessible or foreign-owned keys and symlinks). Manager state under `/persist/manager/`:
`journal/`, `tuf/cache/`, `tuf/mirror/` (a box on the GitHub repository: `tuf/github/cache/`, `tuf/github/mirror/`,
updates UP-X35), `staging/`, `assignment/current.json`, `network/{candidates,state}/`, `known-good/`. Helper state:
`/var/lib/whombat-update-helper/` (root 0700: `state.json`, `tuf/` or, on the GitHub repository, `tuf-github/`,
`work/`, `network/`). Pinned root: `/etc/whombat/tuf/root.json` (from the image, root-owned). See the unit layout below
for sockets.

## MG-18 Schema compatibility and migrations (MD-10)

Per `Whombat docs/decisions/managed-db.md` MD-10: at `Staged` the manager runs the candidate's read-only
`schema-check` (helper op). `current`/`newer_compatible` → no migration; `migration_required` → migrate at the
boundary; read-only/refused verdicts → `Failed` (`schema_incompatible`, counted). When `needsCheckpoint` is
non-empty, the manager asks the backup service for a **verified checkpoint** while the runtime is quiesced
(renewing the drain lease meanwhile) — proposed local API `POST /v1/checkpoints {reason, releaseId,
migrations}` → `{ref, verified: true}` on the backup socket; without one it defers with an explanation and
changes nothing. The request is the contract `CheckpointRequest {reason: "migration", releaseId, migrations,
underDrain: <the manager's drain requestId>}` (CT-30) and the answer a `CheckpointResult` that must be
`verified`. A checkpoint is also required when `CheckActivation(current, candidate, db).requiresCheckpoint`
(the installed runtime cannot read what the candidate writes) even if no single migration is a contract one. At
`Activating` it records `migrateAttempted`, runs `migrate-runtime` with the checkpoint ref, then activates. On a failed candidate after a migration attempt it asks the **known-good** binary
(`check-schema <knownGood>`): `read-write`/`read-only` → roll the runtime back (`rolled_back_read_only` is reported
as degraded); `none` → no rollback, no rewind, `ForwardRepairRequired` (MG-06). Without an answer before the deadline it
falls back to `CheckActivation(knownGood, candidate, candidate.schemaWrites).rollbackCompatible`.

## MG-19 Staging capacity

Required space = download + unpacked closure size + the helper's private copy of the largest artifact + reserve.
`EnsureSpace` garbage-collects only staged files that belong to no current, known-good, previous-known-good,
candidate or queued tuple; if it still does not fit, `Failed(no_space)` (not counted, retried after 30 min). The
manager never asks the helper to delete store paths; the known-good generation stays referenced by its Nix
profiles. Tested with an injected quota and with a real 256 KiB tmpfs in an unprivileged user namespace.

## MG-20 Provisioning interface (for the provisioning/NixOS workstream)

Provisioning (owned by `provisioning/`, not this workstream) must: create `management.key` in the format above
(`whombat-manager keygen --out …` exists for development), write `device.json`, register the device with
control using contracts `device.SignRegistration(r, management, content)` — both keys, so the provisioning tool
(which has access to the runtime-owned content key) does it, not the manager; install the pinned dev/prod root;
then on first boot run `whombat-update-helper seed-factory <releaseId>` (root) and `whombat-manager provision
--factory-release <releaseId>` (manager user) for the factory tuple.

## MG-21 Assignment-key trust: control's key, authorized through TUF

Decision (2026-09-25, orchestrator): **control generates and holds the assignment private key** (per
environment, in its KMS/HSM); **release custody authorizes it** by publishing the contract `AssignmentKeys`
document `{v:1, env, keys[{kid, publicKey (hex), state: active|next|retired, notBefore, notAfter}]}` (contracts
0.5.1, CT-41) as the TUF target `control/assignment-keys.json`. The target's content is the document's canonical
JSON; its custom metadata carries the same document (`{"whombat":{"kind":"assignment-keys","document":{…}}}`)
and must hash to the signed target. The manager **and the helper** build their key map only from that verified
target with `release.AssignmentKeyMap(doc, env, referenceTime)`:

- accepted now: every `active` key; a `next` key once `notBefore` has passed; a `retired` key until
  `notAfter`; unknown kids never;
- an invalid document — `bad_schema`, `wrong_env`, `duplicate_kid`, `no_active_key`, `active_with_window`,
  `next_with_not_after`, `retired_without_not_after`, `retired_with_not_before` — is a
  `*release.AssignmentKeysError` (kept in the error chain with `trust.ErrInvalidMetadata`) and refuses **every**
  assignment (fail closed; the installed release keeps running). This closes the 0.5.0 gap where a `retired`
  key with `notAfter: null` behaved like an active one.

Control's `GET /v1/assignment/keys` is informational and never read by the appliance. Tooling
(`release-tools`, development only) validates every document with the same function before signing:
`tufrepo add-assignment-key --kid K --public-hex H --state active` | `--state next --not-before T` | `--state
retired --not-after T` (adds or replaces by kid), `remove-assignment-key --kid K` (immediate revocation; refused
if it would leave no active key), `rotate-assignment-key [--grace D]` (new active key; the old one `retired`
until now+grace, or removed). A typical control-key rotation: add the new key as `next` with `notBefore`,
promote it to `active` and retire the old one with a `notAfter` long enough for long-offline devices. Tests:
`trust.TestAssignmentKeyTrust` (unknown kid; next before/after `notBefore`; retired before/after `notAfter`;
removal; wrong key under a trusted kid; each invalid-document code refused by the tooling and, published
anyway, by the device; `no_active_key`; `wrong_env`; rotation with grace).

## MG-22 Contracts 0.5.0 adoption

Vendored 0.5.0; conformance list of `docs/local-ipc.md` (contracts): ForwardRepairRequired (MG-06), `claimId`
(MG-11), assignment poll `result` (MG-08), `AssignmentKeys` + `AssignmentKeyMap` (MG-21), `CheckActivation` /
`UpdateClass` / `ProtocolOverlap` (MG-09, MG-18; `ServesClient` not needed by the manager), `status.report` from
`GET /facts` (MG-23), `underDrain` (MG-18), manager extensions as contract types with MTU 576–9216 (MG-11). Also
conformed the backup service API (owned by the backup workstream, done here on request): `LocalError {error:
{code, message, stage?}}` with `busy` 409, `unprotected` 412, `forbidden` 403, `checkpoint_failed` 502 (+ stage),
`bad_request` 400, `destination_failed` 502, `internal` 500; strict `CheckpointRequest` (`manual|scheduled|
migration`, no `pre-migration` alias, no fallback to `manual`; `migration` needs the manager's uid and
`underDrain`); answers are `CheckpointResult`. The backup manifest keeps its internal reason `pre-migration`.

## MG-23 status.report

Every `nextReportS` (default 300 s) the manager sends `status.report`: `release`, `managerVersion`, `uptimeS`
(`/proc/uptime`), `update` from the journal record, `sessionsActive` and `recoveryKit`
(`local.RecoveryKitState`) from the runtime's `GET /facts` (`RuntimeFacts`), relay state from the same facts
(`connected` ok, `connecting`/`backoff` degraded, `stopped` down), `lastBackupAt` and the backup level from the
backup service's `GET /v1/status` (`protected` ok, `stale`/`pending` stale, `failing` failing, `unprotected`
unconfigured), runtime/database/session-endpoint levels from the local health check, storage from statfs of
`/persist`, `clockSynced` from `/run/systemd/timesync/synchronized`. The body is validated against the contract
before sending. Without runtime facts since start nothing is sent; while the runtime is down the last facts are
reused. `runner` has no separate probe and reports the runtime's level (gap).

## MG-24 Host fallback reconciliation and generation pruning (for docs/decisions/nixos.md)

- **Host fallback.** A host activation switches the runtime profiles before the reboot, so after boot
  counting falls back to the known-good generation the runtime units start the *candidate's* runtime. Inside
  an activation (`Activating`/`Verifying`, host class) the manager detects the fallback on its first step
  (boot id changed, booted system ≠ candidate host) and rolls back with `activate-host-on-reboot <knownGood>`:
  the booted host already matches, so the helper switches the runtime/provider profiles back, fixes the boot
  default and restarts the runtime without a reboot; known-good health is verified, then `RolledBack`
  (`boot_fallback`). Outside an activation (steady states and `Failed`), every step compares the booted
  system with the journal's `current` host; if it is the known-good or previous known-good tuple's host
  (fallback, boot-menu choice) the manager re-activates that tuple the same way and journals it (`current` and
  `knownGood` = that tuple; history note "host fallback"). An unknown booted system is reported
  (`lastRefusal`), never "fixed". Tests: `TestHostFallbackRestoresKnownGoodRuntime`,
  `TestReconcileBootedKnownGoodHost`, `TestReconcileSurvivesCrash`, and the host-fallback crash matrix.
- **Generation pruning.** New typed helper op `prune-host-generations` (no arguments). Before staging a host
  candidate the manager calls it; the helper deletes system-profile generations whose store path is none of:
  the booted system, its recorded current, previous (known-good) and pending hosts, and the newest generation
  (`nix-env --profile /nix/var/nix/profiles/system --delete-generations N…`, then `switch-to-configuration
  boot` of the profile's default so the boot loader drops their kernels/initrds from the boot partition). The
  keep set comes from the helper's own records, never from the request. A failure is logged and staging goes
  on. Tests: `ops.TestHostActivationBlessAndFallback` (prune after a failed candidate),
  `activator.TestNixHostGenerations` (argv, link resolution), `TestFailedHostGenerationsPrunedBeforeStaging`.

## MG-26 Contracts 0.5.4 adoption: the client security floor (CT-53, CT-54) (2026-09-26)

Vendored 0.5.4 (skipping 0.5.2/0.5.3 as separate steps). For the Go bindings the only change since 0.5.1 is the
client security floor; the rest (CT-51, CT-52, CT-55, CT-56) is session surface the manager doesn't touch. The
Go tarball is byte-reproducible (CT-54), so `VENDORED.md` also records the git tree id, which `git write-tree`
of the vendored directory reproduces.

- **Pass-through.** `broker.UpdateFactsOf` copies `Current.Release.clientFloor` into `UpdateFacts.clientFloor` of
  every `POST /facts` (absent when the tuple has none; the contract member is optional, not nullable). `Current`
  is the journal's TUF-verified tuple, so the floor survives a manager restart, a rollback reports known-good's
  floor, and a later release without a floor clears it (no ratchet, as CT-53 says). While a candidate is in
  `Activating`/`Verifying` the facts still carry the current (old) tuple's floor; the candidate's floor applies
  once it is `Healthy`. Floors are monotonic across releases custody approves, so this errs on the side of the
  lower floor for at most the verify window.
- **Helper and manager.** Both parse tuples with the strict contract types, which now know `clientFloor`; the
  manager does not evaluate floors (clients are the runtime's business).
- **Rollout.** Helpers and managers on contracts < 0.5.3 refuse a tuple with a floor (unknown member of a strict
  document, fail-closed). The first release shipping this manager and helper therefore carries no floor
  (`docs/runbooks/updates.md`).
- **Tooling.** `tufrepo add-release` and `add-fake-release` take `--client-floor platform=build,…` (unlisted
  platforms 0; `none` strips a floor from the tuple file); `devtuf.FakeRelease.ClientFloor` for tests.
- Tests: `broker.TestUpdateFactsCarryTheCurrentTuplesClientFloor` (factory tuple: no member; floor release
  installed through TUF: passed through and accepted by `local.ParseFactsRequest`; restarted engine; rollback to
  the floor release; later release without a floor), `devtuf.TestParseClientFloor`,
  `devtuf.TestFakeReleaseCarriesClientFloor`.

## MG-27 The runtime gets its facts again after it restarts (2026-09-26)

The runtime keeps the manager's update facts (`POST /facts`) and the claim window (`POST /claim-window`) in memory
only. The manager used to send facts at its own start and on journal transitions, and the claim window only at
start, so a runtime that (re)started after the manager had none until the next transition (`appliance.status.update`
empty, the diagnostics `updates` scope refused). `runtimeSyncLoop` probes `GET /health` every `runtimeProbeSec`
(default 10 s, jittered) and hands both over again when the runtime becomes reachable (also the first probe after
the manager starts), when it turns from not-`ok` to `ok`, after a failed send (every probe until one succeeds), and
every `factsResendSec` (default 300 s, jittered) while it answers, which catches a restart between two probes. Both
pushes are idempotent replacements. Every facts push (transition or resync) is serialized and built from the
journal as it is at send time, so an older state can't overwrite a newer one. Tests:
`TestRuntimeRestartGetsFactsAgain` (runtime crash after the manager started and an update, back after a few probes;
unhealthy → healthy; periodic re-send disabled), `TestFactsResentPeriodically` (facts dropped with no visible
downtime).

## MG-28 The claim-code lookup lease (2026-09-26; MA-22 CC-03, CC-13, contracts 0.8.0)

While the device is unclaimed the manager holds the lookup lease that makes it a box "waiting to be claimed" at
control (`claims.nearby` lists only boxes with a live lease; the runtime shows `waiting` without one). The loop
`claim-lease` calls the device op `claim.lookup {}` (signed like every op) and renews after `renewAfterS` (jittered),
but never later than half the lease's remaining lifetime; it hands the lease to the runtime with
`POST /claim-lookup {v, lookup, expiresAt}` after every renewal. `runtimeSyncLoop` pushes it again with the facts and
the claim window whenever the runtime comes (back) up (MG-27), because the runtime keeps it in memory only. When
control can't be reached, `claim.lookup` is retried with backoff (`claimLookupRetrySec`, default 15 s, doubling to
5 min) and never later than the lease's expiry; once the lease has run out the runtime gets `{v, lookup: null}` (its
console goes to "Connecting to Whombat…"). A runtime before contracts 0.7 answers 404: ignored. The lookup number is
logged only as "leased" (never the number: the console never shows it either, CC-13).

## MG-29 When the lease stops for good (2026-09-26)

The manager stops leasing, pushes `{lookup: null}` and records `journal/claim-state.json {v:1, claimed:true}` (so a
restart doesn't ask control again) as soon as any of these says the device is claimed: control answers `claim.lookup`
with 409 `claim_conflict` / `details.code: already_claimed`; the runtime reports its claim on the broker
(`/v1/runtime/claimed`, before the manager forwards `claim.claimed`; the broker's `OnClaimed` hook); or the runtime's
`GET /facts` says `claimed: true` (checked before every `claim.lookup`, which also covers a manager restart between the
claim and its report). A device that control retired (403 `device_revoked`) stops too (MG-30). Tests:
`TestClaimLookupLease` (lease, renewal, re-push after a runtime restart, withdrawn after expiry while control is
away, new lease when it's back, released on `already_claimed` and never asked again), `TestClaimReportedStopsLease`,
`TestClaimedRuntimeGetsNoLease`; the dev manager stand-in (`harness/src/dev/dev-manager.ts`) does the same.

## MG-30 A retired, never-claimed self-installed box gets new keys (2026-09-26; CC-10, control CL-33/CL-34)

Control retires self-registered devices that stay unclaimed and unseen for 7 days; from then on every device op
answers 403 `device_revoked` and the identity can't come back (the same registration is `device_retired`), but the
same serial may register again with new keys. The manager can't touch the identity (root's files), so on
`device_revoked` it only asks: it writes `reregisterRequest` (`/persist/manager/reregister.json`,
`{v:1, deviceId, reason:"device_retired", at}`) when **every** local fact says there is nothing to lose — the image
allows it (the path is configured only with `whombat.provisioning.selfRegister`), `device.json` says model
`self-installed`, the manager never recorded a claim (MG-29), and the runtime's facts answer `claimed: false` (an
unreachable runtime is a no). Root acts on it (NX-35) and checks again. A factory box, a claimed box, or any doubt:
the manager only logs that the appliance needs a factory reset or support. Test: `TestRetiredSelfInstalledAsksForNewKeys`
(never-claimed self-installed asks; claimed or factory doesn't).

## MG-31 A runtime restart between two probes is noticed by its new admin socket (2026-09-26; refines MG-27)

MG-27 caught a runtime restart that fell between two health probes only with the periodic re-send (5 min), so a
runtime restarted faster than the probe interval ran without update facts (the h3 diagnostics scenario failed in the
0.6.0 and 0.8.0 candidate runs) and, since MG-28, without its claim-code lease (the console said "Connecting to
Whombat…"). Every runtime process creates its admin socket anew, so `runtimeSyncLoop` also compares the socket
file's identity (device, inode, change time) at every probe and hands everything over again when it changed. The dev
manager stand-in does the same. Test: `TestRuntimeRestartBetweenProbes` (two restarts faster than the probe, no
periodic re-send).

## MG-32 The lease is renewed over both address families (2026-09-26; CC-04, control CL-36)

Control finds a waiting box for a browser by the network tag of the family the browser reaches it over, and keeps
one tag per family (CL-36). Go dials control over IPv6 when it can, so on a dual-stack LAN the box used to be tagged
by its /64 only and a browser on IPv4 found nothing (the reverse too). `claim-lease` now follows every successful
`claim.lookup` with one more, forced over the other family: `controlapi.Client.ClaimLookupOver` reports the family
the normal request went over (an `httptrace` `GotConn` hook on the connection's remote address; IPv4-mapped counts
as IPv4) and sends the extra request through a second `http.Client` per family, a clone of the transport whose
`DialContext` dials `tcp4` or `tcp6` only. When that family has no route, DNS has no A/AAAA record, the URL is an
address literal of the other family, or anything else fails, the extra request is skipped quietly: one debug log
per distinct error (`debugOnce`), 15 s timeout, and neither the lease nor the backoff changes; the lease only ever
follows the normal request (a renewal of a live lease keeps the number anyway). Only `claim.lookup` does this, every
`renewAfterS` while unclaimed; no other request changes. The dev manager stand-in does the same with Node's
`family: 4 | 6` on the request and counts answered lookups per family in its status file (`lookups`). Tests:
`TestClaimLookupOverEachFamily` (forced families, the family reported, IPv4-only control and an IPv4 literal
failing over IPv6), `TestClaimLookupBothFamilies` (a dual-stack fake control, `ServeDualStack`: both families on
every renewal), `TestClaimLookupOneFamily` (`localhost` with an IPv4-only control: the lease works, nothing over
IPv6).

## MG-33 The manager installs the AI clients from the signed client channel (2026-09-26; SUB-09, CT-72…CT-74, contracts 0.9.0)

*Superseded in part by MG-184: Claude Code comes from Anthropic's download site, not the channel's artifact.*

Claude Code and Codex are no longer part of the image (NX-37). On an owner's request the manager installs the latest
tested version and keeps it current (`manager/internal/clients`, `manager/pkg/clientbundle`).

- **Channel.** `clients/channel.json` is a TUF target of the delegated targets role `clients` (terminating, key
  threshold 1, paths `clients/*` and `clients/*/*/*` — go-tuf matches patterns per path segment, so the channel and
  `clients/<provider>/<version>/<os>-<arch>.tar.gz` need one pattern each). The role's key is online (the channel
  publisher's, `docs/runbooks/updates-release-signing.md`); it can sign nothing outside `clients/`, which the
  delegation enforces and `trust` checks again (`Repo.ClientTarget` only hands out `clients/` paths the delegation
  covers; a top-level target of the same path wins, TUF pre-order). The TUF client resolves the channel after every
  successful top-level refresh (`trust.Config.ResolveClients`, manager only; the helper never loads the role); an
  unavailable, expired or badly signed role makes only the channel unavailable, never the refresh. The document is
  verified again with `release.VerifyClientChannel` against the pinned channel key document
  (`clients.channelKeys`, AssignmentKeys shape, `AssignmentKeyMap`), the device's environment and the last accepted
  sequence (persisted; the same sequence again is fine, a lower one is `rolled_back` and the last good channel stays).
  The last verified channel is kept (`<stateDir>/channel.json`) and re-verified at start, so the latest version is
  known offline until the channel expires.
- **Selection.** `release.SelectClientBundle(bundles, provider, linux, <arch>, level)` with the runtime's
  `RuntimeFacts.clientAdapters` (read from `GET /facts` at every check and every runtime (re)start, persisted). A
  runtime without `clientAdapters` (before 0.9.0) gets nothing installed: `404 unavailable` with the reason.
- **Install.** The artifact is downloaded by its TUF target (consistent-snapshot name) into `<stateDir>/staging`,
  never past its TUF length; TUF's length and sha256 must equal the bundle's `artifact.size`/`sha256` (else
  `client.digest_mismatch`), the file must match TUF's hashes (else `client.digest_mismatch`). It is unpacked into
  `<root>/<provider>/.incoming-<version>` — directories and regular files only, plain relative names, no symlink in
  any parent, at most 2 GiB and 10 000 entries — then `artifact.path` must be a regular executable of
  `executable.size` and `executable.sha256` (else `client.digest_mismatch`), permissions go read-only (0555
  executables and directories, 0444 other files), and it is renamed to `<root>/<provider>/<version>`. File contents and
  names are exactly the vendor's (E-C1; Codex keeps `bin/codex` next to `codex-resources/` and `codex-path/`). The
  manager never runs a client. Other failures (network, TUF, space, unpack) are `client.install_failed`.
- **Ownership.** Everything under the root is the manager's (`whombat-manager`, directories 0755 whatever the umask),
  readable and executable by the runner, writable by no one else. Contracts' `docs/local-ipc.md` says “root-owned”; the
  manager is not root and the helper has no op for it, and what matters — the runner (and a task) can't change what it
  runs — holds with the manager as owner. Recorded as a deviation; a helper op could chown later without a contract
  change.
- **Switch.** `installed` changes only when the new version is complete and verified; then `<root>/<provider>/current`
  is re-pointed atomically (relative link, rename) and the status is pushed. The pushed executable path is the
  versioned one (`<root>/<provider>/<version>/<artifact.path>`), so a turn that started on the previous version keeps
  a path that exists: the previous version always stays (it is also the rollback), older ones for at least 24 h
  (`retain`); garbage collection runs after installs and checks, never for a provider while it installs.
- **Rollback.** When the selection is a version still on disk (a withdrawn newer version, or the channel pointing
  back), its executable is re-verified and it is switched back without a download.
- **Updates.** After every TUF refresh (the tuf loop pokes the clients loop), every `clients.checkSec` (default 1 h)
  and when the runtime's adapter levels change, every chosen provider whose selection differs from what is installed
  gets an install (`updating`; `installed` stays the running version) — never while it is installing or being
  removed. A failed version is retried after 15 min, doubling to 12 h; an owner's install request retries at once.
- **Socket (CT-73).** `GET /v1/clients` → `LocalClientsStatus` (both providers; `latest` = the selection for this
  machine and runtime; `progress` 0–80 download, 80–100 unpack; `channel {sequence, checkedAt}`),
  `POST /v1/clients/install` → 202 `LocalClient` (`installing`, or the current state when installing or already at the
  selected version), 409 `busy` while removing, 404 `unavailable` when nothing fits or the channel is unavailable;
  `POST /v1/clients/remove` → 200 `LocalClient` `not_installed` (cancels an install in progress, deletes every
  version, forgets the choice; sign-ins are the runtime's). Runtime uid only. Without `clients.root` in the
  configuration the three answer 404 `unavailable`.
- **Push.** `POST /clients` (`ClientsPushRequest`, validated before sending) after every change (at most once a
  second, progress included), after every check, and at every runtime (re)start (the runtime sync of MG-27/MG-31);
  a runtime answering 404 (before 0.9.0) is not an error. The server keeps it and writes `WHOMBAT_CLIENTS_FILE` for the
  runner (Whombat SUB-25).
- **State.** `<stateDir>/state.json` (0600): chosen providers, installed and previous versions, the failure back-off,
  the last channel sequence and check, the adapter levels. An install interrupted by a restart is resumed by the next
  check. Recovery mode does not run the clients loop (installed clients keep running, nothing changes).
- **Configuration.** `clients.{root, stateDir, channelKeys, checkSec}`; `root` must be absolute with plain segments
  (the contract's executable path pattern: no dot-directories), checked at start.

Tests: `manager/internal/clients` (a development TUF repository with the clients role and bundles built by the
publisher: install, idempotence, update, rollback without a download, garbage collection after 24 h, remove,
digest mismatch of the artifact and of the executable, back-off, channel rollback refused, unknown key, no adapters,
adapter mismatch, no update while installing, remove stops an install, restart resumes, umask 077),
`manager/pkg/clientbundle` (hostile archives: traversal, absolute, symlink parent, hardlink, device, duplicate, file
as directory, size limit), `broker` (status codes), `daemon` `TestClientsInstallAndPush` (over the socket, pushed,
pushed again to a restarted runtime), `helper/pkg/trust` (delegation, paths outside the role ignored, wrong key,
expired role).

## MG-34 The manager renews the appliance licence (2026-09-26; LC-02, LC-05, LC-06, CT-76, CT-77, contracts 0.10.0)

`manager/internal/daemon/licence.go` (the loop), `manager/internal/licence` (key set, verification, the stored
state). Configuration `licence {keysFile, stateFile}`; both optional. Without `keysFile` the manager renews no
licence (an image before 0.10.0); the NixOS module always sets it (NX-38).

- **When.** The loop runs once the manager knows the device is claimed: its claim record (`claim-state.json`, MG-28)
  or the runtime's `GET /facts` `claimed`. It renews at once (also at every manager start: one call per start, well
  under control's 12/h), then after `renewAfterS` from control (±10 %, at least 60 s), and immediately when the
  runtime's claim report reaches control (the broker's `OnClaimReported`, after `claim.claimed` succeeded) or the
  manager learns of the claim (`MarkClaimed`) while it holds no token or the last attempt said `device_unclaimed`.
  A nudge that lands while an attempt is failing with `device_unclaimed` still renews at once afterwards (a counter,
  so the claim report can't be lost in the race).
- **Failures.** Network, 5xx and a malformed answer back off from 60 s to 1 h (`Backoff`, ±20 %). 429 is
  `rate_limited`, backed off the same way. `device_unclaimed` (409, CL-41) and `devices_allowed_reached` (403
  `entitlement_withheld`, CL-40) retry after an hour (±10 %): the claim report may still be on its way, and an org
  back within its limit is noticed within the hour. `device_revoked` stops the loop for good (control never
  un-retires a device); `POST /v1/licence/renew` then answers `device_revoked` without calling control.
  `controlapi` now wraps the `HTTPError` of 5xx/429 answers too (`%w: %w`), so 429 can be told from an outage.
- **Verification.** Every token goes through `protocol.VerifyLicenceToken` with the pinned `LicenceKeySet`
  (`protocol.ParseLicenceKeySet`), `Device` = this device id and `Now` = max(local clock, highWater, control's
  `now` of this answer). A token whose `iat` is older than the held one's is refused as `stale`; a token that doesn't
  verify is `bad_token`. Both keep the held token and mark and back off like a failure.
- **State.** `licence.stateFile` (default `<dir of journalDir>/licence.json`; the image: `/persist/manager/licence.json`)
  holds `{v: 1, token, highWater}` (RFC 3339), mode 0600, written through a temporary file, fsync, rename and a
  directory fsync. `highWater` = max(held mark, accepted `iat`, control's `now`); the local clock never raises it and
  nothing lowers it. At start the stored token is verified again (the pinned set may have changed with an update):
  one that no longer verifies is dropped with a warning, the mark is kept. An unreadable file starts empty (logged).
- **Robustness.** A missing or malformed key set logs an error and runs the manager without the licence loop: updates
  and security fixes never depend on the licence (LC-10). A key set of another environment is logged (tokens then
  fail `wrong_audience`).

## MG-35 The runtime gets the licence (2026-09-26; LC-06, LC-07, CT-77)

`POST /licence {v: 1, token, highWater}` (`runtimeapi.PushLicence`, validated before sending) after every renewal that
changed the token or the mark, and in `syncRuntime` — so at every runtime (re)start (MG-27, MG-31) and with the
periodic re-send (`factsResendSec`). `token: null` is sent while the manager holds a mark but no token; nothing is
sent before the first successful renewal. Only a transport failure fails the sync (retried at the next probe). A 404
(a runtime before 0.10.0) is logged once at debug and tried again with the next re-send; 409 `stale` (the runtime holds
a newer token, e.g. the manager's state was lost) and 400 (the runtime can't verify it) are logged once as warnings
and change nothing. The runtime's answer (`LocalLicenceStatus`) is logged when its state/reason changes
(`licence state at the runtime state=licensed/active`).

## MG-36 Check now: `POST /v1/licence/renew` (2026-09-26; LC-08, CT-77)

The manager socket serves `MANAGER_PATHS.licenceRenew` for the runtime uid only: `LicenceRenewNowRequest {v}` (strict)
→ one renewal now, serialized with the loop's, answered after the attempt and after the push to the runtime (so the
runtime's `licence.refresh` reads the new state): `LicenceRenewNowResult {v, renewed, error?}` with `error` one of
`unreachable`, `rate_limited`, `device_unclaimed`, `devices_allowed_reached`, `device_revoked`, `bad_token`, `stale`,
`control_refused`. A second request within 60 s of the last one (whatever its outcome) is `429 busy` (`Retry-After:
60`); without a licence configuration `404 unavailable`. The loop reschedules from the forced attempt.

## MG-37 Tests for the licence (2026-09-26)

`manager/internal/licence`: the mark from control's `now` and never down, clock rolled back 60 days (a fresh token
still verifies; control's rolled-back token is `stale`), forged (another key under the pinned kid), unknown kid,
foreign device, another environment, admission `typ`, lifetime over 14 days, a token from the future, save/load with
mode 0600 and no temporary files left, a restart with the clock back, a stored token dropped under another key set,
malformed key sets. `manager/internal/daemon` (real daemon, fake control signing with a TEST key from
`licence/licencetest`, fake runtime verifying pushes with the same pinned set): `TestLicenceRenewal` (renewed at once,
stored 0600, pushed with the stored mark, pushed again to a restarted runtime without its token),
`TestLicenceRenewsAfterRenewAfterS`, `TestLicenceClockRollback` (manager clock −60 days, restart with control away:
the stored token and mark are pushed; control's clock back too: `stale`, nothing changes), `TestLicenceRefusedTokens`
(forged, foreign device, admission `typ`: never kept, stored or pushed), `TestLicenceRefusals` (`device_unclaimed`
waits, the claim report renews at once; `devices_allowed_reached` waits; `device_revoked` stops; control away then
back), `TestLicenceRuntimeWithoutEndpoint` (404, then the re-send), `TestLicenceRenewNow` (over the socket; the second
within a minute is 429 `busy`). All under `-race`.

## MG-38 A manager restart keeps the renewal schedule (2026-09-26; refines MG-34)

Control allows 12 `licence.renew` calls an hour per device (CL-41), and managers restart (updates, the harness's
update scenarios restart it several times an hour). The state file therefore also keeps `renewAt` (epoch seconds, the
manager's clock at acceptance + the jittered `renewAfterS`); at start the loop waits until then, at most 24 h (a
clock set back must not postpone renewal longer), and still hands the stored token to the runtime at once (MG-35). A
state without `renewAt` (written before MG-38) or without a token renews at start, as does a nudge after a claim
report. The file stays manager-private; `{v, token, highWater}` keeps LC-06's meaning. Test:
`TestLicenceRestartKeepsSchedule`.


## MG-39 The feedback drop's three socket paths (2026-09-27; Whombat FD-06, FD-21, FD-32, FD-33, FD-38; CT-91)
Superseded in part by MG-126 (HE-52): a control's 400 `bad_envelope` is no longer read as `unsupported`.

The broker serves `POST /v1/runtime/feedback/cards`, `/pull` and `/ack` (`local.ManagerPathFeedback*`, runtime uid
only, `manager/internal/broker/feedback.go`). Each checks the request against the contract schema, signs the matching
device op (`feedback.cards.sync`, `feedback.drops.pull`, `feedback.drops.ack`) with the management key through
`controlapi.Client.Forward`, checks control's answer against the response schema and returns it **as control sent
it** (no re-encoding). The manager holds no content key and never opens a card or an envelope; bodies are never
logged.

- **Sizes.** The runtime's request may be 4 MiB for a card sync (`FeedbackCardsSyncMaxBytes`), 64 KiB for pull and
  ack; above it the broker answers 413 `too_large`. Before sending, `Forward` computes the signed bytes and refuses a
  request above `device.DeviceRequestMaxBytesFor(op)` (`ErrTooLarge` → 413), so control never sees it. Control's
  answer is read up to 64 MiB for a pull (`FeedbackPullResponseMaxBytes`) and 1 MiB otherwise (`ErrAnswerTooLarge` →
  502); every other op keeps the 1 MiB it had. Schema validation of a maximal 43 MiB pull takes well under a second.
- **Timeouts.** 25 s for a card sync, 110 s for a pull, 8 s for an ack: each below the runtime's own socket timeout
  (30 s, 120 s, 10 s), so the runtime hears 503 and retries instead of timing out.
- **Answers.** Control unreachable, 5xx or 429 → 503 `unavailable` (as every op, `Retry-After: 30`); an older
  control's 400 `validation_failed`/`bad_envelope` and a control with the drop off (404 `feedback_drop_off`) → 501
  `unsupported` (FD-38); 409 passes through with control's reason as the code (`device_unclaimed`); a request above
  the limits → 413 `too_large`; anything else, and an answer that isn't the contract's → 502 `control_refused`. The
  broker never answers 404 on these paths: the runtime reads 404 as a manager older than 0.13 (unsupported).
- `fakecontrol` answers the three ops (modes `old`, `off`, `unclaimed`; recorded syncs, pulls and acks) for the
  broker tests.

## MG-40 `tufrepo`'s production mode: online-pilot custody (2026-09-27; PI-05, PI-11, MA-14; control HZ-15…HZ-21)

`release-tools` creates production keys only when asked for all of `--env prod --custody online-pilot --keys-dir DIR`
(`devtuf.Options{Env: "prod", Custody: CustodyOnlinePilot, KeysDir}`); any one of them alone, `env production`,
another custody or a relative keys dir is refused, and so is every command not marked `[prod]` in `tufrepo`'s header
(fake releases, single artifacts or tuples, assignments, holds, fixtures, expiry manipulation, development key files).

- **Keys.** One Ed25519 key per role (root, targets, snapshot, timestamp; the clients role's when it is added),
  threshold 1, in `--keys-dir`: a real directory (no symlink) owned by the caller, mode 0700, outside the repository
  directory (both ways, symlinks resolved; the repository is served). Files `<role>-<keyid[:16]>.json`, 0600, written
  with `O_EXCL` and fsynced before any metadata names them, never overwritten or deleted, carrying
  `{"development": false, "environment": "prod", "custody": "online-pilot"}`. `init` refuses a keys dir that holds
  any key file and a repository directory that holds a repository: there is never a second key set. Loading keeps
  only the keys the current root (and the clients delegation) names; a role without its key, a key file readable by
  others, a development key file or an `assignment` key file is refused.
- **Never mixed (MA-14).** A development repository refuses production options and production key files; a
  production repository (`state.json` `{"env": "prod", "development": false, "custody": "online-pilot"}`) refuses
  development options (“use --env prod --custody online-pilot --keys-dir DIR”) and development key files; a production
  root that trusts a development key (`trust.DevelopmentKeyIDs`) is refused at load and by `export-root`. An
  `AssignmentKeys` document of another environment than the repository's is refused (also in development now).
- **Expiry.** Root 120 days (`PilotRootExpiry`), targets 90 (every targets version gets the full 90 days in
  production), snapshot 7, timestamp 1, clients 21 (the runbook's values). `refresh` (the 6-hourly timer) always
  re-signs snapshot and timestamp, the clients role when it expires within 7 days and targets within 14; `status`
  (JSON: versions, expiries, releases, the assignment key document, warnings) warns 30 days before the root expires;
  `resign-root` publishes a new root version with the same keys and a fresh 120 days (devices walk to it).
- **Assignment keys.** A production repository holds no assignment private key (control does, MG-21): `init` publishes
  no `control/assignment-keys.json`; `set-assignment-keys --doc F` publishes control's own document
  (`GET /v1/assignment/keys`) after the CT-41 checks; `add-assignment-key`/`remove-assignment-key` work as in
  development.
- **Repository files.** Metadata is replaced atomically (temporary file and rename), so a client never reads half a
  `timestamp.json`; the production repository's directories are world-readable (the update server runs as a dynamic
  user); the lock file is a dot file, which the update server never serves.
- `export-root` prints the current `root.json` after checking it is signed by its own keys to threshold (and, in
  production, trusts no development key): the file a prod image pins (`manifest/prod/tuf-root.json`, PI-10).

Tests: `release-tools/devtuf/prod_test.go` (every refusal; keys and modes; expiries; control's key; the clients role;
a real-format release; the device's `trust.Refresh` with `Production: true` from the exported root, artifacts,
assignment keys and an assignment signed with control's key; the timer at 6 h, day 15 and day 80; the root warning and
a new device walking to a re-signed root after the first expired), `release-tools/cmd/tufrepo/main_test.go` (flag
combinations, prod-only and dev-only commands, the whole prod command sequence), and
`manager/internal/tufclient/remote_test.go` (runs only with `WB_TUF_REMOTE`: the manager's client against a live
repository, including a Range resume and the helper's view from the mirror; control `infra/hetzner/standin`).
Not built: production channel publishing (`clientchannel` stays development-only).

## MG-41 Real releases: `export-release` and `publish-release` (2026-09-27; PI-11, MG-09)
Superseded in part by UP-X23 (HE-52): release directories carry closure indexes only, no `nix-store --export` streams.

Until now every published release was a JSON stand-in (`FakeArtifact`). A real one is a release directory:

- `release.json` `{"v": 1, "releaseId", "tuple": ReleaseTuple, "artifacts": [{"target", "file", "meta": ArtifactMeta}]}`,
  one `nix-store --export` stream per artifact (`host.closure`, `runtime.closure`, `provider-<name>.closure`) and
  `SHA256SUMS`. Targets are `host/<version>/whombat-host.closure`, `runtime/<version>/whombat-runtime.closure`,
  `provider/<name>/<version>/provider.closure`.
- **`release-tools/nixexport`** reads an export stream without Nix: every path's NAR hash (`sha256:<hex>` of the NAR,
  checked equal to what Nix records), NAR size and references; `ClosureSize` is the sum of the NAR sizes of a path's
  closure (what `nix path-info -S` reports); `CheckComplete` requires every reference to be in the stream before its
  referrer (so `nix-store --import` succeeds on an empty store).
- **`export-release --template tuple.json --out R [--reuse-host]`** exports `nix-store --export $(nix-store -qR P)` for
  the host, the runtime and each provider, fills every `narHash` (the manager's from the host stream, which must
  contain it), sets `closureSize` and `managerStorePath`, validates the tuple (schema, `CheckActivation(t, t,
  schemaWrites)`) and writes `release.json` and `SHA256SUMS`. A `narHash` given in the template must match.
- **`publish-release --release-dir R`** trusts nothing in `R`: strict `release.json`; the tuple valid and
  self-compatible; plain file names and valid target paths, each artifact matching a tuple component by kind, version,
  store path and NAR hash; every file read once while it is parsed, hashed and copied into the targets tree under a
  hidden name, then checked (store path present, NAR hash, closure size, the manager inside the host closure,
  completeness) and only then renamed to its consistent-snapshot name before targets, snapshot and timestamp are
  signed. A component without an artifact in `R` must already be published (runtime-only releases reuse the host). The
  identical release again changes nothing (`alreadyPublished`); another tuple under a published id, or other bytes
  under a published target path, is refused; a refused publish leaves no release and no hidden files. Files are
  streamed, never held in memory.

Tests: `release-tools/nixexport` (synthetic streams, refusals, a real `nix-store --export` checked against Nix), and
`TestPublishReleaseRefuses` (edited hashes and sizes, traversal, unknown fields, id mismatch, incompatible tuple,
manager outside the host, missing component, incomplete closure, not a stream, same id with another tuple, same
target with other bytes, runtime-only reuse, template hash mismatch). End to end on control's stand-in host:
three real store paths with references exported, published by `deploy.sh release`, downloaded and verified by the
manager's client, then imported into an empty Nix store.

## systemd units (for the Nix agent)

```ini
# whombat-manager.service
[Unit]
After=network-online.target
Wants=network-online.target
OnFailure=whombat-manager-recovery.service
StartLimitIntervalSec=10min
StartLimitBurst=5
[Service]
Type=notify
NotifyAccess=main
ExecStart=${whombat-manager}/bin/whombat-manager --config /etc/whombat/manager.json
User=whombat-manager
Group=whombat-manager
SupplementaryGroups=whombat-admin          # access to /run/whombat/admin.sock (runtime socket, 0660)
Restart=on-failure
RestartSec=5s
WatchdogSec=120s
RuntimeDirectory=whombat-manager            # /run/whombat-manager (0750, group whombat-api)
RuntimeDirectoryMode=0750
Slice=whombat-manager.slice                 # reserved CPU/memory/IO (MA-12)
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/persist/manager
ProtectHome=yes
PrivateTmp=yes
CapabilityBoundingSet=
# whombat-manager-recovery.service
[Unit]
Conflicts=whombat-manager.service
[Service]
Type=simple                                 # the exec'd known-good may predate Type=notify changes
ExecStart=${whombat-manager}/bin/whombat-manager-recovery --config /etc/whombat/manager.json
User=whombat-manager
Group=whombat-manager
SupplementaryGroups=whombat-admin
Restart=always
RestartSec=30s
RuntimeDirectory=whombat-manager
ReadWritePaths=/persist/manager
NoNewPrivileges=yes
ProtectSystem=strict
# whombat-update-helper.socket
[Socket]
ListenStream=/run/whombat-update-helper/helper.sock
SocketUser=root
SocketGroup=whombat-manager
SocketMode=0660
DirectoryMode=0750
Accept=no
[Install]
WantedBy=sockets.target
# whombat-update-helper.service
[Service]
Type=simple
ExecStart=${whombat-update-helper}/bin/whombat-update-helper --config /etc/whombat/update-helper.json
User=root
StateDirectory=whombat-update-helper        # /var/lib/whombat-update-helper, 0700
# no Restart=; socket activation starts it; it exits after idleTimeoutSec
```

- The manager API socket `/run/whombat-manager/api.sock` is created 0660 by the manager; the directory's group
  must let the runtime user (`whombat`) and the backup user traverse it (group `whombat-api` containing both).
- `whombat-network-revert` (transient, created by the helper with `systemd-run`) runs
  `whombat-update-helper --config … revert-network-deadman` as root.
- Boot blessing: configure `nix.blessBootCommand` in the helper config (e.g. `systemd-bless-boot good`) once the
  pinned NixOS has boot counting (§10: upstream integration expected in 26.11; qualify a backport).
- Committed network config: the helper keeps it in `/var/lib/whombat-update-helper/network/committed.network`;
  the Nix module must copy it into `/run/systemd/network/` before `systemd-networkd` starts.

## Gaps reported (contracts / other workstreams)

Resolved in contracts 0.5.0: forward-repair state (CT-31), runtime facts for `status.report` (CT-37),
`checkActivation`/`updateClass` in Go (CT-35), the backup checkpoint API (CT-30), the manager extensions (CT-37).
Open:

1. `status.report.health.runner` has no source other than the runtime's own health; a runner probe (or a runner
   field in `RuntimeHealth`) would make it meaningful.
2. ~~`retired` keys with `notAfter: null` accepted~~ — resolved by contracts 0.5.1 (CT-41), adopted (MG-21).

## Open items (need a VM or hardware)

- The `nix` activator, `switch-to-configuration boot`, boot counting/blessing, the dead-man network revert,
  socket activation, `OnFailure=`/watchdog behaviour and `SO_PEERCRED` across real users run only in the NixOS VM
  tests (other agent). Unit tests cover argv construction and validation only.
- Real power loss (not just SIGKILL) during journal/cache writes, and firmware/TPM effects on boot fallback, need
  hardware qualification.

## MG-42 A failed claim.lookup over the other family is retried soon (2026-09-28; MG-32, CL-36; John's first prod box)
John's box from `pve-20260928.3` didn't appear on app.whombat.com/appliances/claim for about five minutes: its first
lease went over IPv4 and the one extra claim.lookup over IPv6 (MG-32) failed, because the VM's IPv6 address from
router advertisements wasn't up yet seconds after boot. MG-32 only repeated it with the next renewal (`renewAfterS`
300), and control lists a box for a browser on IPv6 only by the box's IPv6 tag (CL-36). Now a failed attempt over the
other family is repeated after `claimLookupOtherFamilyRetrySec` (default 30 s), at most ten times in a row, each time
as a full renewal; after that it rides along with the regular renewals as before. A network without the other family
costs ten extra renewals over five minutes. `TestClaimLookupOtherFamilyLate` covers it (the fake control refuses one
family until the test lets it through).

## MG-43 A migrating candidate is judged by the schema it migrates to (2026-09-28; CT-134, Whombat MD-12; HZ-28)
Production, 2026-09-28: box `wb-old0-prod-0001` on `pve-20260928.4` (runtime `2be6fc1`, schema 48 = `0047_delegation`)
quarantined `pve-20260928.5` (runtime `e8474971`, schema 49 = `0048_capabilities`, an `expand` whose floors are
`0047_delegation`) with `schema_incompatible`: `checkSchema` saw exit 10 (migration required) and then called
`CheckActivation(current, candidate, 48)` with the **pre-migration** version, and Whombat tuples read only their own
newest schema (`schemaReads {49..49}`, `compat.json` `runtime.readsFrom`), so `candidate_cannot_read_schema`. Behind it:
rollback judged by the tuples (`current.schemaReads ∋ candidate.schemaWrites`) is false for every new schema, so every
migration needed a verified checkpoint, and the box has no backup destination (`ErrUnprotected`): it would have waited
for ever although the runtime's own floors say a schema-48 binary reads and writes schema 49. No release carrying a
migration could install.

Now:
- **The runtime says what it migrates to.** `whombat schema-check --json` reports `target {version, readers, writers}`
  (Whombat MD-12): the schema its migration authority leaves and that schema's reader and writer floors, computed as
  the old binary's own check will compute them from the recorded rows. The helper passes it on
  (`proto.Schema.Target`, `proto.SchemaTarget`) only when complete and consistent (`0 ≤ readers ≤ writers ≤ version`);
  anything else counts as not reported.
- **Exit 10 is the proof the candidate migrates from the live schema**, so for a candidate that must migrate the
  manager calls `release.CheckMigratingActivation(current, candidate, dbSchema, {target, readers, writers,
  needsCheckpoint})` (CT-134): the candidate must read the **target** (and write it: `schema_target_mismatch` when the
  runtime's target isn't the tuple's `schemaWrites`), must not write below the live schema, and its host ABI must fit.
  Refused (12) and read-only (11) answers stay `schema_incompatible` as before; exit 0 keeps `CheckActivation`.
- **Rollback from the floors.** The installed runtime (schema `current.runtime.schemaWrites`) can write the migrated
  database when it is at or above the target's writer floor (`rollbackAccess` `read-write`, rollback-compatible), only
  read it at or above the reader floor (`read-only`: the rollback would end `rolled_back_read_only`), else `none` (a
  rollback would be forward repair). The floors decide even where the current tuple claims more. `SchemaPlan` keeps
  `target` and `rollbackAccess` next to `rollbackCompatible`.
- **A checkpoint only when it buys something**: for the migrations the runtime names (`needsCheckpoint`: contract and
  incompatible classes, MD-06) or when a rollback would not be read-write (the plan then checkpoints the pending
  migrations, as before). An `expand` (and a backfill whose writer floor stays below the installed schema) migrates
  without one, on a box with or without a backup destination.
- **No floors (a runtime before MD-12): today's behaviour**, `CheckActivation` against the pre-migration schema (so such
  a runtime that reads only its own schema is still refused), plus a checkpoint for migrations it names.
- **The known-good fallback uses the floors.** When the known-good binary's own schema check can't answer during a
  rollback and the deadline passed, `knownGoodAccess` takes the access from the candidate's reported floors
  (read-write for an expand) instead of the tuples (which said `none`: forward repair for every migration).

Managers before this one refuse any candidate whose runtime must migrate, whatever it reports: a box on one can't take a
migrating release. Production reinstalls its box from a release with this manager (John, 2026-09-28) instead of walking
it through the old manager; otherwise such a box first needs a host release without a migration (runbook `updates.md`,
“Releases that migrate the database”).

Tests (`manager/internal/update/migration_floors_test.go`; fixtures in `testworld`: runtimes that read only schema 11
and report floors, the fake database records the floors its migrations report and an older fake binary judges a newer
schema by them, as `evaluateSchema` does): an expand with floors migrates, activates and is healthy on a box whose
checkpoints fail, and no checkpoint is asked for; the same with an unhealthy candidate rolls back read-write (the
factory's health says read-write on schema 11, no checkpoint); a contract named by the runtime waits with the
checkpoint explanation, nothing changed, the plan says read-only, and migrates with the checkpoint once one can be
taken; floors past the installed runtime without a named contract still checkpoint (plan `none`); a runtime without
floors is `schema_incompatible` (`candidate_cannot_read_schema`, the production failure) and quarantined; a candidate
whose own check refuses a newer schema is `schema_incompatible`; the known-good check unavailable after the deadline
falls back to the floors (read-write, not forward repair). Helper: `TestParseSchemaTarget` (complete, absent, null,
partial and inconsistent targets). Contracts' `migrating` vectors run in Go through the vendored module. With the real
runtimes: `update-migration` (NX-103).

## MG-44 Nothing older is signed: `tufrepo` orders releases before it signs them (2026-09-28; UP-A3, MA-21c, NX-67, NX-105)
Devices refuse a tuple whose host, runtime or manager version is lower than the installed one's unless release
custody signed `allowDowngradeFrom` (MA-21c): a release signed older than the one before it strands every box it is
assigned to (known issue 1: `0.1.0-195421a` compared older than `0.1.0-e847497`). The signing step is the one place
every release passes, dev and prod, so it checks there.

- **The rule.** `publish-release` and `add-release` look at the published releases (`releases/<id>.json` targets) of
  the candidate's **id family**: `pve-YYYYMMDD.N` (prod) and `pve-dev-YYYYMMDD.N` (dev), ordered by day, then counter
  (NX-67). Other ids (the harness's `rt-…`, fixtures, fake releases) have no order and aren't compared;
  `add-fake-release` is never ordered. The newest release of the family (by id) must have no higher host, runtime or
  manager version (`trust.CompareVersions`, the devices' own order; equal is fine: a runtime-only release keeps the
  host and manager), and the candidate's id must sort after it. The check runs before any file is copied; a refused
  release leaves the repository as it was. The message names the component, both versions and that release:
  `refusing to sign pve-20260929.2: it is older than pve-20260929.1, the newest published pve release (runtime
  0.1.0-195421a < 0.2.0-…). Nothing older is signed (MG-44); a custody rollback names the release devices move back
  from: --allow-downgrade-from pve-20260929.1`.
- **Custody rollback.** `--allow-downgrade-from <id>[,<id>…]` accepts lower versions and writes the TUF-signed
  `custom.whombat.allowDowngradeFrom`; it must name the newest release (the one devices move back from; naming only
  others is refused, since boxes on the newest would refuse the release anyway). The id order is never waived: a
  rollback is a new release with a later id. A published release's permission can't change under its id (publishing
  it again with another list is refused; the identical publish is `alreadyPublished`).
- **Only the newest is compared.** After a custody rollback the next release is compared with the rollback, not with
  the release it undid; boxes still on that one refuse a release older than it (the helper's check), which is safe.
- **`check-newer`** runs the same check read-only, without keys or the repository lock, from `--tuple` (only the id and
  the three versions are read: a `nix eval` template before a build works, UP-C1) or `--id/--host-version/
  --runtime-version/--manager-version`, against `--dir` (a repository here; the prod flags as the other commands, the
  keys aren't read) or `--metadata-url` (a published one over HTTPS; no keys; `--env prod` alone refuses a root that
  trusts a development key). It verifies the chain itself (`devtuf.VerifyPublished`): root rotations from `--root` or
  else the repository's own `1.root.json` (trusted as found, and it says so under “not verified”), each signed by the
  root before it and by itself; the timestamp by the root's timestamp keys; the snapshot's version, length and hashes
  as the timestamp names them; the targets' version (and length/hashes when given) as the snapshot names it, signed by
  the targets keys. Expired roles are warnings: the question is what the repository signed. Exit 1 with the refusal
  on stderr when publishing would be refused.
- **`status`** lists `releases` as `{id, host, runtime, manager, allowDowngradeFrom}` in family order (was ids only).

Tests: `devtuf.TestCheckNewer` (the field's versions, both traps of the old scheme, ids, families, rollbacks),
`TestPublishReleaseOrdering` (a production repository: refused before anything changes, the rollback signed and
read by a device through `trust.Refresh` and `CheckForward`, the permission fixed per id), `TestVerifyPublished`
(rotations, a pinned root, expiry warnings, the committed fixtures refused as production, a foreign root, an edited
targets file), `tufrepo.TestCheckNewer` (CLI: dir, HTTP from its own root and a pinned one, prod flags, unbuilt
templates with empty or zero hashes).

## MG-45 Exit 0 is judged by the live schema's floors (2026-09-28; UP-B2, CT-135, MG-43, Whombat MD-12)
MG-43 used the floors only for a candidate that must migrate (exit 10). A candidate with nothing to migrate kept the
tuple-only `CheckActivation`, so release custody could never step a box back after an `expand`: the older runtime's
tuple reads only its own schema (`candidate_cannot_read_schema`) and writes below the database (`schema_downgrade`),
although its own schema check says `newer_compatible`, read-write (known issue 6).

Now `checkSchema` calls `release.CheckCompatibleActivation(current, candidate, dbSchema, {readers, writers})` when the
candidate's check answered exit 0 **and** reported the live schema's floors (`target.version` = the database's
schema: Whombat's `current` and `newer_compatible` answers). A candidate at or above the database schema gets
`CheckActivation`'s candidate checks; one below it activates when its own schema is at or above the writers floor,
is `candidate_read_only` between the floors and `candidate_cannot_read_schema` below the readers floor, never
`schema_downgrade` (nothing migrates down: the newer schema stays and is written compatibly); the rollback access is
the installed runtime's schema against the same floors; no checkpoint (nothing migrates on exit 0). Without floors (a
runtime before MD-12, or a target that isn't the live schema) `CheckActivation` as before. The forward check is
unchanged: the older release still needs the TUF-signed `allowDowngradeFrom` (MG-44), and control can't send a box
back without it. `knownGoodAccess`'s fallback uses the reported floors only for a plan that migrates (only a migration
attempt asks it); the other `CheckActivation` calls check a tuple against itself (`devtuf`, `trust.CheckCompat`).

Tests (`manager/internal/update/custody_rollback_test.go`, fake runtimes that read only their own schema and report
floors): factory 10 → schema 11 (floors 10/10) → schema 12 (floors 11/11) → a new release of the schema-11 runtime
with `allowDowngradeFrom` the installed release: plan `newer_compatible`, not migrating, rollback read-write, activated
and healthy on schema 12, no migration, no checkpoint (it failed `candidate_cannot_read_schema, schema_downgrade`
without this change); the same release without the permission is refused as a downgrade, nothing moved; after a
contract (schema 12's floors 11/12) the schema-11 runtime's own check answers read-only: `schema_incompatible`
`candidate_read_only`, nothing changed, quarantined. The VM case with real runtimes is agent G's (`update-migration`,
`custody-rollback`).

## MG-46 Failure detail reaches control as structured fields (2026-09-28; UP-E3, CT-137, HZ-28)
Superseded in part by MG-125 (HE-52): no fallback for a control before 0.22 (“Older controls” below).
Control only got a failure code (`schema_incompatible` on 2026-09-28), and an operator has no shell on the box. Free
text can't go out (paths, content: the device report allowlist), so the failure goes out as the fields its message
was made of (contracts `UpdateFailureDetail`); `describeUpdateFailure` renders it for the admin panel, `promote-prod`
and the owner.

- **The journal keeps them.** `Failure` gains `release` (the candidate: a quarantined failure still names it),
  `reasons` (the activation check's, `protocol_no_overlap` until MG-131, or for a refusal by the candidate's own check
  `candidate_read_only` / `candidate_cannot_read_schema` / its verdict; the cause of a forward repair; a failed
  migration's error kind and verdict when they are idents), `schema` (`database`, `target` — set only when the
  candidate was judged at the schema it migrates to, i.e. exit 10 with floors; null otherwise, so the incident
  renders “it reads schema 49 only and the database is at 48” —, `candidateWrites`, `candidateReads`),
  `failedChecks` (the contract's check names from the last evidence of an `unhealthy` or `known_good_unhealthy`
  rollback; `boot` for `boot_fallback` and `reboot_timeout`) and `rollbackAccess` (the plan's for a schema refusal, the
  known-good's after a rollback or guard, `none` for forward repair). A rollback in progress carries its failed checks.
  `update.FailureDetail(st)` builds the contract value for the failure the record reports (the candidate's, a
  rollback in progress, or the last failure while not healthy), keeping only idents; nil for a journal from before
  (no release to name) or no failure. `Message` never leaves the box.
- **Reports.** `status.report` sends `update.failureDetail` and `runtimeVersion` (the current tuple's runtime),
  `update.progress` its `failureDetail` (through the outbox).
- **Older controls.** A control before 0.22 validates device bodies strictly and answers `400 validation_failed` to
  these members. `controlapi.Client.Status`/`Progress` then send the report once more without them, and every later
  report goes without them for the life of the process (`OnLegacy` logs once: “control predates contracts 0.22 …”); a
  manager started after control's update sends them again. A 400 for a report without them is the caller's, as before.

Tests: `update.TestFailureDetailOfASchemaRefusal` (the 2026-09-28 failure, before and after quarantine; a refusal by
the candidate's own check), `TestFailureDetailOfARollback` (during and after, then nothing once healthy),
`TestFailureDetailOfABootFallback`, each validated as a strict device body; `controlapi.TestReportsToAnOlderControl`
(fake control `OldReports`: one refusal, then stripped; plain reports pass); `daemon.TestFailureDetailReachesControl`
(a new and an old control through the running daemon).

## MG-47 The owner's update facts: the detail, what an update waits for, the last update (2026-09-28; UP-E4, CT-138)
`UpdateFacts` (the runtime's `appliance.status`, Settings → This Whombat) gains `failureDetail` (MG-46's),
`waiting {reason, since, blockers}` and `lastUpdate {release, from, at}`. `waiting` comes from the candidate's
deferral while it is `Staged` or `WaitingForSafeBoundary`: the reason (`boundary` — also when only running work is
recorded —, `checkpoint`, `window`, `hold`, `lock`, `metadata`), when the candidate started waiting, and the running
work counted by kind (kinds that aren't idents count as `other`; the blockers' descriptions stay on the box).
`lastUpdate` is persisted in the journal (`State.LastUpdate`) when a candidate becomes the healthy current release:
the release, the one it replaced, when; it survives restarts, rollbacks and later failures, and a factory install has
none. Tests: `broker.TestUpdateFactsTellTheOwner` (waiting with two turns, healthy with the last update, a failure
with its detail and the last update unchanged, after a restart), `update.TestWaitingOf` (boundary, checkpoint, hold).

## MG-48 Facts to a runtime before contracts 0.22 (2026-09-28; UP-X06, MG-47)
Superseded by MG-127 (HE-52).
A host release can keep an older runtime, and a runtime before 0.22 validates the facts push strictly: it answers 400
to MG-47's members and the owner would see no update or backup facts at all. `runtimeapi.Client.SendFacts` then pushes
once more without them, and keeps pushing without them while the same release is current (its runtime); when another
release is current its runtime gets them again (one refused push per such release). `OnLegacyFacts` logs once per
release. New runtimes decode facts tolerantly (Whombat, agent R), so both ends cope. Test:
`broker.TestFactsToAnOlderRuntime` (fake runtime `OldFacts`: one refusal, then stripped; a later release's runtime
gets them).

## MG-49 The helper's version order is the contracts' (2026-09-28; UP-A2, CT-135, NX-105)
`trust.CompareVersions` (the forward check, MA-21c) calls `release.CompareVersions`: the code was identical, and control
(`notOlder`, UP-X03) and the clients now use the same order. The contracts' `versions` vectors run against the helper's
name too. The transition to NX-105's versions is proven over every release tuple in the field
(`helper/pkg/trust/testdata/field-versions.json`: the tuples of `~/.cache/whombat-releases/*`, the DEV TUF repository
and the fixtures, recorded 2026-09-28): the first runtime and manager of the new scheme (earliest commit time, patched,
labelled and dirty forms, and the dev builds' `0.2.0-0.dev`) compare newer than every recorded one, in the order
`0.1.0` < `0.2.0-0` (control's manager floor) < `0.2.0-0.dev` < `0.2.0-<commit time>.<rev>` (UP-X09); host ids order by day then counter; every
recorded box takes a new host release and a runtime-only release on its own host through `CheckForward`, and going back
is refused. The fixtures (`rt-fixture-1`: host `26.05.1`, runtime `1.0.0`) are another scheme used only in VM tests
and are not compared. No `allowDowngradeFrom` is needed for the transition.

## MG-50 Signing checks the id, the version forms and the family's highest versions (2026-09-28; security review 2; MG-44, NX-67, NX-105)
Findings on MG-44: ids outside the families (`hotfix-1`, a typo like `pve-2026092.1`) and `pve-dev-…` were signed
into the production repository without any ordering; the candidate was compared with the newest release only, so a
version below an earlier release's (the text trap: `.5`'s runtime `e847497` above `.6`'s `195421a`) passed; a
`--allow-downgrade-from` could name a release not published yet; a `+` or an over-long number made a version
unorderable. Now `CheckNewer` takes the repository's mode (`NewerOptions`):

- **Ids.** A production repository signs `pve-YYYYMMDD.N` only (`ErrReleaseID`). A development repository signs
  `pve-dev-YYYYMMDD.N` (ordered) and ids of no family (fixtures, harness and VM-test releases, not ordered), never a
  production id or an id that starts with `pve-` and isn't one of the family. `check-newer --metadata-url` takes the
  mode from `--env`.
- **The family's highest versions.** The id must still sort after the newest published release of the family; each of
  the host, runtime and manager versions must be at or above the **highest** one among all published releases of the
  family (the newest release carrying it is named: `runtime 0.1.0-0abc123 < 0.1.0-e847497 of pve-20260928.5`).
  `Ordering.Highest` reports them; `check-newer` prints them.
- **Permissions.** Every `--allow-downgrade-from` id must be a published release the candidate is older than in at
  least one component (`ErrPermission`: no permission for a future id or for a release it doesn't undercut), and the
  list must include, for every component the candidate undercuts, the release holding the highest version.
- **Version forms.** A host, runtime or manager version with a `+` (the rest is build metadata, ignored in comparisons)
  or an all-digit part of more than 19 digits (beyond uint64 it compares as text, above every commit time) is refused
  (`ErrVersionForm`); 19 digits are accepted.
- **Fresh metadata over a URL.** `check-newer --metadata-url` fails (`trust.ErrExpired`, exit 1) when the root,
  timestamp, snapshot or targets it reached has expired, as a device would; `--dir` (a repository here, re-signed on
  publish) still only warns. The pipeline always passes `--root` with the pinned root.

The build side of the version forms is in `flake.nix` (NX-105): a release runtime's package.json must be a plain
`MAJOR.MINOR.PATCH` (≤ 19 digits each), the appliance semver too, and a release runtime version never has a `+`.
Tests: `devtuf.TestCheckNewer` (highest across the family, permissions for future or older releases, ids in both
modes, version forms), `TestPublishReleaseOrdering`, `TestVerifyPublished` (an expired timestamp with freshness
required), the production repository tests on `pve-` ids, `tufrepo.TestCheckNewer` (expired over HTTP, production ids).

## MG-51 Exit-0 floors are used only when they can be the live schema's (2026-09-28; security review 2; MG-45)
`liveFloors` takes the floors of an exit-0 schema check only when `0 < readers ≤ writers ≤` the database's schema (and,
as before, the target is the database's schema); anything else is ignored and `CheckActivation` decides. A runtime
reporting floors of 0 or above its own database can't make an older candidate look compatible.
Test: `update.TestLiveFloorsOnlyWhenConsistent`.

## MG-52 An older control is asked again after 6 hours (2026-09-28; security review 2; MG-46)
Superseded by MG-125 (HE-52).
After a control before 0.22 refused the new report members, MG-46 left them out for the life of the process, so a
control updated meanwhile got no failure detail until the manager restarted. Now they are left out for
`controlapi.LegacyRetry` (6 h) after the last refusal; the next report then goes in full, and a refusal starts another
6 hours (`OnLegacy` logs the first time only). Control's version isn't known cheaply (no answer carries it), so the
interval is the only trigger. Test: `controlapi.TestReportsToAnOlderControl` (refused again after 6 h, then the
updated control gets the detail).

## MG-53 Why an update waits reaches control (2026-09-29; operations review; CT-147, MG-47)
Superseded in part by MG-125 (HE-52): no old-control fallback strips `waiting`.
Operators couldn't see that a box waited, e.g. for a backup destination before a contract migration: control only
had the journal state. `status.report` now carries `update.waiting` and `update.progress` `waiting`
(`device.UpdateWaitingReport {reason, since}`, contracts 0.22.4) whenever the candidate is `Staged` or
`WaitingForSafeBoundary` with a reason (`boundary`, `checkpoint`, `window`, `hold`, `lock`, `metadata`;
`update.WaitingReport`, the same decision as the owner's `UpdateFacts.waiting`). Codes and a time only: the blockers
stay on the box. Every persisted change of the wait is a progress report. The old-control fallback (MG-46, MG-52)
strips `waiting` with the other 0.22 members, also when it is the only one. The fake control's status interval is
configurable (`NextReportS`) so the daemon tests see more than the first report. Tests:
`daemon.TestWaitingReachesControl` (a checkpoint wait at a new and an old control), `controlapi.
TestReportsToAnOlderControl`, `update.TestWaitingOf`.

## MG-54 Retryable failures never quarantine a release (2026-09-29; operations review; CT-147)
The retryable codes (`release.IsRetryableUpdateFailure`: `no_space`, `not_assigned`, `not_staged`, `boundary_lost`,
`checkpoint_stale`, `checkpoint_required`, `activation_deferred`) count no attempt, so `failed()` never quarantined
for them; `failed()` and the rolled-back retry now also check the code, so an attempt counted by mistake can't
either. One path did quarantine: a retryable failure **after the migration ran** (e.g. the helper unreachable, so the
activation was deferred) whose known-good release can't use the migrated database went to forward repair, which
quarantined the candidate locally — the one release that runs on that database, so control's “Retry this Whombat”
(a new assignment of it) was refused. `forwardRepair` now quarantines only when the cause isn't retryable; the state
is still `ForwardRepairRequired` (with the cause as the detail's reason and a message that says the release isn't
quarantined), and assigning the same release again leaves it: its check then says `current` and it activates.
Tests: `update.TestRetryableFailuresNeverQuarantine` (each code from `Failed` and `RolledBack` at the attempt limit;
`download_corrupt` still quarantines), `TestForwardRepairForARetryableCauseKeepsTheRelease` (the helper stops after the
migration; forward repair without quarantine; assigned again, healthy on the migrated schema).

## MG-55 A failing rollback step backs off; a host candidate's deadline is the replaced manager's (2026-09-29; agent G's upgrade gates; MG-06, MG-07)
The upgrade gates (NX-110…) showed a host rollback whose helper step kept failing retried every `retryBaseMs` (5 s
there) for ever: `rollingBack` answered every helper error with `backoff(1)`. Now a failing rollback step — the
runtime rollback, activating the known-good host generation, blessing its boot — is retried after
`RollbackRetryBase` (5 s), doubling up to `RollbackRetryMax` (10 min), never given up (it is the way back to
known-good). The count and the next try are in the journal (`Rollback.StepFailures`, `NextStepAt`), so a manager
restart — or the recovery manager taking over — doesn't start a tight loop; each attempt logs once; a step that
succeeds clears them. The journal state doesn't change (`Activating`/`Verifying` with the rollback in progress); the
failure detail of the rollback in progress carries the reason `rollback_retrying` (MG-46), and every attempt is a
persisted note, so control sees it. `RollbackRetryBase/Max` and `HostRebootTimeout` are policy overrides
(`policy.rollbackRetryBaseMs`, `rollbackRetryMaxMs`, `hostRebootTimeoutMs`; production leaves them unset).

**A host candidate's verify deadline is set at activation by the manager being replaced**: `HostRebootTimeout` (20 min)
+ `VerifyTimeout` (10 min), so an unhealthy host release rolls back about 30 minutes after activation in production
(one that doesn't boot is caught at once by boot counting). The new manager only reads the deadline from the journal:
this is intended — the new manager may be the broken part, so the time a host candidate gets must not depend on it,
and if it fails outright the known-good recovery manager rolls back. The reboot timeout is configurable now (it was
fixed), for VM tests and slow hardware; production keeps the defaults. Documented in `docs/runbooks/updates.md`
(“Host releases: how long before a bad one rolls back”).

Test: `update.TestFailingHostRollbackBacksOff` (a host candidate unhealthy, the known-good activation failing: 5, 10,
20, … 320, 600, 600 s; the state `Verifying` with `rollback_retrying`; a restarted manager waits out the persisted
backoff; the step works again and the box is back on known-good, healthy).

## MG-56 A release that failed after activation is retried only when control assigns it again (2026-09-29; DEV proofs, pve-dev-20260929.3; MG-06, MG-07)
The DEV box got a runtime-only release whose server threw at start: the manager rolled back correctly and control paused
the rollout (`device_failed`), but the manager then retried the same release by itself (`steady()` → `resetForRetry`
after `RetryBase`, up to `MaxAttempts` 3) before it had control's answer. Each retry is another outage for the owner:
runtime, database and sessions down for a verify window.

Now a rollback that ran in `Verifying` — the candidate was activated: it failed its checks (`unhealthy`,
`known_good_unhealthy`, `rolled_back_read_only`), didn't boot (`boot_fallback`) or didn't come up in time
(`reboot_timeout`), or the manager died while verifying it (`manager_recovery`) — marks the failure `afterActivation`
and counts it per release (`State.VerificationFailures`, by tuple digest, kept across candidates, cleared when that
release becomes healthy or is quarantined). Such a candidate is **never re-activated from local state**: in `RolledBack`
it waits for control. Only a new install assignment of that exact release after the failure (an operator's
`device retry`, “Retry this Whombat”; also one that arrived while the rollback ran) marks it `reassigned`; it is then
retried once `VerifyRetryDelay` (30 min) since the failure passed, and quarantined at `MaxVerifyFailures` (2) such
failures. Control holds a device that failed or rolled back a release (`failed_before`) and pauses the rollout, so
normally its answer is a hold, or nothing new, and nothing retries; the box's normal poll fetches it (no local retry
can race it, since none happens without a new assignment). An assignment of another release starts as before.
Failures before activation (download, staging, schema check, safe boundary, activation failing before the candidate
ran) keep the attempt-count policy (`NextRetry`, quarantine after `MaxAttempts`). `VerifyRetryDelay` and
`MaxVerifyFailures` are `Policy` fields (defaults 30 min, 2).

The fix reaches a box only with the next host release: a box runs the manager of its host generation (John's PROD box
ran `…dbbadbe` when this was found).

Tests: `update.TestVerificationFailureRetriedOnlyWhenControlAssignsItAgain` (rolled back; 12 h without an assignment
and with control's hold: no re-activation, one attempt; control assigns it again: retried after the 30 min, quarantined
at the second failure, refused afterwards), `TestVerificationRetryWaitsThirtyMinutes` (a host candidate that didn't
boot, assigned again at once: retried 30 min after the failure), `TestFailuresBeforeActivationStillRetryByThemselves`
(a schema refusal: retried by the box, quarantined after 3 attempts). The crash and kill matrices of the bad-runtime
rollback and the host boot fallback now end rolled back and waiting for control (`testworld.AwaitsControl`).

## MG-57 A host rollback to a runtime-only known-good boots the host its tuple names (2026-09-29; upgrade gates, gate 4; MG-20, L-2)
Gate 4 of the upgrade gates, from the PROD box's starting point (`pve-20260929.2`, a runtime-only release on
`pve-20260928.7`'s host): a host candidate installed, rebooted and failed verification; the rollback asked the helper
for `activate-host-on-reboot pve-20260929.2`. The helper resolved a release to activate without an assignment only
among its **host** records (`Host.Current/Previous`: the candidate and `.7`); a runtime-only release lives in its
**runtime** records, so the request fell through to the assigned-release path, `not_assigned` (the assignment names
the candidate), and the rollback retried for ever (MG-55) while the box stayed on the bad candidate. The same happened
to the manager's alignment after a boot fallback (`reconcileHost`) and to the recovery manager's rollback.

The fix is in the helper, the component that decides what may be activated: `activateHost` resolves the target with
`recordedHostTarget`, which also takes a runtime record (`Runtime.Current/Previous`) of that id whose host is a
recorded host (`Host.Current/Previous`) or the booted system. That record was written when the helper activated the
release — after TUF verification, the assignment and the check that the booted host is the one its tuple names — so
it is the known-good's own tuple: the host generation the release before it installed (its store path, recorded
under that release) with the known-good runtime and providers. Nothing else changes: the target still goes through
`undoAllowed` (only undoing an unfinished activation or aligning with the booted host, never a release fresh metadata
shows withdrawn), every store path must be present, and a release the helper never activated still needs a verified
assignment. After the reboot the known-good record becomes `Host.Current`; its manager is the same (a runtime-only
release names its host's manager), so the recovery manager's known-good manager doesn't change. The manager needed no
change: it names its known-good release, which is right.

**What protects boxes from before this fix.** The helper that serves a host rollback is the booted system's. A
candidate that boots is rolled back by its own helper — the fix only has to be in the host release that is installed
(and the old known-good recovery manager, if the new manager is the broken part, asks that same helper). A candidate
that doesn't boot is caught by **boot counting**, which falls back to the old host generation: the host is protected,
but that host's old helper and manager still have the bug, so the rollback retries for ever, the runtime profile keeps
the candidate's runtime (switched before the reboot), and new assignments queue behind the unfinished rollback; the
box needs a manual repair or a reinstall. Hence the first host release to the PROD box must be proven to boot from
its exact release (gate 1 against the real PROD release, the DEV box), and should keep the box's runtime, so a failed
boot still leaves it serving on its known-good runtime.

Tests: `ops.TestHostRollbackToARuntimeOnlyKnownGood` (runtime-only rt-2 on the factory host, host candidate rt-3
booted and not blessed, no metadata: back to the factory host with rt-2's runtime, blessed, recorded as the current
host, the known-good manager unchanged), `ops.TestHostRollbackToARuntimeOnlyReleaseStaysStrict` (an unrecorded
release still needs its assignment; after the candidate was blessed and the window passed, moving back is refused),
`update.TestHostRollbackToARuntimeOnlyKnownGood` (the manager and the real helper: an unhealthy host candidate and one
that doesn't boot, both back on the factory host with rt-2's runtime, then a good host release installs); both fail
without the fix. Existing rollback tests unchanged.

## MG-58 Contracts 0.25.0 and the fourth feedback path: `POST /v1/runtime/feedback/reporters` (2026-09-30; Whombat feedback-reporters §4, CT-160…CT-165; MG-39)

The manager vendors contracts 0.25.0 (Go module `contracts-v0.25.0` @ `ca35f25`, tree `0093d1c` = the release's
`reproducible.trees.go`; the harness's TypeScript packages the same release, replacing 0.22.4). Nothing in the
manager needed a change for the jump; `vendorHash` is the NAR hash of `go mod vendor` (the method reproduces the old
hash for the old tree, so no image build was needed to find it).

The runtime publishes its signed-in reporters' report statuses (managed drop mode, CT-164) through a fourth socket
path, `local.ManagerPathFeedbackReporters` (`/v1/runtime/feedback/reporters`, runtime uid only), which signs
`feedback.reporters.publish`. It is one more `feedbackRoutes` entry and works like MG-39's three:

- **Request.** Checked with `local.ParseRuntimeFeedbackReportersRequest` (= the op's strict schema: ≤ 100 updates,
  ≤ 100 removals, patterns, the status enum, times ≤ 4102444800); anything else is 400 `bad_request` and never
  forwarded. The body limit is derived from the contract, not picked: `feedbackReportersMaxJSON` is the compact JSON
  of the largest body the schema allows (`FeedbackReportersPublishMax` updates and removals, every member at its
  longest: 26 326 bytes today), computed from the Go types at start-up; the runtime may send **twice** that (52 652
  bytes: room for indentation or another spelling of the same values), above it 413 `too_large`. The request
  control gets is `Forward`'s compact re-encoding, well below `DEVICE_REQUEST_MAX_BYTES` (64 KiB; the op has no size
  exception).
- **Answer.** `{"ok":true}` checked with `ParseRuntimeFeedbackReportersResponse` (tolerant, as the contract
  defines it) and returned as control sent it; read up to **4 KiB** (control's answer or an error body; a 2xx
  above it is 502 `control_refused`, an error body is truncated, which only loses the reason of a non-JSON page).
- **Timeout.** 8 s, like an ack: the runtime's socket client waits its default 10 s for this path, so it hears 503
  and retries rather than timing out.
- **Refusals.** MG-39's mapping unchanged: a control before 0.25 answers the unknown op 400 `validation_failed` /
  `bad_envelope` (its `DeviceRequestEnvelope` enum lacks it) → 501 `unsupported`, as does 404 `feedback_drop_off`;
  409 passes with control's reason (`device_unclaimed`); unreachable, 5xx, 429 → 503; retired → 502. Never 404 (a
  manager before this change answers 404, which the runtime treats like 501).
- **The pull keeps `drop.reporter`.** The pull answer was already passed on byte for byte and only validated; with
  0.25 `FeedbackDrop.reporter?` (`{id, emailDigest}`) is part of the schema and of the Go type (`omitempty`), so an
  attested drop reaches the runtime unchanged, an anonymous one has no member, and a malformed attestation makes the
  answer 502 `control_refused` like any answer that isn't the contract's. The manager never checks the digest (it
  holds no address); the runtime does.
- **`fakecontrol`** answers the op (modes `old`, `off`, `unclaimed` and `FeedbackAnswer` apply as to the other
  feedback ops), records each request (`FeedbackPublishes`) and keeps what control would serve
  (`FeedbackReporters`, keyed `site/reference`, read with `ReporterEntries()`): an update replaces an entry unless
  the held `updatedAt` is newer (equal overwrites), a removal deletes. It treats every site as the device's own
  (control skips others silently). Its `FeedbackDrops` carry `Reporter` for pull tests.

Tests (`manager/internal/broker/feedback_test.go`): `TestFeedbackReportersForwarded` (forwarded and applied, newer
wins, removals, both lists empty, the maximal body compact and indented, 413 above the derived limit, seven shapes
that aren't the contract's never reach control, three answers that aren't the contract's or are above 4 KiB → 502),
`TestFeedbackPullKeepsReporter` (the attestation survives the typed fake and control's raw bytes pass unchanged, an
anonymous drop has none, a malformed one is 502), and the reporters path joins `TestFeedbackRefusals` (old / off →
501, unclaimed → 409) and `TestFeedbackRuntimeOnly` (a lock holder gets 403, nothing reaches control).

What the harness step needs (candidate 0.22.0): `o-feedback` runs against the real control, so the fake is for
the Go tests only; the scenario reads the published statuses from control (`GET …/reporter/reports` with the
reporter's bearer, or control's `feedback_reporter_reports` rows) and the attestation from the filed report
(“Email verified”). The old-control path is covered here (a control on contracts < 0.25 → 501, the runtime keeps
filing reports).

## MG-59 Closure indexes: what the build spec left open (2026-10-02; delta updates, UP-X14…UP-X17; MG-03, MG-09)
`docs/implementation/delta-updates/spec.md` §1 left these to the implementation; decided so:

- **Request and response bounds.** `missing-paths` carries up to 65,536 store paths, so its request line may be up to
  16 MiB; every other op keeps the 1 KiB bound (`DecodeRequest` refuses a line over 1 KiB unless the op is
  `missing-paths`). The response bound (manager side) is 16 MiB for every op. The answer is `Result.missing` (request
  order), not `storePaths`, so the field keeps one meaning. The helper validates every path (`trust.ValidStorePath`)
  and calls `nix-store --check-validity --print-invalid` in batches of 256 (argument length); it keeps only printed
  lines that are paths it was asked about (stderr warnings share the output).
- **The export frame lives in `helper/pkg/narframe`**, not in `release-tools/nixexport`: the helper's binary must not
  depend on the release tools (`server.TestHelperDoesNotImportManager`). `nixexport.WriteFrame` delegates to it. A frame
  of a real path is byte-identical to `nix-store --export` of it (checked on this machine against two store paths).
- **Pass 2 checks again.** The NAR fed into `nix-store --import` goes through `trust.CheckingNarReader`: at its end it
  checks size and hash once more and, if they differ, fails instead of ending, and the frame (whose trailer — path,
  references, deriver — follows the NAR) is never completed, so `nix-store --import` adds nothing. One path per
  `--import` (no batching): a few hundred missing paths cost seconds.
- **Index artifacts in `trust.Artifact`.** An index target is an `Artifact` with `Index *IndexMeta` and `Meta` carrying
  the component (`format: closure-index`, `closureSize: 0` — the blobs count the unpacked size); a blob is an
  `Artifact` with `Meta.Kind nar-blob`, `format nar-zstd`, `closureSize` = its NAR size. `Release.Artifacts()` lists
  every TUF target of the release (legacy and index; for an old release exactly as before), `Release.Delivery(host)`
  the one each component is delivered through, `Release.Units(host)` both per component. A component is found by store
  path, so a release reuses another release's index or closure of the same store path (as for closures before).
- **The plan runs in Assigned and Downloading.** Assigned downloads the indexes it needs (small), asks `missing-paths`
  and checks the space; Downloading plans again and downloads. A corrupt or unparseable index fails like a corrupt
  download (`download_corrupt`, counts an attempt); an unreachable helper or repository is retried. The log line is
  written in Downloading.
- **Old managers and journals.** `trust.Release` gains fields with `omitempty`; a journal from an older manager has none
  (legacy units) and a recovery manager older than 0.3.0 ignores them (non-strict decoding).
- **`nar-list` needs no production flags** (read-only, keyless, no lock); it accepts them. `features` takes no flags.
- **The API's zero value stays `full`.** `devtuf.ExportOptions{}` (tests, any caller without `Closures`) writes legacy
  streams only; the CLI default is `both` as specified.
- **Fixture NARs** are `"nar:" + content` (`devtuf.FakeNar`), so a fixture path has the same NAR hash
  (`sha256("nar:"+content)`, as before) whether delivered through a closure or an index; the fake activator stores the
  content without the prefix. Fixture indexes add a shared library path (`devtuf.FakeLibPath`) to every closure.
- **Publishing verifies blobs in parallel** (up to 8 workers) and copies them into the repository (tmp + rename; no
  hard links: a repository blob must not share an inode with a build machine's cache). It recomputes the index
  metadata's `paths` and `downloadSize` from what it signs. A blob that doesn't decompress to its listing's NAR stays
  out; blobs written before a later refusal stay (content-addressed) and are reused by the next publish.

Tests: `trust.TestParseClosureIndex`, `TestVerifyNar`, `TestReleaseWithIndexes`; `devtuf.TestExportPublishClosureIndexes`,
`TestPublishRefusesBadIndexes`, `TestParsePathInfoJSON`; `ops.TestStageThroughIndex*`, `TestMissingPaths`;
`update.TestIndexReleaseDownloadsOnlyMissingBlobs`, `TestMixedReleasePrefersIndex`, `TestHostReleaseThroughIndex`,
`TestIndexDownloadCrashReplans`, `TestIndexCorruptBlobRefused`; `activator.TestNixInvalidPathsBatches`,
`TestNixImportNarFrame`; `proto.TestMissingPathsRequest`.

## MG-60 Staging is pruned after an update (2026-10-02; UP-X14, MG-59)

When a candidate becomes Healthy (the known-good and current tuples are persisted), the manager removes every staged
file no tuple keeps (`keepSet`: current, known-good, previous known-good and a pending release's closures and indexes):
the closure index's blobs are imported by then, and older closures and abandoned partial downloads are of no use. Before,
staging was only cleaned when the next update didn't fit (`EnsureSpace`), so a box kept every blob it ever downloaded.
Best effort: a failure to remove a file changes nothing else. Test: `tufclient.TestPruneKeepsOnlyKept`.

## MG-61 status.report follows update transitions (2026-10-02; UP-X14, CL status interval)

Measured on the DEV box (its journal, read from a ZFS clone of its disk): `pve-dev-20261002.3` went from Assigned to
Healthy in 2 min 7 s including the reboot, `pve-dev-20261002.4` (runtime-only) in 52 s, yet `release/ship publish-dev`
reported Healthy after 14.5 and ~14 minutes. The box's update.progress reached control at once (rollouts use it),
but control's device record — what `publish-dev`, the admin panel's device view and `dev/devbox status` read — is
status.report, sent 5 s after the manager starts and then every `nextReportS` (control: 900 s). The Healthy of an update
waited for the next one.

Now every persisted transition also asks the status loop for a report, sent 3 s later (`Waits.StatusSettle`, so a step's
transitions are reported once) with the journal's state at that moment; the periodic report is unchanged. While the
runtime has never answered since the manager started, the loop retries every 15 s instead of waiting a whole interval.
`release/ship publish-dev` follows the rollout's per-device progress (`GET /v1/operator/rollouts/<id>/devices`) as well,
so boxes with older managers are seen at once too, and polls every 10 s. Test: `daemon.TestStatusReportFollowsTransitions`
(fails without the change: the device record still shows the previous release an hour later).

## MG-62 Control and the runtime away: INFO while it is short, one WARN when it lasts (2026-10-10; DEV box health check)

Read on the DEV box (`whombat-dev-box`, 2026-10-10): `level=WARN msg="control poll failed; the installed release keeps
running" err="control unavailable: control HTTP 502…"` at every restart of the dev control plane (six in three days,
each fixed a minute later), and `runtime facts unavailable for status.report … dial unix /run/whombat/admin.sock:
connect: no such file or directory` 2–3 s into every runtime activation (MG-61's report after the transition lands
while the runtime restarts). Neither needs anyone; both read as problems. The second was never cleared either: a later
outage with the same error was not logged at all.

Now `daemon/outage.go` tracks one outage per dependency, **control** and **the runtime**. The first failed call opens
it; any successful call to the same dependency ends it.

- **INFO** for each call's first failure in the outage, and again when its error changes (`for=` how long the
  dependency has been away, after the first line).
- **One WARN** per outage, at the first failure once it has lasted **10 minutes** (`for=…`), never while the outage is
  expected: the runtime while the journal is `Activating` or `Verifying` (an activation, or a rollback inside one,
  restarts it; a host activation reboots before Verifying).
- **INFO when it answers again**: `control answers again after=1m12s`, `the runtime answers again after=8s`.

Control's calls: the poll, status.report and update.progress, and only failures that are `controlapi.ErrUnavailable`
(network, 5xx, 429): a refusal, an assignment that doesn't verify or expired TUF metadata stays a warning at once
(`warnOnce`, as before). The runtime's: `GET /facts` for status.report and the facts push; runtimeSyncLoop's health
probe (every 10 s) ends a runtime outage and keeps an open one going, so a runtime that stays away warns on time, but a
failed probe alone opens none (the runtime starting after the manager at boot stays silent, as before). The other
warnings (TUF, claim.lookup, licence, runtime sync) are unchanged. Nothing on disk changes; the state is in memory, so
a manager restart starts afresh. Tests: `daemon.TestOutageLogLevels`, `TestExpectedOutageIsNoWarning`,
`TestRestartingPhases`, `TestRoundAway` (a fake clock), and `TestShortControlOutageIsInfo` (the real loops against the
fake control answering 503: INFO, no WARN, and the INFO when it is back).

## MG-63 The manager measures the box every 10 seconds (2026-10-11; Whombat `docs/decisions/box-status.md` BS-02, CT-334)

*Since NX-455 (2026-10-25) a box has no computers: no Incus container cgroups and no `wbc…` bridge, so the computers'
memory is null and their traffic nothing; the qgroup 1/101 that `computers` reads holds the agent's containers' storage
now (NX-458). The code still names and measures them as below.*

John asked to see how his appliance is doing (processor and its history, disk space, bandwidth, data sent and received
today). The server is sandboxed without `/proc`; the manager sees all of it, survives runtime updates and already
answers the runtime, so it measures (BS-02). The contracts are 0.78.0 (`contracts-v0.78.0` @ `9a2c834`, tree `79ce8ea`
= the release's `reproducible.trees.go`; `vendorHash` updated); nothing in the manager needed a change for the jump
from 0.51.0. The new package `manager/internal/hostmetrics` runs as the daemon's loop `host-metrics` (normal and
recovery mode). Every source takes a root (`/proc`, `/sys`) so the tests read fakes:

- **Processor:** `/proc/stat`'s aggregate line between two readings, busy = everything but idle and iowait (guest and
  guest_nice are left out of the total: they are in user and nice already), in tenths of a percent of all cores
  together, rounded; cores = the `cpuN` lines. A busy share is never more than the time that passed (iowait can go
  back on tickless kernels).
- **Memory:** `MemTotal − MemAvailable`. The computers' share: the sum over Incus's container cgroups
  (`/sys/fs/cgroup/lxc.payload.*`, at the cgroup root; `lxc.monitor.*` and `lxc.pivot` aren't computers) of
  `memory.current` less `memory.stat`'s `inactive_file` (the page cache the kernel drops first, as `docker stats`
  counts), the counterpart of MemAvailable; never more than the memory used; null when no computer runs or a cgroup
  can't be read (one that stops between the listing and the read is left out).
- **Network:** the uplink is the interfaces of the IPv4 default routes in `/proc/net/route` (destination and mask 0,
  RTF_UP; several are all counted; at most 8 names, as HostNow allows), the computers' bridge every interface named
  `wbc…` that is a bridge (`/sys/class/net/<if>/bridge`; computers.nix names it `wbc<install>`, its veth ends are named
  otherwise). Bytes from `/sys/class/net/<if>/statistics/{rx,tx}_bytes`: in = the uplink's rx, out = its tx; the
  computers' in = the bridge's **tx** (what it sends goes to them), out = its rx. A sample counts the difference to the
  previous reading: an interface not in that reading is a baseline (0: its counters hold what it moved before it became
  the uplink or before the manager started), a recreated one (another `ifindex`) or a counter that went back counts
  from zero.
- **The first reading** after the start is only the baseline; the first sample follows a second later (so the runtime
  gets an answer at once; before it, 503), then one just after every multiple of 10 s (`tickOffset` 50 ms), so each
  10-second step gets one. A sample belongs to the step holding the middle of the interval it measured; two in one step
  (the first, a late tick) are added up. A reading without `/proc/stat` is no sample, and the next one is a baseline.
- **Disks**, every minute in a goroutine of their own (a hung backup disk mustn't stop the rest): `statfs` of
  `/persist`, `/` and `<persist>/backup/disk` only while it is a mount point in `/proc/self/mountinfo` (else null).
  used = (blocks − bfree)·size, free = bavail·size, total = blocks·size, size the fragment size (`df`'s).
- **`/persist`'s parts** from the btrfs quota groups in sysfs, world-readable: `computers` = 1/101's `referenced`,
  `work` = the workspaces subvolume's 0/<id>, `database` = postgres's 0/<id>, `whombat` = 1/100 less work (storage.nix
  NX-12, computers.nix NX-150). The subvolume ids come from `statx(STATX_SUBVOL)` (Linux 6.10; the DEV box runs 6.18),
  allowed by the manager's `@system-service` filter and needing no capability; a path counts as a subvolume only when
  it is one's root (inode 256) with another id than `/persist`'s. The filesystem's `/sys/fs/btrfs/<uuid>` is found
  without a device node or an ioctl: btrfs's statfs `f_fsid` is its UUID's big-endian words folded (0^2, 1^3) xor the
  subvolume id, matched against every directory there (checked against the DEV box: `616166a00b3b64bb` for
  `d0a7d186-…` at subvolume 5). Parts are null when `/persist` isn't btrfs, quotas are off, there is no subvolume id
  (an older kernel), or `qgroups/inconsistent` isn't `0` (btrfs counts no writes until whombat-qgroups' rescan ends,
  NX-150). A part that can't be read is left out (and `whombat` with an unreadable `work`, which it would otherwise
  include); when there is no workspaces subvolume, `whombat` is all of 1/100. Shared extents (snapshots, reflinks)
  can make the parts add up to more than used: they are scaled down together, rounding down, so they never exceed it
  (the app's “Other” is the rest).

No privilege, unit setting or Nix change: the manager already reads `/proc` and `/sys` (`ProtectKernelTunables` and
`ProtectControlGroups` make them read-only, not hidden) and writes `/persist/manager`. Tests (`hostmetrics`): `TestCPU`,
`TestMemory`, `TestUplink`, `TestCounterDelta`, `TestBridgesAndComputersMemory`, `TestMeasure` (fake roots end to end),
`TestDisksOfTheDevBox`, `TestDiskParts`, `TestFitParts`, `TestBackupDisk`, and `TestRun` (the loop on fake roots: an answer
within about a second of the start, the open minute written when it stops).

## MG-64 The history: an hour in memory, 48 hours and 35 days in ring files (2026-10-11; BS-03)

Every sample goes into three rings of buckets: 10 seconds (in memory, 400: a little over the hour range), 1 minute
(2 880: 48 hours) and 15 minutes (3 360: 35 days). A bucket keeps the samples' count, the sum of their processor shares
and of their memory (for the averages), the busiest sample, and the four byte counts summed. The bucket starting at t
is at index (t / width) mod capacity; a newer start replaces an older one in place.

The 1-minute and 15-minute rings are also files in the metrics directory, `<dir of journalDir>/metrics`
(`/persist/manager/metrics`, 0700, files 0600; config `metrics.dir`, which the Nix module doesn't set: an older
known-good manager refuses fields it doesn't know). A file is a 64-byte header (`WBHM`, version, record size, width,
capacity, CRC-32) and `capacity` 64-byte records (start, count, sums, peak, CRC-32), each written in place with
`pwrite` at its index: when a sample of a new minute comes, the minute before and its quarter hour (two records, 128
bytes a minute), and the open ones when the manager stops. The files never grow (184 KB and 215 KB, sparse until
written) and are never rewritten whole; there is no fsync (the kernel writes them back within half a minute; a power
cut loses a minute or two). At the start they are read back: a header that doesn't match, or a file of another size
(truncated, another version), starts that ring afresh (logged at INFO); a record whose checksum, start or place is
wrong reads as empty. A manager that didn't stop cleanly loses the minute in progress; measuring then goes on in the
same quarter hour's bucket. Without a usable directory the history is kept in memory only (one warning).

Clock jumps: a sample's step is the wall clock's. One that jumped back adds to the buckets it lands in; one that
jumped forward leaves buckets in the future, which are never shown (ranges end at the latest sample, and “measuring
since” only counts buckets in the ring's span before now) and are overwritten in time. A sample before 2025 (a clock
not set yet) counts for “now” only. Tests: `TestRingFileRoundTrip`, `TestRingFileDamage` (truncated, another header,
a damaged record, a record in the wrong place), `TestHistorySurvivesARestart` (incl. a crash), `TestNoHistoryDirectory`,
`TestClockJumps`.

## MG-65 Ranges, `since`, days and “measuring since” (2026-10-11; BS-04, BS-05, CT-334)

Answered from memory, under a read lock, in well under a millisecond:

- **Ranges:** `hour` 360 × 10 s from the 10-second ring, `day` 288 × 5 min from the 1-minute ring, `week` 336 × 30 min
  and `month` 360 × 2 h from the 15-minute ring. A point adds up its step's buckets: the averages over all its
  samples, the busiest sample (`cpuPeakPermille`), the bytes summed; null where none has a sample. Only finished
  steps: the range ends at the last step whose last 10-second step has its sample, judged by the latest sample, not
  the wall clock (a query in the moment before a sample is kept doesn't get an empty last step that a later `since`
  poll would never fill).
- **`since`:** only the points starting at or after it (the first step at or after it, a fractional second rounding
  up), between the range's start and its end; `series.start` is the first returned point's start (the range's end
  when none is new).
- **Days:** 30 calendar days in the asked zone, oldest first, today (the wall clock's) last, every day present; each
  sums the 15-minute buckets starting from its midnight to the next (23 or 25 hours across a DST change; zones half or
  three quarters of an hour off UTC still start their days on a quarter hour). The zone loads with `time.LoadLocation`
  and the embedded `time/tzdata` (whatever /etc holds); one it doesn't know, and `Local`, is UTC, answered as
  `timeZone: "UTC"`.
- **`measuringSince`:** the oldest 15-minute bucket in the ring's span, refined by the 1-minute ring when its oldest
  bucket lies inside that quarter hour, and by the 10-second ring likewise (a box measured for a minute says that
  minute, not its quarter hour). **`now`** is the latest sample; **`disks`** the last disk reading (zeros until the first,
  within a second of the start).
- Byte counts are capped at 2^53 − 1 and shares at 1000, `cores` at 1…4096, as the contract allows.

Tests: `TestRanges` (49 hours of samples: every range's start, step, points, sums, averages and peaks; a gap is null),
`TestOnlyFinishedSteps`, `TestSince`, `TestDays` (Europe/Amsterdam across 25 October 2026, Asia/Kolkata, an unknown
zone), `TestMeasuringSince`, `TestResponseWithEverything`; every answer passes the contract's `Validate()` and
`ParseHostMetricsResponse`.

## MG-66 `POST /v1/host/metrics` for the runtime (2026-10-11; CT-334, BS-06)

`local.ManagerPathHostMetrics` on the manager's socket, for the runtime uid only (the peer-credential check of its
other routes; anyone else 403), with the 64 KiB request limit. The body is checked with `local.ParseHostMetricsRequest`
(strict: anything else 400 `bad_request`, and a `since` the pattern lets through that isn't a time); the answer is
`local.HostMetricsResponse {v: 1, metrics}`. 503 `unavailable` (`Retry-After: 1`) in the second before the first
sample; a broker without a sampler answers 404 `unavailable`, as a manager before this change does, which the runtime
reports as `unavailable` (BS-06). Who may see the measurements is the runtime's decision (owners, BS-06; *since Whombat
one-person.md OP-03, 2026-10-25, the box's one person*); the manager answers the runtime. Test: `broker.TestHostMetricsEndpoint`.

## MG-67 `whombat-manager check`: a poll of control on demand (2026-10-19; IN-302)

John, 2026-10-19: an update should reach his DEV box as soon as it is published. The manager asked control only on its
own schedule (at start, then every `nextCheckS`, at least 60 s by the device contract), so `dev/candidate` restarted
the manager to make it ask (IN-299). Now `whombat-manager --config … check` asks the running manager over its socket
(`POST /v1/update/check`, `broker.PathCheck`; root and the manager's own uid, anyone else 403): the control loop polls at
once, as at any poll (an assignment verified against fresh metadata and offered to the engine), and answers
`{result, decision, nextCheckS}` (control's `assigned`/`unchanged`/`none`, the engine's decision on an assignment).
Every check gets the answer of a poll that started after it; checks one after another poll at most every 2 s. Control
away is 503 `unavailable`, any other failure 502 `control_refused`; a manager before this change says
`unknown command "check"`, and a broker without `CheckNow` answers 404 `unavailable`. Not a contract path: the
runtime doesn't call it (a “Check for updates” for people would go through the contracts). Tests:
`broker.TestCheckEndpoint`, `daemon.TestCheckTakesAnUpdateAtOnce`.

## MG-68 An accepted assignment wakes the engine (2026-10-19; IN-302)

The control loop offers an assignment to the engine (`Engine.Offer`, Assigned persisted), but the engine loop slept on
until its next step: up to the idle interval, a minute on a box (the watchdog's half). John's box sat Assigned for 55 s
(candidate 0.102.4). Now an offer the engine didn't take as a no-op wakes the engine loop (`engineNow`, a coalescing
signal), which steps at once: Assigned → Downloading without the wait, on every box, production too. The step is the
one the timer would have run, so nothing else changes. Test: `daemon.TestCheckTakesAnUpdateAtOnce` (an hour's idle
interval, Healthy within seconds; without the wake it stays Assigned).

## MG-69 The battery in the host metrics: HostNow.power (2026-10-20; Whombat DK-10, contracts 0.100.0)

The desk display (Whombat `docs/decisions/desk-display.md`) uses a laptop's battery as a UPS: the runtime tells people
when the power goes and comes back, and the screen shows the power line. The manager already measures the box every
10 s (MG-63), so it reads the battery with every reading (`hostmetrics/power.go`) and puts it into `HostNow.power`
(`protocol.HostPower {source, percent, charging, minutesLeft, chargeLimit, since}`), absent on a machine without a
system battery (a VM, a desktop). No privilege or unit change: `/sys/class/power_supply` is world-readable.

- **Batteries:** type `Battery`, not `scope=Device` (a wireless mouse's, a headset's), not `present=0`. **Chargers:**
  every other supply that isn't a device's (Mains, USB/USB-C, UCSI).
- **source:** `ac` when any charger is `online`; with chargers listed and none online, `battery`; with none listed at
  all (some firmwares), the batteries' status says (`Discharging` = battery).
- **percent:** one battery's `capacity` (what the firmware shows and UPower's shutdown at 10 % goes by, NX-166); several
  together by `energy_now/energy_full` (else `charge_*`), else their capacities' mean; kept within 0–100.
- **charging:** a battery reports `Charging` (held at the limit it says `Not charging`).
- **chargeLimit:** the first battery's `charge_control_end_threshold` when 1–99 (100 or none: null; NX-167 sets it).
- **since:** the first reading on battery, kept until a reading on AC (a manager that starts on battery: its first
  reading). The runtime's “on battery for a minute” message counts from it.
- **minutesLeft** (on battery only): what the batteries hold (`energy_now`, else `charge_now`) over their drain
  (`power_now`, else `current_now`, the absolute value: some drivers sign it), in one unit pair for all (MG-71), averaged over the last 6 readings (a
  minute; a laptop's draw jumps with every burst of work); a drain of 0 (a firmware between measurements) is no reading;
  null without a rate; at most a week. The history keeps none of it (the rings and their files are unchanged).
- Tests (fixture sysfs trees): `TestPowerOnTheZ13` (adapter, battery with asus-wmi's threshold, a UCSI port, a mouse's
  battery: plugged in and held, the power out, the average, a 0 W reading, the last minute only, back on AC, out again),
  `TestNoBattery`, `TestPowerVariants` (no charger listed, charge and a signed current, two batteries, a USB-C charger,
  no rate, a capacity out of range), `TestSamplerPower` (the sample, the runtime's answer passes the contract's
  `Validate` and `ParseHostMetricsResponse`, no `power` member without a battery).

## MG-70 Contracts 0.100.0 (2026-10-20; CT-517…)

`third_party/whombat-contracts-go` is the released `whombat-contracts-go-0.100.0.tar.gz` (`contracts-v0.100.0` @
`fcef9bb`, tree `708906f` = the release's `reproducible.trees.go`), replaced whole per VENDORED.md; `vendorHash` updated.
Nothing in the manager needed a change for the jump from 0.78.0; `HostNow` gained the optional `power` (MG-69), which
an older runtime ignores.

## MG-71 Batteries in different units leave the time unknown (2026-10-20; review of the desk display; amends MG-69)

`minutesLeft` adds the batteries' contents and drains in one unit pair for all of them: energy and power (µWh, µW) when
every system battery reports both, else charge and current (µAh, µA) when every one does, else none, and the time left
is null. Watt-hours and amp-hours can't be added without the voltage; before, a battery in energy and one in charge were
summed (`hostmetrics/power.go`). The minute's average of the drain (MG-69) starts again when the pair changes from one
reading to the next, so µW and µA are never averaged together. The percentage was already one unit for all.

- Tests: `TestPowerVariants` gains “mixed units” (no time left, the capacities' mean), “both in energy” (energy wins when
  one battery reports charges too) and “both in charge”; `TestPowerUnitsDontMix` (a driver switching from energy to
  charge: the average starts again).

## MG-72 The processor's temperature and the uptime: HostNow.cpuTempC and uptimeS (2026-10-20; Whombat DK-22, DK-24, contracts 0.101.0)

A desk screen on a new box shows *This Whombat* until there are servers or home tiles (Whombat
`docs/decisions/desk-display.md` DK-22): the processor and memory over the hour, storage, the processor's
temperature, the network and how long the box has been up. The manager measures the box every 10 s (MG-63) and the
runtime already asks it every 10 s for the battery (MG-69), so it reads both with every sample
(`hostmetrics/thermal.go`); neither is kept in the history (the rings and their files are unchanged).

- **cpuTempC**, whole °C, from `/sys/class/hwmon/hwmon*` by the driver's `name`: `k10temp` and `zenpower` their `Tdie`
  input, else `Tctl` (Tdie is the die; Tctl is what the fans follow and reads 10–27 °C above it on Threadripper
  1000/2000), `coretemp` its `Package id N` (one device per socket), and for any of them without such a label their
  hottest input (a coretemp with only its cores, an older k10temp's unlabelled temp1). Several devices (sockets): the
  hottest. No such driver: the hottest thermal zone of the first type present of `x86_pkg_temp`, `cpu-thermal` (an
  ARM board's SoC) and `acpitz`. Disks', network cards' and graphics chips' sensors (`nvme`, `amdgpu`, …) never count.
  A reading of 0 (a sensor that isn't wired up) or outside the contract's −50…150 °C is none. None at all: the member
  is absent (a VM; John's DEV box has an empty `/sys/class/hwmon` and no thermal zone). The Z13's Strix Halo has
  k10temp with Tctl, the case the tests start from.
- **uptimeS**: the first field of `/proc/uptime`, whole seconds; absent when it can't be read.
- No privilege, unit or Nix change, so no NX number: hwmon's `temp*_input`, thermal zones' `temp` and `/proc/uptime`
  are world-readable, and the manager's sandbox (`ProtectKernelTunables`, `ProtectSystem=strict`, `PrivateDevices`)
  leaves `/sys` and `/proc` readable; it hides `/dev` only. Checked on The Titan: k10temp (Tctl 47 °C) and the uptime.
- Tests: `TestCPUTemp` (the Z13 beside amdgpu, nvme and acpitz; Tdie over Tctl; zenpower; two coretemp packages;
  coretemp with cores only; an unlabelled k10temp; an unreadable Tdie; Intel's package zone over ACPI's; a Raspberry
  Pi; the ACPI zone; a VM; only disks; readings that aren't), `TestUptime`, `TestSamplerTempAndUptime` (the answer
  passes the contract's `Validate` and `ParseHostMetricsResponse`; no `cpuTempC` member without a sensor).

## MG-73 Contracts 0.101.0 (2026-10-20; CT-538…)

`third_party/whombat-contracts-go` is the released `whombat-contracts-go-0.101.0.tar.gz` (`contracts-v0.101.0` @
`c7f562b`, tree `1c82fbe` = the release's `reproducible.trees.go`), replaced whole per VENDORED.md; `vendorHash`
updated. `HostNow` gained the optional `cpuTempC` and `uptimeS` (MG-72), which an older runtime ignores.

## MG-100 Wi-Fi changes through the guard (2026-10-20; Whombat HD-06; extends MG-15)

- `netguard` makes a join or a forget the way it applies a wired candidate: it takes the maintenance lock (no update
  activates meanwhile; held by something else → `busy`), runs `applying` (the helper's `wifi-join`/`wifi-forget`,
  NX-244), then `confirming` until a check reaches control (`wifi-confirm` → `committed`) or the deadline passes
  (`reverting` → `wifi-revert` → `reverted`, failure `no_internet`). A join the helper couldn't make is `failed` at once
  with its failure (`wrong_password` also for `invalid_passphrase`; `not_found`; `no_address`; else `failed`), and the
  helper kept nothing. One change at a time, wired or Wi-Fi (`busy`, answered before any check a new change makes, and asked again when it
  is recorded). State in `<network stateDir>/wifi.json` (0600).
- **Guarded only when the box was online before** (HD-06, HD-10), decided on a fresh check (≤ 5 s) when the change is
  asked for: a box that can't reach Whombat anyway has nothing to lose, so its change is kept once made. A guarded
  change sends the helper `deadlineSec = confirmTimeoutSec` (the dead-man, NX-245); the manager's deadline starts when
  the join is done (`confirmTimeoutSec` later), so a slow join doesn't eat the time to confirm. A forget, which carries no
  timeout in the contract, has 120 s (HD-06's 2 minutes).
- **The passphrase stays in memory** until the network loop hands it to the helper; it is never persisted, logged or
  returned. A manager that restarts while a join with a passphrase waits has lost it: the change goes `reverting`
  (failure `failed`), which undoes whatever the helper did. A lost helper answer is treated the same way.
- **What is shown:** the running change, or one that ended less than 5 minutes ago (then `change` is null, so a
  failure from yesterday isn't shown). `deadline` while applying is the expected one (submit + 90 s + timeout).
- The network loop wakes when a change is asked for (no wait for its next step).

## MG-101 The network state and “online” (2026-10-20; HD-10; local `networkState`)

- **Wired:** `/sys/class/net` entries of type 1 with a device behind them that aren't Wi-Fi (no `wireless`, no
  `phy80211`): physical and USB cards, not the computers' bridge, veths or tunnels; at most 8. `connected` = carrier and
  an address (IPv4 that isn't link-local, else global IPv6), which is also `address`.
- **Wi-Fi:** the helper's `wifi-status`: iwd's `connected`/`roaming` → `connected`, `connecting` → `connecting`, else
  `disconnected`; the network's name exactly while connecting or connected (cleaned with `HostText` when it isn't
  displayable, “?” at worst: the network the box is on is never left out); bars from dBm (`WifiSignalFromDBm`) and the
  address only while connected; the saved networks with displayable names (≤ 32; 8021x → `enterprise`, wep → `other`).
- **`wifiMissing`** (only without a station): a `wlan` rfkill blocked (soft or hard) or every card iwd sees
  unpowered → `disabled`; a PCI device of class 0x0280 without a bound driver → `no_driver`; a card with a driver that
  iwd doesn't answer for → left out (nothing true to say); nothing at all → `no_adapter`. USB Wi-Fi without a driver
  reads as `no_adapter` (the hardware report, stream A, says more).
- **Online** is the guard's control check (a TCP connect to control's endpoint, `DialChecker`): an answer counts for 60
  s, one that didn't reach control for 10 s (so the box looks online again soon after its network came back); a
  question after that checks again and waits at most 1 s for it (the answer is then the previous one, and the
  check goes on, at most 10 s); confirmation steps and the check before a change refresh it; after a change ends the
  next question checks again. Nothing checks in the background. `checkedAt` is the last check, null before the first.
- The parts are bounded for the runtime's 2 s: the helper's status ≤ 1.5 s (it runs beside the check), online ≤ 1 s;
  a helper that doesn't answer leaves Wi-Fi out (null, no `wifiMissing`) and the rest is still answered.

## MG-102 The local network routes (2026-10-20; contracts 0.102.0; brief §2.4)

`POST /v1/network/state`, `/wifi/scan` (the helper's fresh scan, at most 10 s; displayable names, strongest first,
≤ 64), `/wifi/join` → 202 `{v, change}`, `/wifi/forget` → 202: the runtime's uid only, bodies ≤ 2 KiB. Errors per the
contract: 409 `no_wifi` (no iwd, no card, or a helper from before Wi-Fi), `busy`, `in_use`; 404 `not_saved`; 400
`invalid_passphrase` (not a WifiPassphrase, or no password for a secured network that isn't saved, from the last scan)
and `bad_request` (the schema, an SSID that isn't `SsidValid`); 503 `unavailable` when the helper fails. A join's
errors never repeat the request (a schema error may quote the passphrase): the passphrase is checked on its own first,
and a schema failure is answered without details. **`in_use`:** forgetting the network the box is on while no cable is
connected (HD-06); with a working cable it is allowed, and guarded like any change. Answers are validated against the
contract (and `HostNetworkValid`, `NetworkChangeValid`) before they go out; an invalid one is a 500 and an error log.

## MG-103 The manager may use AF_NETLINK (2026-10-20)

The interfaces' addresses come from Go's `net.Interface.Addrs`, which asks the kernel over netlink: the manager unit's
`RestrictAddressFamilies` gains `AF_NETLINK` (route queries only; the manager still has no capabilities). The
alternatives were worse: parsing `/proc/net/fib_trie` for IPv4, or asking the root helper for every interface.

## MG-104 Contracts 0.102.0 (2026-10-20; CT-560…)

`third_party/whombat-contracts-go` is the released `whombat-contracts-go-0.102.0.tar.gz` (`contracts-v0.102.0` @
`984fdc7`, tree `7dee68f` = the release's `reproducible.trees.go`), replaced whole per VENDORED.md; `vendorHash` updated
(then again for godbus, NX-243). The network routes use its types and helpers (`HostText`, `SsidValid`,
`WifiSignalFromDBm`, `HostNetworkValid`, `NetworkChangeValid`); no stand-in types were needed.

## MG-110 The hardware report: what the manager reads (2026-10-20; Whombat HD-01, HD-03; contracts 0.102.0, CT-560…CT-563)

John's Z13 had a microphone that didn't record and no Wi-Fi, and nobody could look inside it (no shell on a box of its
own). The manager already reads sysfs and procfs for the box's measurements (MG-63) and answers the runtime, so it
collects the hardware report (`protocol.HostHardware`) when asked: package `manager/internal/hardware`, the roots
injectable (`Config.Sys`, `Config.Proc`) as in `hostmetrics`, which it doesn't touch.

- **The machine:** DMI's `sys_vendor`, `product_name`, `product_family`, `bios_version` (placeholders such as “To Be
  Filled By O.E.M.” and “Default string” are left out); **virtual** from the processor's `hypervisor` flag, Xen's sysfs or
  a hypervisor's DMI strings; its name as systemd-detect-virt has it: `kvm` where the kvm clock is offered (KVM, Proxmox,
  Incus), `microsoft` for Hyper-V's clock or DMI, else systemd's DMI table (`qemu` for QEMU without KVM, `vmware`,
  `oracle`, …). The processor's model (empty on Arm, where /proc/cpuinfo has none), its threads (processors) and cores
  (distinct physical and core ids), `MemTotal`, the kernel's release.
- **Devices** (≤ 256, in the contract's kind order, then by sysfs path): the PCI functions and USB devices on the buses,
  and what works from them: network interfaces (`/sys/class/net`, those with a device: wired, or Wi-Fi by `wireless` /
  `phy80211`; link from the carrier, the speed when up), ALSA cards (`/proc/asound/cards` and `pcm`: capture and playback
  PCM devices per card, the trailing stream fields only as NX-179), non-removable disks with a size (model, size; loop,
  zram, device mapper and MMC boot partitions are left out), Bluetooth adapters, graphics cards and their connectors
  (writeback connectors aren't screens), video4linux devices (cameras), system batteries (not a mouse's: scope Device),
  I²C HID devices (touch screens, touch pads), and the radio switches (`/sys/class/rfkill`).
- **Never** a serial number or a MAC address: `serial`, `serial_number`, `address`, `macaddress`, `wwid`, DMI's serials
  and UUID and the EDID are never opened, and the tests' fixture trees hold sentinels in all of them that must not reach
  the answer. Interface names stay as the kernel has them (NixOS names USB adapters by path, `enp196s0f4u1`, not
  `enx<MAC>`).
- **When asked, and briefly kept:** the runtime asks when an owner opens About → Hardware; an answer is reused for 10 s
  (`CacheFor`), one collection at a time. A collection reads a few hundred small files and the ids files once (under
  10 ms on The Titan) plus the helper's kernel lines (MG-114).
- No privilege, unit or Nix change: /sys and /proc are readable in the manager's sandbox (`PrivateDevices` hides /dev
  only; `ProtectKernelTunables` makes them read-only), and every file read is world-readable.

## MG-111 Kinds and statuses (2026-10-20; HD-03, CT-561)

- **A device is listed as what works from it:** a PCI function or USB device with a network interface, a sound card, a
  disk or a Bluetooth adapter below it is that function's entry, with its owner's name, vendor, `vendor:device` id and
  bus (a USB Ethernet adapter is `wired` on `usb`, the Z13's coprocessor's microphone card is `sound` on `pci` with
  `1022:15e2`). The function's driver: the interface's device's (`mt7925e`, `r8152`, `virtio_net`), the card's device's
  (`snd_hda_intel`, `acp_pdm_mach`), a virtio device's between disk and owner (`virtio_blk`) else the owner's (`nvme`,
  `ahci`), the adapter's interface's (`btusb`). Graphics chips stay entries of their own (their connectors are `display`
  entries); cameras are their USB device or PCI function, known to work by their video nodes.
- **Everything else on the buses** by its class: PCI bridges (class 06) are left out; storage, graphics, Wi-Fi (0280),
  wired (0200), Bluetooth (0d11), sound (0401, 0403), camera (0400), SD (0805) and USB controllers (0c03) by their
  class, the rest `other`. USB hubs and root hubs are left out; a USB device by its interfaces (Bluetooth, camera,
  sound, wired, storage, input), and a vendor-specific one by its names (the database's and its own: “802.11”, “WLAN”,
  “Wi-Fi” is Wi-Fi, “Bluetooth”, “Ethernet”/“LAN”) — a Wi-Fi adapter without its driver says what it is nowhere else.
  That is a reading of names, not a list of models (HD-01).
- **Statuses:** `no_firmware` when a kernel line names the device (`<driver> <device>: …`, `Bluetooth: hci0: …`) as
  failing to load firmware and nothing shows it works: no driver bound, no interface, no card, no graphics card — a
  firmware the driver asks for and can do without (amdgpu's camera ISP, iwlwifi trying older versions first) leaves a
  working device `ok`; a Bluetooth adapter registers before its firmware loads, so for it the line is enough. Else
  `no_driver` when a device that needs one has none: PCI storage, network, graphics, audio and multimedia, USB and SD
  controllers and wireless functions, and every USB device; bridges, the chipset's peripherals, SMBus, encryption,
  signal processing and accelerators (an NPU) work without or aren't the box's business. Else `disabled` for a Wi-Fi
  card or Bluetooth adapter whose own switch or the machine's (a laptop's wireless key, `asus-wlan`) blocks it. Else
  `ok`.
- **Names:** the database's (MG-112), else (USB) the device's own strings, else the PCI class's name, else what it is
  (“Bluetooth”, “PCI device”); vendors likewise. Every string is cleaned with `local.HostText` to the contract's length.
- Tests (fixture trees laid out as the kernel lays them out, bus and class directories as relative links):
  `TestTheZ13` (MT7925 `14c3:7925` on `mt7925e`, link down; the r8152 adapter up at 2500; the HDMI, codec and
  `acp-pdm-mic` cards with one capture device on `1022:15e2`; amdgpu `1002:1586` fine despite an optional firmware; NVMe,
  camera, keyboard cover, touch screen, battery; no bridges, root hubs or virtual disks), `TestAVirtualMachine` (q35,
  virtio network and disk, the emulated HDA card, bochs, `kvm`; `qemu` without the kvm clock), `TestAWifiCardWithoutADriver`
  (an Intel Wi-Fi 7 card and a USB Realtek adapter `no_driver`, the Bluetooth switched off), `TestMissingFirmware`
  (iwlwifi bound without firmware, Bluetooth's firmware missing, a working Ethernet card's optional firmware),
  `TestStatusRules`, `TestNoHwdata`, `TestPlaceholdersAndArm`, `TestDevicesCapped`, `TestCollector` (the cache, the
  helper's deadline and failure, a caller gone), `TestLookup`; every answer passes `local.ParseHostHardwareResponse`.

## MG-112 Device names from hwdata, without a configuration field (2026-10-20; HD-03)

- Names from hwdata's `pci.ids` and `usb.ids` (what lspci and lsusb read): one pass through each file for the ids this
  machine has (vendor, `vendor:device`, PCI class and subclass); subsystem lines and usb.ids' other sections are
  skipped. About 5 ms for pci.ids.
- **The path is in the binary**, not in `manager.json`: `nix/packages/go.nix` builds the manager with `-X
  …/manager/internal/hardware.HwdataDir=${hwdata}/share/hwdata`. The configuration is strict and an older known-good
  manager must still read it (config.go), so it gains no field; a known-good manager has its own path, or none. No new
  closure: hwdata 0.406 is already there (libdrm → libpciaccess). A build without it (tests, `go run`) names devices
  from their own strings and the class names built in.

## MG-113 `POST /v1/host/hardware` for the runtime (2026-10-20; CT-563)

`local.ManagerPathHostHardware` on the manager's socket, the runtime's uid only (anyone else 403), the request at most
1 KiB and strict (`local.ParseHostHardwareRequest`: `{v: 1}`, anything else 400 `bad_request`); the answer
`local.HostHardwareResponse {v: 1, hardware}`, checked with the contract's `Validate` before it is sent (a report the
contract would refuse is 500 `internal`, logged, never sent). A broker without a collector answers 404 `unavailable`,
as a manager before this change does, which the runtime reports as `unavailable`; a request that ends
before the report is 503 `unavailable`. Who may see it is the runtime's decision (owners, the session op
`host.hardware`; *since Whombat OP-03, 2026-10-25, the box's one person*). Normal and recovery mode alike. Test: `broker.TestHostHardwareEndpoint`.

## MG-114 The helper's `hardware-log`: the kernel's firmware and driver errors (2026-10-20; HD-03, brief §2.6)

- A read-only helper operation without arguments (`proto.OpHardwareLog`, registered from its own file), answered in
  `Result.KernelLog`. It runs **outside the helper's operation lock**: it changes nothing, and a staging that takes an
  hour must not hold up an owner's About page.
- **Source:** this boot's kernel messages from the journal (`journalctl --dmesg --boot=0 --output=json
  --output-fields=MESSAGE,PRIORITY`; the helper's sandbox hides /dev/kmsg, `ProtectKernelLogs`, and the journal keeps the
  early boot's lines, which the ring buffer of a long-running box has lost). At most 64 MiB or 200,000 messages are
  read (the boot's first ones, where drivers and firmware load), within 10 s; journalctl from the unit's PATH.
- **The filter** (`helper/pkg/kernlog`, shared with the manager): firmware that didn't load (“Direct firmware load for
  … failed”, “no suitable firmware found”, “Failed to load firmware”, “SOF firmware … not found”), a driver's failed
  probe, hints that a device has no driver (“no codecs found”, “unsupported device”), and error-level messages of a
  device (`<driver> <device>: …`); never ACPI's table errors and firmware-bug notes (most laptops print dozens),
  certificate and lockdown lines, or a line naming a serial number. Each message once, the first 40, cleaned (one line,
  ≤ 240 code points, MAC addresses masked).
- **The manager** asks with a 10 s deadline while collecting; a helper that can't answer (an older helper, the journal
  unreadable) leaves the report's `log` empty and the statuses from sysfs alone, with one warning per kind of failure.
- Tests: `kernlog.TestKeep`, `TestFirmwareFailure`, `TestDevice`, `TestClean`, `TestSelect`; `ops.TestParseJournal`,
  `TestHardwareLog` (outside the lock, an unreadable journal is an error, no arguments); `proto.TestDecodeRequest`.

## MG-115 The report on contracts 0.102.0's types (2026-10-20; CT-560…CT-563)

`manager/internal/hardware` and the broker use contracts-go 0.102.0 (`hw` d584f5f, stream N's re-vendoring):
`protocol.HostHardware`, `HardwareDevice`, `HardwareMachine`, `HardwareCpu`, `HardwareKind`, `HardwareStatus`,
`HardwareBus`, `HardwareLink`; `local.HostHardwareRequest`/`Response`, `local.ManagerPathHostHardware` and
`local.HostText`. The contract has no Go constants for its limits; `hardware.DevicesMax` (256), `LogMax` (40) and
`LogLineMax` (240) are `HOST_HARDWARE_DEVICES_MAX`, `HOST_HARDWARE_LOG_MAX` and `HOST_HARDWARE_LOG_LINE_MAX`. No
stand-in types are left.

## MG-116 Not seen on real hardware (2026-10-20)

Seen in a VM's real sysfs (`console-self`, NX-258: QEMU's devices, the helper's lines, no MAC or serial). Only fixture
trees otherwise: the Z13's real sysfs (whether its microphone card sits under the coprocessor's PCI
function as modelled, its HID devices, its rfkill switches), an Intel card without a driver, a USB Wi-Fi adapter, the
kernel lines of a real firmware failure, and the journal's size on a box that has run for months.

## MG-118 The support service's ticket: `POST /v1/support/ticket` (2026-10-21; Whombat RH-06; contracts 0.120.0 CT-940)

Remote help's service on the box (`whombat-support`, root, NX-411…) dials the relay as a worker for the device's
**support route**, a second opaque route id control keeps per device (control CL-121). The management key stays in
the manager, as for the runtime's tickets (MG-11), so the manager fetches the ticket: `local.ManagerPathSupportTicket`
on its socket, **uid 0 only** (`Server.SupportUIDs`; the runtime's uid and anyone else 403), the body empty or `{}`
(strict, at most 1 KiB), answered with the device op `support.ticket`'s `SupportTicketResponse` (`controlapi.Client.
SupportTicket`, the answer checked by the contract). It is cached on its own (never the runtime's per-class cache) and
reused until `TicketMargin` (60 s) before `expiresAt`; a ticket that would expire within that margin isn't handed on
(502). Control's refusals pass on with their code, as the contract says: a retired device 403 `device_revoked`, an
unclaimed one 409 `device_unclaimed`, 429 `rate_limited`, unreachable (and 5xx) 503 `unavailable` with `Retry-After:
30`; anything else — a control before the op answers 404 — is 502 `control_refused`. Tests: `broker.TestSupportTicket`,
`controlapi.TestSupportTicket` (signed and verified by the contract's verifier in `fakecontrol`).

## MG-119 Remote help in status.report (2026-10-21; RH-09; CT-944)
Superseded in part by MG-126 (HE-52): no retry without `support` for a control before 0.120.0.

`StatusReportRequest.support` comes from the support socket's `GET /v1/state` (`local.SupportPathState`, the one path
the manager's uid may use there), read at every report with a 3 s deadline and an answer of at most 64 KiB, checked by
the contract (`local.ParseSupportState`, then `local.SupportStateValid`). The member is **left out** when the socket is
absent, doesn't answer, refuses (logged once, with its error code only) or answers something invalid (logged once,
without its contents). Mapping (`supportclient.Report`): `off` with `untilS` null without a grant, and also once the
grant's `until` has passed (the service ends it within a second; the report never says a grant runs that is over);
else the grant's level with the whole seconds left (`null` for Forever), at most a week; `connected` counted up to 8;
`helpCode` = `helpCodeRequired`; `hostKey` only when it is an `ssh-ed25519` key in the SSH wire format (Ed25519, 32
bytes), taken bare — a comment or surrounding space is trimmed before the contract's check, as control takes the bare
key only — else null. **Metadata only**: the grant's help code and who granted it and the connected visits' names are
blanked as soon as the answer is checked; nothing of them is kept, logged or sent. A member the report's schema refuses
costs only the member. A control that refuses `support` (400 `validation_failed`: before contracts 0.120.0) gets the
same report once more without it, and the reports after go without it for `LegacyRetry` (6 h), then it is tried again;
`OnNoSupport` logs it once (MG-46's way, kept apart from the 0.22 members' fallback). Tests:
`supportclient.TestState`, `TestStateRefused`, `TestReport`, `TestValidHostKey`; `controlapi.TestStatusWithSupport`;
`daemon.TestRemoteHelpReachesControl` (old and new control).

## MG-120 A grant reaches control within seconds (2026-10-21; control CL-126)

Control answers `support.open` with 409 `remote_help_off` until a status report says remote help is on, and reports
come every 15 minutes (5 while help is on, CL-126). So a loop (`supportWatchLoop`) reads the support state every 10 s
(`supportWatchSec`) and asks for a report (the coalescing `statusNow`, MG-61, sent after its 3 s settle) when what control
should know changed (`supportclient.Key`): whether the service answers, whether it is available, the grant (on, off, its
level, since and until), how many are connected, the host key, whether a help code is needed. The seconds running down
ride the next periodic report. 10 s rather than 30: a local socket read costs microseconds, and an owner who turned
remote help on is usually waiting for support to connect. Test: `daemon.TestSupportWatchAsksForAReport`.

## MG-121 What Look reads through the manager (2026-10-21; brief §3 A5)

The support service runs Look's manager reads itself, as root: `GET /v1/update/status`, `POST /v1/network/state`,
`POST /v1/host/metrics` and `POST /v1/host/hardware` accept `SupportUIDs` (uid 0) beside the runtime (and, for the
update status, the lock holders). Nothing else of the runtime's: its tickets, claims, revocations, pushes, feedback,
Wi-Fi, clients and licence routes stay the runtime's uid only. Normal and recovery mode alike. Test:
`broker.TestSupportReads`.

## MG-122 Configuration and sockets (2026-10-21)

- `supportSocket` (default `local.SupportSocketDefault`, `/run/whombat-support/api.sock`; `"-"` reads none) and
  `supportWatchSec` (default 10) are in `manager.json`'s format but the Nix module sets neither: an older known-good
  manager refuses fields it doesn't know (MG-63's way). An image without the support service simply has no socket there.
- **No `manager.nix` change.** `/run/whombat-manager` is 2750 `whombat-manager:whombat-api` and `api.sock` 0660: root
  reaches it with `CAP_DAC_OVERRIDE`. If the support service's unit ever drops that capability (its
  `CapabilityBoundingSet`), it needs `SupplementaryGroups = [ "whombat-api" ]` in its own unit (support.nix, NX-411…);
  peer credentials still decide (uid 0). The manager reaches the support socket when its group is one the manager's user
  is in (support.nix makes the socket 0660 for the runtime's and the manager's groups).

## MG-123 Contracts 0.120.0 (2026-10-21; CT-930…CT-949)
Superseded in part by MG-126 (HE-52): `fakecontrol` has no `NoSupport` any more.

`third_party/whombat-contracts-go` is the released `whombat-contracts-go-0.120.0.tar.gz` (`contracts-v0.120.0` @
`f0347cf`, tree `775f704` = the release's `reproducible.trees.go`), replaced whole per VENDORED.md; `vendorHash`
`sha256-KPCSj4Hs…` read with a fake hash. The work began on stand-ins (a package with the brief's names, its own signer
for the two shapes 0.116.0's schemas refused) that went with this release: the manager uses `device.SupportTicketRequest`
/ `SupportTicketResponse`, `device.SupportReport` in `StatusReportRequest.Support`, `local.SupportState`,
`local.SupportStateValid` and `local.ManagerPathSupportTicket`. `fakecontrol` answers `support.ticket` and can refuse
`support` like an older control (`NoSupport`).

## MG-124 One outbox file (2026-10-24; HE-27, HE-52; supersedes SR-10)

Every manager in the field is from 0.141.0 on (all boxes were rebuilt fresh at the migration baseline), so none reads
`journal/progress-outbox.json` any more. `outbox.OpenCompat`, its import, the copy written after every save,
`LegacyErr`, `Imported` and the `prev` package the tests used as an older manager went; the daemon opens
`progress-outbox-v2.json` with `outbox.Open`. A file left by a 0.141–0.144 manager stays on disk untouched. A rollback
to such a manager re-imports what its copy held and sends it again; control orders late and repeated reports (SR-09).

## MG-125 Reports go out as built (2026-10-24; HE-52; supersedes the fallbacks of MG-46, MG-52, MG-53)

Control is from contracts 0.22 on (stream A4 dropped its API window too), so `update.progress` and `status.report` no
longer retry without `failureDetail`, `waiting` and `runtimeVersion` after a 400: `OnLegacy`, `LegacyRetry`,
`LegacyReports` and `IsValidationRefusal` went, and the fake control's `OldReports`/`OldRefused`. A 400 is the report's
own error, as for any other member. The manager sends control no API level or feature list (it never did).
Tests: `controlapi.TestReportsCarryTheDetail`, `daemon.TestFailureDetailReachesControl`, `TestWaitingReachesControl`.

## MG-126 Remote help and the feedback drop without an older control (2026-10-24; HE-52; supersedes MG-119's fallback and MG-39's bad_envelope)

`status.report` always carries `support` when the support socket answers: the retry without it (`OnNoSupport`,
`NoSupport`, 6 hours) and the fake control's `NoSupport` (which also made `support.ticket` 404) went. The feedback
routes no longer read a control before 0.13 (400 `bad_envelope`: its op enum lacked the op) as 501 `unsupported`; that
answer is now 502 `control_refused` like any other refusal. A control with the drop switched off (404
`feedback_drop_off`) stays 501: that is a setting, not a version. The fake control's `FeedbackMode "old"` went.

## MG-127 Facts to the runtime as built (2026-10-24; HE-52; supersedes MG-48)

Every runtime is from 0.141.0 on and knows contracts 0.22's facts, so `runtimeapi.Client.SendFacts` posts once:
`OnLegacyFacts`, `withoutNewFacts` and the fake runtime's `OldFacts` went (and `broker.TestFactsToAnOlderRuntime`).

## MG-128 Updates through closure indexes only (2026-10-24; HE-52, UP-X22, UP-X23)

The manager plans every component as its closure index plus the blobs of the paths the box lacks (`update.plan`); the
branch that downloaded a whole-closure artifact went, and the plan log line has no `via` any more. `trust.Release`
carries `hostIndex`, `runtimeIndex` and `providerIndexes` only, under the same JSON names as before: a journal written
by a 0.141–0.144 manager decodes (its `host`/`runtime`/`providers` members are ignored) and one written now decodes in
such a manager after a rollback (it finds the indexes it prefers). A candidate that waits for the repository now waits
in `Assigned` (its space check reads the indexes) instead of `Downloading`.

## MG-129 What stays (2026-10-24; HE-52)

Kept on purpose, as mechanisms rather than compatibility:

- **Runtime admin endpoints answering 404** (`runtimeapi.ErrNotSupported` for `/claim-lookup`, `/clients`, `/licence`;
  the fake runtime's `NoClients`, `NoLicence`): the VM tests' stand-in runtime serves neither `/clients` nor
  `/licence`, and a 404 there must not fail the runtime sync. Their comments still name the contract versions that
  added the endpoints.
- **The schema check without floors** (a runtime before Whombat MD-12: the tuple-only check, `NoFloors` in the test
  world): part of the schema rollback classes HE-52 keeps.
- **`len(AssignmentRaw) == 0` guards**, the `Seq` 0 of an outbox entry (“unknown”), and the broker never answering 404
  on the feedback paths: defensive, not version switches.

## MG-130 The manager drives Tailscale for the runtime (2026-10-24; Whombat HE-51; contracts 1.0.0 CT-1253…CT-1255; NX-441)

- **Routes** on the manager's socket (`broker/tailscale.go`): `POST /v1/tailscale/state` for the runtime and the
  support service's Look; `/on`, `/off` (`{signOut?}`), `/sign-in`, `/cert` for the runtime only. Bodies strict
  (`local.ParseTailscale*Request`), answers checked against the schema and `tailscaleStatusValid` before they leave
  (a state that breaks it is a 500, never sent). Errors: 409 `tailscale.busy` (another change runs; reads never wait),
  409 `tailscale.off` and `tailscale.no_https` (the certificate), 503 `unavailable` (tailscaled refused or didn't
  answer). A manager without Tailscale (`tailscaleSocket: "-"`) answers 404 `unavailable`, as for the other optional
  routes. The owner check is the runtime's: the session ops are an owner's (CT-1254; *since Whombat OP-03,
  2026-10-25, the box's one person's*).
- **tailscaled's local API** (`manager/internal/tailscale`), over `/run/tailscale/tailscaled.sock` (config
  `tailscaleSocket`, default that path; the Nix module sets nothing, so an older known-good manager still reads the
  configuration), Host `local-tailscaled.sock`, no keep-alives:
  - state: `GET status?peers=false` and `GET prefs`, mapped: `Running` → `on` (MagicDNS name without its dot,
    lower-case; addresses IPv4 first, at most four; the tailnet's name as host text; `https` when the name is among
    `CertDomains`), `NeedsMachineAuth` → `needs_approval`, `NeedsLogin` with an https `AuthURL` → `needs_sign_in`, else
    `starting` while `WantRunning` and `off` otherwise (`NoState`/`Starting` likewise), `Stopped` → `off`; no answer
    on the socket (ENOENT, ECONNREFUSED) → `error`/`not_running`; anything else, a name the contract refuses included,
    → `error`/`failed` (logged). `unreachable` isn't reported: tailscaled tells it only in free-text health warnings.
  - on: `PATCH prefs` `{WantRunning: true, LoggedOut: false}` (masked), then `POST login-interactive` only when it
    still needs a login and has no link: a box that was signed in comes back as it was. sign-in: the same with
    `login-interactive` always (a fresh link; as someone else). off: `WantRunning: false`, and `POST logout` with
    `signOut`. A change answers the state once it got past `starting` or after 3 s (the link may follow in `state`).
  - cert: only while `on` with HTTPS; `GET cert/<name>?type=pair` (3-minute deadline: the first one is issued through
    Let's Encrypt), split into the key's PEM and the chain's, the leaf checked for the name, `notAfter` from it. The key
    is in the answer only: no log line or error carries it (tailscaled's error text is logged; it names the domain).
- **`whombat-manager tailscale state|on|off [--sign-out]|sign-in|cert`** runs the same code for root and the manager's
  user (remote help, the VM test); `cert` prints the name and the end, never the key.
- **Checked**: `tailscale` package tests against a fake tailscaled on a unix socket (the calls, a fresh box's sign-in
  link, on while signed in asks for no link, off and sign-out, busy, not running, the certificate's refusals and that
  no log line holds the key); broker tests (routes, callers, errors, a state breaking the contract); `checks.tailscale-
  direct` runs the CLI against the image's real tailscaled (off, on → starting without a tailnet, no certificate while
  off, off; the runtime's user reaches nothing). A real sign-in needs a tailnet: the DEV box is the first.

## MG-131 A new session protocol major activates (2026-10-24; Whombat HE-52)

The engine's schema step refused a candidate whose runtime protocol range shared no major with the installed one
(`protocol_no_overlap`, “would strand every current client”). Since HE-52 a client and a box speak one contracts major,
and a client of the old one is told to update the app; there is no window of clients to keep. The refusal went: the
activation check's reasons (`release.CheckActivation`, `CheckMigratingActivation`, `CheckCompatibleActivation`) decide
alone, and the schema rules (floors, checkpoints, rollback access) are unchanged. It stopped Whombat's step 4
(`whombat-dev-20261024.3`, protocol major 2, schema 4) on John's DEV box on 2026-10-24: the manager that judges a
candidate is the installed one, so a box on a manager from before this change needs a release with a protocol it still
accepts first (the bridge, integration.md IN-425). Contracts keep `release.ProtocolOverlap`; nothing on the box calls it.
`describeUpdateFailure` still renders the reason for an older manager's report.

Tests: `update.TestNewProtocolMajorActivates` (a protocol 2 runtime with a contract migration over the factory's protocol
1: the checkpoint, the migration, Healthy; it failed `protocol_no_overlap` before); the fixtures' `FakeRelease.Protocol`
(zero is 1000, as every fixture had).

## MG-135 Tailscale's own login server (2026-10-24; Whombat HE-58, HE-64; contracts 1.1.0 CT-1306)

- **`POST /v1/tailscale/on {v, loginServer?}`**: the coordination server the box should be signed in to, absent for
  Tailscale's own (the runtime always sends the one wanted). The manager compares it with tailscaled's `ControlURL`
  (`""`, `https://controlplane.tailscale.com` and `https://login.tailscale.com` are Tailscale's own): the same server is
  step 4's on (masked `PATCH prefs`, a link only when one is needed); another starts tailscaled again on it,
  `POST start {UpdatePrefs}` with the whole prefs it read and `ControlURL`, `WantRunning: true`, `LoggedOut: false`
  changed, then `POST login-interactive` for a fresh sign-in. The box so leaves the tailnet it was in; tailscaled keeps
  the server in its prefs on `/persist/tailscale` across restarts, so the manager stores nothing of its own.
  tailscaled's `logout` isn't used for the change: it deletes the profile and with it the operator, after which every
  write of the manager is refused (403) until tailscaled restarts (the image now sets the operator again after a
  sign-out, NX-444). An address the contract's `TailscaleLoginServer` doesn't take is 400 `bad_request` (also refused by
  the request's schema first).
- **The state names the server**: `TailscaleStatus.loginServer` from `ControlURL` without a trailing slash, absent for
  Tailscale's own (or for an address the contract can't carry, which only root on the box could have set). Login links
  may be `http://` (a Headscale on the owner's network; `TailscaleLoginUrl` admits it since 1.1.0); which origin an app
  opens is the app's check (`tailscaleLoginUrlTrusted`).
- **`whombat-manager tailscale on --login-server URL`** for root and the manager's user (the install test, remote help).
- **Checked**: the package's fake tailscaled takes `start` and hands back more prefs than the manager reads; the test
  checks that a change keeps them (the operator above all), uses no logout, names the server in the state and admits
  the server's `http://` link, that the same server again changes nothing and Tailscale's own goes back, and that five
  addresses the contract refuses never reach tailscaled; broker tests pass the field through and refuse a bad one. A real
  Headscale: the community install test (IN-430).

## MG-136 The community edition: no control, updates from its own repository (2026-10-24; Whombat HE-58; UP-X27)

- **`"edition"` in manager.json**: `commercial` (or absent: every image before it) or `community`. A community
  configuration must have `control.url` empty (refused otherwise); a commercial one still needs it. The image writes
  `"edition": "community"` and `control.url: ""` only on community images, and `"edition": "community"` into
  update-helper.json.
- **No control client on a community box**: the control loop, `status.report`, `update.progress` (nothing is recorded
  in the outbox), the claim-code lookup lease (the runtime is claimed on the box's own page, Whombat HE-59; no lease is
  pushed to it) and the licence loop don't run. The facts, the claim window, AI clients, host metrics, Tailscale and the
  network guard work as on any box.
- **Updates**: after every successful TUF refresh (`refreshSec`, default an hour) the newest release of the verified
  repository (`trust.NewestRelease`, UP-X27) goes to the engine as an unsigned offer (`update.LatestOffer`: `Raw` empty,
  `Action` install, the release id and tuple digest, `Sequence` = the targets version). The engine treats it as an
  assignment: the same repository state is `already processed`, a new publication with a newer release starts it (or
  queues it while an activation runs), staging, activation, health, known-good, rollback and quarantine are unchanged,
  and no assignment file is written (`syncAssignment` skips an empty one). Nothing newer offers nothing.
- **`whombat-manager check`** (`CheckNow`): refreshes the repository now and offers its newest release; `result` is
  `none` (nothing newer), `unchanged` (offered before) or `assigned` with the engine's decision; `nextCheckS` is the
  refresh interval.
- **Routes that need control** (`/v1/runtime/ticket`, the claim and revocation reports, push, the feedback drops)
  answer 404 `unavailable`; the broker's `Control` and `Support` stay nil, never a nil client inside an interface. The
  network guard keeps a change when the update repository's host answers (port 80 for an `http://` URL without one).
- **Checked**: config tests (community refuses a control URL, commercial needs one, unknown editions refused);
  `update` tests on the test world with a community helper (the newest started, the same targets version a noop, run to
  Healthy without an assignment file, nothing newer, a new publication taken, an older one published later never taken,
  a host release that doesn't boot rolls back and isn't retried without a new publication); a community daemon test (the
  newest healthy through the real loops, facts at the runtime, a check with nothing newer and with a new publication,
  404 for ticket, claimed and push, nothing ever reaching control, no claim lease pushed).

## MG-137 An update waits for running work without locking people out (2026-10-29; Whombat update-wait.md UW-01…UW-03)

John, 2026-10-29: after a DEV release his app couldn't reach Home. The update waited for Dusty's code run, and the
manager held the runtime drained for its 10-minute window, again every 25 minutes; the runtime refused new sessions and
every command while drained. Holding new work back doesn't make a running turn end sooner.

- **Probes, not a held drain.** Entering `WaitingForSafeBoundary` no longer drains. Every `ProbeInterval` (30 s) the
  manager asks with the same `POST /drain` request id: safe, and it keeps the drain (a window of its own, counted for the
  pre-migration checkpoint) and goes on to the metadata refresh, the checkpoint and the activation as before; not safe,
  and it sends `POST /resume` at once (only for a drain it took: not a backup's 409, not a runtime that is down), records
  the blockers and explains them, persisting only when they change. A queued turn waits a moment, a command waits for the
  drain to end (Whombat UW-02), and sessions are admitted throughout (UW-01).
- **Drain windows after `DrainHoldAfter` (6 h) in `WaitingForSafeBoundary`** without a quiet moment (from `PhaseSince`):
  the 10-minute windows and 15-minute rechecks as before, so a box whose work never pauses still updates.
- **While it probes the box isn't in activation** (`Activation()` needs `Deferral.Draining`): a newer assignment replaces
  the waiting candidate instead of queueing behind it, and the backup may take the maintenance lock, which the update
  then waits for.
- **No contract change**: `POST /drain` and `POST /resume` as they are, so old runtimes and new managers keep working.
- **Checked**: a long turn on the test world — never drained between steps, about one probe every 30 s, Healthy at the
  first quiet moment; drain windows only after 6 h; maintenance during the probes and not during a held window; SR-12's
  lost offer at the step that reaches the safe boundary.

## MG-138 What the box keeps in Tailscale's settings (2026-10-30; Whombat tailnet-reach.md TN-04; NX-440, NX-441)

Whoever changed them (root through remote help, a release before this one), the box on a tailnet keeps: no exit node
(`ExitNodeID`, `ExitNodeIP` empty: its own traffic, the relay and updates among it, never leaves through another device),
nothing advertised (`AdvertiseRoutes` empty: it is no subnet router or exit node for the tailnet), no Tailscale SSH or
web client (the direct port stays the only way in from the tailnet; SSH is off in tailscaled anyway, NX-440), shields
down (the direct port answers the tailnet). The tailnet's DNS (`CorpDNS`) is the tailnet's.
- `on` and `sign-in` send them in the same masked prefs as their own change; a new login server's `start` puts them in
  the whole prefs.
- `state` puts them back once on a box that is running without them (one signed in before this release, as Home was),
  never while a change runs, and after a refusal not again for 10 minutes.
- Checked: the package's fake tailscaled (kept on state once, carried by on and sign-in, the refusal's wait, the new
  server's whole prefs without masks); the real tailscaled 1.98.10 took the same masked prefs (a throwaway userspace
  tailscaled on The Titan, in-memory state, never signed in: HTTP 200, the routes, web client and shields cleared); and
  `checks.tailscale-direct` (root's advertised routes, web client and shields up cleared by `on`).

## MG-139 Signed out by the tailnet, the person sees Sign in (2026-10-30; Whombat tailnet-reach.md TN-05)

Found while checking MG-138 in `checks.tailscale-direct` with a way out to Tailscale (the driver run outside a build
sandbox gets real login links):
- **A box tailscaled signed out by itself** (its node key ran out, 180 days by default; removed in the admin console)
  is `NeedsLogin` with no link, since nobody asked for one: the manager mapped it to `starting`, so the person saw
  “Starting…” with no Sign in, for good. `state` now asks tailscaled for a link itself (`login-interactive`) when it
  needs a sign-in, is wanted running and has none: at most once a minute, never while a change runs. The next read has
  the link (`needs_sign_in`), and the runtime tells the person (TN-05). A link nobody opens does nothing.
- **Off with a link still pending is off**: `NeedsLogin` with a link but not wanted running was `needs_sign_in` (Sign
  in shown after the person turned it off). Every way to a sign-in (on, sign-in, another login server) sets it wanted
  first, so the link waits for the next one.
- Checked: `TestSignedOutByTheTailnet` (starting, then the link a read later, asked once within a minute; off with the
  link pending reads off), `TestStatusOf`; `checks.tailscale-direct` (on, then off with Tailscale's link pending, reads
  off).

## MG-140 The tailnet's routes and devices (2026-10-30; Whombat tailnet-reach.md TN-06, TN-07; contracts 3.11.0 CT-1635)

John wants the agent to reach everything on his tailnet.
- **Routes accepted**: `RouteAll` joins what the box keeps (MG-138), so what a subnet router shares is reachable, as
  from the person's other devices. The box's own networks still come first (NX-487, in the image a release before
  this one: a rollback lands on a release with the rule, while tailscaled keeps the preference on /persist). A box
  already on a tailnet (Home) gets it at its first `state` after the update.
- **`POST /v1/tailscale/peers`** (`TailscalePeersRequest` → `TailscalePeersResponse`; the runtime for the agent's
  `tailnet_devices`, and support's Look like the state): tailscaled's `status` peers, online first, then by name, at
  most 500; a MagicDNS name the contract refuses is null, addresses IPv4 first (four at most), `PrimaryRoutes` as
  CIDRs, `lastSeen` only while offline, `ExitNodeOption`. Mullvad's exit nodes (`Location` set) aren't the person's
  devices and are left out. None unless Tailscale is on; tailscaled not answering is 503 `unavailable`; a list that
  breaks the contract is a 500, never sent. `whombat-manager tailscale peers` prints the same.
- Contracts 3.11.0 vendored (from 3.7.0: 3.8–3.10 changed nothing the appliance's Go uses).
- Checked: `TestPeers` (order, Mullvad left out, a bad route dropped, last seen, signed out none), the broker's route
  and callers, `checks.tailscale-direct` (`RouteAll` after on, no devices while not on).

## MG-141 A silent connection to control is pinged and dropped (2026-11-01; with NX-489)

The control client used Go's default transport: one HTTP/2 connection to control (through Cloudflare), kept as long as
requests keep coming. A request that times out on an HTTP/2 connection doesn't close it (Go only counts the cancelled
stream against the connection's concurrency limit, about 100 streams, until a ping answers), so a connection that died
without a word took every request until Linux gave up on it, 16 minutes on Home (NX-489). Nothing reached control:
status, updates, relay tickets for phones, remote help.
- The control client's transport (`controlapi.HealthChecked`, every client without its own `HTTP`, the per-family ones
  too) pings a connection after 15 s without a frame from control and closes it when the ping isn't answered within
  10 s; the next request opens a new connection. A dead connection now costs at most about 25 s plus one request.
- `TestHealthCheckedDropsAStalledConnection`: a proxy stalls an open HTTP/2 connection (keeps it open, passes nothing);
  the next requests are answered over a new connection. Without the health check every request keeps going to the
  stalled one.

## MG-142 The cable's change is guarded like a Wi-Fi join (2026-11-03; Whombat NM-01, NM-02; NX-494, NX-495)

- **The guard** (`netguard/cable.go`, state in `<network state>/cable.json` beside `wifi.json`): a cable change takes
  the maintenance lock, runs `applying` (the helper's `cable-set`, with `deadlineSec` = the confirmation time when
  guarded, so the helper's dead-man is armed before the cable changes), then `confirming` until the manager reaches
  control (`cable-confirm`, `committed`) or the deadline passes (`reverting`, `cable-revert`, `reverted`, failure
  `no_internet`). Guarded only when the box was online before, checked fresh (HD-06, HD-10); unguarded it is
  `committed` once made. A lost helper answer goes `reverting` (failure `failed`); a refusal is `failed`.
- **One change at a time** across wired candidates, Wi-Fi and the cable: each one's start (and `Submit`) refuses while
  any of the three runs (`busy`).
- **Restarts**: the manager's state survives its own restart and the loop carries on from the phase it finds (an
  `applying` change is asked of the helper again by the same id, which answers `alreadyDone`; a deadline that passed
  meanwhile reverts). A host restart while `confirming` puts the kept setting back; the helper's `cable-confirm` then
  answers `cable_not_applied` and the change ends `reverted` (failure `failed`) instead of being kept untried.
- **Refusals** (all 409): `use: wifi` without Wi-Fi to use → `no_wifi`; Wi-Fi not connected to a network with an
  address → `not_connected`; `use: cable` with no carrier on any wired interface → `no_cable`; what is already so →
  `unchanged`; a change running → `busy`. Whether the box uses Wi-Fi only is the helper's answer (`cable-status`).
- Each change is logged (`network.cable_set` with `use`, `by`, `changeId`, and its end). The appliance keeps no signed
  audit log of network changes (Wi-Fi joins aren't in one either), so the log is the record.

## MG-143 `POST /v1/network/cable` (2026-11-03; contracts 3.13.0)

The runtime's uid only, body at most 2 KiB, `CableSetRequest {v, use, confirmTimeoutSec 30…600}` → 202
`CableChangeResponse {v, change}` (checked against the contract and `CableChangeValid` before it leaves, a 500
otherwise). Errors as the Wi-Fi routes (MG-102): 400 `bad_request`, 409 the refusals of MG-142, 503 `unavailable` when
the helper doesn't answer, 404 `unavailable` without a network guard.

## MG-144 What the network state says about cards and Wi-Fi only (2026-11-03; Whombat NM-07, NM-08; contracts 3.13.0)

All optional on the wire, so older runtimes ignore them. Each wired item: `plugged` (its carrier, true also while the
cable is switched off or has no address), `mac` (sysfs `address`, lower case; left out when it isn't six octets or is
all zeros) and `prefixLength` (of `address`, only with it). Wi-Fi: `mac`, and `prefixLength` while connected. The
network: `wifiOnly` (the helper's `cable-status`, asked beside `wifi-status` within the same 1.5 s; left out when the
helper doesn't answer) and `cableChange` (a running change, or one that ended less than 5 minutes ago, like `change`).
A switched-off cable is `connected: false, plugged: true`.

## MG-145 The cable is the backup (2026-11-03; Whombat NM-03)
Superseded in part by MG-147: the backup is guarded, and a try that didn't help waits half an hour.

Only while the box uses Wi-Fi only and no network change runs, the manager checks control every minute (its own loop,
`cable-backup`). When no check has reached control for 5 minutes in a row and a wired interface has carrier, it starts
a cable change `use: cable`, `by: backup`, unguarded (kept once made: Wi-Fi didn't reach control anyway), which ends
Wi-Fi only, and logs it. A check that reaches control, a change, or Wi-Fi only ending starts the count again; without a
plugged cable it keeps counting and acts once one is plugged in.

- Checked (`netguard/cable_test.go`, the real helper over its socket with the fake activator): Wi-Fi only confirmed and
  the cable again; Wi-Fi only without internet reverted; offline kept at once without checks; the refusals and `busy`
  across Wi-Fi, wired and cable; a manager restart before the loop and after the deadline; a host restart while
  confirming; the dead-man; the backup after 5 offline minutes with carrier and not without, nor before 5 minutes.
  `broker` `TestCableRoute`. `checks.wifi` end to end (NX-493…NX-496).

## MG-146 Contracts 3.13.0 vendored ahead of their release (2026-11-03)
Superseded by MG-151 (the released 3.15.0).

The Go module is Whombat's `contracts/go` at `d3daf60d6` (the 3.13 contracts commit) with its tree hash in
`VENDORED.md`, so the appliance builds against the cable's types before `contracts-v3.13.0` is tagged. Replace it with
the release tarball once tagged (same tree expected).

## MG-147 The backup is guarded, and a try that didn't help waits (2026-11-04; Whombat NM-03)

The backup (MG-145) is a guarded change like a person's (2 minutes, the helper's dead-man armed): the cable is kept
only when the manager reaches control with it; otherwise it is switched off again and Wi-Fi only stays. After such a
try (the last cable change `by: backup` ended `reverted`) the next one waits 30 minutes (`BackupRetryAfter`), however
long control stays out of reach. *Why:* the check is a connection to control's endpoint, so a 5-minute internet,
router or DNS outage looked like a broken Wi-Fi: the unguarded cable then ended Wi-Fi only for good (and owners heard
“Wi-Fi stopped reaching Whombat”), and a cable on a network without internet kept the box offline with nothing to
undo it. Checked: `TestCableIsTheBackup` (kept once the cable reaches control), `TestCableBackupThatDoesntHelpIsUndone`.

## MG-148 The cable again is confirmed only once the cable has its address (2026-11-04; Whombat NM-02)

While a `use: cable` change is `confirming`, the manager checks control only once a wired interface is connected (carrier
and an address, so its metric-100 default route is in place); until then it waits a second at a time, and the deadline
reverts as before (`no_internet`, back to Wi-Fi only). *Why:* the helper's `cable-set` answers before DHCP, so the first
check went out over Wi-Fi about a second later and kept a cable it had never tried; a cable without internet then took
the default route and cut the box off. Wi-Fi only isn't held the same way: a USB-tethered phone also counts as wired
without being switched off. Checked: `TestCableAgainWaitsForTheCablesAddress`.

## MG-149 The restore's maintenance lock ends with the restore (2026-11-04; backup BK-39, BK-42)

The broker takes the lock `backup-restore` when it starts a restore (6 hours at most). While a restore holds it, the
broker asks the backup service where the restore is (`GET /v1/quarantine`) every 30 seconds and gives the lock back
when the restore `failed` (it was undone) or was `released` after a moment later than the lock, or when nothing shows
up 15 minutes after the lock was taken (the unit never ran). `restoring` and `checking` (in quarantine, the person's
answers to come) keep it; `POST /v1/backup/restored` still ends it. The check runs in `Serve`, so a manager that
restarted meanwhile picks the lock up again. A backup service that doesn't answer changes nothing: the lock's limit
ends it.

- Checked: `broker` `TestRestoreLockEndsWithTheRestore` (an earlier failure doesn't count, restoring and checking keep
  it, failed, released and never started release it).

## MG-150 The kit's envelopes go to control through the manager (2026-11-04; Whombat backup-passkey.md, spec I2)

`POST /v1/backup/kit-envelopes {envelopes: [{credentialId, salt, envelope, generation}], adoptedFrom?, applianceName?}`,
the runtime only, at most 64 KiB (a device request's limit): checked strictly against the contracts'
`RuntimeKitEnvelopesRequest` (the op's own body: up to 64 envelopes, base64url ids up to 512 and salts up to 64,
`wbkit1.<nonce>.<ciphertext>`, a generation from 0 to 1 000 000, `adoptedFrom` the earlier Whombat's PeerId or device
id, `applianceName` its own name, MG-153), then sent unchanged to control as the device op `kit.envelopes.put`
(`POST /v1/device/kit.envelopes.put`) through `controlapi.Client.Do`, signed with the management key like
`status.report`. It answers control's `{stored, skipped}`, `503 control_unreachable` (with `Retry-After`) when control
can't be reached, `502 control_refused` otherwise, `404` on a box without control.

- Checked: `broker` `TestKitEnvelopesForwarded`, `TestKitEnvelopesCallers`, `TestKitEnvelopesSigned` (the fake
  control verifies the op like every device request).

## MG-151 Contracts 3.15.0 (2026-11-04; Whombat backup v2; supersedes MG-146's provisional module; superseded by MG-153's release)

`third_party/whombat-contracts-go` is the released `whombat-contracts-go-3.15.0.tar.gz` (`contracts-v3.15.0` @
`dd7f3ad9c`, tree `3ef4ef2` = the release's `reproducible.trees.go`), replaced whole per VENDORED.md; `vendorHash`
`sha256-eMqqRafU…` read with a fake hash. The module's own go.mod and go.sum are unchanged, so the root's are too.
What it brings the appliance's Go:
- **`kit.envelopes.put`** is a contract op (`device.KitEnvelopesPutRequest`/`Response`, `local.ManagerPathKitEnvelopes`,
  `local.RuntimeKitEnvelopesRequest`/`Response`): the manager's push moves to `Do` (MG-150) and `SendUnlisted`, the
  broker's own schema and the fake control's own verifier go. The answer handling is unchanged.
- **The backup status** (`local.BackupServiceStatus`) gains `failedAttempts`, `clearing` and `lastSuccess.incomplete`,
  and its reasons take any script on one line: the backup service's `Status.Validate` checks them as they are (BK-75);
  the manager's status client now keeps those members when it reads `GET /v1/status`. `status.report`'s backup part is
  unchanged (control's contract didn't move). The restore's `reason` and a backup's `covered` are session shapes the
  backup service serves itself; no Go type of the contracts carries them.
- The released 3.13.0 is MG-146's tree; 3.14.0 changed only a session vector in the Go module. The harness keeps its
  3.1.0 tarballs, as through 3.2 … 3.14 (it sends no kit push).

## MG-152 The runtime's facts carry the backup service's status (2026-11-04; backup and restore v2 rehearsal)

- Every facts push (`POST /facts`) carries `backup`: the backup service's `GET /v1/status` (`backupclient.Status`, read
  within 5 s, checked against `local.BackupServiceStatus`), or null when there is no backup service, it doesn't answer
  or what it answers isn't the contract's (logged once). The runtime reads null as unknown and then asks the service
  itself.
- A watch loop (`backup-watch`) reads the status every `backupWatchSec` (default 15; the Nix module sets nothing) and
  pushes the facts when the status differs from the one the runtime last got, its `lastSuccess.ageSeconds` and
  `updatedAt` aside (`backupKey`): a backup that finished or failed, one that runs, a new place or generation reach
  the runtime within seconds. The periodic resend (`factsResendSec`) keeps the age fresh.
- Why: the manager always sent `backup: null`. The runtime's backup-key job locks the passkey copy of the backup
  details again when the facts' last backup, repository or generation change; it never saw one change, so control's
  copy and the place's copy lagged up to a day behind every backup (BPK-03), and the job never saw a restore or drain
  in progress.
- Checked: `daemon` `TestBackupStatusReachesTheRuntime` (start-up facts with the status, a new backup within seconds
  though facts are re-sent hourly, an unusable status left out), `TestBackupKeyIgnoresAgeOnly`.

## MG-153 Contracts 3.16.0: the Whombat's name goes with its kits (2026-11-04; backup and restore v2 rehearsal; supersedes MG-151's release; superseded by MG-155's release)

`third_party/whombat-contracts-go` is the released `whombat-contracts-go-3.16.0.tar.gz` (`contracts-v3.16.0` @
`48b4637e4`, tree `4d121ef` = the release's `reproducible.trees.go`), replaced whole per VENDORED.md; `vendorHash`
`sha256-FyRj0Q3y…` read with a fake hash. The module's own go.mod and go.sum are unchanged, so the root's are too.
What it brings the appliance's Go:
- **`kit.envelopes.put` and `local.RuntimeKitEnvelopesRequest` carry `applianceName?`** (1–80 characters, none a
  control, format or separator character but a space, none at either end; CT-1710). The manager's
  `POST /v1/backup/kit-envelopes` checks the runtime's push against the contract and hands it to `Do` as it is, so the
  name reaches control, which lists it on the Whombat's kits; a name outside the pattern is 400 before anything leaves
  the box. Deploy it with or after a control on 3.16.0 (control refused the member before).
- Kit names up to 80, `BackupRestoreState.newPassword`, `BackupRecoveryMaterial.adopted` and session minor 8 are
  session and control shapes; no Go type of the module carries them. The backup service's material writes `adopted`
  in the contract's shape (BK-79).
- Checked: `broker` `TestKitEnvelopesName` (the fake control parses the push with `device.ParseKitEnvelopesPutRequest`).

## MG-154 Shared links go to control through the manager (2026-11-05; Whombat share-links.md)

The runtime keeps a sealed copy of part of a Chat thread at control for a shared link; the key stays in the link, so
the manager forwards bytes it can't read. Three broker routes, the runtime only, each checked strictly against the
contracts' body and sent unchanged as the device op of the same name through `controlapi.Client.Forward`, signed with
the management key; control's answer is checked against the contract and answered as control sent it (200):

| Route | Body (runtime) | Device op | Answer |
|---|---|---|---|
| `POST /v1/runtime/shares/put` | `{shareId, expiresAt?, envelope}`, up to `device.SharePutMaxBytes` (11 MiB) | `share.put` | `{url}` |
| `POST /v1/runtime/shares/delete` | `{shareIds}` (1–200), up to 64 KiB | `share.delete` | `{ok: true}` |
| `POST /v1/runtime/shares/views` | `{shareIds}` (1–200), up to 64 KiB | `share.views` | `{shares: [{shareId, views, lastViewedAt?}]}` |

- **Errors.** Control out of reach (network, 5xx, 429): `503 control_unreachable` with `Retry-After: 300`. Control
  refused: `502 control_refused` whose message starts with control's codes, its error code and then `details.code`
  when there is one (`refused share_taken: …`, `device_revoked device_retired: …`), so the runtime tells
  `share_taken`, `share_limit`, `bad_expiry`, `device_unclaimed` and `device_revoked` apart within the message's 300
  characters. A body above the route's limit, or a signed request above `device.DeviceRequestMaxBytesFor(op)`:
  `413 too_large`, nothing sent. A body outside the contract: `400 bad_request`. A box without control: `404`.
- **Time.** Each exchange with control has 55 s (the control client's default is 30 s, too short for 11 MiB on a slow
  uplink); the runtime waits 60 s, so it hears 503 rather than timing out on the socket.
- **Memory.** At most two puts are handled at once (a third waits): each holds its copy several times while it is
  checked, signed and sent, and the manager's unit has no memory limit.
- The fake control keeps the copies (`Shares`, `ShareViews`, `SharePuts`) and refuses with a code on request
  (`ShareRefuse`); it reads signed requests up to `SharePutMaxBytes` and 1 MiB.
- Checked: `broker` `TestShareForwarded`, `TestShareLargest` (the largest copy the contract allows, through to the
  fake control), `TestShareTooLarge`, `TestShareControlErrors`, `TestShareCallers`, `TestShareSigned`.

## MG-155 Contracts 3.18.0: shared links (2026-11-05; Whombat share-links.md; supersedes MG-153's release)

`third_party/whombat-contracts-go` is the released `whombat-contracts-go-3.18.0.tar.gz` (`contracts-v3.18.0` @
`f12aa9f54`, tree `90bfcbb` = the release's `reproducible.trees.go`, `SHA256SUMS` checked), replaced whole per
VENDORED.md; `vendorHash` `sha256-d0aQbREe…` read with a fake hash. The module's own go.mod and go.sum are unchanged, so
the root's are too. What it brings the appliance's Go is shared links only (MG-154): the device ops `share.put`,
`share.delete` and `share.views` (`device.SharePutRequest` …, `device.ShareMaxEnvelopeBytes` 8 MiB,
`device.SharePutMaxBytes`, which `DeviceRequestMaxBytesFor` gives `share.put`), the manager paths
`local.ManagerPathShare*` and the runtime's bodies (`local.RuntimeShare*`, the ops' own); nothing else in the Go module
differs from 3.16.0. The harness keeps its 3.1.0 tarballs (it shares nothing). Deploy with or after a control on
3.18.0: an older control refuses the ops, which the runtime hears as `502 control_refused`.

## MG-156 The support watch's first look is compared with what control was told (2026-11-13; adds to MG-120)

The start-up `status.report` goes out 5 s after the manager starts and the support watch looks for the first time at
10 s. The watch took that first look as its starting point, so remote help turned on, or off, between the two was never
asked about: control heard of it at the next periodic report, up to 15 minutes later, and until then refused
`support.open` (`remote_help_off`) or still showed a grant the owner had ended.

- The status loop keeps the support state (`supportclient.Key`) of the last report control took (`supportTold`), also
  when the report went without remote help because it didn't validate: control was told what could be.
- The watch compares the first look after such a report with it, once, and every other look with the look before it
  (MG-120). So a change between the start-up report and the first look asks for a report at that look, and so does a
  report control takes only after the watch's first look (a runtime that answers late, a slow answer) that was read
  before a change.
- Before control took any report, and on a box without control, the watch starts from what it sees, as before: the
  first report reads the state when it is sent.
- No timing changed. A `status.report` control doesn't answer: MG-157.
- Tests: `daemon.TestRemoteHelpChangedBeforeTheWatchLooked` (through the running daemon, on and off),
  `daemon.TestSupportWatchComparesWithWhatControlWasTold`.

## MG-157 A status.report control didn't answer is sent again within seconds (2026-11-13; adds to MG-61, MG-120, MG-156)

A report that failed was tried again only with the next periodic one (`statusReportSec`, 5 minutes unless set). So what
a report asked for within seconds was to say (MG-61: an update's outcome; MG-120, MG-156: remote help turned on or
off) still reached control minutes late when control was away at that moment: the network, or control restarting.

- A report control didn't answer (`controlapi.ErrUnavailable`: the network, 5xx, 429) is sent again after 10 s
  (`Waits.StatusRetry`), then after twice as long each time (the daemon's `Backoff`, ±20 %) up to the report interval.
  The first report control takes ends it. Each try reads the state again, so it says what is true then.
- A report control refuses (any other error) waits for the next periodic one, as before: the same report sent again
  soon would get the same answer.
- While control stays away a box sends five reports more in the first five minutes (after 10, 20, 40, 80 and 160 s),
  then one per interval as before.
- Test: `daemon.TestRemoteHelpReachesControlAfterAFailedReport` (through the running daemon; control answers two
  reports 503 and asks for the next in an hour; fails without the change).

## MG-158 A checkpoint request that lost its connection is asked again within seconds (2026-11-15; adds to MD-06)

A pre-migration checkpoint request whose connection to the backup service failed (EOF, connection refused or reset, a
broken pipe) waited for the next update window, although the backup service hadn't refused anything. The backup API
is socket-activated and restarts when the seal unit seals a new destination's secrets, which the first checkpoint
after `destination set` itself triggers: the restore drill (upgrade gate 7, whombat-20261114.11) lost its update to
that race, and a box whose owner had just set a destination would postpone its update by a window the same way.

- A lost connection is asked again after `Policy.CheckpointRetry` (5 s), up to `Policy.CheckpointRetries` (3) times,
  inside the same drain window (the drain lease is renewed meanwhile). The first answer ends it.
- An answer the backup service gave (412 unprotected, a failed snapshot, an unverified checkpoint) is not asked again:
  the update waits for the next window with the reason, as before.
- The seal stays as it is: whatever restarts the API, the manager's request survives it.
- Tests: `update.TestCheckpointRetriedAfterLostConnection` (fails without the change), `TestCheckpointRetriesAreBounded`,
  `TestCheckpointRefusalNotRetried`.

## MG-159 Ask before updating: the owner's switch and approval (2026-11-16; Whombat ask-before-updating.md, UP-X28)

The owner can make every update wait for their yes. The manager keeps the switch (`AskFirst`) and the approval
(`Approved`, a release id) in its update journal and enforces them itself.

- **The gate.** With the switch on, a staged candidate waits with reason `owner` until the owner approved its release:
  checked right after a hold, before a maintenance lock and the window. Once approved it goes on like any update
  (running work, a checkpoint, the window). The installed release keeps running meanwhile.
- **What waits.** Every candidate that comes from an offer: runtime-only, host, a custody rollback, the community
  edition's newest release. Going back to known-good and an activation already past the gate never reach it.
- **One release per yes.** The approval stays while that candidate is in flight: a renewed assignment, a retry after a
  failure before anything changed, a forward repair that only that release finishes. It ends when the candidate is
  installed, rolled back or quarantined, or another release (or the installed one) is assigned. So a later offer of
  the same release, and a retry after a rollback, ask again.
- **Off** lets one that waits go ahead at the next step.
- **Routes.** `POST /v1/update/ask` and `POST /v1/update/approve`, the runtime's uid only, at most 1 KiB, strict
  contract bodies. Approving when nothing waits for the owner, or another release, is `409 not_waiting`. Both wake the
  engine; their journal write pushes fresh facts to the runtime.
- **Concurrent writes.** Both fields are foreign fields (SR-13), retried on a conflict like the hold.
- **What leaves the box.** The runtime's facts always carry `askFirst` and the reason `owner`; `whombat-manager
  status` explains the wait. Control hears an owner wait as `hold` (`update.WaitingReport`): its contracts before 4.2
  refuse `owner`, and the reason is the owner's business. No device op sets the switch or approves.
- **A wait that ends is written at once.** When a hold, lock, window or the owner's wait ends while the update waits
  for the safe boundary, the journal says so before the next probe, so facts and reports drop the old reason.
- **Contracts 4.2.0**, vendored ahead of their release (Whombat `2293640b3`, VENDORED.md); `vendorHash`
  `sha256-UmVdhZKC…`, computed with `go mod vendor` and `nix hash path` after the same method gave the old hash.
- Tests: update `TestAskFirstWaitsForTheOwner` (runtime and host), `TestApproveOnlyTheReleaseThatWaits`,
  `TestSwitchOffLetsTheWaitingUpdateGo`, `TestANewerAssignmentAfterAnApprovalWaitsAgain`,
  `TestRollbackToKnownGoodNeverWaits` (runtime and host), `TestCustodyRollbackWaitsForTheOwner`,
  `TestCommunityReleaseWaitsForTheOwner`, `TestOwnerWaitWhileWaitingForRunningWork`,
  `TestAskFirstDuringTheActivationStepIsKept`, `TestApprovalAndAHoldKeepEachOther`; broker `TestAskAndApproveRoutes`,
  `TestAskAndApproveForTheRuntimeOnly`, `TestAskBodyLimit`, `TestFactsCarryTheOwnersWait`; daemon
  `TestAnOwnerWaitReachesControlAsAHold`.

## MG-160 Ask before updating off at the box (2026-11-16; Whombat ask-before-updating.md ABU-08, MG-159, NX-514)

With the switch on, only the owner's yes in the apps lets an update install. A release that breaks the apps but passes
the health checks would leave the fix waiting for a yes nobody can give. The box's own screen is the way out: the
recovery menu turns the switch off (NX-514), and the update that waited installs by itself once the box runs again.

- **`whombat-manager ask-off --journal <dir>`**, run without a configuration (the recovery environment has none): it
  removes `askFirst` and `approved` from the newest journal state and adds a history note (`update.AskOffNote`). It
  edits the state as it is on disk, so fields a newer manager wrote stay, and gives the journal's files back to the
  folder's owner (the menu runs as root). Already off: nothing is written.
- **Only with no manager running.** A running manager keeps its own sequence and would write over the change, so the
  command refuses while a manager answers on `/run/whombat-manager/api.sock`; there the apps turn the switch off.
- **No approval at the box.** Off covers the case (the waiting update goes ahead) and needs no release id, which the
  person at the screen would have to read and type.
- **Why no more is asked** than the menu's other choices ask: whoever is at the screen can already export or erase the
  box's data from the same menu. The runtime's signed audit log doesn't record it (the runtime isn't running); the
  journal's history does, and the apps show the switch off.
- Tests: update `TestAskOffAtTheBoxLetsTheWaitingUpdateGo`, `TestAskOffAtTheBoxEndsAnApproval`,
  `TestAskOffAtTheBoxWithTheSwitchOff`, `TestAskOffAtTheBoxKeepsWhatItDoesNotKnow`, `TestAskOffAtTheBoxWithoutAJournal`.

## MG-161 The own address: on by the device's env, no configuration field (2026-11-18; Whombat own-address.md)

Each Whombat serves its own page at `<label>.box.whombat.app` (DEV: `<label>.dev.whombat.app`), with TLS ending on the
box. The manager keeps the label, the certificate and its watch (`manager/internal/ownaddress`); the runtime draws the
label and serves the page. Contracts **4.3.0** (the release tarball, VENDORED.md; `vendorHash` `sha256-pNeRzl8l…`,
computed with `go mod vendor` and `nix hash path`, which gave the old hash for the commit before).

- **When it is on.** A commercial box of env `dev` or `prod` (`/persist/identity/device.json`). Never on a community
  box (no control to register a name with). `WHOMBAT_OWN_ADDRESS` overrides: `off`; `on` and `staging` (Let's Encrypt
  staging), which also switch it on for env `local`, as the dev stack's own appliance and the DEV image (NX-516)
  need; `pebble:<directory URL>` for tests (never on a prod box), which alone honours `WHOMBAT_OWN_ADDRESS_CA` (the test directory's roots),
  `_PROBE` (the DNS stand-in's host:port) and `_CT` (a fake Cert Spotter; unset: no watch, so a test label never
  reaches the real one). An unknown value leaves it off and says so in the log.
- **Zone and directory from the env**, not from new configuration fields: the configuration refuses unknown fields, so
  a field an image set would break a rollback to an older known-good manager. `prod` → `box.whombat.app`, otherwise
  `dev.whombat.app`; both Let's Encrypt production. (Zones superseded by MG-186.)
- **State** in `<dir of journalDir>/own-address/` (`/persist/manager/own-address/`, 0700, every file 0600, the
  manager user's; also a tmpfiles entry): `state.json` (label, host, registeredAt, the current and previous pair's
  serials and the directory the current one came from), `account.key`, `<serial>.key` and `<serial>.pem` for the
  current and previous pair, `ordered.json`, `ct.json`. A saved name under another zone is forgotten at start.
  (The zone rule and the files superseded by MG-186, MG-188.)
- **Never fatal.** A problem setting it up leaves the box without an own address, as an older manager, and the
  manager runs on. It runs in the recovery manager too: a page whose certificate runs out helps nobody.
- Tests: `ownaddress.TestResolve`, `config.TestNoOwnAddressField`, daemon `TestOwnAddressOnByEnv`,
  `TestOwnAddressSwitchedOff`.

## MG-162 The certificate: ACME TLS-ALPN-01, a new key per order, renewal at two thirds (2026-11-18)

- `golang.org/x/crypto/acme` (already in `go.mod`), TLS-ALPN-01 only, ECDSA P-256, an account without a contact
  address, **a new key for every order**. The chain must name the host and carry this order's key.
- **The order that finishes later.** `CreateOrderCert` waits on the finalize answer's `Location`, which RFC 8555
  doesn't require; Pebble always, and Let's Encrypt for some orders, sends none, and the call fails with an empty URL.
  The orderer keeps the order's URL from `AuthorizeOrder`, waits on it and fetches the chain (spike/door.md, goal 1).
- **Renewal at two thirds** of the lifetime. A pair from another directory (staging before production) is replaced at
  once. The previous pair stays on disk beside the new one, for a runtime that fetched it a moment before.
- **Retries forever**, from 1 minute doubling up to 6 hours; a 429 waits its `Retry-After`. The ACME client's own
  retries are kept to a few seconds (a bad nonce, a 5xx), and never for a 429.
- **States** (`acme.state`): `idle` (no label), `probing`, `ordering`, `valid` (with `nextAttemptAt` the renewal),
  `failing` with `error` (`probe_failed`, `validation_failed`, `rate_limited`, `ca_unreachable`, `order_failed`) and
  `nextAttemptAt`. A failing renewal still reports the current pair.
- Tests: `TestServiceOrdersAndRenewsAtTwoThirds`, `TestServiceRetriesWithBackoff`, `TestServiceRetryCapsAtSixHours`;
  against Pebble (`WHOMBAT_PEBBLE`, in an `agent-resource run` task): `TestPebbleOrder` (through the door stand-in,
  the later-finishing order, keys only in the state directory, a new key per order), `TestPebbleRetryAfterAFailedValidation`,
  `TestPebbleRenewsAtTwoThirds`.

## MG-163 The ACME socket (2026-11-18)

`acme.sock` beside the local API's socket (`/run/whombat-manager/acme.sock`, `OWN_ADDRESS_ACME_SOCKET`; 0660 in the
setgid `whombat-api` directory). The runtime pipes each `acme` door stream into one connection, byte for byte, and
never parses it.

- Only the runtime's uid (kernel credentials); anything else is closed at once.
- It answers only ALPN exactly `acme-tls/1`, only for its own host, and only with a pending challenge certificate or
  the probe's (a challenge first). Anything else gets a TLS alert and a close.
- At most 8 connections at once (`OWN_ADDRESS_ACME_CONNECTIONS_MAX`); more are closed before a byte is read. One
  connection is the handshake, within 10 s.
- Tests: `TestResponderAnswersOnlyAPendingChallenge` (with and without one, `h2` and mixed lists refused),
  `TestResponderRefusesAnotherPeer`, `TestResponderClosesTheNinthConnection`, `TestResponderBindReplacesOnlyAStaleSocket`.

## MG-164 A probe of the whole path before every order (2026-11-18; plan D5)

Before every order the manager dials its own name on 443 with ALPN `acme-tls/1`, as a validator would, and expects back
a one-off self-signed certificate it just handed the responder. That checks DNS → door → relay → runtime → manager
without a new runtime ↔ manager message, and spends nothing of Let's Encrypt's 5 failed validations an hour per name.
A failed probe is `probe_failed` and retries like a failed order, except in the first 3 minutes after the label arrived
or the loop started without a certificate: then it is tried again in 5 s, outside the backoff (Whombat
`docs/decisions/whombat-link.md` LNK-86).

- Tests: `TestProbePasses`, `TestProbeFailsOnAnotherCertificate`, `TestProbeFailsWithNothingThere`.

## MG-165 The certificate watch: Cert Spotter, keyless, no catch-up (2026-11-18; design §6, plan D14)

- `GET https://api.certspotter.com/v1/issuances?domain=<host>&include_subdomains=true&match_wildcards=true&expand=dns_names&expand=issuer`,
  `User-Agent: whombat-box`, following `after=` until an empty page (at most 10 pages), every 6 h ± 30 min. The box
  calls Cert Spotter itself; nothing at Cybex sits in between.
- **What counts:** only a complete answer in full. A 5xx, a page out of shape or an issuance it can't read is no check
  at all. A 429 waits as told (an hour without `Retry-After`); other errors retry from an hour, doubling up to 6 hours.
- **Names kept:** the host, any name under it, and exactly `*.<zone>`; `*.whombat.app` covers no two-level name and is
  dropped. Each certificate keeps only those names. (Superseded by MG-189: every served host, `*.<zone>` of each host's
  own zone.)
- **Missed windows:** more than 12 hours between fresh checks (from the start of watching, or across downtime) is a
  window, closed at the next fresh check; `/ct` adds the open one up to now. After a restart the watch waits for the
  next regular check rather than asking at once, so restarts don't spend the keyless quota.
- **No catch-up source**: none free keeps expired certificates (design §6).
- Tests: `TestCTKeepsOnlyNamesThatConcernTheBox`, `TestCTFollowsPages`, `TestCTNeverCountsAnErrorAsACheck`,
  `TestCTRecordsMissedWindows` (13 hours from the start, downtime, another name), `TestCTRunWaitsOutRestartsAndBacksOff`.

## MG-166 The broker's own-address routes and the ticket cache (2026-11-18)

- `POST /v1/own-address/state` answers `enabled: false` where there is none (a runtime then does nothing about it).
  `register`, `cert` and `ct` answer `404 own_address.off` there. The runtime's uid only, 1 KiB, strict bodies.
- **Register** forwards `address.register` once. Control's host must be the label under the box's own zone, or the
  answer is refused (`502 control_refused`, logged). Then the label is saved and the cached appliance tickets dropped,
  so the next ticket comes from control and can carry `lbl`. Once the manager has a label it is the answer, whatever
  the runtime sends, and control isn't asked again. `label_taken` / `label_invalid` → `409 own_address.label_taken` /
  `.label_invalid`; control out of reach (429 included) → `503 control_unreachable`; other refusals → `502
  control_refused` with control's codes first.
- **Cert** is the current pair with its host, or `409 own_address.no_cert`. (Amended by MG-190: a host may be named.)
- **Forwarded as sent**, like the shared links: `/v1/runtime/account/link-lookup`, `/v1/runtime/account/link` and
  `/v1/backup/kit-credentials` (the device ops `account.link.lookup`, `account.link`, `kit.credentials.declare`), checked
  both ways against the contract, control's refusal codes leading the message.
- Tests: broker `TestOwnAddressOff`, `TestOwnAddressRegister` (bad bodies, taken, control down, persisted, the ticket
  cache dropped, the saved label answered), `TestOwnAddressRegisterRefusesAHostMismatch`, `TestOwnAddressCertAndCallers`,
  `TestOwnAddressOnlyForTheRuntime`, `TestAccountLinkAndKitCredentialsForwarded`.

## MG-167 A cached ticket asked for again is replaced, at most once a minute (2026-11-18; loopback integration finding)

On a rollback, control's `lbl` switch goes off and then the relay goes back. The manager's cached appliance ticket
still carried `lbl`, which the older relay refuses (4401) on every reconnect: the box was off the relay for 3 min 20 s,
until the cache ran out.

- **The signal, without a contract change.** The runtime keeps the ticket it was handed and asks the manager again only
  when its own copy is nearly used up (the cached one then is too, and is replaced as before), after a restart, after
  its own address changed, or after a relay refused it (4401). So a cached ticket asked for again more than
  `TicketRefresh` (a minute) after it came from control is replaced by a fresh one. `RuntimeTicketRequest` is strict
  and carries only `class`, so the runtime has no other way to say “refused” in contracts 4.3.
- **The guard.** At most one control call per class a minute, however often a relay that keeps refusing makes the
  runtime ask; meanwhile the cached ticket goes out as before. Control out of reach or refusing: the cached ticket
  still goes out, and control is tried again a minute later.
- **The cost.** A runtime restart now costs one more ticket from control; nothing else asks again.
- Test: broker `TestTicketAskedAgainIsRefreshed` (fails without the change).

## MG-170 The Link state lives in a journal of its own (2026-11-18; Whombat LNK-02, LNK-05, LNK-06)

`manager/internal/link` keeps the box's Whombat Link state, `off · starting · on · grace · ended`, in
`/persist/manager/link/` (the journal package's two slots), not in the update journal: the engine saves its whole state
at every step, so a second writer there would lose changes, and an older manager after a rollback simply never reads it.
Control is the authority: the record takes whatever control said last, from `link.begin`, `link.status`, `link.leave`
and every `ticket.issue` answer (`TicketIssueResponse.link`), except while the owner's change runs or the box is
leaving. The record also keeps the owner's pending wish (`want`, the reach file's `reachSeq`), the content proof and the
name (so an expired code is renewed without the runtime), and `carried` (below).

- **First state.** A box control registered before Link (`device.json`'s `applianceRoute` is control's, not `local`: Home
  and the DEV stack box, LNK-37) starts `on` with `carried`, so it keeps working as it did until control says otherwise; a
  control from before Link (404 on `link.status`) leaves it so. Every other box starts `off`.
- **Polling.** *In part amended by Whombat LNK-88: every 2 s for the first half hour of codes, then every 5 s.* None while `off`. While a code shows, `link.status` every 5 s; waiting for an address every minute; on
  hourly; grace every 15 minutes; ended every 6 hours (so the box sees its owner subscribe again). A code that ran out is
  renewed with `link.begin`. Failures back off from 15 s to 30 minutes.
- **Off.** Turning Link off takes effect on the box at once (`leaving`): every Link feature stops, and `link.leave` is
  sent again until control takes it. The label stays the box's (LNK-06).

## MG-171 The Link gate and the Link routes (2026-11-18; Whombat LNK-03, LNK-05, LNK-07, LNK-36)

Every broker route that goes to control asks the Link state first. Link features need `starting`, `on` or `grace`:
tickets, remote help's support ticket, shares, the feedback drop, kit envelope copies, the own address's label and its
state (`enabled` false otherwise), `push.register`. What is never gated needs only that control knows the box (any state
but `off`): claim and revocation reports, `push.send` (control lets only security pushes through once Link ended),
`push.unregister`. Off means off (Whombat LNK-54): once the owner turned Link off no push goes, `security` included;
only an ended Link (not paid) still sends `security` pushes. Refused: 404 `unavailable`, as on a box without control. New routes (contracts 4.4): `/v1/link/state`
(answered at once from the record), `/v1/link/on` (`link.begin` with the box's registration: `device.json`'s members,
the management key's proof and the runtime's content proof; a registration that doesn't verify never leaves the box),
`/v1/link/off` (answers `off` at once and forgets the cached tickets), `/v1/runtime/push/register|unregister` (the device
ops' bodies, forwarded). Errors as `LINK_ERRORS`. A ticket answer's Link state goes to the keeper.

## MG-172 With Link off the box asks control nothing (2026-11-18; Whombat LNK-03, LNK-31)

The daemon's control loops all wait for Link: the assignment poll answers `none` without calling, status reports,
update reports (they stay in the outbox), the own address's loop (started and stopped with Link) and the claim lease
(only on a box control registered before Link: every other box is claimed on its own page) send nothing while Link
isn't `starting`, `on` or `grace`. The network guard checks a change against the update repository, not control. Once
control speaks Link (it answered a Link state), remote help's report is `support.heartbeat` every `nextS` and at once on
a change, not `status.report`; a carried box on a control from before Link keeps `status.report`. Test: daemon
`TestLinkOffAsksControlNothing`.

## MG-173 The licence is inert (2026-11-18; Whombat LNK-04)

The licence loop no longer runs and `/v1/licence/renew` answers 404 `unavailable`; a token the box holds still goes to its
runtime, so the release before finds it after a rollback. The code and its state file stay until phase 2. The loop's
renewal tests retired with the behaviour (LNK-53); `TestLicenceInert` checks that nothing is renewed.

## MG-174 The environment and the reach choice at start (2026-11-18; Whombat LNK-01a, LNK-12, LNK-15)

The daemon reads the environment resolved at boot (`/run/whombat/environment/environment.json`, NX-520): control's
address and the own address's zone come from it; without one (an image before it) the configuration's `control.url`
stands for it; one that didn't resolve leaves the box without Link. No configuration field is added: an older
known-good manager reads the same `manager.json` and refuses unknown fields. At its start the manager acts once on each
`seq` of the owner's reach choice (`/persist/whombat/reach.json`, NX-521): Link wanted → `link.begin` until control
answers (the network may not be up at the first start); Link not wanted on a box control knows → off; Tailscale wanted →
on, with the owner's login server. A Link label control gives is registered by the manager (`address.register`) and its
certificate ordered (LNK-13).

## MG-175 whombat-manager reach and environment (2026-11-18; Whombat LNK-12, LNK-50)

`whombat-manager reach link|tailscale|tailscale-on [--file F]` is the recovery menu's: it writes the next `seq` of the
reach choice, also when the file already says so (the owner may have turned Link off in the apps since).
`whombat-manager environment show|set <env> [--if-absent]|write-run` is root's: `set dev --if-absent` is the bridge
release's one-shot (idempotent, never over a choice made), `write-run` is whombat-environment.service.

## MG-176 environment set moves a box to another control (2026-11-19; Whombat ONE-06; amends MG-175)

`whombat-manager environment set <env>` (root, the manager stopped: it refuses while the manager answers on its socket)
moves the box (manager/internal/envmove): when the new environment's control is another one, the Link state and the own
address's state go aside into `/persist/manager/environment-moves/<UTC time>-<from>/` (root 0700), so the manager starts
with Link off (or acts on the owner's reach choice again: its seq starts over) and gets a new label and certificate
under the new zone; the kept registration (`/persist/identity/registration.json`) is signed again with the management
and content keys for the new env; the identity's env (`device.json`) becomes the new environment's `deviceEnv`, every
other member as it was; the environment file last. Each step is skipped when done, so a second run finishes a move that
stopped. Only an identity the box made itself (route `local`, LNK-01) moves: one control made names that control's
device. `set dev --if-absent` stays the bridge's: the environment file only.

What signs or pins the env, checked: the registration's two proofs cover it (`device.RegistrationSigningBytes`), so the
kept one is signed again and the runtime signs a fresh one from `device.json` at link.begin; control takes the env from
that registration (production refuses `local`, `wrong_environment`). Nothing else does: the device id and the keys don't
name it, remote help's certificates name the device id and come from the environment's CA (a new grant after the move),
backups carry no env, the relay knows the box by the tickets control issues, the helper reads the identity's env at each
start (production rules then apply: no development TUF key). The AI client channel's key document must be of the new env
(`manifest/prod/client-channel-keys.json`, NX-522), or the box installs no new clients until it is.

## MG-177 An environment move is all or nothing (2026-11-19; R1 #13; amends MG-176)

`envmove.Move` works the whole move out before it changes anything: the environments, the identity (an identity
control made is refused), the kept registration signed again in memory with both keys (checked against device.json),
the state that goes aside; then it tries every folder it writes to (a file made and removed in the identity's, the
environment file's and the moves folder) and that the state can be renamed into the moves folder (one file system). The
moves folder is root's alone, `/persist/environment-moves` (tmpfiles, 0700; made by the move when missing), never under
`/persist/manager`, which the manager owns: it must be a folder of the caller's user, not a link, and nothing in it is
written through one (`O_EXCL|O_NOFOLLOW`). Each move's folder `<UTC time>-<from>/` gets its record (`record.json`: what
changes, which files were there), the files as they were (`before/`), the files as they will be (`new/`), and
`/persist/environment-moves/pending` names it; only then do the four steps run (the state aside, the registration, the
identity, the environment file), each only when it isn't done yet. A step that fails is undone from `before/`, the state
renamed back. A move that stopped (power, a crash) is finished by `envmove.Recover`, which `environment set` runs first
and `environment recover` runs at every boot (whombat-environment-move.service: root, before whombat-environment and
required by it and by every unit that reads the environment, the manager and its recovery first), and undone when it
can't be finished. The boot goes on only after a finished move or a confirmed undo (R2 A9): when a move can be neither,
the unit fails with the reason on the console and in the journal, the move's record stays, and the manager, its
recovery, the runtime, the runner, remote help and self-provisioning don't start; `environment write-run` also refuses
while a move is under way, so the old environment is never resolved for a moved identity. The next boot, or `whombat-
manager environment recover` once the cause is fixed, carries on. Why: Home must never start half moved, on DEV with its address state gone or on DEV
control with a production identity.

## MG-178 A move to another control adopts an identity control made; environment undo (2026-11-20; Whombat ONE-06, LNK-01; amends MG-176, MG-177)

Home's identity was made by DEV control on 2026-10-20, before LNK-01 (route `rt_…`, env `local`, no kept registration),
so MG-176's move refused it. **Adopted**: when the box moves to an environment with another control, an identity whose
route isn't `local` becomes the box's own, as every box's is since LNK-01: route `local`, env the new environment's
`deviceEnv`, the device id, keys and every other member as they were; a kept registration signed for the new env with
both keys is written when there was none, so the manager can begin Link from the reach choice or the recovery menu
without the runtime (`whombat-manager reach link`). The old route names a device of the old control only; the new
control introduces the device at its first `link.begin`. Within one control an identity control made still can't change
env (`ErrControlIdentity`). The move's record, `before/` and `new/` carry it like the env change: a failed step or a
stop is undone or finished the same way. **`whombat-manager environment undo`** (the manager stopped) puts the newest
finished move back from its copies: the identity byte for byte, the registration (removed when the move made it), the
environment file, the Link and own-address state it set aside (what the manager made since goes into the move's
`after/`); it refuses when any of those changed since (`ErrMovedSince`) and when the newest move was undone already.

What the route changes on the box (checked in the code): the manager's `registeredAtControl` is false, so no claim
lease and no carried Link state (Link starts `off`, or begins from the reach choice), and assignments are moot (a box
with a channel takes its channel's newest). The runtime reads the same route (`registeredAtControl` in
`apps/server/src/managed/link/origin.ts`): the box is a box-made one like every new production box: `runtime.edition`
`community`, its pages are its own, it is joined at its address (screen letters, a device link, a box passkey, the
recovery key: own-address.md OWA-15), revocations count as applied, links point at the app's origin, and the hosted
passkeys' relying party is none; Link features follow the Link state (`linkRuns`). The claim (`claimConsumedAt`), the
owner, the members and all their data are the database's and don't change. No runtime change is needed.

## MG-179 The move copies the Link and own-address state between subvolumes (2026-11-20; Whombat ONE-06; amends MG-177, MG-178)

On an installed box `/persist/manager` is a btrfs subvolume of its own; `/persist/environment-moves`, the identity and
the environment file are in `/persist`'s top subvolume. A rename between the two fails with EXDEV, so MG-177's
same-file-system preflight refused every move on a real box (Home, 2026-11-20: “/persist/manager and
/persist/environment-moves are on other file systems”). Now nothing is renamed across them:

- **Set aside**: `link` and `own-address` are copied into the move's folder as `<name>.copying` (files with their bytes,
  modes, owners and times, folders with their modes and owners, links as links; every file and folder synced), checked
  against the original entry by entry (kind, mode, owner, bytes, link target, nothing more), renamed to `<name>` in that
  folder, and only then removed from the manager's folder. A finished copy is never made again; a removal that stopped
  is done again.
- **Put back** (a failed move's undo, the boot's undo, `environment undo`): the move's copy is copied into the manager's
  folder as `.<name>.restoring`, checked, what is there removed, then renamed into place; nothing is done when what is
  there is that copy already.
- **`environment undo`** first keeps what the manager made since (production's state) in the move's `after/`, the same
  way, and is now recorded: `<moves>/pending` says `undo <move>` before it changes anything, so a stop is finished at
  the next boot (`environment recover`, `whombat-environment-move.service`) or by running it again, never half done.
- **Preflight**: the moves folder takes a file and has room for the copies and 32 MiB more (`statfs`); `environment
  undo` checks room for `after/` and for the copy back. The state may hold only files, folders and links.
- **Tests** run every move and undo with renames across the manager's folder refused with EXDEV (`TestMain`), stopped at
  every new step (finished at boot or by running again) and failed at every new step (undone, the state the same entry
  by entry).

The boot's units name the manager by its store path (`whombat-environment-move.service`, `whombat-environment.service`)
and the recovery menu has it on its PATH; only an ad hoc `systemd-run` needs `/run/current-system/sw/bin/whombat-manager`.

## MG-180 Tailscale stays wanted until its first sign-in (2026-11-20; a stranger's install test; amends MG-135)

An Expert box (the installer's Tailscale choice) restarted before its owner signed in to Tailscale never showed a
sign-in link again: its screen only said that the code appears once the box has a secure address. tailscaled saves a
profile's prefs only once the profile has signed in (`ipnlocal.profileManager.SetPrefs`, tailscale 1.98.10), so after a
restart a box that never signed in was off again, on Tailscale's own server, and nothing asked for a link: the reach
choice had been acted on once, and `state` asks for a link only when tailscaled wants to run (MG-139). MG-135's “the
manager stores nothing of its own” holds only once a box has signed in.

- **The want file** `/persist/manager/tailscale.json` (`{v, on, loginServer?}`, beside the journal like
  `licence.json`, 0644: nothing secret): `on` and `sign-in` write `on: true` with the login server (`on` before it asks
  tailscaled, so a restart before tailscaled answered still finds it); `off` writes `on: false`; the first `state` read
  that finds Tailscale running writes `on: false` too, as tailscaled keeps it from then on. The command line
  (`whombat-manager tailscale`) uses the same file.
- **At every start** (`applyReach`, whether or not the reach choice is new) the manager turns Tailscale on again while
  the file says `on`, with its login server: a fresh sign-in link. Tried ten times, 30 s apart, as the reach choice is.
- **tailscaled restarted alone** (an update, a crash): a `state` read that finds the file `on` and tailscaled not
  wanting to run turns it on again, in the background, at most once a minute.
- **Signed in means saved**: tailscaled is running a moment before it saves the new profile, and a restart in between
  loses the sign-in. The want ends only once `profiles/current` has an id.
- **No link asked for right after a sign-in** (amends MG-139): between the registration and the first map tailscaled
  wants a sign-in with no link for a moment, and a `state` read then asked for a link, which starts a new sign-in and
  throws the one just made away (seen in the VM test). `state` now asks only once that state has lasted 10 s.
- **A box from before the file** has none: when its reach choice wants Tailscale and tailscaled never signed in (no
  node key), the choice stands as if the file said `on`; a box that signed in before gets `on: false`, so an owner's
  off stays off.
- Checked: the package's fake tailscaled (a restart that forgets everything, the login server kept, signed in ends it,
  off stays off, tailscaled restarted alone, a box from before the file) and `checks.tailscale-first-sign-in`: a real
  Headscale behind HTTPS, the installer's choice, a restart before the sign-in, a fresh link, signing in with it,
  tailscaled keeping it, and off staying off.

## MG-181 The box's name reaches control while Link runs (2026-11-20; Whombat LNK-56, control CL-245)

- An Easy box links at its first start, before its setup asks for a name, so control had none: the account site said
  “Your Whombat”. The runtime now calls `POST /v1/link/on` with the box's name whenever the box is named or renamed
  while Link is on or in grace (and at its start), as it does when its owner turns Link on.
- While Link runs, `Keeper.On` with a name is a rename: a name control was already given (the record's `Name`) costs
  no call; a new one is sent with `link.begin` (control keeps a name it carries, without a new code), but only after
  `link.status` says Link still runs. `link.begin` on a box whose Link ended meanwhile would start it again with a fresh
  code. No contracts change: the local route and control's op already carry the name.
- Checked: `TestANameWhileLinkRunsGoesToControlOnce` (a new name once, the same one never again, kept across a restart,
  nothing when control ended Link).

## MG-182 The first start finds its release in either channel and follows the one that lists it (2026-11-20; Whombat ONE-02, LNK-21; amends MG-20, UP-X34)

- The same installer goes to Beta first and, unchanged, to Production when it is promoted. A box installed from a Beta
  installer (and from a Production one before its promotion reached the update repository) found its release only in
  the development channel, while the image's default channel is production. `whombat-manager provision` looked there
  only, failed, and the provisioning unit tried again for ever: the manager and the runtime never started and the
  screen said “Starting Whombat…” for good.
- `provision --factory-release` now asks the helper for the box's channel, refreshes TUF in it and looks for the
  release there; when that channel doesn't list it, it looks in the other channel (`factory.Finder`,
  `tufclient.Client.RefreshIn`). Found there, the helper records that channel (`set-channel`), the box's own channel
  is refreshed again (the mirror the helper verifies from ends with that view) and the release is recorded. So the box
  follows the channel its installer came from: a Beta installer's box follows Beta (its owner can move it in Settings →
  This Whombat → Updates), a Production installer's box stays on Production, also when Beta lists the same release.
- A release no channel lists exits 3, an update repository that can't be read exits 4 (`provision`'s exit statuses;
  the provisioning unit tells the console, NX-526). A helper that doesn't answer is an error of its own, never “not
  listed”: without a channel the refresh would read the top-level targets, which list no release.
- The manager changes the channel here without the runtime's route (UP-X34): at the first start nobody owns the box
  yet, and the helper still verifies the release through that channel's signed role.
- Why not the installer's own channel: the ISO is built once and goes to Beta and then to Production unchanged, so it
  can't know which. A promotion slower than an install isn't a real risk: `promote` puts the installer on the download
  site only after releases.whombat.com lists the release in Production, and the download and install take longer than
  the metadata's ten-minute cache.
- Checked: `manager/internal/factory` (with the real helper: a Beta-only release moves the box to development and
  `seed-factory` then verifies it; a promoted one stays on production; not listed; out of reach; no channels) and
  `checks.install-vm` (NX-526).

## MG-183 A required claim window stays off on a box control registered (2026-11-21; Whombat LNK-73)

- `claimWindowRequired` makes the runtime refuse a claim outside a claim window. The manager never opens one (it sends
  `openUntil: null`; a hardware button was never wired), and the screen's New letters opens one only on a box claimed
  on its own pages (Whombat LNK-61). A box control registered before Whombat Link is claimed through control, where
  neither exists: required there, it could never be claimed.
- The image keeps it off for every box (`claimWindowRequired = false` in `nix/modules/manager.nix`, not an option), and
  the manager now sends `required: false` for a box control registered whatever its configuration file says
  (`Daemon.claimWindowRequired`; a warning in the log, once). A box claimed on its own pages keeps the setting: there
  the person at the box can open the window.
- Checked: `manager/internal/daemon` `TestClaimWindowRequiredOnlyWhereItCanBeOpened`.

## MG-184 Claude Code comes from Anthropic's own download site (2026-11-21; John, before the public launch)

- Whombat installs Claude Code but doesn't hand out a copy of its own: for a Claude bundle whose source is a bare
  executable (`binary`) at `https://downloads.claude.ai/claude-code-releases/…`, the manager downloads that address
  straight into the version's folder, never past the signed size, and installs it only when its size and SHA-256 match
  the channel's executable (and the channel's source and executable agree). The channel stays the signed statement of
  which version Whombat tested and what its bytes are; Anthropic's site only delivers them.
- No fallback to the TUF artifact: a site that doesn't answer, or a file that doesn't match, fails the install (what
  was installed keeps running and the retry backs off as before). A bundle on any other address (another host or port,
  a path outside `claude-code-releases`, a query) and Codex install from the TUF artifact as before.
- The download uses its own HTTPS client: bounded waits to connect and for an answer, redirects only to HTTPS. The
  box's egress already allows port 443 for the manager.
- The update host keeps publishing the artifact while boxes run an older manager, which knows only that path. Once
  Production runs this manager, the publisher stops uploading Claude Code and its copies leave the update repository.
- Checked: `manager/internal/clients` `TestClaudeComesFromAnthropic`, `TestClaudeElsewhereComesFromItsTarget`,
  `TestClaudeSiteDown`, and `TestDigestMismatch` (a corrupt file on Anthropic's site; a channel whose source and
  executable disagree).

## MG-185 The claim link goes to control with link.status (2026-11-22; Whombat own-address.md OWA-39, LNK-79)

- The runtime hands the box's claim link (its six letters) to the manager on `POST /v1/link/claim` while nobody
  claimed the box and its own address serves its page, again when it changes, and without it once there is none. The
  manager keeps it in memory only (it is a secret; the runtime gives it again after a restart) and sends it in every
  `link.status` body (`claimLink`, contracts 4.13). A link it didn't have wakes the Link loop, so control has it within
  moments: the person who just linked the box waits for it on the account site. It is never logged and never in the
  local Link state.
- A control from before 4.13 refuses the member (strict body: 400 `validation_failed`, `bad_body`). The manager then
  asks again without it, so the box's Link state never depends on the link, and offers it again an hour later.
- A box whose Link is off sends nothing, claim link or not (LNK-03).
- Checked: `manager/internal/link` `TestTheClaimLinkGoesWithLinkStatus`, `TestAControlBeforeClaimLinksStillGivesTheState`;
  `manager/internal/broker` `TestLinkClaimRoute`.

## MG-186 The own address's zones: prod's two, the host from control (2026-11-23; Whombat own-address.md, own names)

Names are now chosen and changed, and prod's zone is `whombat.app` directly. The manager takes the box's host from
control (`address.register`, `address.rename`, `link.status` `host`) and checks only that it is the label directly
under one of its environment's zones.

- **Zones per environment** (`ownaddress.ZonesOf`): prod `whombat.app` and its earlier `box.whombat.app` (where boxes
  stay until they move); dev `dev.whombat.app` alone. The nix prod environment names `ownAddressZone = "whombat.app"`
  (flake check); a prod box whose environment names no zone takes `whombat.app` too; an image that still names
  `box.whombat.app` gets the same two. An environment zone that is none of Whombat's leaves the own address off (logged),
  as no host from control could ever fit it.
- **`ZoneOf(host)`**: the longest of the three zones the host is directly under; a zone itself (`box.whombat.app`,
  `dev.whombat.app`) is never a box's host, and a label must have the contract's shape and length (3–32).
- **`Open` keeps a saved address under any of the environment's zones**: an update that changes the zone never wipes a
  box's address and certificate. Only an address under none of them (a box moved between dev and prod) is forgotten.
- Tests: `TestResolve`, `TestZones`, `TestOpenKeepsAnAddressUnderAnEarlierZone`, `TestAdoptChecksEveryHost`.

## MG-187 The box moves itself to control's zone, once (2026-11-23; Whombat own-address.md, own names)

- The Link state keeps control's view of the address from every `link.status` and ticket answer: `host`, `zone` (the
  zone new names get) and `leaving` (`Record.Host`, `.Zone`, `.AddressLeaving`; a control that names the zone without a
  leaving address means none, an older control's silence keeps what the box knows). A change of any of them, or Link
  becoming active, runs `followAddress`, and so does a timer every 30 minutes while Link is active (a move that failed
  is tried again then).
- **The move**: the box's host is under `box.whombat.app`, control names another of its zones, control's host is the
  box's own, and nothing is leaving (neither the box nor control knows one) → `address.rename` with the box's own label.
  Only updated boxes move; an older box stays at `<label>.box.whombat.app`, which keeps working.
- **A rename the box missed**: control's host differs from the box's and control names the box's host as leaving (its
  answer to the rename never arrived) → the box takes control's address as a rename. Without that sign the box keeps
  its own: a `link.status` answer fetched before the box's own rename must not take it back.
- One `followAddress` at a time; each reads the newest state.
- The Link record's label and host follow a rename or a move at once (`Keeper.FollowAddress`), before control's next
  answer says so.
- Tests: daemon `TestOwnAddressMovesItself`; link `TestTheAddressFollowsControl`; broker `TestOwnAddressMove`.

## MG-188 The leaving address: served with its pair, never ordered, then forgotten (2026-11-23; Whombat own-address.md)

- `state.json` gains `leaving {label, host, until, pair}` (`Previous` still means the current host's previous pair). A
  rename or a move whose answer names the box's current host as leaving keeps that host with its current pair; the new
  host has no pair yet and is probed and ordered at once (the quick probes of a new label apply).
- It is served until `min(until, the pair's notAfter)`; **no order is ever made for it** (Let's Encrypt's weekly budget
  is the new host's). The order loop wakes at that time; then the leaving address is forgotten and its pair's files
  removed. An older manager reading `state.json` ignores the field.
- **At most one.** A rename while one is leaving keeps it when control names it (its date as control says), and the
  name in between stops at once with its pair. A leaving address without a pair (renamed before its certificate came)
  leaves nothing to serve and isn't kept. An answer without `leaving` never ends one early: its date does.
- A certificate that arrives for a host the box left during the order is dropped (and so is the probe's: the loop
  starts over with the new host).
- `/v1/own-address/state` answers `leaving {label, host, until}` with the effective end.
- Tests: `TestMoveKeepsTheOldPairAsLeaving`, `TestRenameAndRenameDuringLeaving`, `TestLeavingStopsAndIsForgotten`,
  `TestRenameBeforeACertificateLeavesNothing`, `TestOrderForALeftHostIsDropped`; against Pebble `TestPebbleRename`.

## MG-189 The certificate watch covers every served host (2026-11-23; Whombat own-address.md)

- The watch follows the hosts the box answers at (current first, then leaving): a new host starts at once without a
  restart, a host no longer served stops and its record goes. Each host has its own record, `ct-<host>.json`; an older
  manager's `ct.json` counts for its host and goes once that host's own record is written.
- **Names kept per host**: the host, names under it, and exactly `*.<zone>` of that host's own zone. So for a host
  under `whombat.app` the two Cloudflare `*.whombat.app` certificates (valid to 2027-02-16) reach the runtime, which
  knows them and decides what is foreign; for a host under `box.whombat.app` they are not kept, as before.
- **One answer for all** (`/v1/own-address/ct`, `hosts`): `checkingSince` is the latest host's start, `lastFreshAt` the
  oldest host's last fresh check (none while any host has none), `missed` every host's windows, `certs` every host's,
  each once. It never claims more than each host's own record.
- Tests: `TestCTOverTwoHosts`, `TestCTTakesAnOlderRecord`, `TestRelevantNamesPerZone`.

## MG-190 The broker's routes for names (2026-11-23; Whombat own-address.md, contracts 4.16)

```
POST /v1/own-address/cert   {v:1, host?}  → 200 OwnAddressCertResponse | 404 own_address.off | 409 own_address.no_cert
POST /v1/own-address/check  {v:1, label}  → 200 {v:1, label, verdict} | 404 own_address.off | 409 own_address.link_off
                                             | 503 control_unreachable | 502 control_refused
POST /v1/own-address/rename {v:1, label}  → 200 OwnAddressStateResponse | 404 own_address.off | 409 own_address.
                                             label_taken / .label_invalid / .label_reserved / .rename_limit / .link_off
                                             | 503 control_unreachable | 502 control_refused
```

- `cert` without `host` is the current host's; with the leaving host its pair; any other host `409 own_address.no_cert`.
- `check` and `rename` go to control signed by the box (`address.check`, `address.rename`), only while Link is
  starting, on or in grace (otherwise `409 own_address.link_off`, control isn't asked). Control's `own_address_off` is
  `404 own_address.off`; its `link_off` is `409 own_address.link_off`.
- A rename's answer is taken like the move's (MG-188), the cached tickets are dropped (the next carries the new `lbl`
  and the leaving `plbl`), the Link state names the new label, and the route answers the new state.
- `register` keeps its rule: once the box has a label that is the answer (a new name is a rename).
- fakecontrol: `address.check`, `address.rename` (rename, move, limit, at most one leaving), `link.status` and tickets
  with `host`, `zone`, `leaving`.
- Tests: broker `TestOwnAddressCheckAndRename`, `TestOwnAddressMove`, `TestOwnAddressOff`, `TestOwnAddressOnlyForTheRuntime`.
