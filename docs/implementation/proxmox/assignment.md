# Full Proxmox support — build brief (2026-10-17)

Decisions: `docs/decisions/proxmox.md` (PX-01…PX-11). Read it first, then your stream's section. The Rackoon UI and
spec you port from: `~/Code/whombat-hosts/web/src` (Rackoon's React UI, unchanged since `beaea67`, identical to the
Rackoon repo on The Falcon) and `~/Code/whombat-hosts/docs/MANAGE.md` §4, `docs/REST-API.md` “Manage”.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`web: …`, `server: …`, `agent: …`), every
  message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into `main`,
  never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, …): other sessions use them. The lead merges.
- **DEV fast** (John's rule): one quick check per repo at the end — `TMPDIR=~/.cache/wb-tmp pnpm check` (TS repos),
  `go vet ./... && go test ./...` (Go; `-race` once at the very end), `pnpm test:server` once (Whombat server). No VM
  tests, no repeated full suites, no CI waits. Use your own ports and throwaway databases; never stop or reset shared
  containers (`docker compose` is shared — never `down -v`).
- **Copy**: plain, short English a non-developer understands, curly quotes (’ “ ”), `·`, `−` for minus, `…`. Whombat's
  own chat words follow CLAUDE.md “Agents and automations talk like people”.
- **Tokens only** (`@whombat/tokens` CSS variables); match the surrounding code's style and comment density.
- **Decisions you make** go in your repo's decisions file (Whombat `docs/decisions/proxmox-<stream>.md`, whombat-app
  `docs/decisions/proxmox-<stream>.md`, `hosts/docs/decisions/hosts.md` as HS-23+, contracts
  `docs/decisions/contracts.md` as CT-353+). IDs: app `AP-1385…`, take a block of 30 per stream as listed below.
