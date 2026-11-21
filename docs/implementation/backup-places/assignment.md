# Backup places — build brief (2026-11-03)

Decisions: `docs/decisions/backup-places.md` BPL-01…BPL-12. **Read them first**, then §1, §2 and your stream's part of
§3. §2's shapes are what every stream builds against; don't change them without telling the lead.

| Stream | Repo | Worktree | Branch (from) | Ids |
|---|---|---|---|---|
| H hosts | the hosts service | `~/Code/.wt/hosts-bp` | `bp` (main) | HS-203…HS-229 |
| S server | Whombat | `~/Code/.wt/whombat-bp-server` | `bp-server` (`bp`) | BPL-S01…BPL-S39 |
| N NAS drivers | Whombat | `~/Code/.wt/whombat-bp-nas` | `bp-nas` (`bp`) | BPL-N01…BPL-N29 |
| W web + phone | Whombat | `~/Code/.wt/whombat-bp-app` | `bp-app` (`bp`) | AP-6700…AP-6729 |

The Whombat integration branch `bp` (`~/Code/.wt/whombat-bp`) is the lead's: the contracts of §2.2 are on it before
S, N and W start. S, N and W work on their own branches; the lead merges them into `bp`. H commits to `bp` in its repo.

## 1. Rules for every stream

- Work only in your worktree on your branch; small commits (`hub: …`, `agent: …`, `server: …`, `core: …`, `web: …`,
  `mobile: …`, `client: …`), every message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  Never push, never merge into `main` or another stream's branch, never touch the main checkouts (`~/Code/Whombat`,
  `~/Code/whombat-hosts`, `~/Code/whombat-appliance`): other sessions work there. Never `git stash` (it is shared by
  every worktree); compare with old code through `git show <rev>:<path>`.
- Search only inside your worktree and the paths named here; never `find`/`grep` over `/` or `$HOME`.
- Node: `export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH; export TMPDIR=/home/me/.cache/wb-tmp`.
  Postgres for server tests is the shared one on :55432 (throwaway databases only; the test harness makes them).
