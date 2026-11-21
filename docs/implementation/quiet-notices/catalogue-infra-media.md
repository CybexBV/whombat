# Quiet notices: catalogue for the infra and media kinds

Scope: `apps/server/src/things/kinds/infra/` — `opnsense.ts`, `cloudflare.ts`, `portainer.ts`, `nginx-proxy-manager.ts`, `grafana.ts`,
`pterodactyl.ts`, `tailscale.ts`, `shared.ts`; `kinds/media/` — `arr.ts` (Sonarr and Radarr), `plex.ts`, `sabnzbd.ts`, `seerr.ts`,
`nzbhydra.ts`, `common.ts`, `ui.ts`. Read at `main` 06e42934 (2026-10-22).

Columns (same as the other catalogues):
- **Id now**: the notice `id` and where it is built. *static* = one fixed id for the check; *per item* = the id carries an item id;
  *groups* = one line stands for several items. “≤ 5” = only the first five items get a line.
- **Dot now**: whether it colours the sidebar dot / card reason / desk look (the 5-minute glance). bad/warn do, info doesn't.
- **Subject**: what the notice is about, and the stable id the reader's snapshot already has for it.
- **Lifts when / episode**: what “Ignore (until it changes)” waits for, and the episode part of the key, if any.
- Key proposal everywhere: `<check>:<subject id>[:<episode>]`. Never the title: titles here carry counts, ages, clock times and
  percentages that change between passes (“is firing for 3 h”, “switched off after errors until Thu 21:00”, “ends in 12 days”,
  “Downloads paused for 2 h”, “is losing 6.2 % of its packets”).

How the 5-minute pass works for these kinds: `home/health.ts` `checkConnectionHealth` → `registry.ts` `seen` → each kind builds its
full view from a cached read (`cachedRead`, 30 s) and keeps only the glance: `cardOf` (`infra/shared.ts:293`) or `seenFromView`
(`registry.ts:81`): status = worst notice tone, reason = that notice's title. The desk's look (`desk/glance.ts:581` `deskLooks`) is
one per connection, from that glance. So filtering the kind's notices before `cardOf`/`seenFromView` fixes the dot, the card reason and
the desk look; the page head is a separate story in every infra kind (see each “Status computed outside notices”).

---

## Cross-cutting findings

1. **Not read ≠ cleared.** Almost every part is `optional()`: when a part fails, its notices simply vanish (OPNsense gateways/services/
   status, Cloudflare tunnels/certificates, Portainer containers, NPM answers, Grafana alerts/sources, Sonarr's queue/health, Plex live,
   SABnzbd `rest`, Seerr's lists, NZBHydra's indexer state). An “until it changes” ignore must only lift when the check's own part was
   read in that pass. Each check needs an “evaluated” flag next to its notices.
2. **Caps look like clearing too.** Items beyond a read cap disappear without being fixed: Cloudflare's first 10 sites, Portainer's 5
   environments and 12 image checks, Pterodactyl's 12 live reads (3 activity checks), Grafana's 12 data-source checks and 10 alert
   lines, NPM's 30 asked sites, the 20 rows of the Sonarr/Radarr and SABnzbd queues, SABnzbd's 20 failed, Seerr's 12 requests per list
   and its 10 newest open issues. Same rule: no lift unless the item was within what was read.
3. **Grouped lines** (16, listed in the summary) must be built from per-item keys: filter the items, then group what is left (“2 devices
   keys have expired” becomes “1 …” when one is ignored). Their “Ignore” on the line means “ignore these items”.
4. **Ids built from words.** Sonarr/Radarr health ids include the first 40 characters of the message (`arr.ts:622`), which changes when
   e.g. the list of failing indexers changes. Key on the check's `source` instead.
5. **In-memory state** decides three notices: Pterodactyl's `lastRunning` (`pterodactyl.ts:134`), Plex's scan start (`plex.ts:429`
   `scanSeen`), SABnzbd's pause start (`sabnzbd.ts:301` `pausedSince`). A Whombat restart resets them (“paused for 1 h” starts over).
   If their episode goes into a key, the quiet store should keep the “first seen” itself.
