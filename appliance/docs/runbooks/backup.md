# Backup runbook (appliance)

Decisions: `docs/decisions/backup.md` (BK-01…BK-74). Code: `backup/`. Related runbooks: `restore.md` (drills),
`replacement.md`, `recovery-export.md`.

## What is backed up

Generated from `backup/pkg/coverage` (`whombat-backup coverage`); a test keeps this table identical to the code.

<!-- coverage:begin -->
| Class | Covered | Source | Checkpoint method | Restore |
|---|---|---|---|---|
| Database (`database`) | yes | PostgreSQL 17 database `whombat` (every schema, incl. `whombat_meta` and `drizzle`): channels, threads, DMs, messages, runs, approvals, keys and grants, accounts, principals, endpoint enrollments, recovery authority, audit chain, schedules and automations, connectors (tokens sealed under the master key), command receipts, session events | `pg_dump -Fc -Z0 --snapshot=<exported>` from the snapshot exported inside the quiesce; row counts and schema version read in the same snapshot | `pg_restore --no-owner --no-acl` into an empty database; then the runtime's `schema-check` / `migrate --checkpoint` |
| Memory and conversations (`memory`) | yes | `/persist/whombat/hermes`: the agent's Hermes home — what it remembers (`memories/MEMORY.md`, `USER.md`), its sessions (`state.db` with its write-ahead log, `sessions/`) — with the outsiders' profile (`profiles/_feedback/`) and `/persist/whombat/hermes/pending` (session deletes still owed) | filesystem snapshot of `hermes` taken inside the same quiesce: one atomic snapshot of the home, so each SQLite store and its write-ahead log are as one instant had them (a running turn's too); each store's sha256 in the manifest | the home back as it was, each store checked against its sha256; SQLite replays the write-ahead log at the first open. A checkpoint made before the home was backed up has none: the agent starts with an empty memory and new sessions |
| Attachments and files (`attachments`) | yes | `/persist/whombat/home/files` (content-addressed `sha256/aa/bb/<sha256>`, Feedback screenshots included) | filesystem snapshot of `home` taken inside the same quiesce; referenced blobs checked present | files back; every blob's sha256 checked against its name, every blob the database references present |
| Skills (`packs`) | yes | `/persist/whombat/hermes/skills`: the agent's skills — Hermes's built-ins, what was installed from the hub and what the agent learned — and the ones switched off | filesystem snapshot of `hermes` | files back; Hermes's own sync brings its built-ins up to date at the next start and keeps the rest |
| Other runtime state (`home`) | yes | everything else in `/persist/whombat/home` except the transient names below | filesystem snapshot of `home` | files back |
| Workspaces, repositories and the agent's home (`workspaces`) | yes | `/persist/whombat/workspaces`: whole working trees and `.git` (objects, refs, reflogs, stashes, worktree metadata), so **unpushed commits, uncommitted changes and untracked files** (git-ignored ones too, e.g. `.env`) are in it; and `/persist/whombat/agent/home`, the agent's home (its own files and projects, what it installed there), except its `.cache` | filesystem snapshots of `workspaces` and `agent`; per-repository inventory (HEAD, branches, unpushed commits, modified and untracked counts) in the manifest | trees back; worktree/alternates paths relocated; `git fsck` and the manifest's unpushed commits and dirty files checked |
| Configuration and master key (`configuration`) | yes | `/persist/secrets` (the master key that seals signing keys and connector tokens in the database); settings live in the database; the NixOS configuration is declarative and identified by the runtime tuple in the manifest | filesystem snapshot of `secrets` | master key back (without it the database's sealed secrets can't be opened) |
| Provider session state (`provider-sessions`) | yes (re-login) | `/persist/whombat/credentials/<account>/<provider>/` (per-identity Codex, Claude, GitHub homes) | filesystem snapshot of `credentials` | homes back; **may need re-login after restore** (refresh tokens rotate; a replacement must re-verify every login, BK-13) |
| Servers (`servers`) | yes | `/persist/hosts`, only where the hosts service runs: the servers people added, what Whombat may do on them and their history (its SQLite database), and the agents' CA | the service's own backup (`whombat-hosts backup`: a consistent copy of the database, and the CA) made as its user just before the quiesce into `/persist/hosts-backup/hub.tar` (uncompressed; `hub.tar.gz` from a hosts service from before), then snapshotted as `hosts`; its sha256 and size in the manifest | the archive checked (its sha256, `manifest.json` and `hub.db` in it), then put at `/persist/hosts/restore-staged.tar` (`restore-staged.tar.gz` when gzipped; the service's, 0600), which the service applies at its next start; its service token and the agents' listener certificate stay the new box's |
| Recovery material references (`recovery-references`) | yes | appliance id, management key fingerprint, content PeerId, recovery authority fingerprint, manifest signing key, restic repository id | recorded in the signed checkpoint manifest (references only, never private keys) | used to check the kit matches and to reconcile identities on a replacement |
| Appliance identities (`identity`) | **no** | `/persist/identity` (management key, content identity) | not backed up: a replacement gets fresh identities (MA-03, BK-07) | fresh provisioning; clients re-pin through the recovery or trusted-endpoint ceremony |
| Recovery key and backup password (`recovery-secrets`) | **no** | customer's recovery kit | never in a backup (the recovery key never is on the appliance; the repository password opens the backup) | the kit authorizes the restore |
| Manager state (`manager`) | **no** | `/persist/manager` (journal, TUF cache, staged releases, known-good) | device-local, rebuilt by provisioning and the update service | — |
| PostgreSQL data directory (`postgres-datadir`) | **no** | `/persist/postgres/17` | replaced by the logical dump (`database`) | — |
| Backup service state (`backup-state`) | **no** | `/persist/backup` (staging, status, manifest key) and `/persist/backup-root` (the sealed destination secrets, the pinned backup disk; root only) | the backup's own state; password, destination credentials and manifest key are in the kit | re-created by `whombat-backup destination adopt` |
| Caches (`caches`) | **no** | see the cache rule; and `/persist/containers`, the agent's containers (their images, the containers and their volumes) | excluded (regenerable, not authored); the containers are never a source | regenerated by the project's own install/build; the agent runs its containers again from their images |

Transient names under `/persist/whombat/home`, never backed up: `logs`, `locks`, `backups`, `diagnostics`, `pgdata`, `guarded`, `whombat.pid`, `maintenance.lock`, `maintenance.json`, `last-backup.json`. Under `/persist/whombat/hermes`: `locks`, `transfers`, `check`, `signin`, `logs`, and in each of its profiles `logs`.

**Cache rule.** A path is a cache, and left out, only if it is regenerable and not authored: (1) a directory holding a `CACHEDIR.TAG` (Cache Directory Tagging Specification, restic `--exclude-caches`); or (2) inside a git repository, a directory git **ignores** whose name is one of the cache names (for `target` only next to a `Cargo.toml`, for `.venv`/`venv` only with a `pyvenv.cfg`); or (3) in-flight uploads (`home/files/.staging`) per-turn scratch and transient push repositories (`workspaces/.scratch`, `workspaces/.push`), and the agent's own caches (`agent/.cache`). Everything else is kept, including git-ignored files that are not caches (`.env`, local config) and untracked directories named like caches. The excluded paths of each checkpoint are listed in its manifest.

Cache names: `.angular`, `.cache`, `.dart_tool`, `.direnv`, `.gradle`, `.mypy_cache`, `.next`, `.nox`, `.nuxt`, `.parcel-cache`, `.pnpm-store`, `.pytest_cache`, `.ruff_cache`, `.svelte-kit`, `.terraform`, `.tox`, `.turbo`, `__pycache__`, `bower_components`, `node_modules`; conditional: `.venv` (needs `pyvenv.cfg`), `target` (needs `../Cargo.toml`), `venv` (needs `pyvenv.cfg`).
<!-- coverage:end -->

**Provider session state** is backed up but a restore **may need re-login**. Refresh tokens rotate, and a
replacement must re-verify every login before leaving quarantine (BK-13).

## How a checkpoint is made (BK-04…BK-06)

```
preflight  destination opens with the password (repository id matches); staging clean; space for the dump;
           runtime tuple from /health                                     (nothing paused yet)
hosts      where the hosts service runs: its own backup, made as its user → /persist/hosts-backup/hub.tar
           (hub.tar.gz from a hosts service from before; connect to /run/whombat-backup/hosts.sock, answer "ok"; a
           failure leaves the servers out of this checkpoint, recorded, and everything else goes up, BK-64)
quiesce    POST /drain {reason: backup, scope: writes|all, leaseMs} until safe (bounded, lease renewed)
  inside   BEGIN REPEATABLE READ READ ONLY; SELECT pg_export_snapshot()   ← the checkpoint instant
           snapd take: home, workspaces, credentials, hermes, agent, secrets (+ hosts) → staging/current/files/<name>
resume     POST /resume                                                    (writes paused only for "inside")
dump       pg_dump -Fc -Z0 --snapshot=<id>, hashed as it is written; row counts, schema version, referenced blobs
           in the same snapshot
inventory  repositories (unpushed, staged, modified, untracked), cache excludes, source sizes; the hosts
           service's backup read to its end, its sha256 and size into the manifest; referenced attachments the box
           no longer has, and a servers export that failed, recorded as the checkpoint's gaps (BK-64)
manifest   manifest/checkpoint.json + .sig (Ed25519 manifest key); seq handed out now (<stateDir>/seq, BK-61) +
           previous (hash chain to the last checkpoint read back)
upload     cd staging/current; restic backup db manifest files/* --tag whombat-checkpoint --tag ck:<id> --tag mf:<sha>
           (--pack-size 32 to REST/S3, --read-concurrency 4; the copy driver adds --ignore-inode --ignore-ctime, BK-69)
verify     read back the snapshot's tags and the manifest; append to checkpoints.jsonl; status
clear      after a scheduled backup, at most daily, where the box may delete: the windows, then the space limit
release    snapd release; staging emptied
```

- **Scope `writes`** (btrfs/ZFS snapshots): a write barrier; running turns continue. Measured on the dev host:
  the barrier is held for tens of milliseconds.
- **Scope `all`** (the copy fallback, for a layout without snapshots; the appliance's btrfs `/persist` takes
  snapshots): no new turns, session commands
  answer `unavailable`, running work finishes first, and the copy happens inside. The manifest and status say
  `quiesced-copy` with the pause in ms. Measured on the dev host (ZFS, data hot in cache, 188 GB RAM):
  1 GiB + 200 000 rows paused 84 ms (byte copy) / 160 ms (FICLONE). **Not representative of appliance
  hardware**: without snapshots and with a cold cache expect roughly data size ÷ disk copy throughput.
- **Quiesce timeout** (default 120 s): the checkpoint gives up, the drain is released, **nothing is stopped or
  cancelled**, and the status says why ("couldn't reach a safe moment within 2m0s: migration m-0028 (backfill
  running, since …); nothing was stopped or cancelled, the backup will retry"). The 15-minute timer's next run tries
  again (a failed try waits 15 minutes, BK-37); no systemd restart is involved.
- **A gap instead of no backup** (BK-64): an attachment the database references but the box no longer has, or a
  servers export that failed, doesn't stop the checkpoint. The manifest records it (`incomplete`), the status says it
  in plain words (`lastSuccess.incomplete.reason`), and a check of that backup reports the servers skipped.

## When backups run, and who clears old ones (BK-37, BK-60…BK-66)

- **Slots** are the person's: `nightly` 03:00, `6h` 03/09/15/21, `hourly`, in the policy's time zone. Each day's slots
  are that day's wall-clock hours, so a slot whose hour summer time skips moves past the gap. `run -if-due` (every 15
  minutes) runs when nothing was backed up since the newest slot or the destination changed; a failed try waits 15
  minutes. Times recorded while the clock ran ahead never hold a backup back.
- **The weekly check** (`drill -if-due`, hourly) is due 6½ days after the last, between 04:00 and 07:00 in the person's
  zone, or at any hour once it is 8 days overdue. It reads 5% of the data (`restore.CheckWeekly`).
- **“Check this backup now”** (`POST /v1/drills`) queues a request (`drill-request.json`); the drill takes it once it
  holds the run lock, so one asked for during a backup waits for it.
- **Failing** (BK-65): only after two failed tries in a row (`failedAttempts`), or one while the backups are late.
- **Who clears** (`status.clearing.by`): `box` wherever this Whombat's key may delete (disk, SFTP, S3, a REST server
  without `--append-only`, its own disk): after a scheduled backup, at most once a day, `restic forget --keep-within*`
  with the person's windows and `--prune`; `destination` where the destination refuses deletes (append-only): its own
  side clears (a backup place's cleanup, or the maintenance instance below), or nobody.
- **The space limit** (`limitBytes`, BK-63): over it, the box forgets again with ever shorter windows, the same steps as
  a backup place's cleanup: months 6, 3, none; weeks 4, none; days 7. Every backup of the last 7 days (or more, when
  the person keeps more) stays. Still over at the end: `clearing.overLimit`. The size is the repository's folder on the
  disk and the box's own disk, else `restic stats --mode raw-data`.

