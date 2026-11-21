# Whombat robust updates, from DEV to PROD — implementation orchestrator prompt

Give this entire file to the lead coding agent. It is an implementation assignment, not a study. It follows the
production incident of 2026-09-28 (control `docs/decisions/hosting.md` HZ-28, HZ-29) and the partial fix that
shipped with it (appliance MG-43, NX-103, NX-104; contracts CT-134; Whombat MD-12).

---

You are the lead architect and implementation orchestrator for Whombat's update system. Use specialist sub-agents
where work is parallel; own the design, the integration, the commits and the completion yourself.

**Do the implementation. Do not stop after a plan, a spec or a list of TODOs.** Inspect the real code, decide the
open details, build every workstream below across the repositories, test it, prove it end to end on DEV and then on
PROD as described in section 9, and report.

## 1. Goal

Every change to a Whombat — runtime (server + runner), host (NixOS image, manager, update helper), hosted services
(control, relay, web, embed, admin) and clients (web, Android) — reaches production through **one pipeline with the
same stages every time**: build → validate → prove the upgrade on DEV through the real update chain → publish to
PROD in staged waves → observe → complete or stop automatically. No step depends on someone remembering an order,
a box is never stranded, a bad release never reaches more than its first wave, and an owner's data is protected
before anything irreversible happens.

Concretely, when you finish:

1. A release of any class (host, runtime-only, with or without a database migration, additive or breaking) installs
   on an enrolled box by itself, or is refused **before** anything changes, with a reason people can read.
2. Versions only ever move forward in a way the box can verify; a new release is never refused because of how a
   commit hash sorts.
3. Before a release is published to PROD it has been installed **as an update** on a DEV box running the previous
   PROD release, through the real manager, helper, TUF repository and control — not only started from scratch.
4. PROD rollouts are staged with health observation and automatic pause; failures are visible with their message
   and alert the operator.
5. The hosted web app and the boxes can be updated independently: every client tolerates runtimes one or two
   releases older and newer within the supported window, and a runtime that needs a newer client says so.
6. Every box has, or is clearly told it lacks, a backup destination; breaking migrations never run without a
   verified checkpoint.

## 2. What happened (read before designing)

2026-09-28, production box `wb-old0-prod-0001` (Incus VM `whombat-prod-box` on the dev machine, release
`pve-20260928.4`, runtime Whombat `2be6fc1`, schema 48) was assigned `pve-20260928.5` (host release, runtime
`e8474971`, schema 49 via the additive migration `0048_capabilities`):

- The manager refused it with `schema_incompatible` and quarantined it; the box stayed healthy on `.4`. Cause:
  `checkSchema` in `manager/internal/update/engine.go` called `release.CheckActivation` with the **pre-migration**
  schema, while Whombat runtimes declare in their tuple that they read only their own newest schema
  (`compat.json` `runtime.readsFrom` = newest migration), so **no release with a migration could ever install**.
  Behind it, every new schema also demanded a backup checkpoint, and the box had no backup destination.
- Control only received the failure **code**; the message was on the box, which has no shell access for operators.
- Candidate 0.18.0 had passed every gate, 132 scenarios and VM tests: nothing in the pipeline installs a candidate as
  an **update** of the previous PROD release through the real image. The DEV instance runs the managed stack
  directly (`dev/up`), not through the manager.
- The hosted web app had to be deployed before the runtime and then rolled back by hand, because older clients refuse
  data from newer runtimes (closed unions, contracts CT-130) and newer clients call endpoints older runtimes lack.
- Fix shipped the same day: Whombat MD-12 (`whombat schema-check --json` reports its target schema and that schema's
  reader/writer floors), contracts 0.21.0 CT-134 (`CheckMigratingActivation`, Go and TS), appliance MG-43 (the
  manager judges a migrating candidate by its target schema; additive migrations need no checkpoint), NX-103 VM test
  `update-migration`, NX-104 image runtime `195421a4`. Because the box's old manager predates MG-43, it was
  **reinstalled** from `pve-20260928.6` instead of updated: the old device record had to be retired first (the VM
  keeps its hardware serial). New box `wb-old0-prod-0002`, claimed by John, healthy on `pve-20260928.6`.
