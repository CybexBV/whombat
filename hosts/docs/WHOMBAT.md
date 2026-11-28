# Whombat ↔ hosts service

This is the contract between the Whombat server and its **hosts service**
(`whombat-hosts`, formerly the Rackoon hub) as built on branch
`one-headless` (2026-10-17, decisions in `docs/decisions/hosts.md`,
product decisions ONE-11…ONE-15 in Whombat's
`docs/decisions/one-whombat.md`). The hosts service runs **headless**
inside the Whombat appliance: no web UI, no users of its own. The Whombat
server owns accounts, permissions, approvals and every screen; it talks to
the hosts service over a local Unix socket with one service token and says
whom it acts for in a header.

Where a route is unchanged from Rackoon, its request and response shapes
are in `docs/REST-API.md` (the section is named); this file lists what
Whombat calls, what is different headless, and what is new. Agent ↔ hub
wire details: `docs/AGENT-PROTOCOL.md`. Guest management:
`docs/MANAGE.md`.

```
browser ─HTTPS─▶ Whombat server ─HTTP over unix:/run/whombat-hosts/api.sock─▶ whombat-hosts ◀─WSS+mTLS :8443─ whombat-agent
                 (accounts, keys,      Authorization: Bearer <service token>      (SQLite, CA,        (one per server)
                  approvals, UI)        X-Whombat-Actor: <id>|<name>                alerts, consoles)
```

## 1. Running it

```sh
whombat-hosts serve --headless \
  --data /persist/hosts \
  --listen unix:/run/whombat-hosts/api.sock \
  --agent-listen :8443 \
  --agent-url auto \
  --agent-dist <package>/share/whombat-hosts/agent \
  --service-token-file /persist/hosts/service-token
```

| Flag | Environment | Meaning |
|---|---|---|
| `--headless` | `WHOMBAT_HOSTS_HEADLESS` | Data routes only (§3). No web UI, sign-in, users, passkeys, single sign-on, kiosk links, API tokens, notification channels or assistant (no routes, no job, no runner process); no setup URL is printed. Needs `--service-token-file`; refuses `--oidc-*`. |
| `--listen unix:/path` | `WHOMBAT_HOSTS_LISTEN` | The API on a Unix socket (absolute path; the directory must exist). A socket file left by an earlier run is replaced; one another process still serves is refused. `host:port` still works (a warning when headless and not loopback). |
| `--socket-mode 0660` | `WHOMBAT_HOSTS_SOCKET_MODE` | The socket's file mode (octal, default `0660`): the hub's group may connect. |
| `--service-token-file PATH` | `WHOMBAT_HOSTS_SERVICE_TOKEN_FILE` | The service token (§2). Created on start when missing: `wbh_` + 43 random characters, mode `0640`, owner the hub's user and group. The hub keeps only its SHA-256. Also accepted when not headless. |
| `--agent-listen :8443` | `WHOMBAT_HOSTS_AGENT_LISTEN` | The agents' TLS listener (unchanged), now also serving `install.sh`, the agent downloads and heartbeat pings (§6). |
| `--agent-url auto` | `WHOMBAT_HOSTS_AGENT_URL` | `wss://<IPv4 of the default route's interface>:<agent port>` (`/proc/self/net/route`, else `/proc/net/route`; lowest metric, private addresses first; falls back to the source address of a UDP "connect" to 192.0.2.1). Looked up when used, at most every 30 s, so a new DHCP lease shows within a minute. `wss://host:port` sets it by hand. |
| `--agent-dist DIR` | `WHOMBAT_HOSTS_AGENT_DIST` | `whombat-agent-linux-amd64` and `whombat-agent-linux-arm64` for `install.sh`; `manifest.json` (from `rackoon-sign`) only for signed builds. Without a manifest, agent self-update is off ("The hub has no signed agent build"). |
| `--data DIR` | `WHOMBAT_HOSTS_DATA` | Database, CA, the agent listener's certificate, `hub.lock`. Default `/var/lib/whombat-hosts`. |
| `--self-macs a,b` | `WHOMBAT_HOSTS_SELF_MACS` | The MACs of the machine the hosts service runs on (comma list). Empty (default): read from `/sys/class/net/*/address` at start and every 10 minutes (`lo` and all-zero ones left out). The guest with one of them is the Whombat itself (`self`, §3 "Managing guests"). For tests and the simulator (`10:66:6a:77:68:01` is basalt's `whombat`). |

`RACKOON_*` variables are still read when the `WHOMBAT_HOSTS_*` one is
absent. Logs go to stderr (`--log-format json` available). `GET /healthz`
answers `ok` on the socket and on the agent listener.

Build: `CGO_ENABLED=0 go build ./cmd/whombat-hosts` (no `embedweb` tag:
headless needs no UI) and `CGO_ENABLED=0 GOOS=linux GOARCH=amd64|arm64 go
build -ldflags "-X main.version=<v>" -o whombat-agent-linux-<arch>
./cmd/whombat-agent` (`make headless`, `make agents-unsigned`). Signed
agents add `-X rackoon/internal/agent.UpdatePublicKey=<base64>`; the Go
module path is still `rackoon`. Go 1.27.1 or newer.

## 2. Authentication and headers

Every request under `/api/v1` needs:

| Header | |
|---|---|
| `Authorization: Bearer <token>` | The contents of the service token file (trimmed). Anything else is 401 `unauthenticated`. Headless, session cookies and `rk_` API tokens are not accepted at all. |
| `X-Whombat-Actor: <id>\|<display name>` | Whom the request is for: a person, or Whombat acting for one. The id is 1 to 128 of `A–Z a–z 0–9 . _ : @ -` (400 `bad_actor` otherwise); the name is optional, printable, at most 128 bytes, whitespace collapsed. Absent: `whombat\|Whombat`. |
| `X-Whombat-Role: viewer\|operator\|admin` | Optional; lowers the role for this request (default **admin**, never higher). Anything else is 400 `bad_role`. |
| `X-Whombat-Client-IP: <ip>` | Optional; the person's address, recorded in the audit log and used for per-address limits. |

- The actor becomes the hub's user name everywhere it records one: the
  audit log (`user`), `acknowledged.by`, `created_by` of maintenance windows,
  checks and enrollments, `GET /console-sessions` `user`. Format:
  **`<display name> (<id>)`**, or `<id>` without a name (`John Doe
  (pe_8f2c)`, `Whombat (ag_31)`). Per-person limits key on the id: 5 open
  consoles, 16 event streams, the refusal throttle, thumbnails.
- The service principal is an admin without a user row. Role checks below
  use the header's role; re-authentication (`reauth_required`) never
  applies to it, so Whombat must ask the person itself (approvals) before
  it calls an admin route.
- No CSRF token is needed, and the `Origin` check is skipped (a bearer
  token is not ambient). Whombat checks its own browsers' origins.
- Requests over the Unix socket count as a secure transport, so consoles
  work without `--insecure-consoles`.
- **Rotation**: write a new token into the file (atomically: write a temp
  file, rename). The hub re-reads it within 2 seconds; the old token then
  gets 401, and live consoles and event streams opened with it end
  (`closed`, reason `revoked`). A deleted or malformed file refuses every
  request until it holds a token again (logged once); the hub creates a
  token only at start. Whombat should re-read the file when it gets a 401.
- Errors are `application/problem+json`: `{"code", "detail", "status",
  "title", "type"}` (+ `field_errors` for manage requests). Show or relay
  `detail` (plain English); branch on `code`. Common codes:
  `docs/REST-API.md` "Errors".

## 3. Routes Whombat calls

All paths under `/api/v1`. **Role** is what the request's role must be
(from `X-Whombat-Role`); the hosts service checks the per-server switches
on top (both the hub's switch and the agent's `agent.toml`). Whombat decides
which role it sends: a Whombat is one person's, so what the person changes
goes with the role the change needs, and Whombat's own reads as `viewer`.

### Status (`hosts.status`)

| Call | Route | Role |
|---|---|---|
| liveness | `GET /healthz` (plain `ok`, 503 `unhealthy: …`) | none |
| status | `GET /api/v1/hub` | admin |
| move the agents | `POST /api/v1/hub/agents/move` `{url}` → `{asked, already}` | admin |

`GET /hub` (headless additions marked +):

```json
{"version": "dev", "schema": 13, "started_at": "…", "uptime_s": 9, "go": "go1.27.2",
 "database_bytes": 253952, "database_free_bytes": 0, "servers": 8, "agents_connected": 8, "consoles_open": 0,
 "public_url": "", "agent_url": "wss://10.100.1.158:8443",
 "agent_url_previous": "wss://10.100.1.160:8443", "agent_url_changed_at": "2026-10-21T08:02:11Z",
 "restored_at": null, "restore_error": null,
 "headless": true, "ca_sha256": "e57c…", "tls_pin": "sha256//15ug…=", "agents_url": "wss://10.100.1.5:8443",
 "reconnecting": null}
```

`agents_url` (+) is the agents' URL as resolved now (auto: the LAN
address), `ca_sha256` (+) the CA pin agents enroll with, `tls_pin` (+) the
agent listener's key in curl's `--pinnedpubkey` form. `agent_url` is the
agents' address the hub tells its agents first (as `agents_url` without a
request), `agent_url_previous` / `agent_url_changed_at` the address before
the last change and when (null: none; Whombat BF-16), `restored_at` when a
backup was restored into this hub (null: never), `restore_error` the last
staged backup that could not be applied (`{at, code, message}`, else
null). `reconnecting` is null, or `{since, until, reason, waiting}` while
the hub holds its servers' “isn't checking in” alerts because the problem
is the box itself (`reason`: `address_changed`, `many_dropped`, `move`;
`waiting`: servers it covers that aren't back yet; Whombat's NM-06).