## Destinations

You set the destination in the app (Settings → This Whombat → Protect your Whombat, UP-F1): the session
op `backup.configureDestination` passes the contract's input (CT-142) unchanged to `PUT /v1/destination`. At the
console the same is `whombat-backup destination set` (root or the backup user). Whatever the kind: the box
verifies the destination before it replaces the old one (a mistyped key never breaks working backups), keeps
the secrets sealed (BK-23), and afterwards **you save a new recovery kit** (the generation changed).

| Kind | Repository | Credentials | Append-only | What someone holding the kit's credential can do |
|---|---|---|---|---|
| REST server | `rest:https://host:8000/box/` (plain `http://` only to a numeric address on your network, BK-29) | `restUser`, `restPassword` | `verified` with `--append-only` | read and add, never delete |
| S3-compatible | `s3:https://host/bucket/path` | `s3AccessKeyId`, `s3SecretAccessKey`, `s3Region` | `not-enforced` | **delete every backup** (unless versioning/lock keeps old versions) |
| SFTP / NAS | `sftp:host:/path`, `sftp://host:port//path` | `sftpUser` + the box's key; `sftpHostKey` pinned | `not-enforced` | **delete every backup** (unless the NAS keeps snapshots) |
| Backup disk | `disk:` | none | `not-enforced` | whoever has the disk has the (encrypted) backups; the password is in the kit |

