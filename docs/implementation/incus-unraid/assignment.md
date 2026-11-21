# Full Incus, unRAID and QEMU support — build brief (2026-10-17)

Decisions: `docs/decisions/incus-unraid.md` (IU-01…IU-12). Read it first, then §1, §2 and your stream's part of §3.
The Proxmox build is the pattern to copy everywhere: `docs/decisions/proxmox.md`, `docs/implementation/proxmox/assignment.md`,
`~/Code/whombat-hosts/docs/MANAGE.md` (§2.5 is Incus today), `docs/REST-API.md` “Manage”.

Real things to look at (read-only unless your stream says otherwise):
- **The Titan** (this machine, Incus 6.0.4): `incus list --all-projects`, `incus storage list`, `incus image list`,
  `incus profile list`, `incus network list`, `incus query /1.0/...`. Its agent is enrolled as `the-titan`
  (`/etc/whombat-agent/agent.toml`, read-only). **Never change, stop or delete an existing instance, image, profile,
  network, pool or volume on The Titan** — it hosts the DEV Whombat (`whombat-dev-box`), `whombat-prod-box`, the CI
  templates and `whombat-link` (IU-01). Writes only inside the throwaway project `whombat-test` (HI creates it with
  `incus project create whombat-test -c features.images=false -c features.profiles=true`, deletes it with everything
  in it at the end).
- **BlackBox** (unRAID 7.3.1): `ssh root@10.100.0.40` — **read-only**: `cat`/`ls` of `/var/local/emhttp/*.ini`,
  `/boot/config/` (never write there), `/var/log/plugins`, `/tmp/plugins`, `/tmp/notifications`,
  `/boot/config/plugins/dockerMan/templates-user`, `/var/lib/docker/unraid-*`, `/usr/local/emhttp/plugins/*/scripts`
  (read the scripts to learn the commands), `docker ps`, `virsh -r list --all`. Never run `emcmd`, `mdcmd`, `plugin`,
  `mover`, `update_container` or anything that changes state there. You may copy a test build of the agent to
  `/tmp/whombat-test/` and run read-only collection from it, then delete it.
- The DEV box (`~/Code/whombat-appliance/dev/devbox shell -- …`): read-only, only if you must see the live hub.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`agent: …`, `hub: …`, `server: …`, `web: …`,
  `mobile: …`), every message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never
  merge into `main`, never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-hosts`,
  `~/Code/whombat-contracts`): other sessions use them. The lead merges.
- **DEV fast** (John's rule): one quick check per repo at the end — `TMPDIR=~/.cache/wb-tmp pnpm check` (TS repos),
  `go vet ./... && go test ./...` (Go; `-race` once at the very end), `pnpm test:server` once (Whombat server). No VM
  tests, no repeated full suites, no CI waits. Own ports and throwaway databases; never stop or reset shared containers
  (`docker compose` is shared — never `down -v`). `/tmp` runs out of inodes: `TMPDIR=~/.cache/wb-tmp`.
- **Copy**: plain, short English a non-developer understands, curly quotes (’ “ ”), `·`, `−` for minus, `…`. Whombat's
  own chat words follow CLAUDE.md “Agents and automations talk like people”. Platform names: “Incus”, “unRAID” in
  prose is written **“Unraid”** in the UI (the vendor's own spelling today), “Proxmox VE”.
- **Tokens only** (`@whombat/tokens` CSS variables); match the surrounding code's style and comment density.
- **Decisions you make** go in your repo's decisions file (Whombat `docs/decisions/incus-unraid-server.md` as IU-S01…,
  whombat-app `docs/decisions/incus-unraid-<stream>.md`, `hosts/docs/decisions/hosts.md` as HS-33…: HI takes
  HS-33…HS-52, HU HS-53…HS-72; contracts `docs/decisions/contracts.md` as CT-363…). App IDs as listed in §3.
- **Shared files** (several streams touch them; keep your edits small, appended, in your own blocks):
  whombat-app `packages/client/src/hosts/{index.ts,react.ts,fixtures.ts,model.ts}`,
  `apps/web/src/features/things/Things.module.css`, `parts.tsx`; `hosts/internal/proto/manage.go`,
  `internal/hub/manage.go`, `internal/rules/health.go`, the sim and fake fleet, `docs/*.md`. New fixture handlers go in
  **your own file** (`packages/client/src/hosts/fixtures-<stream>.ts`, one call line in `fixtures.ts`); new CSS classes
  are prefixed with your stream (`.wi…`, `.wu…`); new Go code in new files (`incus_*.go`, `unraid_*.go`,
  `hub/manage_incus.go`, `hub/manage_unraid.go`, `rules/incus.go`, `rules/unraid.go`).
- **Visual check** for UI work: the app's fake world with servers (`VITE_WHOMBAT_TRANSPORT=session VITE_WHOMBAT_FAKE=1
  VITE_FIXTURE_HOSTS=1` vite in `apps/web`, signed in with `e2e-managed/support.ts` `signIn` + `claimAndSaveKit`),
  1440×900, both themes; the fixture world already has `thetitan` (Incus + Docker) and `blackbox` (Unraid 7.3). Match
  the Proxmox pages' look (they are the reference for density, cards, tables, dialogs); unRAID's own Main page is the
  reference for what the Array table shows. Fix differences before finishing.
- **Report** at the end: what you built (by IU decision), files outside your ownership you touched, contract gaps, what
  the lead must do at merge, how you verified it.

## 2. Shared shapes (all streams build to these)

The hub speaks snake_case; Whombat's contracts are the camelCase mirror (as in PX §2.1). Guest ids stay
`incus:<name>` / `incus:<project>/<name>`, `docker:<name>`, `libvirt:<name>`, `pve:<vmid>`.

### 2.1 Server kinds and the self guest (IU-02, IU-03)

- Hub `detail_view`: `proxmox` (PVE) · `unraid` (agent reports `system.unraid` / install `unraid`) · `incus` (Incus
  present, not PVE, not unRAID) · `standard`. Contracts `HostServerPlatform = ['proxmox','standard','incus','unraid']`
  (append; the app maps an unknown value to `standard`).
- Guests: `self: boolean` (only when true) — the guest whose MAC matches one of the hub machine's own. The agent reports
  `macs: string[]` per guest (Incus `volatile.<nic>.hwaddr`, PVE `netN` `macaddr`/`virtio=`, libvirt `<mac address>`),
  lower case. The hub reads its own from `/sys/class/net/*/address` (skip `00:00:00:00:00:00`, loopback) at start and
  every 10 minutes; `--self-macs` / `WHOMBAT_HOSTS_SELF_MACS` (comma list) overrides for tests.
- Servers: `hosts_this_whombat: true` (contracts `hostsThisWhombat`) on `HostServer` and `HostServerInfo` when one of
  its guests is `self`.
- Refusals (hub, and Whombat's server again before calling): 409 `self_guest`, message “That’s this Whombat itself.”,
  for power `stop`, `shutdown`, `force_stop`, `restart`, `reboot`, `pause`, `destroy`, `kill`; `snapshot_restore`
  (deleting a snapshot stays allowed); manage ops `config.set`, `disk.resize`, `disk.move`,
  `guest.delete`, `guest.rename`, `guest.move`, `guest.template`, `guest.migrate`, `guest.publish` (needs a stop),
  `backup.restore` over it, `guest.autostart`. Allowed: reads, `snapshot_create`, `backup.create`, consoles.
  Contracts: `HOST_SELF_GUEST_ALLOWED` lists what stays allowed; error code `self_guest` in the hosts error words.

### 2.2 Incus (IU-04)

`HostServerDetail.incus` (from the agent's report; slow refresh, 5 minutes, plus after every change):

```ts
HostIncusDetail = {
  version: string,                       // "6.0.4"
  clustered: boolean,
  projects: { name: string; description: string; instances: number; running: number }[],
  pools: { name: string; driver: string; status: string; description: string;
           usedBytes: number | null; totalBytes: number | null; volumes: number }[],
  networks: { name: string; type: string; managed: boolean; description: string;
              ipv4: string | null; ipv6: string | null; nat: boolean | null; usedBy: number }[],
  profiles: { name: string; project: string; description: string; usedBy: number }[],
  images: HostIncusImage[],
  volumes: HostStorageVolume[],          // custom volumes only
}
HostIncusImage = { fingerprint: string; aliases: string[]; description: string;
  type: 'container' | 'virtual-machine'; architecture: string; sizeBytes: number;
  uploadedAt: string | null; lastUsedAt: string | null; autoUpdate: boolean; cached: boolean; project: string }