- Found and **not yet fixed** (section 5): runtime versions `0.1.0-<shortrev>` compare as text, so roughly every
  other runtime release will be refused as a downgrade; rollback of custody to an older runtime after an additive
  migration is refused by the tuple-only check; the new box has no backup destination and no recovery kit; control's
  deploy tool only knows one-wave rollouts; the fixed path has never performed a real PROD update.

## 3. What exists (rely on it, do not rediscover it)

- **Appliance** (`~/Code/whombat-appliance`, main `6723564` or newer; decisions `docs/decisions/{manager,nixos,
  integration,prod-image,backup}.md`, last ids MG-43, NX-104, IN-93, PI-20): the manager (`manager/`: journal, states
  `Assigned → Staged → WaitingForSafeBoundary → Activating → Verifying → Healthy`, `RolledBack`, `Quarantined`,
  `ForwardRepairRequired`; `checkSchema`, `takeCheckpoint`, safe-boundary drain, recovery manager), the update helper
  (`helper/`: typed root ops, re-verification, `pkg/trust/forward.go` `CheckForward` / `CompareVersions` and
  TUF-signed `allowDowngradeFrom`, MA-21c), release tools (`release-tools/cmd/tufrepo`: `export-release`,
  `publish-release`, `assign`, `hold`, keys, `refresh`), the build (`release/build-proxmox <env> <id>
  [--reuse-host <build.json>]`, output `~/.cache/whombat-releases/<id>/`), the runtime package
  (`nix/packages/runtime/default.nix`: `version = "${releaseVersion}-${shortRev}${patchTag}"`, flake input
  `whombat`, `checks.runtime-pin` against `manifest/candidates/<candidate>.json`), candidates and pins
  (`manifest/candidates/*.json`, `manifest/pins.json` — note: pins were last promoted at `2026.09.26-rc.1`), the
  harness (`harness validate`: gates, scenarios `harness/scenarios/*.scenario.ts` incl. `i-updates` with a **fake
  activator**, demo), VM tests (`vm-tests/`: `update-migration`, `install-proxmox-vm`, `manager-units`,
  `runtime-real`, `browser-real`, …), the DEV instance (`docs/runbooks/dev-instance.md`, unit `whombat-stack-dev`,
  `dev/up`, `dev/publish-release <release dir> --rollout <device>` for a DEV box on the dev TUF repository), runbooks
  `release-build.md`, `updates.md`, `rollback.md`, `updates-release-signing.md`, `install.md`,
  `factory-reset.md`, `replacement.md`, `backup.md`, `pilot.md`.
- **Control and PROD hosting** (`~/Code/whombat-api`, decisions `docs/decisions/{control,hosting}.md`, last HZ-29):
  rollouts (`src/rollout/service.ts`: `computeDesired`, waves with cohorts `internal|pilot|canary|general`,
  `basisPoints`, `minObservationS`, `failureThresholdBp`, `minSample`; per-device buckets; `notOlder` by release
  `createdAt`; assignments signed, TTL 24 h; the box re-checks after `nextCheckS` = 300 s while a rollout is open, 3600
  s idle), operator API (`/v1/operator/rollouts/:id/{pause,resume,promote,stop}`, `/v1/operator/devices/:id/
  {retire,release,internal,assignment}`, emergency stop, releases, cohorts), device status (`update.state`,
  `failure` **code only**, health), tuple `clientFloor` (control.md, CT-53), the PROD host (Hetzner
  `203.0.113.44`, `infra/hetzner/deploy.sh control|relay|web|embed|admin|updates|tuf-*|release|iso|iso-link|
  self-install|clients-*`; TUF keys online on the host, custody `online-pilot`, root expiry warnings in
  `tuf-status`; `release … --rollout` creates **one wave at 100 %**), the admin panel (whombat-app `apps/admin`).
- **Runtime** (`~/Code/Whombat`, `docs/decisions/managed-db.md` MD-01…MD-12, `managed-runtime.md`): schema versions
  are journal positions, `apps/server/src/db/migrations/compat.json` (per-migration class `expand|backfill|contract|
  incompatible` and reader/writer floors; `runtime.readsFrom|writesFrom`), `apps/server/src/db/compat.ts`
  (`evaluateSchema`), `whombat schema-check --json` (`whombat.schema-check/1`, with `target {version, tag, readers,
  writers}` since MD-12) and `whombat migrate --json [--checkpoint]`, managed boot refusals (exit 10), health.