- **DEV fast** (John's rule): at the end `pnpm format` then `TMPDIR=~/.cache/wb-tmp pnpm check` (H: `go vet ./... &&
  go test ./...`), plus the server test files you touched (single files while you work). Only one `pnpm check` on The
  Titan at a time: if another is running (`pgrep -af "pnpm check"`), wait for it.
- Read `CLAUDE.md` (Whombat) or the repo's own README/docs (hosts) for the house rules: plain words in everything a
  person sees, contracts first, all writes through the commit pipeline, comments say why, no decision codes in code.
- Record new decisions in your id range: S and N in `docs/decisions/backup-places.md` (a table “Server details” /
  “NAS drivers” at its end), W in `docs/app/decisions/backup-places.md`, H in `hosts/docs/decisions/hosts.md`.
- **John's real servers** (Home's BlackBox, the-titan, pve-01/02) are not for tests. Use the fake fleet, Docker on The
  Titan through `agent-resource` (read `/home/me/Code/dashboard/docs/agent-resources.md` first), and fakes.
- Finish with a short report: what you built, commit range, tests run, what is unverified.

## 2. Shapes

### 2.1 Hosts hub API (the hosts service; Whombat's server calls it through `apps/server/src/hosts/client.ts`)

All routes need the server's `manage` switch on both sides (agent and hub), like the Unraid routes; refused on the
server this Whombat runs in (`self_guest`-style refusal, code `self`). JSON is snake_case.

**Server detail** (`GET /api/v1/servers/{id}` and the list, from the agent's report) gains:

```json
"backup_place": {
  "supported": true,
  "reason": "",
  "platform": "unraid",
  "root": "/mnt/user/whombat-backups",
  "free_bytes": 1900000000000,
  "total_bytes": 2000000000000,
  "addresses": ["10.100.0.40", "10.100.1.23"],
  "nfs": true,
  "clients": [
    {
      "client": "whombat-home-4hxx",
      "port": 8747,
      "running": true,
      "image": "restic/rest-server@sha256:…",
      "used_bytes": 123456789,
      "cleanup": { "set": true, "running": true, "keep_within_days": 90,
                   "last_run_at": "2026-11-03T13:00:00Z", "last_ok": true, "last_error": "" }
    }
  ]
}
```

`supported` false with `reason` one of `no_docker`, `docker_down`, `array_stopped` (Unraid), `self`; absent
(`null`) from an agent that doesn't report it yet. `addresses`: the server's IPv4 LAN addresses (private ranges), the
interface with the default route first. `nfs`: the server can export a folder over NFS (Unraid with NFS on).

**Routes** (answers are synchronous; the hub waits for the agent up to 5 minutes, since pulling the images can take a
minute):

- `POST /api/v1/servers/{id}/backup-place/ensure` `{"client": "whombat-home-4hxx", "rest_password": "…", "port": 0}` →
  200 `{"client", "port", "addresses": [...], "path": "/mnt/user/whombat-backups/whombat-home-4hxx", "created": true}`.
  Idempotent: makes the root (Unraid share via emcmd: no SMB/NFS export) if missing, writes the client's htpasswd
  (bcrypt, replacing the line), pulls the pinned image, creates or recreates `whombat-backup-<client>` (restart
  unless-stopped, labels `whombat.service=backup-place` and `whombat.client=<client>`, Unraid template + autostart on
  Unraid), keeps the port it had (`port` 0 = keep or the first free from 8747), waits until it answers HTTP. `client`
  matches `^[a-z0-9][a-z0-9-]{2,62}$`; `rest_password` 24…200 printable ASCII. Errors: 422 `invalid`, 409
  `unsupported` (with the reason), 502 `agent_error` with one plain sentence.
- `PUT /api/v1/servers/{id}/backup-place/{client}/cleanup` `{"repository_password": "…", "keep_within_days": 90}` →
  200 `{"set": true}`. Writes `<root>/.whombat/<client>.pass` (0600 root) and creates or recreates
  `whombat-backup-<client>-cleanup` (restic image pinned, weekly `forget --keep-within <n>d --prune --retry-lock 2h`
  on `/data/<client>`, the first run 7 days after it starts, status in `<root>/.whombat/<client>.cleanup.json`).
- `DELETE /api/v1/servers/{id}/backup-place/{client}` `{"delete_data": false}` → 200 `{"removed": true}`. Removes both
  containers, templates and the htpasswd/pass files; `delete_data: true` also removes `<root>/<client>` and needs the
  admin role, a recent sign-in and `confirm: true` (like stopping the array).
- `POST /api/v1/servers/{id}/backup-place/nfs` `{"name": "whombat-pve-01", "clients": ["10.100.1.5"]}` → 200
  `{"export": "/mnt/user/whombat-pve-01", "addresses": [...]}`. Unraid only (409 `unsupported` elsewhere): a share
  `name`, not exported over SMB, exported over NFS to exactly those addresses (rw, no_root_squash as Proxmox needs).
  Idempotent; adds clients rather than replacing.
- `POST /api/v1/servers/{id}/proxmox/storages` `{"storage": "blackbox-backup", "type": "nfs", "server": "10.100.0.40",
  "export": "/mnt/user/whombat-pve-01", "content": ["backup"]}` → 200 `{"storage": "blackbox-backup"}`. Proxmox VE
  only. Idempotent when the same storage exists with the same server and export; 409 when the name is taken otherwise.

The hub's audit log gets every call (without passwords).

### 2.2 Whombat contracts (on `bp` before S, N and W start)

`@whombat/core` `domain/backup-places.ts` (pure):

```ts
export type BackupPlaceKind = 'unraid' | 'linux' | 'truenas' | 'synology' | 'qnap';
export type BackupPlaceState = 'in_use' | 'ready' | 'connect_first' | 'manage_first' | 'unsupported';
export interface BackupPlaceKept {           // what the place keeps for this Whombat
  usedBytes: number | null; freeBytes: number | null;
  cleanup: { on: boolean; keepDays: number; lastAt: string | null; ok: boolean | null };
  byHand: boolean;
}
export interface BackupPlace {
  id: string;            // 'server:<serverId>' | 'connection:<connectionId>' | 'found:<host>'
  kind: BackupPlaceKind;
  name: string;          // 'BlackBox'
  address: string | null;
  state: BackupPlaceState;
  reason: string | null; // one plain sentence for connect_first / manage_first / unsupported
  byHand: boolean;       // “Set it up by hand” offered (BPL-09)
  kept: BackupPlaceKept | null;
}
```

plus `backupPlaceId`, `parseBackupPlaceId`, `placeKindOf`, `bestBackupPlace(places)` (BPL-07's order) and the words
(`BACKUP_PLACE_TEXT`). Session ops (`@whombat/protocol` `session/backup.ts`, owner only, `app` channel, feature
`backup.places`):

- `backup.places` `{}` → `{ places: BackupPlace[], currentPlaceId: string | null }` (query).
- `backup.usePlace` `{ placeId, move?: boolean }` → `{ placeId, destination: string, appendOnly, firstBackup: boolean }`
  (mutating, no automatic retry; `move` needed while a destination other than the box's own disk is set).
- `backup.placeByHand` `{ placeId }` → `{ compose: string, steps: string[], expiresAt }` (query, secret: the compose
  holds the bcrypt line; the password waits on the server for 24 hours).
- `backup.placeCheck` `{ placeId }` → same as `usePlace` (sets a place made by hand).
- `backup.forgetPlace` `{ placeId, deleteData?: boolean }` → `{ ok: true }` (only a place not in use).

MCP: `WhombatBackupInput.set` gains `'place'` with `place: string` (a place id); the output's `ok` read gains
`places: { id, name, state }[]`.

## 3. Streams

### H — hosts (Go), `~/Code/.wt/hosts-bp`

Build §2.1 in the agent and the hub: the report's `backup_place` (cheap: read Docker's containers by label, the
`.cleanup.json` files, `statfs` of the root; no image pulls), the five routes, the agent's operations (Docker Engine
API over the socket as `broker/docker.go` does; Unraid's `emcmd` for shares, read `/usr/local/emhttp/plugins/dynamix`
pages' forms on a real Unraid only through docs or the fake — not on BlackBox), the Unraid templates
(`/boot/config/plugins/dockerMan/templates-user/my-<name>.xml`) and autostart (`/var/lib/docker/unraid-autostart`, see
`unraid_manage.go` `setAutostart`), the Proxmox storage route (the agent's PVE API client, `pve_*.go`). Images pinned by
digest (`restic/rest-server:0.14.0`, the newest `restic/restic` 0.18.x; resolve the digests from Docker Hub when you
build and write them down). The fake fleet gets an Unraid server with a backup place. Tests: unit tests per operation
with a fake Docker socket and a temp root; one real test against Docker on The Titan inside `agent-resource run`
(skipped without `HOSTS_REAL_DOCKER=1`) that runs ensure → a `restic init` + `backup` from a `restic/restic` container
over REST → a delete is refused (403) → cleanup set → remove. Docs: `docs/REST-API.md`, `docs/MANAGE.md`, decisions
HS-203…. The hub's `/install.sh` and agent update path stay as they are (agents update themselves from the box).

### S — server, `~/Code/.wt/whombat-bp-server`

`apps/server/src/backup-places/`: the places list (servers from the hosts service with `backup_place`, NAS connections
of the three catalog ids, the scan's finds; BPL-04's states), the `PlaceDriver` interface
(`ensure(client, restPassword) → {address, port}`, `cleanup(client, repoPassword, keepDays)`, `forget(client,
deleteData)`, `kept(client)`), the agent driver (hosts routes), a stub registry N fills for the NAS kinds, the
`usePlace` flow (BPL-05: client name from the Whombat's name and appliance id, password, ensure, destination via
`setBackupDestination`, recovery material → cleanup, record, `backup.runNow`), a migration for the place record
(`backup_places`: place id, client, address, port, by hand, pending password sealed with the server's custody for
BPL-09, timestamps), the session ops of §2.2, `whombat_backup`'s `place` (BPL-06), the Inbox proposal (BPL-07,
`home/box-backup.ts`), the address follow job (BPL-08), the watch checks (BPL-11, `startsOn: false`), the care plan's
NAS storage (BPL-12: core `careSteps`/`backupStorageOf` and the hosts tools `backup_place_nfs` and
`proxmox_storage_add` the step names), `ARCHITECTURE.md`'s backups paragraph. Integration tests against the fake hosts
hub and a fake backup service (see `managed/backup.int.test.ts`).

### N — NAS drivers, `~/Code/.wt/whombat-bp-nas` (starts after the research and S's driver interface)

TrueNAS (JSON-RPC socket: dataset, `app.create`/`app.update` custom compose, jobs), Synology (Container Manager
`SYNO.Docker.Project`, File Station folder), QNAP (Container Station application, File Station folder) through the
connection's signed-in session (`apps/server/src/connections/`), the compose text both they and BPL-09 use, the by-hand
flow (`backup.placeByHand`, `backup.placeCheck`), TrueNAS's NFS share for BPL-12. The API research is in
`~/.cache/wb-tmp/nas-backup/nas-apis.md`. Unit tests against recorded answers; say plainly which calls no real device
has seen.

### W — web + phone, `~/Code/.wt/whombat-bp-app`

Web Settings → This Whombat → Backups (`features/settings/BackupDestination.tsx` and its section): “On your network”
with each place (mark, name, state line, Back up here / Set it up / Connect it first / Turn on Manage first / Set it
up by hand), the confirm for a move, the by-hand sheet (compose to copy, steps, Check it), the current place's line
(BPL-10). The server page (Unraid and Linux) and the NAS connection page: “Backups kept here”. The phone: the same in
`WhombatBackupsScreen` and the server/connection screens. `@whombat/client` wrappers for the ops. Fixture-mode data so
`pnpm visual` shows the section; check both themes at 1440×900 and the phone sizes. Copy is short and plain.