### restic REST server (`rest:`, BK-09)

The qualified destination: a **restic REST server in `--append-only` mode**, run by the customer or their
storage provider. The only kind whose credential can't delete backups (append-only `verified`).

```sh
# on the storage host (customer side)
rest-server --path /srv/restic --listen :8000 --append-only --tls ... --htpasswd-file /etc/restic/appliance.htpasswd
# the separate maintenance instance: same data, full access, its own user, reachable only from the admin host
rest-server --path /srv/restic --listen 127.0.0.1:8001 --htpasswd-file /etc/restic/maintainer.htpasswd
```

On the appliance (through your client → runtime → `PUT /v1/destination`, or at the console for tests):

```sh
whombat-backup destination set -repository rest:https://backup.example:8000/appliance/ \
  -user appliance -password-file /path/to/rest-pw -init
# → "append-only verified": the appliance tried to delete a random non-existent key and got 403
```

**An append-only server is cleared only from its own side** (the box can't delete there): a backup place's cleanup
does it with the person's windows and space limit; for your own server, run the maintenance instance with
`--keep-within`:

```sh
restic -r rest:http://127.0.0.1:8001/appliance/ forget --keep-within 90d --prune
restic -r rest:http://127.0.0.1:8001/appliance/ check --read-data-subset 5%
```

Never use `--keep-last`/`--keep-daily` against an append-only repository. An attacker with the appliance's
credential can add snapshots dated in the future, and those policies then drop the real checkpoints. Tested:
`--keep-last 1` would keep only the attacker's 2099 snapshot and remove all 3 real checkpoints; `--keep-within 30d`
kept every real checkpoint (`TestMaintenanceCredentialForgetPrune`). Check snapshot counts and dates before
pruning (`whombat-recovery list` flags unauthentic ones). Object locking is not prescribed (not tested).

What the appliance credential **cannot** do (tested against rest-server 0.14.0, `TestAppendOnlyRefusesDeletionAndOverwrite`):

| Attempt with the appliance credential | Result |
|---|---|
| `restic forget --prune <snapshot>` | fails: `Remove(<snapshot/…>) … 403 Forbidden`; snapshot still there |
| HTTP DELETE of `data/`, `snapshots/`, `keys/`, `index/` objects | 403 |
| HTTP POST (overwrite) of an existing pack, snapshot, `config` | 403 |
| POST of a new object whose name isn't its sha256 | 400 |
| `restic key remove` | fails (key add works: it only appends) |
| DELETE of lock files | allowed (restic needs it; harmless) |
| appliance credential against the maintenance instance | refused (not in its htpasswd) |

### S3-compatible bucket (`s3:`, BK-18)

Your steps (AWS S3, Backblaze B2, Wasabi, Cloudflare R2, a MinIO on the NAS, …):

1. Create a bucket for this Whombat (or let Whombat create it: “allow Whombat to create the repository”).
2. **Turn on versioning** and a lifecycle rule that deletes non-current versions after 30 days or more (or Object
   Lock in governance mode). The box's key can delete objects; with versioning a deletion only hides them for the
   retention time. Whombat can't check this and shows append-only `not-enforced`.
3. Create an access key limited to this bucket (list, read, write, delete — restic removes its own lock files).
4. In the app: endpoint + bucket + path (`s3:https://s3.eu-central-1.amazonaws.com/my-bucket/whombat`), access key
   ID, secret, region when the service needs one.

```sh
whombat-backup destination set -repository s3:https://s3.example.com/my-bucket/whombat \
  -s3-key-id AKIA… -s3-secret-file /root/s3-secret [-s3-region eu-central-1] -init
```

The secret reaches restic only in its environment (never its command line, the status or a log). Typical errors
and what they mean: “The bucket refused the access key” (key or secret wrong, or no permission on this bucket),
“The bucket doesn't exist”, “The bucket is in another region”.

### SFTP / NAS (`sftp:`, BK-19)

Your steps (Synology, QNAP, TrueNAS, any Linux host with OpenSSH):

1. On the NAS, make a user for the backups (SFTP only if the NAS offers it) and a folder it may write.
2. In the app, “SFTP / NAS” shows **this Whombat's public key** (`backup.sshPublicKey`, made on first use):
   add it to that user's `~/.ssh/authorized_keys` on the NAS.
3. Enter host, folder and user. Leave the host key empty to trust the NAS on first contact: the app then shows the
   fingerprint it pinned — compare it with the NAS's (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the NAS,
   or its web UI). Or paste the NAS's host key line (or its `SHA256:` fingerprint) to pin it up front.
