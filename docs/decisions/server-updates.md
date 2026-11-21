# Workstream: software updates on servers (2026-10-19)

John, 2026-10-19 (main checkout): “I want to be able to install software updates via Whombat on, for example, Proxmox
or Debian, etc. Research both issues and implement it fully.”

What was there: the agent on a server lists the updates its package manager has waiting (the hosts service
`internal/agent/pkgs`, read-only, never refreshes), the System tab shows “N updates waiting, M for security” and
“Restart: Needed”, Look inside lists the packages, and the Summary's Worth a look links there. Nothing could install
them: the only way was `server_command` (`apt full-upgrade` as root, cut off after 120 s, its output only at the end)
or the proxmox skill's `nohup … &` over SSH.

Decided by the lead (feedback-decide-yourself). Not in the mocks (B-05): the UI follows the System tab's Health card
on the web and the server screen on the phone as they are.

Numbering: SWU-01… here; contracts CT-500…CT-529 (0.98.0); hosts HS-119…; server stream SWU-S01…
(`server-updates-server.md`); app AP-2860…AP-2899 (`server-updates-app.md`); candidate 0.110.0 / IN-313.

## What it does

- **SWU-01 Install the waiting updates of a server's operating system** where its package manager is one the agent
  already reads: apt (Proxmox VE, Proxmox Backup Server, Debian, Ubuntu), dnf/yum (Fedora, RHEL, Rocky, Alma), zypper
  (openSUSE), apk (Alpine), pacman (Arch). Not: unRAID (its plugins and containers have their own updates, IU-07; its
  OS needs a reboot, IU-10), NixOS (Whombat's own appliance: declarative, updated by its releases), TrueNAS (its own
  updater; the agent refuses with “TrueNAS installs its updates itself, on its Update page.”). A container with its own
  agent is a server like any other.
  *Why:* John named Proxmox and Debian; the agent already knows the other managers, and refusing the three that update
  themselves another way is honest.
- **SWU-02 Two actions: Check for updates and Install updates.** Check refreshes the package lists (`apt-get update`,
  `dnf makecache`, `zypper refresh`, `apk update`; pacman has no safe refresh without upgrading, so Check reads the
  cache again) and reads the waiting updates again. Install refreshes the lists and installs everything waiting —
  apt's `dist-upgrade` (Proxmox's rule: never `apt upgrade`, which can leave Proxmox half upgraded), `dnf upgrade
  --refresh`, `yum update`, `zypper update` (`dup` on Tumbleweed), `apk upgrade`, `pacman -Syu` — or only the named
  packages (apt `install --only-upgrade`, dnf/yum/zypper/apk by name; pacman refuses: partial upgrades break Arch).
  *Why:* the counts come from the cache, which is only as fresh as the last refresh; a full upgrade is what each
  distribution documents as the safe one.
- **SWU-03 Never a new release, never a repository change, never a held package.** No `do-release-upgrade`, no
  `pve8to9`, no edits to `sources.list`; held packages stay held; changed configuration files keep the local version
  (`--force-confdef --force-confold`). A major upgrade stays a person's project (the proxmox skill already says so).
- **SWU-04 It runs on the server as a task, outside the agent.** A transient systemd unit (as `server_command` already
  does), so it keeps going when the upgrade restarts services or the agent itself, and a lost connection doesn't stop
  it; its output goes to a log the task's status pages through (the hub's existing task view, `task.status`). One
  package task at a time per server; while another program holds the package lock it waits up to two minutes, then
  refuses (“Another program is installing packages on {server} right now. Try again in a few minutes.”). Install can't
  be stopped once it started (an interrupted dpkg is worse than a slow one); Check can. Limits: Check 10 minutes,
  Install 2 hours.
- **SWU-05 It never restarts the server.** Afterwards the waiting updates and “needs a restart” are read again at once
  and shown with their reason (a new kernel). Restarting is the server's existing Restart (`server_power`, which asks
  agents first; SA-03 on the server Whombat runs on). Services that need it restart during the upgrade (needrestart's
  automatic mode on Debian and Ubuntu), as unattended-upgrades does.