- **Shared files** (several streams touch them; keep your edits small and appended so the lead's merge is easy):
  `packages/client/src/hosts/{index.ts,react.ts,fixtures.ts}`, `apps/web/src/features/things/Things.module.css`,
  `parts.tsx`. New fixture handlers go in **your own file** `packages/client/src/hosts/fixtures-<stream>.ts` with one
  call line added in `fixtures.ts`; new CSS classes are prefixed with your stream (`.wa…`); new shared React pieces go
  in new files, not into `parts.tsx`.
- **Visual check** for UI work: the app's fake world with servers (`VITE_WHOMBAT_TRANSPORT=session VITE_WHOMBAT_FAKE=1
  VITE_FIXTURE_HOSTS=1` vite in `apps/web`, signed in with `e2e-managed/support.ts` `signIn` + `claimAndSaveKit`),
  1440×900, both themes; compare the layout with Rackoon's screens (`~/Code/whombat-hosts/docs/handoff/design/screenshots`,
  or run Rackoon's own fixture UI from `~/Code/whombat-hosts/web`) and the one-Whombat mock
  (`whombat-app/docs/design-handoff/one-whombat/server.png`). Fix differences before finishing.
- **Report** at the end: what you built (by PX decision), files outside your ownership you touched, contract gaps,
  what the lead must do at merge, how you verified it.

## 2. Shared shapes (all streams build to these)

### 2.1 Backup jobs (PX-03) — hub wire format (snake_case; Whombat's contracts are the camelCase mirror)

```jsonc
// GET /api/v1/servers/{id}/backup-jobs  → {"items": [BackupJob]}     (operator)
// POST /api/v1/servers/{id}/backup-jobs  {BackupJobInput}  → 200 {ok, id, audit_id}            (admin)
// PUT /api/v1/servers/{id}/backup-jobs/{job}  {BackupJobInput (partial), digest?} → 200 {ok, changes, audit_id} (admin)
// DELETE /api/v1/servers/{id}/backup-jobs/{job}?confirm=1  → 200 {ok, audit_id}               (admin)
// POST /api/v1/servers/{id}/backup-jobs/{job}/run → 202 {ok, task: {id}, audit_id}              (operator)
BackupJob = {
  "id": "backup-dc316015-ac2c", "enabled": true, "schedule": "04:00", "storage": "PBS-BlackBox",
  "node": "pve-01" | null,                 // restricted to one node; null = every node
  "selection": "all" | "guests" | "pool",
  "guests": ["pve:101", "pve:118"],        // selection "guests": hub guest ids
  "exclude": ["pve:100"],                  // selection "all": hub guest ids left out
  "pool": "prod" | null,
  "mode": "snapshot" | "suspend" | "stop", "compress": "zstd" | "lzo" | "gzip" | "0" | null,
  "keep": {"last": 7, "hourly": 0, "daily": 14, "weekly": 8, "monthly": 6, "yearly": 0} | null,  // prune-backups; null = the storage's own
  "notes_template": "{{guestname}}" | null, "comment": "…" | null,
  "next_run": "2026-10-18T02:00:00Z" | null,
  "digest": "…"                            // sha256 of the job as read; PUT refuses a stale one (digest_mismatch)
}
```

Whombat contracts (0.81.0): `HostBackupJob` (camelCase of the above; `notesTemplate`, `nextRun`), read op
`backupjob.list` → `{op: 'backupjob.list', items: HostBackupJob[]}`, manage ops `backupjob.create`,
`backupjob.update`, `backupjob.delete`, `backupjob.run` with `params` `{jobId?, enabled?, schedule?, storage?, node?,
selection?, guests?, exclude?, pool?, mode?, compress?, keep?, notesTemplate?, comment?}`; `backupjob.delete` joins
`HOST_MANAGE_DESTRUCTIVE_OPS`. Whombat's server maps them to the routes above (`MANAGE_ROUTES`).

### 2.2 Servers tools (PX-02) — names and inputs (contracts own the JSON schemas; server implements)

Existing, fixed: `guest_power` gains `pause` and `resume`; `guest_config_set` gains `revert` (keys) and `confirm`
(boolean, for deleting an unused disk); `guest_migrate` takes `storage` (optional) instead of `online`; `server_diagnose`
takes `args` (object of strings); `server_metrics`' series hint names `cpu_pct, mem_pct, temp_max_c, net_rx_mbps,
net_tx_mbps`.

New (read): `guest_snapshots {server, guest}`; `server_choices {server}` (storages, bridges, ISO images, container
templates, templates, next id, CPU types, cluster nodes); `guest_backups {server, guest?}`; `backup_jobs {server}`;
`storage_contents {server, storage?, content?: iso|vztmpl|import, appliances?: boolean}`; `server_tasks {server,
guest?, task?}` (a list, or one task with its log); `guest_firewall {server, guest}`.

New (write): `guest_create {server, kind: vm|container, name, id?, cores?, memory_mb?, disk_gb?, storage?, bridge?,
iso?, template?, password?, ssh_keys?, start?, settings?}`; `guest_clone {server, guest, name, id?, full?, storage?}`;
`guest_template {server, guest}`; `guest_delete {server, guest, purge?}`; `guest_disk {server, guest, action:
resize|move, disk, size?, storage?, delete_source?}`; `guest_backup {server, guest?, action: create|restore|protect|
unprotect|notes|delete, backup?, storage?, mode?, notes?, as_new?, id?}`; `backup_job_set {server, action: create|update|
pause|resume|delete|run|add_guest|remove_guest, job?, guest?, schedule?, storage?, mode?, keep?, selection?, comment?}`;
`storage_content {server, action: download|get_template|delete, storage, content?, url?, filename?, checksum?,
checksum_algorithm?, template?, volume?}`; `task_stop {server, task}`; `guest_firewall_set {server, guest, action:
enable|disable|options|add_rule|update_rule|delete_rule|move_rule, rule?, pos?, to?, options?}`; `guest_ha {server,
guest, action: set|remove, state?, max_restart?, max_relocate?}`; `guest_replication {server, guest, action:
add|delete, target?, schedule?, job?}`; `server_power {server, action: reboot|shutdown}`.

**Always ask** (sensitive): `guest_delete`, `guest_template`, `server_power` (whole tools); `guest_power` stop,
shutdown, reboot, pause; `guest_snapshot` restore, delete; `guest_disk` move; `guest_backup` restore, delete;
`storage_content` delete; `backup_job_set` delete; `guest_migrate`, `server_command` (as today).

### 2.3 Agent command (PX-04)

`whombat-agent allow <switch>…` · `whombat-agent deny <switch>…` · `whombat-agent policy`. Switches: `console`,
`power`, `host_shell`, `host_power`, `manage`, `diagnose`, `all`. Run as root; edits `[remote_control]` in
`/etc/whombat-agent/agent.toml` (or the Unraid path) keeping comments and order, then reloads the running agent
(`systemctl reload whombat-agent`, else SIGHUP to the pid in `/run/whombat-agent.pid`), and prints one sentence
(“pve-02 now allows guest editing and power.”). The web shows `sudo whombat-agent allow <key>` (no `sudo` on Unraid,
`install` = `unraid`) beside a switch the server blocks, with a copy button; a server whose agent is older says to
run its install command again first (the version that has `allow` is the one after this build; compare
`agent.version` with the hub's build when known, else show both lines).

## 3. Streams

| Stream | Repo · worktree · branch | Owns | App IDs |
|---|---|---|---|
| **C** contracts | whombat-contracts · `~/Code/.wt/contracts-px` · `px` | `packages/core/src/domain/hosts.ts`, `connections-catalog.ts` (Servers tools), tests | CT-353… |
| **H** hosts (Go) | the hosts service · `~/Code/.wt/hosts-px` · `px` | everything in the repo | HS-23… |
| **SV** server | Whombat · `~/Code/.wt/whombat-px-server` · `px-server` | `apps/server/src/hosts/**` | — |
| **WA** guest editing | whombat-app · `~/Code/.wt/app-px-wa` · `px-wa` | `guest/HardwareTab.tsx`, `guest/OptionsTab.tsx`, `guest/EditDialog.tsx`, `guest/CloudInitTab.tsx`, `packages/client/src/hosts/config.ts` (+ new `props.ts`) | AP-1385…1414 |
| **WB** guest lifecycle | whombat-app · `~/Code/.wt/app-px-wb` · `px-wb` | `guest/GuestPage.tsx`, `guest/GuestSummary.tsx`, `guest/{Snapshots,Backups,Firewall,Tasks,Replication}Tab.tsx`, `manage/GuestDialogs.tsx`, `manage/useManage.ts`, task toasts and outcome, `tabs/BackupsTab.tsx` (jobs), `guestTabs` in `model.ts` | AP-1415…1444 |
| **WC** host and fleet | whombat-app · `~/Code/.wt/app-px-wc` · `px-wc` | `manage/CreateGuestDialog.tsx`, `packages/client/src/hosts/manage.ts`, `tabs/{GuestsTab,StorageTab,SummaryTab,SystemTab}.tsx`, `manage/StorageContentDialog.tsx`, `ServerPage.tsx`, `ServersPage.tsx`, the fleet Guests page (new), bulk, templates, hints with fixes, the agent command | AP-1445…1474 |
| **WD** consoles | whombat-app · `~/Code/.wt/app-px-wd` · `px-wd` | `console/**` | AP-1475…1484 |
| **MA** Android | whombat-app · `~/Code/.wt/app-px-ma` · `px-ma` | `apps/mobile/**`, new shared helpers in new files under `packages/client/src/hosts/` | AP-1485…1514 |

The lead merges C, vendors contracts 0.81.0 into the `px` branches of Whombat and whombat-app and tells the streams
to `git merge px`; until then build what doesn't need the new types.