HostStorageVolume = { pool: string; name: string; project: string; type: 'custom'; contentType: 'filesystem' | 'block' | 'iso';
  sizeBytes: number | null; usedBytes: number | null; usedBy: string[] /* guest ids */; description: string }
```

New **read** ops (`HOST_MANAGE_READ_OPS`, all need the manage switch like the others):

| Op | Hub route | Answer |
|---|---|---|
| `profile.get` | `GET …/incus/profiles/{profile}?project=` | `{op, profile: HostIncusProfile}` = `{name, project, description, config: Record<string,string>, devices: Record<string, Record<string,string>>, usedBy: string[], restricted: string[], digest}` |
| `network.leases` | `GET …/incus/networks/{network}/leases?project=` | `{op, items: {hostname, address, hwaddr, type, guestId: string \| null}[]}` |
| `log.get` | `GET …/guests/{guestId}/log?lines=` | `{op, file: string, lines: string[]}` (`lxc.log` / `qemu.log`, last 500 by default, ≤ 2000) |
| `backup.list` | existing route | Incus backups as `HostBackupVolume`: `volume` = backup name, `storage` = `"incus"`, `created`, `sizeBytes` (when known), `notes` = `expires <iso>` or empty, `format` = `optimized` / `tar`, plus new optional `expiresAt` |
| `task.list` | existing routes | Incus operations (running ones and the last 48 h, newest first) as `HostTask`, `id` `incus:<uuid>`, `cancellable?: boolean` (new optional field) |
| `choices` | existing | Incus gains `projects: string[]`, `remoteImages: {alias, description, type}[]` (the common images of `images:`: debian/13, debian/12, ubuntu/24.04, ubuntu/22.04, alpine/3.22, fedora/42, archlinux, rockylinux/9, nixos/25.05 — container and VM each, plus `/cloud` variants; a fixed list in the agent, a free alias is also accepted), and `project` in the query selects whose pools/networks/profiles |

New **write** ops (`HOST_MANAGE_OPS`), Incus:

| Op | Hub route | Role · reauth | Body | Answer |
|---|---|---|---|---|
| `guest.create` (Incus) | existing | admin · yes | adds `project`, `pool`, `network`, `cloud_init` (user data, ≤ 64 KiB) | 202 task, `new_id` = guest id |
| `guest.clone` (Incus) | existing | admin · yes | `name`, `storage` (pool), adds `project`, `instance_only` | 202 |
| `guest.rename` | `POST …/guests/{guestId}/rename` | admin · yes | `name` (Incus rules `^[a-zA-Z][a-zA-Z0-9-]{0,62}$`), stopped only | 202, `new_id` |
| `guest.move` | `POST …/guests/{guestId}/move` | admin · yes | `pool?`, `project?`, `confirm` (required), stopped only | 202, `new_id` |
| `guest.publish` | `POST …/guests/{guestId}/publish` | admin · yes | `alias?`, `description?`, `snapshot?` (publish a snapshot; else the instance must be stopped) | 202, `new_id` = fingerprint |
| `backup.create` (Incus) | existing | operator | `name?` (default `whombat-<yyyymmdd-hhmm>`), `expires_at?` (default 7 days), `instance_only?`, `optimized?`, `compression?` (`zstd` default, `gzip`, `none`) | 202 |
| `backup.restore` (Incus) | existing | admin · yes | `platform: incus`, `guest` (whose backup), `volume` (backup name), `name` (the new instance, default `<name>-restored`), `storage?` (pool), `start?` — always a **new** instance (`guest` names the source, never an overwrite) | 202, `new_id` |
| `backup.delete` (Incus) | existing | admin · yes | `?platform=incus&guest=&volume=` | 200 |
| `task.stop` (Incus) | existing | operator | cancels an operation that says `may_cancel` | 200 |
| `image.download` | `POST …/incus/images` | admin · yes | `alias`, `type` (`container` / `virtual-machine`), `project?`, `auto_update?` (default true) | 202, `new_id` = fingerprint |
| `image.refresh` | `POST …/incus/images/{fingerprint}/refresh` | operator | `project?` | 202 |
| `image.delete` | `DELETE …/incus/images/{fingerprint}` | admin · yes | `?project=` | 200 / 202 |
| `profile.create` | `POST …/incus/profiles` | admin · yes | `name`, `description?`, `copy_from?`, `project?` | 200 |
| `profile.update` | `PUT …/incus/profiles/{profile}` | admin · yes | `project?`, `digest`, `set`, `delete`, `devices` (`{name: {…} \| null}`), `description?` — same allowlist as instances | 200 `{changes}` |
| `profile.delete` | `DELETE …/incus/profiles/{profile}` | admin · yes | `?project=&confirm=1`; refused while used (`in_use`) or `default` | 200 |
| `volume.create` | `POST …/incus/pools/{pool}/volumes` | admin · yes | `name`, `size` (`10GiB`), `content_type?` (`filesystem` default, `block`), `project?`, `description?` | 200 |
| `volume.resize` | `POST …/incus/pools/{pool}/volumes/{volume}/resize` | operator | `size` (grow only), `project?` | 200 |
| `volume.delete` | `DELETE …/incus/pools/{pool}/volumes/{volume}` | admin · yes | `?project=&confirm=1`; refused while attached (`in_use`) | 200 |

Attaching a volume or adding a NIC stays `config.set` with `devices` (MANAGE.md §2.5 allowlist: `type=disk` with
`pool=`, `source=<custom volume>`, `path=`; `type=nic` with `network=` or `nictype=bridged,parent=`).
Snapshot schedules stay `config.set` (`snapshots.schedule`, `snapshots.expiry`, `snapshots.pattern`).

### 2.3 unRAID (IU-05)

`HostServerDetail.unraid` (from the agent's report every 30 s; plugins and update checks every 6 h):

```ts
HostUnraidDetail = {
  version: string,                       // "7.3.1"
  name: string,                          // NAME in var.ini: "BlackBox"
  license: string | null,                // regTy: "Pro"
  osUpdate: { version: string } | null,  // newer unRAID available (from /tmp/unRAIDServer.plg or plugin check)
  array: {
    state: 'started' | 'stopped' | 'starting' | 'stopping' | 'invalid',   // mdState / fsState
    stateRaw: string,                     // "STARTED"
    startOnBoot: boolean,                 // startArray
    sizeBytes: number, usedBytes: number, freeBytes: number,   // data disks only
    disabled: number, invalid: number, missing: number,        // mdNumDisabled / mdNumInvalid / mdNumMissing
    moverRunning: boolean,
    parity: {
      state: 'idle' | 'running' | 'paused',
      action: 'check' | 'correct' | 'rebuild' | 'clear' | null, // mdResyncAction while running
      pct: number | null, speedMbs: number | null, etaS: number | null, errors: number,  // mdResyncCorr while running
      last: HostUnraidParityRun | null,                         // sbSynced/sbSynced2/sbSyncErrs/sbSyncExit
      history: HostUnraidParityRun[],                          // /boot/config/parity-checks.log, newest first, ≤ 10
      schedule: string | null,                                 // plain words: “Monthly, day 1 at 00:30, no corrections”
    },
    disks: HostUnraidDisk[],                                   // parity, parity2, disk1…, in slot order
  },
  pools: { name: string; fsType: string; profile: string | null /* "raidz1", "mirror", "single" */;
           sizeBytes: number; usedBytes: number; freeBytes: number; disks: HostUnraidDisk[] }[],
  flash: HostUnraidDisk | null,
  shares: { name: string; comment: string; usedBytes: number; freeBytes: number;
            primary: string /* "array" or a pool */; secondary: string | null;
            moverAction: 'to_array' | 'to_pool' | null; smb: string | null /* "public" | "secure" | "private" */;
            nfs: boolean; encrypted: boolean }[],
  plugins: { name: string; file: string; version: string; update: string | null; author: string | null; supportUrl: string | null }[],
  notifications: { id: string; at: string; importance: 'alert' | 'warning' | 'normal';
                   event: string; subject: string; description: string }[],  // unread, newest first, ≤ 50
  docker: { enabled: boolean; imageUsedPct: number | null },
  vms: { enabled: boolean },
}
HostUnraidDisk = { name: string /* "disk1", "parity", "cache" */; slot: 'parity' | 'data' | 'pool' | 'flash';
  device: string | null; model: string | null; serial: string | null;
  status: 'ok' | 'disabled' | 'emulated' | 'missing' | 'new' | 'invalid' | 'wrong' | 'empty';
  statusRaw: string;                     // DISK_OK, DISK_NP_DSBL, …
  sizeBytes: number; usedBytes: number | null; freeBytes: number | null; fsType: string | null;
  tempC: number | null; spunDown: boolean; errors: number; rotational: boolean | null }
