# Managing guests (Proxmox VE, Incus, unRAID, libvirt)

Whombat's hosts service can change guests, not only watch and power them:
edit a VM's or container's configuration, add and grow disks, create,
clone, convert to template and delete guests, back up and restore, keep
Proxmox's scheduled backup jobs, keep ISO images and container templates,
manage a guest's firewall, HA and replication, and follow every long
operation's task log. Proxmox VE gets all of it; Incus gets configuration
with devices and profiles, snapshots, backups kept on the host, create
from an image in any project, copy, rename, move, publish as an image,
delete, the instance log, tasks, and the host's profiles, custom volumes,
images and network leases (2.5). unRAID (2.6) gets its array, parity,
disks, mover, plugins and notifications, and its Docker containers an
update from their template; Docker on unRAID and libvirt guests get
autostart. QEMU/KVM VMs that libvirt runs (2.8) get configuration,
disks, CD/DVD, network cards, create, clone, rename, delete, backups,
storage volumes, ISO images, DHCP leases and the QEMU log, on every host
with libvirt (an unRAID server's VMs too). The host's own operating
system gets its waiting updates checked and installed (2.9). A server
with Docker can keep Whombats' backups, and an Unraid server can share a
folder over NFS that a Proxmox VE server adds as backup storage (2.10,
backup places). Other Docker
management is unchanged. The guest the Whombat itself runs in is protected (1, "The
self guest").

Protocol types: `internal/proto/manage.go`. Web types and calls:
`web/src/api/manage.ts`. REST details: `docs/REST-API.md` ("Manage").

## 1. Permissions

- **Manage** is a fifth remote-control capability, off by default, with
  the same two switches as the others: `[remote_control] manage = true` in
  the host's `agent.toml` (`Policy.Manage`; `sudo whombat-agent allow
  manage` sets it and reloads the agent) **and** the hub's per-server
  switch (`rc_manage`, Settings › Agents › server, re-authentication to turn
  on). It does not imply power or console, nor the other way round. A
  guest's snapshot list needs power or manage.
- **Roles**: reading configuration, choices, backups, backup jobs,
  content, tasks and firewall, and changing configuration, disks,
  firewall, backups (create, notes, protection), replication, running a
  backup job and stopping tasks need **operator**. **Admin plus a sign-in
  less than 10 minutes old** (`requireReauth`) for: create, clone, convert
  to template, delete a guest, migrate a guest, restore, delete a backup,
  create, change or delete a backup job, download to a storage, delete
  storage content, HA. unRAID (2.6): checks, parity, spinning disks, the
  mover, archiving notifications and autostart need operator; starting and
  stopping the array, updating plugins and updating a container need admin
  plus a recent sign-in. Operating-system updates (2.9): checking needs
  operator, installing admin plus a recent sign-in.
- **Confirmations** (`confirm: true` in the body, the UI asks first):
  config changes that delete an `unusedN` disk (destroys the volume),
  convert to template (irreversible), restore over an existing guest,
  migrate (it takes a while and restarts a running container), stopping
  the unRAID array, updating an unRAID plugin, updating a container,
  installing operating-system updates.
  Delete needs `confirm_name` equal to the guest's name; deleting a backup
  job `?confirm=1`.
- **Audit**: every change writes `manage.requested` before it is sent and
  `manage.finished` with the outcome (for tasks: when the task ends).
  Details: `op`, the target fields (`disk`, `size`, `storage`, `new_id`,
  `name`, `volume`, `url`, `task`), and for config changes `changes`
  (`key: old → new; …`, at most 2000 characters). Secrets
  (`cipassword`, `password`, and every value the agent masks) are never
  written to the audit log, the hub log or the agent log. Reads are
  audited like inspect views (`manage.viewed`, once per user, guest and
  view every 10 minutes).
- One change per guest at a time (the hub's action tracker, shared with
  power actions, and the agent's guest lock). A task that keeps running on
  the platform does not hold the lock; PVE locks the guest itself.
- **The self guest** (IU-02): agents report every Incus, Proxmox VE and
  libvirt guest's MACs; the hub compares them with its own machine's
  (`/sys/class/net/*/address` but `lo` and all-zero ones, at start and
  every 10 minutes; `--self-macs` / `WHOMBAT_HOSTS_SELF_MACS`, a comma
  list, replaces them) and marks the match `self` (its server
  `hosts_this_whombat`). What may change it is contracts 0.83.0's
  `HOST_SELF_GUEST_ALLOWED`: reads and consoles, the actions `start`,
  `resume`, `snapshot_create`, `snapshot_delete`, and the manage changes
  `backup.create`, `backup.update`, `backup.delete`, `guest.clone`,
  `replication.add`, `replication.delete`, `task.stop`, `backup.restore`
  as a new guest. Everything else that changes it (other power actions,
  `ctrl_alt_del`, `snapshot_restore`, `config.set`, disks, firewall, HA,
  rename, move, publish, template, migrate, delete, autostart, a container
  update, a restore over it) is
  409 `self_guest` “That’s this Whombat itself.”, audited as denied, also
  from the assistant's tool. Host power on its server is not refused
  (Whombat's question says the Whombat goes down too).

## 2. Agent

### 2.1 Runtime

`proto.StreamManage` → `Broker.Manage`, refused with
`remote_control_disabled` unless `Policy.Manage` (`internal/agent/streams.go`).
`internal/agent/broker/manage.go` validates the op, finds the guest in the
latest inventory (PVE templates too) and takes the guest lock for
changes, then calls the platform's `manager` (`pve_manage.go`,
`incus_manage.go`). A guest that was just created is not in the inventory
until the next report; host ops (create, restore as new, task status)
don't need it.

### 2.2 Proxmox VE: the manage token

When `manage = true` and the host is a PVE node, the agent provisions (at
start and on reload, idempotent; failures are logged and returned as
`platform_error` by every op until it works):

1. Role `WhombatManage`: the privileges of the built-in role `PVEVMAdmin`
   **minus** `VM.Console`, `VM.Monitor` and `VM.GuestAgent.*` (except
   `VM.GuestAgent.Audit`), **plus** `Datastore.AllocateSpace`,
   `Datastore.AllocateTemplate`, `Datastore.Audit`, `SDN.Use`,
   `SDN.Audit`, `Sys.Audit`, `Pool.Audit`, `VM.Migrate` (PVEVMAdmin has it;
   listed so the role keeps it) — each only if this PVE version knows it (read the privilege list from `pveum role list --output-format
   json`). `pveum role add` or `pveum role modify --privs` when it exists.
2. User `whombat-manage@pve` (comment "Whombat agent (manage)"), ACL
   `WhombatManage` on `/`.
3. When the privilege `Sys.AccessNetwork` exists (PVE 8.3+): role
   `WhombatNetwork` = `Sys.AccessNetwork`, ACL on `/nodes/<node>` for the
   user (this is what `download-url` needs instead of `Sys.Modify` on `/`).
   `Choices.Download` reports whether it is there. (`Choices.restore_isolate`, set by the hub from the agent's
   capabilities, says whether `backup.restore` takes `isolate`.)
4. Token `whombat-manage@pve!agent-<node>` (`--privsep 0`), stored in
   `/etc/whombat-agent/pve-manage-token` (0600, `[pve] manage_token_file`), like
   the read-only token (`provisionPVEToken`). Never logged.

When `manage` is off and the token file exists, the agent removes the
token (`pveum user token remove`) and the file. User and roles stay
(harmless without a token).

Everything below uses this token against the local API
(`https://127.0.0.1:8006/api2/json`, the collector's TLS setup), **except**
HA, whose API needs `Sys.Console` on `/` (root-equivalent): `ha.set` /
`ha.remove` run `ha-manager add|set|remove vm:<vmid>` as root with
validated arguments only. content.delete runs `pvesm free <volid>` as
root too (PVE needs `Datastore.Allocate` to delete volumes other than
backups, which would let the token change storage definitions), after
the volume was found, exactly, in the API's content list of a storage of
this node. Backup jobs are created, changed and deleted with `pvesh
create|set|delete /cluster/backup[/<id>]` as root (PVE wants `Sys.Modify`
on `/` for jobs, which would let the token change the node's settings),
after every value was checked (2.3); `--key=value` arguments only.
`pvesm`, `ha-manager` and `pvesh` run outside the agent's sandbox
(systemd-run, like `qm` and `pct`): they write outside `/etc/pve`. PVE
root-only settings stay refused by PVE itself because the token is not
root@pam.

Async PVE endpoints return a UPID: answer `OK` with `Task{ID: upid}`.
`POST .../config` is sent with `background_delay=5`: `null` → done,
`Changes` filled; a UPID → `Task` as well.

### 2.3 PVE operations

| Op | PVE API (node = local node) | Notes |
|---|---|---|
| config.get | `GET /nodes/{n}/{qemu,lxc}/{vmid}/pending` (+ digest from `GET .../config`) | Values = current values; Pending = `pending` fields; PendingDelete = `delete` > 0. Disks parsed for display. `cipassword` masked. Restricted = present keys outside the allowlist. HA from `/cluster/ha/resources/vm:<vmid>` (or ct:) and `/cluster/ha/status/current`; Replication from `/cluster/replication` + `/nodes/{n}/replication` (status) filtered to the guest (cluster only). |
| config.set | VM `POST .../config` (background_delay=5), CT `PUT .../config` | Set/Delete/Revert/Digest; every key and value through the allowlist (2.4). Changes = old → new (masked); `Pending` when the key shows up in `/pending` afterwards. |
| disk.resize | `PUT .../resize` `{disk, size}` | Size `+NG` or absolute; refuse shrinking (compare with the disk's current `size=`). |
| disk.move | VM `POST .../move_disk {disk, storage, delete}`, CT `POST .../move_volume {volume, storage, delete}` | Target storage must offer `images` (VM) / `rootdir` (CT). |
| choices | `/nodes/{n}/storage` (enabled+active), `/storage` (type, content, sparse), `/nodes/{n}/network?type=any_bridge`, `/cluster/sdn/vnets` (ignore 403/501), content of every `iso` / `vztmpl` storage, `/cluster/resources?type=vm` templates on this node, `/cluster/nextid`, `/nodes/{n}/capabilities/qemu/cpu`, `/cluster/status` (cluster + nodes) | `Thin`: lvmthin, rbd, zfspool with `sparse`, dir/nfs/cifs (qcow2). |
| guest.create | VM `POST /nodes/{n}/qemu`, CT `POST /nodes/{n}/lxc` | `vmid` = NewID or `/cluster/nextid`; `name` (VM) / `hostname` (CT) = Name; Set through the create allowlist (2.4); CT: `unprivileged=1` always (privileged containers are refused: `not_allowed`), `password` and `ssh-public-keys` allowed and never logged; `start`. NewID in the answer. |
| guest.clone | `POST .../{vmid}/clone {newid, name|hostname, full, storage}` | `full` required (true) when the source is not a template; `storage` only with full. |
| guest.template | `POST .../{vmid}/template` | Guest must be stopped (`guest_running`). |
| guest.delete | `DELETE /nodes/{n}/{qemu,lxc}/{vmid}?purge=…&destroy-unreferenced-disks=1` | Stopped only; `protection` set → `protected`. |
| guest.migrate | VM `POST .../qemu/{vmid}/migrate {target, online, with-local-disks, targetstorage}`; CT `POST .../lxc/{vmid}/migrate {target, restart, timeout, target-storage}` | Cluster only; target another node; the digest (if given) compared with `GET .../config` first; running VM → `online=1` + `with-local-disks=1`, running CT → `restart=1`, `timeout=180`, stopped → offline; templates refused. Needs `VM.Migrate` (listed in `WhombatManage`). |
| backup.list | content `?content=backup&vmid=` of every active storage with `backup` content | `verification.state` → Verified; `protected`, `notes`, `encrypted`, `format`, `subtype` → Kind. |
| backup.create | `POST /nodes/{n}/vzdump {vmid, storage, mode, compress, notes-template, protected}` | Storage must offer `backup`; mode default snapshot; compress default zstd (ignored for PBS). |
| backup.restore | VM `POST /nodes/{n}/qemu {vmid, archive, storage, force, unique, start}`; CT `POST /nodes/{n}/lxc {vmid, ostemplate: archive, restore: 1, storage, force, unique, start}` | Volume must be a backup volume of this node's storages; GuestID set = overwrite (`force=1`, guest stopped, same vmid); else NewID / next id. **Isolate** (`{name, marker, tag}`, a new guest that doesn't start; agents with the capability `restore_isolate`, the hub refuses it to others with `agent_outdated`): the agent reads the backup's configuration (`GET /nodes/{n}/vzdump/extractconfig`) and restores with `onboot=0`, every `netN` of it with `link_down=1` and a new MAC (the rest as it was), `protection=0` when it had protection, `name`/`hostname`, `description` = the marker and `tags` = its tags plus the tag. Proxmox VE writes these over the backup's own settings with the restore (VMs: PVE 7.2 and later; older ones refuse the restore, so nothing is made); a container's restore leaves `unique` out, which would give it the backup's cards back. A restore refused over the tag alone (a cluster that keeps tags to a list) is sent once more without it. |
| backup.update | `PUT /nodes/{n}/storage/{s}/content/{volume} {notes, protected}` | |
| backup.delete | `DELETE /nodes/{n}/storage/{s}/content/{volume}` | Refuse protected (`protected`). |
| content.list | `GET /nodes/{n}/storage/{s}/content?content=` | iso, vztmpl, import. |
| content.download | `POST /nodes/{n}/storage/{s}/download-url {url, content, filename, checksum, checksum-algorithm, verify-certificates=1}` | `http(s)://` only, no credentials in the URL; filename `[A-Za-z0-9._-]{1,200}` with the content's extension (`.iso`, `.img` for iso; `.tar.(gz|xz|zst)` for vztmpl; `.ova`, `.qcow2`, `.vmdk`, `.raw` … for import). |
| content.delete | `pvesm free <volid>` as root, after `GET /nodes/{n}/storage/{s}/content?content=` lists the volid exactly | iso / vztmpl / import volumes only (backups: backup.delete). |
| appliance.list | `GET /nodes/{n}/aplinfo` | |
| appliance.download | `POST /nodes/{n}/aplinfo {storage, template}` | Storage must offer `vztmpl`. |
| task.list | `GET /nodes/{n}/tasks?vmid=&limit=50&source=all` (guest) or without vmid (host) | Newest first, Status normalized: running / ok / warning (`WARNINGS: n`) / error. |
| task.status | `GET /nodes/{n}/tasks/{upid}/status` + `/log?start=&limit=500` | UPID must parse (`UPID:<node>:…`) and name the local node; LogStart -1 skips the log. |
| task.stop | `DELETE /nodes/{n}/tasks/{upid}` | |
| firewall.get | `GET .../firewall/options`, `.../firewall/rules`, `/cluster/firewall/groups`, `/cluster/firewall/options` (enable) | Digests from the answers. |
| firewall.options | `PUT .../firewall/options` | Keys: enable, dhcp, ndp, radv, macfilter, ipfilter, policy_in, policy_out, log_level_in, log_level_out. |
| firewall.rule_* | `POST .../firewall/rules`, `PUT .../rules/{pos}`, `DELETE .../rules/{pos}` | Fields as FirewallRule; `group` type needs an existing security group; macros as PVE validates. |
| ha.set / ha.remove | `ha-manager add|set|remove <sid> --state … --max_restart … --max_relocate … --comment …` as root | Cluster only (`unsupported` on a standalone node). |
| replication.add / delete | `POST /cluster/replication {id: <vmid>-<n>, type: local, target, schedule, rate, comment}`, `DELETE /cluster/replication/{id}` | Cluster only; target must be another cluster node; job number = first free. |
| backupjob.list | `GET /cluster/backup` (manage token: `Sys.Audit`) | vzdump jobs only (also old vzdump.cron ones without a type). `all` (or `exclude` without `pool`) → selection all with Exclude, `pool` → pool, else `vmid` → guests; `prune-backups` (object, or a property string on older PVE) → Keep, `keep-all` → every count 0; `compress` "1" → lzo; `mode` default snapshot; `next-run` → NextRun for enabled jobs. Digest = SHA-256 of the job's JSON without `next-run` (keys sorted, numbers as PVE wrote them). |
| backupjob.create | `pvesh create /cluster/backup --id=backup-<8 hex>-<4 hex> --schedule= --storage= --all=1 --exclude= \| --vmid= \| --pool= --mode= --compress= --prune-backups= --notes-template= --comment= --node= --enabled=` as root | Checked first: storage active on this node with `backup`; new guest ids in `/cluster/resources`; node in `/cluster/status`; pool in `/pools` (when readable); schedule `^[A-Za-z0-9 :,.*/~-]{1,128}$`; mode, compress (zstd, lzo, gzip, 0) enums; keep 0–10000 (every 0 → `keep-all=1`); notes-template, comment one line ≤ 1024. Defaults: mode snapshot, compress zstd unless the storage is PBS. The id is the agent's (pvesh says nothing back). |
| backupjob.update | `pvesh set /cluster/backup/<id> --key=value… --delete=…` as root | The job must be listed; Digest compared first (PVE's job API has none); only changed fields are sent; Clear → `--delete` (node, compress, prune-backups, notes-template, comment, exclude). Selection changes send `all=1`, `vmid` or `pool`; PVE drops the other selection's keys. Ids the job already has pass even when their guest is gone. Changes = field: old → new. |
| backupjob.delete | `pvesh delete /cluster/backup/<id>` as root | The job must be listed. |
| backupjob.run | `POST /nodes/{n}/vzdump {all=1, exclude \| vmid \| pool, storage, mode, compress, notes-template}` (manage token: `VM.Backup`, `Datastore.AllocateSpace`) | Refused for a job of another node or whose guests are all elsewhere (`unsupported`), or without a storage (`not_allowed`). A job with Keep runs with `remove=0`: `prune-backups` through the API needs `Datastore.Allocate`; the next scheduled run prunes. |

PVE parameter errors (HTTP 400 with `errors`) → `invalid_value` with
FieldErrors; "can't lock file" / "is locked" → `locked`; digest mismatch
→ `digest_mismatch`; 403 → `not_allowed` with PVE's message; other errors
→ `platform_error` with PVE's message (first line, at most 500 chars).
`pvesh`: "400 Parameter verification failed." with `field: message`
lines → `invalid_value` with FieldErrors named as the request's fields
(`prune-backups` → keep, `notes-template` → notes_template, `vmid` →
guests); "already exists" → `exists`; "no such vzdump job" → `not_found`;
a held cluster lock → `locked`.

### 2.4 PVE allowlist

The agent changes only these keys (config.set Set/Delete/Revert; create
additionally the create-only keys). Any other key present in a config is
`Restricted`. Values must be valid UTF-8 without control characters
(`description` may contain newlines).

**VM keys**: `name`, `description`, `tags`, `onboot`, `startup`,
`protection`, `cores`, `sockets`, `vcpus`, `cpu`, `cpulimit`, `cpuunits`,
`numa`, `memory`, `balloon`, `shares`, `ostype`, `bios`, `machine`,
`scsihw`, `boot`, `agent`, `tablet`, `hotplug`, `acpi`, `kvm`,
`localtime`, `freeze`, `vga`, `keyboard`, `serial[0-3]` (value `socket`
only), `ide[0-3]`, `sata[0-5]`, `scsi[0-30]`, `virtio[0-15]`, `efidisk0`,
`tpmstate0`, `net[0-31]`, `ipconfig[0-31]`, `ciuser`, `cipassword`,
`sshkeys`, `nameserver`, `searchdomain`, `citype`, `ciupgrade`,
`unused[0-255]` (delete only). Create-only: none beyond these.

**CT keys**: `hostname`, `description`, `tags`, `onboot`, `startup`,
`protection`, `cores`, `cpulimit`, `cpuunits`, `memory`, `swap`,
`nameserver`, `searchdomain`, `net[0-31]`, `features` (sub-keys
`nesting`, `keyctl`, `fuse` only), `rootfs` (create only; later via
disk.resize / disk.move), `mp[0-255]`, `console`, `tty`, `cmode`,
`timezone`, `unused[0-255]` (delete only). Create-only: `ostemplate`,
`password`, `ssh-public-keys`, `unprivileged` (must be `1`), `arch`.

**Disk values** (`ide/sata/scsi/virtio/efidisk0/tpmstate0/rootfs/mp`):
property string whose first (default-key) item is one of
- `STORAGE:SIZE` — a new volume, SIZE in GiB (integer or decimal), STORAGE
  a storage of this node with `images` (VM) / `rootdir` (CT) content;
- the volume the key already has (unchanged), or a volume that is
  currently an `unusedN` of the same guest (re-attach);
- CD-ROM (`media=cdrom`): `none`, `cdrom` is refused (host drive), or
  `STORAGE:iso/NAME` of an `iso` storage of this node;
- `efidisk0` / `tpmstate0`: `STORAGE:1` (new) or unchanged.
Refused everywhere: values starting with `/` (host paths, bind mounts),
the sub-key `import-from`, and `size=` changes (use disk.resize).

**Network values**: VM `MODEL[=MAC]` with MODEL in virtio, e1000,
e1000e, rtl8139, vmxnet3, then `bridge` (must be one of Choices.Bridges),
`tag` (1–4094), `firewall`, `rate`, `queues`, `mtu`, `link_down`,
`trunks`, `macaddr`. CT: `name`, `bridge`, `hwaddr`, `ip`, `gw`, `ip6`,
`gw6`, `tag`, `firewall`, `rate`, `mtu`, `link_down`, `type=veth`.
Unknown sub-keys are passed through (PVE validates them). A card's
current value with only `link_down=1` added is always taken, whatever its
model or bridge: pulling the cable never fails over a card Whombat doesn't
offer.

**Property strings** (Go `parsePropString` / TS `parseProps`): an ordered
list of `key=value` items separated by `,`; an item without `=` is the
default key's value (`file` for disks, the model for VM NICs is
`model=mac` written as `virtio=BC:24:…`); serializing keeps the order and
every item it did not change. Round trips must be lossless (fuzzed).

### 2.5 Incus

Over the Unix socket with the agent's own trust (`internal/agent/broker/
incus_manage*.go`, the official client). Digest = ETag (`If-Match`). Host
ops take `project` ("" = default) and connect to it after checking it
exists; guest ids are `incus:<name>` or `incus:<project>/<name>`. Long
operations answer with a task `incus:<operation uuid>`; the agent follows
the operations it started and keeps them 48 hours (at most 200), because
Incus forgets an operation 5 seconds after it ends.

| Op | Incus | Notes |
|---|---|---|
| config.get | `GET /1.0/instances/<n>` | Values = `expanded_config` minus `volatile.*` plus `device.<name>` from `expanded_devices`; Inherited = keys only in profiles; Profiles; Disks from disk devices. |
| config.set | `PUT /1.0/instances/<n>` with the instance's own config/devices changed | Allowed config: `limits.cpu`, `limits.memory`, `limits.memory.swap`, `limits.processes`, `boot.autostart`, `boot.autostart.priority`, `boot.autostart.delay`, `boot.host_shutdown_timeout`, `security.protection.delete`, `security.nesting` (containers), `snapshots.schedule`, `snapshots.expiry`, `snapshots.pattern`, `cloud-init.user-data` (≤ 64 KiB), `user.*`, `description` (top-level field). Devices as `device.<name>` keys or the `devices` map (`{name: {options} \| null}`, null removes): `type=nic` with `network=` (an Incus network) or `nictype=bridged,parent=` (a host bridge); `type=disk` with `pool=` (and `path`, `size`, `source=<custom volume>` of that pool) — never `source=` a host path. `profiles` (a non-empty ordered list of the project's profiles) replaces the instance's profiles; applying a profile is allowed whatever it holds (IU-04). Everything else (raw.*, security.privileged, idmap, proxy, unix-*, gpu, usb, pci, host disk sources) is Restricted. |
| disk.resize | `devices.<disk>.size` via PUT | Root disk, grow only. |
| choices | projects, storage pools (+ resources), networks (managed and host bridges, not Docker's `docker0` / `br-<12 hex>`), profiles and local images of `project`, the common images of `images:` | `remote_images`: debian/13, debian/12, ubuntu/24.04, ubuntu/22.04, alpine/3.22, fedora/42, archlinux, rockylinux/9 (each also `/cloud`), nixos/25.05; container and VM each. |
| guest.create | `POST /1.0/instances?project= {name, type, source: {type: image, alias\|fingerprint, server, protocol: simplestreams}, profiles, config, devices, start}` | Image `images:<alias>` → `https://images.linuxcontainers.org`; local alias or fingerprint (`local:` optional); other remotes refused. `pool` → the root disk (`device.root` with that pool), `network` → `eth0` on it (a host bridge becomes `nictype=bridged`), `cloud_init` → `cloud-init.user-data`; all through the allowlist. NewID = `<project>/<name>` outside the default project. |
| guest.clone | `POST /1.0/instances?project=<target> {name, source: {type: copy, source: <n>, project: <source project>, instance_only}}` (+ `pool` on the root device when Storage is set) | `project` copies into another project; `instance_only` leaves the snapshots out. |
| guest.rename | `POST /1.0/instances/<n> {name}` | Stopped only (`guest_running`); `^[A-Za-z][A-Za-z0-9-]{0,62}$`, not ending in `-`; `exists` when taken. NewID. |
| guest.move | `POST /1.0/instances/<n> {name, migration: true, pool, project}` | Stopped only; on this host (Incus copies and deletes the original); a pool and/or a project; NewID with the new project. |
| guest.publish | `POST /1.0/images?project= {source: {type: instance\|snapshot, name}, aliases, properties: {description}}` | A snapshot (`snapshot`), or the stopped instance (`guest_running` otherwise); `alias` must be free (`exists`). Task; its status carries the fingerprint as `new_id` when done. |
| guest.delete | `DELETE /1.0/instances/<n>` | Stopped only; `security.protection.delete` → `protected`. |
| log.get | `GET /1.0/instances/<n>/logs/lxc.log` (containers) or `qemu.log` (VMs) | The last `lines` (default 500, at most 2000) of at most 16 MiB, control characters removed; an instance that never started has none (empty list). |
| backup.list | `GET /1.0/instances/<n>/backups?recursion=1` | `volume` = backup name, `storage` = `incus`, `format` = `optimized` / `tar`, `created`, `expires_at`, `notes` = `expires <RFC 3339>`, `size_bytes` from the file in `/var/lib/incus/backups/instances/<project>_<name>/` when readable. Newest first. |
| backup.create | `POST /1.0/instances/<n>/backups {name, expires_at, instance_only, optimized_storage, compression_algorithm}` | `name` default `whombat-<yyyymmdd-hhmm>`, `expires_at` default 7 days (must be in the future), `compression` `zstd` (default), `gzip` or `none` (`compress` is read when it is empty); `exists` when the name is taken. Task. |
| backup.delete | `DELETE /1.0/instances/<n>/backups/<b>` | Host op with `guest` (whose backup). |
| backup.restore | `GET …/backups/<b>/export` streamed into `POST /1.0/instances` (the tarball, `X-Incus-name`, `X-Incus-pool`) | Always a **new** instance: `guest` names the source, `name` (default `<name>-restored`) must be free in its project, `storage` an optional pool, `start` starts it after. Both requests go over the local socket in the agent (nothing is written elsewhere); answers at once with an agent task `incus:<uuid>` ("Copying the backup: 45% (120MB/s)", "Unpacking the backup") whose status gets `new_id` when done. |
| task.list | `GET /1.0/operations?recursion=1&all-projects=true` | Operations of class `task` (exec and console sessions are not tasks), the agent's own of the last 48 h and the failed operations the collector reports; guest ops list the guest's; newest first; `cancellable` for running operations that say `may_cancel`. |
| task.status | `GET /1.0/operations/<uuid>` | Message = progress metadata; no log lines; `new_id` = the `fingerprint` of a finished image operation. |
| task.stop | `DELETE /1.0/operations/<uuid>` | Only when the operation may be cancelled (`not_allowed` otherwise); a finished one is OK. |
| network.leases | `GET /1.0/networks/<n>/leases` | Incus lists a project's own leases: without a project the agent also asks every project that uses the default project's networks. `guest` = the instance whose `volatile.*.hwaddr` holds the address. |
| profile.get | `GET /1.0/profiles/<p>?project=` | Config, devices, description, `used_by` (instances), `restricted` (config keys and `device.<name>` outside the allowlist), `digest` (ETag). |
| profile.create | `POST /1.0/profiles` | Empty, or a copy of `copy_from` (config and devices as they are: applying the original is allowed, so a copy adds nothing); `exists`. |
| profile.update | `PUT /1.0/profiles/<p>` with `If-Match` | `set`, `delete`, `devices`, `description` through the instance allowlist (container-only keys allowed: a profile serves both kinds); restricted keys and devices stay. Changes. |
| profile.delete | `DELETE /1.0/profiles/<p>` | `default` → `not_allowed`; used → `in_use`. |
| volume.create | `POST /1.0/storage-pools/<pool>/volumes?project= {name, type: custom, content_type, config: {size}, description}` | `size` absolute, at least 1 MiB; `content_type` `filesystem` (default) or `block`; `exists`. |
| volume.resize | `PUT …/volumes/custom/<v>` with `If-Match`, `config.size` | Grow only (`+2GiB` or the new total); a volume without a size limit is refused. Changes. |
| volume.delete | `DELETE …/volumes/custom/<v>` | Refused while attached (`in_use`). |
| image.download | `POST /1.0/images?project= {source: {type: image, mode: pull, server, protocol: simplestreams, alias, image_type}, auto_update, aliases}` | From `images:` only; `type` `container` / `virtual-machine`; `auto_update` default true; the alias names the image locally when it is free. Task; `new_id` = the fingerprint when done. |
| image.refresh | `POST /1.0/images/<fp>/refresh?project=` | Fingerprint or a prefix of at least 12. Task. |
| image.delete | `DELETE /1.0/images/<fp>?project=` | Fingerprint or a prefix of at least 12 (`invalid_value` when it is ambiguous). |

Everything else (disk.move, template, migrate, firewall, HA, replication,
storage content, appliances, backup.update): `unsupported`.

**Collector** (`internal/agent/collect/incus*.go`): every report carries
`Platform.Incus` (`proto.IncusDetail`): projects with their instance
counts (every run), storage pools with `GET …/resources` use, custom
volumes of every project with use (`…/state`) and the instances attaching
them, managed networks and host bridges (not Docker's), profiles of every
project, images of every project; read on the slow path (5 minutes) and
again after a lifecycle event that changes one of them (`instance-backup-*`,
`storage-pool-*`, `storage-volume-*`, `image-*`, `profile-*`, `network-*`,
`project-*`, instance created, deleted, renamed or updated). Each instance
reports its MACs, the snapshot schedule in effect (own or a profile's),
when it was created and its newest backup (`last_backup`).

### 2.6 unRAID

The agent reads and changes unRAID (6.12 and 7.x; checked against 7.3.1
on BlackBox) the way unRAID's own web page does: emhttp's files under
`/var/local/emhttp`, the flash configuration under `/boot/config`, the
plugin manager's and dockerMan's files, and the page's own commands.
Implementation: collector `internal/agent/collect/unraid*.go`, operations
`internal/agent/broker/unraid_manage.go`, tasks
`internal/agent/broker/unraid_tasks.go`.

**Report** (`Report.Unraid`, every 30 s; `proto/unraid.go`):

| Part | Source |
|---|---|
| version, name, license | `var.ini` `version`, `NAME`, `regTy` |
| array state | `mdState` / `fsState`: `started` (STARTED), `stopping`/`starting` (fsState Stopping, Starting, Mounting, Copying), `invalid` (mdState `ERROR:…` or `configValid` not `yes`), else `stopped`; `stateRaw` = mdState; `startOnBoot` = `startArray` |
| array disks | `disks.ini` sections `type=Parity` and `Data` in `idx` order; empty slots (`DISK_NP`, and a parity slot `DISK_NP_DSBL` without a device: parity not installed, as the Main page hides it) are left out. Status: DISK_OK ok, DISK_DSBL disabled, a data slot DISK_NP_DSBL emulated, DISK_NP_MISSING missing, DISK_NEW / DISK_DSBL_NEW new, DISK_INVALID invalid, DISK_WRONG wrong. Size, `fsSize`/`fsUsed`/`fsFree` are 1 KiB blocks; used/free only for a mounted file system; `temp` `*` = unknown; `spundown`, `numErrors`, `rotational`; model and serial from the disk collector by device, else from the `id` (`<model>_<serial>`) |
| array size, used, free | the data disks' `fsSize`, `fsUsed`, `fsFree` |
| disabled, invalid, missing | the installed slots' statuses (md's `mdNumDisabled`/`mdNumInvalid` count unassigned parity slots too: BlackBox reports 2 and 2 without any parity disk) |
| mover running | `shareMoverActive=yes` or `/var/run/mover.pid` names a live process |
| parity | running while `mdResyncPos` > 0, paused when `mdResync` = 0 then; action from `mdResyncAction` (`check P[ Q]` check, `correct` with `mdResyncCorr=1`, `recon …` rebuild, `clear`); pct = pos / `mdResyncSize`; speed = `mdResyncDb` KiB per `mdResyncDt` s; ETA = remaining × Dt / Db; errors = `sbSyncErrs`. Last: md's superblock (`sbSynced` start, `sbSynced2` end, `sbSyncErrs`, `sbSyncExit` 0 ok / −4 cancelled / other failed), or the history's newest line (md forgets after a reboot; the line wins when it is the same run: it has speed and action) |
| parity history | `/boot/config/parity-checks.log` `date\|duration s\|speed bytes/s\|exit\|errors\|action\|size KiB` (dates in `var.ini` `timeZone`; older lines `123.4 MB/s`), newest first, at most 10; action `check` (with parity), `read_check`, `sync` (recon P/Q), `rebuild` (recon D…), `clear` |
| parity schedule | `dynamix.cfg` `[parity]` (`mode` 0 off, 1 daily, 2 weekly, 3 monthly, 4 yearly, 5 custom; `hour` "M H", `day`, `dotm` incl. `28-31` and `W1`…`WL`, `month`, `write` NOCORRECT or empty, `cumulative`) in words: “Monthly, day 1 at 00:30, no corrections” |
| pools | names from `/boot/config/pools/*.cfg` (else the `type=Cache` sections with a file system); members are the `type=Cache` sections named like the pool or the pool plus digits (`apps`, `apps2`…); the first section carries `fsType` (e.g. `luks:btrfs`), `fsProfile` (raid10, raidz1, mirror; `single` for one device), sizes; status from `monitor.ini` `[poolsstatus]` |
| flash | the `type=Flash` section |
| shares | `shares.ini`: `useCache` no = array; only = `cachePool`; yes = pool then the array (or `cachePool2`), mover `to_array` (`to_pool` to a secondary pool); prefer = the same storages, mover `to_pool`; `luksStatus` ≠ 0 encrypted. SMB from `sec.ini` (`export` `-` = not exported, else `security`), NFS from `sec_nfs.ini` (`export` ≠ `-`) |
| plugins | `/var/log/plugins/*.plg` without `unRAIDServer.plg`; the `<PLUGIN>` tag's `name`, `version`, `author`, `support` with the DOCTYPE's entities resolved; update = the version of `/tmp/plugins/<file>` when newer (digit runs compared as numbers). `pluginsCheckedAt` = the newest `/tmp/plugins/*.plg` |
| notifications | `<dynamix.cfg [notify] path, default /tmp/notifications>/unread/*.notify` (`timestamp`, `event`, `subject`, `description`, `importance`; quoted values with `\"` escapes); id = file name without `.notify`; newest first, at most 50 listed, all counted |
| unRAID update | `/tmp/unraidcheck/result.json` (`isNewer`, `version`) unless in `ignored.json` `updateOsIgnoredReleases`; else `/tmp/plugins/unRAIDServer.plg` when newer |
| Docker, VMs | `docker.cfg` `DOCKER_ENABLED=yes`; docker.img use from `monitor.ini` `[system] docker` (only written above unRAID's warning level), else the `/var/lib/docker` file system; `domain.cfg` `SERVICE=enable` |
| encrypted, keyfile | an array or pool file system `luks:…`; `var.ini` `luksKeyfile` exists |

Docker guests on unRAID get `Autostart` (in `/var/lib/docker/unraid-autostart`),
`UnraidTemplate` (a `templates-user/*.xml` whose first `<Name>` is the
container), `WebUI` (dockerMan's label `net.unraid.docker.webui`, else the
template's `<WebUI>`; `[IP]` = `nginx.ini` `NGINX_LANIP` for host networking
or published ports, the template's `<MyIP>` when set, else the
container's own address; `[PORT:n]` = the published host port of n, else
n; only http(s) links; a link without placeholders is kept) and
`UpdateAvailable` from dockerMan's `unraid-update-status.json` (key
`ensureImageTag(Config.Image)`: `library/` without a registry path,
`:latest` without a tag; `undef` = unknown and the agent's own registry
check stays; else local digest ≠ remote digest). libvirt guests on every
host get `Autostart` (`virDomainGetAutostart`, read with the snapshot
count). The agent never runs unRAID's checks on its own: unRAID's cron
does (`plugincheck`, `unraidcheck`, `dockerupdate check` daily), or
`plugin.check` / `containers.check`.

**Operations** (`Platform: "unraid"`; the manage switch on both sides,
`remote_control_disabled` otherwise). Every argument is checked first:
array and parity state from the latest report, disk names from the
report (array and pool disks with a device), plugin files on disk in
`/var/log/plugins` and `/tmp/plugins`, notification ids in the unread
directory, containers with a template; a command that is not there
(another unRAID version) is `unsupported`. Commands run as root in their
own session (an agent restart does not stop them), environment `PATH`
with `/usr/local/sbin`, `HOME=/root`, `LANG=C`.

| Op | Checks | Runs | Task ends |
|---|---|---|---|
| array.start | `stopped` with mdState `STOPPED` (other stopped states — new array, missing or replaced disk, a new / missing / wrong / invalid disk — need a choice on unRAID's page: `not_allowed`); `invalid` → `not_allowed`; started/starting/stopping → `busy`; encrypted without the keyfile → `not_allowed` (“start it in Unraid’s own page, where you type the passphrase”) | `/usr/local/sbin/emcmd cmdStart=Start` | when `var.ini` says STARTED / Started (≤ 15 min) |
| array.stop | started | `emcmd cmdStop=Stop` | when stopped (≤ 15 min) |
| parity.start | started, parity idle; `correct` without a parity disk → `invalid_value` | `emcmd 'cmdCheck=Check&optionCorrect=correct'` or `emcmd cmdCheck=Check` (the Main page's Check button; without parity it is a read check) | when md is done: “No errors.” / “3 errors found.”; cancelled or an error code fails the task; a progress line every 5 minutes |
| parity.pause | running | `/var/tmp/stamps.ini` like the page's `ParityControl.php`, then `emcmd cmdCheckPause=` | paused (≤ 1 min) |
| parity.resume | paused | stamps, then `emcmd cmdCheckResume=` | running |
| parity.cancel | running or paused | `emcmd cmdCheckCancel=` | idle |
| disk.spin_up / disk.spin_down | `all`, or an array / pool disk of the report with a device | `emcmd cmdSpinupAll=Apply` / `cmdSpindownAll=Apply` / `cmdSpinup=<disk>` / `cmdSpindown=<disk>` (the page's `ToggleState.php`) | at once |
| mover.start | started, the mover not running | `/usr/local/sbin/mover start` (what unRAID's cron runs) | when the mover exits |
| plugin.check | | `/usr/local/sbin/plugin checkall` | when done |
| plugin.update | a file name `[A-Za-z0-9][A-Za-z0-9._+-]*.plg` installed in `/var/log/plugins` with a newer copy in `/tmp/plugins`; `unRAIDServer.plg` → `not_allowed` (unRAID updates need a reboot: its own page); `all` = every plugin the report lists with an update (none → `not_found`) | `/usr/local/sbin/plugin update <file>`, one after another for `all` (a failure fails the task, the others still run) | when done |
| notification.archive | the id (or every unread one when empty) in the unread directory | `/usr/local/emhttp/plugins/dynamix/scripts/notify archive <id>.notify` (unRAID 7 keeps the archive copy from the start and removes the unread one) | done at once (200) |
| containers.check | Docker on | `…/dynamix.docker.manager/scripts/dockerupdate check nonotify` (like the Docker page's button: no notification per update) | when done |
| container.update (guest, Docker on unRAID) | a dockerMan template for the container (`not_allowed` otherwise: “update it where it was created”) | `…/dynamix.docker.manager/scripts/update_container <name>` | when done; it reports to the Docker page and exits 0 either way, so the agent checks the container exists again (and runs again when it ran): “plex is up to date.” |
| guest.autostart (guest, Docker on unRAID) | `on` given | dockerMan's list `/var/lib/docker/unraid-autostart` as its page edits it: on adds the name and sorts the list (by `userprefs.cfg` order, else natural name order; the others' wait times kept), off removes the line; an empty list removes the file | done at once (200, `changes` autostart old → new) |
| guest.autostart (guest, libvirt, any host) | `on` given | `virDomainSetAutostart` (what `virsh autostart [--disable]` does) | done at once |

**Tasks**: id `unraid:<16 hex>`; type = the op; guest = the container for
`container.update`; status running → ok / error (exit code, or what the
task waited for); message = the outcome (“The array is started.”, “No
errors.”, “tailscale is up to date.”) or the error's first line; the log =
the command line (`$ …`), its stdout and stderr (progress lines split at
`\r`, terminal escapes and dockerMan's HTML taken out, values of secret-
looking keys and URL passwords masked) and the agent's own lines. The log
file lives in `<state_dir>/tasks/` (RAM on unRAID). Tasks are kept a day
after they end. `task.status` takes `unraid:` ids on any platform (the hub
follows a container update with `platform: docker`); `task.list` with
platform `unraid` lists them, newest first, and a Docker guest's lists its
updates. `task.stop` is `unsupported` (cancel a parity check with
`parity.cancel`). One array or parity command, one plugin command, one
mover run, one container check and one update per container at a time
(`busy`). After an operation and when a task ends, the agent reads unRAID's
state again and reports at once.

**Not covered** (IU-10): unRAID OS updates (a reboot: the hint links to
unRAID's page), share and pool editing, adding containers from Community
Applications, editing VM XML, flash and appdata backup, Docker updates on
hosts that are not unRAID, starting an array that needs a choice
(passphrase, new or missing disks).

### 2.7 Collector additions (PVE)

- `Guest.Tags` (cluster resources `tags`, split on `;` and `,`).
- Guest configs are read from `/pending` instead of `/config` (same
  privilege, also gives `PendingChanges`).
- `Guest.GuestAgent`: running VMs with `agent` enabled: `running` when
  `agent/get-osinfo` answers, `not_running` when PVE says the agent is not
  running (HTTP 500 "… not running"); empty otherwise (403 etc.).
- `Guest.OldestSnapshot` from the snapshot lists (`snaptime`).
- `Guest.BackupJob`: an enabled backup job covers the guest (`all` with
  `exclude`, `vmid` list, `pool`, node restriction). Read on the slow path
  (every 5 minutes); after a backupjob create, update or delete through
  the agent the jobs are read again with the next report (seconds).
- `Guest.HAState` from cluster resources `hastate`.
- `PVE.Templates` (template guests of this node) and
  `PVEStorage.ProvisionedBytes` / `Thin` (sizes from the guest configs).

### 2.8 libvirt (QEMU/KVM)

`broker/libvirt_manage*.go` over the go-libvirt connection
(`qemu:///system`); `lvfake` is the in-memory libvirt of the tests and
the simulator. Every op takes `platform: libvirt` and works wherever
libvirt runs, whatever the server's kind (BlackBox's VMs too).

**Configuration** (`config.get` / `config.set`). The digest is the
SHA-256 of the inactive domain XML (secure, so VNC passwords survive a
change). Values are the configuration in effect (the live XML while the
VM runs); Pending is what the inactive XML (the next start) has
differently; a device only the running VM still has is in
PendingDelete. Keys (Proxmox-like, so the Proxmox editors work):

| Key | Value | Live while running |
|---|---|---|
| `name` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; a change renames (stopped only) and answers `new_id` | no |
| `title`, `description` | one line up to 1024 / text up to 64 KiB | yes (`virDomainSetMetadata`) |
| `vcpus`, `vcpus_max` | current / maximum vCPUs (`<vcpu current=…>`); more than the maximum raises it; the topology follows (1 socket) | `vcpus` up to the running maximum |
| `memory_mb`, `memory_max_mb` | the balloon target (`currentMemory`) / maximum (`memory`) in MiB; more than the maximum raises it. `memory_mb` shows the target, not what the balloon reached | `memory_mb` up to the running maximum |
| `autostart` | `1` / `0` (`virDomainSetAutostart`) | yes |
| `boot` | `hd,cdrom,network` in order (`<os><boot dev>`, or the devices' own `<boot order>` when the VM uses those) | no |
| `cpu_mode` | `host-passthrough`, `host-model`, `maximum`, `custom:<model>` (a usable model of the domain capabilities); topology, features and caches stay | no |
| `on_poweroff`, `on_reboot`, `on_crash` | `destroy`, `restart`, `preserve`, `rename-restart` | no |
| `disk<N>` | `source=<path or pool/volume>,bus=virtio\|sata\|scsi\|ide\|usb,format=qcow2\|raw,target=vda,size=<bytes>` (+ `cache`, `discard`, `readonly=1` when set) | no |
| `cdrom<N>` | `source=<iso path or pool/volume>\|empty,bus=sata\|ide` (+ `target`) | the medium (`virDomainUpdateDeviceFlags`) |
| `net<N>` | `model=virtio\|e1000e\|e1000\|rtl8139\|vmxnet3,network=<name>\|bridge=<name>,mac=<mac>,link=up\|down` | `link` |

Devices are numbered in the inactive XML's order (disks, CD/DVD drives,
network cards each from 0). A new disk is the next `disk<N>` set to
`new=<size>,storage=<pool or folder:domains>[,format=qcow2|raw][,bus=]`
(a volume `<vm>-<target>.qcow2` in the pool, raw on block pools, or
`<domains>/<vm>/vdiskN.qcow2` on unRAID) or `source=<pool/volume or path>`
(a file in a pool or unRAID's folders that no other VM uses). Deleting a
`disk<N>`, `cdrom<N>` or `net<N>` detaches it; a disk's file stays. A
disk's `bus` changes when stopped (new target, the address dropped);
`source`, `format` and `size` do not change (`disk.resize` grows).
Changes to a running VM that libvirt cannot apply live are written for
the next start (Pending). `revert` gives keys their running value back.

Read-only, in Restricted: `machine`, `firmware` (`bios`/`uefi`),
`secure_boot`, `tpm`, `video`, `hostdev<N>` (PCI/USB passthrough),
`graphics<N>`, disks that are whole devices or network disks, network
cards that are not on a libvirt network or a host bridge (macvtap,
hostdev); changing them is 403 `not_allowed` (“change it in virt-manager
or Unraid’s VM page”). Everything else in the XML stays as it was: edits
go through an XML tree that writes back what it does not know
(`broker/libvirt_xml.go`), never a regenerated document.

| Op | libvirt | Notes |
|---|---|---|
| disk.resize | running: `virDomainBlockResize` (QEMU tells the guest); stopped: `virStorageVolResize` (a transient pool on a file outside the pools) | `disk` = `disk<N>` or the target (`vda`); grow only |
| choices | pools, unRAID's folders (`folder:domains`, `folder:isos` with `statfs`), networks, host bridges (`/sys/class/net/*/bridge`, not Docker's or a network's), ISOs, custom CPU models, `os_variants`, `firmware` | |
| guest.create | a new document per OS type (below), then `set` like config.set; `virDomainDefineXMLFlags(VALIDATE)`, `start` | synchronous, `new_id` = the name |
| guest.clone | stopped only; every disk file copied (`virStorageVolCreateXMLFrom`, qcow2) into `storage` or where it is; new UUID, new MACs, a fixed display port becomes automatic; the UEFI variables copied | task `qmclone`; whole-device disks refuse (`not_allowed`) |
| guest.rename | stopped only (`virDomainRename`) | libvirt refuses a VM with snapshots (`not_allowed`) |
| guest.delete | stopped only; `virDomainUndefineFlags` with managed save, snapshot and checkpoint metadata; `purge` adds NVRAM and TPM state and deletes the disk files in pools and unRAID's domains folder no other VM uses (the VM's empty unRAID folder too) | without purge the NVRAM and TPM stay; the hub sends `purge` unless `purge=0` |
| backup.create | running: libvirt's backup job (push mode, `virDomainBackupBegin`) of the disks the VM runs with, progress from `virDomainGetJobStats` (`disk_*`), stop aborts it; stopped: each disk file copied; then the UEFI variables, `domain.xml` and `backup.json` | task `vzdump`; read-only and whole-device disks are left out (and said so) |
| backup.list | the VM's folder (by its UUID, else its name); without a VM every VM's | `volume` = the folder (`yyyymmdd-hhmmss`), `storage` = `libvirt`, `guest` = the VM |
| backup.restore | always a new VM (`name`, default `<vm>-restored`): disks copied into `storage` or where they were, new UUID and MACs, the UEFI variables back, a new empty TPM; writable disks not in the backup are left out | task `qmrestore`; works for a deleted VM's backups |
| backup.delete | the backup folder's files, the folder, the VM's folder when empty | |
| volume.create / resize / delete | `virStorageVolCreateXML` / `Resize` / `Delete` on a pool | `in_use` while a VM's disk is the volume (resize: while it runs) |
| content.list | `iso`: ISO files of file-based pools and unRAID's ISO folder; `images`: a pool's volumes (or unRAID's VM disk files) with format, use and `used_by` | |
| content.download | HTTP(S) into a pool or `folder:isos` through `virStorageVolUpload`; checksum checked on the way, a mismatch deletes the file | task `download`; `.iso` names only |
| content.delete | an ISO no VM uses | `in_use` otherwise |
| network.leases | `virNetworkGetDHCPLeases`; `guest` = the VM with that MAC | |
| log.get | the end of `/var/log/libvirt/qemu/<vm>.log` (last 500 lines, at most 2000) | |
| task.list / status / stop | agent tasks `libvirt:<16 hex>`, kept 24 hours | stop aborts a backup job at once; a disk copy libvirt is doing finishes and is then removed |

**Files through libvirt.** The agent's sandbox keeps the file system
read-only, so every file Whombat makes — volumes, VM folders on unRAID,
backups, `domain.xml` / `backup.json` (`virStorageVolUpload`), downloads,
copied UEFI variables — is written by libvirt itself: a pool of the host
when one is on that folder, else a transient directory pool
`whombat-tmp-<8 hex>` the agent makes and removes (shared by concurrent
work on one folder; leftovers of a crashed agent are removed at its next
start). The agent only reads (backups, logs, `domain.cfg`, qcow2
headers, free space). Writes go only into file-based pools, unRAID's
domains and ISO folders and the backups folder; a disk outside them can
be shown, grown and backed up, never written to by a copy or deleted by
a purge.

**Backups folder**: agent.toml `[libvirt] backups_dir`, default
`<unRAID's domains folder or the first directory pool ("default"
first)>/.whombat-backups`; one folder per VM (its name, characters other
than letters, digits, `.`, `-`, `_` as `_`), one per backup
(`yyyymmdd-hhmmss`). qcow2 files take only the used space; `compress` is
accepted and not applied further. `backup.json` (written last: a folder
without it is unfinished and not listed): name, UUID, time, notes, the
disks with their source, the UEFI variables file.

**OS types** (`choices.os_variants`, create's `os_variant`): `debian13`,
`ubuntu2404`, `fedora`, `arch`, `alpine`, `linux` (Other Linux), `win11`,
`win10`, `win2025`, `freebsd`, `other`. All are q35 with a VNC display on
127.0.0.1, a QEMU guest agent channel, a USB tablet and a virtio balloon;
Linux: virtio disk, virtio network card, virtio video, serial console,
RNG; Windows: SATA disk and CD/DVD, e1000e, VGA video, Hyper-V
enlightenments, local-time clock; `win11` (and `win2025`) UEFI
(`firmware='efi'`, libvirt picks the OVMF build) with Secure Boot and SMM
when the host has a secure build, `win11` also a TPM 2.0 (swtpm,
`tpm-crb`). A preset that needs UEFI or a TPM the host lacks (domain
capabilities: the `efi` firmware value; `tpm` with the emulator backend,
or `/usr/bin/swtpm`) is refused with a plain reason on `os_variant`
(“Windows 11 needs UEFI firmware (OVMF) and a TPM emulator (swtpm) on
this server. …”). On unRAID the document gets unRAID's `vmtemplate`
metadata (name, icon, os) so its VM page shows it right. Defaults per
type: memory, vCPUs, disk size (Windows 4 GiB / 2 / 64 GB, Alpine 1 GiB
/ 1 / 8 GB, else 2–4 GiB / 2 / 32 GB); the disk is made only with
`disk_gb` or `storage`; `iso` adds a SATA CD/DVD and boots it first; the
network card goes on `network` or `bridge`, else the network `default`,
else the first host bridge.

**Snapshots** stay the power path (internal snapshots); a VM with a
writable disk that is not qcow2 is refused in plain words (“Snapshots
need every disk in qcow2 format, and disk vdb is raw. Back the VM up
instead.”), and libvirt's refusal for UEFI firmware too.

**Host view** (`Report.Libvirt.Libvirt`, every 5 minutes and after a
libvirt change or the end of one of its tasks): QEMU's version, pools
(type, state, autostart, path, use, volume count without folders),
networks (bridge, forward mode, IPv4, DHCP, the VMs' cards on it),
unRAID's folders (`/boot/config/domain.cfg` `DOMAINDIR`, `MEDIADIR`),
firmware (UEFI, Secure Boot, TPM from the q35 domain capabilities) and
the backups folder. VMs add `LastBackup` (newest finished backup) and
`LastSnapshot` (newest snapshot).

### 2.9 Operating-system updates

Whombat's `server-updates.md` (SWU-01…SWU-15) decides what this does; the
agent's side (HS-119…HS-138 in `docs/decisions/hosts.md`): check for and
install the updates the host's package manager has waiting, with the
package managers the agent already reads (`internal/agent/pkgs`): apt
(Proxmox VE, Proxmox Backup Server, Debian, Ubuntu), dnf/yum, zypper,
apk, pacman. Implementation: command lines and the runner
`internal/agent/pkgs/install.go`, `task.go`, `lock.go`; the agent's task
registry and the operations `internal/agent/broker/pkg_tasks.go`; the
runner command `whombat-agent package-task` (`cmd/whombat-agent/packagetask.go`).

**Operations** (`Platform: "host"`, or empty; the manage switch on both
sides). Both answer at once with a task `pkg:<16 hex>`.

| Op | Request | Refused |
|---|---|---|
| `packages.check` | — (`Packages` refused: `invalid_value`) | see below |
| `packages.install` | `Packages`: only these (each `^[A-Za-z0-9][A-Za-z0-9+._:@~-]{0,127}$`, at most 200, duplicates dropped); empty: every waiting update | see below |

Refusals, before anything runs: TrueNAS (`/etc/truenas` or `midclt`, asked
before apt) `not_allowed` “TrueNAS installs its updates itself, on its
Update page.”; Unraid `unsupported` (“Unraid updates itself on its Update
OS page, and its plugins and containers have their own updates.”); NixOS
`unsupported` (“NixOS is updated by changing its configuration, not by
installing packages.”); no package manager the agent knows `unsupported`
(“This server has no package manager Whombat can use.”); pacman with
`Packages` `not_allowed` (a partial upgrade breaks Arch); a package task
already running `busy`. An agent older than this answers `unsupported`
“unknown operation” (the new agent's sentences never say that).

**Command lines** (`pkgs.Plan`, unit-tested; never a release upgrade, a
repository change or a held package):

| Manager | Check | Install everything | Install named |
|---|---|---|---|
| apt | `apt-get -q -o DPkg::Lock::Timeout=120 update` | the refresh, then `apt-get -q -y -o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade` (never `upgrade`: Proxmox's rule) | the refresh, then the same options `install --only-upgrade <names>` |
| dnf | `dnf -y --refresh makecache` | the refresh, then `dnf -y upgrade` | `dnf -y upgrade <names>` |
| yum | `yum -y makecache` | the refresh, then `yum -y update` | `yum -y update <names>` |
| zypper | `zypper --non-interactive refresh` | the refresh, then `zypper --non-interactive update --auto-agree-with-licenses` (`dup` on Tumbleweed and Slowroll, from `/etc/os-release` `ID`) | `… update --auto-agree-with-licenses -- <names>` |
| apk | `apk --wait 120 --no-progress update` | the refresh, then `apk --wait 120 --no-progress upgrade` | `… upgrade <names>` |
| pacman | none: no safe refresh without upgrading, the cache is read again | `pacman -Syu --noconfirm --noprogressbar` | refused |

Before an apt install, a dpkg run that stopped halfway
(`/var/lib/dpkg/updates` not empty) is finished first: `dpkg
--force-confdef --force-confold --configure -a`. Environment of every
command: `DEBIAN_FRONTEND=noninteractive`, `NEEDRESTART_MODE=a`
(needrestart restarts services as unattended-upgrades would),
`APT_LISTCHANGES_FRONTEND=none`, `UCF_FORCE_CONFFOLD=1`, `LC_ALL=C`,
`ZYPP_LOCK_TIMEOUT=120`, `PATH` with the sbin directories, `HOME=/root`,
`TERM=dumb`; stdin closed, its own process group.

**How it runs.** The agent writes the task's spec to
`<state_dir>/packages/pkg-<hex>/task.json` and starts `whombat-agent
package-task --dir <that directory>`:

- under systemd (`/run/systemd/system` and `systemd-run`, also for an agent
  started by hand) as a transient unit `whombat-pkg-<hex>.service`:
  `systemd-run --quiet --collect --service-type=exec --unit=…
  --property=KillMode=mixed --property=TimeoutStopSec=15s` (an install:
  `600s`) `--property=RuntimeMaxSec=` the limit plus 5 minutes
  `--working-directory=/`. Not `--wait` or `--pipe`: the unit is outside
  the agent's sandbox (the agent unit's `ProtectSystem=strict` keeps `/`
  read-only) and outlives the agent;
- without systemd in its own session (`setsid`, stdin/stdout/stderr
  `/dev/null`), the pid in `task.json`.

The runner appends every command line (`$ …`) and its output to `log`,
and writes `result.json` (atomically, once) last: `{status: ok|failed,
message, code?, installed?, kept_back?, warning?, waiting?, finished}`. An
agent that restarts finds a running task (the unit is active, or the pid
is still `package-task` of that directory) and follows it; a task whose
runner is gone without a result (the server restarted, the unit was
killed) gets a failed result from the agent: “The server may have
restarted while it ran.” One package task at a time. A check stops on
`task.stop` (`systemctl stop` of the unit, or SIGTERM: the runner stops
its command group and ends “Checking for updates was stopped.”); an
install doesn't (`not_allowed` “Installing updates can’t be stopped once
it started.”; a SIGTERM to its runner is logged and ignored, dpkg must not
stop halfway). Limits: a check 10 minutes, an install 2 hours, counted
from the task's start; past it the command group gets SIGTERM, SIGKILL 30
s later, and the task fails with code `timeout` (“Installing updates took
longer than 2 hours and was stopped.”).

**The package lock** (SWU-04). Before each command the runner checks
whether another program holds the manager's lock — apt: an fcntl lock on
`/var/lib/dpkg/lock-frontend`, `/var/lib/dpkg/lock`,
`/var/lib/apt/lists/lock`, `/var/cache/apt/archives/lock`; dnf/yum/zypper:
`/var/lib/rpm/.rpm.lock` and the pid files `/run/dnf.*.lock`,
`/var/run/yum.pid`, `/run/zypp.pid`; apk: a flock on `/lib/apk/db/lock`;
pacman: `/var/lib/pacman/db.lck` — and waits up to 120 s (the log says
“Waiting for another program to finish with the package lock (…)…”).
Still held, or a command that fails with the manager's lock error: the
task fails with code `busy`, “Another program is installing packages on
<host name> right now. Try again in a few minutes.” The managers' own
lock waits (`DPkg::Lock::Timeout`, `ZYPP_LOCK_TIMEOUT`, `apk --wait`)
cover the moment between the check and the command.

**A Proxmox node without a subscription** (SWU-06). When `apt-get update`
fails and every error line names `enterprise.proxmox.com` with a 401
(apt's “Some index files failed to download” aside; apt 3's `Error:`
lines too), the task carries on with the other repositories and the
result's `warning` is “The Proxmox enterprise repository refused (it
needs a subscription); the other repositories were used.” (also on a
check, and when apt only warns). Any other refresh failure stops the task
with apt's own last error line (no warning then); the other managers'
failures stop it with their last line.

**The result.** Installed = the waiting updates (`pkgs.Check` after the
refresh, before the install; named: only those) that no longer wait
afterwards (pacman: its “Packages (N)” line when larger: its cache is
older than what `-Syu` installs). Kept back = those still waiting, plus
what apt says it kept back (“The following packages have been kept
back:”, apt 3's “Not upgrading:”: held packages never count as
waiting), at most 50. Messages: “Installed 23 updates.”, “Installed 1
update.”, “Nothing to install.”; a check “23 updates waiting, 3 for
security.” / “No updates waiting.”; failures the manager's line or the
sentences above.

**Task status** (`task.status` with a `pkg:` id, platform `host` or
empty): type `packages.check` / `packages.install`, user `root`, status
running → ok / error, `cancellable` while a check runs, the log from
`log_start` (500 lines at most, secrets masked like unRAID's), and once
it ended `packages: {installed, kept_back, warning}` and `code` (`busy`,
`timeout`) when it didn't do its work. `task.list` with platform `host`
lists the package tasks of the last day; a task is kept a day after it
ended.

**The report** (`SystemInfo`): `PackageTask` `{id, op: check|install,
started}` while one runs (`pkg_task`), `PackageLast` `{op, status:
ok|failed, finished, installed (install only), msg, code}` after one
ended (`pkg_last`), kept in `<state_dir>/packages/last.json` across agent
restarts (written by the agent when it sees the end, so also for a task
that ended while the agent was down). When a task starts the agent
reports at once; when it ends the agent first records `PackageLast` and
clears `PackageTask`, then runs the updates collector and the reboot
check (the system collector) at once and reports. `UpdatesCheckedAt` is
when an updates check *started*, so a report with `UpdatesCheckedAt` at or
after `PackageLast.Finished` (the same clock) has the counts read after
the task.

**Inspect updates** (SWU-11): `InspectUpdates` needs the diagnose switch
or the console one (the agent's `[remote_control]`; the hub checks its
own the same way); the other inspect views keep needing the console.

**Local check without a hub**: `whombat-agent console-test --platform host
--manage packages.check|packages.install|task.status|task.stop|task.list
[--packages a,b] [--task ID] [--log-start N] [--follow]` runs the same
broker path, and `--package-report` prints the report's two fields.

### 2.10 Backup places

Whombat's `backup-places.md` (BPL-01…BPL-16) decides what this is for;
the agent's side is HS-203…HS-219, HS-240…HS-251 and HS-252…HS-262 (the
kit user) in `docs/decisions/hosts.md`. Code: `internal/agent/broker/backupplace*.go`
(operations, Docker calls, files and the cleanup script, Unraid,
locations and moves), `pve_manage_storage.go` (`storage.add`),
`internal/agent/collect/backupplace.go` (the report), `internal/proto/backupplace.go`.

**Per Whombat** (`client`, `^[a-z0-9][a-z0-9-]{2,62}$`, never `kit`) the server runs:

| Container | Image | What |
|---|---|---|
| `whombat-backup-<client>` | `restic/rest-server@sha256:d2aff06f…14a5` (0.14.0) | `/usr/bin/rest-server --path /data --listen :8000 --append-only --private-repos --htpasswd-file /auth/.htpasswd`; `<root>/<client>` on `/data/<client>`, `<root>/.whombat/<client>.kit` on `/data/kit` (the kit user's repository), the htpasswd read-only, a 1 MB tmpfs on `/data` (the image declares it a volume), host port → 8000, restart `unless-stopped` |
| `whombat-backup-<client>-cleanup` | `restic/restic@sha256:39d9072f…7e76` (0.18.1) | `/bin/sh /state/cleanup.sh <client> <days>`; `<root>/<client>` on `/data/<client>`, `<root>/.whombat` on `/state`, no network, restart `unless-stopped` |

Both carry `whombat.service=backup-place`, `whombat.client`,
`whombat.role` (`server` | `cleanup`), `whombat.port` or
`whombat.keep_days`, and `whombat.config` (a hash of the settings and the
files they depend on: an ensure recreates a container only when it
changed); the REST server `whombat.kit=1` once it has the kit user; on
Unraid also `net.unraid.docker.managed=dockerman`.

**Two users** in the REST server's htpasswd: the client, whose private
repository is `/<client>/`, and the **kit user** `kit` with the
well-known password `whombat-kit` (`proto.PlaceKitUser`,
`PlaceKitPassword`; Whombat core has the same), whose repository `/kit/`
holds the locked copies of the Whombats' backup details (they open only
with the person's passkey, and the server only adds). Each line is kept
while it verifies its password; the file is written only when it changes,
and a change makes the container again: rest-server re-reads the file
only when the file it opened changes (at most every 30 s), and the
single-file bind keeps the one there was at the start while the agent
replaces the file by a rename (HS-254). An ensure gives REST servers from
before the kit user both (HS-253).

**Files** below `<root>`, the client's location (Unraid: the dedicated
share `whombat-backups`, `/mnt/user/whombat-backups`, or the folder
`whombat` of another user share, `/mnt/user/<share>/whombat`; other Linux
servers `/srv/whombat-backups`):
`<client>/` (the repository, 0700), `.whombat/` (0700) with
`<client>.htpasswd` (the two users' bcrypt lines, 0600), `<client>.kit/`
(the kit user's repository, 0700; made by the agent, its `keys/` and the
rest by the kit user's `POST /kit/?create=true`), `<client>.pass`
(the repository password, 0600), `<client>.cleanup.json` (the cleanup's
status, written atomically by the cleanup) and `cleanup.sh`. On Unraid
the agent writes directly (it runs unsandboxed); on systemd hosts writes
go through a transient unit (`systemd-run --pipe … /bin/sh -c <fixed
script> sh <op> <path> <mode|target>`, the content on standard input;
ops mkdir, write, rm, rmtree, copy, rename), since
`ProtectSystem=strict` keeps `/srv` read-only for the agent.

**Locations** (`Report.BackupPlace.Locations`, `proto.PlaceLocations`):
on Unraid the dedicated share first (`id`/`name` `whombat-backups`,
`IsNew` until the share exists; a new one goes on the array, or on a
server without array disks on its first pool by name), then every other
user share of the same report's `Unraid.Shares` except `system` and names
outside `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$` (or with `..`), each with
the share's `FreeBytes`, `SMB`, `NFS` and `Primary` as `shares.ini`,
`sec.ini` and `sec_nfs.ini` say, and `Path` = its data root. On other
servers one location: `srv`, “this server”, `/srv/whombat-backups`. A
client's `Location` is the location its REST server's `/data/<client>`
bind is in (Docker's mounts; no label, so containers from before report
it too), `""` when it is in none Whombat knows.

**Moving** (ensure with another `Location` than the client's): an
existing share must be there (`/mnt/user/<share>`); its settings are left
as they are and only the folder `whombat` (0700, root) is made in it; the
dedicated share is made through emcmd as always. The agent pulls the
images first, refuses (`exists`) when the new root already holds other
backups of the client, and (`platform_error`) when the new root's file
system has less room than the backups and 5 %. Then: stop the cleanup and
the REST server; copy `<old>/<client>` to `<new>/.<client>.moving`
(directly: a Go copy keeping modes, times and, as root, owners, every file
synced; through the transient unit: `cp -a` and `sync`); compare both
trees (every name, kind and file size); copy and compare the client's
`.whombat/<client>.*` files and its kit folder (not `*.tmp`); rename the copy to
`<new>/<client>`; remove both containers and make them again on the new
root (the cleanup first, with its days; then the REST server with the
same port and the copied htpasswd line, which still verifies the
password, its Unraid templates rewritten) and wait until it answers. Only
then are `<old>/<client>` and the old files deleted. A failure before the
containers are replaced drops the copy and starts the old containers
again; after, the new containers are removed, the old ones made again on
the old root (port, htpasswd, days as they were, templates too) and the
copy dropped. The old folder is never touched before the move is done.
An interrupted move's `.moving` folder is removed on the next try, and a
complete identical copy already at `<new>/<client>` is reused. On Unraid
`/mnt/user` spans the shares, so every move is a copy.

**The cleanup script** (`placeCleanupScript`; Alpine's `sh`, `date`,
`sleep`, `sed`, `grep`, `tr`): it reads the next run from the status file
(`next_run_epoch`; missing, unreadable or more than a week out: a week
from now), writes the status, and loops: when due it runs `restic -r
/data/<client> --password-file /state/<client>.pass --no-cache forget
--keep-within <days>d --prune --retry-lock 2h` (never `--keep-last`),
records `last_run_at` (UTC), `last_ok` and `last_error` (restic's last
line without quotes, backslashes or control characters, at most 300
characters), and sets the next run a week on; between runs it sleeps at
most an hour at a time. Each time it wakes it tidies the kit files
(`/state/<client>.kit/keys`, HS-257): of each Whombat's (`appliance` in
the file) it keeps the newest 10 by when the REST server stored them
(`ls -t`) and removes the rest; only regular files named by 64 lower-case
hex, at most 64 KiB, with `"kind":"whombat.kit-envelope/1"` count, and
nothing else there is touched; without the folder there is nothing to do. TERM or INT stops it at once (and restic with
it). Status: `{"keep_within_days", "running", "last_run_at", "last_ok",
"last_error", "next_run_epoch"}`.

**Unraid** (all through `emcmd`, the form posts Unraid's own pages send;
the fields and their source are in HS-205): a missing share is made with
`ShareEdit.page`'s “Add Share” form (on the array, or on the first pool
when the server has no array), then kept off SMB (`SecuritySMB.page`,
`shareExport=-`) and, for the backups share, off NFS
(`SecurityNFS.page`, `shareExportNFS=-`); an NFS share gets
`shareExportNFS=e`, `shareSecurityNFS=private` and its rules
(`changeShareAccessNFS`). The containers get dockerMan user templates
`/boot/config/plugins/dockerMan/templates-user/my-<name>.xml` (Repository
pinned by digest, ExtraParams with restart, entry point, tmpfs and
labels, PostArgs, the port, paths and variables as Config entries) and
lines in `/var/lib/docker/unraid-autostart`, so they show in Unraid's
Docker page and start with the array.

**Operations** (`Platform: "host"`; `storage.add` `"pve"`; the manage
switch on both sides; they answer when done, up to 5 minutes; an ensure
that names a location up to 60 minutes, `proto.ManageBudget`, though the
agent keeps one that doesn't move to 5):

| Op | Request (`Place` / `PVEStorage`) | Answer (`Place`) |
|---|---|---|
| `backup_place.ensure` | `Client`, `RestPassword` (24…72 printable ASCII), `Port` (0 = keep or first free from 8747), `Location` (`""` = where it is, a new client the dedicated root) | `Client`, `Port`, `Addresses`, `Path`, `Created`, `Location`, `Moved`, `Kit` |
| `backup_place.cleanup` | `Client`, `RepositoryPassword` (one line, ≤ 1024), `KeepWithinDays` (0 = 90; 7…3650) | `Set` |
| `backup_place.remove` | `Client`, `DeleteData` (in every root the client has anything in; the kit folder too) | `Removed` |
| `backup_place.nfs` | `Name` (`whombat-…`), `Clients` (1…16 IPv4) | `Export`, `Addresses` |
| `storage.add` | `Storage`, `Type` (`nfs`), `Server`, `Export`, `Content` | — |

Refusals: `invalid_value` with the field; `unsupported` with
`Place.Reason` (`no_docker`, `docker_down`, `array_stopped`, `nfs_off`,
`not_unraid`); `not_found` (a cleanup before the REST server);
`exists` (`storage.add`: the name is another storage's; a move into a
root with other backups of the client); `platform_error`
with one sentence (a failed pull, a container that stopped right after
it started, Unraid refusing a change); `timeout` (the REST server didn't
answer within a minute). `storage.add` runs `pvesh get /storage/<id>` and
`pvesh create /storage --storage=… --type=nfs --server=… --export=…
--content=…` as root outside the sandbox, like backup jobs.

**Report** (`Report.BackupPlace`, every minute, sub-collector
`backup_place`): whether the server can keep backups now (Unraid's array
started, a Docker socket, Docker answering), the root's space (`statfs`
of the root or its nearest existing parent; unknown under `/mnt/user`
while the array is stopped), the private IPv4 addresses, Unraid's NFS
switch, and per client its containers (listed by label), the cleanup's
status file and the data folder's size (a walk, at most every half hour),
its location and `Kit` (its REST server carries `whombat.kit=1`; nil from
agents before the kit user), and the locations. Nothing is pulled or changed. The hub marks the server `self` when it is
the machine the hosts service runs on (one of its network cards' MACs is
the hub's) or one of its guests is.

### 2.11 Docker Compose app updates

Whombat's `app-updates.md` (APU-01…) decides what this is for. The agent
updates containers Docker Compose started, one app at a time (with the
services of its project that run the same image), deploys exactly the
image the person said yes to, and puts the previous image back by itself
when the new one doesn't come up. Code:
`internal/agent/apps` (labels, versions, the runner, the docker CLI),
`internal/agent/broker/app_tasks.go` (tasks, the operation), the runner
command `whombat-agent app-task` (`cmd/whombat-agent/apptask.go`), the
collector's `composeApp` (`collect/docker.go`) and the newer image's
version (`collect/imageupd.go`).

**Which containers.** A Docker guest whose labels name a Compose project
and service (`com.docker.compose.project`, `…service`; not a one-off
`compose run` container) has `Guest.App` (`app`): `{svc, ver, new_ver,
new_dg, cfg_hash, blocked, busy, last}`. `ver` is the image's `org.opencontainers.image.version`
label, else a version-like tag (`16.4`, `v2.3.0`); `new_ver` the newer
image's label when the image check found one (once per new digest: the
manifest, this machine's image in a list, its config blob; one pull on
Docker Hub's count). `new_dg` is that newer image's registry digest
(`sha256:…`), `cfg_hash` the container's `com.docker.compose.config-hash`
label. `blocked` is `pinned` for an image named by digest. A project or
service name that isn't letters, digits, `.`, `_` and `-` starting with a
letter or digit is no app (an image's labels could claim to be Compose's;
a name like `--build` must never reach `compose`).
The project's folder and files are checked when the update runs: the
agent's sandbox hides home folders. A container `docker run` started has
no `app`; neither does any container of an agent older than this, which
is how Whombat tells an old agent (it gets the newer one by itself).

**Operation** `app.update` (`Platform: "host"` or empty; the manage switch
on both sides): `Apps` (`apps`) names up to 10 containers, `HoldMajor`
(`hold_major`) leaves a new major version, or one whose version isn't
known, for a person (every run whose yes didn't cover one). `AppExpect`
(`app_expect`; `[{app, svc, image_id, digest?, cfg_hash?}]`, at most one
per app named) is what the yes was for: the service, the image it ran,
the newer image's digest, the settings' hash. With it the agent updates
an app only while it is so; without it (an older hub) it pulls the tag.
It answers at once with a task `app:<16 hex>`; one app task at a time.
Refused before anything runs: no such container `not_found`, not a Compose
app, pinned, one of Whombat's own services `not_allowed`, not Linux
`unsupported`, a task already running `busy`, an `app_expect` for an app
not named, twice, or with a malformed service, image id, digest or hash
`invalid_value`. An agent older than this
answers `unsupported` “unknown operation”.

**How it runs**: like a package task (2.9): spec in
`<state_dir>/apps/app-<hex>/task.json`, `whombat-agent app-task --dir …`
in a transient unit `whombat-app-<hex>.service` (`TimeoutStopSec=600s`,
`RuntimeMaxSec` 30 minutes per app plus 5, at most 3 hours) or its own
session, `log`, `result.json` last; tasks are kept a day, each container's
last outcome for good (`last.json`). It can't be stopped (`not_allowed`):
an app half updated is worse than a slow update. Per app, in order:

1. Inspect the container: project, service, working folder, config and
   environment files (labels `…project.working_dir`, `…project.config_files`,
   `…project.environment_file`), the image it runs and the reference it
   was created from. Gone, no Compose, a file missing or not absolute,
   pinned: `failed`. Another service or image than its `app_expect`:
   `failed` `changed`.
2. The group: every running container of the project with the same
   reference, image, folder and files (services sharing an image move
   together). With `app_expect`, each one needs its own, else `changed`;
   apps of the group named too are reported with it.
3. `docker compose --project-name … --project-directory … --file …
   --env-file … config --hash=<service>` for each service must equal its
   container's `config-hash` label (and `cfg_hash` when given): anything
   else in the files changed since the yes, `changed`.
4. Tag the running image `<repo>:whombat-previous-<service>` and write
   `progress.json` (the services, the old image id, the reference, the
   tag) before anything moves.
5. `docker pull -- <repo>@<digest>` (the `app_expect` digest; the
   reference itself without one), 20 minutes at most. The same image id:
   `current`.
6. With `HoldMajor`, a new major version (first numbers differ; calendar
   versions, a year first, have none) or a version not known on either
   side: the old image is tagged back (even past the deadline), nothing
   restarts: `held`.
7. Tag the new image as the reference, then `docker compose … up --detach
   --no-deps --pull never --no-build -- <services>` (without `--pull` on
   an older Compose), then watch the services' containers: running for
   30 s, healthy when they have a health check (5 minutes at most);
   exited, dead, two restarts since before the update or unhealthy fails.
8. Works: the backup tag goes, `updated`. Fails: the old image id is
   tagged as the reference again and the same `up` recreates them,
   watched the same way: `rolled_back`; when that fails too, `failed`
   with reason `back_failed` and the backup tag stays for a person.

**When the server stops it part-way** (a restart, the unit killed): the
broker finds the runner gone, no `result.json` and an update in
`progress.json`, and starts the runner again in `whombat-app-<hex>-<n>
.service` (twice at most). It doesn't start new apps: when the services
still run the old image it puts the tag back (`failed` `interrupted`);
when they run the new one it watches them again (restarts counted from
that look) and keeps it (`updated`) or goes back (`rolled_back`); apps
never reached end `failed` `interrupted`. After two tries the task ends
`failed` with the update's app `back_failed`, its backup tag kept.

Commands run with `HOME=/root` (registry sign-ins `docker login` saved),
`docker compose` or else `docker-compose`.

**Task status** (`task.status` with an `app:` id): type `app.update`, the
log, `guest` when one app, and once it ended `apps: [{app, service,
status: updated|current|held|rolled_back|failed, reason?, from?, to?,
message?}]`. Reasons: `gone`, `no_compose`, `no_files`, `pinned`, `pull`,
`no_cli`, `start`, `stopped`, `restarting`, `unhealthy`, `back_failed`,
`docker`, `timeout`, `changed`, `interrupted`.

**The report**: `app.busy` while a task updates the container, `app.last`
`{status, reason, from, to, finished}` after. When a task starts or ends
the agent reads the containers and image checks again and reports at once.

## 3. Hub

- Switch `rc_manage` everywhere the four existing switches are wired
  (store column + migration, `Server`/`ServerState`, PATCH remote_control
  with re-auth to turn on, `GET /servers/{id}/settings` and `/agents`
  (`remote_control.manage`, `agent_policy.manage`), audit
  `remote_control.enabled|disabled`, agent policy change audit,
  `model.Perms` → `manage`, `agent_manage`, `manage_reason` with reasons
  "Managing guests is turned off for this server" / "This host's agent
  does not allow managing guests yet: set manage = true under
  [remote_control] in its agent.toml and reload the agent").
- `remotePrecheck(..., needManage)`; admin-only ops add `requireReauth`.
- Routes, bodies and answers: `docs/REST-API.md` "Manage" (one
  table-driven handler: route → op, role, reauth, confirm, audit). The
  body is decoded into `proto.ManageRequest` (unknown fields refused);
  Op, Platform and GuestID come from the route. Agent codes → HTTP:
  `invalid_value`/`invalid_request` 400 (`field_errors` in the problem),
  `not_allowed`/`remote_control_disabled` 403, `unknown_guest`/`not_found`
  404, `digest_mismatch`/`locked`/`guest_running`/`protected`/`exists`/`busy`
  409, `unsupported` 501, `platform_error` 502, `inventory_unavailable`
  503, `timeout` 504.
- Answers: reads 200 with the JSON of the proto part (`config`,
  `choices`, `{items: [...]}`); changes 200 `{ok, changes, audit_id}` or
  **202** `{ok, task: {id}, new_id, audit_id}` when a task runs; `new_id`
  is the hub guest id (`pve:123`).
### 3.1 Routes

All under `/api/v1/servers/{id}`; `{guestId}` is the hub guest id
(`pve:100`, `incus:web`); host ops take `platform` (body or query,
default `pve` when the host reports PVE, else `incus`; the `/incus/…` routes are Incus). "admin" = admin +
re-authentication. `web/src/api/manage.ts` calls exactly these.

| Method | Path | Op | Role | Body / query |
|---|---|---|---|---|
| GET | `/guests/{guestId}/config` | config.get | operator | |
| PUT | `/guests/{guestId}/config` | config.set | operator | `{digest, set, delete, revert, confirm}` |
| POST | `/guests/{guestId}/disks/{disk}/resize` | disk.resize | operator | `{size}` |
| POST | `/guests/{guestId}/disks/{disk}/move` | disk.move | operator | `{storage, delete_source}` |
| GET | `/manage/choices` | choices | operator | `?platform=` |
| POST | `/guests` | guest.create | admin | `{platform, kind, new_id, name, set, start, image, profiles}` |
| POST | `/guests/{guestId}/clone` | guest.clone | admin | `{new_id, name, full, storage}` |
| POST | `/guests/{guestId}/template` | guest.template | admin | `{confirm: true}` |
| POST | `/guests/{guestId}/migrate` | guest.migrate | admin | `{target, storage, digest, confirm: true}` |
| DELETE | `/guests/{guestId}` | guest.delete | admin | `?confirm_name=&purge=1` |
| GET | `/guests/{guestId}/backups` | backup.list | operator | → `{items}` |
| POST | `/guests/{guestId}/backups` | backup.create | operator | `{storage, mode, compress, notes, protected}` |
| POST | `/backups/restore` | backup.restore | admin | `{platform, volume, new_id \| guest, storage, start, unique, isolate, confirm}` |
| PATCH | `/backups` | backup.update | operator | `{platform, volume, notes, protected}` |
| DELETE | `/backups` | backup.delete | admin | `?platform=&volume=` |
| GET | `/storage/{storage}/content` | content.list | operator | `?platform=&content=` → `{items}` |
| POST | `/storage/{storage}/download` | content.download | admin | `{platform, content, url, filename, checksum, checksum_algorithm}` |
| DELETE | `/storage/content` | content.delete | admin | `?platform=&volume=` |
| GET | `/appliances` | appliance.list | operator | `?platform=` → `{items}` |
| POST | `/storage/{storage}/appliances` | appliance.download | admin | `{platform, template}` |
| GET | `/guests/{guestId}/tasks` | task.list | operator | → `{items}` |
| GET | `/tasks` | task.list | operator | `?platform=` → `{items}` |
| GET | `/tasks/{task}` | task.status | operator | `?platform=&log_start=` → TaskStatus |
| DELETE | `/tasks/{task}` | task.stop | operator | `?platform=` |
| GET | `/guests/{guestId}/firewall` | firewall.get | operator | |
| PUT | `/guests/{guestId}/firewall/options` | firewall.options | operator | `{digest, set, delete}` |
| POST | `/guests/{guestId}/firewall/rules` | firewall.rule_add | operator | `{rule}` |
| PUT | `/guests/{guestId}/firewall/rules/{pos}` | firewall.rule_update | operator | `{digest, rule, move_to}` |
| DELETE | `/guests/{guestId}/firewall/rules/{pos}` | firewall.rule_delete | operator | `?digest=` |
| PUT | `/guests/{guestId}/ha` | ha.set | admin | `{state, max_restart, max_relocate, comment}` |
| DELETE | `/guests/{guestId}/ha` | ha.remove | admin | |
| POST | `/guests/{guestId}/replication` | replication.add | operator | `{target, schedule, rate, comment}` |
| DELETE | `/guests/{guestId}/replication/{job}` | replication.delete | operator | |
| GET | `/backup-jobs` | backupjob.list | operator | → `{items}` |
| POST | `/backup-jobs` | backupjob.create | admin | `{enabled, schedule, storage, node, selection, guests, exclude, pool, mode, compress, keep, notes_template, comment}` → `{ok, id}` |
| PUT | `/backup-jobs/{job}` | backupjob.update | admin | the fields to change (null removes), `digest` → `{ok, changes}` |
| DELETE | `/backup-jobs/{job}` | backupjob.delete | admin | `?confirm=1` |
| POST | `/backup-jobs/{job}/run` | backupjob.run | operator | → 202 task |
| GET | `/guests/{guestId}/log` | log.get | operator | `?lines=` → `{op, file, lines}` (Incus) |
| POST | `/guests/{guestId}/rename` | guest.rename | admin | `{name}` (Incus) |
| POST | `/guests/{guestId}/move` | guest.move | admin | `{pool, project, confirm: true}` (Incus) |
| POST | `/guests/{guestId}/publish` | guest.publish | admin | `{alias, description, snapshot}` (Incus) |
| GET | `/incus/networks/{network}/leases` | network.leases | operator | `?project=` → `{op, items}` |
| GET | `/incus/profiles/{profile}` | profile.get | operator | `?project=` → `{op, profile}` |
| POST | `/incus/profiles` | profile.create | admin | `{name, description, copy_from, project}` |
| PUT | `/incus/profiles/{profile}` | profile.update | admin | `{project, digest, set, delete, devices, description}` → `{changes}` |
| DELETE | `/incus/profiles/{profile}` | profile.delete | admin | `?project=&confirm=1` |
| POST | `/incus/pools/{pool}/volumes` | volume.create | admin | `{name, size, content_type, project, description}` |
| POST | `/incus/pools/{pool}/volumes/{volume}/resize` | volume.resize | operator | `{size, project}` |
| DELETE | `/incus/pools/{pool}/volumes/{volume}` | volume.delete | admin | `?project=&confirm=1` |
| POST | `/incus/images` | image.download | admin | `{alias, type, project, auto_update}` → 202 |
| POST | `/incus/images/{fingerprint}/refresh` | image.refresh | operator | `{project}` → 202 |
| DELETE | `/incus/images/{fingerprint}` | image.delete | admin | `?project=&confirm=1` (confirm optional) |
| POST | `/unraid/array/start` | array.start | admin | |
| POST | `/unraid/array/stop` | array.stop | admin | `{confirm: true}` |
| POST | `/unraid/parity/start` | parity.start | operator | `{correct}` |
| POST | `/unraid/parity/{pause\|resume\|cancel}` | parity.pause / resume / cancel | operator | cancel: `{confirm}` optional |
| POST | `/unraid/disks/{disk}/spin-up`, `…/spin-down` | disk.spin_up / spin_down | operator | `{disk}` = a disk name or `all` |
| POST | `/unraid/mover` | mover.start | operator | |
| POST | `/unraid/plugins/check` | plugin.check | operator | |
| POST | `/unraid/plugins/{plugin}/update` | plugin.update | admin | `{confirm: true}`; `{plugin}` = a `.plg` file or `all` |
| POST | `/unraid/notifications/archive` | notification.archive | operator | `{id}` (omitted: all) → 200 |
| POST | `/unraid/containers/check` | containers.check | operator | |
| POST | `/guests/{guestId}/update` | container.update | admin | `{confirm: true}`; Docker on unRAID |
| PUT | `/guests/{guestId}/autostart` | guest.autostart | operator | `{on}`; Docker on unRAID, libvirt → 200 |
| POST | `/packages/check` | packages.check | operator | `{}` → 202 `pkg:` task |
| POST | `/packages/install` | packages.install | admin | `{packages?, confirm: true}` → 202 `pkg:` task |
| POST | `/backup-place/ensure` | backup_place.ensure | operator | `{client, rest_password, port, location}` → 200 `{client, port, addresses, path, created, location, moved}` |
| PUT | `/backup-place/{client}/cleanup` | backup_place.cleanup | operator | `{repository_password, keep_within_days}` → 200 `{set}` |
| DELETE | `/backup-place/{client}` | backup_place.remove | operator (admin + `confirm` with `delete_data`) | `{delete_data, confirm}` → 200 `{removed}` |
| POST | `/backup-place/nfs` | backup_place.nfs | operator | `{name, clients}` → 200 `{export, addresses}` (Unraid) |
| POST | `/proxmox/storages` | storage.add | operator | `{storage, type, server, export, content}` → 200 `{storage}` (Proxmox VE) |

The Incus fields of the shared routes: `POST /guests` adds `project`,
`pool`, `network`, `cloud_init`; `…/clone` adds `project`,
`instance_only`; `…/backups` adds `name`, `expires_at`, `instance_only`,
`optimized`, `compression` (no `storage`); `POST /backups/restore` adds
`name` (Incus: `guest` names whose backup, no `confirm`, always a new
instance); `DELETE /backups` adds `?guest=`; `GET /manage/choices` adds
`?project=`; `PUT …/config` adds `devices` and `profiles`. They are added
to the table by `internal/hub/manage_incus.go` at start; the Incus-only
routes answer 501 `unsupported` on a server or guest that is not Incus.

`DELETE /guests/{guestId}` shares its path with nothing else; `POST
/guests` with nothing else either (the existing `GET /guests` is the
list). The existing `GET /guests/{guestId}` stays the guest's report
entry. Backup job bodies are not `proto.ManageRequest` JSON: the hub
reads them itself (hub guest ids `pve:101` become vmids, `null` / `""` /
`[]` fill `BackupJobSpec.Clear`) and answers jobs with hub guest ids and
`null` for unset fields (`docs/REST-API.md` "Manage", backup jobs).

- **Task watcher**: for every 202 the hub polls `task.status`
  (LogStart −1) every 2 s (every 10 s while the agent is offline) until
  the task ends or 24 h pass, then writes `manage.finished` and publishes
  SSE `task.finished` `{server, guest, task, op, result: ok|warning|error,
  message, new_id?, code?}` (`new_id` when the task said what it made at its
  end: an image fingerprint for publish and image.download, the guest id
  for an Incus restore; `code` when it ended with one: `task_failed`, a
  package task's `busy` or `timeout`, `not_found`, the hub's own
  `timeout` after 24 h). A package task's `manage.finished` adds
  `installed`, `kept_back` and `warning`. Watchers do not survive a hub
  restart. Package tasks (`pkg:`) are platform `host`; a task route without
  `platform` takes `host` for them (before a libvirt server's default).
- **Guest JSON** (`model.Guest`): `tags`, `pending_changes`,
  `guest_agent`, `oldest_snapshot`, `backup_job`, `ha_state`. `GET
  /guests`: `tag` filter (case-insensitive exact), `tags` facet (tag →
  guests, over the same guests as `counts`).
- **Hints** (`model` hints, routine ones fold per host like the others):
  `guest.no_backup_job` (non-template PVE guest, `backup_job` false),
  `guest.backup_old` (covered, last good backup older than 8 days, or none
  while a job ran since the guest exists), `guest.snapshot_old` (oldest
  snapshot older than 30 days), `guest.pending_changes`,
  `guest.agent_down` (running VM, `guest_agent` not_running),
  `storage.overcommit` (thin storage with provisioned > total).
- **Incus hints** (`rules/incus.go`): `incus.no_snapshots` (running
  instances without a snapshot schedule and without a backup in 30 days,
  created more than a day ago, from agents that report schedules; one
  hint per host, `guests` = their hub ids, link `#guests`),
  `incus.pool_full` (a pool at 85 %, a warning from 95 %, entity
  `incus-pool:<name>`, link `#storage`), `incus.warning` (Incus' own
  warnings, link `#system`; they no longer make a `platform.warnings`).
- `cmd/rackoon-sim`: basalt answers the Incus ops (incus.go) and its
  Incus VM `whombat` has the MAC `10:66:6a:77:68:01`
  (`fakefleet.SelfMAC`): run the hub with `--self-macs` set to it to see
  the self guest.
- `cmd/rackoon-sim`: every apt host answers `packages.check` and
  `packages.install` (packages.go): a task whose apt log grows with the
  clock (a check 6 s, an install 20 s), the counts going down after an
  install (named: those only), `granite` needing a restart afterwards,
  `shale`'s enterprise repository refusing (the SWU-06 warning), blackbox
  refusing (Unraid); inspect updates lists as many as the report counts.
- `cmd/rackoon-sim`: the Proxmox node `shale` answers manage ops from an
  in-memory configuration (config.get/set with digests and pending for
  running guests, disks, choices, create/clone/delete, backups, content,
  appliances, simulated tasks with log lines, firewall, two backup jobs
  with coverage recomputed after each change); `--allow-manage`.

## 4. UI

"Less is more": no new top-level navigation. New things live on the
guest page, the host's Guests and Storage tabs and Settings › Agents.

- **Guest page** `/servers/:id/guests/:guestId` (`features/guest`), tabs
  in `?tab=` (`features/guest/tabs.ts`): Summary for every guest; Proxmox
  VE: Hardware (VM) / Resources (CT), Options, Cloud-Init (VMs with a
  cloud-init drive), Snapshots, Backups, Firewall, Replication (cluster),
  Tasks; Incus: Configuration, Snapshots; libvirt: Snapshots. Tabs that
  need Manage show only with `rc.manage`; Summary then says why it is
  missing (`manage_reason`, with a link to the agent settings for admins).
  Guest names in every guest table and the Guests page link here (the
  console button stays where it is).
- **Header**: host link, name, state, platform/kind, VMID and node, tags,
  Console button, the power menu (same items as the row menu) and the
  lifecycle menu (Clone…, Back up now…, Convert to template…, Delete…).
- **Editing**: each section row has Edit (and Add for disks, network
  devices, CD/DVD, EFI disk, TPM, mount points). Dialogs use typed fields
  (memory in MiB with a GiB hint, cores, sockets, CPU type from choices,
  bridge from choices, VLAN, disk storage + size, ISO from choices), then a
  **review step** listing `key: old → new` before Apply. The digest from
  the loaded config goes with every change; 409 `digest_mismatch` reloads
  and says "Changed meanwhile — review again". Running guests: values that
  wait for a restart show "→ new (after restart)", with a banner "N
  changes apply at the next restart" + Revert (per key and all). Disk
  rows: Resize (grow only), Move storage, Detach (→ unused), Delete
  (unused only, confirm). Restricted keys show read-only with a lock and
  "Change this in Proxmox". Unknown sub-options are preserved (property
  string round trip, `features/guest/props.ts`).
- **Create**: host Guests tab → "Create" menu (admins, Manage on): VM /
  container (PVE), instance (Incus). One dialog with sections (General,
  OS/template, Disk, CPU, Memory, Network, Advanced collapsed), defaults
  as PVE's wizard (virtio-scsi-single, x86-64-v2-AES, q35 with OVMF when
  chosen + EFI disk, virtio NIC on the first bridge, guest agent on,
  container: unprivileged, nesting on, IPv4 DHCP). Templates of the host
  list under the guest table ("Templates (n)", collapsed) with Clone… and
  Delete….
- **Backups tab**: Back up now (storage, mode, compression unless PBS,
  notes, protected) and the list (date, storage, size, verified, protected,
  notes) with Restore… (over this guest or as a new one), protect, notes,
  Delete.
- **Storage tab** (PVE): storages with `iso` / `vztmpl` / `import`
  content get "Contents…": list with Delete, "Download from URL" (when
  `choices.download`), "Get templates" (Proxmox's appliance list).
- **Tasks**: every 202 starts a toast "… started — Show progress"; a task
  dialog follows `GET …/tasks/{id}?log_start=` every 1.5 s (log appended,
  Stop for running tasks); `task.finished` events toast the outcome and
  invalidate guests, the server and `manageKeys.server`. Tasks tab: the
  guest's task list; a row opens the same dialog.
- **Firewall tab**: enable + policies + options, rules table (add, edit,
  delete, move up/down), a note when the datacenter firewall is off.
- **HA** (cluster, admins): Options row with state and Edit/Remove.
  **Replication tab** (cluster): jobs with add/delete.
- **Tags**: chips in guest rows and on the guest page; Guests page filter
  `?tag=` with the tags facet; editing in Options.
- **Bulk actions**: Guests page and host Guests tab get row checkboxes
  (users with power on at least one listed host) and a bar "N selected:
  Start · Shut down · Reboot · Stop… · Clear"; actions run through
  `runPowerAction`, 3 at a time, confirming disruptive ones with the
  names; one summary toast.
- **Settings › Agents › server**: the Manage switch (done).
- Every text through `t()` / `tx()` / `tn()` with Dutch in
  `locales/nl-manage.ts` / `locales/nl-lifecycle.ts`.
- Fixture server (`web/dev/fixtures`): the endpoints above with in-memory
  state for `shale` (PVE) and one Incus host; Playwright tests for the
  flows (edit with review and pending, create, clone, backup + restore,
  download, task dialog, firewall rule, bulk start) at 1440 and 390 px
  with axe scans.

## 5. Not covered

Migration across clusters or standalone nodes (`guest.migrate` works
within a cluster only; the Proxmox servers it was tried on are standalone, so it is tested
against fakes and the simulator), uploads from the browser (download from a URL instead), PVE users
and permissions, SDN, node network configuration, Ceph, PBS's own API
(verification state comes through PVE). libvirt (IU-10): QEMU started by
hand without libvirt (watch only), migration between hosts, editing
PCI/USB passthrough and graphics, external (disk-only) snapshots,
creating libvirt networks and pools, editing the raw XML. Incus (IU-10):
clusters (members, evacuate, moving between members), network and project
editing, creating storage pools, volume snapshots, downloading a backup to
the browser, scheduled backups (snapshot schedules cover it), `incus
rebuild`. Operating-system updates (SWU-15): updates on a schedule as a
setting, a cluster one node at a time as one action, unattended-upgrades
configuration, release upgrades (`do-release-upgrade`, `pve8to9`), held
packages, changing repositories, a restart afterwards (the host's own
restart action does that).
