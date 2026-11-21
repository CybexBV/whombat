# Restore drills and quarantine restores

Decisions: BK-12 (drills), BK-08 (authentication), BK-13 (replacement uses the same restore), BK-24 (onto a
fresh box), BK-34 (the servers), BK-36 (the Hermes homes), BK-39 and BK-40…BK-48 (the app's restore, undo, power
cuts, cleanup, the adopted key, stale locks). Code: `backup/pkg/restore`, `backup/internal/drill`,
`backup/internal/quarantine`.

## Run a drill

```sh
whombat-backup drill                         # newest checkpoint, structure check, private throwaway cluster
whombat-backup drill -check-data 5%          # also read and verify 5 % of all pack data
whombat-backup drill -check-data all -snapshot ck-20260925T132320Z-1e8574 -json
whombat-backup drill -audit-verify "/path/to/runtime/audit-verify"   # the runtime's own audit-chain verifier
```

The NixOS unit `whombat-backup-drill.timer` runs one weekly (`-check-data 5%`). The result becomes the status's
`recoverability.lastDrill` (ok, RTO, backup age, failed and skipped checks).

## Restore a checkpoint onto a fresh box (UP-F2)

When a box can't be brought back (a migration broke its database, the disk died, a reinstall) its newest checkpoint
— for a failed update, the verified checkpoint the manager took before the migration — goes onto a freshly installed
box. This is also the restore drill of the upgrade gates (`vm-tests/upgrade-gates`, gate 7) and of
`vm-tests/backup-destinations.nix`. All commands as **root** at the box's console: `adopt`, `resolve` and `status`
run as the backup user by themselves (the kit file you name is handed over), `prepare`, `apply` and `release` stay
root and never follow anything in the backup user's directory; the secrets are unsealed into a private directory on
`/run` for the run (BK-24, BK-26). A plain `http://` destination must be a numeric address on your network (BK-29). `cfg=$(systemctl cat whombat-backup | grep -o '/nix/store/[^ ]*whombat-backup.json' | head -1)`.

1. **Install and claim** the fresh box as usual (from the ISO, `install.md`; claim it into the same organization). It now has
   its own files, master key and a migrated database: nothing of that is kept. After a failed update, install the
   release the old box ran *before* the update (its ISO is kept with the release), so the runtime reads the
   checkpoint's schema; the update is then retried once its fix is released.
2. **Stop the runtime** (and keep it stopped until step 6):
   ```sh
   systemctl stop whombat-runtime.target whombat-server.service whombat-runner.service
   ```
3. **Join the repository with the recovery kit** (the whole kit or its backup section, e.g. copied from a USB
   stick): repository, password, the destination's credentials (REST user, S3 key, or the old box's SFTP key and
   pinned host key) and the old box's manifest key, whose checkpoints the restore trusts.
   ```sh
   whombat-backup -config $cfg destination adopt -kit /root/kit.json
   ```
   For the backup disk, attach the old box's disk first (it mounts by its label). For SFTP, the new box uses the
   old box's key from the kit; afterwards give it its own (`ssh-public-key`, add it on the NAS, set the destination
   again) and remove the old key from `authorized_keys`.
4. **Set the fresh install aside** — its files move to `/persist/whombat-set-aside-<time>/`, its database is renamed
   to `whombat_set_aside_<time>` and an empty `whombat` owned by the runtime's role is created. Nothing is deleted:
   the folder's `set-aside.json` records each change first, so `quarantine undo` (or the runtime's next start) puts
   the fresh install back if the restore doesn't finish (BK-40, BK-43). Keep the runtime stopped until step 6: its
   start undoes a prepare that no apply followed.
   ```sh
   whombat-backup -config $cfg quarantine prepare -admin-dsn "host=/run/postgresql dbname=postgres user=postgres"
   ```