4. Turn on the NAS's own snapshots of that folder: the box's key can delete what it wrote.

```sh
whombat-backup ssh-public-key                       # add the first line to the NAS user's authorized_keys
whombat-backup destination set -repository sftp:nas.local:/volume1/whombat -sftp-user whombat -init
# → pinned host key SHA256:… — compare it with the server's
whombat-backup destination set -repository sftp://nas.local:2222//volume1/whombat -sftp-user whombat \
  -sftp-host-key "ssh-ed25519 AAAAC3…"               # or -sftp-host-key SHA256:…
```

ssh runs with no configuration files and no agent, only the box's key, strict host key checking against the one
pinned key. If the NAS is reinstalled its host key changes and backups stop with “The server's host key doesn't
match…”: set the destination again and compare the new fingerprint (never accept a change you can't explain).
“The server refused this Whombat's key”: the public key isn't (or no longer) in `authorized_keys`.

### Backup disk (`disk:`, BK-20)

A disk attached to the Whombat itself (on a dedicated machine: a USB disk; on a VM: a second virtual disk on storage
other than the system disk's, e.g. on Incus `incus config device add <vm> backup disk pool=<pool> source=<volume>`,
on Proxmox VE *Hardware → Add → Hard Disk*). Not off-site: protects against a broken system disk or a bad update, not
against losing the machine.

- Let Whombat prepare it: attach an **empty** disk (1 GiB or more) and choose “Local disk” with “prepare the disk”
  (`allowInit`). The root helper formats it only if it is the one attached disk that is empty and unused (no
  partitions, no filesystem, zeros at its start); with two empty disks it asks you to attach only one.
- Or prepare it yourself: `mkfs.ext4 -L WHOMBAT-BACKUP /dev/sdX` (or `mkfs.btrfs -L WHOMBAT-BACKUP`).

Choosing the disk destination pins that disk (its filesystem UUID): from then on only that disk is mounted, at
`/persist/backup/disk`, whenever it is attached (`nodev,nosuid,noexec,noatime,nosymfollow`), and the repository is
`whombat/repository` on it. Before a disk destination is set no disk is mounted at all, and a disk that merely
carries the label is never mounted (BK-27). To move to another disk, attach it (alone) and choose “Local disk”
again: it is pinned instead.
While it is missing the status says “The backup disk (labelled WHOMBAT-BACKUP) isn't attached…” and backups (and
migrations that need a checkpoint) wait. `whombat-backup disk-scan` lists the disks and why each can or can't be
prepared.