6. **Flapping.** Lifting on the first clean pass makes flapping things re-alert all day (gateway loss, tunnels degraded, NPM answers,
   unhealthy containers, NZBHydra's temporary disables, Plex converting). Suggest: a cleared condition must stay clear for two passes
   (10 min) before an ignore lifts, and the flappy checks also need two bad passes before they colour the dot.
7. **One subject, several kinds.** The same download disk shows in SABnzbd, Sonarr and Radarr (three “… full” notices); “can’t reach
   Sonarr” shows in Seerr and on Sonarr's own card; failing indexers show in NZBHydra and in Sonarr's health; failed downloads show in
   SABnzbd and as “can’t be imported” in Sonarr.
8. **Nature is per condition, not per check** in several places: NPM certificate (Let’s Encrypt → problem, own certificate → you),
   SABnzbd news server (failed login → you, can't connect → problem), NZBHydra indexer (switched off for good → problem, for a while →
   fyi), Portainer stopped container (exit code ≠ 0 → problem, 0 → fyi), Sonarr health (by source), OPNsense status (by level).

---

## OPNsense (`infra/opnsense.ts`, catalog `opnsense`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `gateway-down-<name>` `opnsense.ts:454` — per item | A gateway's status is `down` or `force_down` | bad for the default gateway, warn for others | ask “Look into it” | Yes | The gateway — `OpnGateway.name` (OPNsense's unique gateway name) | **problem** — the internet or a line is down; the assistant can look. `force_down` → **fyi** (someone switched it off in OPNsense) | Status no longer down; no episode | “Ignore until it’s back up” | “Gateways going down” (`opnsense.gateway_down`); **per gateway** | `force_down` is treated as down today: a person's choice shows as bad/warn. Backup WANs, unused VPN and IPv6 gateways can be down for good → Stop watching. dpinger can flap: two passes. |
| `gateway-loss-<name>` `opnsense.ts:467` — per item | Gateway loss > 5 % (`LOSS_WARN`) and not down | warn | none | Yes | The gateway — name | **problem** — a bad line; the assistant can look at the ISP/interface | Loss back ≤ 5 % (suggest ≤ 2 % hysteresis); no episode | “Ignore until the loss stops” | “Packet loss on a gateway” (`opnsense.gateway_loss`); per gateway | One sample of dpinger; 5 % spikes are common. Use the stored `gw_loss_pct` points (default gateway only) over 15 min, or two passes. Non-monitored gateways have no loss figure. |
| `service-<id>` `opnsense.ts:477` — per item, ≤ 5 | A listed service isn't running | warn | button **Start** (none when locked) | Yes | The service — `OpnService.id` (`unbound`, `openvpn/3`) | **problem** — something stopped; the assistant can see why; keep Start, add “Look into it” | Running again; no episode | “Ignore until it’s running again” | “Services stopping” (`opnsense.service_stopped`); **per service** | A service someone stopped on purpose, or an instance not in use (an OpenVPN client, a plugin), stays stopped → Stop watching. Only 5 get lines but the head counts all. |
| `states` `opnsense.ts:485` — static | Firewall states ≥ 90 % of the limit | warn | none | Yes | The firewall (whole) | **problem** — new connections get refused; the assistant can find who uses them | Below 90 % (suggest < 80 % hysteresis); no episode | “Ignore until it’s less full” | “Connection table filling up” (`opnsense.states`); per check only | Bursts (torrents, scans) flap around 90 %: two passes. |
| `opnsense-<key>` `opnsense.ts:493` — per item | An OPNsense system status item (error, warning or notice; banners left out) | warn (error, warning) / info (notice) | url “Open OPNsense” | Yes for error/warning | The status subsystem — `OpnNotice.key` (OPNsense's subsystem key, e.g. the crash reporter, the firewall) | error/warning → **problem** (the assistant reads the message; the crash reporter → **you**: send or dismiss it); notice → **fyi** | Item gone; episode = its message (one subsystem can say several things) | “Ignore until OPNsense says something new” | “OPNsense’s own messages” (`opnsense.status`); per subsystem | OPNsense has its own dismiss for these (its bell; `POST /api/core/system/dismissStatus` in recent versions, to verify): reuse it or at least respect a dismissed item. Crash reports linger until someone deals with them. |
| `reboot` `opnsense.ts:502` — static | Firmware status `needs_reboot` | warn | url “Open OPNsense” | Yes | The firewall (whole) | **you** — Whombat never restarts the firewall; a person picks the moment | No longer needed; episode = installed version (a later update that needs one alerts again) | “Ignore until it’s restarted” | “A restart needed after an update” (`opnsense.reboot`); per check only | — |
| `firmware` `opnsense.ts:511` — static | An update, an upgrade or a new major waits | info | url “Open updates” | No | OPNsense (whole) | **fyi** — nothing is wrong | A different version waits, or none; episode = `latest` (else `major`, else package count) | “Ignore this version” | “OPNsense updates” (`opnsense.updates`); per check | Only as fresh as OPNsense's own last check (the head's Check for updates). |

**Status computed outside notices:** yes. The head badge is `opnsenseStatus` (`opnsense.ts:528`): default gateway down → bad
“Internet down”, its loss → warn, any stopped service (all, not 5) → warn, else ok “Internet 4 ms”; it ignores the other gateways,
the states, OPNsense's messages and the restart. The glance is `cardOf(view, ['internet', 'cpu'], 'Firewall and router')`
(`opnsense.ts:801`) from the notices. The filter has to reach `opnsenseStatus` too (an ignored stopped service would still make the
head say “Unbound stopped”). Figure tones (internet, CPU ≥ 90 %, connections ≥ 90 %) are page-only. Points `gw_delay_ms`/`gw_loss_pct`
are kept whatever is quieted.

---

## Cloudflare (`infra/cloudflare.ts`, catalog `cloudflare`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `tunnel-down-<id>` `cloudflare.ts:444` — per item, ≤ 5 | Tunnel status `down` | bad | ask “Look into it” | Yes | The tunnel — `CfTunnel.id` (tunnel UUID) | **problem** — its cloudflared stopped on one of your machines; the assistant can look | Healthy/degraded/inactive or deleted; no episode (Cloudflare's `conns_inactive_at` would make one; not read) | “Ignore until it’s connected again” | “Tunnels going down” (`cloudflare.tunnel_down`); **per tunnel** | A retired tunnel that was never deleted stays “down” for ever → Stop watching, or suggest deleting it. Smart default: down for more than 30 days → fyi with “Delete it in Cloudflare”. |
| `tunnel-degraded-<id>` `cloudflare.ts:457` — per item, ≤ 5 | Tunnel status `degraded` | warn | none | Yes | The tunnel — UUID | **fyi** while short (it still serves), **problem** when it lasts > 30 min | Healthy again (down hands over to the line above); no episode | “Ignore until it’s healthy again” | “Tunnels losing connections” (`cloudflare.tunnel_degraded`); per tunnel | Flaps on colo maintenance and cloudflared reconnects: two or three passes before it counts. |
| `cert-<zoneId>` `cloudflare.ts:467` — per item (one per site) | The active pack's primary certificate ends in < 14 days (`CERT_WARN_DAYS`); bad once expired | warn / bad | none | Yes | The site's certificate — `CfCertificate.zoneId`; **no certificate id** in the snapshot | **problem** — Cloudflare renews by itself; a stuck renewal is usually DNS/CAA, which the assistant can check | The end date moves; **episode = `expires`** | “Ignore until it’s renewed” | “Certificates ending” (`cloudflare.cert`); per site | Kept an hour. Picks the first active pack: a site with an advanced pack and a universal one may pick the one being replaced. 14 days is fine (Universal renews about 30 days ahead). Only the first 10 sites. |
| `zone-<id>` `cloudflare.ts:480` — per item | Site status not `active` (pending, initializing, moved, …) | warn | none | Yes | The site — `CfZone.id` | **you** — the name servers at the registrar, or deciding to remove a site that moved | Status active, or the site gone; episode = status (pending → moved alerts again) | “Ignore until it’s active” | “Sites not active” (`cloudflare.zone`); per site | `initializing` is a short setup state (fyi on the first day). `moved` stays until someone deletes the site in Cloudflare → Stop watching. |
| `paused-<id>` `cloudflare.ts:493` — per item | Site active but paused | info | none | No | The site — zone id | **fyi** — someone paused it | Unpaused; no episode | “Ignore until it’s unpaused” | “Paused sites” (`cloudflare.paused`); per site | Already info. |
| `api-token` `cloudflare.ts:674` — static, only on the “Sign in with Cloudflare” view | Connected through MCP, not an API token | info | tab “Settings” | No (`seen` returns no status for these) | The connection | **fyi** — a setup hint | Connected with an API token | “Hide this hint” | “The hint to add an API token” (`cloudflare.token_hint`); per check only | — |

**Status computed outside notices:** yes. The head badge is `cloudflareStatus` (`cloudflare.ts:502`): tunnels down → bad, degraded →
warn, sites not active → warn, else ok “N sites”; it ignores certificates and paused sites. The glance is
`cardOf(view, ['requests', 'tunnels'], …)` (`cloudflare.ts:728`) from the notices; for MCP connections the glance has no status at all.
The figure “Tunnels” carries bad/warn tones on the page only.

---

## Portainer (`infra/portainer.ts`, catalog `portainer`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `env-down-<id>` `portainer.ts:362` — per item, ≤ 5 | Environment not up, and not an Edge agent that hasn't checked in yet | bad | ask “Look into it” | Yes | The environment — `PortainerEnv.id` (Portainer endpoint id) | **problem** — Portainer can't reach its Docker | Up again; no episode | “Ignore until it’s back up” | “Environments going down” (`portainer.env_down`); **per environment** | Edge agents on machines that sleep (a laptop) and environments left behind after a machine was retired → Stop watching. |
| `unhealthy-<envId>-<containerId12>` `portainer.ts:376` — per item, ≤ 5 | Docker health `unhealthy` | bad | ask “Look into it” + button **Restart** | Yes | The container — **Docker id changes when it's recreated** (compose up, new image); stable: env id + container name (or Compose project + service label, not kept today) | **problem** | Healthy, starting, no health check, or gone; no episode | “Ignore until it’s healthy again” | “Unhealthy containers” (`portainer.unhealthy`); **per container** (by name) | Docker already waits for several failed checks. A badly written health check that is always unhealthy → Stop watching. |
| `unhealthy` `portainer.ts:392` — static, **groups** (only when no container list could be read) | Portainer's snapshot counts unhealthy containers | bad | url “Open Portainer” | Yes | Several containers — **no ids** (counts per environment only) | **problem** | Count back to 0; episode = the count | “Ignore until they’re healthy again” | Same check; per check only | Portainer's snapshot is a few minutes old. |
| `stopped-<envId>-<containerId12>` `portainer.ts:402` — per item, ≤ 5 | Exited/dead container in a stack or Compose project whose other containers run | warn | none (Restart only in the table) | Yes | The container — same id caveat as above | Exit code ≠ 0 or dead → **problem**; exit 0 → **fyi** (one-shot jobs end like that); 137/143 is usually someone's `docker stop` → **fyi** | Running again or removed; no episode | “Ignore until it’s running again” | “Containers stopping in a stack” (`portainer.stopped`); **per container** (by name) | Main noise source: init, migration, certbot and backup containers in a Compose project exit 0 by design. Today they colour the dot. |
| `images` `portainer.ts:414` — static, **groups** | Business edition says a running container's image is outdated (first 12) | info | none | No | Several containers — names (ids per container available) | **fyi** | The set of outdated containers changes; episode = their names | “Ignore until another image is newer” | “Newer images” (`portainer.images`); per container or per check | Kept an hour; `:latest` tags flip often. |
| `update` `portainer.ts:423` — static | Portainer says an update is available | info | none | No | Portainer (whole); episode = `LatestVersion` | **fyi** | Another version, or none | “Ignore this version” | “Portainer updates” (`portainer.updates`); per check | — |

**Status computed outside notices:** yes. The head badge is `portainerStatus` (`portainer.ts:431`): environments down → bad, any
unhealthy (all, also from snapshots) → bad, stopped in a running stack (all) → warn, else ok “N running”. The glance is
`cardOf(view, ['running', 'unhealthy'], …)` (`portainer.ts:690`) from the notices. Figure tones (Stopped warn, Unhealthy bad) are
page-only.

---

## Nginx Proxy Manager (`infra/nginx-proxy-manager.ts`, catalog `nginx_proxy_manager`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `cert-expired-<certId>` `nginx-proxy-manager.ts:367` — per item, ≤ 5 (one line per certificate, the first site's name) | A switched-on site's certificate has expired | bad | url “Open it” + button **Renew** (Let’s Encrypt only) | Yes | The certificate — `NpmCertificate.id` (kept across renewals) | Let’s Encrypt → **problem** (renewal fails; Renew, or the assistant checks DNS/port 80); own certificate → **you** (upload a new one) | End date moves into the future; **episode = `expires`** | “Ignore until it’s renewed” | “Certificates ending” (`npm.cert`, one check for ending and expired); per certificate | Certificates of internal-only names that can't renew. |
| `cert-ending-<certId>` `nginx-proxy-manager.ts:379` — per item, ≤ 5 | Ends within 14 days (`WARN_DAYS`) | warn | url “Open it” + **Renew** (Let’s Encrypt, within 30 days) | Yes | The certificate — id | As above | **episode = `expires`** | “Ignore until it’s renewed” | Same check; per certificate | NPM renews at 30 days left, so 14 days means its renewal has failed for two weeks: a good threshold. |
| `not-answering` `nginx-proxy-manager.ts:396` — static, **groups** | Whombat's own HEAD/GET from the box times out, fails, refuses the certificate or gets ≥ 500 (first 30 asked sites) | warn | ask “Look into it” | Yes | Several sites — `NpmSite.id` (`p<id>`, `r<id>`) is stable, but the notice id is static → split per site | **problem** | Per site: answers < 500 again; no episode | “Ignore until it answers again” | “Sites not answering” (`npm.site`); **per site** | Asked from inside: hairpin NAT and split DNS make public names fail from the box; LAN-only or IP-restricted sites time out; one try with a 5 s deadline flaps. Two passes before it counts. A backend's 502/503 is counted (rightly). |
| `config-<siteId>` `nginx-proxy-manager.ts:424` — per item, ≤ 5 | A switched-on site's config didn't load (`nginx_online` false) | warn | url “Open it” | Yes | The site — `p<id>` / `r<id>` | **problem** — the assistant can read nginx's complaint | Config loads, or the site is switched off; no episode | “Ignore until its config loads” | “Config errors” (`npm.config`); per site | — |
| `switched-off` `nginx-proxy-manager.ts:434` — static, **groups** | Sites switched off | info | none | No | Several sites — `p<id>` / `r<id>` | **fyi** — someone switched them off | The set changes; episode = their ids | “Ignore until another is switched off” | “Switched-off sites” (`npm.switched_off`); per check | A fact more than a notice: suggest this check off by default. |

**Status computed outside notices:** yes. The head badge is `npmStatus` (`nginx-proxy-manager.ts:446`): expired → bad, not answering
→ warn, config errors → warn, ending within 14 days → warn, else ok. The glance is `cardOf(view, ['sites', 'ending'], …)`
(`nginx-proxy-manager.ts:694`) from the notices; the pass reads answers with `npmAnswers(…, 'pass')` (kept 5 minutes).

---

## Grafana (`infra/grafana.ts`, catalog `grafana`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `database` `grafana.ts:315` — static | `/api/health` says the database isn't ok | bad | ask “Look into it” | Yes | Grafana (whole) | **problem** | Database ok; no episode | “Ignore until it’s reachable again” | “Grafana’s database” (`grafana.database`); per check only | — |
| `alert-<fingerprint>` `grafana.ts:325` — per item, ≤ 10 (critical first, then oldest) | An alert instance is active and not silenced | bad (severity critical/crit/emergency/page/p1/disaster) / warn | url “Open in Grafana” | Yes | The alert instance — `GrafanaAlert.id` (Alertmanager fingerprint, stable per label set); **the rule uid (`__alert_rule_uid__`) isn't kept** | **problem** by default; severity `info`/`none` → **fyi** | Stops firing (fingerprint gone); **episode = `startsAt`** so a new firing alerts again | “Ignore until it stops firing” | “Firing alerts” (`grafana.alert`); **per rule** (needs the rule uid kept), exceptions listed by rule name | Grafana's silences are respected already (suppressed alerts are left out). `DatasourceNoData` / `DatasourceError` alerts are typical noise → fyi. A flapping rule gets a new `startsAt` each time: lift only after 10 min clear. |
| `alerts-more` `grafana.ts:338` — static, **groups** (alerts beyond 10) | More than 10 firing | bad if any of them is critical, else warn | url “Show them” | Yes | Several alerts — fingerprints | **problem** | Per alert, as above | “Ignore until they stop firing” | Same check | Must be counted after the filter, or ignored alerts keep it alive. |
| `source-<uid>` `grafana.ts:346` — per item, ≤ 5 | Data source health says ERROR (first 12 checked) | warn | url “Open it” | Yes | The data source — `GrafanaSource.uid` | **problem** — the assistant can look (credentials, the database behind it) | OK again, or “can’t be checked”; no episode | “Ignore until it works again” | “Data sources failing” (`grafana.source`); **per data source** | Old test data sources nobody uses → Stop watching. Health kept 5 minutes. |

**Status computed outside notices:** yes. The head badge is `grafanaStatus` (`grafana.ts:360`): database → bad, any firing (all, not 10;
bad if one is critical) → bad/warn, failing sources → warn, else ok “Nothing firing”. The glance is `seenFromView(view, { figures: 1 })`
(`grafana.ts:489`) from the notices. “About to fire” (pending rules) is a panel only, never a notice.

---

## Pterodactyl / Pelican (`infra/pterodactyl.ts`, catalog `pterodactyl`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `stopped-<identifier>` `pterodactyl.ts:247` — per item, ≤ 5 | Offline now, seen running in the last day by this Whombat (in memory), and its activity has no person's stop/kill since (12 servers read live, 3 checked) | warn | ask “Look into it” + button **Start** | Yes | The game server — `GameServer.id` (Pterodactyl identifier) | **problem** — it crashed | Running again; **episode = when it was last seen running** (each stop is new) | “Ignore until it’s running again” | “Game servers stopping on their own” (`pterodactyl.stopped`); **per server** | In memory only: a Whombat restart forgets, and the line goes by itself a day after the server was last seen running. A stop by a panel schedule may not count as a person's (to check). Activity that can't be read counts as “nobody stopped it”. |
| `suspended-<identifier>` `pterodactyl.ts:261` — per item, ≤ 5 | Suspended | warn | none | Yes | The game server — identifier | **you** — an administrator lifts it (often billing) | Unsuspended; no episode | “Ignore until it’s unsuspended” | “Suspended game servers” (`pterodactyl.suspended`); per server | Servers suspended on purpose stay so → Stop watching. |
| `install-<identifier>` `pterodactyl.ts:271` — per item, ≤ 5 | Status `install_failed` / `reinstall_failed` | warn | none | Yes | The game server — identifier | **you** — reinstall from the panel; Whombat never reinstalls | Status changes; no episode | “Ignore until it’s installed” | “Failed installs” (`pterodactyl.install`); per server | — |
| `disk-<identifier>` `pterodactyl.ts:278` — per item, ≤ 5 | Disk ≥ 90 % of its limit (first 12 servers) | warn | none | Yes | The game server — identifier | **problem** — the assistant can find what fills it (logs, backups, old worlds); or a person raises the limit | Below 90 % (suggest < 85 % hysteresis); no episode | “Ignore until there’s room again” | “Game server disks filling up” (`pterodactyl.disk`); per server | Games write logs and saves all the time: hovers around 90 % and flaps. |

**Status computed outside notices:** yes, and it disagrees today. The head badge `pterodactylStatus` (`pterodactyl.ts:287`) only knows
“stopped on its own” (warn); suspended, failed installs and full disks colour the dot through the glance
(`seenFromView(view, { figures: 1 })`, `pterodactyl.ts:500`) while the head says ok “3 of 4 running”.

---

## Tailscale (`infra/tailscale.ts`, catalog `tailscale`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `keys-expired` `tailscale.ts:193` — static, **groups** | This tailnet's approved devices whose key has expired | bad | url “Open Tailscale” | Yes | Each device — `TailscaleDevice.id` (nodeId) | **you** — someone signs in on the device | Per device: key renewed (end date moves) or device removed; **episode = `expires`** | “Ignore until it’s signed in again” | “Device keys ending” (`tailscale.key`, one check for ending and expired); **per device** | Abandoned devices (an old phone) keep an expired key for ever. Smart default: expired and offline for over 30 days → fyi with “Remove it in Tailscale”. |
| `waiting` `tailscale.ts:211` — static, **groups** | Devices waiting for approval | warn | button **Approve** (when one) | Yes | Each device — nodeId | **you** — a person decides who joins | Approved or removed; no episode | “Ignore until it’s approved or removed” | “Devices waiting for approval” (`tailscale.waiting`); per device | — |
| `keys-ending` `tailscale.ts:226` — static, **groups** | Key ends within 14 days | warn | url “Open Tailscale” | Yes | Each device — nodeId | **you** — sign in again, or turn off key expiry | Key renewed; **episode = `expires`** | “Ignore until its key is renewed” | Same check; per device | Every person's device hits this every 180 days by default: expected, and right as `you`. For servers the real fix is turning key expiry off. |
| `updates` `tailscale.ts:244` — static, **groups** | Devices whose client can update | info | none | No | Each device — nodeId | **fyi** | The device's version changes; episode = its version | “Ignore until a newer update” | “Tailscale updates on devices” (`tailscale.updates`); per device or per check | — |
| `offline-long` `tailscale.ts:253` — static, **groups** | Approved devices offline for over 7 days | info | none | No | Each device — nodeId | **fyi** | Back online; no episode | “Ignore until it’s back online” | “Devices offline for a week” (`tailscale.offline`); per device | — |

**Status computed outside notices:** yes. The head badge is `tailscaleStatus` (`tailscale.ts:262`): expired → bad, waiting → warn,
ending (expired included) → warn, else ok “N of M online”. The glance is `seenFromView(view, { figures: 2 })` (`tailscale.ts:460`)
from the notices.

---

## Sonarr and Radarr (`media/arr.ts`, catalogs `sonarr`, `radarr`; one code path)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `disk` `arr.ts:613` — static (only the tightest root folder) | Tightest root folder < 10 % free (bad < 5 %) | warn / bad | none | Yes | The root folder — `ArrRoot.path` (Sonarr's rootfolder id isn't kept; the path is) | **problem** — imports stop once it's full; the assistant can find what can go | ≥ 10 % free (suggest 12 % hysteresis); no episode | “Ignore until there’s more room” | “Disk space” (`arr.disk`); per root folder | Shares are eager on big arrays (10 % of 40 TB is 4 TB free): add an absolute floor or use the disk forecast. Same disk shows in Sonarr, Radarr and SABnzbd. Without root folders the config disk counts. |
| `health-<source>-<message40>` `arr.ts:622` — per item | An item of Sonarr's/Radarr's own `/health` | error → bad, warning → warn, notice → info | url “How to fix it” (their wiki) | Yes for error/warning | The check — `ArrHealth.source` (the class name, e.g. `IndexerStatusCheck`); the id today also takes the message's first 40 characters, which change | **By source** (table below); default **problem** | That source's item is gone; episode = its message | “Ignore until Sonarr stops saying it” / “… Radarr …” | “Sonarr’s own checks” (`arr.health`); **one switch per source**, exceptions by source | Sonarr/Radarr re-run checks on events and on their scheduled health check, so a fixed problem can linger a while; the assistant could send the `CheckHealth` command. No dismiss of their own (as far as I know). |
| `imports` `arr.ts:635` — static, **groups** | Queue items (first 20) with a tracked warning/error, import blocked/failed, failed pending, or failed/warning status | warn | url “Open Sonarr” (its queue) | Yes | Each download — `ArrQueueItem.id` (Sonarr's hash of client + download + episode: stable per download); the download id isn't kept | **problem** mostly — the assistant can read the message, import by hand, or remove and blocklist; “not an upgrade” / “matched by id, import by hand” are **you** | Per item: imported, removed, or fine again; no episode | “Ignore until it’s imported or removed” | “Downloads that can’t be imported” (`arr.imports`); per download | Stalled torrents and downloads “not grabbed by Sonarr” in its category sit there for ever. Sonarr v4's own Remove → “Ignore download” is the native equivalent: offering it would really clear it. Only 20 queue rows read. |

Sonarr/Radarr health by source (suggested nature; `type: notice` is always **fyi**):

| Source (examples) | What it says | Nature | Note |
|---|---|---|---|
| `IndexerStatusCheck`, `IndexerLongTermStatusCheck` | Indexers unavailable due to failures (> 6 h for the long one) | **problem** | The short one is Sonarr's own back-off and clears by itself: two passes, or count only the long one. Often the same as NZBHydra's “switched off after errors”. |
| `IndexerRssCheck`, `IndexerSearchCheck` (in the fixtures) | No indexers with RSS sync / automatic search | **problem** | Usually follows the line above. |
| `DownloadClientCheck`, `DownloadClientStatusCheck` | Can't reach the download client | **problem** | Same as SABnzbd's own card being down. |
| `RemotePathMappingCheck` (in the fixtures), `DownloadClientRootFolderCheck`, `DownloadClientSortingCheck`, `ImportMechanismCheck`, `DownloadClientRemovesCompletedDownloadsCheck` | Setup is wrong | **problem** (the assistant explains; changing settings asks first) | Long-lived until someone changes a setting. |
| `RootFolderCheck`, `MountCheck` | Root folder missing / mount read-only | **problem** | — |
| `RemovedSeriesCheck`, `RemovedMovieCheck` | A series/movie was removed from TheTVDB/TMDb | **you** | Stays until someone deletes it; the title is in the message → per-title Stop watching. |
| `UpdateCheck` | An update / can't install the update | **fyi** (can't install → **you**) | — |
| `ImportListStatusCheck`, `NotificationStatusCheck` | Lists / notifications failing | **fyi** (→ problem when it lasts a day) | Low impact. |
| `SystemTimeCheck`, `ProxyCheck` | Clock off / proxy failing | **problem** | — |
| `ApiKeyValidationCheck`, `AppDataLocationCheck`, `RecyclingBinCheck`, release-branch checks | Setup advice | **you** | — |
| `PackageGlobalMessageCheck` | The packager's message | **fyi** | — |

**Status computed outside notices:** no. The head is `statusFrom(notices, downloading → ok “Downloading N items”)` (`arr.ts:812`),
the glance `seenFromView({kpis, notices: arrNotices(input)})` (`arr.ts:922`): filtering `arrNotices` covers both. The Disk free figure
carries its own tone on the page.

---

## Plex (`media/plex.ts`, catalog `plex`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `converting` `plex.ts:537` — static | More than 2 streams converting now | warn | none | Yes | Plex (whole); sessions are fleeting | **fyi** — a heads-up about load; nobody has to act | ≤ 2 converting; no episode | “Ignore until fewer streams convert” | “Many streams converting” (`plex.converting`); per check | Among the noisiest: colours the dot on every busy movie night and flaps with viewing. fyi, or warn only when the machine's CPU is saturated. |
| `remote` `plex.ts:545` — static | Signed in, and the mapping failed or Plex gives a mapping error | warn | url “Open Plex” (server settings) | Yes | Plex's remote access (whole) | **problem** — port forwarding/UPnP; the assistant can check the router (often a person's fix there) | Mapping ok; no episode | “Ignore until it’s reachable again” | “Remote access” (`plex.remote`); per check | People who reach Plex through Tailscale, a relay or a reverse proxy see this for ever → Stop watching. Plex re-tests and fails briefly when the public address changes: two passes. |
| `scan-<uuid>` `plex.ts:559` — per item | A scan/refresh activity seen running ≥ 1 h by this Whombat (in memory) | warn | none | Yes | The run — activity uuid (one per run, so it is its own episode); the library is `PlexActivity.sectionKey` | **fyi** — first scans and metadata refreshes of big libraries take hours; problem only when very long without progress (e.g. > 6 h) | The activity ends | “Ignore until the scan ends” | “Long library scans” (`plex.scan`); per library (section key) | In memory: a Whombat restart starts the hour again. |
| `unmatched` `plex.ts:569` — static, **groups** (summed over libraries) | Movie/show libraries have unmatched items | info | none | No | Several items — counts per library (`PlexLibrary.key`); **no item ids** read | **fyi** — “Fix match” in Plex is a person's, unhurried | More become unmatched; episode = count per library | “Ignore until more go unmatched” | “Unmatched items” (`plex.unmatched`); per library | Home videos in a movie library never match → per library. Kept 30 min. |
| `update` `plex.ts:578` — static | A newer Plex is out | info | none (the head has Check for updates) | No | Plex (whole); episode = version | **fyi** | Another version, or none | “Ignore this version” | “Plex updates” (`plex.updates`); per check | — |

