# Recovery and export without Whombat

Decisions: BK-14 (tool), BK-15 (kit), BK-16 (billing boundary). Code: `recovery/` (`whombat-recovery`),
`nix/profiles/recovery.nix`. Tested: `TestExportFromKitAndLocalRepositoryCopy`, `TestExportFromDisk`,
`backup/scripts/e2e.sh`.

`whombat-recovery` is a restricted command-line tool, not a hosted or local UI. It needs **no Whombat cloud
and no appliance**. The customer's recovery kit authorizes it: the kit's backup section holds the repository
location, the append-only read credential, the repository password and the manifest key. It lists, verifies
and exports, and never writes to a backup repository.

```sh
whombat-recovery list   -kit kit.json                        # authentic checkpoints; flags unauthentic ones and gaps
whombat-recovery verify -kit kit.json -check-data 10%        # every drill check that needs no database server
whombat-recovery export -kit kit.json -out /mnt/usb/whombat  # newest checkpoint → open formats
whombat-recovery export -kit kit.json -repo-dir /mnt/usb/restic-copy -snapshot ck-… -out /mnt/usb/whombat
whombat-recovery export -kit kit.json -out … -include-secrets   # also provider logins, the master key, the servers
whombat-recovery export-disk -persist /persist -out /mnt/usb/whombat -pg-user nobody  # appliance disk (-pg-user when root)
```

- `-repo-dir` opens a copy of the repository on a local disk: the storage provider's export, a USB disk, or an
  rsync of the rest-server directory. No network is needed.
- The export verifies first (`restic check`, authentic manifest, `restore --verify`, dump hash, attachment
  hashes, git fsck and the recorded unpushed/uncommitted/untracked state). If any check fails it stops and
  writes `verification.json`.
- A wrong kit password opens nothing (`TestExportFromKitAndLocalRepositoryCopy`).

## Export layout (open formats)

```
README.txt                     checkpoint, verification, tables with row counts, repositories with unpushed/dirty counts
manifest.json, manifest.sig    the signed checkpoint manifest
verification.json              the full verification report
database/whombat.pgdump        PostgreSQL custom format (pg_restore -d <db> whombat.pgdump)
database/whombat.sql           the same as plain SQL (psql -f whombat.sql) — made without a server
files/home/                    attachments (files/sha256/aa/bb/<sha256>), other runtime files
files/hermes/                  the agent's Hermes home: what it remembers, sessions in state.db, its skills/; a
                               checkpoint before BK-36 has none
files/agent/                   the agent's home (its own files and projects; not its .cache); none before NX-466
workspaces/                    every working tree as it was, with .git (metadata relocated to work in place)
git-bundles/<path>.bundle      one bundle per repository: git clone x.bundle (all refs, unpushed commits included)
secrets/{credentials,secrets}  only with -include-secrets: provider homes, the master key (keep private)
secrets/hosts/hub.tar.gz       only with -include-secrets, where the box had the hosts service: its own backup (the
                               servers' database and the agents' CA key: whoever holds it can pose as the hub; BK-35)
```

## Export from the appliance's disk (`export-disk`)

When no backup is usable but the appliance's disk is. The recovery environment unlocks `/persist` with the
customer's **disk recovery key** (NX-12/NX-13), which authorizes this path. The tool copies
`/persist/postgres/17` to scratch space, starts a private PostgreSQL on the **copy** (the original is never
started or written), dumps it, and copies the file trees. It claims no database/file consistency beyond what the
disk had at power-off.

## In the signed recovery environment (NX-13)

The recovery UKI contains `whombat-recovery`, `restic`, `git` and PostgreSQL 17. It has **no shell and no login**
(MA-21a): the only interface is the menu on the first console.

1. Hold Space at power-on and choose *Whombat recovery*. The environment has no network until the operator
   enables it (menu 6, needs the recovery key).
2. Attach a disk formatted ext4, exFAT, FAT, btrfs or XFS.
3. Menu 1 *Export this appliance's data*: type the disk recovery key (not echoed; a wrong key touches nothing),
   pick the attached disk from the list (the appliance's own disk is never offered), choose whether to include
   provider logins and the master key. `/persist` is opened read-only with the key and exported with
   `export-disk` to `whombat-export-<time>/` on that disk (PostgreSQL runs as the unprivileged `whombat-export`
   user on a copy in a work directory on the same disk).
4. Menu 2 *Verify a backup*: recovery key, then the kit file from the attached disk (listed), verified with
   `whombat-recovery verify -check-data 10%` (the network must be enabled for a REST destination).

The key is checked against the data volume before anything is opened; every action is logged to the kernel log.

The same static binary runs on any Linux machine with `restic`, `git` and `pg_restore` on `PATH`, so a customer
can recover on their own hardware.

## Billing boundary

A suspended or cancelled subscription never wipes appliance data and never interrupts a running checkpoint,
drill or transaction. It never blocks this tool, the recovery environment, drills or the customer's own
destination. The backup service and the recovery tool have no dependency on Whombat's control plane at all.
Any future entitlement policy (for example, no new off-device checkpoints after a long suspension) is a separate,
documented decision, and may not touch existing backups, export or recovery (BK-16).