```sh
whombat-backup destination set -repository disk: -init
```

## Recovery kit (BK-15)

Your client builds the kit. It generates the recovery key itself and fetches the backup section from the
appliance (a session op, served by `GET /v1/recovery-material` to the runtime uid only):

```json
{ "kind": "whombat.backup-recovery-material/1", "applianceId": "…", "generation": 1, "createdAt": "…",
  "repository": "rest:https://backup.example:8000/appliance/", "restUser": "appliance", "restPassword": "…",
  "repositoryPassword": "…", "repositoryId": "…", "manifestKey": "ed25519:…",
  "head": {"seq": 4, "manifestSha256": "…", "at": "…"},
  "adopted": [{"applianceId": "wb-x2fn-7kvd-9946", "manifestKey": "ed25519:…",
               "until": {"checkpointId": "ck-…", "seq": 2, "manifestSha256": "…", "known": ["…", "…"]}}] }
```

`head` is the newest backup the box had made (a restore from the kit checks no newer one was withheld). `adopted` is
there on a Whombat that was brought back from another (BK-79): each earlier Whombat's manifest key with its cut-off,
the backup brought back and that Whombat's backups known then (newest first, at most 4 Whombats and 128 backups each).
A box that adopts the kit trusts the kit's own key for its backups and each earlier key only up to its cut-off, so
bringing this Whombat back keeps the history it brought back; what a stolen earlier box signs later never counts.