**Status computed outside notices:** no. Head `statusFrom(notices, streams → ok “N streams playing”)` (`plex.ts:726`), glance
`seenFromView({kpis, notices: plexNotices(input)})` (`plex.ts:849`). Filtering `plexNotices` covers both.

---

## SABnzbd (`media/sabnzbd.ts`, catalog `sabnzbd`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `disk` `sabnzbd.ts:443` — static | Download disk < 10 % free (bad < 5 %) | warn / bad | ask “Look into it” (“What can go?”) | Yes | The download folder's disk — **no path or id** in the queue answer (`diskspace1`) | **problem** | ≥ 10 % free (hysteresis); no episode | “Ignore until there’s more room” | “Download disk space” (`sab.disk`); per check | Same eager share threshold as Sonarr; SABnzbd pauses itself at its own minimum free space. Same disk as Sonarr/Radarr's. |
| `failed` `sabnzbd.ts:457` — static, **groups** | Any failed download in the history (`failedTotal`: all of them, however old) | warn | button **Retry all** | Yes | Each download — `SabDone.id` (`nzo_id`) | **fyi** by default — Sonarr/Radarr usually blocklist it and grab another release by themselves; **problem** when several fail within a day (points at a server or account) | A newer failure arrives; **episode = the newest failed `nzo_id`** | “Ignore until another one fails” | “Failed downloads” (`sab.failed`); per check | The biggest noise source here: failed history stays until someone deletes it, so the dot stays yellow for weeks. Count only the last 24 h. SABnzbd's own fix is deleting failed history (`mode=history&name=delete&value=failed`). |
| `server-<host>` `sabnzbd.ts:485` — per item, ≤ 3 | A warning says can't connect / will be ignored / failed login / too many connections for a news server | warn | url “Open SABnzbd” (servers) | Yes | The news server — host name from the warning | Failed login → **you** (account or payment); the others → **problem** | No such warning any more; **episode = the newest matching warning's time** | “Ignore until it works again” | “News servers” (`sab.server`); per server | SABnzbd keeps warnings until they're cleared or it restarts, so this stays after the server recovered. “Will be ignored for 10 minutes” is SABnzbd's own back-off. Respect its Clear (cleared → lifts). |
| `paused` `sabnzbd.ts:496` — static | Paused without a timer, downloads waiting, seen paused ≥ 1 h by this Whombat (in memory) | warn | button **Resume** | Yes | SABnzbd (whole) | **you** — someone paused it; only a person decides to resume (Resume in place) | Resumed; episode = when the pause began | “Ignore until it’s resumed” | “Downloads paused for long” (`sab.paused`); per check | SABnzbd also pauses itself (full disk, quota, its scheduler): the disk line covers the disk case; a nightly scheduled pause warns every night after an hour. In memory: a restart starts the hour again. |
| `warnings` `sabnzbd.ts:508` — static, **groups** | Other SABnzbd warnings | info | button **Clear** (SABnzbd's own) | No | Several warnings — **no ids** (text, time, origin) | **fyi** | A new warning arrives; episode = the newest warning's time | “Ignore until a new warning comes” | “SABnzbd’s other warnings” (`sab.warnings`); per check | Many are “helpful” hints SABnzbd itself lets you switch off (`helpful_warnings`); its Clear already exists. |

**Status computed outside notices:** partly. The head is `statusFrom(notices, …)` (`sabnzbd.ts:692`) but its fallback makes the head
**warn “Paused”** whenever the queue is paused, notice or not; the glance (`sabSeen`, `sabnzbd.ts:799`) comes from the notices only, so the
dot stays green during the first hour of a pause while the head is yellow. Quieting `paused` must also quiet that fallback.

---

## Seerr / Overseerr / Jellyseerr (`media/seerr.ts`, catalog `overseerr`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `unreachable-<name>` `seerr.ts:619` — per item, ≤ 3 | Seerr's request lists report `serviceErrors` for a Sonarr/Radarr server | warn | url “Open Seerr” (services) | Yes | The server as Seerr names it — **name only** (Seerr's server id not kept) | **problem** — approved requests can't go on | No error for it; no episode | “Ignore until Seerr reaches it again” | “Reaching Sonarr and Radarr” (`seerr.unreachable`); per server | Repeats the Sonarr/Radarr card's own “couldn’t reach it”. |
| `failed` `seerr.ts:630` — static, **groups** | Requests in Seerr's failed state (first 12 read) | warn | button **Retry** (when one) | Yes | Each request — `SeerrRequest.id` | **problem** — Seerr couldn't send it on; the assistant can retry or check Sonarr/Radarr | Per request: retried, approved or deleted; no episode | “Ignore until it’s sent on” | “Failed requests” (`seerr.failed`); per request | Failed requests stay until someone acts: long-lived yellow. |
| `old-issues` `seerr.ts:649` — static, **groups** | Open issues created more than 7 days ago | warn | url “Open Seerr” (issues); Mark resolved is in the panel | Yes | Each issue — `SeerrIssue.id` | **you** — someone checks it and marks it resolved | Per issue: resolved; no episode | “Ignore until it’s resolved” | “Issues left open” (`seerr.issues`); per issue | Only the 10 newest open issues are read (`sort: added`), so with many open the oldest are never seen. 7 days may be eager for households that never resolve issues. |
| `restart` `seerr.ts:667` — static | Seerr says a restart is needed | warn | none | Yes | Seerr (whole) | **you** — “Whombat leaves that to you” | Restarted; no episode | “Ignore until it’s restarted” | “A restart needed” (`seerr.restart`); per check | — |
| `moved` `seerr.ts:676` — static | Version < 3 (Overseerr or Jellyseerr) | info | url “How to move” | No | Seerr (whole) | **fyi** | Moved to Seerr 3; no episode | “Ignore until it’s moved to Seerr” | “Moving to Seerr” (`seerr.moved`); per check | Permanent for people staying on Jellyseerr → Stop watching. |
| `security` `seerr.ts:685` — static | Seerr 3.0–3.3 | warn | url “Seerr’s releases” | Yes | Seerr (whole); episode = version | **you** — update Seerr (problem if Whombat manages the machine it runs on) | Version ≥ 3.4 | “Ignore until it’s updated” | “Known security problems” (`seerr.security`); per check (better not stopped) | — |
| `update` `seerr.ts:694` — static | Seerr says an update waits | info | none | No | Seerr (whole); episode = version | **fyi** | Version changes, or no update | “Ignore this update” | “Seerr updates” (`seerr.updates`); per check | Develop builds report being behind all the time. |

**Status computed outside notices:** no. Head `statusFrom(notices, pending → ok “N waiting for you”)` (`seerr.ts:715`), glance
`seenFromView` of the notices (`seerr.ts:788`). Note: requests waiting for approval are **not a notice** (only the warn-toned
“Waiting for you” figure and the head badge), so they never colour the dot or reach the desk, unlike Tailscale's devices waiting.

---

## NZBHydra2 (`media/nzbhydra.ts`, catalog `nzbhydra`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `off-<name>` `nzbhydra.ts:280` — per item, ≤ 5 | Indexer `DISABLED_SYSTEM` (for good) or `DISABLED_SYSTEM_TEMPORARY` | bad when no indexer works, else warn | url “Open NZBHydra2” (indexer statuses) | Yes | The indexer — `HydraIndexer.name` (NZBHydra's unique name; **no numeric id**) | For good → **problem** (often **you**: an expired key or account, the last error tells); for a while → **fyi** unless none works (then problem) | Enabled again (or switched off by the user); episode = state (temporary → for good alerts again) | “Ignore until it’s working again” | “Indexers switched off after errors” (`hydra.indexer_off`); per indexer | Temporary disables are NZBHydra's own back-off and end by themselves: they flap. Its title carries “until Thu 21:00”. |
| `limit-<name>` `nzbhydra.ts:297` — per item | API or download hits ≥ 90 % of the daily limit | warn | none | Yes | The indexer — name; episode = the day (NZBHydra also gives `apiResetTime`/`downloadResetTime`, not parsed) | **fyi** — nothing to do until it resets | The limit resets | “Ignore until the limit resets” | “Daily limits” (`hydra.limit`); per indexer | Heavy users reach it by design; the dot shouldn't go yellow for it. |
| `vip-<name>` `nzbhydra.ts:311` — per item | VIP ends within 14 days (info) or has ended (warn); switched-off indexers included | info / warn | none | Yes once ended | The indexer — name; **episode = `vipEnds`** | Ending → **fyi**; ended → **you** (renew, or update the date in NZBHydra2) | The date moves later | “Ignore until it’s renewed” | “VIP memberships ending” (`hydra.vip`); per indexer | The date is typed in by hand and often left stale. Indexers switched off by the user still warn: leave them out. |
| `old` `nzbhydra.ts:326` — static | Version < 9 | info | none | No | NZBHydra2 (whole) | **fyi** | Updated | “Ignore until it’s updated” | “Old NZBHydra2 version” (`hydra.old`); per check | — |

**Status computed outside notices:** no. Head `statusFrom(notices, null)` (`nzbhydra.ts:456`), glance `seenFromView` of the notices
(`nzbhydra.ts:514`).

---

## Summary

**61 notice sites** (Sonarr and Radarr share three): OPNsense 7, Cloudflare 6, Portainer 6, Nginx Proxy Manager 5, Grafana 4,
Pterodactyl 4, Tailscale 5, Sonarr/Radarr 3, Plex 5, SABnzbd 5, Seerr 7, NZBHydra2 4.

**Proposed nature (default per site):** problem 30 · you 12 · fyi 19.
- Splits within one site: OPNsense status (notice → fyi, crash reporter → you), OPNsense gateway (`force_down` → fyi), Cloudflare
  degraded (fyi → problem after 30 min), Portainer stopped (exit 0/137/143 → fyi), NPM certificates (own certificate → you), Grafana
  alerts (severity info → fyi), Sonarr health (by source), SABnzbd failed (several in a day → problem), SABnzbd server (failed login →
  you), NZBHydra off (temporary → fyi), NZBHydra VIP (ending → fyi, ended → you).
- Today 44 sites always colour the dot (bad/warn), 14 never (info), 3 by level. Demoted to fyi but colouring the dot today: Cloudflare
  degraded, Plex converting, Plex long scan, SABnzbd failed, NZBHydra daily limit, NZBHydra temporary off, Portainer exit-0 stops,
  OPNsense `force_down`.

**One line for several items (16):** Portainer `unhealthy` (aggregate) and `images`; NPM `not-answering` and `switched-off`; Grafana
`alerts-more`; Tailscale `keys-expired`, `waiting`, `keys-ending`, `updates`, `offline-long`; Sonarr/Radarr `imports`; Plex `unmatched`;
SABnzbd `failed` and `warnings`; Seerr `failed` and `old-issues`. (Sonarr/Radarr `disk` names only the tightest of several root folders.)

**No stable id (or a weak one):** Cloudflare certificate (no certificate id: zone id + expiry); Portainer containers (Docker id changes
on recreate: use env + name); Portainer aggregate unhealthy (counts only); Grafana rule (only the instance fingerprint is kept);
Sonarr/Radarr health (no id; `source` is stable, the message isn't); Sonarr/Radarr disk (path only); SABnzbd disk (nothing); SABnzbd
warnings (text + time); Seerr unreachable (server name); NZBHydra indexers (name only); Plex unmatched (counts per library); Plex scan
(uuid per run).

**Status/glance computed outside notices:** all seven infra kinds have their own head badge (`opnsenseStatus`, `cloudflareStatus`,
`portainerStatus`, `npmStatus`, `grafanaStatus`, `pterodactylStatus`, `tailscaleStatus`) next to a glance from notices
(`cardOf`/`seenFromView`); Pterodactyl's already disagrees with its dot. Media kinds derive the head from notices (`statusFrom`), except
SABnzbd's “Paused” fallback (warn without a notice).

**Open design questions**
1. Should Ignore also act in the service where it can (Grafana silence, SABnzbd Clear warnings / delete failed history, OPNsense
   dismiss, Sonarr “Ignore download”)? That writes to the service and affects everyone using it.
2. How is “until it changes” protected from read gaps, caps and flapping (an evaluated flag per check; clear for two passes)?
3. Should the infra heads be rebuilt as `statusFrom(filtered notices, otherwise)` like the media kinds, so one filter covers page head,
   card, dot and desk?
4. One subject across kinds (the download disk in SABnzbd/Sonarr/Radarr, Sonarr's reachability in Seerr): one quiet for all?
5. Should Seerr's requests waiting for approval become a `you` notice, like Tailscale's devices waiting?
6. Is quieting per connection (everyone in the burrow) and limited to managers, or per person?
