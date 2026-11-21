# Brief B — backup destinations beyond the REST server (UP-F1, UP-F2)

Worktree `~/Code/.wt/whombat-appliance-ru-backup`, branch `ru-backup`. Ids BK-18…BK-29 (`docs/decisions/backup.md`,
3-column table). You own `backup/**`, `nix/modules/backup*.nix` (and the backup parts of other modules, tell the
orchestrator if you touch more), `docs/runbooks/{backup,restore,replacement}.md`. Ports 5850–5899.

Read `docs/decisions/backup.md` (BK-01…BK-17: restic CLI, destinations `rest:` qualified and append-only (BK-09),
`restic-local` for tests, kit and password custody BK-15, pre-migration checkpoint BK-17), `docs/runbooks/backup.md`,
the service API (`backup/internal/api/api.go`, `PUT /v1/destination`), destinations (`backup/internal/dest/dest.go`),
and contracts' `packages/protocol/src/session/backup.ts` in `~/Code/.wt/whombat-contracts-robust-updates` (agent C adds,
for 0.22.0 / CT-142: `s3AccessKeyId`, `s3SecretAccessKey`, `s3Region`, `sftpUser`, `sftpHostKey` on the destination
input; output `kind`, `hostKeyFingerprint`; op `backup.sshPublicKey`; kit fields for S3/SFTP; local disk = repository
`disk:`). Use those exact names; if the local service request differs, keep the service's API consistent with the
contract C publishes (read C's worktree as it lands; ask the orchestrator if unclear).

## Tasks

1. **S3-compatible destinations** (`s3:https://host/bucket/path`): credentials passed to restic through the
   environment from the service's sealed secrets (never on the command line, never in logs or status), region
   optional. Append-only is `not-enforced` (say so in the output and status); recommend bucket versioning/object lock
   in the runbook. Kit carries the credentials.
2. **SFTP/NAS** (`sftp:host:/path`, user separate): the box's own ed25519 key (generated on first `sshPublicKey`
   request, stored with the other backup secrets, sealed like the restic password), host key pinned (given, or trust on
   first use with the fingerprint returned for the owner to compare), restic via `-o sftp.command=…` with a hardened
   `ssh` invocation (no agent, no config files, `StrictHostKeyChecking=yes` against the pinned key, `BatchMode`). Kit
   carries user, private key and host key.
3. **Local disk** (`disk:`): a block device labelled `WHOMBAT-BACKUP` (ext4 or btrfs, made by the owner or by the
   service when empty with an explicit `allowInit`) mounted by the NixOS module at a fixed path under `/persist` only
   while backups run (or permanently — decide), restic local repository inside. Say in status when the disk is absent.
4. Status and errors: every destination kind reports clear owner-facing errors (wrong credentials, bucket missing, host
   key mismatch, disk absent) through the existing status document.
5. **Restore drill (UP-F2)** support for agent G's VM gate 7: make sure a checkpoint taken before a failed contract
   migration can be restored onto a fresh box with the documented commands (`restore.md`); fix what's missing.
6. Tests: unit tests per destination (fake restic / command construction, secret handling, no secrets in argv or
   logs), integration tests where the repo has a harness (`backup/itest`) — a real `restic` against a local SFTP server
   (e.g. an OpenSSH in a temp dir) and a local S3 (e.g. `minio`/`garage` from nixpkgs, on your ports) if feasible;
   otherwise say what was tested how. `go vet ./... && go test ./backup/... ./recovery/...` must pass.
7. Docs: BK entries, runbook sections per destination kind with the owner steps.

Security review will look at: secrets never in argv/env of other processes/logs/status/control, kit completeness, host
key pinning, what an attacker with the S3 key can do (delete backups — documented), file permissions.