For S3 the kit carries `s3AccessKeyId`, `s3SecretAccessKey`, `s3Region`; for SFTP `sftpUser`, `sftpPrivateKey`
(the box's key, OpenSSH PEM) and `sftpHostKey` (the pinned host key); for the backup disk nothing more
(`whombat-recovery … -repo-dir <where the disk is mounted>`). With the kit alone, `whombat-recovery` reaches every
kind from another machine (BK-14).

`generation` changes whenever the destination, password or manifest key change: the client must then ask
you to save a new kit. Password rotation: `restic key add` works append-only, but removing the old key needs
the maintenance side, and the repository's master key only changes with a new repository.

## Status (BK-11)

`GET /v1/status` on `/run/whombat-backup/api.sock` (runtime and manager uids) or `/persist/backup/status.json`
(0644). Schema: contracts `local.BackupServiceStatus` (`whombat.backup-status/1`), validated before every write.

```json
{ "kind": "whombat.backup-status/1", "state": "protected", "protected": true,
  "destination": {"configured": true, "kind": "rest", "display": "https://backup.example:8000/appliance/", "appendOnly": "verified", "repositoryId": "…"},
  "lastSuccess": {"id": "ck-…", "at": "…", "ageSeconds": 5, "snapshotId": "…", "method": "snapshot", "quiesceHeldMs": 7, "durationMs": 2174, "bytesAdded": 17442, "totalBytes": 90113, "files": 42, "schemaVersion": 29,
                  "incomplete": {"servers": true, "reason": "The servers’ list wasn’t saved: the servers service hadn’t started yet. Everything else was backed up."}},
  "lastFailure": null, "lastAttemptOk": true, "failedAttempts": 0,
  "coverage": [{"id": "database", "title": "Database", "covered": true}, {"id": "provider-sessions", "title": "Provider session state", "covered": true, "relogin": true}, …],
  "recoverability": {"lastDrill": {"at": "…", "ok": true, "checkpointId": "ck-…", "rtoSeconds": 4, "backupAgeSeconds": 4, "skipped": ["audit-chain"]}},
  "kitGeneration": 1, "running": null,
  "clearing": {"by": "box", "at": "…", "ok": true, "bytes": 5123456789, "overLimit": false}, "updatedAt": "…" }
```

States: `unprotected` (no destination; **never** shown as "backups enabled"), `pending`, `protected`, `stale`
(last success older than the policy's 1.5 × interval + 2 h, 36 h before a policy is set), `failing` (two failed tries
in a row, or one while the backups are late, or the backup disk isn't attached; the previous success is still shown;
BK-65). `failedAttempts` counts failed tries since the last success. `lastSuccess.incomplete` is set when the newest
backup was made with a gap (BK-64): its `reason` says what and why in plain words only (BK-77), the technical cause is
in the manifest's `incomplete.servers` and the journal; `clearing` says who clears old backups and how the box's last clearing went
(BK-62, BK-63). `destination.kind` is `rest`, `s3`, `sftp`, `disk` or `local`; `lastFailure.reason` is one of BK-21's
sentences followed by the technical cause, on one line in any script (curly quotes kept, at most 500 characters).

## Checks, lists and the check before a migration (BK-67…BK-70)

- **A check** (drill) reads the repository through a cache made for it in its own directory (the index and trees once,
  `restic check --with-cache`), never the box's own cache, and takes manifests the box read before from
  `<stateDir>/manifests/`, verified again with the trusted key. Levels: `restore.CheckStructure` (before an app
  restore: its `restic restore --verify` proves the chosen checkpoint), `restore.CheckWeekly` (5%, the weekly check),
  `restore.CheckAll`.
- **The list** (`GET /v1/checkpoints`) costs one `restic snapshots` once each manifest was read: manifests are kept with
  their signatures, and a snapshot whose manifest doesn't verify is remembered (`manifests/unauthentic.json`) until
  the trusted keys or the adopted key's bound change. Each entry says what the backup holds (`covered`: the ids of
  the coverage classes its manifest covers, `servers` only when their archive is in it).
