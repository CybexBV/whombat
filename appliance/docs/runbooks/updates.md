# Appliance updates: operating the manager (development)

> Commands written `dev/<name>` are the maintainers' (`bin/<name>` in their private whombat-ops). Anyone can run
> the same code: `node harness/src/dev/<name>.ts` (`dev/prune` is `prune-copies.ts`, `dev/devbox` is
> `harness/src/devbox/main.ts`), after `pnpm install --frozen-lockfile` in `harness/`.

## Components

- `whombat-manager` (user `whombat-manager`): polls control (`update.assignment`), refreshes TUF, downloads into
  `/persist/manager/staging`, drives the journal (`/persist/manager/journal`), reports `update.progress`, serves
  `/run/whombat-manager/api.sock`. From 0.3.0 it downloads a component with a closure index as the index plus the
  blobs of the store paths the box lacks (UP-X14, below).
- `whombat-update-helper` (root, socket-activated): typed ops only, re-verifies everything (MG-03); `missing-paths`
  is its one read-only query about the store; after an update it prunes runtime generations and collects the store
  (UP-X18, UP-X19, below).
- `whombat-manager-recovery`: started by systemd when the manager fails; runs the known-good manager in recovery
  mode (never activates, rolls back an interrupted activation).

## Looking at an appliance

A DEV Whombat runs these through `dev/devbox shell` (NX-143; as root, so the status command as the manager's own user:
`runuser -u whombat-manager -- whombat-manager --config /etc/whombat/manager.json status`); a production box has no
shell (NX-10).

```
whombat-manager --config /etc/whombat/manager.json status        # state, current, known-good, candidate, explanation
journalctl -u whombat-manager -u whombat-update-helper -u whombat-manager-recovery
cat /var/lib/whombat-update-helper/state.json                     # what the helper activated (root)
```

States are the contract journal states. The reason a staged update waits also reaches control (`update.waiting {reason,
since}` in `status.report` and `update.progress`, MG-53), so the admin panel shows e.g. a box that waits for a backup
destination; what runs on the box stays there, and an update waiting for the owner reaches control as `hold` (MG-159).
Typical explanations:

