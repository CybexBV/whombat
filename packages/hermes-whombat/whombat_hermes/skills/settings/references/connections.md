# Connections, servers and services

## Settings → Connections (`connections`)

Your accounts (Google, Microsoft, mail), apps and services, and what needs you there.

- Read which services can be connected — `connections.catalog` · read
- Check a connection again — `connections.check` · change
- Connect a service with a token — `connections.create` · theirs: send them there
- Remove a connection and its tools — `connections.disconnect` · change, always asks
- Read the connected accounts and services — `connections.list` · read
- Check a connection again and read its tools — `connections.recheck` · change
- Disconnect an account and forget it — `connections.remove` · change, always asks
- Replace the token of a connection — `connections.setSecret` · theirs: send them there
- Read the tools of a connection and their settings — `connections.tools` · read
- Rename a connection — `connections.update` · change (`body.fields`, `body.access` theirs)
- Connect a mailbox over IMAP — `connectors.imapConnect` · theirs: send them there
- Remove the app a service signs in with — `connectors.removeApp` · change, always asks
- Remove the Google app and disconnect Google — `connectors.removeGoogleApp` · change, always asks
- Remove the Microsoft app and disconnect Microsoft — `connectors.removeMicrosoftApp` · change, always asks
- Save the app a service signs in with — `connectors.setApp` · theirs: send them there
- Save the Google app — `connectors.setGoogleApp` · theirs: send them there
- Save the Microsoft app — `connectors.setMicrosoftApp` · theirs: send them there
- Read which Google and Microsoft apps are set up — `connectors.status` · read

## Overview (`overview`)

Every server and service with its own page: how it is doing, what Whombat watches, its settings.

- Look for services on the home network — `connections.discover` · change
- Hide a found service or show it again — `connections.hideFound` · change
- Say which server a service runs on — `connections.setRunsOn` · change
- Choose what a device connection may do and switch it on — `deviceSkills.decide` · theirs: send them there
- Decline a proposed device connection — `deviceSkills.decline` · theirs: send them there
- Acknowledge or snooze a server alert — `hosts.ackAlert` · change
- Read whether this Whombat’s address changed and who hasn’t found it — `hosts.addressChange` · read
- Read whether server agents update by themselves — `hosts.agentSettings` · read
- Add a check on a server or website — `hosts.createCheck` · change (`body.target` always asks)
- Mute server alerts for a while — `hosts.createMaintenance` · change
- Read all servers and how they are doing — `hosts.fleet` · read
- Read a virtual machine or container — `hosts.getGuest` · read
- Read a server and how it is doing — `hosts.getServer` · read
- Read how a server task went — `hosts.getTask` · read
- Start, stop, restart or snapshot a virtual machine or container — `hosts.guestAction` · change, always asks
- Read a guest’s charts — `hosts.guestMetrics` · read
- Look inside a server: services, disks, network and more — `hosts.inspect` · read
- Read the server alerts — `hosts.listAlerts` · read
- Read the checks on servers and websites — `hosts.listChecks` · read
- Read the virtual machines and containers of a server — `hosts.listGuests` · read
- Read when server alerts are muted — `hosts.listMaintenance` · read
- Change a Proxmox, Incus, unRAID or KVM server or guest — `hosts.manage` · change, always asks
- Read a guest’s settings, backups, storage and tasks — `hosts.manageRead` · read
- Remove a check — `hosts.removeCheck` · change, always asks
- Remove a muted period for server alerts — `hosts.removeMaintenance` · change, always asks
- Remove a server from Whombat — `hosts.removeServer` · change, always asks
- Restart or shut down a server — `hosts.serverAction` · change, always asks
- Read a server’s charts — `hosts.serverMetrics` · read
- Read a server’s group, place and remote-control switches — `hosts.serverSettings` · read
- Set up a server by signing in to it once — `hosts.startInstall` · theirs: send them there
- Read how the servers are doing — `hosts.status` · read
- Take back an acknowledged or snoozed server alert — `hosts.unackAlert` · change, always asks
- Update a server’s agent now — `hosts.updateAgent` · change, always asks
- Keep server agents up to date by themselves, or stop — `hosts.updateAgentSettings` · change, always asks
- Change a check or switch it off — `hosts.updateCheck` · change (`body.target`, `body.enabled` always ask)
- Rename a server or change its group, place, parent or remote-control switches — `hosts.updateServer` · change, always asks
- Arrange the Overview: what each tile shows, its size and place — `overview.arrange` · change
- Read what the Overview’s tiles can show — `overview.figures` · read
- Read what the assistant runs on the box — `services.list` · read
- Stop a service the assistant runs — `services.stop` · change, always asks
- Change a service’s setting, or run an action on it like Restart — `things.action` · change, always asks
- Read how a connection or device is doing — `things.page` · read
- Ignore or snooze a Worth a look line — `things.quiet` · change
- Stop or start watching a check on a connection or device — `things.setWatch` · change
- Read what Whombat watches on a connection or device — `things.watch` · read
- Read the widgets on the Overview — `widgets.list` · read
- Move a widget on the Overview — `widgets.move` · change
- Remove a widget from the Overview — `widgets.remove` · change, always asks