- **A check of an earlier Whombat's backup** (`POST /v1/drills {own: false}`) uses the key that signed it and trusts
  that key only up to the backup brought back from it (`keys/adopted-until.json`, and for the Whombats before it
  `keys/adopted-earlier.json`), as the list, the restore and peeks do.
- **The manifest cache** (`<stateDir>/manifests/<sha256>.json`) records the key that verified each manifest; an entry
  counts only while that key is still trusted (BK-78), so after a new adopt nothing verified with the previous
  adopt's key is listed.
- **Before a migration** the manager's checkpoint is read back with the box's cache (`check --with-cache`), and the
  database dump is streamed back whole from the destination and hashed.

## Opening a backup for reading (BK-72…BK-74)

The runtime gets back one thing from a backup (Whombat restore-one) by opening it for reading:

```
POST   /v1/peeks {checkpointId, own?}  → 202 {id}       one at a time: 409 busy (also while a backup runs)
                                                        507 no_space {needBytes, freeBytes, message}; 404 not_found
GET    /v1/peeks/{id}                  → {id, checkpointId, state: opening|ready|failed|closed, database, root,
                                          expiresAt, error}
DELETE /v1/peeks/{id}                  → closed (409 busy while the database still has a session; it ends itself)
```

`own`: `true` = a backup of this Whombat, `false` = of the earlier Whombat it was brought back from, absent = either.
While `opening`, the backup holds the run lock (backups and checks wait). `database` and `root` are set while `ready`.

**The database** `whombat_peek_<12 hex>` is on the box's PostgreSQL (`/run/postgresql`): connect as the runtime's own
role (`whombat`, peer) with `dbname` set to it. It holds every schema of the checkpoint as `pg_restore --no-owner
--no-acl` made it; the runtime's role may only `SELECT` (and `USAGE` on the schemas); sessions are read-only by
default, and one idle 5 minutes is ended: connect, read, disconnect, and give the client an error handler.

**The root** `/persist/backup/peek/<id>/root` (group `whombat-peek`, which the server is in; directories 0750, files
0640 or 0750, nothing writable by the group) holds the checkpoint's runtime sources under their source names:

| Path in the root | What it is | Live path |
|---|---|---|
| `home/` | WHOMBAT_HOME: `files/sha256/aa/bb/<sha256>` (attachments), `skills/<sha256>/…`, the rest | `/persist/whombat/home` |
| `workspaces/` | the workspaces and their repositories | `/persist/whombat/workspaces` |
| `hermes/` | WHOMBAT_HERMES_ROOT: `memories/`, `state.db` (+ `-wal`), `sessions/`, `skills/`, `profiles/<name>/` | `/persist/whombat/hermes` |
| `agent/` | WHOMBAT_AGENT_HOME, the agent's home | `/persist/whombat/agent/home` |

Only the sources the checkpoint has are there (one from before BK-36 has no `hermes/` or `agent/`); `credentials`,
`secrets` and the servers never are. Names left out of every backup (the transient names, caches) aren't either.
Symlinks are kept as the backup had them: never follow one. FIFOs, sockets and devices are left out.

A peek closes itself 2 hours after it is ready. A sweep at the API's start, with every 15-minute timer run and at boot
(`whombat-backup-peek-sweep.service`) closes one of an earlier boot, past its time or whose opener died, and removes
anything a peek left behind.

## Operations

```sh
whombat-backup status                       # human summary
whombat-backup run -reason manual           # exit 0 ok, 2 unprotected, 3 busy, 1 failed (stage + reason)
whombat-backup snapshots                    # authentic checkpoints, chain gaps, unauthentic snapshots
whombat-backup drill -check-data 5%         # restore.md
whombat-backup coverage                     # the table above
whombat-backup ssh-public-key               # the box's SFTP key (made on first use)
whombat-backup disk-scan                    # the disks and whether each could become the backup disk
whombat-backup peek-sweep                   # close a backup opened for reading that should be closed
```