| Seen | Meaning | Action |
|---|---|---|
| `WaitingForSafeBoundary`, reason `boundary` | acknowledged work is running; the manager drains up to 10 min, then lets users continue and retries every 15 min | none; the explanation lists the blockers; never kill work for an update |
| reason `hold` | control sent a hold (pause/emergency stop), or, at control only, the owner hasn't approved it yet (below) | resume the rollout in control; for an owner's wait, nothing |
| reason `owner` (on the box) | the owner turned on “Ask before updating” and hasn't approved this release; it stays staged, the installed release running (UP-X28, MG-159) | only the owner: Update now in This Whombat → About, or the switch off |
| reason `lock` | the backup service (or a network change) holds maintenance | wait |
| reason `window` | the assignment's `notBefore` is in the future | wait |
| reason `checkpoint` | a contract/incompatible migration, or one after which the installed runtime could not write (its floors, MG-43), needs a verified backup checkpoint and the backup service could not provide one (e.g. no destination: “unprotected”) | fix backups; nothing was changed |
| reason `metadata` | TUF metadata could not be refreshed before activation | check network/clock/repository |
| `Failed no_space` (and the other retryable failures: `not_assigned`, `not_staged`, `boundary_lost`, `checkpoint_stale`, `checkpoint_required`, `activation_deferred`) | this box can't right now: staging/import does not fit even after garbage collection (`no_space`), the helper or the metadata isn't ready, work started at the boundary, the checkpoint went stale | free space (`no_space` retries every 30 min) or wait; the box retries by itself. Never a bad release: these codes are the contracts' `RETRYABLE_UPDATE_FAILURES` (CT-147, `release.IsRetryableUpdateFailure`); the manager counts no attempt for them and never quarantines the release for them (MG-54), and control doesn't pause the rollout, alert or mark the device `failed_before`, so “Retry this Whombat” in the panel can help |
| `RolledBack` with `unhealthy`, `boot_fallback`, `reboot_timeout`, `known_good_unhealthy`, `rolled_back_read_only` | the candidate was activated and failed; the known-good tuple runs. The box **does not retry it by itself** (MG-56): each retry would be another outage. Control holds a device that failed a release and pauses the rollout, so it stays here | fix the release. To try the same release on this box again anyway: “Retry this Whombat” (control assigns it again); it is retried once, not before 30 min after the failure, and quarantined if it fails again |
| `Quarantined` | a release failed verification twice, or failed before activation `maxAttempts` (3) times (download, staging, schema check — retried by the box itself), or is incompatible | the device refuses the quarantined release; ship a fixed one |
| `rolled_back_read_only` | rolled back, but the known-good runtime can only read the database | ship a forward fix soon |
| `ForwardRepairRequired` | a migration ran and the known-good release cannot use the database; the candidate keeps running (if it activated), nothing was rewound | assign a fix-forward release (the only way out of the state); when the cause was retryable (the detail's reason, e.g. `activation_deferred`: the helper went away after the migration), the candidate itself isn't quarantined and assigning it again (“Retry this Whombat”) finishes the update (MG-54); restoring the pre-upgrade checkpoint is an explicit, data-losing operation the customer authorizes |

### Host releases: how long before a bad one rolls back (MG-55)

A host release (a new host generation or manager) reboots. Its verify deadline is set at activation, **by the manager
being replaced**: `hostRebootTimeoutMs` (default 20 min) for the reboot plus `verifyTimeoutMs` (default 10 min) for
the health checks, so in production an unhealthy host release rolls back about **30 minutes** after its activation
(a candidate that never boots is caught earlier: boot counting falls back and the manager rolls back at once). The
new manager only inherits that deadline from the journal and can't extend it: the new manager may be the broken part,
so the time a host candidate gets is fixed by the release it replaces (and if the new manager fails outright,
`whombat-manager-recovery`, the known-good manager, rolls back). Both are policy overrides in `manager.json`
(`policy.hostRebootTimeoutMs`, `policy.verifyTimeoutMs`); production images leave them unset.

While rolling back, the helper step (switching the runtime back, activating the known-good host generation, blessing
its boot) can fail. It is retried after 5 s, doubling to 10 min (`policy.rollbackRetryBaseMs` / `rollbackRetryMaxMs`),
**never given up** — it is the way back to known-good — with the backoff kept in the journal (a restart doesn't start
over at 5 s) and one log line per attempt (“rollback step failed; retrying”). The box stays in `Verifying` (or
`Activating`) with the rollback in progress; control sees the failure detail with the reason `rollback_retrying`.
Look at the helper's journal (`journalctl -u whombat-update-helper`) for why the step fails.

**A box whose known-good is a runtime-only release** (e.g. `pve-20260929.2` on `pve-20260928.7`'s host — the PROD box
on 2026-09-29) is rolled back from a failed host candidate to the host generation its known-good tuple names, with
the known-good runtime (MG-57). The helper that serves the rollback is the one of the **booted** system: a host
candidate that boots is rolled back by its own helper (and by the known-good recovery manager through it), so the
candidate must carry this fix (every host release built after MG-57). A candidate that doesn't boot at all falls
back by boot counting to the old host, whose helper and manager are the old ones: on a box from before MG-57 its
rollback to a runtime-only known-good fails (`not_assigned`) and retries for ever; the box runs its old host with the
**candidate's runtime profile** (switched before the reboot) and takes no further update until repaired. So the first
host release to such a box is one proven to boot from that exact release (upgrade gate 1, the DEV box), and preferably
one that keeps the box's runtime, so even a failed boot leaves it serving on its known-good runtime.

## Development repository and assignments

```
go run ./release-tools/cmd/tufrepo init --dir /tmp/devrepo
go run ./release-tools/cmd/tufrepo add-index --dir /tmp/devrepo --kind runtime --target runtime/1.2.0/whombat-runtime.index.json \
    --file runtime.json --version 1.2.0 --store-path /nix/store/…-whombat-runtime-1.2.0 --nar-hash sha256:…
    # a fixture document (--nar-hash of "nar:" + the file) or a placeholder for a path the box has (no blob; UP-X24)
go run ./release-tools/cmd/tufrepo add-release --dir /tmp/devrepo --tuple tuple.json      # ReleaseTuple JSON
go run ./release-tools/cmd/tufrepo assign --dir /tmp/devrepo --device dev-1 --release rt-… --seq 7 --out assignment.json
go run ./release-tools/cmd/tufrepo hold --dir /tmp/devrepo --device dev-1 --seq 8
go run ./release-tools/cmd/tufrepo add-assignment-key --dir /tmp/devrepo --kid control-dev-1 --public-hex <control's key> \
    [--not-after 2027-01-01T00:00:00Z] [--state active|next|retired]      # authorize control's assignment key
go run ./release-tools/cmd/tufrepo rotate --dir /tmp/devrepo --roles root,timestamp
go run ./release-tools/cmd/tufrepo expire-timestamp --dir /tmp/devrepo --at 2026-01-01T00:00:00Z
go run ./release-tools/cmd/tufrepo export-release --out R --template tuple.json   # real store paths
go run ./release-tools/cmd/tufrepo publish-release --dir /tmp/devrepo --release-dir R
go run ./release-tools/cmd/tufrepo nar-list --dir /tmp/devrepo         # the NAR hashes of the repository's blobs
go run ./release-tools/cmd/tufrepo features                            # closure-index (an older tufrepo fails)
```

Serve `/tmp/devrepo/metadata` and `/tmp/devrepo/targets` over HTTP(S) and point `tuf.metadataUrl`/`targetsUrl`
at them; pin `/tmp/devrepo/metadata/1.root.json` as `/etc/whombat/tuf/root.json`. Development keys only.

## Production repository (online-pilot, PI-05, MG-40, MG-41)

**Kept running after the move to one environment (ONE-01; R3 B1):** releases go to the GitHub channels only, and
updates.whombat.com stays up, with its `whombat-updates` service and TUF timer, until its users are verified; the
cutover doesn't retire it. Production's fleet was 0 devices when the one image replaced it (`deploy.sh status`,
2026-11-19: “0 devices, 0 live”), so no bridge image goes out through it. Before it goes, both:

1. **The pilot inventory reconciled:** every box ever installed from a production image of this repository is named
   and shown to be retired, reinstalled from the one image, or reading GitHub (with its owner's help code, `support
   <box> updates`: the helper's `tuf-github` folder in use). The maintainers' `legacy-boxes` helps: it lists the boxes
   production control knows whose last reported release only this repository lists, and those it can't tell; a
   release listed in both repositories says nothing about which one a box trusts, and a box control never saw isn't
   in it, so it is a hint, not the answer.
2. **No requests for 30 days**, where HAProxy on the host logs that backend (the static server keeps no request log):
   no metadata request for 30 days running.

A box still on it needs a release through this repository, with its own keys, that moves it to GitHub first.

The production repository is signed on the Hetzner host with keys that never leave it; control's
`infra/hetzner/deploy.sh` drives it (`tuf-init`, `tuf-timer`, `release`, `tuf-status`, `tuf-root`; runbook
`infra/hetzner/README.md`, decisions HZ-15…HZ-21). Every production command takes all of
`--env prod --custody online-pilot --keys-dir /etc/whombat/secrets/tuf`; the development-only commands refuse them.

```
tufrepo init --dir /srv/whombat/updates <prod flags>                  # once: keys (0600), root v1 (120 days)
tufrepo set-assignment-keys --dir … <prod flags> --doc keys.json      # control's GET /v1/assignment/keys
tufrepo add-clients-role --dir … <prod flags>                         # clients key generated in --keys-dir
tufrepo clients-keys --dir … <prod flags>                             # whombat.clients.channelKeys of the prod image
tufrepo refresh --dir … <prod flags>                                  # every 6 h (whombat-tuf-timestamp.timer)
tufrepo publish-release --dir … <prod flags> --release-dir R          # verify R from its bytes, sign it (never older, MG-44)
tufrepo publish-release … --release-dir R --allow-downgrade-from ID   # a custody rollback (below)
tufrepo check-newer --tuple R/../tuple.json --dir … <prod flags>      # would it be refused as older? (read-only)
tufrepo status | resign-root --dir … <prod flags>                     # status: releases with host, runtime, manager
tufrepo export-root --dir … <prod flags> [--out manifest/prod/tuf-root.json]   # the root an image pins
```

A release directory comes from built store paths, on any machine with the Nix store that holds them (no keys):

```
go run ./release-tools/cmd/tufrepo export-release --out R --template tuple.json [--reuse-host] \
    [--nar-cache ~/.cache/whombat-releases/nar]
```

`tuple.json` is a `ReleaseTuple` with the store paths, versions, schema, protocol and ABI ranges; its `narHash` fields
may be empty (filled from the store; a given one must match). The host closure must contain `manager.storePath`.
`--reuse-host` leaves the host out (a runtime-only release; `host.narHash` and `manager.narHash` then come from the
release that published the host, which `publish-release` finds in the repository as an index).

## Closure indexes and blobs (UP-X14, UP-X23)

Each component (host generation, runtime bundle, provider bundle) is published as a closure index (UP-X23: the
whole-closure `nix-store --export` artifacts of managers before 0.3.0 are gone; such targets in a repository are
ignored):

- **closure index** (`host/<v>/whombat-host.index.json`, `runtime/<v>/whombat-runtime.index.json`,
  `provider/<name>/<v>/provider.index.json`; kind `closure-index`): every store path of the closure in import order
  with its NAR hash, NAR size, references, deriver and the sha256/size of its zstd-compressed NAR, the **blob** at
  `targets/nar/<filehash>.<narhash>.nar.zst` (one per NAR hash, shared by every release; not a TUF target, verified
  through the signed index). Older managers skip the kind.

The release directory gets
`<component>.paths.json` (the listing: the index without blob fields) and `nar/<narhex>.nar.zst`, hard links into the
build machine's NAR cache (`--nar-cache`, default `$XDG_CACHE_HOME/whombat-releases/nar`; copies across filesystems).
The facts come from `nix path-info --json --recursive`; only NARs not in the cache yet are dumped
(`nix-store --dump`, in parallel) and compressed (zstd, best compression), and a dump whose hash or size isn't
path-info's is refused. `release.json` is `v: 2` with `indexes`; `SHA256SUMS` covers the top-level files only, so an
upload may leave out the blobs the repository has (`tufrepo nar-list --dir` prints the NAR hashes it holds).

`publish-release` checks each listing again (strict JSON, store paths and hashes, no duplicates, import order, the
root's closure complete and equal to the listing, the tuple's NAR hash, closure size, the manager in the host's),
reuses the repository's blob of every NAR hash it has, verifies every other blob from `nar/` by decompressing it
(bounded) against the listing's NAR hash and size and writes it to `targets/nar/` (a path whose blob is in neither
place fails the publish, naming it), then signs the index targets with each path's blob size and hash. Everything is
checked before the metadata is signed; blobs written before a refusal stay (content-addressed, harmless) and are
reused next time. Its JSON result counts `blobsAdded`, `blobsReused` and `bytesAdded`.

**On the box.** The manager resolves each component through its index (a component without one is not approved). It
downloads the index,
asks the helper which of its store paths are not valid (`missing-paths`, read-only), checks the space for those blobs
(their NAR sizes count as unpacked size) and downloads only them; it logs one line per component (`paths=… missing=…
bytes=…`). It plans this again in every step, so a crash or a restart in the middle of the downloads goes
on with what is missing. The journal keeps the release's TUF targets (its indexes) as current/known-good,
not the blobs: staging may drop them once imported. Staging (`stage-runtime`, `stage-host`) in the helper takes each
component in order (host, runtime, providers): the index copied from staging and parsed from the helper's own TUF view, then for every path not valid: its
blob copied (root-owned, the index's size and hash), decompressed once to check the NAR hash and size, decompressed
again into an export frame piped to `nix-store --import` (the frame is only completed when the NAR checks out again),
the path's validity checked, the copy removed. A missing blob is `not_staged` (naming the path; the manager
downloads again), a full disk `no_space`, a blob or NAR that doesn't match `verification_failed`. The ~4.8 GB of a
host release become the few new paths (measured: `pve-20260930.3` → `pve-20261001.1` 24 of 1,118 paths, ~19 MB;
`pve-20261001.1` → `pve-20261002.1` 68 of 1,212 paths, 58 MB), and staging no longer needs three times the closure.
On the build machine the first export with an empty NAR cache compressed the whole host and runtime (1,085 NARs,
4.8 GB → 2.5 GB) in 30 s; the next release compressed its 66 new NARs (149 MB → 44 MB) in 3 s, and publishing it into
a repository that had the first one added 66 blobs and reused 1,046 in 0.2 s.

## Store retention: what stays, when the store is collected (UP-X18…UP-X21)

Profiles are the GC roots of what a box can go back to; the helper decides what each keeps from its own records
(`/var/lib/whombat-update-helper/state.json`), never from the manager:

| Profile (`/nix/var/nix/profiles/`) | Kept | Pruned |
|---|---|---|
| `system` (`system-<n>-link`) | the booted system, the helper's current, previous (known-good) and pending host, the newest generation | before a host candidate is staged (`prune-host-generations`, MG-24) |
| `whombat-runtime` (`whombat-runtime-<n>-link`) | the runtimes of the helper's current and previous runtime and of its current, previous and pending host, and the profile's current (= newest) generation: usually two to four | right after every update that became Healthy (`prune-runtime-generations`) |
| `whombat-provider-<name>` | everything (no tuple has carried providers since NX-37) | never |

Every other store path no kept generation references (nor the booted or current system, nor a running process) is
garbage. **When:** once per update, in the step that records it Healthy, right after staging is pruned (MG-60): first
`prune-runtime-generations`, then `collect-garbage` (`nix-store --gc`, never `-d`: no generation goes) in the scope
`whombat-store-gc.scope` with CPUWeight and IOWeight 10 and nice 19, bounded to 30 minutes. No update step runs
meanwhile, so nothing is staged while the store is collected (a staged closure is no GC root until it is activated);
nothing is collected after a rollback, on a timer or by the recovery manager. A failure is a warning; the next update
tries again. The first collection on a box that never collected deletes everything older releases left behind (John's
DEV box held 1,441 store paths, 7.4 GB, on 2026-10-07) and may take a few minutes; later ones delete what the previous
release left, in seconds.

On a box (DEV: `dev/devbox shell`, NX-143):

```
journalctl -u whombat-manager | grep -E 'staging pruned|runtime generations|collecting the store|store collected'
journalctl -u whombat-update-helper | grep -E 'generations deleted|store collected|collect-garbage'
ls /nix/var/nix/profiles/                 # system-<n>-link (2–4), whombat-runtime-<n>-link (2–4) and the profiles
systemctl status whombat-store-gc.scope   # only while a collection runs
df -h /
```

| Seen (manager) | Meaning |
|---|---|
| `pruned runtime generations deleted=[…]` | those runtime generations went; their closures go with the collection that follows |
| `store collected after the update paths=… freedBytes=… rootFreeBytes=…` | what `nix-store --gc` deleted (bytes rounded to its unit; `-1`: it printed no summary) and what is free on `/` afterwards |
| `pruning runtime generations failed; collecting the store anyway` / `collecting the store failed; the update is done` | the helper's journal says why; nothing else depends on it, the next update tries again |

A box whose `/` is already too full to import an update (`Failed no_space` at Verified) never reaches Healthy, so it
never collects by itself. On a DEV box, by hand: `nix-env --profile /nix/var/nix/profiles/whombat-runtime
--list-generations`, then `--delete-generations <n>…` for generations that aren't current and whose store path is the
`runtime.runtime` of none of the helper's records (`runtime.current`, `runtime.previous`, `host.current`,
`host.previous`, `host.pending` in its state file), then `nix-store --gc`. Never `nix-collect-garbage -d` or
`--delete-old`: they delete the known-good system generation too. The store's size and `/`'s free space aren't reported
to control (UP-X21): the collection's log line is the record.

## Versions (NX-105, MG-44, MG-49; UP-A1, UP-A2)

Every component version only moves forward, and the devices check it (`trust.CheckForward`, MA-21c): a tuple whose
host, runtime or manager version is lower than the installed one's is refused unless release custody signed
`allowDowngradeFrom` for it.

| Component | Version | Ordered by |
|---|---|---|
| runtime | `<Whombat package.json>-<commit time UTC YYYYMMDDHHMMSS>.<rev>`, then `.p<digest>` (patched bundle) and `.<label>` (a dev runtime-only release), e.g. `0.2.0-20260929081512.1a2b3c4` | package.json, then the Whombat commit's time |
| host | the release id, `whombat-YYYYMMDD.N` (prod) or `whombat-dev-YYYYMMDD.N` (dev; `pve-…` before PI-23); a runtime-only release keeps the host of the release it reuses | `whombat` after `pve`, then day, then counter |
| manager, helper | `<appliance semver>-<appliance commit time>.<rev>` for a release build (`applianceRelease`), `0.3.0-0.dev` for every other build (UP-X09) | appliance semver (`flake.nix` `applianceVersion`), then commit time |

`CompareVersions` (the contracts' order): build metadata after `+` ignored; core and pre-release split at the first
`-`; dotted segments, two numbers numerically, a number before anything with a letter, else as text; a pre-release
sorts before the plain release. So every `0.2.0-…` manager compares **below** `0.2.0`: “at least 0.2.0” is `0.2.0-0`
(control's manager floor). The order is `0.1.0` < `0.2.0-0` < `0.2.0-0.dev` < `0.2.0-<commit time>.<rev>` < `0.2.0`.
`applianceVersion` is **0.3.0** since closure indexes (UP-X17): “manager at least `0.3.0-0`” means the box reads
indexes, and `0.2.0-…` < `0.3.0-0` < `0.3.0-0.dev` < `0.3.0-<commit time>.<rev>` < `0.3.0`.

**The transition (2026-09-28).** Every version in the field before it had core `0.1.0` (runtimes `0.1.0-<rev>`,
managers `0.1.0`; the dev stack's manager `0.0.0-dev+<commit>`). Every new one has core `0.2.0` and compares newer
whatever follows the `-`, so the first release of the new scheme installs on every box and needs no
`allowDowngradeFrom` (proven over every recorded release: `helper/pkg/trust/transition_test.go`). A release build
stops while the Whombat pin's package.json is below 0.2.0 (“release runtimes need 0.2.0 or later”): move the pin.
A box installed from a non-release image (VM tests, dev images; manager `0.3.0-0.dev`, `0.2.0-0.dev` before the bump)
is above control's floor and takes releases normally: `<semver>-0.dev` sorts before every release build's manager.

**Nothing older is signed (MG-44, MG-50).** A production repository signs `whombat-YYYYMMDD.N` ids only; a development
one `whombat-dev-YYYYMMDD.N`, and ids of no family (fixtures, harness releases) without ordering, never a production
id, a malformed `whombat-` id or any `pve-` id (PI-23: those stay published, compared as the family's older
generation). `publish-release` and `add-release` refuse, before anything changes, a candidate whose id
doesn't sort after the newest published release of its family, or whose host, runtime or manager version is lower
than the highest one any published release of the family carries; versions with a `+` or a numeric part of more than
19 digits are refused (they can't be ordered). Over `--metadata-url`, `check-newer` fails on expired metadata.
Check before a 20-minute build (no keys needed; `release/ship build` runs it first):

```
tufrepo check-newer --tuple tuple.json --metadata-url https://updates.whombat.com/metadata/ --root manifest/prod/tuf-root.json --env prod
tufrepo check-newer --id whombat-dev-20260929.1 --host-version whombat-dev-20260929.1 --runtime-version 0.2.0-… --manager-version 0.2.0-… \
    --dir ~/.whombat-stack-dev/env/manager/tuf
```

It prints what it verified (the root chain, timestamp → snapshot → targets) — and, without `--root`, that it trusted
the repository's own first root — then the newest release it compared with. Reading a refusal:

| Refusal | Meaning | Do |
|---|---|---|
| `release id X doesn't sort after Y, the newest published … release` | the id is taken or older than a published one | build with a later id (same day: next counter) |
| `older than what the published … releases carry (runtime A < B of Y)` | the Whombat pin (or a patch) is older than what Y ships, or the build is from an older commit | build from the commit that should ship; if the pin moved back on purpose, this is a custody rollback |
| `… (manager A < B of Y)` / `(host A < B of Y)` | the appliance commit is older than Y's, or the host of an older release was reused | rebuild from `main`; `--reuse-host` only the newest release's host |
| `--allow-downgrade-from must name Y` | a custody rollback that doesn't name every release holding a version it undercuts | name them (and any other release boxes may be on) |
| `--allow-downgrade-from X: no such published release` / `… older than it in no component` | a permission for a future release, or one the candidate isn't older than | name only published releases boxes move back from |
| `a production release id is whombat-YYYYMMDD.N` / `a development repository signs whombat-dev-YYYYMMDD.N` | the id is of the other environment, or malformed | use the environment's id (release/build makes them) |
| `… is an id from before PI-23` | a `pve-…` id | build it again under a `whombat-…` id |
| `timestamp expired …` (over `--metadata-url`) | the published repository isn't being re-signed | fix the timer on the updates host (`deploy.sh tuf-status`) before building |

`tufrepo status` lists every release with its three versions.

## Custody rollback (MG-44, MG-45; UP-B2)

To take boxes back to an older release after a bad one, release custody signs it as a **new release** (a later id)
whose tuple carries the older components, with the releases boxes move back from (only published releases it is older
than, and at least those holding every version it undercuts):

```
tufrepo check-newer --tuple back/tuple.json --dir … <prod flags> --allow-downgrade-from whombat-20260930.1
tufrepo publish-release --dir … <prod flags> --release-dir back/release --allow-downgrade-from whombat-20260930.1
```

The permission is TUF-signed (`allowDowngradeFrom` in the target's custom metadata): boxes on a named release take it,
boxes on any other refuse it as a downgrade, and control alone can never send a box back. It can't change under its id
(another list needs another release id). Then roll it out as any release.

**After a migration.** The older runtime's own schema check on the migrated database decides (Whombat MD-12):

- exit 0 `newer_compatible` — its schema is at or above the database schema's writers floor (after an `expand`): the
  manager accepts it (`CheckCompatibleActivation`, MG-45), nothing is migrated down, no checkpoint; the database
  stays at the newer schema and the older runtime reads and writes it. `whombat-manager status` shows the plan
  (`newer_compatible`, rollback access);
- exit 11 `newer_read_only` (between the floors, after a `contract`) or 12 `newer_incompatible` (below the readers
  floor): refused `schema_incompatible` (`candidate_read_only` / `candidate_cannot_read_schema`), nothing changed. The
  way out is a fix-forward release, or restoring the pre-migration checkpoint (a data-losing operation the
  customer authorizes, `restore.md`), not a custody rollback.

A runtime from before MD-12 reports no floors and is judged by its tuple, which refuses it on any newer schema.

## Failure detail and what the owner sees (MG-46, MG-47, MG-48; UP-E3, UP-E4)

A box reports a failure as structured fields, never its message: `update.failureDetail` in `status.report` and
`update.progress` — `stage`, `code`, `reasons` (the activation check's), `release`, `schema {database, target,
candidateWrites, candidateReads}` (schema failures; `target` only when the candidate was judged at the schema it would
migrate to), `rollbackAccess` (what the installed runtime could do on the database the candidate leaves),
`failedChecks` (`runtime`, `database`, `session_endpoint`, `boot`, …), `at` — and `runtimeVersion`. Contracts'
`describeUpdateFailure` turns it into the sentence the admin panel, `promote-prod` and the owner's app show (the
2026-09-28 failure: “pve-20260928.5 couldn’t start on this Whombat’s database: it reads schema 49 only and the database
is at 48. Nothing was changed.”). The full message stays on the box: `whombat-manager status` (`explanation`) and the
journal.

| Code | The detail carries |
|---|---|
| `schema_incompatible` | reasons (`candidate_cannot_read_schema`, `candidate_read_only`, `schema_downgrade`, `schema_target_mismatch`, `host_abi_unsupported`, or a refusal verdict like `foreign`; `protocol_no_overlap` from a manager before MG-131), schema, rollback access |
| `unhealthy`, `known_good_unhealthy` | the failed checks; after the rollback the known-good's access |
| `boot_fallback`, `reboot_timeout` | failed check `boot` |
| `rolled_back_read_only` | rollback access `read-only` |
| `forward_repair_required` | the code that led there as reason, rollback access `none` |
| `migrate_failed` | the migration's error kind and verdict as reasons |
| others (`download_corrupt`, `no_space`, `helper_…`, …) | stage, code, release |

The owner's facts (`UpdateFacts`, Settings → This Whombat) carry the same detail, `waiting {reason, since, blockers}`
(why a staged update waits: `boundary` with the running work counted by kind, `checkpoint`, `window`, `hold`, `lock`,
`metadata`, `owner`), `lastUpdate {release, from, at}` (the last update that completed, kept in the journal) and
`askFirst` (the owner's “Ask before updating”; always there, so the app offers the switch).

**Older ends.** A control before contracts 0.22 (0.22.4 for `waiting`) answers `400 validation_failed` to the new
members (`failureDetail`, `waiting`, `runtimeVersion`): the manager sends
the report again without them, keeps doing so for 6 hours and then tries the full report again (log “control predates
contracts 0.22 …”, once). A
runtime before 0.22 answers 400 to the new facts: the manager pushes them without while that release is current (log
“the runtime predates contracts 0.22 …”, once per release).

## Releases that migrate the database (MG-43, CT-134, Whombat MD-12)

A release whose runtime carries a migration activates like this: the helper runs the **candidate's** `whombat
schema-check --json` against the live database. Exit 10 (migration required) with a `target {version, readers,
writers}` — the schema its migrations produce and that schema's floors — is judged by `CheckMigratingActivation`: the
candidate must read the target (its tuple's `schemaWrites`), and the installed runtime's schema against the floors says
what a rollback would leave: `read-write` (≥ writers: no checkpoint), `read-only` (≥ readers) or `none`. A checkpoint
is taken, at the safe boundary while drained, only for the migrations the runtime names (`contract`/`incompatible`)
or when a rollback wouldn't be read-write; a box without a backup destination then waits with reason `checkpoint`,
nothing changed. An `expand` (Whombat's normal migration, MD-03) needs none: it migrates, activates and, if the
candidate fails, the known-good runtime runs read-write on the new schema (`vm-tests/update-migration.nix`, NX-103).
Before shipping, check a release's migrations in its `compat.json` (`class`, `readers`, `writers`): anything but
`expand` means boxes without backups will wait.

A candidate with nothing to migrate (exit 0) that reports the live schema's floors is judged by them (MG-45): see
“Custody rollback”. A runtime without `target` in its schema check (Whombat before MD-12) keeps the old tuple-only
check, which refuses any runtime that must migrate (Whombat tuples read only their own schema). **Boxes whose manager is older than MG-43 can't
take a release that migrates**, whatever its runtime reports: they fail it `schema_incompatible` and quarantine it,
nothing changed (production, 2026-09-28: `pve-20260928.5` on `wb-old0-prod-0001`, HZ-28). Such a box is **reinstalled**
from the ISO of a release with the MG-43 manager (production's plan for that box), or first given a host release
**without** a migration (a runtime at the box's own schema, so its old manager sees schema `current`) that brings the
new manager; after that, migrating releases are ordinary.

## Client security floor (CT-53)

A release tuple may carry `clientFloor {web, android, ios, desktop, cli}`: the lowest client build number each
platform may use against that release (`0`: no floor). The manager hands the running tuple's floor to the runtime
(`UpdateFacts.clientFloor`), which turns away older clients with `client_below_security_floor` (MG-26).

```
go run ./release-tools/cmd/tufrepo add-release --dir /tmp/devrepo --tuple tuple.json --client-floor android=4021,web=120
go run ./release-tools/cmd/tufrepo add-release --dir /tmp/devrepo --tuple tuple.json --client-floor none   # strip it
```

**Rollout constraint.** Managers and helpers built from contracts < 0.5.3 refuse any tuple with a `clientFloor`
(fail-closed: the assignment is refused and the device stays on its release). So:

1. The first release whose manager **and** helper use contracts ≥ 0.5.3 is published **without** a floor.
2. Floors start with the next release, once the devices that will receive it run that manager and helper (check
   `status.report` `managerVersion` before assigning).
3. A device still on an older manager/helper must be moved to a floor-free ≥ 0.5.3 release first; never skip it.

The floor follows the running tuple and does not ratchet: a rollback to known-good restores known-good's floor, and
a release without a floor removes it. Keep floors monotonic across releases you approve.

## AI client channel (Claude Code; MG-33, NX-37, IN-432)

AI clients are not part of a release. The manager installs the clients the box's person chose from the **client channel**.
Claude Code is the only one since 2026-10-25: ChatGPT runs on Hermes's own provider with no client, the runtime reports a
Codex adapter level no bundle has and removes a Codex it finds installed, and the latest tested job publishes Claude Code
alone (IN-432; Whombat HN-A01…HN-A04). The channel is the signed document `clients/channel.json`
(`SignedClientChannel`, CT-74), a TUF target of the delegated `clients` role, next to the bundle artifacts
`clients/<provider>/<version>/linux-<arch>.tar.gz`. The role is limited to
`clients/*` and `clients/*/*/*` and signed by the online channel key, so the channel advances without the release
keys and can never approve a release. The same signed document is also published at the plain path
`clients/channel.json` of the updates host for self-hosted servers (SUB-26).

On an appliance:

```
curl -s --unix-socket /run/whombat-manager/api.sock http://m/v1/clients | jq   # as root: state, installed, latest, channel
ls -l /persist/whombat/clients/*/                                             # <version>/ (read-only), current -> <version>
jq . /persist/manager/clients/state.json                                      # chosen, previous, back-off, adapters (root)
journalctl -u whombat-manager | grep clients:
```

| Seen | Meaning | Action |
|---|---|---|
| `latest: null`, `channel: null` | no channel yet, or it could not be verified (expired, unknown key, rolled back, clients role unavailable) | publish/refresh the channel; check `clients.channelKeys` and the environment |
| install answers 404 `unavailable` | no bundle for this architecture and the runtime's adapter level, or a runtime without `clientAdapters` | publish a bundle for that level; a pre-0.9.0 runtime runs its release's providers |
| `failed`, `client.digest_mismatch` | the artifact or the executable differs from the channel (nothing was unpacked; what was installed still runs) | withdraw the bundle, re-publish from a verified source |
| `failed`, `client.install_failed` | download, TUF, space or unpack failed; retried after 15 min, doubling to 12 h | fix the cause; an install the person starts retries at once |
| `updating` | a newer tested version is being installed next to the running one | none |

Withdrawing a version (a bad client) is a new channel without it: devices that still have the previous version switch
back to it without a download; the previous version always stays on disk, older ones for at least 24 h.

Development repository (the dev instance's is `~/.whombat-stack-dev/env/manager/tuf`, served as `updates.whombat.com`):

```
go run ./release-tools/cmd/tufrepo add-clients-role --dir D [--key-file K]   # once; without --key-file a dev key in D/keys
go run ./release-tools/cmd/tufrepo clients-keys --dir D --out keys.json      # the device's clients.channelKeys
go run ./release-tools/cmd/clientchannel latest --provider claude
go run ./release-tools/cmd/clientchannel fetch --provider claude --version 2.1.302 --dir /tmp/dl > fetched.json
go run ./release-tools/cmd/clientchannel bundle --fetched fetched.json --fixtures-digest sha256:… --adapter 1 --work W --out b.json
go run ./release-tools/cmd/clientchannel publish --repo D --bundle b.json [--withdraw codex/0.157.0] [--key-file K]   # --withdraw drops an older Codex bundle too
go run ./release-tools/cmd/clientchannel refresh --repo D --within 96h       # re-sign before expiry (7 days)
go run ./release-tools/cmd/clientchannel show --repo D
```

Bundles are only published after the provider tests passed against that exact executable: the latest tested job
(`docs/runbooks/client-latest-tested.md`) does fetch → test → bundle → publish.

## Channels and the GitHub repository (UP-X29…UP-X34, Whombat LNK-20…LNK-27)

The Whombat image (`nix/profiles/prod-instance.nix`, NX-522) has channels, Production by default; people see
**Production** and **Beta** (ONE-03), the wire names stay `production` and `development`. Every box with channels
(`whombat.helper.defaultChannel` set) takes the newest release of its channel from the GitHub repository: the metadata at
`https://releases.whombat.com/` (the `metadata/` folder of CybexBV/whombat-releases on GitHub Pages), the files as that
repository's release assets (`tuf.targetsUrl` `https://github.com/CybexBV/whombat-releases/releases/download/`, the
layout `github` in both manager units' environment, `WHOMBAT_TUF_TARGETS_LAYOUT`).

**The old GitHub address** (UP-X48). Boxes on older releases fetch their files from
`https://github.com/CybexHQ/whombat-releases/…`, which reaches the repository only through GitHub's redirect from its
old address. So never create a repository at an old `CybexHQ/<name>`, `whombat-releases` or any other: that ends the
redirect, and the account `CybexHQ` must stay Cybex's.

| What | How |
|---|---|
| a box's channel | the helper keeps it (`/var/lib/whombat-update-helper/channel.json`); the owner changes it in Settings → This Whombat → Updates (the runtime's `updateChannelSet`); root: `whombat-update-helper --config /etc/whombat/update-helper.json set-channel development` |
| a release into development (Beta) | `tufrepo gh-publish --dir <clone> --release-dir <release>`; the maintainers' `candidate` does it for every release (the clone and token from `~/.config/whombat/releases.env`); the token in `WHOMBAT_RELEASES_TOKEN` |
| promote to production | `tufrepo gh-promote --dir <clone> --release <id>`: the same files, nothing uploaded, signed with the repository's online production key (ONE-05; `--key-file` for an offline copy); the maintainers' `promote <id> --yes` runs it on John's word and then puts the installer on the download site (IN-835, PI-25) |
| pause / resume a channel | `tufrepo gh-pause --dir <clone> [--channel production\|development] [--key-file F]` and `tufrepo gh-resume --dir <clone> [--channel production\|development] [--key-file F]` (local repository: `tufrepo pause` / `tufrepo resume`; `--channel` defaults to `production`): signs the pause marker in the channel's own role metadata with the channel's key, nothing uploaded; keeps all listed releases for rollbacks and stays paused across publishes/promotions until resumed |
| the client channel | `tufrepo gh-clients --dir <clone>` after the channel publisher signed it |
| freshness | the whombat-releases workflow re-signs snapshot and timestamp every 6 h and on each push (3 days); an issue opens 30 days before a role expires |
| set up from DEV's repository | the bridge procedure below |

A box on the GitHub repository verifies it in folders of its own: the manager's `tuf/github/cache` and
`tuf/github/mirror` under `/persist/manager`, the helper's `/var/lib/whombat-update-helper/tuf-github` (UP-X35). The
continued root gives timestamp and snapshot new keys, so the old repository's chain stays where the earlier manager and
helper keep it (`tuf/cache`, `tuf/mirror`, the helper's `tuf`): a bridge that rolls back still takes DEV control's next
assignment, and the GitHub folders keep the continued chain for the next move forward.

### The bridge: moving DEV's boxes to the GitHub repository (LNK-50)

Once, in this order, never skipping a step; this is the procedure, and the maintainers' runbook (whombat-ops
`runbooks/appliance/dev-instance.md`, “The move to GitHub”) gives Cybex's exact commands under the same numbers. The rule
behind every step: **no box is offered a release it can't roll back from.** A box's rollback from the bridge goes only to
a release the GitHub repository lists (UP-X32), so the release each box runs when it takes the bridge must be among the
carried ones, and nothing may move a box between the record and the bridge. DEV control offers a box the release of an
open rollout whose waves reach its cohort, else the newest **completed** rollout's, whatever its cohort: a rollout that
completes offers its release to every box (UP-X41).

1. **Freeze, under the candidates' lock**: whombat-ops `bin/candidate --freeze "the move to GitHub"`. It waits for a
   candidate that is running, writes `~/.config/whombat/candidate-freeze`, stops DEV's open rollouts, waits until every
   DEV box is settled (steady, heard from, not behind the release control offers every box) and records each box's
   release in the file (`release <device> <id>` lines). Exit 1: a box didn't settle; the freeze stays, the move waits,
   run it again. From now on a candidate that rolls out refuses, checked at its start, again once it holds the lock and
   again right before it publishes; `release/ship publish-dev` refuses every `--waves` but `rehearsal`.
2. **Land on `main`, in order**: whombat-ops, the relay, control, the appliance, Whombat; fast-forward each
   main checkout on the machine that runs the candidate (the freeze lives in the new `bin/candidate` and the harness, and
   every later step uses `main`). Not before step 1: appliance `main` makes every `--host` candidate the bridge.
3. **Control and the relay with Link on DEV, pinned explicitly**: `WB_MGD_LINK_LABELS_PER_DAY=2` in the stack's
   environment, then a candidate with `--api <control's main> --relay <the relay's main> --no-rollout` (runtime-only on
   the boxes' host; no box is offered it). Check before going on: migration 0029 applied once and comped every DEV box
   that existed (`dev/panel ops link <device>`: `enabled`, a `comp`), control runs with `LINK_LABELS_PER_DAY=2`, Home's own
   address answers, remote help reaches Home (`support <box> status`).
4. **Build the bridge**, a host release from appliance `main` (never a reused host: it has no channels), published
   through the old address without a rollout, naming the same `--api` and `--relay` so its candidate pins them:
   `--minor --host --no-rollout --api … --relay …`. Nothing on GitHub; no box is offered it.
5. **Record each box's running tuple again**: the freeze file's `release` lines, checked against each box now (a box's
   own update status: support's `updates`, `dev/devbox update-status`). They must agree; if not, back to step 1.
6. **Continue the repository** on a copy of DEV's, into the publisher's clone, with a **permanent keys directory** on the
   machine that publishes (the candidate's): `tufrepo gh-continue --from <copy> --out <clone> --keys-dir <permanent,
   0700> --offline-keys-dir <offline> --carry <every box's release>,<the bridge>`. The clone's `state.json` records the
   keys directory's absolute path and every later publish loads the keys from exactly there: don't move it (if it must
   move, change `state.json` with it), back it up at once (losing it loses the only keys of the new root and development
   role: bridged boxes could never be signed an update again), never into a repository. `continue.json`:
   `carriedReleases` names every box's release and the bridge.
7. **The repository on GitHub**: the snapshot and timestamp keys into the Actions secrets, then `tufrepo gh-init --dir
   <clone> --remote …`: it uploads and checks every file the metadata names (the carried releases, the AI clients) before
   it pushes the metadata; then `tufrepo gh-clients --dir <clone>` (the clients role's files and role), and the AI client
   job publishes into the clone from now on (`release-tools/clients/latest-tested`, `WB_CLIENTS_GITHUB`).
8. **The workflow's first run** (workflow_dispatch), green.
9. **Pages checked with the boxes' trust root**: `https://releases.whombat.com/timestamp.json` fresh; the snapshot
   version from the timestamp, the development version from that snapshot, and those exact files verified against the
   root the boxes pin: development lists every carried release, `clients` lists the AI clients. No tool verifies the
   signatures of the downloaded chain against that root yet: the commands check versions, lengths and names, and the
   VM's first refresh (step 10) is the first real signature check, before Home's.
10. **The rehearsal on a temporary DEV box VM** (only with the owner's go-ahead; when there is none, say so: the first
    box then is the first box-level run of all of this). **It can't run yet**: every box set up since own addresses
    starts with its own address only and is claimed only on a page it serves, while `dev/devbox` claims through the
    relay (`claim_here_unavailable`); until `dev/devbox` claims on the box's own page, the VM stops after its
    registration. The machine running it must also let the lease's VM network reach the internet (DHCP, DNS, out).
    Under a managed lease; installed **where the first real box is**
    (`dev/devbox create --release <its release>`: a runtime-only release installs its host's ISO and DEV control then
    brings the VM to it, refused unless that is the release control offers every box); claimed (the old manager's
    claim), **then** comped at DEV control (`dev/panel ops comp <vm device> …`; a box made after the control deploy gets
    no migration comp, and without Link the new manager sends no progress and the smoke's client ticket is refused),
    **then** the bridge, through `release/ship publish-dev <bridge> --waves rehearsal` (the internal cohort only, held a
    week so it can't complete; stopped at the end whatever happened, the stop checked; the VM is the only internal
    device). Three passes, in order:
    - **a bridge that fails after it refreshed from GitHub, and rolls back**: once the VM's manager journal shows its
      first refresh from `releases.whombat.com`, its runtime is kept down until the verify deadline (`systemctl mask
      --runtime --now whombat-server` in the box; the mask goes with the reboot). The box rolls back to its carried
      release, `publish-dev` reports it and stops the rollout. Back on the carried release, Healthy, by the box's own word;
    - **a legacy assignment after that rollback**: the failed attempt cleared at DEV control (`POST
      /v1/operator/devices/<vm>/retry {"release":"<bridge twin>","reason":"rehearsal"}`), the same `publish-dev …
      --waves rehearsal` again: the old manager and helper stage DEV control's assignment from the old repository
      (UP-X35), and this time the bridge passes: Healthy and blessed **by the box's own word** (`dev/devbox
      update-status`: past the bridge a box with Link sends support heartbeats, not status reports, so control's device
      record keeps its old release), refreshing from `releases.whombat.com` (no `metadata_stale`), its own address, the
      smoke;
    - **a runtime-only release through GitHub**: a release on the bridge's host published into the Development channel
      only (`release/ship build <id> --reuse-host <bridge's prod id>`, then `tufrepo gh-publish` of its twin; no rollout,
      DEV control never hears of it), which the VM installs, Healthy. It is development's newest from then on, so the
      first real box takes it right after the bridge: that is part of the plan, and its checks come after both.
    Then `dev/devbox destroy` (refused while a rollout to the internal cohort is open), the lease released and checked.
11. **Before the first real box**: its release now is one of `carriedReleases` (its own word, not control's record); a
    way in that doesn't depend on the bridge works (the local network or Tailscale, tested now), and its local recovery
    is ready (someone at the box, its recovery menu).
12. **The box**: the bridge's twin through DEV control, all at once, with no other rollout open. It reboots into the
    bridge, then takes the GitHub runtime-only release (step 10). Check: Healthy and blessed by its own word, refreshing
    from `releases.whombat.com`, its own address, remote help, `bringBack: ready`, a push to the owner's phones. Then the
    next box the same way.
13. **Lift the freeze** once every box runs the bridge (or a release after it), blessed: remove the file. From then on a
    candidate whose host has channels publishes into the GitHub Development channel first (a failure stops it), then
    DEV control's rollout, which a box with channels doesn't read.

Keep the carried releases listed in development until every DEV box is past the bridge; a box that missed the bridge
keeps the old address.

**If the move stops**, at any step: **keep the freeze**. While the bridge is DEV's newest release, a lifted freeze lets
the next ordinary candidate reuse the bridge's host and roll it out to every box: never lift it then, or every candidate
until the move ends runs with `--reuse-host <the host the boxes run>`. A rollout that may be open (a `publish-dev` killed
between Healthy and its stop, a rehearsal) is stopped by hand at once (`POST /v1/operator/rollouts/<id>/stop`) and its
state read back as `stopped`. Before step 6 nothing has changed for any box: stop there. After step 7 the repository on
GitHub stays (no box reads it before its bridge). A rehearsal that failed: the VM is destroyed and the lease released,
and the real box doesn't move until the cause is fixed and the rehearsal passes. A real box that took the bridge and is
locally healthy but unreachable (no own address, no remote help): don't send another release; reach it the
independent way (step 11), and bring it back with the recovery menu or a signed forward repair through GitHub.

### A publish that stopped

Run the same command again: it finishes (files already on GitHub are skipped, the role is not signed twice, a commit
whose push failed is pushed; the publish is done only when the remote has it). A record that left nothing signed or
unpushed is dropped by the next publish with a note. To give up a publish that did sign, in the clone: `git reset -q
--hard '@{u}' && git clean -fdq metadata && rm -f .publish-pending.json`. This puts the index and the work tree back to
what the remote has (a publish stopped after `git add` leaves staged files) and drops a commit it couldn't push. A publish commits only the metadata it signed; a clients role the channel publisher signs during
an upload waits for the next `gh-clients`.

When `gh-resign` passes over a role file that doesn't verify (a broken push, a wrong key), it signs over that role's last
good version, which keeps serving; the workflow opens the issue “A role file did not verify” and ends red after Pages is
deployed. Sign the role again (or remove the broken file) and push.

A box that moved from development to production **stays on its release** until production lists a newer one: the
helper refuses anything older (`downgrade`/`not_assigned`), and `updateChannel` answers `staysOn`. A release id of
either family orders by date and number (`whombat-dev-20261118.3` < `whombat-20261119.1`; contracts 4.4.0).

When a publish stops halfway nothing reaches a box: blobs and files may be on GitHub, but the metadata is pushed only
after them. Run the same command again (“A publish that stopped” above). Until then every other publish (and
`gh-clients`) is refused and names the one to finish (`<clone>/.publish-pending.json`), so its signed role never goes up
with another's. `gh-clients` works the same way:
the clients role's files first, then its role pushed. A file over 2 GiB is refused by name (the ISO is not published here, LNK-27). The repository's settings, secrets
and token: `release/github/whombat-releases/SETUP.md`.

## One environment (Whombat ONE-01…ONE-06; NX-522, MG-176)

Every box runs the Whombat image (`prod-instance.nix`): production, the GitHub repository, Production by default. The
image still knows the development environment so Home (environment file `dev`, identity env `local`) keeps working
until it moves; a box in that environment keeps Beta by itself (the channel bridge records `development` once).

### The key ceremony (ONE-05, UP-X42)

Once, before the first release for customers, on the publisher's machine (The Falcon), with no candidate or client job
running (they sign with the same clone). The root gets three offline keys, two of which sign the next root; the
top-level targets an offline key; snapshot and timestamp stay in the Actions secrets; development, clients and
production stay online with the publisher (production promotes, ONE-19). `tufrepo` is this repository's
(`go build -o ~/.cache/wb-tmp/tufrepo ./release-tools/cmd/tufrepo` at the landed commit).

```sh
set -a; . ~/.config/whombat/releases.env; set +a       # WHOMBAT_RELEASES_DIR (the clone), WHOMBAT_RELEASES_TOKEN
T=~/.cache/wb-tmp/tufrepo
$T gh-rotate --dir "$WHOMBAT_RELEASES_DIR" --check       # root 3, rootThreshold 1, done false: nothing is read but metadata
# The ceremony: the new keys and a copy of the production key into a new 0700 folder; the new root (signed by the
# current root key and the three new ones) and the top-level targets (the new key) pushed like a publish.
$T gh-rotate --dir "$WHOMBAT_RELEASES_DIR" --offline-keys-dir ~/.config/whombat/releases-ceremony \
  --production-key-file ~/.config/whombat/releases-offline-keys/production.json
ls ~/.config/whombat/releases-keys                        # clients-0, development-0, production-0: no root, no targets
                                                          # (they leave only once the push succeeded)
# The workflow runs on the push; then (a minute or two):
curl -sf https://releases.whombat.com/4.root.json | jq '.signed.roles.root.threshold'   # 2
git -C "$WHOMBAT_RELEASES_DIR" pull -q && $T gh-rotate --dir "$WHOMBAT_RELEASES_DIR" --check   # done true
# Boxes walk to it from the root they pin: check from the oldest one an image pins.
$T check-newer --metadata-url https://releases.whombat.com/ --root manifest/dev-instance/tuf-root.json \
  --channel development --id whombat-YYYYMMDD.N --host-version whombat-YYYYMMDD.N --runtime-version 0 --manager-version 0
```

The last command verifies the chain and the Beta role (its answer about the made-up versions doesn't matter). Then:

1. The image pins the new root: `cp "$WHOMBAT_RELEASES_DIR/metadata/4.root.json" manifest/prod/tuf-root.json`, committed
   (the flake check `self-installed-config` then requires two root keys: NX-522).
2. The AI client channel for production boxes, right before Home moves (Home's clients refuse it until then):
   `$T gh-clients-env --dir "$WHOMBAT_RELEASES_DIR" --env prod`, `go run ./release-tools/cmd/clientchannel publish
   --repo "$WHOMBAT_RELEASES_DIR"` (re-signs the same bundles for env prod), `$T gh-clients --dir
   "$WHOMBAT_RELEASES_DIR"`, `$T clients-keys --dir "$WHOMBAT_RELEASES_DIR" --out manifest/prod/client-channel-keys.json`
   (env prod), committed. The client job publishes into the clone directly from then on (mirroring DEV's channel stops:
   its env is local).
3. The online production key's backup on The Titan (ONE-05): `~/.config/whombat/releases-keys/production-0.json`, 0600,
   in the same folder there.
4. John copies `~/.config/whombat/releases-ceremony/` (README.txt names every file and key id) to his offline media,
   the root keys apart, and checks each copy reads back. On his word: `rm -r ~/.config/whombat/releases-ceremony
   ~/.config/whombat/releases-offline-keys/production.json` (the production key is in `releases-keys` and offline).

A ceremony that stopped carries on when the same command runs again (UP-X47): the old root and targets keys stay in
`releases-keys` until GitHub has the new root, the ceremony's record (`.rotation-pending.json` in the clone) names its
offline folder and keys, and nothing is signed twice. Stopped at its push (GitHub down, refused): run it again, it
pushes what is signed, then retires the old keys. Stopped while signing (after the root, before the targets): run it
again with the same `--offline-keys-dir`, it signs what is missing with the same keys, root and targets together. Only
one that stopped while writing the new keys, before its record, left a folder of keys that sign nothing: remove that
folder and run it again. Rehearsed with throwaway keys (`release-tools/devtuf/rotate_test.go`,
`release-tools/ghpublish/ghpublish_test.go`; the scripts in the A1 and A2 reports): the chain from the pre-ceremony
root, the workflow's re-signing, promotion with the online production key, a later root of one key refused and never
cached (UP-X46), the push refused and run again, a ceremony stopped while signing and carried on.

### Moving Home to production (ONE-06)

When production runs Link (control, relay and the door for `*.box.whombat.app`), the key ceremony is done and its root
and the env prod client keys are in the image (“The key ceremony” below), and Home runs that image. Keep the
development stack running until John is signed in at Home's new address: until then `environment undo` takes Home back.
As root on Home (its console, or remote help: that session ends with the reboot), in order. A root shell has
`whombat-manager` on its PATH; a transient unit (`systemd-run`) has none: there, use
`/run/current-system/sw/bin/whombat-manager` (the boot's own units name its store path).

```sh
# 0. Before: a backup (Settings → Backups → Back up now), and check where the box is.
jq -r .default /etc/whombat/environments.json                          # prod: the Whombat image
whombat-manager environment show | jq -r .name                         # dev
jq -r '.deviceId, .env, .applianceRoute' /persist/identity/device.json # wb-…, local, rt_jw3bs1kz18n4hkj8hm65q1fxb4
ls /persist/identity/registration.json 2>/dev/null || echo none        # none: DEV control registered Home (2026-10-20)
jq -r .channel /var/lib/whombat-update-helper/channel.json             # development (Beta)
jq -r '.signed.roles.root.threshold' /etc/whombat/tuf/root.json        # 2: the rotated root is pinned
jq -r .env /etc/whombat/tuf/client-channel-keys.json                   # prod
stat -c '%d %n' /persist /persist/manager /persist/environment-moves 2>/dev/null
                                       # two numbers: /persist/manager is a subvolume of its own (MG-179), expected
btrfs subvolume list /persist | grep -w manager                        # ID … path manager
df -h /persist                                                         # room for a copy of manager/link and own-address
# 1. Stop the manager and move. Home's identity, which DEV control made, becomes its own (MG-178): the same device id
#    and keys, route `local`, env prod, and a kept registration signed for prod.
systemctl stop whombat-manager
whombat-manager environment set prod      # says: moves from dev to prod; its identity … is now its own
# 2. Have Link start by itself at the next start (the box's own registration, no session needed): the screen then
#    shows the Link code.
whombat-manager reach link
# 3. Check, then start everything in the new environment.
jq -r '.deviceId, .env, .applianceRoute' /persist/identity/device.json # the same wb-…, prod, local
jq -r .env /persist/identity/registration.json                         # prod
jq -c . /persist/whombat/environment.json                              # {"v":1,"env":"prod"}
ls /persist/environment-moves/                                         # <time>-dev: before/, new/, the old Link and address state
test ! -e /persist/environment-moves/pending && echo done              # no move under way
systemctl reboot
```

The move is all or nothing (MG-177): it checks the keys, the registration, every folder it writes to and the room for
its copies before it changes anything, keeps what was there in its folder (the Link and own-address state copied there,
checked, then removed from the manager's subvolume, MG-179), and undoes itself when a step fails (it says “the move stopped and
was undone”: fix the cause, run it again). One that stopped (power, a crash) is finished at the next boot by
`whombat-environment-move.service`, before anything reads the environment, or by running `environment set prod` again;
one that can't be finished then is undone. When it can be neither (the disk refuses writes), the boot holds the manager
and everything that reads the environment, says why on the console and in the journal (`journalctl -u
whombat-environment-move`), and keeps the move's record: fix the cause, then `whombat-manager environment recover` and
reboot. Home never starts half moved.

After it starts: `whombat-manager environment show | jq -r '.name, .controlUrl'` says prod and `https://api.whombat.com`,
and Home's screen shows a Link code with `app.whombat.com/link`. Then John, in order:

1. **Link.** On a computer or phone, open `app.whombat.com/link`, sign in with his production account (the e-mail's
   sign-in link; the first time it makes the account) and enter the code from Home's screen. Link starts; at
   admin.whombat.com his account gets free time, forever (ONE-09). Within minutes Home has its address,
   `<label>.box.whombat.app`: app.whombat.com lists Home with **Open**.
2. **Sign in at the new address.** **Open** (or the address) shows Home's page. Home is claimed, so it asks how this
   device gets in: **Use its screen**. Six letters appear on Home's screen; type them. The browser is in John's own
   account, with everything as it was: the owner, members, conversations, automations, files and servers.
3. **A box passkey** for the new address, on that browser: Settings → This Whombat → Devices → Add a passkey. From then on the
   browser signs in without the screen. Box passkeys belong to the address: the ones made at the DEV address and the
   ones made at dev.whombat.com don't work any more (they stay listed until removed).
4. **Phones.** The production app (TestFlight on the iPhone, the APK on Android, `--env prod`). Add Home with a device
   link from the signed-in browser (Settings → This Whombat → Devices → Add a device: the link or its QR code), or with the screen's
   letters. Phone notifications come back once the phone is signed in (its token goes to production control).
5. **Other people and old devices.** Members join the same way (a device link John sends, or the screen's letters).
   Settings → This Whombat → Devices still lists the old browsers and the DEV apps: remove them.
6. **Remote help** is granted again in Settings, with a help code (production's rules: no Forever grant).
7. **Check**: Settings → This Whombat → Updates says Beta; Servers shows every server reporting; an automation runs.
   Anything outside that called the old address (`<label>.dev.whombat.app`: a webhook, a bookmark, a shared link) is
   pointed at the new one.

Nothing on the disk is lost: the device id, its keys, the database, the files, the servers' hub and the backups stay.
What stops: the DEV address and its certificate, sessions and passkeys made for dev.whombat.com or the DEV address, the
DEV phone apps' way in, and remote help's grant. **Lockout**: until step 2 works, Home is reached only at its screen
(and on Tailscale when that is on). If Link doesn't start (no code on the screen: `journalctl -u whombat-manager | grep
-i link`; `device_exists` means production control already knows Home's serial or keys), undo while DEV still runs:
`systemctl stop whombat-manager && whombat-manager environment undo && systemctl reboot` puts the identity (route and
env), the registration, the environment file and DEV's Link and address state back as they were.

### The cleanup release (after Home's move)

One commit, its own release: `nix/profiles/environments.nix` loses `dev`; `manifest/dev-instance/` goes;
`prod-instance.nix` loses the channel bridge, `whombat.helper.interimRoot` and the `manifest/dev-instance` fallbacks (so
`manifest/prod/tuf-root.json` and `client-channel-keys.json` are required); the flake check `self-installed-config`
follows. Before it: `whombat-manager environment show | jq -r .name` says prod on every box that had `dev` (a box still
on `dev` would resolve to nothing and run without Link).

## Tests

```
TMPDIR=~/.cache/wb-tmp go test -race ./helper/... ./manager/... ./release-tools/...
(cd third_party/whombat-contracts-go && go test ./...)       # vendored contract vectors
```

Closure indexes (UP-X14): `helper/pkg/trust/index_test.go` (parsing and every refusal, NAR verification, resolution
through indexes, a component without one refused), `release-tools/devtuf/release_index_test.go` (export and publish round trip,
dedupe, refused listings and blobs, `nix path-info` formats), `release-tools/nixexport/frame_test.go`,
`helper/internal/ops/index_test.go` (staging through an index, corrupt blobs and NARs, no space),
`release-tools/cmd/tufrepo/main_test.go` (`add-index`: a fixture document and a placeholder, UP-X24),
`manager/internal/update/delta_test.go` (only missing blobs downloaded, a host release, a crash in the
middle of the downloads, a corrupt blob).

Store retention (UP-X18, UP-X19): `helper/internal/ops` `TestPruneRuntimeGenerations`,
`TestPruneRuntimeGenerationsKeepsCurrent`, `TestCollectGarbageDropsAStagedClosure`,
`TestCollectGarbageFollowsReferences`; `helper/internal/activator` `TestNixRuntimeGenerations`, `TestNixCollectGarbage`
(exact argv), `TestParseGCSummary`, `TestFakeCollectsWhatNoRootReaches`; `manager/internal/update/store_test.go` (after
each Healthy update and only then, before a queued update is staged, failures as warnings, at most once per update
across crashes, the watchdog fed while waiting). The fake activator
collects by reachability from its profiles' generations, the booted system and the references of NAR imports (a profile
the dev stack seeded without a generation link becomes generation 1 at the first switch), so every manager test (the
crash matrices too) collects after each update.

Versions and ordering: `helper/pkg/trust/transition_test.go` (every recorded release; `testdata/field-versions.json`),
`release-tools/devtuf/ordering_test.go`, `release-tools/cmd/tufrepo` `TestCheckNewer`. Custody rollback and failure
detail: `manager/internal/update/{custody_rollback,detail}_test.go`, `controlapi` `TestReportsToAnOlderControl`,
`broker` `TestUpdateFactsTellTheOwner` / `TestFactsToAnOlderRuntime`, `daemon` `TestFailureDetailReachesControl`.

The crash matrices (`manager/internal/update/crash_test.go`) inject a crash at every persisted transition and
effect of a runtime update, a bad-runtime rollback, a host update and a host boot fallback; `kill_test.go` does
the same with a real `SIGKILL` of a child process. Full-disk staging runs against a real 256 KiB tmpfs inside an
unprivileged user namespace (skipped where user namespaces are unavailable).