- **Contracts** (`~/Code/whombat-contracts`, 0.21.0, CT-134): `packages/release` (tuple, `CheckActivation`,
  `CheckMigratingActivation`, `ProtocolOverlap`, `ServesClient`, `ClientBelowFloor`) mirrored in `go/release` with
  vectors; control contracts (rollouts, devices); protocol version (`1000`); the closed-union policy (CT-130: older
  apps and runners refuse answers carrying a new enum member).
- **Clients** (`~/Code/whombat-app`, 0.11.1, AP-254): the hosted web (`build:web:hosted`, session transport over the
  relay) served by `deploy.sh web`, the embed, the admin panel, Android (`apps/mobile`).
- **This machine**: Incus (DEV/PROD-like VMs; John's PROD box is `whombat-prod-box`, device `wb-old0-prod-0002`), Nix,
  the DEV managed stack, `~/.cache/whombat-releases/` (built releases incl. `pve-20260928.{4,5,6}`). `TMPDIR=
  ~/.cache/wb-tmp` everywhere (`/tmp` runs out of inodes). The host's active `gh` account may be a test account, which
  can't see the private repositories: push and fetch with the maintainer account's token per command
  (`git -c credential.helper= -c credential.helper='!f() { echo username=x-access-token; echo "password=$(gh auth
  token --user <the maintainer account>)"; }; f' …`; for Nix, the same through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
  `GIT_CONFIG_VALUE_n`). Never change the global gh account.

Settled rules that bind you: TUF signing and custody (PI-05; keys never leave the Hetzner host), forward-only with
TUF-signed `allowDowngradeFrom` (MA-21c), the safe boundary (never kill acknowledged work for an update), checkpoints
before contract migrations (MD-06), the manager/helper split (typed root ops only), MG-43/CT-134/MD-12 as shipped,
and `CLAUDE.md` in each repo. Decision prefixes for this work: `UP-` (a new `docs/decisions/updates.md` in the
appliance repo, the index for this workstream) plus each repo's own series (MG-44+, NX-105+, IN-94+, PI-21+, HZ-30+,
CT-135+, MD-13+, AP-255+).

## 4. Workstreams

### U-A Versions that only move forward

