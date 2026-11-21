# What Whombat watches starts calm (WD)

John, 2026-10-30 (main checkout): “In Whombat we have things that ‘Whombat watches’ in Services / servers. For example
in Fusebox it's watching failing requests, a week running out early, etc. These are things that are normal things in
Fusebox and make no sense for Whombat to take action for. I think the majority of ‘What Whombat watches’ should be
turned off and turned on manually by the user. Only things that are VERY important and Whombat can actually take care
of or provide useful information for should be turned on by default.” He asked for a full review of every service and
server, and for a rule future services follow (`CLAUDE.md`, “What Whombat watches”).

Changes `quiet-notices.md` QN-S10 (“every check starts on”).

## The rule

| # | Decision | Why |
|---|---|---|
| WD-01 | **A check starts on only when both hold.** It is very important: the thing or part of it is down or broken now, data is at risk (storage failing or full, a backup not happening or failing), a security opening (an alarm, a door, a known hole), money being lost, or Whombat can no longer reach or read the thing. *And* Whombat can do something with it: the assistant can look into it or fix it, or only the person can and Whombat says what to do. **Everything else starts off**: updates and versions, forecasts and near limits, usage, quotas and limits, the service's own catch-all warnings and messages, what is normal in that service (a request that failed and was retried, a failed download, an indexer resting, a busy moment), what someone did on purpose (paused, switched off, suspended), advice about settings, warm or slow parts. | John's rule. Most of what Whombat could say is information the service shows itself; a line that asks for a look should be one worth a look. |
| WD-02 | **Off from the start is the same as switched off** (QN-13): no line on the page, no dot, nothing in Needs you, on the desk, in a message or the assistant's looks; the page's figures and tables stay. The person turns it on with the same switch in What Whombat watches; a check that starts off and is off shows no “Off since”. | One meaning of “off”, and nothing to learn. |
| WD-03 | **Turning one on is kept** (`watch_ons`, migration 0020; owner the thing's burrow, always the whole check) and signed in the thing's Activity (“Started watching “Firmware updates””); turning it off again removes the row. Per-item Stop watching, Ignore and Remind me tomorrow work as before on a check that is on. A check someone switched off before keeps its off row; turning it on takes that back too. | Kept until undone, like an off. |
| WD-04 | **Every check says whether it starts on** (`startsOn`, required on `KindCheck` and the contract's `HostWatchCheck`): a new service decides per check when it is written. The lists register themselves (`things/quiet/defaults.ts`, as Home's sources do: the kinds read through modules that ask it); a check id shared by kinds (`media.disk`, `crm.overdue`, `git.*`, `conn.signin`) has one decision, and fewer than half of all checks start on (`defaults.test.ts`). A check no list names stays watched; a server hint kind this version doesn't know starts off. | A forgotten decision fails the build, not the person's calm. |
| WD-05 | **Servers' alert rules** are the hosts service's: Whombat switches the rules that start off off there itself (`PUT /servers/{id}/watch`, as Whombat) on every server where nobody turned them on, in the 5-minute pass (`quietServerPass`), so they show nowhere and their open alert resolves; a new server gets them at the next pass. Turning one on switches it on there and keeps a `watch_ons` row, which the pass leaves alone. An alert rule this version doesn't know stays on. Hint kinds are left out in Whombat (`markHints`). | The hosts service already drops what a switched-off rule would raise, everywhere at once (dot, banner, card, Watch, the desk, the assistant's reads). |
| WD-06 | **Nothing is migrated.** At the update, checks that start off go quiet on every Whombat, also those someone had ignored (their rows hold nothing until the check is on). | The defaults are the point; whoever wants one back turns it on. |
| WD-07 | **Words**: the toast after turning a check on is “Whombat watches {name} now.” (no “again”, which was wrong for a check that started off). | Plain and true either way. |

## The review (2026-10-30)

What starts on. Every other check starts off (the full list with natures: `startsOn` beside each check in the code).