HostUnraidParityRun = { at: string; durationS: number | null; speedMbs: number | null; errors: number;
  result: 'ok' | 'errors' | 'cancelled' | 'failed'; action: string | null }
```

Docker guests on unRAID gain `autostart?: boolean`, `webUi?: string | null` (the template's `<WebUI>` with `[IP]` →
the host's LAN address, `[PORT:n]` → the mapped port), `template?: boolean` (a dockerMan template exists, so Update
works); `updateAvailable` comes from `/var/lib/docker/unraid-update-status.json` on unRAID. libvirt guests gain
`autostart?: boolean` (everywhere libvirt runs).

New **read** op: none needed (all of it is in the report).

New **write** ops (host ops, `platform: unraid`; guest ops on Docker/libvirt guests):

| Op | Hub route | Role · reauth | Body | Agent runs |
|---|---|---|---|---|
| `array.start` | `POST …/unraid/array/start` | admin · yes | | `emcmd cmdStart=Start` (refused when the array is started or the configuration is invalid) |
| `array.stop` | `POST …/unraid/array/stop` | admin · yes | `confirm` (required) | `emcmd cmdStop=Stop` |
| `parity.start` | `POST …/unraid/parity/start` | operator | `correct` (boolean, default false) | `mdcmd check CORRECT\|NOCORRECT` (array started, nothing running) |
| `parity.pause` / `parity.resume` / `parity.cancel` | `POST …/unraid/parity/{pause\|resume\|cancel}` | operator | | `mdcmd nocheck PAUSE`, `mdcmd check RESUME`, `mdcmd nocheck CANCEL` (check the 7.3 scripts for the exact words) |
| `disk.spin_up` / `disk.spin_down` | `POST …/unraid/disks/{disk}/spin-{up\|down}` (`{disk}` = `all` or a disk name from the report) | operator | | `emcmd cmdSpinupAll=true` / `cmdSpindownAll=true` / `cmdSpinup=<name>` / `cmdSpindown=<name>` |
| `mover.start` | `POST …/unraid/mover` | operator | | `/usr/local/sbin/mover start` (refused while running) |
| `plugin.check` | `POST …/unraid/plugins/check` | operator | | `plugin checkall` |
| `plugin.update` | `POST …/unraid/plugins/{plugin}/update` (`{plugin}` = a file name from the report, or `all`) | admin · yes | `confirm` | `plugin update <file>.plg` (never `unRAIDServer.plg`: `not_allowed`) |
| `notification.archive` | `POST …/unraid/notifications/archive` | operator | `id?` (omitted = all) | moves `/tmp/notifications/unread/<id>.notify` to `archive/` (unRAID's own `notify archive`) |
| `container.update` | `POST …/guests/{guestId}/update` (Docker guest on unRAID with a template) | admin · yes | `confirm` | dockerMan's `update_container <name>` |
| `containers.check` | `POST …/unraid/containers/check` | operator | | dockerMan's update check (`dockerupdate check`, see its script) |
| `guest.autostart` | `PUT …/guests/{guestId}/autostart` | operator | `on` (boolean) | Docker on unRAID: `/var/lib/docker/unraid-autostart` (dockerMan's format, keep order and waits); libvirt: `virsh autostart [--disable]` |

Every unRAID command runs as an agent task `unraid:<16 hex>` (202 with `task.id`), its stdout/stderr lines (secrets
masked) as the log, status `running` → `ok` / `error` by exit code; kept 24 h in memory; `task.status` reads it,
`task.list` with `platform=unraid` lists them. `notification.archive`, `guest.autostart` answer 200 at once.

`HostManagePlatform = ['pve','incus','unraid']` (append). Destructive (`HOST_MANAGE_DESTRUCTIVE_OPS`, append):
`guest.move`, `profile.delete`, `volume.delete`, `image.delete`, `array.stop`, `plugin.update`, `container.update`,
`parity.cancel`.

### 2.4 Hints (IU-08) — hub kinds (agent rules), Whombat maps the way out

| Kind | When | Section · way out |
|---|---|---|
| `incus.no_snapshots` | running instance, no `snapshots.schedule` (own or profile) and no backup in 30 days | guest → Snapshots tab (“Set a schedule”) |
| `incus.pool_full` | pool ≥ 85 % | storage |
| `incus.warning` | an Incus warning (the existing platform warnings) | system |
| `unraid.array_stopped` | array stopped (warning) | array → Start the array |
| `unraid.parity_errors` | last check ended with errors > 0 | array → Check parity |
| `unraid.parity_old` | a parity disk exists and the last check is > 35 days old or never | array → Check parity |
| `unraid.disk_errors` | a disk with `numErrors` > 0 | array |
| `unraid.pool_full` | pool ≥ 90 % | array |
| `unraid.plugin_updates` | plugins with an update (info) | plugins → Update all |
| `unraid.notification` | an unread unRAID alert (warning) or warning (info) | the text → Archive |
| `unraid.os_update` | newer unRAID (info) | link “Update in Unraid” |
| `docker.update_available` | (exists for Docker; on unRAID with a template the way out is **Update**) | guest → Update |

`raid.degraded` stays the critical alert for a degraded array (its section becomes `array` on unRAID).

### 2.6 QEMU through libvirt (IU-13) — contracts 0.84.0

Server kind `libvirt` (hub `detail_view` `libvirt`: libvirt present, not PVE/unRAID/Incus; UI label “QEMU/KVM”).
Contracts: `HostServerPlatform` + `libvirt`, `HostManagePlatform` + `libvirt`. Every libvirt op below works on
**every** host that runs libvirt (BlackBox's VMs too), whatever the server kind.

`HostServerDetail.libvirt` (report, slow refresh 5 minutes, plus after every change):

```ts
HostLibvirtDetail = {
  version: string,                       // libvirt "12.2.0"
  qemu: string | null,                   // QEMU "10.1.0"
  pools: { name: string; type: string /* dir, logical, zfs, netfs… */; active: boolean; autostart: boolean;
           path: string | null; usedBytes: number; totalBytes: number; availBytes: number; volumes: number }[],
  networks: { name: string; active: boolean; autostart: boolean; bridge: string | null;
              forward: string | null /* nat, route, bridge, open, none */; ipv4: string | null; dhcp: boolean; usedBy: number }[],
  folders: { domains: string | null; isos: string | null } | null,  // unRAID VM Manager (DOMAINDIR, MEDIADIR) when there are no pools
  firmware: { uefi: boolean; secureBoot: boolean; tpm: boolean },  // OVMF / swtpm present
  backupsDir: string | null,             // where Whombat's VM backups go (agent.toml [libvirt] backups_dir, default
                                         // <domains folder or first dir pool>/.whombat-backups)
}
```

Guest configuration (`config.get` / `config.set` with `platform` `libvirt`; the digest is the SHA-256 of the
inactive domain XML): `HostGuestConfig.values` uses PVE-like keys so the Proxmox editors can be reused —
`name`, `title`, `description`, `vcpus`, `vcpus_max`, `memory_mb`, `memory_max_mb`, `autostart` (`1`/`0`), `boot`
(`hd,cdrom,network` order), `cpu_mode` (`host-passthrough`, `host-model`, `maximum`, or `custom:<model>`),
`on_poweroff` / `on_reboot` / `on_crash` (`destroy`, `restart`, `preserve`, `rename-restart`), and devices as
`disk<N>` (`source=<path or pool/volume>,bus=virtio|sata|scsi|ide,format=qcow2|raw,target=vda,size=<bytes>`),
`cdrom<N>` (`source=<iso path or pool/volume>|empty,bus=sata|ide`), `net<N>` (`model=virtio|e1000e|rtl8139,
network=<name>|bridge=<name>,mac=<mac>,link=up|down`). Read-only (in `restricted`): `machine`, `firmware`
(`bios`/`uefi`), `secure_boot`, `tpm`, `hostdev<N>`, `graphics<N>`, `video`, anything else in the XML. New disks:
`disk<N>` with `new=<size>,storage=<pool or folder:domains>,format=qcow2`. A change to a running VM applies live
where libvirt can (CD/DVD media, link state, memory up to max, vCPUs up to max, autostart, title/notes) and otherwise at
the next start (`pending`). `disks` filled as for PVE.

`choices` (`platform=libvirt`): `storages` = active pools with `images` content, or `folder:domains` on unRAID;
`bridges` = host bridges; new optional `networks: string[]` (libvirt networks); `isos` = ISO files of every pool and
the ISO folder (`{volid, name, sizeBytes}`); new optional `osVariants: {id, label, firmware: 'bios'|'uefi', tpm: boolean}[]`
(a fixed list in the agent: Debian 13, Ubuntu 24.04, Fedora, Arch, Alpine, “Other Linux”, Windows 11 (UEFI + TPM),
Windows 10, Windows Server 2025, FreeBSD, “Other”); `firmware` (from the detail).

Ops (contracts: no new op names except `media.change`? **no** — media goes through `config.set` `cdrom<N>`):
`config.get`, `config.set`, `disk.resize` (grow; live with `blockresize` when running), `guest.create` (`kind: vm`,
`name`, `os_variant`, `set` with the keys above, `iso`, `storage`, `disk_gb`, `network` or `bridge`, `start`),
`guest.clone` (stopped; `name`, `storage?`; disks copied as a task), `guest.rename` (stopped), `guest.delete`
(stopped; `purge` = delete its disks and NVRAM too), `backup.create` (`compress?`; libvirt `backupBegin` push mode into
`<backupsDir>/<vm>/<yyyymmdd-hhmmss>/` with `domain.xml`, a task with progress from the job info; a stopped VM's disks
are copied), `backup.list`, `backup.restore` (always a new VM: `name`, `storage?`, `start?`), `backup.delete`,
`volume.create` / `volume.resize` / `volume.delete` (pool volumes; `in_use` while a domain uses it), `content.list`
(ISOs), `content.download` (`url`, `filename`, into a pool or the ISO folder; a task), `content.delete` (an ISO no
domain uses), `network.leases` (`virNetworkGetDHCPLeases`), `log.get` (`/var/log/libvirt/qemu/<name>.log`),
`task.list` / `task.status` / `task.stop` (agent tasks `libvirt:<16 hex>` for clone, backup, restore, download, disk
copies; `stop` aborts a backup job or a copy), `snapshot.list` (as today), `guest.autostart` (HU builds it).
`HOST_MANAGE_DESTRUCTIVE_OPS` already covers delete/restore/volume/content deletes.

Hints: `libvirt.pool_full` (pool ≥ 85 % → storage), `libvirt.no_backup` (running VM, no backup and no snapshot in 30
days → guest Backups). Tools (§2.5) widen to libvirt the same way as to Incus (`guest_config`, `guest_config_set`,
`guest_create` with `os_variant`/`iso`, `guest_clone`, `guest_rename`, `guest_delete`, `guest_disk` resize,
`guest_backup`, `storage_contents`/`storage_content` for ISOs, `storage_volume`, `network_leases`, `guest_log`,
`server_tasks`, `task_stop`, `server_choices`), plus `libvirt_overview {server}` (read).

### 2.5 Servers tools (contracts own the JSON schemas; server implements)

Existing tools take Incus where they took only Proxmox: `guest_config` / `guest_config_set` (Incus keys, `devices`,
`profiles`), `guest_create` (`project`, `profiles`, `pool`, `network`, `cloud_init`, `template` = image alias),
`guest_clone` (`storage` = pool, `project`), `guest_delete`, `guest_disk` (resize), `guest_backup` (Incus: create,
restore as new with `name`, delete; `expires_days`), `server_tasks`, `task_stop`, `server_choices` (projects, remote
images). Their descriptions stop saying “Proxmox only” where Incus works; the server stops hard-coding
`platform:'pve'` (it asks the host's kind).

New (read): `incus_overview {server}` (projects, pools, networks, profiles, images, volumes — the detail),
`incus_profile {server, profile, project?}`, `network_leases {server, network, project?}`, `guest_log {server, guest,
lines?}`, `unraid_overview {server}` (array, parity, disks, pools, shares, plugins, notifications, updates).

New (write): `guest_rename {server, guest, name}`, `guest_move {server, guest, pool?, project?}`, `guest_publish
{server, guest, alias?, snapshot?}`, `incus_image {server, action: download|refresh|delete, alias?, type?, image?,
project?}`, `incus_profile_set {server, action: create|update|delete, profile, set?, delete?, devices?, description?,
copy_from?, project?}`, `storage_volume {server, action: create|resize|delete, pool, volume, size?, content_type?,
project?}`, `unraid_array {server, action: start|stop|parity_check|parity_pause|parity_resume|parity_cancel|spin_up|
spin_down|mover|archive_notifications, correct?, disk?, notification?}`, `unraid_plugins {server, action: check|update,
plugin?}` (`plugin` = file name or `all`), `container_update {server, guest}` (also `action: check` without guest),
`guest_autostart {server, guest, on}`.

**Always ask** (sensitive): `guest_move`, `incus_image` delete, `incus_profile_set` delete,
`storage_volume` delete, `unraid_array` stop and parity_cancel, `unraid_plugins` update, `container_update` (not
`check`); plus everything PX listed. Every tool refuses the self guest's changes (§2.1) with “That’s this Whombat
itself.” and `server_power` on a `hostsThisWhombat` server asks with “This Whombat goes down too.” in the question.

## 3. Streams

| Stream | Repo · worktree · branch | Owns | IDs |
|---|---|---|---|
| **C** contracts | whombat-contracts · `~/Code/.wt/contracts-iu` · `iu` | `packages/core/src/domain/hosts.ts`, `connections-catalog.ts` (Servers tools), hosts error words, tests, release 0.83.0 | CT-363… |
| **HI** hosts Incus + self (Go) | the hosts service · `~/Code/.wt/hosts-iu-incus` · `iu-incus` | Incus collector/broker/manage (§2.2), MACs + self guest (§2.1, all platforms), `detail_view` `incus`, Incus rules, hub routes `hub/manage_incus.go`, sim/fake fleet Incus host, docs MANAGE.md §2.5, REST-API.md | HS-33…HS-52 |
| **HU** hosts unRAID (Go) | the hosts service · `~/Code/.wt/hosts-iu-unraid` · `iu-unraid` | unRAID collector (§2.3), unRAID manage + agent tasks, Docker/libvirt guest ops (`container.update`, `guest.autostart`), `detail_view` `unraid`, unRAID rules, hub routes `hub/manage_unraid.go`, sim/fake fleet unRAID host, docs (new MANAGE.md §2.6 unRAID) | HS-53…HS-72 |
| **SV** server | Whombat · `~/Code/.wt/whombat-iu-server` · `iu-server` | `apps/server/src/hosts/**`: map, routes, tools (§2.5), hints' ways out, self refusals, task outcomes | IU-S01… |
| **WI** web Incus + self | whombat-app · `~/Code/.wt/app-iu-incus` · `iu-incus` | Incus server page (tabs: Summary, Guests with Profiles card, Storage with pools + volumes, Images, Network, Backups, Sensors, System with projects, tasks, warnings), Incus instance page (Configuration editor, Devices, Snapshots + schedule, Backups, Tasks, Log; More: Back up now, Copy, Rename, Move, Make an image, Delete), Incus create dialog (project, image, profiles, pool, network, limits, cloud-init), the self badge and refusals everywhere on the web, client helpers in new `packages/client/src/hosts/incus.ts` | AP-1557…1586 |
| **WU** web unRAID | whombat-app · `~/Code/.wt/app-iu-unraid` · `iu-unraid` | unRAID server page (tabs: Summary, Array, Shares, Guests, Plugins, Sensors, System), array/parity/disk/mover actions, Docker on unRAID (Update, autostart, web page link, Check for updates), libvirt autostart, notifications, client helpers in new `packages/client/src/hosts/unraid.ts` | AP-1587…1616 |
| **HQ** hosts QEMU/libvirt (Go) | the hosts service · `~/Code/.wt/hosts-iu-qemu` · `iu-qemu` | libvirt collector additions (§2.6), libvirt manage + agent tasks, `detail_view` `libvirt`, libvirt rules, hub routes `hub/manage_libvirt.go`, sim/fake fleet libvirt host, docs (MANAGE.md §2.7 libvirt) | HS-73…HS-92 |
| **WQ** web QEMU | whombat-app · `~/Code/.wt/app-iu-qemu` · `iu-qemu` | QEMU/KVM server page (Summary, Guests, Storage with pools/volumes/ISOs, Network with leases, Backups, Sensors, System), libvirt VM page (Hardware, Options, Snapshots, Backups, Tasks, Log; More: Back up now, Clone, Rename, Delete) reusing the Proxmox editors, create dialog, the libvirt parts of a VM on an Unraid server; helpers in new `packages/client/src/hosts/libvirt.ts`, fixtures `fixtures-wq.ts` | AP-1647…1676 |
| **MA** Android | whombat-app · `~/Code/.wt/app-iu-mobile` · `iu-mobile` | `apps/mobile/**`: Incus instance screen, Incus server screen (Summary, Guests, Backups), unRAID server screen (Summary, Array, Guests, Plugins), container Update/autostart, self badge; shared helpers only in new files | AP-1617…1646 |

QEMU (§2.6) came later: contracts 0.84.0 adds it (C again); SV and MA take the libvirt parts after their Incus/unRAID
work, HQ and WQ are new streams. The lead merges C, vendors contracts 0.83.0 (then 0.84.0) into the `iu` branches of Whombat and whombat-app and tells the streams to
`git merge iu`; until then build against §2 (the shapes are final; add a local `type` mirror if you must and delete it
after the merge).

### C — contracts 0.83.0
Everything in §2 as Zod (append-only: optional fields, new enum members at the end, new ops at the end of their
lists), `HOST_SELF_GUEST_ALLOWED`, the tools of §2.5 with JSON schemas and descriptions in plain words (say which
platforms each works on), `SERVERS_SENSITIVE` additions, error words for `self_guest`, `in_use`, `not_allowed`
(platform-neutral wording). Tests for the new schemas (a full Incus detail, a full unRAID detail from BlackBox-like
data, the self guest). Release: bump to 0.83.0, `pnpm release`, tag `contracts-v0.83.0` on the `iu` branch (the lead
merges to main and pushes). Report the `dist-release/0.83.0` path. Target: done within ~45 minutes, before the rest.

### C (again) — contracts 0.84.0
§2.6 as Zod, append-only: the enums, `HostLibvirtDetail`, `HostChoices.networks` / `osVariants`, the libvirt keys in
the `HostGuestConfig` / `HostManageRequest` doc comments, the tools widened to libvirt with `libvirt_overview`,
feature `hosts.libvirt`, tests (a full libvirt detail, an unRAID-style detail with `folders` and no pools). Release
0.84.0 the same way.

### HQ — whombat-hosts: QEMU through libvirt
- Collector: `HostLibvirtDetail` (pools with usage, networks, unRAID folders from `/boot/config/domain.cfg`, firmware,
  QEMU version, backups dir) into the report; nothing else changes for guests (`macs` is HI's; `autostart` is HU's —
  if both of you need the domain XML parse, put shared helpers in a new file and tell the lead).
- Broker/manage (`broker/libvirt_manage*.go`): every op of §2.6 over the existing go-libvirt connection; XML edits
  through a typed model that round-trips unknown elements untouched (never regenerate the whole XML from scratch);
  argument checks (paths only inside pools, the domains/ISO folders or the backups dir; names `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`);
  agent tasks `libvirt:<16 hex>` with progress; Windows 11 preset (q35, OVMF secure boot, swtpm TPM 2.0, e1000e/virtio,
  SATA CD for the installer) when the host has OVMF and swtpm, else refuse that preset with a plain reason.
- Hub: routes for the reused ops with `platform=libvirt` (`hub/manage_libvirt.go`), guest manage ops on libvirt guests
  no longer 501, `detail_view` `libvirt` (precedence PVE > unRAID > Incus > libvirt > standard — HI and HU add theirs in
  parallel; make the function take all), libvirt rules (`libvirt.pool_full`, `libvirt.no_backup`), the fake fleet: one
  libvirt host (Debian + libvirt: a pool `default`, network `default` with leases, an ISO, three VMs incl. a Windows 11
  one, a backup) and the sim answering the ops.
- Tests with a fake libvirt (the repo's go-libvirt test patterns), plus ONE real-libvirt test behind
  `WHOMBAT_TEST_LIBVIRT=1`: in a throwaway Incus VM on The Titan in **your own project `whombat-test-kvm`** (create it;
  `incus launch images:debian/13 kvm-test --vm --project whombat-test-kvm -c limits.cpu=2 -c limits.memory=4GiB`;
  The Titan has nested KVM), install `libvirt-daemon-system qemu-system-x86 ovmf swtpm` there, copy the test binary in,
  run create → config → CD media → disk add/grow → snapshot → backup → restore as new → clone → rename → delete; then
  delete the project with everything in it. Run it once. Read-only check of BlackBox's real XML (`virsh -r dumpxml pbs`,
  `/boot/config/domain.cfg`) as test data (redact UUIDs/MACs if you like).
- Docs: MANAGE.md §2.7 libvirt, REST-API.md, CONTRACT.md, decisions HS-73…HS-92.

### WQ — web QEMU
The QEMU/KVM server page and the libvirt VM page as in §3's table. Reuse the Proxmox Hardware/Options editors and
dialogs (the key scheme of §2.6 was chosen for that), the Proxmox review step and task toasts. Hardware: disks (add
new/existing, grow, detach), CD/DVD (insert/eject an ISO, live), network cards (add on a network or bridge, link
up/down, remove), locked rows for firmware, TPM, passthrough and graphics (“Change this in virt-manager or Unraid’s VM
page.”). Create: OS type preset first (Windows 11 shows UEFI + TPM), then CPU, memory, disk and where (pool or the
domains folder), ISO, network, Start after creating. Storage tab: pools with usage, volumes (create, grow, delete
unused), ISO images (download from a URL, delete). Network tab: networks and their leases. Backups tab: every VM's
backups (Back up now, restore as new, delete). A VM on an **Unraid** server gets the same VM page (WU builds the Unraid
server page; agree nothing, just make the guest page platform-driven). Fixtures `fixtures-wq.ts`: a libvirt host
(`kvm-lab`, Debian 13) and BlackBox's `pbs` VM config (UEFI, raw disk on `/mnt/user/domains/pbs/vdisk1.img`, br0).

### HI — whombat-hosts: Incus and the self guest
- Collector: projects, pools (with `/resources` usage), networks, profiles (+ usedBy), images, custom volumes, in the
  report (proto + CONTRACT.md); per-guest `macs` for Incus, PVE and libvirt; `system`-level nothing new.
- Broker/manage: every Incus op in §2.2 (project-aware: `create`/`choices` in the asked project), `backup.*` with the
  backup file staying on the host (restore streams `GET …/backups/<b>/export` into `CreateInstanceFromBackup` locally),
  `task.list`/`task.stop` from `/1.0/operations` (+ the failed ones it keeps), `log.get`, `network.leases`,
  `profile.get/create/update/delete` (instance allowlist), `volume.*`, `image.*`, `guest.rename/move/publish`.
- Hub: routes (`hub/manage_incus.go`), roles/reauth/confirm/audit like the PVE routes, `detail_view` `incus`, the
  self guest (§2.1: MACs, `self`, `hosts_this_whombat`, refusals for power/snapshot actions and manage ops), Incus
  rules (§2.4). Fake fleet: make `basalt`'s Incus complete (projects, pools, images, profiles, networks, volumes,
  backups, operations) and give one fake host a `self` guest; the sim (`cmd/*-sim`) answers the new Incus ops.
- Tests with the fake Incus server (extend `fakeIncus`), plus **one real-Incus test** behind an env var
  (`WHOMBAT_TEST_INCUS=1`) that runs in project `whombat-test` on The Titan: create from `images:alpine/3.22`, config,
  snapshot, backup + restore as new, rename, publish, profile and volume create/delete, delete — everything inside that
  project, the project deleted at the end. Run it once.
- Docs: MANAGE.md §2.5 (full table), REST-API.md manage table, CONTRACT.md, `docs/decisions/hosts.md`.

### HU — whombat-hosts: unRAID
- Collector (`collect/unraid*.go`): §2.3 from `var.ini`, `disks.ini` (all slots, pools by `type=Cache` and pool
  names from `/boot/config/pools/*.cfg`), `shares.ini`, `/boot/config/parity-checks.log`, the parity schedule
  (`/boot/config/plugins/dynamix/dynamix.cfg` `[parity]` + its cron), `/var/log/plugins/*.plg` (version from the plg's
  entity `version`) vs `/tmp/plugins/*.plg` (update), `/tmp/notifications/unread/*.notify`, `/tmp/unRAIDServer.plg`
  (OS update), dockerMan templates (`my-<name>.xml`: WebUI, template present), `unraid-autostart`,
  `unraid-update-status.json`, docker.img use; libvirt autostart (all hosts). Check every parser against BlackBox's
  real files (copy them read-only into `testdata/unraid-7.3.1/` with secrets — `csrf_token`, `flashGUID`, serials,
  share names are fine — redacted).
- Manage (`broker/unraid_manage.go`): the ops of §2.3, the agent task registry, argument checks (disk names only from
  the current report, plugin files only from `/var/log/plugins`, container names only with a template), `emcmd` /
  `mdcmd` / `plugin` / `mover` / `update_container` paths checked to exist (`unsupported` otherwise). Read the 7.3.1
  scripts on BlackBox to get the exact `mdcmd` words and dockerMan's update entry point. `manage` switch on both sides.
- Hub: routes (`hub/manage_unraid.go`), the guest routes for Docker/libvirt (`/update`, `/autostart`) next to the 501
  for other ops, `detail_view` `unraid`, unRAID rules (§2.4; `raid.degraded` section `array` on unRAID), fake fleet
  unRAID host (BlackBox-like: started array, one data disk, missing parity, three ZFS pools, shares, Plex/arr Docker
  with templates and one update, a VM with autostart, two plugin updates, one alert notification, an OS update); the
  sim answers the new ops with fake tasks.
- Tests with a fake root (`testdata`, a fake `emcmd`/`mdcmd`/`plugin` on `$PATH` that records its arguments). Live: run
  a read-only collection on BlackBox from `/tmp/whombat-test/` once, compare with what unRAID's web page shows, delete
  it. **No writes on BlackBox.**
- Docs: MANAGE.md §2.6 unRAID, REST-API.md, CONTRACT.md, `docs/decisions/hosts.md`.

### SV — Whombat server
`apps/server/src/hosts/**`: map `incus` / `unraid` details, `self`, `hostsThisWhombat`, `autostart`, `webUi`,
`template`; `MANAGE_ROUTES` for every new op and read op (§2.2, §2.3); the tools of §2.5 (stop hard-coding
`platform:'pve'`: ask the server's kind); refusals for the self guest before calling the hub; hints' ways out for the
new kinds (§2.4); task outcome messages (IU-07) for Incus and unRAID tasks in plain words (“The parity check on
BlackBox is done. No errors.”, “web on The Titan is backed up.”, “Plex on BlackBox is up to date now.”); the fake hub
(`testing/fake-manage.ts`, fixtures `server-basalt.json` and a new `server-blackbox-unraid.json`) answers the new
routes; tests. Decisions in `docs/decisions/incus-unraid-server.md` (IU-S01…).
**Then QEMU (§2.6, contracts 0.84.0)**: map `libvirt` details and the libvirt config/choices, the reused ops with
`platform: libvirt`, the tools widened to libvirt + `libvirt_overview`, the two libvirt hints' ways out, task outcomes
for clone/backup/restore/download, a fixture `server-kvm-lab-libvirt.json`, `hosts.libvirt` in IMPLEMENTED_FEATURES.

### WI — web Incus and the self guest
Incus server page and instance page as in §3's table, with the Proxmox pages as the visual pattern (cards, tables,
the review step before a change, toasts with Show progress for tasks, PX-05). Configuration: the Incus allowlist as
grouped fields (Resources, Boot, Security, Snapshots, Notes, Profiles in order), raw `user.*` keys as a small key/value
list, restricted keys shown locked (“Change this with the incus command”). Devices: NICs and disks with add/remove;
the root disk's size. Create: project, image (local images first, then the common `images:` list, or type an alias),
profiles, pool, network, CPU, memory, disk, cloud-init user data (only for `/cloud` images), Start after creating.
Images tab: download (alias + type), refresh, delete; Profiles card: edit with the same field groups, create, delete
unused; Storage: pools with usage bars, custom volumes (create, grow, delete, which guest uses them, attach from a
guest's Devices). Network: networks and, for managed ones, leases. Backups tab: each instance's backups (Back up now,
restore as new, delete) and “no snapshot schedule” rows. System: Incus version, projects, operations (cancel), warnings.
Self: a “This Whombat” chip in every guest row and the guest page header, its changing actions hidden with one line
(“This is your Whombat itself.”); host power on a `hostsThisWhombat` server says the Whombat goes down too. Fixtures
(`fixtures-wi.ts`): `thetitan` with the real shape of The Titan (`whombat-dev-box` as `self`, projects `default` and
`ci-platform`, pool `default`, `incusbr0`, images, profiles, a custom volume, backups, operations).

### WU — web unRAID
unRAID server page as in §3's table. Summary: array card (state, used/free bar, parity line with progress or the last
check, Start/Stop), pools, updates (Unraid version, plugins, containers), unread notifications (Archive, Archive all),
hints with ways out. Array: tables like Unraid's Main (Parity, Data, each pool, Flash: status dot, device, model,
temperature, errors, file system, size, used, free, spin state with spin up/down), buttons Start/Stop array, Check
parity (dialog: write corrections, off by default), Pause/Resume/Cancel with progress, Spin up all / Spin down all, Run
mover; parity history and schedule. Shares: read-only table with “Change shares in Unraid’s own page.” Guests: Docker
on unRAID gets Update (when an update is available and a template exists), Autostart toggle, the web page link, “Check
for updates”; libvirt VMs an Autostart toggle. Plugins: installed with version, Update / Update all, Check for
updates, the Unraid version line (“Unraid 7.3.2 is available — update it in Unraid.” with a link to the server's own
page when its address is known). Fixtures (`fixtures-wu.ts`): `blackbox` from BlackBox's real shape (§2.3).

### MA — Android
IU-09: Incus instance screen (Summary, Settings with the everyday edits and the review step, Snapshots, Backups,
Tasks; More: Back up now, Copy, Rename, Delete; a line + link for what stays on the web), Incus server screen
(Summary, Guests, Backups), unRAID server screen (Summary with array/parity/updates/notifications, Array with disks
and the actions, Guests, Plugins with Update), Docker guest on unRAID: Update and Autostart; libvirt Autostart; the
self badge and hidden actions. 44 px touch targets, the existing phone patterns (`GuestScreen.tsx`, `ServerScreen.tsx`,
sheets). **Then QEMU (§2.6, contracts 0.84.0)**: the libvirt VM gets the same phone screen as an Incus instance
(Summary, Settings with vCPUs, memory, autostart, notes and the CD/DVD ISO, Snapshots, Backups, Tasks; More: Back up
now, Clone, Rename, Delete; hardware stays on the web), a QEMU/KVM server screen (Summary, Guests, Backups). Check it on the emulator (`export ANDROID_HOME=$HOME/Android/Sdk`) against the fake world, both themes.