5. **Restore in quarantine**: every drill check first (restic check with 10 % of the data read, the manifest
   signed by the old box's key, restore `--verify`, dump hash, row counts, attachments, git), then the files into
   the live directories (the btrfs subvolumes stay; they are filled) and the database as the role `whombat`,
   read-only, with `/persist/backup/quarantine.json` written first. `-snapshot <checkpoint id>` picks one (default:
   the newest); `-kit /root/kit.json` also checks that no newer checkpoint the kit knows was withheld.
   ```sh
   whombat-backup -config $cfg quarantine apply \
     -dsn "host=/run/postgresql dbname=whombat user=postgres" \
     -admin-dsn "host=/run/postgresql dbname=postgres user=postgres" -check-data 10%
   ```
   The checkpoint's schema version is in the marker (`restored.schemaVersion`); the runtime's own schema check
   decides at start whether it reads it (MD-10). **The servers** (a checkpoint of a box with the hosts service,
   BK-34): after the `hosts` check, the hosts service's own backup is put at `/persist/hosts/restore-staged.tar`
   (`restore-staged.tar.gz` when the checkpoint carries the older gzipped `hub.tar.gz`; its user's, 0600) and the marker says `"servers": "staged"`; the service applies it at its next start, and
   doesn't start while the box is in quarantine. On a box without the hosts service the rest is restored and the
   marker says `"no-hosts-service"`. Checkpoints from before have no servers and restore as always. **The agent's
   Hermes homes** (BK-36): every person's home and the shared skills fill `/persist/whombat/hermes` with the other
   sources, after the `hermes` check, and the marker says `"hermes": "restored"`. A checkpoint from before them
   (`"hermes": "none"`) leaves the directory empty: everyone starts with an empty memory and new sessions, and the
   runner puts the release's skills back at its start.
6. **Reconcile and release** (`replacement.md` §4 for what each item means), then start the runtime:
   ```sh
   whombat-backup -config $cfg quarantine resolve old-appliance decommissioned   # … every required item
   whombat-backup -config $cfg quarantine release -admin-dsn "host=/run/postgresql dbname=postgres user=postgres"
   systemctl start whombat-runtime.target
   systemctl restart whombat-hosts.service   # where the box has the hosts service: it applies the staged servers
   ```
   The hosts service keeps this box's service token and makes its agents' listener certificate for this box's
   address; the servers' agents trust it by the CA they know (hosts HS-170…).
7. **Backups continue** into the same repository from this box (its own manifest key and chain): give the owner a
   new recovery kit. The release removes what was set aside (`whombat-backup-restore-recover.service`, started by
   the release's `restore-cleanup.json`: the folder and the `whombat_set_aside_<time>` database, BK-44). From now on
   the old box's key is trusted only for the checkpoints it had made up to the restored one (BK-45).

A restore that stops part-way (`phase: restoring`, or a prepare without an apply) is put back as it was by
`whombat-backup -config $cfg quarantine undo`, or by itself at the runtime's next start (a power cut included); then
start again from step 4.

## The app's restore

The person picks a backup in the app; the manager takes a maintenance lock and has the update helper start
`whombat-backup-restore@<checkpoint>` (BK-39). Its script holds `/persist/.whombat-restore.lock` throughout and:

1. reads this release's schema version from the fresh install's `schema-check --json`;
2. runs `whombat-backup restore -snapshot <id> -release-schema <n>`: anything left by an earlier restore that didn't
   finish is put back first; then, with the runtime still running, it refuses in plain words a missing place, a
   backup that isn't there or isn't trusted, a backup from a newer Whombat, and not enough room (on `/persist`, and in
   Whombat's qgroups); only then the runtime stops, prepare and apply run (structure-only `restic check`; `restore
   --verify` proves the checkpoint; restic's cache for the restore lives in its staging directory and goes with it,
   manifests read before come from the box's cache, and root writes nothing into either cache), the database becomes
   writable. Any failure from there is undone and the
   runtime starts again (BK-41, BK-42);
3. brings the schema to this release's (`schema-check`, `migrate --checkpoint`); a newer schema (exit 11, 12), a
   failed migration or a failed check is undone with `restore-end -failed <reason>`, success ends with `restore-end`;
4. starts the runtime, which serves the person's checklist in quarantine.

`restore-result.json` (`ok`, `reason`: `no_place`, `unreachable`, `not_found`, `newer`, `no_space`, `busy`,
`interrupted`, `migration`, `failed`; `error`: the sentence the app shows; `detail`: technical words for support) is
what `GET /v1/quarantine` reports as `failed` with “Try again”, its `reason` and `error` (`error` keeps its curly quotes
and script, on one line), never `detail` (BK-52). The runtime's
`POST /v1/quarantine/release {oldWhombat, checkpointId}` is refused (409) when the restore waiting for the answers is
another checkpoint's; once released, `GET /v1/quarantine` says `released` with the same `since` it had while it waited
(the runtime knows a restore by it) until a later attempt ends. The manager gives its lock back as soon as the
restore failed, was released or never started (MG-149). Look at `journalctl -u 'whombat-backup-restore@*' -u whombat-backup-restore-recover`.

## What "quarantine" means

- A fresh directory `/persist/backup/drill/<id>/root` and a fresh database. By default that's a private
  PostgreSQL cluster (`initdb` in the drill directory, unix socket only, started and stopped by the drill), so
  the live cluster is never touched. `-server-admin-dsn` creates a database on a server instead.
- The restored database is made `default_transaction_read_only = on` right after loading.
- Nothing is started from the restored data: no runtime, runner, schedule, automation or outbound effect.
- The repository is read **without** the appliance's restic cache, so the drill sees what a recovery would.
- Everything is removed afterwards (`-keep` keeps it for inspection).

## Checks (in order)

| Check | What it proves |
|---|---|
| `restic-check` | repository structure (and with `-check-data`, that the pack data reads back and matches its hashes) |
| `manifest` | the checkpoint's manifest is signed by the trusted manifest key, the snapshot's `mf:`/`ck:` tags match it; reports unauthentic snapshots, chain gaps, duplicate manifests |
| `restore` | `restic restore --verify`: every restored file re-read against the repository |
| `dump-hash` | the database dump is the one the manifest names (sha256, size) and parses (`pg_restore --list`) |
| `database` | `pg_restore --no-owner --no-acl --single-transaction --exit-on-error` into the empty database, then read-only |
| `row-counts` | every table's row count and the schema version equal the manifest's (read in the checkpoint's snapshot) |
| `attachments` | every blob's sha256 equals its name; the restored database references exactly the manifest's blob set, all present |
| `hermes` | only for a checkpoint with the Hermes homes (BK-36): every home it names is back, each SQLite store (`state.db` and its write-ahead log, so its sessions) byte for byte as the manifest's sha256 and size, and as many shared skills |
| `hosts` | only for a checkpoint with the servers: the hosts service's backup is the one the manifest names (sha256, size) and reads to its end (a complete gzip of a tar with `manifest.json` and `hub.db`) |
| `audit-chain` | the runtime's `audit:verify` over every burrow's chain (signatures, hashes, links). **Skipped** (and listed as skipped, never as passed) when not configured |
| `git` | `git fsck --full --strict` for every repository; HEAD, refs digest, unpushed commits and staged/modified/untracked lists equal the manifest. This is where "unpushed commits and uncommitted/untracked files survived" is proven |

**RTO** is wall time from drill start to the end of the last check: restic check, restore, database load and
all verification. **Backup age** is drill start minus the checkpoint instant: how much would be lost at that
moment. No SLA is derived from either.

## Measured (dev host, not appliance hardware)

| Run | Dataset | Drill RTO | Backup age |
|---|---|---|---|
| `TestRoundTripWithUnpushedAndUncommittedWork` (read-data all) | 250 messages, 5 blobs, 3 repos, concurrent writer | 2.8 s | 2.0 s |
| `scripts/real-runtime.sh` (real runtime schema 29, `audit:verify` ok, read-data all) | runtime seed world: 82 tables, 372 rows, 52 signed events | 3.6 s | 2 s |
| `scripts/e2e.sh` (CLI) | 100 messages, 1 repo | 3.5 s | 4 s |
| `TestScaleMeasurement` (structure check) | 1 GiB incompressible files + 200 000 rows | 4.5 s | 2.8 s |

The host is a 64-core machine with 188 GB RAM on ZFS, with the REST server on loopback. Real RTO is dominated by
download bandwidth from the destination and disk speed, and must be measured on the sold hardware against the
customer's destination (the drill does exactly that).

## Failures and what to do

- A backup made before release 0.268.0: its database is on the schema chain that release moved every Whombat off, and
  later releases refuse it in plain words (“update this Whombat to 0.268.0 first …”, schema-check exit 12), so the
  restore is undone (`migration`). Restore it on a box running 0.268.0 (a build of it is kept for this), let the
  runtime start once, which moves the database across, then update as usual (Whombat `docs/upgrade.md`).
- A repository locked by a restic that was killed (a power cut, a timeout): nothing to do. Stale locks are removed
  before every check, forget/prune and copy and after a `locked` error, and a cancelled restic removes its own
  (BK-46). `restic unlock` by hand removes only stale ones too.

- `restic-check` failed: the repository is damaged or tampered with (`ciphertext verification failed`, damaged
  packs). Don't prune. Run `restic check --read-data` on the maintenance side, then follow restic's
  troubleshooting guide. Older checkpoints whose packs are intact still restore: drill them with
  `-snapshot`. Tested: a flipped byte in a pack fails `restic-check` (`TestCorruptedPackIsDetected`).
- `manifest` failed or unauthentic snapshots are listed: someone holding the repository password (a compromised
  appliance or a leaked kit) added snapshots, or the destination altered one. The drill ignores unauthentic
  snapshots. Investigate before pruning, and rotate the kit if it leaked.
- `dump-hash` failed with an authentic manifest: a replay of a genuine manifest with other data. Use the other
  snapshot with the same checkpoint id (`chain.duplicates`).
- `row-counts`/`attachments`/`git` failed: report it. The checkpoint doesn't restore what it recorded.