Run them as **root** at the console (`-config $(systemctl cat whombat-backup | grep -o '/nix/store/[^ ]*whombat-backup.json' | head -1)`).
The destination's secrets are sealed in the root-only `/persist/backup-root` (BK-23, BK-26): a root run unseals
them into a private directory on `/run` (removed at exit) and then runs the command **as the backup user**, with
the secrets and any file you named (`-kit`, `-password-file`, …) handed over; only `quarantine
prepare|apply|release|undo`, the app's `restore`, `restore-end` and `restore-recover` (restore.md, BK-40…BK-44) and
the disk helpers stay root, and they never follow anything in `/persist/backup` (BK-26). `run` and `serve` are the services' (`systemctl start whombat-backup.service`). Run directly as the backup
user (`runuser -u whombat-backup --`), the CLI only sees a secret written since the last seal.

## NixOS integration

`nix/modules/backup.nix` (NixOS module: users, tmpfiles, snapd socket, API socket, timers, PostgreSQL
role and the root peer map, systemd-creds sealing of every destination secret, the backup group's egress, the
backup disk's mount and its prepare/init units, quarantine condition on the runner, the peek group and its boot sweep)
and `nix/profiles/recovery.nix` (recovery UKI: `whombat-recovery`, `whombat-export`). **Layout:** `/persist` is btrfs
with `whombat/home`, `whombat/workspaces`, `whombat/credentials`, `whombat/hermes`, `whombat/agent/home`, `secrets`
and `hosts-backup` as subvolumes and `/persist/backup` on the same filesystem (driver `btrfs`, NX-07, NX-431); the
`copy` driver remains for other layouts.

## Verification

2026-11-04 (`bv2/appliance-backup`, BK-60…BK-74): `go test -count=1 ./backup/... ./recovery/...` and `go vet` against
restic 0.18.0, rest-server 0.14.0 and the shared PostgreSQL 17 (throwaway databases and a throwaway role for the
peek's runtime role). New: the schedule (a slot summer time skips, clocks put back, the weekly check in the person's
morning), the failing rule, the check queue waiting for the run lock, sequence numbers after a failed read-back
(`TestSequenceSurvivesAFailedReadBack`), gaps for a missing attachment and a failed or broken servers export
(`TestMissingAttachmentLeavesAGap`, `TestServersBackupFailureLeavesAGap`), `hub.tar`
(`TestServersAsAnUncompressedArchive`), the box clearing a REST server that isn't append-only and the limit's ladder
(`TestBoxClearsARESTServerThatIsNotAppendOnly`, `internal/clearing`), the restic calls of a check and two lists
(`TestChecksAndListsReuseWhatWasRead`: no manifest downloaded again, one check fills the run's cache, an unauthentic
snapshot read once), the restic flags, and peeks (`TestPeekOpensABackupForReading`, `TestPeekRoomExpiryAndBoot`).

2026-09-28 (`ru-backup`, BK-18…BK-25): unit tests (no secret in restic's argv or errors, the hardened ssh
command, secret resolution, per-kind validation and reasons, the disk helper's eligibility, the kit per kind,
moves into subvolumes across filesystems, the API) and integration tests against a real OpenSSH `sshd`
(`TestSFTPDestination`), MinIO (`TestS3Destination`), a disk directory (`TestDiskDestination`) and a fresh box
(`TestRestoreOntoFreshBox`); `vm-tests/backup-destinations.nix` on real appliance VMs. Tools:
`backup/scripts/test-tools.sh` (adds OpenSSH 10.5 and MinIO from nixpkgs; MinIO is marked insecure there and runs
only on loopback in the tests).

2026-09-25 (the original branch):

Tools: Go 1.26.8, restic 0.18.0, rest-server 0.14.0 (`go install …@v0.14.0`), PostgreSQL 17.11 client
(nixpkgs `postgresql_17`) against the shared `postgres:17` server (throwaway `whombat_bk_test_*` databases), git
2.47.3. `backup/scripts/test-tools.sh` fetches them.

```sh
go test ./backup/... ./recovery/... -count=1      # from the repository root: unit + integration (needs the tools above)
backup/scripts/e2e.sh                           # the real binaries end to end
RUNTIME_DIR=~/Code/Whombat/.claude/worktrees/managed-runtime backup/scripts/real-runtime.sh
WB_SCALE_MB=1024 go test ./backup/itest -run TestScaleMeasurement -v   # measurement only
```