Moving the servers to another of the box's addresses (Whombat NM-05):
`POST /hub/agents/move` `{"url": "wss://10.100.1.97:8443"}`, `url` one of
the hub's own addresses now (else 400 `bad_request`), asks every connected
agent not already there to connect there (`hub_move`) and opens a
`reconnecting` hold (`move`); `200 {"asked", "already"}`. Each item of
`GET /agents` and `GET /fleet`'s `servers` carries `via`, the hub's IP the
agent's connection arrived at (absent when not connected): “4 of 6 servers
found Home's new address” counts the connected servers whose `via` is the
new address. REST-API "Hub".

### Fleet, servers, guests, history

Shapes: `docs/REST-API.md` "Fleet and servers" and "Guests". All viewer.

| Whombat op | Route |
|---|---|
| `hosts.fleet` | `GET /fleet?range=` (hosts table, KPIs, open alerts, hints); `GET /fleet/series?range=24h` for the per-server sparklines (`servers.<id>.cpu_pct`: 60 points over the range, `null` for gaps; average pairs down to ≤ 48 for `cpu24h`) |
| `hosts.servers.get` | `GET /servers/{id}?range=` (detail: facts, storages, disks/SMART, sensors, health, updates, Proxmox cluster/storages/backups, virtualization, hints, `server.remote_control`; a Mac's `macos` block, `detail_view` `macos`, `os_family`; a Windows PC's `windows` block, `detail_view` and `os_family` `windows`) |
| `hosts.servers.metrics` | `GET /servers/{id}/metrics?range=&series=` (or `from`/`to`); chart markers `GET /servers/{id}/annotations?range=` |
| `hosts.guests.list` | `GET /servers/{id}/guests?platform=&kind=&q=&sort=&limit=&cursor=`; fleet-wide `GET /guests?q=&state=&platform=&server=&tag=` |
| `hosts.guests.get` | `GET /servers/{id}/guests/{guestId}` (`guestId` = `pve:101`, `incus:web`, `docker:pihole`, `libvirt:win11`) |
| `hosts.guests.metrics` | `GET /servers/{id}/guests/{guestId}/metrics?range=` |
| groups | `GET /groups` |

### Changing servers (admin)

| Whombat op | Route | Notes |
|---|---|---|
| `hosts.servers.update` | `PATCH /servers/{id}` `{group?, location?, parent?, remote_control?: {console, power, host_shell, host_power, manage, diagnose}}` | REST-API "Fleet and servers"; the switches need the agent's flag too. Settings: `GET /servers/{id}/settings`. |
| `hosts.servers.remove` | `DELETE /servers/{id}` | Revokes the certificate, closes consoles. |
| agents | `GET /agents` | Version, policy, update availability per server (`update`, below). |

### Agent updates (`hosts.agentSettings`, `hosts.updateAgentSettings`, `hosts.updateAgent`)

The hub keeps the agents on its signed build by itself (Whombat
`agent-updates.md` AU-01…AU-10; HS-140…HS-169; REST-API "Agent updates"):
at start (after a 2-minute grace), a minute after an older agent connected,
and every 15 minutes, one server at a time, never while it installs
packages, has a console or shell open, or runs a libvirt or unRAID task.

| Whombat op | Route | Notes |
|---|---|---|
| `hosts.agentSettings` | `GET /agents/settings` → `{auto_update, halted_version}` | `halted: halted_version != null` |
| `hosts.updateAgentSettings` | `PATCH /agents/settings` `{auto_update}` → the same | audited `agent.settings_changed` |
| `hosts.updateAgent` | `POST /agents/update` `{servers: [id]}` → 202 `{servers, installing, version}` | `installing` lists the servers that get the last install (contracts `state: installing`), the others `updating`. Clears the server's failed mark and the halt (Try again). The service token needs no re-authentication. 409 `needs_install` (keyless, the hub can't install it: show the install command), `nothing_to_update`, `update_running`, `no_build`. |

`GET /agents`' `update` per server (snake_case of contracts'
`HostAgentUpdate`): `available`, `version` (the build), `reason` (English),
`reason_code` (`no_build`, `not_connected`, `up_to_date`, `no_key`,
`other_key`, `turned_off`, `newer_running`), `auto`, `state` (`updating`,
`failed`, `waiting`, `halted`), `waiting_for` (`packages`, `console`,
`task`), `message`, `failed_version`, `updated_at`, `can_install`.
Strings are left out when empty; `auto` and `can_install` are always
there.

The last install (`can_install`: no key, connected, a service install, and
the host shell on both sides) runs the System tab's update command as root
through exec, detached (`systemd-run --unit=whombat-agent-reinstall-<n>`, or
`setsid` without systemd; never on a Mac, whose agents carry the key from
their first install), so the agent's restart doesn't end it; then the
hub waits for the agent to come back with the build's version and key. It
never carries `--token`, `--control` or `--force`: identity and the
server's own switches stay. It works with agents of 5394c53 (their exec is
the same). The round never does it.

**Whombat Helper follows the same way** (HS-360…): on a Mac whose agent
reports the `helper_update` capability, the round (and Update now, after
the agent's own update, also for a Mac whose agent gains the capability by
it) sends the hub's helper when the Mac has none or an older one; never to
an agent without the capability, never beside the agent's own update, and
only while the agent's updates and the host shell are allowed on both
sides. Same setting (`auto_update`), one server at a time; its own audit
(`agent.helper_updated`, `agent.helper_update_halted`), its own event
(`agent.helper_update`, the states of `agent.update`), its own failed marks
and halt (a helper that didn't answer at the screen halts the helper's
updates). What Whombat reads:

- `GET /agents`: each Mac's row has `helper` (`null` for other servers):
  `available`, `version` (the hub's helper), `installed` (the Mac's),
  `reason`, `reason_code` (`no_build`, `not_connected`, `up_to_date`,
  `unsupported` (the agent can't take it yet), `no_key`, `other_key`,
  `turned_off`, `host_shell_off`, `newer_running`), `auto`, `state`
  (`updating`, `failed`, `waiting`, `halted`), `waiting_for` (`agent`,
  `packages`, `console`, `task`), `message`, `failed_version`,
  `updated_at`.
- `GET /agents/settings` adds `helper_version` (the hub's helper, `null`
  without one) and `helper_halted_version`.
- `GET /servers/{id}`: `macos.helper.latest` (the hub's version) and
  `macos.helper.update` (the object above) beside the Mac's own
  `macos.helper.version`.
- `POST /agents/update` answers 202 `{servers, installing, version,
  helpers, helper_version}`: `helpers` lists the Macs whose helper is sent.

### Guest power and snapshots (`hosts.guests.action`)

`POST /servers/{id}/guests/{guestId}/actions {action, confirm?, snapshot?,
description?, memory?}` → 202 `{action_id, audit_id}`; the outcome comes as
the `action.finished` event. Operator, power switch (`ctrl_alt_del`:
console). `confirm: true` for `force_stop`, `stop`, `reboot`, `shutdown`,
`restart`, `snapshot_restore`, `snapshot_delete`. Snapshots: `GET
…/guests/{guestId}/snapshots` (operator, the power **or** the manage
switch; 403 `power_disabled` otherwise — it no longer needs the console). Host power: `POST /servers/{id}/actions
{action: host_reboot|host_shutdown, confirm: true}` (admin, host power
switches). REST-API "Console and actions", "Inspect, snapshots and host
actions".

### Managing guests (`hosts.manage`, `hosts.tasks.get`)

Whombat's `hosts.manage {op, guestId?, params, digest?, confirm?,
confirmName?}` maps `op` to one route of `docs/MANAGE.md` §3.1 (body or
query as listed there; `digest` and `confirm` go in the body,
`confirmName` is the `confirm_name` query of `guest.delete`). Reads answer
200 with the part; changes 200 `{ok, changes, audit_id}` or **202 `{ok,
task: {id}, new_id?, audit_id}`** when the platform runs a task, which the
hub follows (`task.finished` event). `hosts.tasks.get` = `GET
/servers/{id}/tasks/{task}?log_start=` (operator). Operators edit
configuration, disks, firewall, backups and replication; admins create,
clone, template, delete, restore, migrate, download, delete content and
change HA. A digest that no longer matches answers 409 `digest_mismatch`
("Changed meanwhile — review again"). Field problems: 400 `invalid_value`
with `field_errors`.

New: **`guest.migrate`** (Proxmox VE, within a cluster):

```
POST /servers/{id}/guests/{guestId}/migrate
{"target": "pve-02", "storage": "local-zfs", "digest": "<from config.get>", "confirm": true}
→ 202 {"ok": true, "task": {"id": "UPID:pve-01:…:qmigrate:101:whombat-manage@pve!agent-pve-01:"}, "audit_id": "au_…"}
```

Admin, Manage switch, `confirm: true` required (400 `confirm_required`).
`target` is another node of the guest's cluster (400 `invalid_value`
otherwise; 501 `unsupported` on a standalone node or for Incus); `storage`
(optional) the target storage; `digest` (optional) must still match.
Running VMs move live with their local disks, running containers with a
restart (shut down within 180 s, started on the target), stopped guests
offline. The agent's manage token needs `VM.Migrate` (its role
`WhombatManage` has it). After the task the guest is in the target node's
report (if that node has an agent), with the same guest id. HA-managed
guests may be refused by Proxmox (HA needs root-level rights).

New: **Unraid** (IU-05; `docs/MANAGE.md` 2.6, `docs/REST-API.md`
"Manage", Unraid): `hosts.manage` ops `array.start`, `array.stop`,
`parity.start`, `parity.pause`, `parity.resume`, `parity.cancel`,
`disk.spin_up`, `disk.spin_down`, `mover.start`, `plugin.check`,
`plugin.update`, `notification.archive`, `containers.check` (routes under
`/servers/{id}/unraid/…`) and the guest ops `container.update` (`POST
…/guests/{guestId}/update`) and `guest.autostart` (`PUT
…/guests/{guestId}/autostart {on}`). Commands answer 202 with a task
`unraid:<16 hex>` (`hosts.tasks.get` with `?platform=unraid`), archiving
and autostart 200. The server detail has `detail_view` `unraid` and the
`unraid` block (`docs/CONTRACT.md` "Unraid").

New: **libvirt / QEMU/KVM** (IU-13; `docs/MANAGE.md` 2.8,
`docs/REST-API.md` "Manage", libvirt): the shared `hosts.manage` ops with
`platform: libvirt` on every host that runs libvirt (configuration with
Proxmox-like keys, disks, CD/DVD, network cards, create with OS types,
clone, rename, delete, backups, volumes, ISO images, leases, the QEMU
log), new routes under `/servers/{id}/libvirt/…` (every VM's backups,
pool volumes, network leases) and the guest routes `rename` and `log`;
long work answers a task `libvirt:<16 hex>`. The server detail has
`detail_view` `libvirt` (after `proxmox`, `unraid`, `incus`) and, on every
host with libvirt, the `libvirt` block (`docs/CONTRACT.md` "libvirt").

New: **operating-system updates** (Whombat SWU-01…SWU-15; `docs/MANAGE.md`
2.9, `docs/REST-API.md` "Manage", Operating-system updates): `hosts.manage`
ops `packages.check` (`POST /servers/{id}/packages/check {}`, operator) and
`packages.install` (`POST …/packages/install {packages?, confirm: true}`,
admin), both 202 with a task `pkg:<16 hex>` (`hosts.tasks.get` with
`?platform=host`; its status adds `packages: {installed, kept_back,
warning}` and `code` once ended; `DELETE` stops a check). `task.finished`
carries `code` (`busy`, `timeout`) when the task ended with one. The server
detail's `system` has `package_task` and `package_last`. An agent older
than this answers 501 `unsupported` “unknown operation”.

New: **Docker Compose app updates** (Whombat `app-updates.md`;
`docs/MANAGE.md` 2.11, `docs/REST-API.md` "Manage", Docker Compose app
updates): `hosts.manage` op `app.update` (`POST /servers/{id}/apps/update
{apps: ["docker:<name>"…], hold_major?, expect?: [{app, service,
image_id, digest?, config_hash?}], confirm: true}`, admin), 202 with a
task `app:<16 hex>` (`hosts.tasks.get` with `?platform=host`; its status
adds `apps: [{app, service, status, reason, from, to, message}]` once
ended). `task.finished` names the guest when one app was updated. A Docker
guest Compose started has `app: {service, version, new_version,
new_digest, config_hash, blocked, updating, last: {status, reason, from,
to, at}}`; a server whose agent is
older answers 409 `agent_outdated`.

New: **backup jobs** (Proxmox VE's scheduled backups, PX-03). Manage
switch; 501 `unsupported` on a server without Proxmox VE.

| Whombat op (`hosts.manage`) | Route | Role |
|---|---|---|
| `backupjob.list` | `GET /servers/{id}/backup-jobs` → `{items: [job]}` | operator |
| `backupjob.create` | `POST /servers/{id}/backup-jobs {job}` → 200 `{ok, id, audit_id}` | admin |
| `backupjob.update` | `PUT /servers/{id}/backup-jobs/{jobId} {fields to change, digest?}` → 200 `{ok, changes, audit_id}` | admin |
| `backupjob.delete` | `DELETE /servers/{id}/backup-jobs/{jobId}?confirm=1` → 200 `{ok, audit_id}` | admin |
| `backupjob.run` | `POST /servers/{id}/backup-jobs/{jobId}/run` → 202 `{ok, task: {id}, audit_id}` | operator |

A job: `{id, enabled, schedule, storage, node, selection: all|guests|pool,
guests, exclude, pool, mode, compress, keep, notes_template, comment,
next_run, digest}` (snake_case; `guests` / `exclude` are hub guest ids
`pve:101`, `[]` when the selection is another; `node`, `pool`,
`compress`, `keep`, `notes_template`, `comment`, `next_run` are `null`
when not set; `keep: {last, hourly, daily, weekly, monthly, yearly}`,
every count 0 = keep every backup, `null` = the storage's retention).
Whombat's `params` map 1:1 (`jobId` → the path, `notesTemplate` →
`notes_template`, `nextRun` ← `next_run`, `digest` from the list); for
`backupjob.delete`, `confirm: true` is the query `confirm=1`. An
update sends only what changes; `null` removes `node`, `compress`,
`keep`, `notesTemplate`, `comment` or `exclude`. "Add to a backup job" is
an update: append the guest to `guests` (selection guests) or drop it
from `exclude` (selection all), with the job's `digest`. Codes: 400
`invalid_value` with `field_errors` (`schedule`, `storage`, `guests`,
`exclude`, `node`, `pool`, `keep`, …), 400 `confirm_required` (delete
without `confirm=1`), 404 `not_found` (unknown job), 409
`digest_mismatch` (changed in Proxmox meanwhile: reload the list), 409
`locked`, 409 `exists`, 403 `not_allowed` (run: the job has no storage),
501 `unsupported` (run: a job of another node, or none of its guests on
this server; not Proxmox VE). `run` is followed like every task
(`task.finished` with `op: backupjob.run`, `guest: null`); a job with its
own `keep` runs without pruning (the next scheduled run prunes). After a
job change the guests' `backup_job` (and the `guest.no_backup_job` hint)
follow within one report (about 10 seconds).

New: **Incus** (IU-04, `docs/MANAGE.md` 2.5, REST-API "Manage"). Whombat's
`hosts.manage` ops map 1:1 to these routes (params snake_case as usual:
`cloud_init`, `instance_only`, `expires_at`, `copy_from`, `content_type`,
`auto_update`, `pool`, `project`, `network`):

| Op | Route | Role |
|---|---|---|
| `log.get` | `GET …/guests/{guestId}/log?lines=` → `{op, file, lines}` | operator |
| `guest.rename` | `POST …/guests/{guestId}/rename {name}` → 200/202 `new_id` | admin |
| `guest.move` | `POST …/guests/{guestId}/move {pool?, project?, confirm: true}` → 202 `new_id` | admin |
| `guest.publish` | `POST …/guests/{guestId}/publish {alias?, description?, snapshot?}` → 202 (fingerprint as `task.finished.new_id`) | admin |
| `network.leases` | `GET …/incus/networks/{network}/leases?project=` → `{op, items: [{hostname, address, hwaddr, type, guest_id}]}` | operator |
| `profile.get` | `GET …/incus/profiles/{profile}?project=` → `{op, profile: {name, project, description, config, devices, used_by, restricted, digest}}` | operator |
| `profile.create` / `update` / `delete` | `POST …/incus/profiles`, `PUT …/incus/profiles/{profile}`, `DELETE …?project=&confirm=1` | admin |
| `volume.create` / `resize` / `delete` | `POST …/incus/pools/{pool}/volumes`, `POST …/volumes/{volume}/resize` (operator), `DELETE …/volumes/{volume}?project=&confirm=1` | admin |
| `image.download` / `refresh` / `delete` | `POST …/incus/images {alias, type, project?, auto_update?}`, `POST …/incus/images/{fp}/refresh` (operator), `DELETE …/incus/images/{fp}?project=` | admin |

The shared ops take the Incus fields (create: `project`, `pool`,
`network`, `cloud_init`; clone: `project`, `instance_only`; backup.create:
`name`, `expires_at`, `instance_only`, `optimized`, `compression`;
backup.restore: `platform: incus`, `guest` = whose backup, `volume` =
backup name, `name`, `storage`, `start` — always a new instance, no
confirm; backup.delete: `?platform=incus&guest=&volume=`; choices:
`?project=`; config.set: `devices`, `profiles`). `task.list` items may say
`cancellable`. Codes: 409 `in_use` (a profile or volume something uses),
501 `unsupported` (an Incus route on a host or guest that is not Incus).

**The self guest** (IU-02): the guest Whombat runs in has `self: true`,
its server `hosts_this_whombat: true`. The hub refuses changing it with
409 `self_guest` "That’s this Whombat itself." outside contracts
0.83.0's `HOST_SELF_GUEST_ALLOWED` (actions `start`, `resume`,
`snapshot_create`, `snapshot_delete`; manage `backup.create`,
`backup.update`, `backup.delete`, `guest.clone`, `replication.add`,
`replication.delete`, `task.stop`, a restore as a new guest; reads and
consoles). Host power on its server is not refused: Whombat asks.

### Alerts, watch settings, maintenance, checks

REST-API "Alerts", "Watch settings", "Maintenance", "Checks".

| Whombat op | Route | Role |
|---|---|---|
| `hosts.alerts.list` | `GET /alerts?state=open\|resolved\|all&server=&severity=&rule=&q=` | viewer |
| `hosts.alerts.ack` | `POST /alerts/{id}/ack {note?, minutes?}` (`minutes` 1–43200 snoozes) | operator |
| `hosts.alerts.unack` | `DELETE /alerts/{id}/ack` | operator |
| `hosts.watch.get` | `GET /servers/{id}/watch` → `{rules: [{rule, entity?, off: true, by, at}], limits: [{rule, entity?, value}]}` | viewer |
| `hosts.watch.set` | `PUT /servers/{id}/watch {rule, entity?, off}` → the same | operator |
| `things.setWatchLimit` | `PUT /servers/{id}/watch {rule, entity?, limit, expected_limit?}` → the same. `null` clears a limit | operator |
| `hosts.maintenance.list` | `GET /maintenance` | viewer |
| `hosts.maintenance.create` | `POST /maintenance {scope: server\|group\|all, target, starts_at?, ends_at? \| duration_min, weekdays?, start_time?, tz?, note?}` | operator |
| `hosts.maintenance.remove` | `DELETE /maintenance/{id}` | operator |
| `hosts.checks.list` | `GET /checks` | viewer |
| `hosts.getCheck` | `GET /checks/{id}` | viewer |
| `hosts.checks.create` | `POST /checks {name, kind: http\|tcp\|ping\|dns\|heartbeat, target, runner?, interval_s?, timeout_s?, grace_s?, options?, owner?}` and `PATCH /checks/{id}` | admin |
| `hosts.checks.remove` | `DELETE /checks/{id}` | admin |

For history, pass `state=all&overlaps_since=<RFC 3339>` to `GET /alerts`.
The list includes alerts that stayed open into the period. The `since`
filter selects alerts by when they opened.

**Quiet notices** (Whombat QN-23; decisions HS-190…HS-197). A server's
`status` is `warning` only while one of its open alerts asks for attention
(`attention: true`), and its `status_note` is that alert's; `offline` is
the heartbeat's alone. Every alert carries `entity` and `key`
(`<rule>:<entity>`), every hint a stable `id` (`<kind>:<entity>`, unique
within its server). What Whombat's menu does on a server's line:

| Whombat | Alert | Hint |
|---|---|---|
| Ignore (until it changes) | `POST /alerts/{id}/ack {}` (`minutes` 0): until it resolves, or its severity rises within its rule (then `alert.updated` with `attention: true`); a recurrence is a new `id` | in Whombat, by the hint's `id` |
| Remind me tomorrow | `POST /alerts/{id}/ack {minutes}` up to 09:00 in the Whombat's zone; also ends on a rise | in Whombat |
| Undo | `DELETE /alerts/{id}/ack` | in Whombat |
| Stop watching {disk, guest …} / this | `PUT /servers/{id}/watch {rule, entity: <alert's entity>, off: true}`, or without `entity` for the whole rule; `off: false` undoes | in Whombat |

An autostart Unraid Docker container that ran out of memory or an
autostart libvirt VM that crashed can open a critical `guest.stopped`
alert if it stays stopped. Stops the hub requested stay quiet, and a report
showing the guest running clears its planned-stop note.

Custom limits for disk use, inodes, SSD wear and temperature apply to the
server unless the alert's entity has its own. The hub rechecks its latest
readings and closes alerts that fall below the new limit right away.
Temperature and SSD wear warning limits must stay below their critical
limits. A limit change keeps the same watch switch. Whombat signs the change as the person and uses
`expected_limit` to take it back only while their edit still holds.

A connection's check has `owner: "whombat:connection:<id>"` and uses the
single-check route to read `last`, including latency and the certificate's
end date. A stale check has no current answer. Its previous `last.at`
stays available for “Not checked since …”. A new or edited probe waits
for its own first result, and its wait counts from when the settings took
effect. A check-in gets its full period and grace time when set up or
resumed, until its first successful ping. For a name lookup, set
`options.dns_type` to `any` to accept an A or AAAA answer. The default is A.
A hub rolled back to the previous version runs an A lookup for that check.

Hints (conditions near a limit, not alerts yet) are `hints[]` of `GET
/fleet` and `GET /servers/{id}`. Headless, a heartbeat check's `ping_url`
is on the agent listener: `https://<agents address>:8443/ping/<token>`
(curl needs `-k` or `--pinnedpubkey <tls_pin>`).

### Enrollments: Add a server (admin)

| Whombat op | Route |
|---|---|
| `hosts.enrollments.create` | `POST /enrollments {approve?, control?, name?, group?}` (body optional) |
| `hosts.enrollments.list` | `GET /enrollments?state=pending\|issued\|approved\|rejected\|expired\|all` |
| `hosts.enrollments.approve` | `POST /enrollments/{id}/approve {group?, name?}` → `{server_id}` |
| `hosts.enrollments.reject` | `POST /enrollments/{id}/reject` |
| `hosts.startInstall` (the script it runs over SSH) | `GET /agent-install.sh` (`text/x-shellscript`) |

`POST /enrollments` takes an optional body (Whombat SI-06/SI-07; an empty
body or `{}` is the enrollment as before):

| Field | |
|---|---|
| `approve: true` | **Pre-approved**: the hub approves it the moment the agent asks (in the agent's enroll request), and the agent's first poll gets its certificate. Without it the enrollment waits for `approve` (`enrollment.pending`, Needs you). |
| `control: "watch"\|"operate"\|"full"` | The server's switches when it is approved (automatically or by hand), exactly the level's (table below). `install_command` ends with `--control <level>`, which sets the agent's own lock to the same level. |
| `name` | The server's name (slugged like `approve`'s `name`; 400 `invalid_name` when nothing is left). Default: the agent's host name. |
| `group` | Default `Ungrouped`; `All` is 400 `invalid_group`. |

| Level | Hub switches (`remote_control`) and the agent's `[remote_control]` |
|---|---|
| `watch` | `diagnose` only (the agent's defaults) |
| `operate` | `console`, `power`, `diagnose` |
| `full` | all six: `console`, `power`, `host_shell`, `host_power`, `manage`, `diagnose` |

A pre-approved server whose name is taken gets `-2`, `-3`, … (up to `-99`;
then the enrollment waits for an admin): an existing server is never taken
over. The approval publishes `enrollment.approved` (admins; also for an
approval by hand) and the usual `server.settings_changed` /
`server.updated`, and is audited as `enrollment.approved` with the token's
creator as the actor (`John Doe (pe_8f2c)`, role admin, the agent's
address) and details `auto: "true"`, `control`, `group`, `hostname`,
`enrollment_id`. Browser sessions (not headless) need a recent sign-in for
`operate` and `full`, at creation and at a manual approval; the service
token does not (Whombat asks the person itself).

Headless answer (201):

```json
{"id": "en_26d5…", "token": "dkpU…", "expires_at": "…",
 "install_command": " curl -fsSL --insecure --pinnedpubkey 'sha256//15ug…=' https://10.100.1.5:8443/install.sh | sudo sh -s -- --token dkpU… --control full",
 "install_url": "https://10.100.1.5:8443/install.sh", "tls_pin": "sha256//15ug…=",
 "agent_url": "wss://10.100.1.5:8443", "ca_sha256": "e57c…",
 "approve": true, "control": "full", "name": "pve-03"}
```

`approve` is always there (`false` when not asked); `control` and `name`
are `null` when not given. While the hub has a Windows build of the agent
the answer also has `install_command_windows` (one line for PowerShell
opened as administrator: it fetches `install.ps1` from the agents'
address, checks it against the SHA-256 in the line and runs it with
`-Origin`, `-Hub`, `-Token` and `-Control`) and
`uninstall_command_windows`; without one both are absent. Show `install_command` as it is (it starts with
a space: shells with `HISTCONTROL=ignorespace` keep the token out of the
history). The token is single use and lasts an hour. 503 `no_agent_url`
when the hub cannot tell the address agents reach it at (no `--agent-url`,
no default route). Errors: 400 `invalid_control`, `invalid_name`,
`invalid_group`, `bad_request` (unknown field, bad JSON).

`GET /enrollments` items add `approve` (boolean), `control` and `name`
(`null` when not given):

```json
[{"id": "en_…", "state": "pending", "hostname": "pve-03", "os": "Debian GNU/Linux 13 (trixie)",
  "address": "10.100.0.14", "agent_version": "…", "requested_at": "…", "created_at": "…",
  "expires_at": "…", "server_id": null, "approve": false, "control": "full", "name": null}]
```

`GET /agent-install.sh` (admin) is the script the agent listener serves at
`/install.sh`, byte for byte: downloads from the agents' address
(`https://<agents address>:<port>/download`, the listener's key pinned) and
the agents' URL baked in, whatever `Host` the socket request named. 503
`no_agent_url` like above. `?via=<address>` is the machine's own end of
Whombat's connection to the server: when it is an address of the Tailscale
interface, both are that address on the agent listener's own port (400
`bad_request` for any other address, and Whombat asks again without it).
The answer names the agents' URL it carries in `X-Whombat-Agent-URL`. Whombat
streams it to the server over SSH (§6).

### Consoles (`hosts.consoles.create`)

| Route | Role |
|---|---|
| `POST /servers/{id}/guests/{guestId}/console-sessions {protocol?, switch_from?}` | operator, console switch |
| `POST /servers/{id}/console-sessions {protocol: logs\|shell\|vnc}` (the host's journal, a root shell, or a Mac's screen) | operator (logs) / admin + host shell switches (shell, vnc) |
| `GET /console/{sid}` (WebSocket) | the same actor |
| `DELETE /console-sessions/{sid}`, `GET /console-sessions` (admin) | |

Answer: `{"session_id": "cs_…", "url": "/api/v1/console/cs_…", "token":
"…", "protocol": "shell", "expires_at": "…", "idle_timeout_s": 900,
"requires_confirmation": false}`. Protocols: `vnc`, `spice`, `serial`,
`shell`, `tty`, `logs` (the guest's `console.protocols`). Whombat's contract
is `{path, token, protocol}` = `{url, token, protocol}`. See §5 for the
proxy. A Mac's host offers `vnc` (and makes it the default) when Screen
Sharing answers and the screen account is set (`macos.screen.sharing`,
`macos.screen.account`): the agent signs in to the Mac's Screen Sharing
and the browser sees an RFB session with security None; the Mac answers
noVNC's encodings with ZRLE.

### Inspect, diagnose, exec (new routes for Whombat's tools)

| Whombat op / tool | Route | Role and switches |
|---|---|---|
| `hosts.inspect` | `GET /servers/{id}/inspect/{processes\|ports\|services\|updates}` | operator, console switch; `updates` the diagnose or the console switch (SWU-11; REST-API "Inspect") |
| `server_diagnose` (catalog) | `GET /servers/{id}/diagnose` | operator, diagnose switch (on by default, both sides) |
| `server_diagnose` (run) | `POST /servers/{id}/diagnose {check, args?}` | operator, diagnose switch |
| `server_disk_usage`, `hosts.diskUsage` | `POST /servers/{id}/disk-usage {mount?, max_depth?, timeout_s?}` | operator, diagnose switch (cached recent list: `GET /servers/{id}/disk-usage`, viewer) |
| `server_command` | `POST /servers/{id}/exec {command, timeout_s?}` | admin, host shell switches (hub `host_shell` and `[remote_control] host_shell = true`) |
| `mac_screen`, `mac_ui`, the Mac's page | `POST /servers/{id}/screen {op, …}` (a Mac only) | host shell switches; operator for `status` only, admin and a recent sign-in for every other step; `status` also with the diagnose switches |

`GET /servers/{id}/diagnose` →
`{"server": "pve-02", "checks": [{"name": "smart", "description": "Full SMART data of one disk (a disk in standby is not woken up)", "args": [{"name": "device", "description": "sda, nvme0n1, or a /dev/disk/by-id name", "required": true}]}, …]}`:
the read-only checks this host can run (`docs/ASSIST.md` §3.1: `system`,
`processes`, `ports`, `services`, `service`, `logs`, `disks`, `smart`,
`raid`, `unraid`, `zfs`, `network`, `sensors`, `docker`, `docker_logs`,
`incus`, `libvirt`, `pve`, `ups`, `updates`; missing tools are left out).

`POST /servers/{id}/diagnose {"check": "logs", "args": {"unit": "pveproxy", "since": "2h", "lines": 200}}` →
`{"server", "check", "ok": true, "commands": ["journalctl -o short-iso -n 200 --unit pveproxy --since …"], "output": "…", "truncated": false}`.
A check that ran and failed or timed out answers 200 with `"ok": false,
"code": "failed"|"timeout", "message"` and what it printed. Arguments are
strings (numbers and booleans are converted), at most 16, validated by the
agent. Errors: 400 `invalid_value` (check name, argument shape), 400
`invalid_request` (the agent refused an argument; `detail` says why), 404
`unknown_check`, 403 `diagnose_disabled`, 409 `agent_offline`, 502
`agent_error`. Output is UTF-8 text, at most 256 KiB, secrets redacted.
Each run is audited as `diagnose.ran` (check and arguments).

`POST /servers/{id}/disk-usage {"mount": "/"}` →
`{"server", "ok": true, "mount", "fs_type", "device", "measured_at", "duration_ms", "total_bytes", "used_bytes", "partial", "categories": [{"key", "label", "bytes", "reclaimable_bytes"?, "detail"?}], "folders": [{"path", "bytes", "partial"?}]}`.
An omitted `mount` chooses the fullest writable local filesystem (or `/`). When
a backing disk is spun down, the agent skips it without touching the mount and
the route answers 200 with `"ok": false, "code": "spun_down", "message",
"skipped_spun_down"`; when Whombat cannot confirm which backing disks a mount
uses or whether a drive is asleep, the route answers 200 with `"ok": false,
"code": "standby_unknown", "message"`. Neither overwrites a previously stored
measurement.
Successful runs are stored per `(server, mount)` in SQLite, broadcast as
`server.disk_usage`, and included on `GET /servers/{id}` (`disk_usage`) while
measured within 24 hours. Errors: 400 `invalid_value` / `invalid_request`, 403
`diagnose_disabled`, 409 `agent_offline` / `busy`, 501 `unsupported`, 502
`agent_error`. Each run is audited as `disk_usage.ran`.

`POST /servers/{id}/exec {"command": "systemctl restart pveproxy", "timeout_s": 120}` →
`{"server", "exit_code": 0, "timed_out": false, "output": "…", "truncated": false, "duration_ms": 412, "audit_id": "au_…"}`.
`/bin/sh -c` as root on the host, outside the agent's sandbox, stdin
closed, a clean environment; `timeout_s` 1 to 1800 (default 120; the
request lasts as long). Output: stdout and stderr interleaved, the **last**
256 KiB. A non-zero exit is still 200. The command runs to its end if the
caller disconnects. Audited before it runs (`exec.requested` with the
command's first 500 characters; refused with 503 `audit_unavailable` if
that fails) and after (`exec.finished` with exit code). Errors: 400
`invalid_value` (empty, over 16 KiB, NUL), 403 `insufficient_role`, 403
`host_shell_disabled`, 409 `agent_offline`, 502 `agent_error`.

`POST /servers/{id}/screen {"op": "look", "max_w": 1280, "format": "jpeg"}` →
`{"server", "op", "ok": true, "image_b64": "…", "format": "jpeg", "w": 1280, "h": 720, "screen_w": 1920, "screen_h": 1080}`:
one step on a Mac's screen (`docs/AGENT-PROTOCOL.md` "Screen"). Body:
`op` and its fields: `x`, `y`, `to_x`, `to_y` (framebuffer pixels: the
`screen_w` × `screen_h` space every answer gives), `button`, `clicks`,
`dx`, `dy`, `text` (`type`, and `ui.set`'s value), `keys`, `max_w`,
`format`, `app`, `window`, `name`, `role`, `index`, `path` (`ui.menu`),
`limit`, `target` (`ui.open`), `account: {user, password}`
(`account.set` only), `crop: {x, y, w, h}` (`look`), `action`
(`ui.action`), `queries` (`map.geocode`), `w`, `h`, `scale`, `dark`,
`pins: [{lat, lon}]`, `lat`, `lon`, `span_m` (`map.snapshot`). Ops:
`status`, `look`, `click`, `drag`, `scroll`, `type`, `keys`, `unlock`,
`password`, `account.set`, `account.check`, `account.clear`, `ui.apps`,
`ui.list`, `ui.press`, `ui.set`, `ui.menu`, `ui.focus`, `ui.open`,
`ui.action`, `ui.quit`, `map.geocode`, `map.snapshot`. `look` with `crop`
takes only that part of the screen (framebuffer pixels, clamped to the
screen, cut before `max_w` scales it). `ui.open`'s app is its name as the
Mac shows it (“Find My”), its file's (“FindMy”) or its bundle id
(`com.apple.findmy`, the same in every language); app names in `ui.*`
match with case and spaces ignored, an ordinary app before an accessory or
an extension matched alike. `ui.action` runs an element's accessibility
action by name (found as `ui.press` finds it): an app's own (Find My's rows:
“Open Details”, “Directions”, “Play”; Find My lists them only for the
selected row) or an `AX…` one; the whole name first, then the one that
starts with it (“Directions” runs “Directions · 0 min”); two that start
with it run nothing (`not_found`, the names in its message). `ui.quit` asks
an ordinary app to quit as its menu does and waits up to 3 s (`message`
“It is still closing.” when it hasn't ended; `not_found` when it isn't
open). `map.geocode` finds each address with Apple's geocoder
(`places`, one per query in order: `{lat, lon, accuracy_m}` or null when
nothing was found; kept by the Mac for an hour). `map.snapshot` draws a
map picture on the Mac with MapKit (a standard map without points of
interest, dark with `dark`): `image_b64`, `format` (jpeg by default),
`w`, `h` (pixels: `w` × `scale` by `h` × `scale`, 600 × 400 points at 2
by default), `points` (one per pin in the picture's points from its
top-left, null outside it), `lat`, `lon` and `span_m` (the region drawn,
metres across its shorter side). Its region is `lat`, `lon` and `span_m`
when given (all three), else every pin with 30 % more around them and at
least 600 m. `ui.quit` and the `map.*` steps need neither Accessibility nor
an unlocked screen; `ui.action` needs both, as `ui.press` does. The `map.*`
steps may take 20 s on the Mac. `password` types the Mac's stored password into
macOS's own password prompt in front (an administrator prompt, a privacy
switch's) and takes no `text` (400 `invalid_value` with one); its
`element` is the prompt's password field, whose `app` names the prompt.
Before Whombat Helper has Accessibility (a new Mac, a new helper build) it
still answers the prompt that switches it on, for an administrator at the
screen whose account is the screen account and an administrator
(`not_admin` when it isn't one, `failed` when someone else is at the
screen); its `element` is then the prompt's window (`role` `AXWindow`).
The answer adds what the step returns: `image_b64`,
`format`, `w`, `h`; `elements` (`[{id, role, subrole, title, desc, value,
ident, enabled, focused, x, y, w, h, actions, app, window}]`, pixels),
`apps` (`[{name, bundle_id, pid, active, windows}]`), `element` (what
`ui.press`/`set`/`menu` acted on, its `title` the name it was found by
when it has none of its own), `truncated`; `status` (`{sharing,
account, sign_in, sign_in_at, locked, w, h}`) and `helper` (`{installed,
version, running, ax, user, idle_s}`: `idle_s` the whole seconds since the
last keyboard or mouse input at the Mac, Screen Sharing's included, from
Whombat Helper 1.1.0 and only in `status`'s answer, else null);
`places`, `points`, `lat`, `lon`, `span_m` (above); `message` when the agent says something
about a step that worked (an unlock through Screen Sharing that macOS
undoes when the session ends, a press whose app is still busy); `audit_id`
for every step but `status`. A step the agent ran but couldn't do is 200
`{"ok": false, "code", "message"}` with its code: `not_found` (the message
lists close names), `no_helper`, `no_access` (Whombat Helper lacks
Accessibility), `not_admin` (`password` without Accessibility: the screen
account isn't an administrator, so macOS wouldn't fill in its name; typing
it at the Mac is the way), `locked`, `no_prompt` (`password`: no macOS
password prompt on the screen), `sign_in_failed`, `no_account`,
`no_screen` (Screen Sharing is off, or what answers on its port isn't
macOS's own: the agent signs in to nothing else), `busy` (another step is
running, or Whombat Helper takes no more requests now: try again),
`timeout`,
`failed` (its message says which: the password was refused, the prompt is
still there, the password field didn't have the keyboard, the lock state
couldn't be told). Only `status` is an operator's; every other step needs
an admin and a recent sign-in (the service token counts) and is audited
as `screen.<op>`: the steps that act with their target (coordinates, keys,
names, an action's name, menu path, the account's user, a typed text's
length, the app of the prompt `password` answered; never the text or the
password), `look`, `ui.apps` and `ui.list` with the op and the app only,
never what they saw, and `map.geocode` and `map.snapshot` with the op
alone, never an address or a place; refused with 503 `audit_unavailable`
when the audit log is. Errors: 400 `invalid_value` (a field beyond the
limits below, or the agent refused the step: `detail` says why), 403
`insufficient_role`, 403 `host_shell_disabled`, 409 `agent_offline`, 501
`unsupported` (not a Mac, an agent without a screen, or a Whombat Helper
older than the step: “Whombat Helper on this Mac is older than this step;
it updates itself.”, which `detail` says; an agent older than the step
refuses it as 400 `invalid_value`), 502 `agent_error`; 30 s at most, `password`
and `unlock` 65 s (the password goes one character at a time, each checked
first: a long one takes tens of seconds), so a caller waits at least that
long for those two.

**A Mac's screen: the limits.** The hub refuses a field beyond these with
400 `invalid_value` before the agent is asked; the agent checks the same
(and what needs the screen, such as a point inside it) and answers
`invalid_request`. Whombat holds its tools to the same numbers.

| Field | Steps | Limit |
|---|---|---|
| `x`, `y`, `to_x`, `to_y` | `click`, `drag`, `scroll` | framebuffer pixels, 0 or more and inside the `screen_w` × `screen_h` screen (the hub: 0 to 16384); `scroll` at 0, 0 is the screen's middle |
| `button` | `click`, `drag` | `left` (default), `right`, `middle` |
| `clicks` | `click` | 1 to 3 (0 is 1) |
| `dx`, `dy` | `scroll` | −50 to 50 steps each (a step is 40 wheel events); not both 0 |
| `text` | `type` | 1 to 2000 characters (line breaks are Return) |
| `text` | `ui.set` (the value) | 0 to 10 000 characters (`""` clears) |
| `keys` | `keys` | at most 500 characters and 50 chords |
| `max_w` | `look` | 0 (full size) to 8192 pixels |
| `format` | `look` | `png` (default) or `jpeg` |
| `app`, `window`, `name` | `ui.*` | at most 200 characters, no NUL |
| `role` | `ui.list`, `ui.press`, `ui.set` | at most 64 characters: a role word (`button`, `checkbox`, `switch`, `text_field`, `menu_item`, `link`, `tab`, `row`, `popup`, `radio`, `any`) or an AX role (`AXSlider`), or up to 8 of them separated by commas (`button,link`); `any` anywhere is any role |
| `index` | `ui.press`, `ui.set` | 0 to 1000 |
| `path` | `ui.menu` | 1 to 8 menu items, each 1 to 200 characters |
| `limit` | `ui.list` | 0 (300) to 1000 |
| `target` | `ui.open` | `accessibility`, an app's name or bundle id (at most 200 characters, no `/`), or an `https` address (at most 2048) |
| `action` | `ui.action` | 1 to 200 characters (`name` is needed too) |
| `app` | `ui.quit` | 1 to 200 characters |
| `crop` | `look` | `x`, `y` 0 or more; `w`, `h` 1 or more (the hub: at most 16384 each); clamped to the screen, none of it on the screen is `invalid_request` |
| `queries` | `map.geocode` | 1 to 8, each 1 to 300 characters |
| `w`, `h` | `map.snapshot` | 64 to 1600 points (0: 600 × 400) |
| `scale` | `map.snapshot` | 1 or 2 pixels per point (0: 2) |
| `format` | `map.snapshot` | `jpeg` (default) or `png` |
| `pins` | `map.snapshot` | at most 20, `lat` −90 to 90, `lon` −180 to 180 |
| `lat`, `lon`, `span_m` | `map.snapshot` | all three or none (then pins are needed); `span_m` 50 to 20 000 000 metres |
| `account.user`, `account.password` | `account.set` | 1 to 63 bytes each (Apple's sign-in carries 63), one line of text, no NUL |
| the stored password | `unlock`, `password` | the screen account's, so at most 63 bytes |

Answers are bounded too: `elements` at most 1000, `apps` 500 (each at most
50 windows), names and values 200 characters, `message` 1000, a picture
under 7 MiB (a look's made smaller when it would be bigger; a map that
would be bigger is `failed`: ask for a smaller one), `places` 8, `points`
20.

What the password checks can't do: `password` and `unlock` look at where
the keyboard goes right before each key, and then send it. Those are two
steps a few milliseconds apart, so if the focus moves in exactly that
moment, one character can land somewhere else. The next check then fails:
nothing more is typed and Return is never pressed, so the password is
never sent anywhere whole. A step that runs out of time stops the same
way, after emptying the field it typed into while that field still has
the keyboard.

Whombat's Servers tools (ONE-12) map onto the routes above:
`servers_overview` → `GET /fleet`; `server_detail` → `GET /servers/{id}`;
`server_metrics` → `GET /servers/{id}/metrics`; `guests_list` → `GET
/servers/{id}/guests` or `GET /guests`; `guest_detail` → `GET
/servers/{id}/guests/{guestId}`; `guest_config` → `GET
…/guests/{guestId}/config`; `guest_power` → `POST …/actions`;
`guest_config_set` → `PUT …/config`; `guest_snapshot` → `POST …/actions
{action: snapshot_create|…}`; `guest_snapshots` → `GET …/snapshots`;
`backup_jobs` → `GET /servers/{id}/backup-jobs`; `backup_job_set` →
`POST /backup-jobs` (create), `PUT /backup-jobs/{job}` (update; pause and
resume are `enabled`, add_guest and remove_guest change `guests` /
`exclude`), `DELETE …?confirm=1` (delete, always asks), `POST …/run`
(run); `guest_migrate` → `POST …/migrate`;
`alerts_list` → `GET /alerts`; `alert_snooze` → `POST /alerts/{id}/ack
{minutes}`; `server_diagnose` and `server_command` as above.

### Audit, backup

`GET /audit?limit=&cursor=&server=&event=` and `GET /audit/export` (CSV),
admin (REST-API "Audit"). `GET /hub/backup` (admin): a `.tar.gz` with the
database and the CA key; its `manifest.json` names the backup's
`agent_url` and `ca_sha256`. The box's checkpoints take `whombat-hosts
backup --out -`, the same files as a plain tar (`hub.tar`, which restic
can dedup). `POST /hub/restore` (admin, the `.tar.gz` or a plain tar as
the body, ≤ 1 GiB): `202 {ca_sha256, servers, agent_url}` and the service
restarts within seconds with the backup's servers and CA (its own service
token and a new listener certificate); refusals 400 `bad_backup` /
`newer_schema`, 409 `same_hub` / `hub_not_empty` / `restore_pending`
(REST-API "Hub"). Whatever puts a backup at
`<data>/restore-staged.tar.gz` or `<data>/restore-staged.tar` (a tar or a
gzipped one under either name) gets it applied at the next start. For 14
days after a restore, agents that renewed their certificate after the
backup was made are let back in (their machine id must match).

### Not served headless

`/auth/*`, `/tokens`, `/users*`, `/channels*`, `/deliveries`,
`/notification-settings`, `/assistant*`, `POST /alerts/{id}/ack-link`, the
UI's static files and `install.sh` / `/download/*` on the socket (they are
on the agent listener; the socket has `GET /api/v1/agent-install.sh`).
These answer 404. `GET /metrics` (Prometheus)
accepts the service token.

## 4. Events (realtime topic `hosts`)

`GET /api/v1/events` with the service token: Server-Sent Events, `id:
<n>`, `event: <name>`, `data: <JSON>`; `retry: 5000` first and a `:
keepalive` comment every 20 s. Resume with `Last-Event-ID` (buffer of 4096
events); when the id is too old (or from an earlier hub run) the stream
starts with `resync` `{}`: refetch everything. The stream ends within 20
s when the service token changes, and when the client falls 512 events
behind: reconnect. At most 16 streams per actor (the oldest is closed); use one
stream with a fixed actor (`whombat-server|Whombat`, role admin, so the
admin-only events arrive). Data shapes: `docs/REST-API.md` "Events".

| Event | Whombat topic |
|---|---|
| `server.updated` `{id, status, status_note, current, last_seen, agent_connected}`, `server.online`, `server.offline` `{id, at}`, `server.settings_changed`, `server.deleted` `{id}` | `hosts.server` |
| `guest.state_changed` `{server, id, state}` | `hosts.guest` |
| `alert.opened`, `alert.updated`, `alert.resolved` (the alert object; `alert.updated` also when the severity changes) | `hosts.alert` |
| `watch.changed` `{server, rule, entity?, off or limit}` | a server's watch settings changed: refetch `GET /servers/{id}/watch` |
| `action.finished` `{action_id, server, guest, action, result, message, state, noop, code}`, `task.finished` `{server, guest, task, op, result: ok\|warning\|error, message, new_id?, code?}` (`new_id`: an image's fingerprint after publish or image.download; `code`: `task_failed`, `not_found`, `timeout`, a package task's `busy`) | `hosts.task` |
| `enrollment.pending` `{id, hostname}` (admins) | Needs you: a server waits for approval (not sent for a pre-approved one) |
| `enrollment.approved` `{id, server_id, hostname}` (admins) | the enrollment became a server (pre-approved or by hand): clear Needs you |
| `maintenance.changed`, `checks.changed` | refetch those lists |
| `agent.update` `{server, state, message}` (admins) | agent update progress: `updating`, `failed` (`version`, `by`), `waiting` (`waiting_for`), `updated` (`from`, `to`, `by`: `auto` or the actor; Done recently), `halted` (`version`), `""` (cleared) |
| `console.closed` `{session_id, reason}` | only to the console's actor |
| `resync` | refetch everything |

## 5. Proxying a console WebSocket

1. A person asks Whombat for a console; Whombat checks its own permission
   (and asks, for host shells), then calls `POST
   …/console-sessions` **with that person's actor** (and role). The answer's
   token works once, for 30 seconds, only for **the same actor id** and
   the same service token.
2. Whombat gives its browser a Whombat URL (its own WebSocket endpoint,
   behind its own sign-in and Origin check). Keep the hosts token
   server-side.
3. When the browser connects, Whombat opens the upstream WebSocket over the
   Unix socket:
   - `GET ws://hosts/api/v1/console/{sid}` (any `Host`; the hosts service
     does not look at it),
   - headers `Authorization: Bearer <service token>` and the same
     `X-Whombat-Actor` (role optional),
   - subprotocols **`rackoon.console.v1`** and **`rackoon.token.<token>`**
     (the hub answers `rackoon.console.v1`),
   - **no `Origin`** needed (it is ignored for the service token),
   - no compression.
   Refusals before the upgrade are problem+json: 403 `invalid_token`
   (other actor, other token), 403 `token_used`, 403 `token_expired`, 400
   `subprotocol`, and the permission checks (repeated at upgrade).
4. Relay binary messages unchanged in both directions. Every message is
   `kind (1 byte) | channel (uint16 BE) | payload` (≤ 1 MiB): kind 0 data
   (terminal, RFB or SPICE bytes), kind 1 a JSON control. The browser side
   must send `{"type":"activity"}` controls while the person types or
   moves the mouse (the hub's idle timer, 15 minutes, ignores data
   frames); resize, open, close and ping pass through. The hub sends
   `status` first and `{"type":"closed","reason"}` before it ends a
   session (`idle_timeout`, `max_age` 8 h, `revoked`,
   `remote_control_disabled`, `agent_disconnected`, `guest_stopped`,
   `switched`, `ended`). Close the browser socket when the upstream
   closes, and the upstream when the browser goes.
5. Ending a console from Whombat: `DELETE /console-sessions/{sid}` with the
   same actor (or an admin role).

The browser clients ported from Rackoon (xterm.js for `shell`, `tty`,
`serial`, `logs`; noVNC for `vnc`) speak exactly this framing. SPICE is
left out (ONE-13).

## 6. Install flow (Add a server)

Two ways in (Whombat SI-01), the same installer:

- **Sign in once** (SI-02): Whombat signs in to the server over SSH, calls
  `POST /enrollments {approve: true, control, name?}`, fetches `GET
  /agent-install.sh`, writes it to a temporary file on the server and runs
  `sh <file> --token - --control <level>` as root (through `sudo -S -p ''`
  when the user is not root: stdin is `<password>\n<token>\n`, sudo reads
  its line, the script the next one; `sudo -k -S` makes sure sudo always
  reads its line).
- **Run a command**: Whombat shows `install_command` of a pre-approved
  enrollment; the person runs it as root:
  `curl -fsSL --insecure --pinnedpubkey 'sha256//…' https://<box LAN address>:8443/install.sh | sudo sh -s -- --token <token> --control full`.
  `--insecure` only skips the CA check curl cannot do (the certificate is
  from the hub's own CA); `--pinnedpubkey` pins the agent listener's key,
  so the script cannot come from anyone else.
- **Windows PC**: Whombat shows `install_command_windows` of the same
  enrollment; the person pastes it into PowerShell opened as
  administrator. It fetches `install.ps1` (without a certificate check for
  that one download, put back right after it: Windows PowerShell can't be
  given the hub's CA for one download), checks
  its SHA-256 against the one in the line and runs it; the script checks
  the agent's `.exe` against the SHA-256 it carries for the PC's
  architecture, installs it as `%ProgramFiles%\Whombat\whombat-agent.exe`,
  keeps its identity and settings in `%ProgramData%\Whombat` (SYSTEM and
  Administrators only; the agent takes the folder over, moves out what
  someone else could have written there and refuses links in it),
  registers the service `whombat-agent` (LocalSystem,
  automatic, restarted on failure), enrolls and prints one line. Run again,
  it updates the agent in place. Each agent command it runs as
  administrator (`whoami` first) takes the folder over before reading it,
  so an identity someone else left there is set aside and the PC enrolls
  afresh; a step that fails stops the line with its reason. `& "$env:ProgramFiles\Whombat\whombat-agent.exe"
  uninstall` removes the service and the program and keeps the identity
  (`--purge` removes it too). The agent's commands below work the same on
  the PC, with that path, as administrator; a reload is the service's
  parameter-change control.

**install.sh** (`sh install.sh [--token TOKEN|-] [--control watch|operate|full] [--force] [--hub URL] [--download-base URL] [--sha256 HEX] | --uninstall [--purge]`):

1. Checks its arguments, root (`id -u`), reads `--token -` from the first
   line of stdin, and finds the init system (systemd, OpenRC, SysV, Unraid;
   on a Mac launchd, macOS 13 or later).
2. **Before changing anything**, when `$CONFIG_DIR/agent.crt` exists
   (`/etc/whombat-agent`, Unraid `/boot/config/plugins/whombat-agent`): the
   SHA-256 of `ca.crt`'s certificate (else `agent.toml`'s `ca_sha256`) is
   compared with this hub's CA. The same CA → it **keeps** the identity;
   another → it changes nothing, prints `whombat-agent: other-whombat` and
   exits **3** (`--force` enrolls the server here with the token instead).
3. Prints `whombat-agent: os <system>` (below), downloads the agent (the
   listener's key pinned; the SHA-256 in the script is checked either way;
   `wget` cannot pin), installs `/usr/local/bin/whombat-agent` (a Mac:
   `/Library/Application Support/Whombat/bin/whombat-agent`, where only
   root can write, with a link in `/usr/local/bin`) and its
   service (systemd unit `whombat-agent`, OpenRC or SysV
   `/etc/init.d/whombat-agent`, Unraid `/boot/config/plugins/whombat-agent`
   + `rc.whombat-agent`, a Mac's LaunchDaemon
   `/Library/LaunchDaemons/com.whombat.agent.plist` with `RunAtLoad`,
   `KeepAlive` and its log `/var/log/whombat-agent.log`, rotated by
   `/etc/newsyslog.d/whombat-agent.conf`). On a Mac it downloads
   `whombat-agent-darwin-<arch>` (an Apple silicon Mac gets arm64 also
   from a shell under Rosetta), checks it with `shasum -a 256` and, when
   the hub has it, installs Whombat Helper: `whombat-helper-macos.zip`
   (its SHA-256 in the script; the unpacked bundle must be
   `com.whombat.helper` at the version the hub names, pass `codesign
   --verify --deep --strict`, and be signed by the team the hub's
   `whombat-helper-macos.json` names when it names one) unpacked with `ditto -x -k` to
   `/Library/Application Support/Whombat/Whombat Helper.app` (root:wheel,
   readable by everyone) and its LaunchAgent
   `/Library/LaunchAgents/com.whombat.helper.plist` (`LimitLoadToSessionType`
   Aqua, `RunAtLoad`, `KeepAlive`, `ProcessType` Interactive), bootstrapped
   in `gui/<uid>` of whoever is at the screen (other sessions start it at
   their login). Without the helper on the hub the Mac is added without it.
4. New identity: `whombat-agent enroll --hub wss://<box>:8443 --ca-sha256
   <CA pin> --token -` (the agent pins the CA itself). A pre-approved token
   is approved in that request; any other waits for the person to approve
   it (the agent prints `whombat-agent: waiting <enrollment id>` and polls
   until approved, as before). Kept identity: when a token was given, `whombat-agent whoami
   --check` asks the hub whether it still knows the agent's certificate; a
   server removed in Whombat (or an expired certificate) enrolls again with
   the token, anything else keeps it; then `whombat-agent hub <HUB_URL>`
   points `agent.toml` at this script's hub when it differs (a box whose
   address changed).
5. `--control <level>`: `whombat-agent policy set <level>` makes the
   agent's `[remote_control]` exactly the level's switches (§3, lowering
   too), on every init system and on Unraid.
6. Enables and (re)starts the service, which reads the new settings (a
   Mac: `launchctl enable`, `bootout` and `bootstrap system` of the
   LaunchDaemon, then the helper).

**stdout**: the last line says what happened, exactly one of

| Line | |
|---|---|
| `whombat-agent: added <server id>` | enrolled and approved (“Added to Whombat as pve-03.” before it) |
| `whombat-agent: waiting <enrollment id>` | enrolled, waits for the person's approval (not pre-approved); printed while the script waits, `added` follows once approved |
| `whombat-agent: kept <server id>` | already enrolled with this Whombat: upgraded, re-pointed, level applied |
| `whombat-agent: other-whombat` | its agent reports to another Whombat; nothing changed (exit 3) |

`whombat-agent: os <system>` comes before it (and before the download):
the platforms found, then `PRETTY_NAME` and the architecture, joined with
` · `: `Proxmox VE 9.0 · Debian GNU/Linux 13 (trixie) · amd64`, `Unraid
7.3.1 · <its PRETTY_NAME> · amd64`, `Incus 6.0 · Debian GNU/Linux 13 (trixie) ·
amd64`, `Alpine Linux v3.22 · amd64`, `macOS 27.2.1 · arm64` (Proxmox
from `pveversion`, Unraid from `/etc/unraid-version`, Incus from `incus
--version`, macOS from `sw_vers -productVersion`).

**stderr**: failures end with one stable line (exit 1, or 2 for arguments):

| Words | When |
|---|---|
| `install.sh: run as root (sudo)` | not root |
| `install.sh: unsupported init system; …` | none of systemd, OpenRC, SysV, Unraid |
| `install.sh: unsupported architecture <uname -m>` | not amd64 or arm64 |
| `install.sh: macOS 13 or later is needed (this Mac has <version>)` | a Mac older than macOS 13 |
| `install.sh: checksum mismatch (Whombat Helper)`, `could not unpack Whombat Helper`, `the Whombat Helper download holds no app` | the helper's zip is not the one the hub published |
| `install.sh: launchd did not start the agent` | `launchctl bootstrap` kept failing for 10 s |
| `install.sh: curl or wget is required` | neither |
| `install.sh: cannot reach <url>` | the download could not connect: curl exit 6, 7, 28, 35; GNU wget 4, 5; BusyBox wget's “can't connect”, “bad address”, “timed out” (curl's or wget's own message comes before it) |
| `install.sh: download failed: <url> (curl exit N)` | any other download failure (HTTP error, a key that does not match the pin: curl 90) |
| `install.sh: checksum mismatch` | the binary is not the one the hub published |
| `install.sh: --control must be watch, operate or full`, `--force needs --token`, `could not read the token from stdin`, `--token is required …` | arguments (exit 2) |
| `whombat-agent: enrollment refused: invalid_token …` | the token was used, expired or unknown |

Then the agent connects (`wss://…/agent/v1/connect`, mTLS) and reports
every 10 s; the first report carries the agent's policy.

The agent's files: `/etc/whombat-agent` (identity, `agent.toml` with
`[remote_control]`; on a Mac also `screen.toml`, the screen account, root
only), `/var/lib/whombat-agent` (sample buffer), on a Mac too.
`--uninstall` removes `screen.toml` (the Mac's password) always; on a Mac
it boots out the LaunchDaemon and the helper from every desktop session
and removes them, the app, the agent's folder, its link in
`/usr/local/bin` and `/var/run/whombat-agent`; `--purge` also the identity
and the log. A Mac's agent installed in `/usr/local/bin` before moves to
`/Library/Application Support/Whombat/bin` at install.sh's next run. Until
then an agent whose folder someone other than root can change (Homebrew's
`/usr/local/bin` on an Intel Mac) says so in its report, and the Mac shows
the hint `macos.agent_folder` (off by default, like the Mac's other
hints).

**Agent commands on the server (PX-04, SI-06/SI-08).** The server's own
`[remote_control]` stays the first lock; the hub's switch is the second.
On the server, as root: `whombat-agent allow <switch>…`, `whombat-agent
deny <switch>…`, `whombat-agent policy` (switches `console`, `power`,
`host_shell`, `host_power`, `manage`, `diagnose`, `all`; Unraid runs it
without `sudo`), and `whombat-agent policy set watch|operate|full`
(exactly a level; `--no-reload` leaves the reload to the caller). They edit
`agent.toml` in place, reload the agent (systemd, a Mac's `launchctl kill
SIGHUP system/com.whombat.agent`, else SIGHUP), print one
sentence (“pve-02 now allows guest editing and power.”, “pve-03 is set to
Full control: it allows consoles, power, the host shell, host power, guest
editing and diagnostics.”) and the next report carries the new policy
(`agent_policy`, `remote_control.agent_manage`, …) within about 10
seconds. `whombat-agent hub [wss://HOST:PORT]` shows or changes the hub it
reports to (systemd, or a Mac's `launchctl kickstart -k`, restarts the
agent; `--no-restart`). `whombat-agent
whoami [--check [--hub URL]]` prints `<server id> <CA SHA-256>` (`--check`:
and `known`, `removed` or `unreachable`). `allow manage` on Proxmox VE also
creates `whombat-manage@pve`'s token at the reload; `deny manage` removes
it. Agents built before these commands (the `version` in `GET /agents`)
say `unknown command …`: run the install command again first. On Proxmox
VE it creates `whombat@pve` (PVEAuditor, token `agent-<node>`) and, with
`manage = true`, `whombat-manage@pve` (roles `WhombatManage`,
`WhombatNetwork`). None of it overlaps with a Rackoon agent, so a server
can run both (each reports to its own hub). `--uninstall` / `--purge`
remove the Whombat agent only.

Agents reach the box only from private networks (the appliance's firewall
allows 8443 from private ranges). The agent URL is baked into each agent's
`agent.toml`: if the box's LAN address changes, run the installer again
(either way in: it keeps the identity and re-points `hub`), or `whombat-agent
hub wss://<new address>:8443` on the server.

## 7. Notes for the appliance (stream N)

- Unit: user and group `whombat-hosts` (965), `ExecStart` as in §1,
  `RuntimeDirectory=whombat-hosts` (mode 0750 so the server's group can
  reach the socket; the hub creates the socket 0660), `ReadWritePaths`
  the data directory. The hub writes only `--data`, the token file and the
  socket.
- **The token file must be readable by the Whombat server**: mode 0640
  with group `whombat-hosts`, and every directory above it traversable by
  that group. `/persist/hosts` at 0700 blocks it: use 0710 (or 0750) for
  `/persist/hosts`, or put the token in its own directory.
- `--agent-url auto` reads `/proc/self/net/route` (then `/proc/net/route`) and the interface addresses
  (netlink): allow `AF_NETLINK` next to `AF_UNIX AF_INET AF_INET6` for the
  exact answer; without it the hub falls back to a UDP "connect" (no packet
  sent), which picks the same source address on a single-homed box.
- Ping checks use unprivileged ICMP sockets (`net.ipv4.ping_group_range`
  must include gid 965) or `CAP_NET_RAW`.
- `--agent-dist`: `whombat-agent-linux-amd64`, `whombat-agent-linux-arm64`,
  `whombat-agent-darwin-amd64`, `whombat-agent-darwin-arm64`,
  `whombat-agent-windows-amd64.exe`, `whombat-agent-windows-arm64.exe`
  (`make agents` builds all six; `GET /install.ps1` on the agents' address
  serves the Windows installer with their SHA-256s, and a hub without the
  `.exe` files makes no Windows line), the signed `manifest.json` (`rackoon-sign manifest`;
  `appliance/dev/sign-agents`; a darwin entry carries `"os":
  "darwin"`; the helper's entry `whombat-helper-macos.zip` is `{"os":
  "darwin", "arch": "universal", "version", "size", "sha256", "sig"}`) and,
  for Macs, `whombat-helper-macos.zip` with `whombat-helper-macos.json`
  (`{"version", "sha256", "size", "team"}`; without them Macs install
  without the helper; without the manifest's entry the hub doesn't update
  it). Without the manifest agent self-update is off
  (`reason_code: no_build`). The round's timing: `--agent-update-grace`,
  `--agent-update-after-connect`, `--agent-update-interval`.
- Health: `curl --unix-socket /run/whombat-hosts/api.sock http://hosts/healthz`.
- The self guest: the hub reads `/sys/class/net/*/address` (sysfs stays
  readable under `ProtectSystem`; do not set `PrivateNetwork`, which would
  show only `lo`). Inside the DEV box the VM's own card is the Incus
  instance's `volatile.eth0.hwaddr` on its Incus host.