| Where | Starts on | Starts off (examples) |
|---|---|---|
| Every connection | Whether it answers, whether it's still signed in, its sign-in and tools, its disk | New tools to decide on, reading its details, when its disk will be full |
| Devices, mail | Whether it answers, whether it's still signed in | Readings it can't read, counting unread mail |
| Home Assistant | Recovery mode, integrations not loading, backups | Repairs, an integration filling the log, updates, devices not answering |
| UniFi Network | The gateway offline, access points and switches offline | A busy gateway, firmware updates |
| Hetzner | Servers not running, traffic past what's included (it costs money) | No Hetzner backups, delete protection off |
| Fusebox | Expired sign-ins | Claude or ChatGPT used up, a week running out early, failing requests, its usage history, its own warnings, one subscription used up or switched off |
| NZBHydra2 | — | All: indexers resting, VIP ending, daily limits, an old version |
| Seerr | Reaching Sonarr and Radarr, versions with known security problems | Failed requests, open issues, a restart it needs, moving to Seerr, updates |
| Plex | Reaching Plex from outside | Converting, long scans, unmatched items, updates |
| Sonarr, Radarr | The media disk filling up | Their own health checks, downloads that can't be imported |
| SABnzbd | The download disk filling up, news servers not working | Paused downloads, failed downloads, its other warnings |
| ESPHome | — | All: devices offline, installs that fail, older versions |
| UniFi Protect | The alarm, cameras offline | Following detections |
| UniFi Access | Doors left open or kept unlocked, readers and hubs offline | — |
| Pi-hole, AdGuard Home | DNS stopping | Blocking or lists switched off, lists failing or old, its own warnings, new versions |
| Cloudflare | Tunnels down, certificates ending | Tunnels losing connections, sites not active or paused, the API token hint |
| Grafana | Its database, firing alerts | Data sources failing |
| Nginx Proxy Manager | Certificates ending, sites not answering | Config errors, switched-off sites |
| OPNsense | Gateways down, services stopping | Packet loss, the connection table filling up, its own messages, a restart after an update, updates |
| Portainer | Environments down, unhealthy containers, containers stopping in a stack | Newer images, updates |
| Pterodactyl | Game servers stopping on their own | Suspended servers, failed installs, game server disks filling up |
| Tailscale | Device keys ending | Devices waiting for approval, updates, devices offline for a week |
| Paperless-ngx | Its own checks (database, worker), the disk filling up | Imports failing, the classifier, updates |
| Nextcloud | Free space running out | Not an admin account, updates, app updates |
| Proxmox Backup Server | Datastores unusable or full, guests without a recent backup, backups failing verification, jobs failing | Full within a month, other tasks failing, old guests in the backups |
| TrueNAS | Storage not working, damage found, storage filling up, snapshot, replication and cloud tasks, apps that crashed | Data checks overdue, its other alerts, disks running hot, updates |
| Immich | The disk filling up, missing or changed files | Paused queues, failed jobs, updates |
| Synology | Storage not healthy, volumes filling up, disks to replace, Hyper Backup failing or late | Partly done backups, disks running hot, Security Advisor, DSM updates, storage for administrators only |
| QNAP | Volumes filling up, disk health | Its own system health, disks running hot, running warm |
| Mollie | Chargebacks, many payments failing today | Only test payments |
| Moneybird | — | Invoices over 30 days late, bank lines to match |
| Plausible | A busy site with no visitors today | — |
| HubSpot, Pipedrive | — | Overdue tasks and activities |
| GitLab, Forgejo, GitHub Actions | Runners going offline | Default branches failing, jobs waiting for a runner |
| Todoist | — | (watches nothing) |
| Servers: alerts | Not checking in, running too hot, disks worn out, failing or with errors, disks filling up or about to, storage missing a disk or damaged, mirrors missing a disk, disks that can't be written or have no room for files, a cluster losing touch, backups and copies failing, Ceph, running on battery, fans stopping, out of memory, restarting over and over | Running hot, disks wearing out, machines given more processors or memory than the server has, the clock out of sync, a network cable unplugged |
| Servers: hints | Apps not working, Incus, libvirt and Unraid storage filling up, machines not backed up or with an old backup or in no backup plan, the Unraid array stopped, parity and array disk errors, Whombat's helper not updating or needing one more install | Getting warm, memory low or spilling to disk, disks getting full in weeks, disk wear and counters, parts Whombat can't read, background services stopping, updates of any kind, a restart needed, slowed down by its host, data checks overdue, disks syncing, backup warnings, the platform's own warnings and messages, machines out of their memory, guest agents, pending changes, old snapshots, storage promising more than it has, the helper out of date |