- UP-A1 **One version scheme per component, totally ordered and verifiable.** Runtime: replace `0.1.0-<shortrev>`
  with a form `CompareVersions` orders by build, e.g. `<semver>-<commit time UTC YYYYMMDDHHMMSS>.<shortrev>` (the flake
  input's `lastModifiedDate`), or a monotonic build number from the pipeline — decide and document why. Host: the
  release id (`pve-YYYYMMDD.N`) is already ordered; state it. Manager/helper: version from the appliance build, not a
  constant `0.1.0`. App and embed: their semver.
- UP-A2 **The transition is safe**: from `0.1.0-195421a` (the PROD box) and every `0.1.0-<hex>` in the field to the
  new scheme, the first new release must compare newer. Prove it with tests over the published releases' versions
  (`~/.cache/whombat-releases/*/tuple.json`, the TUF repository's targets) and, where a box could compare older,
  sign `allowDowngradeFrom` for that transition explicitly.
- UP-A3 **The build refuses a release that isn't newer** than the newest published one of its environment (checked
  against the TUF repository before signing), with a clear message.

### U-B Compatibility across versions

- UP-B1 **Write down the compatibility model** (runtime ↔ database schema, runtime ↔ host ABI, runtime ↔ protocol,
  runtime ↔ clients) in `docs/decisions/updates.md`, including the meaning of every tuple range, and make the code
  match it: `CheckActivation` (exit 0), `CheckMigratingActivation` (exit 10), the helper's forward check, control's
  `notOlder`.
- UP-B2 **Custody rollback after an additive migration**: assigning an older runtime release after an `expand`
  migration is refused today by the tuple-only check although that runtime reads and writes the migrated database
  (the old binary's own floors check says so). Make the exit-0 path use the same floors (the candidate's schema check
  answers `newer_compatible`), with tests and a VM case.
- UP-B3 **Clients tolerate skew.** Choose the support window (e.g. the hosted web and Android serve runtimes from N-2
  to N+1) and implement it:
  - Parsing: responses and frames with enum members or card kinds a client doesn't know are shown as “unknown”
    (never a failed screen); contracts provide the tolerant decoders (`z.catch`-style or a preprocessor), with tests
    that feed a 0.19-era client 0.21 data and vice versa. Update CT-130's policy accordingly.
  - Capabilities: the runtime advertises what it supports (a `features` list or its contracts version in
    `RuntimeFacts`/session hello); the web hides or explains features the connected box lacks (“Update your Whombat to
    use Spend”) instead of calling missing endpoints.
  - Floors: a runtime release that needs a newer client sets the tuple's `clientFloor` (CT-53); clients below it get
    the existing “update the app” path. The pipeline refuses to publish a runtime whose floor the deployed web doesn't
    meet.
- UP-B4 **Hosted deploys check the fleet**: `deploy.sh web|embed|control|relay` refuses (with `--force` for an
  emergency) when the new build falls outside the window of the runtimes the fleet actually runs (from control's
  device status), and prints the order to use.

### U-C Release pipeline and gates

- UP-C1 **One command per stage** (a script in the appliance repo, e.g. `release/ship <env> …`, wrapping what exists):
  `build` (candidate + release + ISO, clean tree, pins checked), `validate` (gates, all scenarios, demo, the VM
  gates below), `publish dev`, `promote prod` (section U-E). Each stage writes a signed or hashed record next to the
  release (`build.json` exists; add `gates.json`, `upgrade-gates.json`, `dev-soak.json`), and the next stage refuses
  to run without the previous record for the same release id.
- UP-C2 **Upgrade gates in VMs with real releases** (the missing gate of 2026-09-28), run against the actual previous
  releases (their published closures) and the candidate:
  1. the current PROD release → candidate, through manager, helper, TUF and a control fake, with a populated
     database; healthy, data intact;
  2. the release before that (N-2) → candidate (a box that skipped one);
  3. fresh install from the candidate's ISO, claim, first boot healthy;
  4. a candidate made to fail verification → automatic rollback to N-1, healthy, no data lost;
  5. migration classes: additive (no checkpoint), breaking with a backup destination (checkpoint, migrate), breaking
     without one (waits, nothing changed) — `update-migration` covers part; extend it;
  6. runtime-only release on the previous host (`--reuse-host`), and a host release that keeps the runtime.
  Make them a required gate of `validate` for PROD candidates; keep their run time reasonable (share images, cache
  closures).
- UP-C3 **Release notes and records**: every release gets generated notes (components and commits since the previous
  release, migrations with their class, client floor, known issues) kept with the release and shown in the admin
  panel.
- UP-C4 Promote `manifest/pins.json` as part of `promote prod` (it is stale today), so pins always name what PROD runs.

### U-D DEV exercises the real update chain

- UP-D1 **A DEV box**: an Incus VM on this machine installed from the DEV ISO, enrolled with DEV control
  (`api-dev.whombat.com`), marked `internal`, running the previous DEV release; `publish dev` delivers each candidate
  to it through the DEV TUF repository and a rollout (`dev/publish-release … --rollout <device>`), exactly as PROD
  will. The managed stack from `dev/up` stays for fast iteration but is not the gate.
- UP-D2 **Soak**: a candidate must be Healthy on the DEV box for a configurable time (default 2 h) with no failed
  update, runtime restarts or health regressions, plus a scripted smoke (sign in, post, agent turn with the scripted
  provider, browser available) before `promote prod` is allowed.
- UP-D3 The DEV runbook describes the flow; the DEV box is rebuilt from scratch by one command when it breaks.

### U-E PROD rollouts with safety

- UP-E1 **Staged waves** by default: `promote prod` creates a rollout `internal → pilot → canary → general` with
  observation windows and failure thresholds (control supports them; `deploy.sh release --rollout` only makes one
  wave — extend it: `--waves default|all-at-once|<file>`), and promotes waves automatically when the window passes
  cleanly (or leaves promotion to the operator: decide, document).
- UP-E2 **Automatic stop**: control pauses the rollout when a device in the current wave fails, rolls back or
  quarantines; `promote prod` reports it. Emergency stop documented and tested.
- UP-E3 **Failure detail reaches control**: the manager reports the failure message (bounded, no secrets) with the
  code, and control stores and shows it (device status, admin panel). Today only `schema_incompatible` arrived.
- UP-E4 **Owners are told**: an update that waits (safe boundary, checkpoint, window) or fails is shown to the
  owner in the web app (Settings → This Whombat) with what it waits for; a successful update says what changed
  (release notes summary). Optional maintenance window per org (`notBefore`, already in assignments).
- UP-E5 **Reinstall and replacement** as a supported flow: retiring or releasing the old device record when a box is
  reinstalled on the same hardware (same serial), documented in `factory-reset.md` / `replacement.md` and offered in
  the admin panel; stale unclaimed registrations are cleaned up.
- UP-E6 **Boxes on managers before MG-43** can't take a migrating release: the pipeline detects that from the device
  status (manager version, after UP-A1) and refuses to assign such a release to them, pointing to a host release
  without a migration first or a reinstall.

### U-F Data safety

- UP-F1 **Backups on by default**: claiming a box (or its first owner sign-in) asks for a backup destination
  (S3-compatible bucket, SFTP/NAS, or a local disk; the backup service's `restic` destinations) and a recovery kit;
  until one exists the web app says so and what it blocks (breaking migrations). `whombat-backup` destinations as they
  exist (`backup.md`); extend only what's missing.
- UP-F2 **Checkpoint before every migration that isn't read-write compatible**, and a restore drill in a VM test:
  restore the checkpoint of a failed breaking migration onto a fresh box, data intact.

### U-G Observability and alerts

- UP-G1 An **admin panel page** for releases and rollouts: per release its gates, soak and notes; per rollout the
  waves, devices, states, failures with messages, and the actions (pause, resume, promote, stop).
- UP-G2 **Alerts** to the operator (email to the operator account; push where configured) for: a rollout paused or
  stopped, a device failed/rolled back/quarantined, a device unseen for a day, TUF timestamp or root near expiry
  (`tuf-status` warns today only when run), the client channel near expiry, backups failing.
- UP-G3 `deploy.sh status` (or `release/ship status`) prints the whole picture in one screen: hosted components and
  their versions, the fleet by release, open rollouts, alerts.

### U-H Docs

- `docs/decisions/updates.md` (UP-…) as the index, each repo's decision entries, and **one runbook “Shipping a
  release, DEV to PROD”** (`docs/runbooks/shipping.md`) that replaces the scattered steps: prerequisites, the
  commands per stage, what each gate proves, how to read a failure, how to stop, roll back, reinstall. Update
  `release-build.md`, `updates.md`, `rollback.md`, `dev-instance.md`, control `infra/hetzner/README.md`.

## 5. Known issues to fix (with evidence)

1. Runtime version ordering (`helper/pkg/trust/forward.go CompareVersions`: the part after `-` compares lexically; a
   runtime `0.1.0-0abc123` is “older” than `0.1.0-195421a`) — U-A.
2. No upgrade gate through the real chain (2026-09-28) — U-C2, U-D.
3. Failure messages don't reach control (`device_updates.failure` is a code) — UP-E3.
4. One-wave PROD rollouts (`deploy.sh release … --rollout`) — UP-E1.
5. Hosted web vs runtime skew handled by hand (HZ-28: web rolled back) — UP-B3, UP-B4.
6. Custody rollback after an additive migration refused (exit-0 path) — UP-B2.
7. Reinstall on the same hardware needs a manual retire (HZ-29) — UP-E5.
8. The PROD box has no backup destination and no recovery kit (`backup: unconfigured`, `recoveryKit: not_created`)
   — U-F (the box is John's; configure it with him, don't invent credentials).
9. `manifest/pins.json` stale since `2026.09.26-rc.1` — UP-C4.
10. The runtime's refusal of a plain export op carries no `details.code: use_export_stream` (appliance h4 note) —
    small, fix while in the area.
11. Manager version is a constant `0.1.0` in the tuple — UP-A1, UP-E6.
12. `nextCheckS` is 3600 s when idle: a new rollout reaches an idle box only up to an hour later — decide whether a
    push nudge (the relay already reaches boxes) or a shorter idle interval is right; document the expected latency.

## 6. Repositories, branches, numbering

| Repo | Branch | Ids |
|---|---|---|
| the appliance | `robust-updates` | UP- (new `docs/decisions/updates.md`), MG-44+, NX-105+, IN-94+, PI-21+, BK- (backup.md) as needed |
| control | `robust-updates` | HZ-30+, control.md entries |
| Whombat (runtime) | `robust-updates` | MD-13+ |
| whombat-contracts | `robust-updates` | CT-135+; a minor release (0.22.0) when shapes change; vendor where needed |
| whombat-app | `robust-updates` | AP-255+; a release (0.12.0) when clients change |

Use worktrees under `~/Code/.wt/<repo>-robust-updates`. One writer at a time for contracts, lockfiles and manifests.
Other people and agents work in these checkouts at the same time: check each main before merging, never reset shared
containers (`docker compose down -v` is forbidden), use free ports and throwaway databases, `TMPDIR=~/.cache/wb-tmp`.

## 7. Method and order

0. Read the repos' `CLAUDE.md`, the decision files and runbooks in section 3, control HZ-15…HZ-29, and the code
   paths named above. Write `docs/decisions/updates.md` first (the requirements above as decisions, plus the details
   you settle), and a ledger (`docs/implementation/robust-updates/{plan,ledger,verification}.md` in the appliance
   repo) that you keep current so the work survives context limits.
1. U-A (versions) and UP-B1/UP-B2 first: they unblock every later release. Contracts changes in one release.
2. In parallel: U-C (pipeline and VM gates), U-D (DEV box and soak), UP-B3/UP-B4 (clients and hosted checks), U-E
   (rollouts, failure detail, owner messages, reinstall flow), U-F (backups), U-G (observability).
3. Integrate; run every gate; build the first candidate through the new pipeline.
4. Independent review, two lenses: security (TUF and signing paths, downgrade and rollback rules, what failure
   messages may contain, admin actions, backup credentials) and operations (can a person on call understand and stop a
   bad rollout from the panel and the runbook alone). Fix every confirmed finding.
5. Prove it (section 9) and ship (section 10).

Sub-agents get owned files, inputs, outputs, tests and a completion criterion; they do not merge each other's work or
stop shared services. Report progress to John in percentages at each phase boundary.

## 8. Verification (all must pass before shipping)

- Unit tests: the version scheme and the transition from every published version; `CompareVersions`;
  `CheckActivation` / `CheckMigratingActivation` / the exit-0 floors path (Go and TS, vectors); tolerant decoders;
  client floors; rollout wave logic and automatic pause; failure-message bounds.
- VM gates (UP-C2 1–6) green against the real previous releases; `update-migration` extended; a restore drill.
- Harness: `validate` on the new candidate with every scenario, plus the new upgrade gates as part of it.
- Skew tests: the hosted web at the new version against a runtime one and two releases older (session transport,
  harness), and the previous web against the new runtime; Android against both.
- DEV: three consecutive releases delivered to the DEV box through the new pipeline and soaked — (a) a runtime-only
  release, (b) a host release, (c) a runtime release with an additive migration — each applied automatically; one
  deliberately bad release rolled back automatically and the rollout paused with its message visible in the panel.

## 9. PROD proof (ask John before each step; he has said to decide everything else yourself)

- Before any PROD step, send John the exact plan (release, waves, what changes on his box, how to stop) and wait for
  his yes in the chat. Never reinstall, retire or release a device, or touch another organization's device, without it.
- Then: deploy the hosted changes in the order the fleet check prints; ship the first release built by the new
  pipeline to John's box (`wb-old0-prod-0002`, Incus `whombat-prod-box`) as a staged rollout (it is the whole fleet, so
  every wave contains only it) and watch it apply by itself; then ship a small runtime-only release to prove the
  runtime path and the version transition (UP-A2) on the real box. Record both in HZ entries with evidence (device
  states, timings, rollout records).
- Take an Incus snapshot of `whombat-prod-box` and a control database dump before each PROD step; state in the record
  whether they were needed.

## 10. Delivery

- Merge each repo's `robust-updates` branch into `main` with `git merge --no-ff`, check that `HEAD` moved, delete the
  branch, push `main` and tags (contracts, app). Commit messages: imperative, one concern each, ending with the
  attribution line the repo's `CLAUDE.md` prescribes.
- Deploy DEV as the runbooks say (the managed stack and the DEV box), then PROD per section 9.
- Finish with: what changed per repo with commits and versions, the pipeline commands and what each gate proves, the
  DEV and PROD evidence, the decisions you took, and what was left out and why.

## 11. Out of scope, and do not

- No new signing custody (offline keys, HSM) — keep online-pilot; note what it would take (PI-12).
- No iOS pipeline, no app-store releases; no second PROD host; no change to how boxes are claimed.
- Do not weaken the forward-only rule, the safe boundary or the checkpoint rule to make a test pass; do not bypass TUF
  or control to update a box; do not touch production without John's yes (section 9); do not change the global `gh`
  account; do not reopen settled decisions — record new ones.