- **SWU-06 A Proxmox node without a subscription.** When the enterprise repository refuses (401) but the others
  answer, Install carries on with them and the result says so in one sentence: “The Proxmox enterprise repository
  refused (it needs a subscription); the other repositories were used.” Any other refresh failure stops Install with
  the package manager's own last line.

## Who may, and asking

- **SWU-07 People: owners** (`canManageServers`, as for every server change), from the server's page. **On the
  server:** the agent's and the hub's `manage` switch (“Full control”, SI-06's default); Watch only and Restart and
  consoles can see the updates but not install them (“Installing updates needs Full control on {server}.”). The hub
  runs Check as operator and Install as admin.
- **SWU-08 Agents: `server_updates` (read) and `server_update` (`action`: `check` or `install`, `packages` optional,
  `reason`).** Install asks a person first (`SERVERS_SENSITIVE`: “Installing updates always asks”) unless the server's
  Asks you first is Never (SA-01); on the server this Whombat runs on it always asks, like SA-03, because an upgrade
  there can restart Whombat's own database. Check never asks. “Approve later” works (ONE-10: updates belong at night).
  When the install finishes the conversation gets one plain message (PX-05 `follow`): “PVE-02 is up to date: 23
  updates installed. It needs a restart for the new kernel.”
- **SWU-09 The Asks you first hint names updates:** “Commands, power, updates, deleting and restoring wait for your
  yes.” (SA-08). The skills (`proxmox`, `incus-lxc`) use `server_update` on a server that is in Servers and keep the
  SSH way only for one that isn't.

## What people see

- **SWU-10 Web, System tab, Health card.** The Updates line keeps its words and gets **Install updates** (when updates
  wait and the viewer may) and **Check now**. Install confirms: “Install {n} updates on {server}?” — “{server} keeps
  running while they install, and so do its guests. Services restart when they need to. A new kernel needs a restart
  afterwards; Whombat doesn’t restart {server} on its own.” — **Install updates**. While it runs the line says
  “Installing updates…” / “Checking for updates…” with the task's live log one click away (the existing task dialog),
  also after a reload and on another device (the agent reports its running package task). Afterwards: “Installed {n}
  updates.”, “Nothing to install.” or “Installing updates stopped: {reason}.”, with when. The Restart line gets
  **Restart now** when a restart is needed and the viewer may restart the server (the existing server action, its
  existing confirm). Look inside → Updates gets the same Install updates.
- **SWU-11 Look inside → Updates works on Watch only too.** The hub and agent read the list with the diagnose switch as
  well as the console one (it was gated on console while the web enabled it from diagnose, so a Watch only server
  showed an error).
- **SWU-12 The phone.** The server screen's Summary gets an Updates card (the same line, checked when, needs a restart)
  that opens an Updates screen: the waiting packages (name, now → new, security first), Install updates, Check now,
  the task's progress and result, and Restart now — the web's words.
- **SWU-13 Worth a look and the System tab's hint** about waiting updates gain their way out: “Install them on the
  System tab.” (the phone: “Install them under Updates.”).
- **SWU-14 Feature `hosts.package_updates`.** Clients show the buttons only when the server has it; the agent's support
  shows as the server's report (an older agent refuses with “Update the agent on {server} first.”).

## Not now

- **SWU-15** *Superseded in part by care-plan.md CPL-03, CPL-06: a server's care plan proposes its updates every Sunday in
  the quiet hours for changes, as an automation the person turns on with Go ahead.* Automatic updates on a schedule as a setting (an agent's schedule can already ask to install them, and the
  asks can be approved later), rolling a cluster one node at a time as one action (the proxmox skill's job, node by
  node), unattended-upgrades configuration, Docker image updates on servers that aren't unRAID, major release upgrades.
