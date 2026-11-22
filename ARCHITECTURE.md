# Whombat architecture

Whombat is one person's device: a box (the appliance) that holds one workplace, a "burrow", with one AI agent. The
person talks to the agent in their Chat (one threaded room) and works with it through plans, runs, approvals,
canvases, search, automations and connections to their servers and services. Every write is checked against the
agent's permission keys and signed into an audit log. Nobody else signs in; outsiders (website feedback reporters,
a report tracker's customers, whoever mails the person) only send things in, and what they send runs apart from the person's
things.

This file describes how Whombat is built today. The reasons behind it are in `DECISIONS.md` and the files under
`docs/decisions/` (index: `docs/decisions/README.md`). The product spec is `docs/design-handoff/README.md`, the visual
references are mapped by that handoff to the screens they cover.

## Processes and how they talk

```
 the person's devices (web app, Android) ── Noise XX session ── through the relay, or directly
                                                                  (local network, Tailscale)
                                                                            │
 the box ───────────────────────────────────────────────────────────────────▼──────────────────────
   server     the session endpoint: enrolment, the dispatcher, durable commands, events, streams
              loopback HTTP: /internal/runner/* (runner token) · /mcp (agent token)
                             /ai-gateway/* (a turn's model calls) · /internal/demo/*
              unix sockets: admin (manager, backups), sign-in (runner), desk screen
   runner     claims turns and runs them in Hermes Agent inside a sandbox (one long-lived pod)
   agent-net  the network proxy for the agent's commands (its own user)
   Postgres   all durable state, full-text search, canvas documents, the session event log
   beside it  (from appliance/ and hosts/) the manager, rootless Podman for the agent's
              containers, the hosts service (monitored servers), the support service (remote help),
              presence, voice (speech and its model fetcher) and Bluetooth services

 server ── the person's GitHub sign-in, polled ──► github.com
```

- **server** (`apps/server`) is the only writer to the database: every change goes through the commit pipeline. Its
  HTTP listener is loopback-only; the person's devices reach it only through the encrypted session, and nothing from
  GitHub comes in (a poller reads).
- **runner** (`apps/runner`) turns queued dispatches into Hermes turns, runs the person's sign-ins to Claude and
  ChatGPT, and is the only process that touches Hermes's homes. The agent acts on Whombat only through the server's
  MCP tools, authenticated as the agent, so the keys engine and signing apply to it as to the person.
- **agent-net** (`apps/agent-net`, `whombat-agent-net`) is the proxy for every command of the agent: any public
  address but port 25, the home networks, production servers only through an opening; the runner sets its rules.
  Destination checks reuse a bounded cache of parsed CIDR strings and evaluate the current host facts, policy
  lists and openings on every connection. Each opening comes with a time limit the runner renews with every policy
  (at most 90 s): the daemon closes it by itself when that runs out and cuts the tunnels to production servers it
  carried, so a runner that stopped or a lost removal can't keep one open (`docs/decisions/net-openings.md`).
- **The container engine** is the appliance's rootless Podman with Docker's API, as its own user; the agent's
  commands get it as `DOCKER_HOST`. What the agent keeps running is a container labelled `whombat.service=1` with a
  port in 20000–20099 (at most five, private networks only), which the person can stop in Settings → Advanced →
  Running (`apps/server/src/agent-services/`).
- **`whombat` CLI** (`apps/cli`) is the runtime bundle's `bin/whombat`, run by the appliance's update helper:
  `schema-check`, `migrate` and `version`.

The appliance's units run the bundle's server, runner and agent-net; `pnpm dev` runs the same three as a development
box (see Local environment).

## The box and the encrypted session (`apps/server/src/managed/`)

`managed/boot.ts` starts the session endpoint: a relay client (tickets from the manager's socket, open only while
Whombat Link runs; a relay that names a lease in its welcome gets a `renew` with a fresh ticket about 90 s before the lease
would end, on the same connection, and a fresh ticket with another label is a renewal too, while a change of the door
classes still opens the connection again), a direct listener (`managed/direct/`) and, for each connection, a Noise XX responder with the box's
content identity (`@whombat/secure-channel`) carrying the session protocol (`@whombat/protocol`); a client of another
protocol major is told to update the app. The direct listener takes the same Noise session over the local network and
Tailscale (in the image, off until the person signs it in), which is how the apps connect at home. It serves the web
app's page only over HTTPS (the Tailscale name; the own address has its own listener): a browser that comes over plain
HTTP gets one sentence naming the box's HTTPS addresses and no app code, so no page keeps a software device key
([direct-connection.md](docs/decisions/direct-connection.md), [whombat-link.md](docs/decisions/whombat-link.md)).
A tablet becomes a screen only from such a page. On a tailnet the box
is one of its devices: the agent reaches the others (and the networks their subnet routers share) as it reaches the
local network and lists them with `tailnet_devices` (`managed/tailnet-tool.ts`), the box's own networks come before the
tailnet's routes, and the person hears when Tailscale signed the box out (`managed/direct/tailscale.ts`).

**Whombat Link** (`managed/link/`, [whombat-link.md](docs/decisions/whombat-link.md)): every box is the same image. The
runtime reads Link's state (`off · starting · on · grace · ended`) from the manager at start, every five minutes and after
the owner's own change; control is its authority. While Link runs (starting, on, grace) the relay connection is open and
the own address, phone push through control, remote help's switches (on and grace only), website feedback and kit
envelope copies work; nothing else depends on it. The owner turns Link on (`link.on`: the runtime signs its part of the
box's registration from `device.json` with the content key, the manager adds its own and sends `link.begin`) or off
(`link.off`), each a signed appliance event; a change control made is recorded as `link.state_changed`. While Link is
on or in grace the runtime also gives the manager the box's name through `link.on` whenever it is named or renamed, so
the account site shows it (`LinkService.tellName`; the manager sends only a name control lacks, once control says Link
still runs). `reach.get`
answers Link, the own address and Tailscale in one; `updates.channel.get/set` pass the update channel to and from the
manager (the helper keeps it). Grace is one Inbox item and one push asking to turn on Tailscale and to check the backup
details' paper copy; once ended, one Inbox item says what still works and how to come back
(`link/notices.ts`). The screen shows Link's code while it starts and Tailscale's sign-in link (`ConsoleState.reach`). A
phone gives its own push token to the box (`push.token.set`); the box keeps it on the device's endpoint and registers it
at control while Link runs (`link/push-tokens.ts`), and pushes go to that handle. A box control registered before Link
(Home, the DEV stack box; `device.json` names an appliance route other than `local`) keeps its claim through control,
its reports to control and links to the hosted app; every other box is claimed on and linked to its own pages (its own
address, else an HTTPS way such as its Tailscale name, else its address on the local network; no address at all while
nobody can reach it, and loopback only in development), even where the image names a hosted app. The old edition switch and the licence are
inert: `WHOMBAT_EDITION` is read only where there is no `device.json` (development, tests), and the licence gate never
refuses.

**Own address** (`managed/own-address/`, [own-address.md](docs/decisions/own-address.md)): while Link runs a box also serves
its page at `<label>.box.whombat.app` (DEV: `<label>.dev.whombat.app`), with TLS ending on the box. Control gives the label
when Link starts and the manager registers it (with a manager from before Link the runtime draws it), orders the
certificate (ACME TLS-ALPN-01) and watches Certificate Transparency;
the runtime polls the manager (`own-address/state.ts`), records each certificate before it serves it, keeps what the watch
calls foreign and raises the notices. The relay's door hands the box raw TLS streams over the relay client
(`session/relay-client.ts`, `accepts` in the control hello): `web` ones go to a direct listener made for the door (HTTP/2
with HTTP/1.1 for the page's WebSocket, the host's certificate only, exact `:authority`/Host, the page's CSP as a header,
`assetlinks.json`, limits per visitor address without lockouts), `acme` ones are piped into the manager's ACME socket. A
box whose first start had the own address on is inside A3 (`appliance_state.shared_route_off`): it is claimed only on a
page it served (the claim link on its screen at its address, the letters on its local network), never through control,
code pairing is off, the hosted app's page doesn't open it, and the person links it to their account with a code
(`account.link`). Box passkeys (`managed/box-passkeys.ts`) have the box's host as RP ID and are declared to control as a
full set.

- **Enrolment** (`managed/trust.ts`): a session's endpoint key is enrolled to the person's account, the one that
  claimed the box. A device gets in through the claim (a CPace exchange bound to both Noise keys, with the console's
  code; on a box without a secure address the phone app makes it at the box's address on its local network). On the
  box's own pages the proofs come first (`enroll.claim.local.prove`): the box checks the device's and answers its own,
  and only then the device names the person, once, on that session and that connection, within the time of the
  exchange and for the letters it proved. The runtime gives one verdict at a time across all sessions; a wrong try
  retires its letters in memory before it is counted, and no verdict waits on the database for more than ten seconds.
  The person at the box can ask its screen for new letters that stay for ten minutes whatever others on the network
  tried; asking also closes the sessions of devices nobody let in, at no cost to their addresses, and changes the
  claim link. Such sessions are admitted apart by the way they came (the relay, the local network and Tailscale, the
  box's own address, and there a few places for the visitor whose hello shows the claim link), so nobody on the
  internet holds a place the person at home needs. Nothing a visitor does changes the claim link: a wrong one is a try
  of the visitor's own address, ten different ones an hour (`own-address/claim-link.ts`). Under the claim link the
  screen names a second way in that nobody outside can keep busy, the Tailscale page or the address on the local
  network (`ConsoleState.fallbackUrl`)
  ([whombat-link.md](docs/decisions/whombat-link.md) LNK-59…LNK-77, [own-address.md](docs/decisions/own-address.md)
  OWA-34…OWA-37). Other ways in: six letters on the box's own screen (`managed/screen-signin.ts`), pairing from another of the person's
  devices, a device link, a passkey the box verifies itself (`managed/passkeys.ts`) or the recovery kit. A passkey
  uses an owner public key in its authenticator user handle and signs the list of Whombats it opens. Control stores
  that list and the owner seed encrypted with the passkey PRF; the client verifies it before pinning any identity.
  An enrolled session explicitly links the credential on each additional box with a fresh assertion bound to the box
  and session. Each box verifies enrollment itself. Removing it on one box leaves the shared cloud credential and
  other boxes intact. Legacy per-box credentials remain supported and stay available while a replacement is verified.
  Every setup entry point reuses the newest shared credential. The default setup checks all the
  account’s live boxes through this device’s existing pins and enrollments, independently verifies each configured
  backup with that exact credential, and retires older access only for fully checked scopes. Control atomically
  refuses retirement while any recovery envelope needs the old key or its signed scope changed. Pending boxes and
  older recovery details retain their keys; the app names when old password-manager items are safe to delete.
  A shared credential whose signed directory already includes the box unlocks its owner seed in the fresh linking
  assertion itself. That same evaluation checks its backup envelope, saving the derived key and reading back the
  envelope first when needed. The action names each box and check before a prompt; cancellation keeps existing access and explains how
  to finish.
  Retiring a box retains shared credentials; a legacy credential that locks its backup details remains for recovery.
  Revoking
  never leaves the person without a device; every change is a signed appliance event. There are no cookies, bearer
  tokens or magic links. Signing out of the box's web page closes its session and deletes the browser's personal
  endpoint key from IndexedDB; other box tabs close their sessions too. Its separately enrolled screen key stays.
  A tablet or computer the person makes a screen (`managed/display.ts`: it shows six letters,
  the person types them in Settings → This Whombat → Screens) is enrolled as a `display`: its sessions act for no account, resolve
  only the `screen` channel (its own state, lock and pictures), follow no topics and open no streams but its pictures;
  it is none of the person's devices, and removing it revokes its key and deletes its screen in one commit.
- **Requests** go through an allowlisted dispatcher (`managed/dispatcher.ts`) into the handlers in-process (the
  session's `api` operations), with application context only. Runner handlers that need HTTP use an explicit
  request/reply context. Mutations are durable commands: the receipt (`command_receipts`) commits in the
  command's own transaction, so a retried command never runs twice. Downloads, resumable uploads, voice typing
  recordings, exports, canvas collaboration and server consoles are credit-paced streams (`managed/resources.ts`).
  Pending opens count toward the stream limit and retain cancellation during permission and resource setup.
  Each file has one upload owner until its active write or completion stops and its handle closes. Unexpected
  session-task failures close that connection; commands recover through their durable receipts.
- **The manager** (`appliance/manager`) drives health, drain and resume and the claim window through the admin socket; health also says when a periodic housekeeping job stopped finishing its runs (`lib/housekeeping.ts`:
  each job runs on its own with a deadline, so a stuck one holds up nothing else). A drain holds back new turns, executions, automation steps and commands, never sessions or reads; a
  command waits up to 5 s for one to end (`lib/maintenance.ts`), because while an update waits for running work the
  manager drains only for the moment it asks whether the box is quiet (running work: turns, approved actions, automation
  steps mid-call to GitHub, a tracker or a URL, session commands, writes); the server asks the manager's socket for host measurements, the hardware report and Wi-Fi. The
  licence (`managed/licence.ts`) is inert: a token the manager still pushes is verified against keys pinned in the
  image and kept for a rollback, but no state is shown and nothing is refused. Every box has its own Web Push key and
  the person's own SMTP.
- **Ask before updating** (`managed/update-ask.ts`, [ask-before-updating.md](docs/decisions/ask-before-updating.md)):
  the manager keeps the owner's switch and holds every update it is offered until an owner approves that release
  (`appliance.update.ask`, `appliance.update.install`, both signed appliance events; the manager's `/v1/update/ask` and
  `/v1/update/approve`). Its facts say whether it keeps the switch (`update.askFirst`) and when an update waits for the
  owner (`waiting.reason` `owner`), which is one Inbox item (`managed/update-inbox.ts`) until it installs. When the apps
  can't take the yes, the box's recovery menu turns the switch off in the manager's journal.
- **The box's network** (`managed/host-network.ts`, [network-move-server.md](docs/decisions/network-move-server.md)):
  owners join Wi-Fi and choose Wi-Fi only or the cable again through the manager's guard (`host.wifi.*`,
  `host.cable.set`), each change signed in the appliance's audit log. Before Wi-Fi only the hosts service is asked to
  move every agent to the Wi-Fi's address, and after the cable is back to the cable's (`network-move-service.ts`); the
  move is kept a day in `box_network`, follows the address the box uses once its change is over (none when the box is
  back where it was), and `host.network` counts the servers that found the new address. A one-minute watch
  (`network-watch.ts`) keeps what owners are told in the Inbox: a cable that stopped while Wi-Fi carries the box, the
  cable back as the backup (the box tries it when Wi-Fi loses Whombat and keeps it only if it reaches Whombat), and
  connections that refuse Whombat in the check after the box's address changed, made once no cable change runs.
  While the hosts service reconnects to its servers after the box's address changed, the servers it covers show no dot
  and raise nothing.
- **The box's own backups** go where the person set them, through the backup service's socket (`managed/backup.ts`,
  `managed/backup-port.ts`: a status read gives up after 10 s, the list may be 16 MiB, and a silent service reaches
  people as one plain sentence); the runtime hands the service and the manager's last status to the rest of the server
  (`managed/box-backup.ts`, one status read in flight at a time). The
  best place is a **backup place** (`apps/server/src/backup-places/`): a NAS or server on the network where Whombat
  installs a restic REST server that only adds — through the hosts service's backup-place routes on an Unraid or Linux
  server with Whombat's helper, through the connection's own API on a TrueNAS, Synology or QNAP (one driver per kind,
  `drivers/`) — and points the box's repository at it (`rest:http://<LAN address>:<port>/<client>/`); the NAS clears
  backups older than 90 days with the repository password it is handed once. A place lists where on it the backups can
  go (Unraid's shares, a TrueNAS's pools, a Synology's or QNAP's shared folders, with a plain note each;
  `locations.ts`), the one only Whombat uses recommended; another location moves the folder through the agent on
  Unraid or Linux (the repository and history stay) and starts new backups there on a NAS. `backup.places` lists the places in their
  states, `backup.usePlace` sets one up in one step, and the place in use is the record (`backup_places`) whose
  repository the backup service reports. A place Whombat can't install itself is set up by hand: `backup.placeByHand`
  hands out the compose to paste (the user's bcrypt line, no cleanup) and keeps the password sealed in the record for a
  day, and `backup.placeCheck` sets it once the app answers (`backup-places/by-hand.ts`, `nas/`). While nothing backs the box up, or only its own disk does, the Inbox holds the
  assistant's one proposal of the best place (`home/box-backup.ts`) and its `whombat_backup` tool sets it on the
  person's yes and answers the sentence to tell them (no address, port or path), then tells that thread when the first
  backup is done or didn't work; the claim's “Let {assistant} set it up” is the same yes, kept until the AI is connected.
  Backups left on the box's own disk move to the place as part of the yes; any other move stays the person's. Nothing
  forgets a place or replaces the destination while the backup service doesn't say where backups go. One job keeps the
  place right (`backup-places/keep-right.ts`, every five minutes inside the place lock, paused during a restore): the
  schedule in the person's time zone, the place followed when its NAS moved, its cleanup handed the person's keep again
  until it took it (`backup_places.cleanup_keep`; an older helper gets the longest window), a new password after a
  “lost or stolen” restore (on a place Whombat can't change — set up by hand, or typed in — a note instead, and the Inbox
  asks the person to change it until they set a destination again), the claim's yes, the first backup told, and the places' cleanup and free space as Whombat's own
  hints on the server, off at the start; what is still to do is kept in `box_backup` (`backup-places/notes.ts`), and other
  parts add their own step (`addKeepRightStep`: the passkey's gives the place in use the kit user). The Inbox shows one
  backup item at a time (`boxBackupNeedsYou`): a restore waiting for its answer, backups failing for 45 minutes or late
  (the assistant can fix them), a bring back a restart stopped, the proposal of a place, a password only the person can
  change, then the passkey's ask.
  [backup-places.md](docs/decisions/backup-places.md)
- **Backup options and bringing a Whombat back** (`managed/backup-options.ts`): the backup service owns the person's
  policy (`/v1/policy`: how often in their time zone, the keep windows, a space limit, the weekly check) and lists the
  backups in its repository (`/v1/checkpoints`, signed manifests cached, with what each covers), which the runtime pages
  newest first; `backup.overview` answers the Backups page in one request (a part it couldn't read is null, with a plain
  `notice` while the backup service isn't answering, and the places that kept older backups from their records). The
  place's cleanup gets the windows and the
  limit (`backup-places/keep.ts`, kept in step by the keep-the-place-right job, which never writes a policy it didn't
  parse). Backups left on the box's own disk are copied to the place or removed (`backup.moveLocal`,
  `backup.removeLocal`). On a new Whombat — or later, replacing its own backups — `backup.adopt` joins an earlier one's
  repository with its backup details (finding the place on the network by its repository when the details' address no
  longer answers), `backup.restore` has the manager start the root restore (the runtime stops, comes back in
  quarantine, pushes the person once that it is back, `managed/restore-notice.ts`, and keeps an Inbox item while it
  waits), and `backup.finishRestore` takes the person's one answer (gone, or lost or stolen), resolves the checklist,
  has the assistant say what came back and the manager restart the runtime and servers; doing it again carries on where
  it stopped. Lost or stolen gives the place a new password once the box runs normally again; the restore's state says
  who can (`newPassword`: Whombat on a place it set up, else the person), so the question and the done screen promise
  only that. The restore's state is read in one place (`managed/restore-state.ts`): a restore a restart stopped
  (`interrupted`) is a failed one that can be tried again, and people read the service's plain `error`, never its
  technical `detail`. In a list of backups to bring back, a Whombat's backups made after another took its place (the
  first backup of a Whombat brought back from it) are marked and never picked first (`madeAfterReplaced`). Who clears old backups follows
  the service's `clearing.by`, and what a backup left out (`incomplete`) reaches the summary and the list.
  [backup-options.md](docs/decisions/backup-options.md)
- **Getting one thing back from a backup** (`backups/look/`, ops in `managed/backup-look.ts`): `backup.look` has the
  backup service open one backup for reading (`POST /v1/peeks`: a `whombat_peek_<12 hex>` database restored from it and
  a read-only folder with its `home/`, `workspaces/`, `hermes/` and `agent/`), one at a time, kept in memory
  (`BackupLooks`), followed until ready and then read through a read-only pool of its own; its folders are read without
  following a symlink (`look/inside.ts`). `backup.lookContents` lists what it holds by category — the threads of the
  person's Chat and Feedback rooms, other chats, files, automations, connections, Vault entries, memories and skills —
  with plain titles, a search, and whether each is here (its own id or the restore map; `look/items.ts`).
  `backup.lookBring` runs the backup file's collectors on the backup (`collect/source.ts`: their bytes from the backup's
  folders and database instead of the running Whombat's; `look/pick.ts` keeps only the picked records) and its restorer
  with `keep`, so it only adds; a `backup_restores` row naming the look keeps it from overlapping a file's restore, and
  each picked thing comes back as back, here already or not back (`look/bring.ts`). A look closes when the person is
  done, after two hours unused, when the box stops and at the next start (`backup-look.json`). The assistant's
  `backup_bring_back` finds candidates in the newest backup before the person's time hint and puts the bring-back on the
  settings card (`backup.lookBring` always asks). [backup-look.md](docs/decisions/backup-look.md)
- **The passkey is the key to the backups** (`managed/backup-key.ts`): every passkey touch on the person's device (a
  sign-in or passkey setup) asks for the WebAuthn PRF output for one constant salt; the device derives
  this Whombat's backup key from it (`@whombat/core/backup` `kitKeyFromPrf`, bound to its PeerId), drops the output from
  everything it sends, and hands the box only the key (`backup.passkeyKey.set`, sealed with key custody in
  `backup_passkey_keys`). A brand-new credential needs a fresh passkey evaluation after creation to open the stored
  envelope and answer a one-use, session-bound encrypted challenge before the app reports verified recovery.
  Finishing an existing shared passkey uses the linking evaluation, which opens the previously saved owner seed,
  to check the backup envelope too. If its derived backup key is newly saved, the app reads back and opens that
  stored envelope and challenge with the same output, kept only until the ceremony ends. Saving still in progress
  stays pending without another prompt. An already saved key is checked directly without rewriting it. Verification is tied to the
  unchanged key; a changed provider output cannot overwrite working recovery material. Saving and verification
  have separate states. Overview, Inbox, Devices and Backups share the current session's passkey action and feedback,
  with one empty, incomplete or ready status, so unfinished setup survives screen changes and dismissed prompts.
  The account and appliance are both read: a passkey removed locally is reused from the account, and a missing key
  is offered setup rather than a touch. Overview deduplicates backup and access asks into one Devices row. Devices
  puts individual records, removal, policy and rechecking a ready key under Passkey details. Backup selection prefers the
  account’s shared credential and links it here when needed, excluding older sign-in-only credentials. The box locks its backup
  details with every key when they change, after every successful
  backup, when a key is armed and right after any new destination (`whenDestinationSet`: a new place, its new address,
  the new password after a “lost or stolen” bring back), and keeps the envelopes, which only the passkey opens, at
  control through the manager (the signed device op `kit.envelopes.put`, answering `{stored, skipped}`, with the
  Whombat's own name, `applianceName`; after a bring back, either answer, its first push names the Whombat it came from,
  `adoptedFrom`, with or without an envelope, and control switches that one off) and next to the backups as the place's
  `kit` user (`backup-places/kit-copy.ts`; files named by their SHA-256 with the Whombat's name, the place's cleanup
  keeps ten; an app without the user is given it by the keep-the-place-right job). A job asks the backup service's own
  status every minute (whatever the manager reports), locks again when a backup changed it and tries again every five
  minutes what didn't go; nothing goes out during a restore, in quarantine or while drained. On a new Whombat the
  person's passkey opens an envelope from their account (only those of passkeys the account still has), or from the
  backup apps on the network (`backup.findKits`; right after the claim, with no burrow yet, the box scans its networks
  as itself and waits up to 75 s), and its details join the old backups. The
  paper copy holds only the backup part (`backup.paperCopy.confirm` notes it). `bringBack` in the backup summary says
  where it stands (`ready`, `needs_passkey`, `paper_only`, `none`), and while no passkey holds the key the Inbox asks
  once for the same passkey setup (`managed/backup-key-inbox.ts`). [backup-passkey.md](docs/decisions/backup-passkey.md)
- **Push** goes through the manager to control as requests with opaque references and at most a short preview the
  person can turn off (`managed/push.ts`). A `security` push (a new device, the recovery kit) says what happened in
  fixed words and its tap opens the page it is about (`managed/security-push.ts`,
  [push-words.md](docs/decisions/push-words.md)); a remote help visit is told in the Chat instead. A quarantined box
  sends nothing but one `backup` push that a restore is done and waits for the person.
- **Remote help** (`managed/remote-help.ts`) is granted and enforced by the support service; the runtime gives the
  person its switches and records each step ([remote-help.md](docs/decisions/remote-help.md)). **The desk screen**
  (`apps/server/src/desk/`) is the box's own display: a glance, the person's asks, talking to the agent. The glance is
  the calm glance: the runtime gathers what's true (Home's asks and looks, the work, the fleet, the connections'
  activity, what's coming up: `desk/calm-sources.ts`) and core's planner (`deskCalmFor`, `domain/desk-calm.ts`) decides
  what shows from the person's choices (`DeskSettings.show`, set in Settings → This Whombat → Screen, which previews it with
  `desk.preview`); the console draws `DeskGlance.calm`. The glance reads each widget's newest point only, and it and
  Home's overview read what their parts share once per request (`homeReads`, the registry sources' `SourceCtx.reads`). The box learns its own name from the app (`desk.setName`).
  Every screen is a grid of widgets the person arranges ([desk-display.md](docs/decisions/desk-display.md)):
  the box's own, each monitor the console reports through the desk socket's `size`, each tablet or
  computer enrolled as a screen, each a row of `screens` (`desk/screens.ts`) with its layout, pages and pop-ups, the
  calm glance being the default layout. The runtime resolves each placed widget into a view (`desk/widgets/`: Whombat's
  own from the glance's read, servers from the fleet and the hosts service — a server's overview or one part of it
  (`opts.show`: processor, memory, network, storage, guests, temperature, alerts; `server-parts.ts`, read as its own
  screen reads it) — Home's widgets, the connections' and devices' through `ThingWidgets`), kept at each widget's pace
  and read again in the background so the glance never
  waits, trimmed by the lock; the console gets them in `DeskGlance.grid` and `outputs`, pictures through the socket's
  `image`, and Settings edits them with `desk.screens`, `desk.screen.*` and `desk.widgets`.
  Pairing and discovery read the person's eligible places in one relational query, choosing the claimer's person
  before requiring their account, agent and default Chat.
  *Done today* and *Welcome back* list the tasks the agent finished in its own words (`report_done`, one per thread in
  `done_tasks`, [done-today.md](docs/decisions/done-today.md)), not Home's changes.
  A screen's widgets of a connection or device come from its page: `desk/widgets/things.ts` reads `things.page` and
  maps its figures and panels into views (`thing-views.ts`), with each kind's hints and what a locked screen leaves out
  in `thing-kinds.ts` ([desk-display-server.md](docs/decisions/desk-display-server.md)). A hint can also make a
  widget from what the page shows without being a panel of it (*All backed up*, *Ads kept out today*, *Tonight on TV*:
  `screen-panels.ts`, [service-dashboards.md](docs/decisions/service-dashboards.md)).
  The person's own accounts (`account:<connections.id>`, `account:github`) have widgets of their own
  (`desk/widgets/accounts.ts`, views in `account-views.ts`; [desk-display-server.md](docs/decisions/desk-display-server.md)): *Today* and *Next
  meeting* from today's calendar, *Unread mail* from the inbox's own unread count (`inboxUnread`), read with the screen's
  person's own token, and *Pull requests* and *Waiting for review* from the GitHub mirror's tables.

The web and phone share recovery orchestration in `packages/client/src/managed/recovery-ceremony.ts`: identity
checks before secrets, enrollment over the pinned session, record creation, error mapping and session cleanup.
Their platform screens and directory loading remain in each app.

## Repository layout

pnpm workspaces, Node 24, TypeScript strict, ESM everywhere. One repository holds the box's runtime, the apps and the
contracts between them, so one commit changes a contract and everything that uses it
([one-repo.md](docs/decisions/one-repo.md)). The appliance (NixOS image, manager, release tooling) is in `appliance/`
and the hosts service (the hub and its agents) in `hosts/`, and a release is built from one commit of `main`. Neither
folder is part of the pnpm workspace. Control and the relay live in a private repository.

`appliance/flake.nix` builds the image from the folders beside it. Each build reads a narrow copy of only the files it
needs (`appliance/nix/lib/sources.nix`: the runtime bundle's, the web app's, the hub's, the agents', each Go
program's), so a commit changes only the builds whose files it touches, and a change to a document or a test changes
none. A release's runtime carries a stamp its maker chooses, the commit and time the bundle says it is: the published
runtime's stamp keeps that runtime, this commit's makes a new one. The agents' version is a committed value that only
signing changes (`appliance/nix/packages/hosts/agent-version.json`). The hashes of what the build downloads are kept
with the digest of what they were taken for (`appliance/nix/fixed-hashes.json`; `appliance/scripts/ci/fixed-hashes.sh`).

What a release is made of and how each part is checked is the component list, `appliance/manifest/components.json`:
every component's place (this repository, or the private one for control and the relay), its build from a clean clone
and its gates, without a commit. `appliance/manifest/pins-at <commit>` fills a commit in; the full validation
(`appliance/release/ship validate`) and the bill of materials (`appliance/release/sbom`) read the result. A Production
release's commit carries the release's id as a tag.

| path | package | contents |
|---|---|---|
| `apps/server` | `@whombat/server` | Session endpoint, Fastify 5 on loopback, Drizzle + postgres.js, migrations, seed, commit pipeline, handlers, MCP, GitHub, approvals, automations, search, notifications. `@whombat/server/host` is what the CLI and the bundle builder take from it. |
| `apps/runner` | `@whombat/runner` | Claims dispatches, prepares a turn's workspace, runs Hermes turns in the sandbox and the pod, streams progress; the sign-in executor, the Hermes-home service, the agent's gh and git relay. |
| `apps/agent-net` | `@whombat/agent-net` | The commands' network proxy and its control socket. |
| `apps/cli` | `@whombat/cli` | The bundle's `whombat` binary (`schema-check`, `migrate`, `version`) and the release library (`@whombat/cli/release`). |
| `apps/web` | `@whombat/web` | The web app: the box's own page, the hosted UI (app/dev.whombat.com), the visual harness's journeys. Its `package.json` carries the app's version (the APK's too). |
| `apps/mobile` | `@whombat/mobile` | The Android (and iOS) app: Expo/React Native with a native module for live activities and the home-screen status widget. |
| `apps/widget` | `@whombat/widget` | The embeddable feedback widget and its embed tree. |
| `packages/core` | `@whombat/core` | The contracts: domain types, Zod schemas for every operation and frame, the keys engine, approvals and automations logic, message parsing, formatters. Pure: no I/O. |
| `packages/protocol`, `packages/secure-channel` | | The session protocol (frames, claim, tickets, licence) and the Noise XX channel it runs over. |
| `packages/control-contracts`, `packages/release` | | Control's API schemas; release tuples, manifests and update states. |
| `packages/canvas-schema`, `packages/fixtures` | | The canvas document schema; the mock world shared by tests, the seed and the apps. |
| `packages/client` | `@whombat/client` | The apps' session client and the reducers that apply realtime frames to the query cache. |
| `packages/tokens`, `packages/avatars`, `packages/brand` | | Design tokens (CSS variables on web), the agent faces, logos and marks. |
| `packages/agent-runtime` | `@whombat/agent-runtime` | The provider-neutral turn contract; `HermesProvider` over ACP and the scripted stand-in (`hermes/`); Claude Code's checks, model lists and sign-ins; the turn's words (`persona/`); the managed sandbox (`access/managed/`); the workspace manager; host paths. |
| `packages/commands` | `@whombat/commands` | What runs inside a command's wrapper: `whombat-command` (Hermes's terminal prefix), the holder and its network, the `gh`, `git` and `whombat` helpers. |
| `packages/hermes-whombat` | (Python) | Whombat's Hermes plugin: the pinned DirectSDK provider, the commands terminal backend, the tool-policy hook, the logins vault, the skills steps, the `whombat:settings` skill. |
| `packages/node-io` | `@whombat/node-io` | Node-only HTTP-over-socket and tar mechanics; policy stays with the callers. |
| `packages/screen` | `@whombat/screen` | The screens of widgets: the grid, the widgets' sizes and forms, page turning, the screen's words and fixtures, as pure TypeScript with no zod; `@whombat/screen/react` draws them for the box's console and the web app's screen page and editor. |
| `contracts/` | | The contracts' cross-language side: JSON Schema, test vectors, the Go module the relay and the appliance use, the generator and the release script. |
| `scripts/package` | `@whombat/package` | `pnpm bundle:runtime`: the appliance's reproducible, signed runtime bundle per architecture. |
| `tools/visual` | | The visual reference harness (`ref:shot`, `visual:diff`). |
| `appliance/` | (Go, Nix) | The appliance: `flake.nix` and the NixOS image, the manager and the update helper, backup, the console, the release tools, the integration harness (`appliance/harness`, a pnpm project of its own) and the VM tests. Its own guide is `appliance/CLAUDE.md`. |
| `hosts/` | (Go) | The hosts service: the hub (`whombat-hosts`), the agents on monitored servers, Whombat Helper for macOS, and the hub's own web UI (`hosts/web`, a pnpm project of its own). Its own guide is `hosts/CLAUDE.md`. |

- **Releases for other repositories**: `pnpm contracts:release` makes the contracts' tarballs and Go archive (tag
  `contracts-v<version>`) that control and the relay vendor; `pnpm app:release` makes the app's release (tag
  `app-v<version>`). The box's web page is built from `apps/web` with the runtime, not vendored.
- **Dependencies point one way**: contracts ← `agent-runtime` ← the box's apps, and contracts ← `client` ← web and
  mobile. Apps don't import each other, except that `apps/cli` imports `@whombat/server/host` (migrations, the schema
  check, build info) so it applies the server's rules exactly. `@whombat/core` does no I/O; `@whombat/node-io` carries
  transport mechanics only, never keys, signing, the pipeline or leases.

## Database and migrations (`apps/server/src/db/`)

The Drizzle schema (`db/schema/`) is the source. Migrations are drizzle-kit SQL files with a journal, starting at
`0000_baseline`; each has an entry in `migrations/compat.json` with its class (`expand`, `backfill`, `contract`,
`incompatible`) and the oldest build that may still read and write the database after it. A migration's schema
version is the folder's `schemaBase` (in `compat.json`, 0 when absent) plus its position. A new migration is
`pnpm --filter @whombat/server db:generate` plus that entry. What only SQL says (the append-only triggers on `events` and `appliance_events`,
a few index details) lives in the migrations.

The baseline stands for the 76 migrations of the chain before it, so `schemaBase` is 76 and the baseline is version 77:
versions never go down. A database still on that earlier chain is refused with the release that moves it across
(0.268.0, `db/compat.ts`), and a backup from before it is restored with that release first
([report-trackers.md](docs/decisions/report-trackers.md)).

Migrations run under one advisory lock wherever they run (the manager's `whombat migrate`, the development boot,
`pnpm db:migrate`) and refuse a database whose history isn't a prefix of the build's. A contract migration needs a
verified backup checkpoint first. In production the server's start only validates the schema: a build below its
writer floor starts read-only. A database from before the baseline, or of the chain before it, is refused. Reasons and the rollback rules:
[managed-db.md](docs/decisions/managed-db.md).

## Domain model (`@whombat/core/domain`)

All ids are text: `<prefix>_<nanoid(12)>` (`bur_`, `prn_`, `cnv_`, `msg_`, `run_`, `apr_`, `evt_`, `dsp_`…). The seed
uses readable ids (`prn_dusty`, `prn_mara`, `cnv_pr482`). URLs use handles and slugs where one exists.

- **Burrow** (one per box) and **Account**; the box's **person** is the account that claimed it.
- **Principal** — anyone who acts and signs: `person`, `agent` or `system`. There is exactly one agent (name, face,
  status, runtime `{provider: claude | codex | local, model, effort, fast}`, where `codex` means ChatGPT). `system`
  principals are Whombat's own signers: GitHub, each automation, Feedback, the report trackers, Servers.
- **Grant** `{keyId, tier: can | ask | cannot, scope?}` — the agent's permission keys.
- **Conversation** — `dm` (the person's Chat, their Feedback room) or `branch` (a pull request's room). Every
  conversation is the person's with the agent; nobody is a member of one. The person's notification level for a room
  is `conversations.notify` ([membership.md](docs/decisions/membership.md)).
- **Message** — light Markdown parsed by core's `parseMessage()`, with mentions, an optional card (`plan`, `run`,
  `approval`, `answer`, `digest`…), quick replies, “More detail”, attachments, reactions, link previews, threads
  (`threadRootId`), edits, deletes and pins. An HTML page (a fenced block, a raw page, an `.html` attachment) or a
  Mermaid diagram shows live in a sandboxed frame: an opaque origin under `PAGE_POLICY` (inline scripts and styles, bundled scripts and embedded assets;
  remote resource requests blocked), the app's theme as the page's first style (`withPageStyle`, `pageThemeCss`),
  as tall as the page up to 2000 px. The web writes it into `/sandbox/html-frame.html`, which the box's own page frames
  with headers of its own; the phone loads it in a confined WebView with Mermaid bundled as a data URL, started when its row nears the screen
  and let go 20 s after it leaves
  ([visual-replies.md](docs/decisions/visual-replies.md)). A **page set** (a folder of pages the agent showed with
  `show_pages`) is one attachment of type `application/vnd.whombat.pages+zip`: a ZIP of stored entries with
  `.whombat/cover.png` (its thumbnail) and `.whombat/pages.json`. Its viewer runs `pages-runtime.js` in the same frame
  or WebView; the script asks the app for each file a page uses, which the app reads by its byte range over the session
  (`@whombat/client/pages`), and writes the page with them in place ([page-sets.md](docs/decisions/page-sets.md)).
- **Plan** (the agent's own work), **Run** (a coding task on a branch), **Approval** (an action, its conditions and
  its state), **Dispatch** (one queued turn), **Automation** with its versions and runs, **VaultEntry**, **Canvas**,
  **Repo**, **PullRequest**, **Notification**, **AuditEvent**.

## The commit pipeline (`apps/server/src/commit/`)

```
commit({burrowId, actorId, onBehalfOf?}, command, input)
  1. validate the input against the command's Zod schema
  2. licence gate, then the keys engine: decide(actor, grants, requiredKey, scope)
       deny  → a signed Blocked event, answer `blocked` with the key it needed
       ask   → a pending Approval and a signed Asks event, answer `pending_approval`
       allow → continue
  3. one transaction: apply the change, finish dependent writes with `beforeCommit`,
     append signed events, write outbox rows and the receipt
  4. after commit: publish the outbox, run `after` hooks (search index, approval checks),
     and start `background` hooks (badges, notifications, push) without holding the answer
  5. required `complete` continuations run without the database lock; their result or
     failure reaches the caller
```

A command is a module defining `{name, schema, requiredKey(input), apply(tx, ctx, input)}` (`defineCommand`). The
session's operations and the MCP tools are thin adapters over the same commands, so the person tapping in the app
and the agent calling a tool run identical code. A turn may call only the tools it is served (`mcp/server.ts`
`mcpToolList`, the same list `tools/list` answers): anything else is refused before it runs. A call checks its one tool
by the same rules (`servesTool`), reading only what that tool's rule needs; each request reads its dispatch, agent and
person once. Writes that belong to the account rather than the burrow use
`transactAccount`.

Posting a message queues its agent turns in the same transaction, after attachments and model choice are stored.
“More detail” and an answer resuming a waiting run save their markers and jobs together. A crash after the commit
leaves a durable turn for the runner; retrying the message does not create another one.

The transaction holds the burrow's write lock (step 3), so every other write of the box waits while it runs. A
statement in it, and its wait for the lock, may take at most a minute (`WRITE_LIMIT`). Calls to outside services
belong after the commit: an allowed Google change is a `complete` continuation that calls Google and then signs its
content-free event (`connectors/commands.ts` `changeAfterCommit`). `callGoogle` refuses to run under the lock in
development and tests and logs it in production (`commit/lock-scope.ts`), except for the reads an approval card shows,
which it names.

A required external continuation marks the accepted receipt’s result as pending. A process that dies while it is
pending leaves an uncertain outcome, never a success or a replay of the action. Ordinary completed commits whose
answer is lost retain the redacted-result behavior.

## Signing and the audit log (`apps/server/src/audit/`)

- Ed25519. Each principal gets a keypair when it is made; secret keys are stored sealed with `WHOMBAT_MASTER_KEY`.
  Seed keys are derived, so fingerprints are stable. A fingerprint is the first 8 hex characters of
  `sha256(publicKey)`, shown `xxxx xxxx`.
- An event's envelope (burrow, sequence, previous hash, actor, type, kind, text, key used, payload, time…) is hashed
  as canonical JSON and signed. `seq` and `prevHash` chain the burrow's events; an append takes a per-burrow advisory
  lock for its transaction, so concurrent commits can't race.
- `events` is append-only (a trigger refuses UPDATE and DELETE). Reads verify signature and chain link;
  `pnpm --filter @whombat/server audit:verify` walks a whole chain.
- Events with `text` are what the audit log shows; high-volume internals are signed with `text: null`. Private
  content never goes into an event: ids, sizes, hashes and versions only.

## Keys engine (`@whombat/core/keys`)

- `KEY_CATALOG` lists every key with its label (the mocks' copy verbatim) and `agentMaxTier`.
- `decide()` is pure and unit-tested. The person may use every key. For the agent: people-only keys (Push to main,
  Approve requests) are denied; other wordings and bundles map to their canonical key; the required key's umbrella
  chain is walked and the first level with a grant decides; no grant denies. `can` is clamped to the key's
  `agentMaxTier`, so sending mail, calendar invites and sharing always ask; trashing mail and files asks unless the
  person set it to Allowed on the account's page.
- Merge and Deploy are rows of three states, Off · Ask · On. Grant changes are signed `Keys` events. A stored grant
  for an unknown key shows as a locked row instead of failing.

## Approvals (`@whombat/core/approvals`, `apps/server/src/approvals/`)

- Conditions are evaluated from live state: checks on the head commit, the pull request's review, the person's
  decision. The person decides every approval, in the room it was asked in.
- “Approve in advance” sets `approved`; the executor runs the action once all conditions hold. Undo returns it to
  `pending` until it has executed.
- Executors are a registry by action type (merge a pull request as the person, let exactly one push through, run a
  configured deploy workflow, give a key, run a command, connector actions). An action without an executor is
  refused up front; nothing is simulated except the demo's staging deploy.
- Each approval stores a hash of its action, deferred input and binding, signed in its request event; execution
  checks it and runs the registered guards, and a mismatch or a missing hash refuses (one without a hash can't be
  approved either). Recovery (at start and every minute) reconciles
  or fails as uncertain what a dead process left running; nothing runs twice.
- An approved connection call runs after its deferred command's commit (which records `connection.tool_called`) as a
  required continuation: the approval succeeds, fails in plain words or is uncertain as the call did, and after a crash
  the call's own events say whether it never ran (it runs once), finished, or may have reached the service.
- Approvals retain their asking dispatch and run. A yes wakes the agent that asked in the card's thread with the
  approval in its context; a decline tells it too. A live run continues in run mode; a pause or take over holds the
  continuation. Approval changes advance linked activity revisions and publish their derived state to open feeds.
- Approval lists and inboxes resolve connection argument previews in one batch per page, with each approval's
  visibility and decider checks intact.
- A Hermes tool that a key at Ask holds back (the web, the browser) is asked through the turn's policy file: Hermes's
  approval gate → ACP `session/request_permission` → the runner → a card for the person; the turn waits.

## Realtime (`apps/server/src/managed/events.ts`, `apps/server/src/realtime/`)

Every frame published after a commit is appended to `session_events` by one serialized writer, so a session that
subscribes with a cursor resumes exactly after it. A restart, an expired cursor, a change of authorization or a
subscriber too far behind answers `snapshot_required` with the head cursor; the client refetches its snapshots and
subscribes again. `typing` (the agent's thinking line) is ephemeral.
Live arrivals during replay have the same 1,000-event bound as queued delivery. Overflow releases the replay buffer,
stops further replay pages and prevents an enrichment read finishing after closure from sending an event.
A failed replay removes its registration; a live delivery failure closes that subscription and requests a fresh
snapshot through the same recovery path, so a later cursor cannot conceal an event that failed to arrive. A frame that
couldn't be appended to `session_events` does the same for every subscription to its topic.

Frames are the Zod-typed `RealtimeEvent`s of `@whombat/core/contracts` on topics `burrow:`, `conv:`, `run:`, `me:`,
`canvas:` and `hosts:`. Subscriptions are authorized before they register (`realtime/hub.ts`): only an enrolled account's person in the
topic's burrow subscribes (a screen elsewhere subscribes to nothing: it asks for its state), and `conv:`, `run:` and `canvas:` topics need their thing in that burrow; every frame goes
to the person in full. What a stored frame
leaves out (a Vault event's detail, a sealed argument preview) is filled in at delivery (`realtime/fill.ts`).
`@whombat/client` applies frames to the app's query cache. The server keeps a private record of whether the person
is at a screen (`realtime/presence-tracker.ts`) to hold back push and poll GitHub faster; nothing about it is
published.

## The agent and whose turn it is

The agent is made with the burrow at the claim (`domain/the-agent.ts`): Dusty by default, with a face, the default
keys and the first ready provider. Its first message in the person's Chat is the welcome (`guides/welcome.ts`): what the
network scan found, a button each, then mail; the claim's own last step signs the person in to ChatGPT or Claude
([first-day.md](docs/decisions/first-day.md)). The person changes its name and face, its AI sign-in and memory in
Settings under its name (its keys in What it may do), its model and effort in Settings → Advanced, and its schedules in
Automations. Code finds it by kind
(`loadAgentRow`). See [one agent](docs/decisions/one-agent.md) and
[one person](docs/decisions/one-person.md).

- **What wakes it**: the person's message in their Chat (or one that mentions it in any room), a search
  question, a yes or no on its approval, a schedule, Whombat's own signers (GitHub's checks, automations,
  Feedback, the report trackers), a server task or a T3 Code thread it handed work to that finished or asks something, a member of
  a council it started whose lead thread is done, a task of a delegation that needs a decision, and a look
  Whombat sees on a server, connection or device (below). The agent never wakes itself.
- **The person's turns** (everything except below) read every room of the burrow, the memory, the notes, every
  connection and the Vault entries switched on for the agent.
- **An outsiders' turn** — a Feedback assessment, what a tracker customer's report or reply starts, incoming mail —
  is queued for nobody (`runtime/person.ts`). Its room is usually the person's Chat or Feedback room, so it works in
  its own thread there: it gets its request and that thread but never the room's recent messages or Files, and its
  tools read, reply and read files only in that thread (`mcp/tools.ts` `withinTurn`, `files/access.ts`). It is served a
  short allowlist and nothing else (`mcp/served.ts` `OUTSIDERS_TOOLS`): read its thread, reply there, read its files,
  check its own work, and its automation step's own tools (the assessment, proposed connection actions for approval, the
  tracker's report, a pull request from the branch its step checked out); a Feedback assessment has its own five. It
  gets no mail, calendar, files, Vault, connections, notes or memory, and runs in Hermes's separate `_feedback` profile,
  so instructions hidden in what strangers send reach none of the person's things. One Hermes holds that profile at a time, so outsiders' turns run
  one at a time: the claim keeps the next one queued, oldest first, while another holds its place, a person's turn
  never waits for them, and one that still finds the profile busy on the runner is queued again rather than failed
  (`runtime/service.ts`, [outsiders-turns.md](docs/decisions/outsiders-turns.md)). An automation step's turn that waits
  for its T3 Code thread does so 25 seconds a call at most (a call's own limit is 30), and while another outsiders'
  turn is queued, or an update waits for it (`lib/maintenance.ts` `updateWaits`), it hands the wait to Whombat and ends (`automations/turn-waits.ts`, `dispatches.waits_on`): nothing
  more runs in that turn (`mcp/server.ts` refuses its calls, a last line too), and when it fails as it ends nobody hears
  of it (`runtime/service.ts`). The engine then waits for the thread and gives the step
  its next turn once the thread finished or asks (`automations/engine/handed-wait.ts`); what the handed turns used
  counts in the run's tokens.
  The one exception is T3 Code: a turn on a tracker's report sees the
  T3 Code connection and nothing else (`connections/context.ts`), and hands looking into the code to a T3 Code thread,
  which runs with full access on the person's computer. There it may only list projects, start a thread in a new
  worktree and follow the threads started from its own thread; the person's other threads, schedules, environments
  and projects are refused before T3 Code is asked (`connections/report-turn.ts`).

- **Settings for the person** (`apps/server/src/settings/`): in the person's own turns (never an automation's step or an
  outsiders' turn) the agent finds, reads and changes Whombat's settings with `settings_find`,
  `settings_read`, `settings_change` and `settings_open`. A setting is one op of the session allowlist; the settings
  map (`@whombat/protocol` `ASSISTANT_SETTINGS`, one entry per op) says whether the agent may read it, change it, change
  it only after a card, or only say where it is, and on which page. Ops run as the person through
  `SessionDispatcher.runForAssistant` (the person's account with no device, `assistantPrincipal`), the same path as
  their device's request. A change first commits `change_setting` with the `settings.change` key (Ask me first by
  default): Go ahead runs it, Ask me first puts an approval card in the thread whose yes runs it once as the person and
  wakes the agent there, Just watch refuses; destructive changes and the map's `ask` entries always ask. An entry may
  guard parts of its input: a connection's address and access level stay the person's, a check's address and switching
  it off always ask, checked on the input by the tool, the command and the dispatcher.
  [assistant-settings.md](docs/decisions/assistant-settings.md)

## Turns (`apps/runner`, `packages/agent-runtime`)

- **Claim**: the runner long-polls `POST /internal/runner/claim` and receives a `DispatchContext` (the turn's person
  or `outside`, the window or thread, attachments, workspace, the keys and Vault entries it holds, connections,
  notes) and a per-dispatch agent token that slides with the turn's progress beats. `runner/turn.ts` coordinates the
  turn's phases; `runner/turn/` holds each phase's work.
- **One turn per thread**: the claim never runs two turns in one conversation and thread at once (the top level
  counts as one place), except a run's turn beside the turn that started it, and never two outsiders' turns at once
  anywhere on the box (they share one Hermes profile). Messages during a turn coalesce into
  the next one; a follow-up of the same person joins the running turn
  ([steering.md](docs/decisions/steering.md)).
- **Hermes Agent** runs every turn: a pinned `hermes acp` driven over ACP by `HermesProvider`. Hermes and Whombat's
  plugin ship in the runtime release, so a new Hermes is a runtime update that the box checks (ACP answers, the plugin
  and its providers load) and goes back from by itself; the appliance's latest-tested job checks for a new Hermes
  release daily, has an agent review it against Whombat's use of Hermes, installs and uses it in a test, and when it
  passes pins it on `main` (the runtime's pin and the appliance's in one commit) and brings it to Beta (Production gets it only inside a promoted release), and This Whombat shows the version ([hermes-updates.md](docs/decisions/hermes-updates.md)). The person's Hermes
  home is `$WHOMBAT_HERMES_ROOT` itself, Hermes's default profile (`config.yaml`, `memories/`, `sessions/`,
  `skills/`, the ChatGPT login); `profiles/_feedback` beside it holds every outsiders' turn. Before a session starts
  the runner writes the profile's `config.yaml`, `SOUL.md` (who the agent is, how its face talks, and that a reply is
  short whatever the face) and `whombat.md`; the per-turn preface opens the prompt and a line on how long the reply may
  be ends it ([concise-replies.md](docs/decisions/concise-replies.md)). Whombat's MCP tools reach Hermes as a stdio bridge to `<server>/mcp`. Web search is
  Hermes's `web_search` on the person's Brave Search key: the plugin's `whombat-brave` backend, named in `config.yaml`
  only while the runner wrote the key to `whombat-web-search.key` in the profile; Hermes's keyless search stays off
  ([web-search.md](docs/decisions/web-search.md)).
- **The pod** (`apps/runner/src/pods.ts`): one long-lived sandbox runs Hermes's gateway and hands each turn a
  pre-started `hermes acp`. It starts with the first turn, stops after 15 idle minutes, is quiesced for steps on the
  person's home and retired by any sign-in change; up to `WHOMBAT_POD_TURNS` (4) turns run there at once. Everything
  that is a turn's own (its commands, logins, MCP token, gateway token, tool policy) is routed by the Hermes session
  its tool calls run in. An outsiders' turn gets a sandbox and a Hermes of its own instead.
- **Where the model runs**, always on Hermes's own loop: Claude subscriptions through Nous's DirectSDK provider (the
  unmodified Claude Code as its model client, [claude-directsdk.md](docs/decisions/claude-directsdk.md)); ChatGPT
  through Hermes's `openai-codex` on Hermes's own login; an API key, the burrow's AI gateway or a custom OpenAI-compatible AI model (an internet service over HTTPS or a server on the person's network) through Hermes's API clients.
  When the agent has an optional `backgroundModel` set ([model-effort.md](docs/decisions/model-effort.md)), automatic
  Looks, care plans and scheduled automation steps resolve their dispatch runtime to that model of the same provider
  with automatic effort and without fast replies, while chats and person-started work keep the main model or thread
  choice.
- **Sessions**: one Chat thread is one Hermes session, resumed on its own provider and model; a turn sends only what
  is new since the session's last turn, a new session gets the window (the thread's first message and last 60 replies,
  in a channel after the room's last 30 top-level messages; a flat room's last 30 messages), and a failed resume is
  retried on a fresh session. Hermes keeps the tools a session began with, so a turn served a tool its session's last
  turn wasn't (`dispatches.served_tools`, recorded at the claim) starts a fresh session too. In the person's Chat and Feedback a turn never reads the room's other threads: a new
  thread starts fresh. Edits, deletes and
  Clear chats forget the sessions that saw them; sessions no turn names are pruned after a week idle.
- **The answer**: a short answer is the agent's final message, posted by the runner in the thread. Hermes's memory and
  skill review carries on in the gateway after the answer. Successful posting results establish delivery; a distinct
  final answer still goes out after a progress message. A direct Chat request ending without an answer after its
  work gets one same-session recovery with tools blocked and a 45-second deadline. Missing answers and failed final
  Chat posts complete as failures, with a Try again card. Runs and search answers use their own completion tools.
  Stop is `session/cancel`; a crashed turn is retried once,
  then the failure is classified and the agent says why with a Try again card.
- **Activity evidence**: the runner's provider reports and the server's MCP reports use core's pure
  `redactActivitySecrets` policy before their own normalization and length bounds.
- **Run recovery** (`runtime/run-recovery.ts`, `commands/run-recovery.ts`): completed turns reconcile their live runs,
  and the runtime's 15-second sweep repeats that check from durable run state, starting on the first housekeeping
  tick after boot. Only the run's own turns, approvals, schedules, checks and questions keep it waiting. The commit
  rechecks its latest turn and dependencies, queues one recovery atomically with its stall marker, then sets attention
  if it remains abandoned. Cancelled work gets attention without restarting; paused, taken-over and finished runs are
  preserved. A lost callback cannot strand a completed turn's run indefinitely.
- **Sign-ins** (`agent-runtime/src/providers/`, `apps/server/src/managed/providers/`): every turn runs on the
  person's own Claude or ChatGPT sign-in or an API key they added, one credential home per provider under
  `WHOMBAT_CREDENTIALS_ROOT`; never another login or a paid fallback (the AI gateway's fallback below uses only the
  person's subscriptions). The runner's sign-in executor runs the
  providers' own sign-in flows for the app. Console reports collect adjacent output fragments and join their bytes
  once per bounded report item, preserving offsets, gaps and control events.
- **The AI gateway** (`apps/server/src/gateway/`): a burrow may connect one gateway (Fusebox or another) and switch
  Claude and ChatGPT turns onto it. Hermes then calls `/ai-gateway/<provider>/…` with the turn's agent token and the
  server relays the calls, streamed, with the gateway's key. The server reads the gateway every minute; two failed
  reads, or one relayed call that couldn't reach it, make it unreachable. While it is unreachable or gone, the claim
  (`gateway/claim.ts`) runs a turn on the person's own Claude or ChatGPT subscription instead (the turn's own tool
  first, never an API key) in a fresh Hermes session, and refuses it only when there is none; a used-up pool refuses.
  See [ai-gateway.md](docs/decisions/ai-gateway.md).
- **Readiness**: the runner checks Hermes and Claude Code (with each CLI's model list) at start and while one isn't
  ready, reports them in its heartbeat and claims only what it can run; a turn no runner can run gets a quiet reply
  saying why. After a claim that failed (the server restarting) it beats before it claims again, so the server knows
  what it runs before it hands it a turn; a server that just started doesn't give that reply while a runner that beat
  hasn't claimed yet (its claims, not its heartbeat, say which providers it runs), nor, for a minute, for a client the
  manager has just installed, which the runners find at their next re-check. A Claude model released after the pinned Claude Code takes the place of the one it follows in that list
  and in Hermes's Claude catalog (Fable 5.2 for Fable 5.1, [model-effort.md](docs/decisions/model-effort.md)). Model and effort are the agent's own or automatic, and a Chat thread may choose its own.
- **Usage and spend**: subscription usage is probed on a schedule and read from the turns (`apps/server/src/usage/`),
  with alerts in the Chat near a limit; spend is read-only sums of `dispatches.usage` (`read/spend.ts`). Tests and the
  demo run a scripted ACP agent in place of Hermes through the same path (`hermes/testing`).

## Commands, the sandbox and the browser

- **The sandbox** (`agent-runtime/src/access/managed/`): every live turn runs in a two-stage bubblewrap sandbox (own
  user, pid, net, ipc and uts namespaces; no capabilities; seccomp), a read-only minimal root, a cgroup per task in a
  delegated subtree, and network only through the runner's per-task egress service (provider endpoints, the MCP
  endpoint, public hosts with the web key; never private, loopback, link-local or metadata addresses). No sandbox, no
  turn. The runner's generation fences stale workers: the server refuses their lease, workspaces refuse their writes,
  and a restarted runner kills their cgroups before claiming. [managed-sandbox.md](docs/decisions/managed-sandbox.md)
- **The agent's commands** run in the pod beside Hermes, each in a bubblewrap wrapper of its own
  (`apps/runner/src/commands/`, `packages/commands`): Hermes's terminal asks the runner before each one (the command
  guard, the person's yes for consequential commands — Allow once, for this task, or always, on a card that says why
  the agent runs it, from the `# why:` line the command starts with — and the turn's keys),
  then runs it with the agent's home as `$HOME` (Hermes's file tools read `~` as that home too), the turn's checkout
  at its real path, the system read-only, nothing
  of Hermes's home but `skills/`, the turn's Vault keys as environment variables and files on a tmpfs, and the
  network through agent-net. Git control files can't be planted in a shared repository. Tools come with the image;
  the agent installs only in user space. The launcher and the helpers start Node without its proxy stack; only the
  agent's own commands get `NODE_USE_ENV_PROXY`. A turn looks its production servers' names up together and waits at
  most a second: the wall starts with the server's addresses and whatever answered, and a later answer adds its
  addresses.
- **Workspaces** (`apps/runner/src/workspace.ts`): coding work is a git worktree of Whombat's own mirror of the
  repository under `<WHOMBAT_WORKSPACES>/<burrow>/<repo>/<branch>`. The person's turn without a checkout works in the
  agent's work folder (`~/work`); other turns get an empty folder in the runner's private temporary space. A
  read-only workspace (an automation's investigator or reviewer) is exported without git metadata into a fresh folder.
- **Pushes and `gh`**: git and gh in a command reach the runner through helpers (`whombat-git`, `whombat-gh`). For each
  operation the server decides with the keys engine (`feat/*` needs the branch key, `main` is blocked, a shared branch
  asks for exactly that commit) and the token reaches only that one process. The agent's `gh` commands are planned
  and decided by the server (`github/gh-plan.ts`) and run by the runner outside the sandbox; the token never reaches
  the agent. Git's error output is redacted as a stream, so a token split between two reads is hidden too.
  [agent-gh.md](docs/decisions/agent-gh.md)
  Command and git frames use one output allocation and incremental, bounded payload decoding; fragmented traffic
  copies each payload once. Runtime event queues advance through buffered events and release consumed references.
- **The browser** (`apps/runner/src/browser.ts`): the plugin's browser tools (`whombat_hermes/browser.py`:
  `browser_navigate`, `browser_snapshot`, `browser_click`, …) drive one headless Chromium per pod, started as Whombat's
  own command in the commands' network and reached through a CDP relay. Each call is one command of agent-browser
  (Whombat's pin, `packages/hermes-whombat/agent-browser.json`), handed its arguments as JSON on stdin; the model
  never writes code that runs beside Hermes, so Hermes's own `browser_exec` is off in every turn. Vault logins switched
  on for the agent are Hermes's login backend `wb` (handles `wb:<entry>`), filled by Hermes's `browser_vault` from the
  runner's logins service without the model seeing them, with a login's current two-step code made on the server. In
  the person's turns `browser_vault` runs with Whombat's prompts: reaching a sign-in page with no login, or a page asking
  for a code, it asks the runner, the server posts a `login` or `code` card in the turn's thread, and the turn waits for
  the person (10 and 5 minutes) while its beats go on; a saved login comes back to fill, a code once, and a wait that runs
  out leaves the card for a later answer. Each new pod's Chromium has a fresh profile; only when the agent asks
  (`browser_keep_site`, `kept_sites.py`) the runner keeps one website signed in between pods (`kept-sites.ts`): it reads
  that site's cookies from Chromium and the server keeps them sealed for a few hours from their last use; every fresh
  Chromium of the person's pod gets the sites still kept before Hermes connects, and a site with a page open is renewed
  when a turn leaves the pod and when the pod stops. Other sites' cookies are never read out or restored, and nothing is
  kept unless the agent asked. A watchdog (`browser-watch.ts`) checks the running Chromium every 20 s straight over its
  DevTools port: a page that stops answering for about a minute is closed, and a Chromium that stops answering or can't
  start a page that answers is ended (its kept sites renewed from it first), so the next connection starts a fresh one. `browser_preview` opens a built folder and posts
  the screenshot; `page_preview` draws an HTML page the way a message shows it (the frame's policy and the app's
  theme, at a width), always offline, and gives the agent its screenshot, height and console lines, posting nothing.
  `show_pages` has the runner read a folder the same way, draw its first page for the cover, pack it as a page set and
  PUT it to the server (`PAGES_TRANSFER`, `pages/`), which checks and keeps it as the agent's file. All three reach the
  runner on its progress beats (`browser/previews.ts`). A Feedback assessment's browser may open only the reported
  site and never signs in.
  Only when the agent asks, one website stays signed in between pods for a few hours ([kept-sites.md](docs/decisions/kept-sites.md)):
  the runner reads that site's cookies over CDP, the server keeps them in `kept_sites` sealed with the custody key
  (`browser/kept-sites.ts`), every fresh browser gets them back until they expire, and a use renews them. The person
  sees and stops them in What it may do.
  The relay and CDP client accumulate incomplete frames with geometric buffer growth and release drained storage;
  retained frames and payloads own their bytes.
- **Attachments** reach the agent through the runner, checked for size and hash, as model input (images, PDFs), an
  excerpt (text) or a plain line; the agent publishes files with `upload_file`.

## Memory, skills and Hermes's homes

- **Memory** is Hermes's own: `memories/MEMORY.md` and `USER.md` in the person's profile, written in the person's
  turns. The person reads and edits it (`apps/server/src/memory/`; a version refuses a stale edit). The agent's notes
  (`burrows.agent_notes`) are the person's to write and reach the person's turns as a prompt section of their own.
  An outsiders' turn remembers nothing.
- **The Hermes-home service** (`apps/runner/src/hermes-home/`) is the only thing that touches the two homes
  (`person`, `outside`): the server queues steps (`apps/server/src/hermes-home/`) that the runner long-polls —
  memory edits, deleting sessions, listing sessions, exporting and importing a home, skills. A step that changes the
  person's home quiesces the pod and holds the profile lock.
- **Skills** are Hermes's: its built-ins (kept by Hermes's own sync), what the person installs from Hermes's hub (its
  scan and install policy decide) and what the agent learns, all in the profile's one `skills/` folder. Whombat ships
  one of its own, outside that folder: the plugin registers `whombat:settings` (`whombat_hermes/skills/settings`,
  read-only), written from the settings map by `pnpm assistant-settings:gen`. Whombat's own bookkeeping (what is switched off, who changed what) is `skills/.whombat/skills.json`; a turn's
  `config.yaml` lists the switched-off names. Settings → Advanced → Skills reads and changes them through the runner's steps
  (`apps/server/src/skills/`). [hermes-skills.md](docs/decisions/hermes-skills.md)

## Automations (`apps/server/src/automations/`)

Versioned definitions (triggers, bounded steps, limits; pure logic in `@whombat/core/automations`) run by an engine
that is active in one server process at a time (an advisory lock). `automations/engine.ts` coordinates the engine's
life and passes, with collaborators under `engine/`; `automations/steps.ts` is the step command surface, with typed
handlers under `steps/`. User guide: `docs/automations.md`.
Run lists and single-run reads share `automations/store.ts`'s page hydration: batched steps, names, billed tokens,
coding-run numbers and approval numbers. Grouping keeps each run's step order and token-rounding boundary;
published automation details read their definition and publisher from one version row.

- **Made by talking to the agent** (`automations/plans.ts`): in the person's Chat the agent proposes an automation, or a
  change to one, with `draft_automation` (a recipe or a definition; `automation_read` lists the person's automations, the
  tracker connections and connected mailboxes a trigger can name, and how to write one). Whombat checks it, keeps it as the automation's draft and posts it in the turn's thread as an
  `automation_plan` card (`automation_plans`, one waiting per automation; a newer plan replaces it). The card's sections
  are written from the definition by core's `planSections`, and a change lists what differs from the live version.
  Turning a plan on publishes exactly its definition with the keys its steps need (`definitionGrants`); Not now sets it
  aside and deletes an automation that was never on. An automation's own step and a turn for nobody can't propose or
  read automations, and a step can't schedule: it finishes its work in its own turn, waiting for T3 Code. The apps have no editor: the Automations page lists automations and the agent's schedules, with
  On/Off, Run now or Try it, Delete and “Talk about it” (the latest plan's thread); its field suggests ideas from what is
  connected (`automationIdeas`: mail, a server, Home Assistant…). On the phone a row opens the automation's own page,
  which says what happens step by step from the definition (core's `automationFlow`, in the plan card's words) and
  holds those buttons ([automation-page.md](docs/app/decisions/automation-page.md)). A server's care plan turns on the automations Whombat
  writes for it (weekly updates, weekly QEMU/KVM backups) with its Go ahead, without a plan card of their own.
  An automation that still has exactly an earlier version's own words for its recipe (`recipeHasEarlierWords`, core
  `EARLIER_RECIPE_WORDS`) is given today's as a new version when the server starts (`automations/words.ts`,
  `automation.words_updated`), its publisher and state unchanged; words someone changed stay. Where a step's prompt
  cuts the person's instructions to fit its rules is no wording: a definition that differs only there counts as that
  version's words.
- **Recipes**: `AutomationRecipe` makes an ordinary definition with the tested steps (assess, fix, review, pull request,
  merge); the agent proposes one when it fits.
- **Triggers** read the signed `events` table after a durable cursor (messages, reactions, mirrored pull requests
  and issues of watched repositories, report trackers' reports, matched incoming emails of watched mailboxes), plus
  schedules (cron in a time zone) and Run now. Webhook triggers are refused: nothing from outside reaches the box. Runs
  are deduplicated by automation, version and trigger; an automation-caused event carries a causal depth and deep chains
  start nothing.
  Cron catch-up parses once per call, reuses at most three days' computed instants and searches them by position,
  retaining each trigger's daylight-saving policies and the bounded search.
- **Mail triggers** (`apps/server/src/mail-triggers/`): `MailTriggerService` watches only connected mailboxes
  (`connections` with `mail`) that have a live `mail` automation — via Gmail History API, Microsoft Graph inbox message
  delta or IMAP IDLE (with a multi-minute socket timeout) paired with `UIDVALIDITY`/`lastUid` + `BODYSTRUCTURE` and a
  60 s safety poll. It reads headers and attachment metadata first, drops mail received before the automation's
  activation time (5 s skew margin), deduplicates by provider id and RFC 5322 Message-ID, backfills from activation on
  the first poll and resyncs expired cursors from the last successful poll time. It fetches full bodies and hands over
  matched email attachments only when a message matches a live trigger (`from` address or domain, `subjectContains`,
  `hasAttachment`, `attachmentTypes`), skipping gone messages immediately and unreadable or commit-invalid messages
  after three failed attempts with a plain-English problem so a mailbox never stalls; attachment metadata is capped at
  100 per email (recording how many were left out) and attachments that cannot be handed over (too large, unknown type,
  download failed, too many) are marked on the run scope so both the prompt and the run page say they didn't come along. High-water marks (`mail_cursors`) and deduplicated matched items (`mail_trigger_items`, whose
  cached body and snippet are cleared once the run starts and whose rows are pruned after 30 days) commit through the
  pipeline with content-free signed `mail.received` events. Mail-triggered runs execute as outsiders' turns (queued for
  nobody, never reading the person's mailbox or connections directly, with messages from mail and tracker outsiders'
  runs marked in `messages.outsiders_run`, a column apps never get, so message and reaction triggers skip them): mail
  definitions may not use repository workspaces or external steps other than `connection_actions`, sender-controlled
  fields reach the agent only inside
  defused `[[mail …]] … [[/mail]]` outsider fences (`packages/core/src/text/fence.ts`, never cut mid-fence) with the
  email's files attached to the run's first agent prompt (`read_attachment`). A run keeps the email's text (`body`,
  `snippet`, `text` in `automation_runs.scope`) only while a step that reads the trigger may still render it; then, and whenever
  the run ends, it goes from the scope, from what settled steps stored (their fenced copies become a short note) and
  from the Hermes sessions the run's turns ran in (`automations/mail-text.ts`), while sender, subject and attachment
  metadata stay.
  Proposed writes (`propose_connection_actions`) are only the listed, create-only actions a mail automation needs
  (`automations/listed-actions.ts`): upload a file of the email to Paperless-ngx, add a purchase invoice or receipt to
  Moneybird, save a new file (or make a folder) in Dropbox or Nextcloud, add a task to Todoist, show a notification in
  Home Assistant. Each has a strict schema; Whombat sets what keeps it create-only (`If-None-Match: *` on a WebDAV PUT,
  Dropbox's `mode: add`, `overwrite: false`) and the `Content-Type`, and refuses any other header, a header name given
  twice in different case and any value named like a password or key; everything else is refused with what a mail
  automation can do instead. The prompt lists the listed actions by connection handle, never the person's labels. An
  upload sends only a file the server handed over from the run's email, by id: those files are copied onto the run's
  first agent prompt, whatever step comes before it. The proposals always ask the person on an approval card bound to the
  exact `actionsHash` regardless of standing settings, built only by the server (`automations/proposed-card.ts`): the
  listed action's words as its title, question, message and “Done:” line, then every line that decides what happens —
  method and path or tool, base, the email's file by name, type and size, every argument and header, nothing hidden, a
  long value in numbered parts — or the proposal is refused when that doesn't fit on one card. `connection_actions`
  runs them after a yes, settling as
  `uncertain` on timeout or partial-batch failure. Any other automation card asks its title as a question unless a
  `request_approval` step's details start with its own question. A session below protocol
  minor 3 (an older app) gets a mail run's trigger as a message, a `connection_actions` step as an earlier step and such
  an automation without its definition (`automations/older-apps.ts`).
  A box makes, turns on and runs automations started by mail, or that change things in connected services, only while
  the release it would go back to after a failed update knows them (`automations/release-gate.ts`): from the manager's
  update facts, the box's current release while this one is being tried, else the release its own last update came
  from, looked up in `runtime_releases`, where each release records itself at its first start on a managed box. Until
  then they wait, kept as they are: no mailbox is read, their runs don't start or move on, and making, turning on or
  running one, or the assistant's `draft_automation`, answers “Mail automations come with the next update.” (or the same
  about connected services), as `automation_read`'s guide says. Development boxes, tests and a box that never updated
  have them on.
- **Runs** are leased and fenced; each step's effect commits with its new state. External effects (calls, pull
  requests, comments) are marked first and reconciled, or set `uncertain` for the person, after a crash or a restart:
  a pull request or merge the mirror doesn't show is looked up on GitHub, and done then when GitHub hasn't got it. An
  agent step's time counts from its first turn's claim (a turn after a handed T3 Code wait keeps it): while the turn is
  queued only the run's own deadline bounds it, and a step queued behind another outsiders' turn says so in its summary (“Waiting for another customer report to finish”). A
  failed turn's step says why when the turn does (“Dusty couldn’t finish because it took too long.”,
  `steps/turn-words.ts`). A run started by incoming mail, or one with a `connection_actions` step, is stored with
  `deadline_at` at the epoch: the release before mail triggers checks a started run's deadline before any step, so after
  a rollback it fails such a run instead of asking the agent as the person; here its deadline is its own time limit after
  it was created (`runDeadline`, docs/decisions/automation-recipes.md).
- **Identity**: each automation signs as its own system principal, with authority = its grants ∩ the publisher's
  current authority, checked before every step and inside approval execution; the rooms a step uses must still be the
  burrow's. The agent can only draft until the
  first publish; publishing is the person's and binds to the reviewed draft's hash.
- **Coding steps** carry a workspace (repository, branch, read or write). A write step's branch key is decided before
  the agent is asked, and the step succeeds only when GitHub has new commits on the branch. A run about an issue or
  pull request continues the thread of the first run about it.
- **Report trackers** (`apps/server/src/trackers/`): a tracker connection names its driver, an owner-installed plugin
  (`$WHOMBAT_HOME/plugins/<id>/plugin.mjs`, imported at start, every call timed and its answers checked) that speaks
  the tracker and gives its words. Reports are mirrored by a poller for connections a live automation listens to and
  become runs like GitHub issues; the agent reads them with the tracker tools (`tracker_item`, `tracker_read`), sorts them and, for a plausible bug,
  looks into the code through T3 Code where it is connected (a look runs in a worktree of its own at full access, so
  nothing waits for an approval nobody gives); their turns are outsiders'. With T3 Code a recipe's fix goes to the
  thread that looked into the report, which makes the fix branch in its own worktree from origin's default branch (a
  new thread on its own worktree and branch when no thread looked), and has another model review it once (`delegate_task`,
  the recipe's `t3Review` or another provider's), fixes what that review found and pushes, with its before and after
  screenshots on `pr-shots/<branch>`; the thread gets the report in the agent's own words, never the customer's text.
  Whombat's review step reads that review itself (a report turn may list and read the reviews its own threads hand out)
  and approves when the review approved or the thread dealt with each thing it found; the server reads the reviewer's
  own answer too, which must be another model's and name a commit on the branch, and the approval binds the branch's
  head, and Whombat's steps open the pull request (named by the assessment's `title`, carrying a marker that names the report and
  the driver's own line,
  with the screenshots as a table) and merge it once the checks the repository runs on every merge have passed on that
  commit; `trackers/fixes.ts` then follows it until it is live where the customer is and tells the customer what the fix
  did for them (the fix turn's “For the customer (fixed|partly fixed): …” line). A production connection may name
  reporters whose bug fixes go straight to production (`releaseFor`, read by the server only): once development runs
  such a fix, `trackers/release.ts` starts one T3 Code thread in the repository's project that runs the repository's own
  release procedure for exactly that revision (waiting for another release under way; an override only where its release
  docs allow one for such a release), and the customer hears once
  production runs it. Several fixes of one report reaching the customer in the same release tell them once. A fix to
  what the tracker releases on its own (the driver's `releasedSeparately`, such as software on customers' computers)
  counts as live where the customer is only once the tracker's health says the release it offers of that part has the
  fix; then the customer hears it is ready for their computers and how to get it right away. Where the tracker doesn't
  say, a fix to that part alone is told at its merge that it comes with an update, and marked released without a message
  once it does. Report fixes merged between two reads of GitHub are found in each fix repository's latest closed pull
  requests. One release of a repository runs at a time: a fix due while another goes waits for it, and starts
  only if production then still lacks it. A fix due while the chosen reporters' other reports are still being fixed waits
  for them, two hours at most, so one release takes them together. A release that stops tells the person, then the customer hears it is coming
  with the next update; it goes again once development runs a newer revision with the fix, later ones three hours after
  a stop (three releases at most), and one whose thread goes on after the stop is followed again. A thread that went quiet without “Released:” or “Stopped:” is asked where it stands, one that doesn't move for
  90 minutes or runs three hours tells the person, and a release ends after twelve hours. Whombat settles a release
  thread in T3 Code once it is over (its fix is live, or a newer try replaced it), after two quiet hours and only when it
  waits for nothing (`settleReleaseThread`). A
  run's pull request finished by hand from the run's branch is followed as the run's own. A reply closes a finished report: a
  question it answers, one the customer withdrew or calls solved, a duplicate, a test. A fix that set out and didn't
  land says why in its thread and reaches the person's Inbox (`trackers/unlanded.ts`). A step's instructions put what a stranger
  wrote last and are rendered so that only that is cut, never the rules. A feature request the agent can judge comes
  to the person as a `feature_request` card with its value from 1 to 10 and both drafts (`trackers/features.ts`, in Needs
  you too): approve, approve and build, decline with a reason or ask the customer; the run then tells the customer, in
  the agent's words when the person gave their own, and builds what was approved to build. A card whose report is
  closed in the tracker meanwhile ends at the next poll (“The report was closed.”) and its run goes on. Each poll also fills in
  the tracker's organization id on reports mirrored before Whombat kept it, so a repeat is told by it; an intake that can't
  go on by itself — more new reports than a poll reads, or an hour of failed polls — is said once in the person's Chat
  and Inbox (`trackers/stuck.ts`).
- **Telling**: a run tells the person as it posts, like any message in its room; a failed run, an approval and a
  review always notify. A saved definition's `tell` is accepted and ignored
  ([brief-removed.md](docs/decisions/brief-removed.md)).
- **Delete** cancels runs in progress and keeps the row for its history.

The runtime CI check (`scripts/ci/check.py`) records phase, unit-selection and executed-test evidence. PRs changing
ordinary server/web/mobile source modules select transitive unit-test importers through Vitest against the exact
controller-bundled PR base. Shared code, configuration, deletions and uncertain discovery run the complete unit
suite; documentation-only changes omit that phase explicitly. Non-PR runs and `WHOMBAT_CI_FULL=1` run every unit
test. Every check retains the full Postgres integration suite and other gates. Eight-worker jobs with eight
available CPUs and at least 10 GiB memory run unit and server suites concurrently, four workers each; other jobs run
them serially. Typecheck and the mandatory two-minute memory soak remain separate. The app job runs managed and
hosted browser projects in one Playwright process with four total workers, then the real runtime smoke journey.

## Whombat Feedback (`apps/server/src/feedback/`)

An optional bug-report widget for the person's own websites (`WHOMBAT_FEEDBACK`). The box has no public address,
so reports come through the encrypted drop: the widget, served from Whombat's embed origin, checks a card the box
signed, seals the report to the box (HPKE) and posts it to control, which can't read it. The runtime pulls drops
through the manager (`feedback/drop/`) and files each one in one transaction (validated, idempotent, capped,
screenshots re-encoded): the report, a thread in the Feedback room, a signed event. The agent assesses every report in
a read-only outsiders' turn; a fix is a later turn after the person's yes. Visitors never become accounts. Guide:
`docs/feedback.md`; reasons: [feedback-drop.md](docs/decisions/feedback-drop.md).

## Shared links (`apps/server/src/shares/`)

The person shares a thread of their Chat, or the thread from one of its messages on, by link. The box builds a copy of
what the person sees there (the person's and the assistant's words, pictures unless turned off, the assistant's pages;
never cards, details, files or outsiders' messages; `shares/snapshot.ts`), seals it with a fresh key
(`@whombat/core/share`) and hands control the sealed bytes through the manager (`share.put`); the key is only in the
link's fragment, `https://<hosted app>/s/<id>#<key>`. The hosted app's `/s/` page (`apps/web/src/share/`) loads on its
own, reads the copy from control's public `GET /v1/shares/<id>` and opens it in the browser. The `shares` table keeps each
link (its key sealed with the custody key) and goes through the pipeline: `share_create`, then the call to control,
then `share_published` (or `share_discard`); stopping is `share_stop` and, once control deleted the copy,
`share_stop_done`. A five-minute round deletes again what control didn't take yet, stops links of deleted threads and
drops rows whose copy never reached control. Links work 7 days unless the person picks otherwise; Settings → You →
Shared links lists them with how often control served each. The assistant's `share_link` always asks first. Reasons:
[share-links.md](docs/decisions/share-links.md).

## The person's prompts (`apps/server/src/prompts/`)

The person keeps words they use again and again under a title; Chat offers them after `/` and Settings → You → Prompts
lists them (`api.prompts.*`). Whombat's shipped prompts are `STARTER_PROMPTS` in `@whombat/core`; the `prompts`
table holds one row per prompt of the person's own and one per shipped prompt they changed, removed (`hidden`) or ran,
whose null title or words follow the shipped ones (`prompts/view.ts` reads them together). Keeping, changing, removing
and bringing back the shipped ones are `prompts.create`, `prompts.save`, `prompts.remove` and `prompts.restore` through
the pipeline, the person's only. A repository prompt runs on a T3 Code project: `prompts.projects` lists T3 Code's
projects through the connection at Manage (kept a minute), and `prompts.use`, in one commit, posts the person's line
(“<title> · <project>”) in their Chat through `send_message`, so the thread and the agent's turn start as for a typed
message, records a hidden brief for the agent (`domain/agent-brief.ts`) with the prompt's words between marker lines
(`promptTask`: the words, the ownership line and the merge lines when on, when it last ran on that project), the project, the connection's
handle and the AI the prompt names as T3 Code takes it, and records the run on the prompt. The agent's turn reads the
line with the brief and starts the T3 Code thread with `t3_thread_launch`; the T3 Code watch and wakes take it from
there. The shipped prompts that leave open points end with `PROMPT_COUNCIL_LINES`: a council in the thread decides
them, and the person gets only what is theirs to choose. A prompt with “Merge into main when it’s done” has its thread
open a pull request instead of merging: the watch of a thread started with the merge lines is marked
(`t3_watches.merge`), and once its job is done each watcher pass (`t3code/merge.ts`) waits for the pull request's checks
as an automation's merge step does, merges it on GitHub at the head they passed on, records it and says in the
person's thread that it merged or why it left it. Reasons: [prompts.md](docs/decisions/prompts.md).

## GitHub (`apps/server/src/github/`)

GitHub is the person's own GitHub sign-in: `ManagedGitHub` calls REST as the person with their token (read through
the runner's sign-in bridge); `FakeGitHub` serves development, tests and the demo (`WHOMBAT_GITHUB`). There is no
GitHub App and no webhook. Every repository the account owns is the burrow's, with nothing to pick
(`github/owned-repos.ts`): brought in when GitHub is connected, on Sync repos and by the poller every 10 minutes. Others
the agent names are added when the account may push to them. Repositories can also be created on the box. A
repository renamed or moved on GitHub is renamed on the box (`github/rename.ts`): the poller reads each repository's own
answer (a 304 while unchanged) and the owned sync matches GitHub's id, then one signed command moves the name in
everything kept by it (cursor, branches, issues, deploys, rules, check-server work, a tracker's fixes, keys limited to
it, a connection's settings) and every automation naming it takes the new name as a new version, published by whoever
published it. Messages, runs and the log keep the name they were written with.

- **The poller** reads each repository on its own cadence (10 s while work is live there, 30 s while the
  person is around, 3 minutes otherwise; woken by pushes, merges and deploys): open pull requests, their checks and
  reviews, the agent's branches, deploy runs, and issues of repositories an automation watches. Conditional requests
  keep it cheap; each cycle reads the connected burrows and an issue watch's automations once, and a poll saves its
  cursor only when it changed (its time at most once a minute). Pure plans diff GitHub against the burrow and feed mirror commands through the pipeline, so it is
  idempotent across restarts. A finished round of checks wakes the agent whose work it is, once per head.
- **Manual and approved merges** (`github/merge-intents.ts`) save the head, destination branch, method and actor in `merge_intents`,
  then claim it after checking permissions, head, checks and review again. GitHub runs outside the burrow lock;
  its result is recorded in another commit, signed by the original actor. One active intent per PR prevents
  concurrent calls. Pending intents resume after a restart. A running call interrupted by a restart stays uncertain
  and is never resent; the mirror can later confirm the same head and destination, retaining the original actor,
  key and on-behalf-of identity in one signed event even if it sees success first. Automation merges use their durable fenced steps.
- **Identity**: everything on GitHub is done as the connected account; the agent stays the commit author, and a push
  is signed by the agent only when Whombat pushed that exact commit for it. Merging follows the agent's Merge row.

Setup and operation: `docs/github.md`.

## Connections, servers and the Vault

- **Catalog definitions** (`packages/core/src/domain/connections-catalog/`) are pure data in one file per service,
  assembled in order by the original public module. Adapters and dashboard kinds use their existing registries.
  Session-authenticated catalog connections (`connections/session.ts`) support both header/query tokens and HTTP
  cookie sessions (`tokenCookie` extracted from `Set-Cookie`, applied as `Cookie: <name>=<value>`, with optional
  `bodyPattern` login-failure matching). Bundled tool definitions refresh on use when their hashes differ from the
  stored tools, preserving the person’s tiers; remote MCP discovery keeps its hourly refresh.
- **Catalog connections** (`apps/server/src/connections/`): services the person connects (Home Assistant, Proxmox,
  UniFi, Plex, mail over IMAP/SMTP and many more), each the burrow's, at most 50, every change signed. The agent
  calls them in the person's turns through `connection_call` under its keys; calls that change things ask. Each
  connection and device has a page (`apps/server/src/things/`) with generic panels and a kind's own part where
  Whombat has one, and Home checks their health every five minutes: one read of the quiet rows and the person per
  pass, and Home hears of a change only when what a connection's glance shows changed. A kind may declare the settings
  of its service that matter through `KindModule.settings` (`declaredSettings` in `things/kinds/settings.ts` — Plex,
  AdGuard Home, Pi-hole, Sonarr, Radarr and Immich): `connectionPage` adds their `service-settings` tab right after
  Summary, and a switch, a sheet's choice and the assistant's approved card all run the kind's `setting` action through
  `actions.ts`, which reads the setting back from the service before it says done and records the change with how to
  put it back (undo kind `thing.action`). The settings tools give that card Whombat's words through
  `kind.settings.describe`, and the dispatcher marks an op run for the assistant (`managed/acting-assistant.ts`) so the
  change names it ([service-settings.md](docs/decisions/service-settings.md)). A kind that sets `slots` (Plex, Seerr, SABnzbd, Home Assistant, Pi-hole…) lays its Summary out
  in the slots every screen shares: Worth a look as a strip on top, then rows of three columns by `span` (Live rows,
  Inventory counts, a Shelf, Trend, People) and the machine as one card after them (`things/machine.ts` `machineCard`;
  without a known machine the service's own figures, else its lines alone as “<name> itself”), with no row of figures,
  machine charts or response-time chart; desk widgets read such a page's figures from its live rows and counts. A
  connection without a kind, or whose kind read nothing, gets slots of its own (`things/generic.ts`): how it answers
  Whombat's checks and its answer time per day ([service-slots.md](docs/decisions/service-slots.md)) A Custom
  connection (`custom_mcp`, `custom_api`) may have a page recipe instead (`catalog_connections.page`,
  `things/recipe/`): the assistant names what to read — MCP tools the server marks read-only, or GET paths — and where
  each value goes (Live, Inventory, Trend, a list, the head's facts, Worth a look's lines under the checks `page.broken`
  and `page.heads_up`), tries it with `connection_look` and saves it; the page reads as the connection with the kinds'
  cache, and the health pass keeps the trend's and counts' readings as points. Such a connection may also have a logo
  of its own (`catalog_connections.logo`, `things/logo/`): Whombat looks for its service's own SVG right after Connect
  (the MCP server's `serverInfo.icons`, then the website's SVG icon) and the assistant may give one from an icon set;
  every SVG is fetched through `lib/outbound.ts` and turned into path shapes (`ThingLogo`) that the apps draw as
  bundled marks are ([connection-looks.md](docs/decisions/connection-looks.md)).
- **Sign in once** (`connections/provision/`): for a service that can make Whombat a key of its own, the person signs in
  once and a provisioner makes the key, which is kept as one of the entry's token sign-ins. T3 Code's is a pairing code
  with no account: Whombat's server signs in to T3 Code's MCP server for outside agents as T3 Code links two of its own
  computers (register, approve with the code, exchange it for a token), keeps when the 30-day sign-in ends, and signs in
  again with a new code through `connections.setSecret` ([t3code.md](docs/decisions/t3code.md)). A T3 Code thread the
  agent starts, messages or answers is watched (`apps/server/src/t3code/`, `t3_watches`): between passes the running
  server keeps a `t3_thread_wait` open at T3 Code for up to six threads at work that wake the agent, and reads such a
  thread at once when the wait comes back with its end (`#holdEnds`); every 15
  seconds Whombat reads up to 40 of them with the connection's sign-in, those read longest ago first (new and re-armed
  ones first of all, one that couldn't be read to the back), each from where its last read stopped (`readThread`, pages
  of 50 items, a few pages a pass), and a thread's last answer that T3 Code cut off is read to
  its end and kept as its start and its end (`fitAnswer`), where the lines Whombat reads are; when it finishes, asks a question or waits for a permission
  the agent is woken with a `t3_thread` turn in the Whombat thread it handed the work over in, once per thing and never
  for what its own calls showed it; a thread an automation's step handed work to wakes nobody, as the step waits for it
  itself. While a turn of the agent is at work there the thread is still read and what the person sees kept, but
  nothing is told or settled until that turn is over. A thread the agent starts is titled with its name first (“Dusty - Fix the login
  bug”), its message ends with when to use subagents (as a delegation's, `subagentRules`) and, in a turn that hands the
  work over for the person, with how to write its last message (`JOB_REPORT_LINES`). A thread is settled in T3 Code
  only once the job it was started for is finished. For a hand-over in the person's turns the agent decides that: the
  per-turn rule and the wake that tells a completed end tell it to settle a thread it started then
  (`t3_thread_organize`), and Whombat refuses that settle while the thread is at work, waits for work or has a pull
  request watched (`t3code/settle.ts` `settleRefusal`). A step's, a council's or a checklist's thread is settled by
  Whombat once that is over and the thread has been quiet: settling ends the thread's session there, which stops every
  command it left running, and T3 Code counts one the thread didn't wait for (`t3_background_wait`, which
  `subagentRules` tells every thread to use) as finished. So Whombat only marks the thread (the watch's
  `progress.settle`), and the watcher looks at each marked thread about once a minute and settles it once no run has
  started for two hours and it waits for nothing (`#settleQuiet`). A told hand-over is marked too, only so the watcher
  looks for a run after it for those two hours: one whose thread T3 Code ran again (a command it left running ended) is
  watched again, so that run's end is told.
  In a turn the person's own message started, the server adds that message word for word to the message the agent
  sends a thread (`t3code/person-words.ts`, fenced and labelled, once per turn and thread; never a stranger's text, a
  wake or an automation's step), and the turn's preface says so, so the agent's brief holds only what the person left
  out. Work that continues a thread goes to that same thread (`t3_thread_send`; T3 Code makes a settled thread active
  again): a turn's context lists the T3 Code threads its Whombat thread handed work to (`t3Handoffs`, at most five,
  newest first). What the person writes to a thread in T3 Code itself (T3 Code marks it `createdBy: user`) the watcher
  keeps (`progress.personSaid`) and gives the agent with the thread's next end, question or permission
  (`T3ThreadUpdate.personSaid`), so its next message to the thread doesn't overrule them.
  A thread whose run ended while T3 Code watches a pull request for it is still watched and left unsettled: T3 Code runs
  it again when the pull request's checks or reviews move, and each run's end wakes the agent. A run that ended while
  its thread still waits for work (T3 Code's wait for its delegated and background work doesn't come back within a
  second: work it delegated, a command it waits for) isn't the end: it is held back, the job shows as finishing and
  nobody is told; the end of the run that follows is the one told. When a hand-over's end is told, the same commit puts T3 Code's last answer in the
  person's thread as the job's result (`t3code/result.ts`): a message in the assistant's name whose text is the report
  as T3 Code wrote it and whose `jobResult` carries the facts (tests, changes, pull request, time, AI) and the person's
  answers; the wake says it was reported, and the agent posts nothing about it. A report is never lost to a later run:
  the next end updates that message in place only when it goes on with the same work, the run the person's answers on
  it started (when that run completes; else only the sending is marked) or a run T3 Code started by itself while
  nothing was written after it (the person gets one notification). A run asked for since its end was told (any message
  to the thread, `progress.asked`) and a stopped or failed run post a new one. `messages.jobAnswers` sends the answers the person marked on a result message to the thread
  in one message, records them on the message and watches the thread again. While it works the
  Whombat thread shows it (`conversations.handoffs`, the `conversation.handoffs` frame, `t3code/handoff.ts`): each read
  keeps T3 Code's state, its latest steps in plain words, its program and its page on the watch, and when what the person
  sees changed the conversation's list goes to whoever has it open. The reply row says “T3 Code is working on it · 6m”
  with T3 Code's mark and the thread's end has a line with what it does now, until the agent answered after its end;
  such a thread doesn't settle. Each hand-over also carries the job's progress (`t3code/progress.ts`, the watch's
  `progress`): its stage on a forward-only track (reading, plan, editing, tests, review, pull request, checks, merged)
  read from every one of T3 Code's items (a file written from the shell counts as editing), T3 Code's plan read in full
  when its plan item changes, its linked pull request with the changes and checks GitHub gives at most once a minute,
  the question it waits on, and once its run ended a receipt and T3 Code's whole answer, which the thread opens under
  the receipt (listed for a week; a follow-up run's end replaces them). The pull request an automation's
  `open_pull_request` step opens from the branch its T3 Code thread worked on is that job's
  (`t3code/pull-requests.ts`), and an ended job's open pull request is still read on GitHub until it merges or closes. The person answers that question (`conversations.handoffAnswer`) or steers and queues messages
  (`conversations.handoffSend`) from the job, checked as a page's button and signed as `t3code.job_message`, which
  watches the thread again; a permission request stays T3 Code's own. An MCP entry may hide
  the server's tools that can't work for Whombat and name reads the server doesn't mark (`mcpTools`).
- **The council** (`apps/server/src/council/`, [council.md](docs/decisions/council.md)): with T3 Code at Manage, the agent
  can put a question or a goal to several AI models of different providers at once (`council_start`, `council_tell`,
  `council_note`, `council_finish`, `council_read`, and the plugin's `whombat:council` skill). Whombat always seats
  T3 Code's own council, unless the person names members for one council: its lead sits the members T3 Code's council
  skill names, and Whombat starts it on the reviewers T3 Code's last council sat (else one member per provider T3 Code
  can run, at most four, `orchestrator_capabilities`) and moves a seat to the model that came (`placeChild`,
  `councils.setup_name` “T3 Code”). The person's council in Settings keeps only its rounds and score. It starts one lead
  thread in T3 Code on the AI the chat runs on (`chatSeat`; the first seat only for a company T3 Code can't run), with the council's brief (`council/briefs.ts`): what was asked as the agent wrote it,
  the seats as `delegate_task` takes them, the rounds and the target. The lead runs the council there (T3 Code's own
  council skill where it has one): it starts a reviewer per seat with `delegate_task`, each on its own, brings their
  answers together, and for a council that improves a project builds in a worktree of its own, opens one pull request,
  has fresh reviewers check it and fixes until the target score or the round limit. A review or a research starts in
  the project's own folder, so the reviewers see the person's checkout as it is; plain research in a scratch folder.
  Whombat reads along. The lead thread is watched with the T3 Code watch (`t3_watches.council_id`,
  `councils.builder_thread_id`; its row in `council_members` has role `builder`). The card shows the seats only, never
  the lead: while a round runs, a seat whose reviewer hasn't started yet is on it as `waiting` (“Getting ready”). On every
  watcher pass the sweep lists the lead thread's children (`t3_thread_list` with `includeSubagents`), places each on
  its seat and round (by its title “Council · <seat> · <look|plan|check> <n>”, else by its model and its order,
  `council/lead.ts`), reads an ended one's answer up to 12,000 characters with its `Score: n/10` and `Verdict:` lines,
  and keeps the rows, the stage, the rounds used and the history in one commit (`council.sync`), which wakes nobody. A
  reviewer past its hour counts as not answering and the lead is told to go on without it; a lead that starts more
  rounds than the council allows is told to finish (both kept on the reviewer's row, `stop_pending`, until T3 Code took
  the message); a lead past twelve hours is stopped. Only a child whose title names a round or says “council” or
  “review” is a reviewer, and only councils whose lead is at work are read. When the lead thread is
  done (work it delegated included), its reviewers are read once more and the agent is woken in the council's thread
  (trigger `council`, `DispatchContext.council`): with the agreed plan of an improving council that nobody said to
  build yet (event `plan`, stage `approve`), which the agent retells and asks about, or with the result (`finished`),
  which it concludes with `council_finish`. The person's go-ahead goes to the lead with `council_tell` and `goAhead`,
  taken only in a turn their own message started; changes they want go without it, and the lead changes the plan and
  comes back (`t3_thread_send`; `council.told` puts the lead's row back to work and watches its thread again). A turn
  the person writes in while the council waits is told so in one line (event `waiting`). One `council`
  card per council: its rows with each reviewer's provider mark, state, score and answer to read, and the lead; the
  message's text is what the agent asked the council (`council_start`'s `intro`), above the card, and the card's `note`
  Whombat's short status under it. The card changes where it is until the thread goes on under it; its next news then posts it again as
  the thread's newest message, quietly, and the old message keeps only the intro, with `messages.moved_card` naming the
  card so the apps link to it; where someone other than the agent wrote after it, the old message also keeps the card as
  it was (`messages.earlier_card`), which the apps fold into one line that opens it read-only (`placeCard`,
  `domain/card-move.ts`, [card-moves.md](docs/decisions/card-moves.md)); a checklist's card moves the same way. The
  person's own presses change a card where it is; the agent's words while it works (`council_note`) and its conclusion
  (`council_finish`) are replies of their own in the thread (`domain/under-card.ts`): the first quiet, the conclusion
  telling the person. The final card has every round's scores and the plan. A review or a research of a project offers
  what it found to change as a plain checklist right after `council_finish` (the wake names the project,
  `DispatchContext.council.project`); a council's own plan never goes on a checklist (`delegate_offer` with `council`
  is refused).
  A turn whose council or checklist tool went through (its contract's success status: `started`, `told`, `offered`,
  `finished` or `ok`) posts none of its own final words: the runner leaves the card as its answer (`CARD_ANSWER_TOOLS` in
  `runner/turn/reply.ts`). `councils.stop`, and a finish while the lead still works, tell the lead to stop and to cancel
  its reviewers (`t3_thread_send` with `restart`; an interrupt only when it can't be told, tried again until T3 Code
  answers); a council that finished with its lead done settles the lead thread in T3 Code once it is quiet. A council without a lead
  thread (one from before it, or one whose lead never started) is ended by the sweep.
- **Delegations** (`apps/server/src/delegate/`, [delegate.md](docs/decisions/delegate.md)): with T3 Code at Manage, the
  agent offers up to twelve ordinary tasks as one `delegation` card (`delegate_offer`, the plugin's `whombat:delegate`
  skill), a checklist the person ticks (`delegations.pick`) and hands over (`delegations.start`). The person chooses
  the AI (model, effort, fast tier) of one task or of every task (`delegations.setAi`, from `delegations.models`);
  each task uses its own choice, else the card's, else T3 Code's default. Each names its parts (`areas`); sharing a
  part sets a dependency (`after_id`). The card's `rules` go into every brief. `delegation.claim` starts the first
  ready task in a worktree from the fetched default branch, or a finished predecessor's source branch, and that thread
  leads every other waiting task whose effective provider, model, options and keep-open preference agree, with what
  each builds on first (`leadsWith`); one branch, one pull request. A task with another AI starts in a thread of its
  own, in the same round: a task taken along holds no place, and “at once” counts threads (or a group while its thread
  starts). The lead's brief (`taskBrief`) numbers the tasks as on the card when they were claimed
  (`delegation_tasks.item`, kept whatever the card's order becomes) and says when to use subagents (`subagentRules`: only for sizeable,
  independent parts, at most “at once”, shared files kept to the lead); the agent's own `t3_thread_launch` messages
  get the same lines (`t3CallArgs`). Lists handed over before the combined candidate (`integration_mode = 'legacy'`)
  group only the tasks after the first (`togetherWith`). A stored `group_id` joins the rows before the thread exists,
  so Stop, retry, more work and keep-open controls reach the shared job during launch too. While the lead works, the
  card gives its other rows the first row's number (`ledBy`), and the apps draw the thread as one row (“9 items
  together”, “4 of 9 done”) with its items under it: the lead writes “Item N done: …” as it finishes each, and the
  watcher reads its messages (`readSaid`, kept on `t3_watches.progress`) for those lines and its latest words, which go
  on the first row (`said`, `reported`). The T3 Code watch
  (`t3_watches.delegation_task_id`) reads the thread's answer, pull request, `Checks:` line, `Note:` line for the
  person and its `Item N:` line per task (`itemsOf`), by the number the task was given: each goes on its row, and one
  “not done”, or none at all (in the answer or as “Item N done” while it worked), fails that row; more work sent to
  the thread asks for those lines again: the task it was for must say again, and an item the new answer leaves alone
  keeps its earlier line, carried on with the answer. A wake tells
  a thread's answer once, on its first task (`answerWith` on the others). Ordinary automatic tasks test what they changed with
  `fast-test` when the repository has a `.fast-test.json`, otherwise with the quick checks its AGENTS.md or CLAUDE.md
  names, plus the checks it requires before a push, never the full suite
  ([fast-testing.md](docs/decisions/fast-testing.md)), and open source pull requests, leaving the check of everything
  together to the combined candidate; a thread fixing failing checks also runs the affected stages the failed run never
  reached before it pushes; waiting for remote checks holds no running place.
  With automatic merging (`integration_mode = 'batch'`), source pull requests stay open. A reserved thirteenth row,
  “Check everything together” (`kind = 'final'`), combines the eligible source heads with the latest default branch
  in dependency order, retaining ancestry. Kept-open work and automatic work depending on it are excluded. This row
  cannot be removed or unticked while automatic merging is on; the normal sweep backfills it for active lists that
  lack it. It opens one integration pull request, or checks the exact default-branch revision when there is no diff;
  when all the work is in one pull request (`onePullRequest`) the final row is given it and checks that pull request's
  head itself, brought up to date only when it lacks the default branch. Tried again on its own with the same inputs,
  it carries on with the candidate its earlier run left open.
  Required checks run once on that exact candidate, retaining critical database, browser and VM boundary checks
  relevant to the change. Its structured `Verification:` answer identifies the checked revision and base, expected
  checks and results, and the input fingerprint and generation Whombat supplied. `verify-final.ts` independently
  reads GitHub to confirm the heads, checks and source ancestry. When the default branch requires no checks on GitHub
  (`ciGate`), the final thread runs `fast-test` (or the repository's quick checks) on the candidate instead (reported
  as `local: fast-test`); one that couldn't run is reported, never replaced by the full suite.
  The specific GitHub Pro plan refusal from the rules endpoint counts as no rules only when the branch explicitly
  reports no protection and no required checks; other policy-read failures block merging. An unavailable independent
  read keeps the final task working with its completed answer and candidate, reports GitHub's actual blocker on its
  row and wakes the agent once for that blocker. The watcher retries those reads for the same completed run with
  backoff from fifteen seconds to fifteen minutes (`progress.verificationRetry`), without another review or test run.
  This also preserves a candidate that loses independent verification just before its merge starts. When no checks
  are required, CI isn't waited for; a CI result that already failed on the revision still stops the merge.
  A check that passed on one of those commits with exactly the candidate's files (the same tree)
  counts for the candidate unless its own run failed. Missing or running checks wait; failing results or
  insufficient independent evidence cannot authorize a merge. While it waits, the verification names the checks that
  haven't started (a queued run, or a pending status whose CI says it waits); one waiting past 30 minutes puts a line on
  the row and wakes the agent once per wait (`delegation.checks_stuck`, `checks_stuck_at`), and the line goes when they
  start. Adding or changing work invalidates the evidence,
  advances the final row's generation and stops its obsolete run. After verification, Whombat reads the list once more, claims the candidate in the commit pipeline (`delegation.claim_final_merge`, still the current
  checked candidate; changes that would replace its check, and a Stop, wait while `merge_claimed_at` is fresh; it stays
  after the merge, marking it as Whombat's until recorded) and merges the
  candidate's pull request on GitHub itself (`mergeChecked` in `delegate/run.ts`): a merge commit, which keeps its tree
  and the sources' ancestry, with GitHub's head guard set to the checked revision and only while the base is the
  checked one. GitHub's record of that merge then finishes it, as an external merge's does, so a restart in between
  loses nothing; a pull request already merged at the checked head counts as merged; a refusal leaves it open with
  GitHub's reason and wakes the agent (`delegation.final_merge_refused`; a retry of the final row merges it again),
  a moved head or base needs a new combined
  check, and a lost answer keeps the claim until the next pass reads it. Once Whombat merged it, the final row works on
  (`delegation.merge_next`) while its thread does only one more step (`deployBrief` with `DEPLOY_AFTER_MERGE`): putting
  it on DEV the way the repository's AGENTS.md or CLAUDE.md says, unless the checklist's rules say not to, or saying
  that they describe no DEV step; never production. Changes that would replace its check wait meanwhile, and however it
  ends, or is stopped, the work is recorded merged (`whombatMerged`), keeping the claim, so a retry of the final row
  puts it on DEV again however that ended; a hand-on that
  couldn't be sent or a restart cut off is finished from GitHub's record of the merge (`recordWhombatMerge`).
  A changed revision needs a new combined check; the delivered tree is independently confirmed. Final preparation and merging coordinate across
  cards for the same T3 Code connection and project. A legacy individual merge already in progress can finish during
  upgrade, after which the list still needs its combined check.
  A retry of a passing final check keeps its evidence; changed work, source revisions or bases still require fresh
  verification. Reopening clears the old outcome note. A mirrored external merge of the checked candidate preserves the review
  while live GitHub reads confirm its delivered tree, base, ancestry and checks; `delegation.checked_candidate_merged`
  then records the merge without starting another review. Other external source merges need a fresh final check.
  Queued, working or waiting-to-merge final work keeps the list open; a failed final ends as incomplete with source
  pull requests open. `delegation.merged_elsewhere` reconciles source pull requests merged through GitHub. The agent
  is woken (trigger `delegation`, `DispatchContext.delegation`) for judgment and once all tasks are over; more work
  for an ended task waits for a place (`send_pending`). A visible change sends before and after screenshots to the
  task's link on the direct listener (`/shots/<token>/…`, `delegate/upload.ts`); the server draws numbered changes
  (`council/shots.ts`) for the task's row. Finished tasks fold on the card; each row shows its state, step, question,
  checks, pictures and links. The message's text is the agent's intro and the card's `note` Whombat's short status;
  `delegate_update`'s note is a quiet reply and `delegate_finish`'s summary tells the person, with quick replies.
  The agent reads current GitHub evidence for CI and merge claims, and says DEV only as the final thread reported it.
  A completed batch source thread settles (once quiet, as every thread Whombat settles) once its delegated
  work is over and T3 Code watches no pull request for it, even while its source pull request awaits the final thread's
  merge. Otherwise its watch remains for quiet cleanup. Ending a list rechecks idle completed watches; the sweep
  repairs lists ended within seven days, including grouped and kept-open work. Cleanup preserves active pull-request
  watches and work resumed after the delegation ended, and retries a refused settlement.
  Every turn of the person's in the card's thread carries the card (`event: reply`) for `delegate_update`.
  `delegations.stopTask` and `delegations.stop` stop threads; runs have no time limit, and the watcher fails a task
  whose thread T3 Code no longer has or that never began. While a council,
  delegation or other hand-over works, `ChatThread.handedOver` hides Settle; `ChatThread.work`, conversation `Handoff`s
  and `@whombat/client`'s `threadWorkLine` show who works and how far along it is.
- **One Chat** ([one-chat.md](docs/decisions/one-chat.md)): every thread of the person's Chat is listed in Chat,
  software work too; a thread with work handed to T3 Code shows the job's parts in the thread. For apps
  from before, `chats.threads` and `chats.unread` with `place: code` answer nothing and `chats.place` answers the thread
  as it is; `thread_places` is left unused.
- **What an OAuth sign-in asks** ([connection-signin.md](docs/decisions/connection-signin.md)): an MCP
  sign-in asks the server's scope plus the entry's list (Cloudflare's: DNS, tunnels and the developer platform, nothing
  account-wide), and on a reconnect what calls needed since (an entry without a list: all it holds as well). A call the server refuses
  with `insufficient_scope` (HTTP 403, or the challenge in a tool error's `_meta`) is kept in `scopes_wanted` and asked
  once on a card in the thread that opens the connection's page, where Allow on {Name} signs in again
  (`connections/step-up.ts`); what an entry never asks for (`scopesNever`) is left to the person in the service.
- **Setting up from the chat** ([connect-in-chat.md](docs/decisions/connect-in-chat.md),
  [vault-simplify.md](docs/decisions/vault-simplify.md)): the agent's `connection_add` puts a card in the turn's thread
  that opens the connect form filled in — the address the network scan found, Look only or Manage chosen by risk, Sign
  in once first — and `vault_ask` a write-only card for any sign-in, in any room of the person's: a website's password
  (with an optional authenticator key), an API token or login, a server (`server`) or a one-time code (`code`)
  (`connections/ask.ts`, `vault/ask.ts`, `vault/ask-server.ts`, `guides/ask.ts`; the card and its words are core's). What
  the person types goes from `guides.act` straight into their Vault, saved as them. A `server` card signs in one of three
  ways — the password once to put the assistant's key on, the password kept sealed with that server, or their own
  private key saved as a Server key entry — trusting the host key on first contact, and closes after three tries that
  don't sign in; a code is held in the server's memory for the turn that asked, once. The agent is woken in the card's
  thread with how it went and the entry's id, never the value, unless the turn that asked still waits for it. The agent
  never asks for a secret in a message; `vault_add_server` takes no password. Proxmox VE, its Backup Server and Unraid
  (`asServer`) are offered as servers first. Any MCP server or API outside the catalog is set up by talking
  ([connect-by-talking.md](docs/decisions/connect-by-talking.md)): the agent gives `connection_add` a Custom entry
  (`custom_mcp`, `custom_api`) with its name, address, sign-in and notes; Whombat checks the address, asks an MCP server
  how it signs in, and posts a card that says what it connects and takes the key in a write-only field. Connect runs the
  connect form's own path as the person (the check with the key, then the tools read) and wakes the agent in the card's
  thread with the new connection; an MCP server with its own sign-in gets the form's link instead.
- **PlayStation 5** (`connections/adapters/ps5.ts`, `things/kinds/ps5.ts`): the catalog connection reads Payload Manager
  and optional ShadowMountPlus on the same console through the connection's destination policy. Adding it and checking
  it again use Payload Manager's `GET /list_payloads` without a credential or an MCP server. One Sony discovery search
  (UDP 9302, `outboundDatagram` under the same policy) says whether the console is awake or resting, its name and
  firmware; the card and the page use it when homebrew doesn't answer (`KindModule.unanswered`). Its page shows running
  homebrew, a shelf of game covers (ShadowMountPlus's icon route, fetched on its port), user storage, updates for every
  installed payload (one uploaded by hand by its file name) and Payload Manager itself, startup with how the last start
  went (Payload Manager's log), downloaded payloads and the console's versions. While updates wait they fill Live (“To
  update”) with a confirmed Update on each and Update all (`things/kinds/ps5-update.ts`): pressed, the server reads the
  updates again, refuses a version other than the one shown and runs the same steps as the assistant's tools. Typed
  writes always ask first; repository downloads recheck the
  approved version and checksum, reuse an exact stored copy when possible and verify stored metadata before anything runs, and an update of a payload uploaded by
  hand moves startup to the new copy and keeps the old one. Startup patches only its own fields and reads them back. A
  downloaded installer does not identify the installed offline cache: the connection keeps the WebKit installer Whombat
  ran. Remote reboot adds the optional SystemStateManager helper: a pinned public artifact is hash-verified before a
  new local upload, with startup unchanged. Its STATUS and separately approved REBOOT use TCP 9112 on the same host
  through `connectionLine` and `outboundLine` (destination policy, pinned DNS, bounded reply and a total deadline).
  Reboot checks the current helper pid and known storage jobs; a lost reply after writing is uncertain and never
  replayed. Acceptance does not prove completion. Missing homebrew stays calm: rest mode and reboot are normal
  ([ps5-connection.md](docs/decisions/ps5-connection.md)).
- **Found on your network** (`connections/discover.ts`, `found-servers.ts`, `found-scans.ts`): a scan of the home
  network's addresses on the catalog's ports, Modbus's and SSH's; a service is named by its entry's probes, a device by
  Modbus, and a computer by its SSH greeting (a server to add). One row stands for one machine, and what is connected
  or added as a server already is left out. The burrow's own scans run at start and daily, and right after the claim;
  what they find is named in the assistant's welcome, or in one message after it, with a button that connects or adds
  each ([first-day.md](docs/decisions/first-day.md)).
- **Accounts** (`apps/server/src/connectors/`): Google through an OAuth client the person stores, with tokens sealed
  per connection and refreshed on the server (`WHOMBAT_GOOGLE=real|fake|off`); the connector tools are pipeline
  commands, and sending, invites and sharing always ask; trashing mail and files goes to the provider's trash and asks
  unless the person allowed it. Each account (and GitHub) is a thing on Home and in the sidebar's Connections by its
  name ([accounts.md](docs/decisions/accounts.md)).
- **Servers** (`apps/server/src/hosts/`): the hosts service (`hosts/`, the program `whombat-hosts`) owns the agents on monitored servers, their
  history, alerts and consoles; the server talks to it over its socket, signs every change the person makes, relays
  consoles through the session, and gives the agent the built-in Servers connection, which acts without asking
  unless the person sets a server to ask before risky actions; powering off, restarting or updating the server this
  Whombat runs on always asks. A server's name, which the person can give it (“Attic server”), is Whombat's own
  (`server_names`, `hosts/names.ts`): read into memory with every fleet read, so every word a person reads uses it
  (`serverLabel`), while links, the hosts service and the tools keep the id and also find the server by the name
  ([server-names.md](docs/decisions/server-names.md)). A Mac is a server like the others (platform `macos`,
  [macos-servers.md](docs/decisions/macos-servers.md)): its detail adds its own facts, its screen and Whombat Helper
  (`macos`), its host console is its screen (`vnc` through the Mac's Screen Sharing, behind the host-shell switch
  only), and `hosts.screen` takes one step on it (`hosts/screen.ts`; a screenshot is `hosts.screenLook`). Only the
  screen's state (`status`) is a read anyone may take; a look, the apps' lists and every step are an owner's, within
  the hosts service's limits (`HOST_SCREEN_LIMITS`). The assistant's `mac_screen` sees the screen
  as a picture beside its answer and clicks, types and unlocks by position, and `mac_ui` presses buttons and fills
  fields by name through Whombat Helper; `connection_call` passes a tool's picture (`CallOutput.image`) to the agent
  as MCP image content. Sign in once adds a Mac with macOS 13 or later and gives its screen the password it signed in
  with when that user is at the screen; only the Mac keeps it. The apps build a server's page from the hosts data (`@whombat/client/hosts`): a verdict
  sentence from Worth a look's own lines, at most four tiles in words, the busiest machines or apps, and one closed
  Technical details fold with its versions, address, Whombat's helper, storage and pools; temporary machines (Incus
  projects other than `default`, CI jobs, leased sandboxes, Whombat's own `whombat.service=1` containers) stay out of
  its lists and counts until asked for. On a server's Storage tab, What uses the space shows each machine's and app's
  disk and replaces “Everything else” with a recent on-request disk breakdown (`server_disk_usage` / `hosts.diskUsage`,
  kept for 24 hours by the hosts service and measured at low priority without waking sleeping or unknown-state disks) together with when
  it was measured. Every page's head is Ask {assistant}, the service's own page, then ⋯ with the
  rest. [server-pages.md](docs/decisions/server-pages.md) A Mac's page has a Screen tab (`macScreenView`): the screen
  live on the web (the host's `vnc` console), a picture of it on demand on the phone, Unlock, the Mac's password sent
  once to the Mac (sealed in the step's mutation, so no cache keeps it), and Whombat Helper with its Accessibility.
  The Mac's own words about a step (a reason it failed, a note on one that worked) reach the person and the assistant.
- **A care plan when a server is added** (`apps/server/src/care/`, [care-plan.md](docs/decisions/care-plan.md)): every
  minute a home job reads the servers; one that first reports and isn't known yet (`server_cares`) is read (its
  machines, the storages that take backups) and core's `careSteps` picks the dialogs' defaults for its kind — nightly
  Proxmox backups (to a Backup Server or a storage on the network, else to a backup place that shares a folder over NFS
  — an Unraid server through Whombat's helper, else a TrueNAS through its API — added as storage first with
  `backup_place_nfs` and `proxmox_storage_add`), daily Incus snapshots, weekly QEMU/KVM backups and weekly system updates in the quiet hours, never a
  temporary machine. `care.start` posts the assistant's line in the server's thread and wakes a `look` turn there
  that proposes the ones that fit; the plan is a look's `look_plan` card (research key `care:server:<id>`), and Go
  ahead turns on the automations Whombat writes for it before the `look_fix` turn takes the rest. The server this
  Whombat runs on gets its plan once and keeps asking for its updates; a Whombat from before writes its servers down as
  known once. An older server's research is offered the same steps when its lines are missing backups or updates.
- **The Vault** (`apps/server/src/vault/`): the person's logins, API keys and SSH keys for the agent, secrets sealed
  and write-only. Each entry has one switch for the agent (`vault_entries.agent_on_at`, with an API's variable and an
  SSH key's servers beside it); `vault.giveKey` and `vault.takeKey` set it. An entry switched on reaches the agent only
  in the person's turns: an API's variables in each command's environment, an SSH key with its config and pinned host
  keys on a tmpfs (a server's kept password there too, which ssh reads through the commands' askpass helper,
  `whombat-askpass`, never from an argument or a variable), a login in Hermes's credential vault. A login may keep its
  authenticator key and a server its password, both sealed and shown only as set; backups carry them sealed.
  Whombat never makes a request with a secret for the agent.
  Entries may reach public hosts over https, and home-network addresses while the local network is open to the
  assistant, or only inside networks the person listed when it isn't (under that switch in What it may do). Every use is a neutral signed event plus a record of which entry. An MCP server is a Custom MCP
  server in Connections: at every read-write start each `mcp` entry moves there with its address, sign-in, secret and
  tool switches (`vault/move-mcp.ts`), and one that can't (the 50-connection limit, basic or query sign-in) stays a
  Hermes MCP server and reads “Move it to Connections”. Its screens name kinds in a person's words from core (Sign-in
  key, Password, Website login, Server key) and keep fingerprints, the `authorized_keys` line, sign-in types and
  variable names under Advanced or Technical details. [vault.md](docs/decisions/vault.md) (its “What holds today”),
  [vault-simplify.md](docs/decisions/vault-simplify.md), [settings-groups.md](docs/decisions/settings-groups.md)
- **Worth a look on a connection's page** is a strip on top, there only while it has a line, and at most three lines per check (two items and one “N more” past that,
  `things/quiet/items.ts`); a service's updates are one line, and a line's title is Whombat's own with the service's
  words as its detail. Amber is for what the person should do this week; permanent or routine conditions are grey
  heads-ups said once ([plain-words.md](docs/decisions/plain-words.md)). The web draws what is wrong now first, the worst
  first, and the heads-ups after it under SOON, each line's way forward only “Ask {assistant}” or “Show”
  ([ui-refresh-chat.md](docs/decisions/ui-refresh-chat.md)).
- **What Whombat watches** starts calm: every check of a kind, a device, a mail account or a server says whether it
  starts on (`startsOn`), and only the very important ones Whombat can act on do. A check that starts off is left out
  everywhere, as one switched off, until the person turns it on (`watch_ons`); `things/quiet/defaults.ts` keeps the
  table the readers ask. A server's alert rules that start off are switched off in the hosts service by Whombat's
  5-minute pass unless someone turned them on. [watch-defaults.md](docs/decisions/watch-defaults.md)
  An Ignore ends when its line gets worse or is gone for 12 passes in a row (`FIXED_PASSES`, about an hour). The
  assistant reads and switches checks with `watch_checks` (`things/quiet/agent.ts`), switching only when the person's own
  message started the turn; the switch is the person's, recorded with the assistant on it (`things.watch`) and an Undo.
  Inbox items carry the check behind them (`watch`) for *Stop watching this*.
  [on-purpose.md](docs/decisions/on-purpose.md)
- **Outbound requests**: any server-side fetch of a URL someone supplied goes through `lib/outbound.ts` (public
  addresses only, the resolved address pinned, no redirects, a size cap); link previews and the Vault add their own
  destination rules. A single UDP datagram and its answer (a console's discovery) go through `outboundDatagram` under
  the same rules.

## Everything else on the server

- **Plans** (`commands/plans.ts`, `domain/plan-follow.ts`): the agent's own work; steps have no owner and follow the
  run, approval, automation run or dispatch they link to. A step the agent stopped at for the person's word, with
  nothing linked to decide it, has “Go ahead”: a message in the plan's thread that tells the agent to carry on. Steps
  show buttons only where the person is needed (`planStepControls`); Start, Mark done and Cancel are in a step's menu.
- **Chat and Feedback** (`apps/server/src/chats/`): the person's two threaded rooms with the agent, where every
  top-level message starts a thread; `chats.threads` lists a room's threads, all, open or settled, each with the
  plain start of its newest reply (`ChatThread.last`, `threadPreview`) and the repository its work is in
  (`ChatThread.repo`: its automation runs', else the one repository of the jobs handed over from it,
  `chats/thread-repo.ts`), and the apps show the open ones as an inbox of two-line rows with an icon. A repository's
  icon is the picture its default branch carries (an `apple-touch-icon`, an app icon, a `favicon.png`; PNG, JPEG or
  WebP up to 256 KiB), found with one tree read and one download, kept as a picture attachment without a conversation
  that anyone in the burrow may read, and looked for again about once a day (`repo_icons`, `github/repo-icons.ts`):
  the list answers with what is kept and starts the look in the background. Clear chats hides
  the room's top level up to a time (`conversations.room_cleared_at`) and settles every thread that may settle. A finished thread
  settles on its first message (`messages.settled_at`, `settled_how`): by the person (`chats.settle`, or
  `chats.settleFinished` for the whole room), or in a round every 15 minutes, signed by the agent, after the person's
  quiet days, once a pull request of its runs merged or closed after their last word in it, or once every fix a
  customer's report made in it is live where the customer is, and only once nothing in it is new to the person; a
  thread where the
  assistant looked into a problem by itself settles when that problem went away (`resolved`). Never while a turn of
  the agent is queued or running in it or it waits for the person (a pending approval card, an unanswered question, an
  open guide card). Any new message in it opens it again in the same commit (`postMessage`); Open again keeps it open
  from the round until then (`kept_open_at`). Settling leaves the thread's Hermes session alone. The apps show only
  open threads in a room and list the settled ones under Settled.
  [chat-settle.md](docs/decisions/chat-settle.md)
  What is new in a thread is read from a marker per thread and viewer (`thread_reads`, `chats/unread.ts`): messages
  from others after it, and a first message only until the room's own marker passes it. The room's badge in Chat and
  Feedback counts open threads with something new; `chats.unread` lists them for the apps' dots, `chats.readThread`
  moves a marker forward and `chats.markUnread` back to before the newest message from someone else, and writing in a thread or settling it by hand reads it. Every change sends the person's badge
  (`conversation.unread`), on which the apps ask `chats.unread` again.
  [thread-unread.md](docs/decisions/thread-unread.md)
  Paged thread replies use a keyset range on `(created_at, ord)` through `messages_thread_idx`, fetching at most
  the requested limit plus one; an unpaged thread reads every reply. Cursor timestamps retain database precision.
  Read models group ordered message reactions and work children by parent once per read, with maps for plan
  references, preserving each query's child order without repeatedly scanning the whole result.
- **Search** (`read/search.ts`): Postgres full-text search over `search_documents` (English stems and the words as
  written), kept in sync by the pipeline and paged by a keyset cursor. What the asker may open is part of the query
  and every row is re-checked: the person sees every room, the agent every room but the branch rooms of switched-off
  repositories; an outsiders' turn searches nothing. What outsiders can steer is never indexed: an assessor's
  output, what an outsiders' run posted (`messages.outsiders_run`), an approval asked on such a run's card, and such a
  run's error.
- **Canvas**: Hocuspocus in the server, one Yjs document per canvas persisted to Postgres, reached through the
  session's collaboration stream; the agent edits server-side with `canvas_edit`.
- **Files** (`apps/server/src/files/`): an upload is reserved for one conversation, sent over a resumable session
  stream, sniffed and stored content-addressed under `$WHOMBAT_HOME/files`; a download checks on every open that its
  message is the burrow's. Signed events carry ids, sizes and hashes, never names or bytes.
- **Voice typing** (`apps/server/src/voice/`, [dictation.md](docs/decisions/dictation.md)): the person speaks in a
  composer and the box turns the recording into text with its own speech models. The settings (on, speech model,
  language, and the opt-in Dutch voice agreement — who agreed, when, and the Open RAIL-M licence version) are the box's
  one `voice_typing` row, changed in signed commits by `voice.update` and `voice.setDutchVoice` (which is blocked from
  the assistant). The speech service (`whombat-voice`, `WHOMBAT_VOICE_SOCKET`) says in its health which speech-to-text
  models and speech languages it runs and on which graphics chip; the model fetcher (`whombat-voice-models`,
  `WHOMBAT_VOICE_MODELS_SOCKET`) downloads both single-file speech-to-text models and the multi-file Supertonic 3 Dutch
  voice (pinned URLs, per-file SHA-256, resumable, with its `LICENSE`) into `/persist/voice-models`. The server asks
  the fetcher for what the settings and the desk's Talk want at start and after every change — fetching `supertonic`
  only after the person agrees in Settings, removing it when Dutch voice is off, and never removing speech-to-text
  models by itself — and while a model downloads reads it every 2 s and tells the person with `voice.changed`. A
  recording is a `dictation` upload: kept in memory, checked like any upload, sent to the speech service with the
  model, the language and (for Whisper) the names the person may say, and answered in `stream_done` as text; the audio
  and the text are never stored or logged. The desk's Talk mic is voice typing too: the desk socket's `hear` turns its
  recording into text the same way (allowed by Talk's own switch) for Talk's box, and the person sends the words as a
  question. Talk says its answers aloud with the speech service (Kokoro in the voice the person chose); an answer in
  Dutch, told by its words, is written out as it is said (numbers, times, names like pve-02) and said in the service's
  Dutch voice (Supertonic 3) of the same kind when installed, falling back to English Kokoro when absent or if Dutch
  synthesis fails ([desk-display-talk.md](docs/decisions/desk-display-talk.md), appliance `nixos.md` NX-529).
  `WHOMBAT_VOICE=fake` brings a fake speech service and a fake fetcher whose downloads take a few seconds.
- **Notifications** (`domain/message-notify.ts`): one rule decides what notifies the person, at their level for the
  room; the agent and Whombat's signers are never notified. Do not disturb and quiet hours hold push back.
- **Home** (`apps/server/src/home/`): `home.overview` (the things, Done recently with Undo, widgets, health, and the
  finished tasks of today, `doneToday`: `done_tasks` since the start of their day, each with its thread, whether a
  look's research there ended fixed, and Undo when the task made exactly one change that can still be undone;
  [status-line.md](docs/decisions/status-line.md)) and the one
  **Inbox** (`needsYouList`, `home/needs-you-list.ts`): what needs the person — approvals, questions,
  connections to sign in again, enrolments, and from the registry's sources the servers' alerts and hints, connections
  that stopped or have a watched problem, devices that don't answer, failed automations and the servers' heads-ups — each item once, about its
  server, connection or device with the assistant's research on it, in a group decided by who has to act (core's
  `needsYouGroupOf`: needs you, the assistant's on it, heads-ups, quiet; the apps split quiet into Later and Settled by
  the item's state). Only the first group counts: `summary.needsYou` is the count every place shows, and the desk
  screen's pill leaves out what the list doesn't count (heads-ups, what the assistant is on). Settle
  (`needsYou.ignore`) is the shared Ignore of the line behind the item, until it happens again, or the person's own;
  Remind me tomorrow and Bring it back are the person's own. *Ask {assistant} to handle it* is `looks.handle` on the
  item's thing, else a question in the newest thread about it (`chats.start` with `reuseThread`); *Talk to
  {assistant} about it* (`needsYou.discuss`) starts a thread the assistant opens with the item's words, read from the
  person's Inbox, without a turn. `needsYou` and `watch.list` answer as before for an older app.
  [needs-you-list.md](docs/decisions/needs-you-list.md), [inbox.md](docs/decisions/inbox.md)
- **Looks** (`apps/server/src/looks/`, [look-research.md](docs/decisions/look-research.md),
  [handle-it.md](docs/decisions/handle-it.md)): every minute a home job reads the looks as the desk does, each with
  every line of its thing that asks (the quiet rules' verdicts); one seen on two passes in a row is looked into by the
  assistant, one at a time, at most 12 a day and 2 of one thing: its own quiet line in the thing's thread of the
  person's Chat (a new thread the first time) wakes a `look` turn there that reads all those lines, which ends with
  `look_report` (what is wrong, fixed, the one step it offers or a plan of several). *Ask {assistant} to handle these*
  (`looks.handle`) starts the same at once as the person, outside the day's count. The research (`look_researches`,
  one live row per thing, with the lines it covers) is on the desk's looks and hero, Home's Needs you and the thing's
  page (a server's through `looks.get`); a plan is also one `look_plan` card in the thread, resolved from the row. The
  step's button or Go ahead (`looks.fix`, the desk's `look/fix`) posts the person's go-ahead in the thread and wakes a
  `look_fix` turn for exactly those steps; the person's reply while a plan waits may change it. A finding with a step
  for the person pushes once. A server's care plan (above) is a research of its own beside its looks: the watcher keeps
  it while it waits, leaves the server's missing backups to it, and never counts it against the day. A look that goes, gets worse or gains a line it didn't cover ends its research, and its
  thread settles when the person didn't write in it; one that comes back as it was within a week gets the last finding
  back at once, without a message or a turn.
- **Quiet hours for changes** (`care/window.ts`, [care-plan.md](docs/decisions/care-plan.md)): one change window per
  Whombat (`burrows.change_window_*`, 03:00–05:00 in its time zone until the person moves it with `changeWindow.set`).
  The care plans' updates and restarts use it, an approval's *Tonight* runs at its start, and every turn of the
  person's is told it (`DispatchContext.changeWindow`). The box's own updates are the appliance's, not this.
- **Backup files** (`apps/server/src/backups/`): the person's encrypted file of chosen categories (Argon2id,
  XChaCha20-Poly1305). Making one reads the burrow in one snapshot; restoring (one at a time per burrow) checks the
  whole file first, then replays each category in batches through the pipeline, matched by portable keys, and puts both
  Hermes homes back through the runner. [backup-file.md](docs/decisions/backup-file.md)

## Clients (`apps/web`, `apps/mobile`, `packages/client`)

The web app (hosted at app.whombat.com and dev.whombat.com, and served by the box on its direct listener) and the
Android app speak only the encrypted session, through `@whombat/client`, whose reducers apply realtime frames to the
query cache. An index per query cache follows endpoint entries as they are added and removed, so realtime patches
visit the affected endpoint's queries. Thread-list events retain unchanged pages and response wrappers. The built page preloads its own root's chunks
(`apps/web/boot-preload.ts`), components that need part of the bootstrap select it (`useBootstrapSelect`) so a
realtime event redraws only what it changed, and a resync refetches each query once. Home's overview refetches at most once a second however many frames ask
(`query/calm.ts`). On the phone, reads on a screen out of view don't refetch (`ScreenFocusContext`, set by the
navigators; both pages count on the open Duo) and catch up when it shows, and coming back to the app refetches only
what the live subscription couldn't resume ([live-data-calm.md](docs/app/decisions/live-data-calm.md)). Rules both apps use (the
automation asker, notification words, the Vault form's rules, schedules' and tracker reports' words, the managed app's
session hooks) are `@whombat/client`'s. Shared
Markdown parsing matches labels, skips list gaps, compiles fences and counts URL punctuation once per relevant
input; its output tree and syntax stay the same. The web terminal mirrors only changed styles into constructable
stylesheets under the hosted CSP, leaving ordinary output mutations out of CSS parsing.
Resource downloads remove cancellation listeners on every terminal path and reject cancellation before metadata.
The client ends its half of completed downloads and exports, and cancels unfinished streams when their consumer
stops or fails. Failed local upload reads reset the peer's stream; asynchronous reads and sends recheck cancellation.
A cancelled bulk-slot waiter leaves the queue immediately; each caller can stop waiting for a shared connection
without cancelling the session's dial for other transfers.
A connection goes to the box's own private addresses and Tailscale name first
(each welcome names them), a quarter second apart, and to the relay beside them after a second; the first to open carries it
([open-speed.md](docs/app/decisions/open-speed.md)). The hosted appliance list prepares one already-trusted session
on hover/focus and gives it to the app on selection,
closing unused preparations after ten seconds. Relay admission follows connection cancellation and has its own
15-second deadline, including the HTTP response body and refusal lookup. The first Chat/Feedback reads share the
screens' query keys and subscribe before message history; the automations list loads with its own screen. Local
`whombat.open.*` Performance marks separate selection-to-welcome from welcome-to-content, and the tab's
`window.__WHOMBAT_OPEN_TIMINGS__()` export keeps at most ten content-free samples
([open-speed.md](docs/decisions/open-speed.md)). Styling is CSS Modules over `@whombat/tokens` variables; the Android
app is Expo/React Native with native modules for live activities, the microphone and the session's cipher and hash
(`modules/whombat-crypto`: javax.crypto on Android, CryptoKit on iPhone, each used once it matches the pure-JS code;
[ios-crypto-speed.md](docs/app/decisions/ios-crypto-speed.md)); its swipes and their animations
run on the display thread (react-native-gesture-handler, Reanimated), and on iPhone its pickers are SwiftUI's
(`@expo/ui`; [native-feel.md](docs/app/decisions/native-feel.md)). Voice typing records in the
client (an AudioWorklet in the browser, `modules/whombat-voice` on the phone) a 16 kHz mono WAV that goes to the box as
a `dictation` upload; the words come back into the draft at the cursor, through one controller shared by both
(`@whombat/client/voice`; [dictation.md](docs/decisions/dictation.md)). Both draw the Inbox from one view model
(`@whombat/client` `needsYouListView`: its groups, each row's buttons, its swipe and More, and what they do); a row
shows its way forward (a line that needs the person only that, Settle with the rest in More), the rest behind ⋯ on the
web and in the swipe's More on the phone (`ui/swipeRow.tsx`, as Chat's threads), and Settled is a bar pinned to the
bottom of the screen that opens upward. An approval is the same card in its thread, its dialog, the Inbox and the
phone's approval screen (core `approvalCardFacts`, web `AskCard`;
[approval-card.md](docs/decisions/approval-card.md)). Chat's head leads to everything the assistant did (`/done`). The web's sidebar is Chat · Inbox · Overview · Automations · Files · Vault · Settings (`assistantSidebarModel.ts`; Feedback opens from Chat's head, Search is ⌘K / Ctrl K; Usage isn't offered), then Servers and Connections as two tabs (Servers first, the other tab's
problems still in view; `assistantSidebarModel.ts` `sidebarLists`); then the person, whose row opens the account menu (Settings → You's parts first, then Phone app, notifications, the theme, Sign out); below 1024 px it is the Places drawer under a 56px bar with Places at the left and what needs you at the right. Search (`/search`) groups the Whombat's chat results with the things, settings and places it matches in the page (`features/search/searchCatalog.ts`). The phone's tabs are Chat · Inbox · Overview ·
Automations · Settings; a tab's screen has one top row: Places' ☰ at the left, the tab's title, and Search's magnifier at
the right ([chat-inbox-phone.md](docs/app/decisions/chat-inbox-phone.md), [one-chat.md](docs/decisions/one-chat.md), [automations-tab.md](docs/app/decisions/automations-tab.md),
[sidebar-tabs.md](docs/decisions/sidebar-tabs.md), [final-shell-web.md](docs/decisions/final-shell-web.md)); Overview is the page at `/connections`: the broken thing first, then
Servers, Connections and Pinned as sections of one page with jump links to them (an old `?tab=` scrolls to its
section). The servers are one list with the same columns (a card each on a narrow page and in the phone app), a
connection is a small tile, and what a row and a tile say is shared by web and phone (`@whombat/client`
`hosts/overview.ts`, `home/overview.ts`; [overview-one-page.md](docs/decisions/overview-one-page.md)). The web's Inbox is `/inbox`; a push or a link about an item (`/needs-you?item=`, which
the web sends on to `/inbox`) opens that item. The phone app lays out by its window's shape
(`src/data/screenShape.ts`): the tabs along the bottom of a phone (on iPhone iOS's own tab bar,
`navigation/GlassTabs.tsx`), down the side where the system keeps its own vertical
bar (the iPhone Duo) or on a wide window, and from 840 points wide two pages — the tabs as the list, what they opened
on the wider page beside them, the line between them dragged and kept on the phone; the software keyboard is followed on the UI thread
(`react-native-keyboard-controller`, `ui/keyboard.tsx`) and a screen's lists run to the window's bottom, padded by what
covers it (`ui/screenBottom.tsx`; [duo-polish.md](docs/app/decisions/duo-polish.md)). Chat's and Feedback's lists have no
message box: one round New chat button floats over the list and opens a new chat, a page with the one box to write in,
which becomes the thread once it is sent; with two pages Chat's new chat is the right page while nothing is open on it. The web's
lists have the same button: the new chat is `?new=1`, beside the list on a wide screen while no thread is open and in
the list's place on a narrower one ([chat-inbox-web.md](docs/app/decisions/chat-inbox-web.md)). Beside Chat a
button in the right page's header hides Chat's list, so what is open takes the whole width (kept on the phone). One root stack
(`navigation/SplitStack.tsx`) is drawn either way, so folding keeps the place; the fold, the clock and the hinge come
from `modules/whombat-fold` ([iphone-duo.md](docs/app/decisions/iphone-duo.md)). On iPhone a long press or a ⋯ opens iOS's own
compact menu (`modules/whombat-menu`, `ui/nativeMenu.tsx`), a message's words are iOS's selectable text view
(`@bsky.app/react-native-uitextview`) and a sheet is the system's form sheet sized to its panel
(with two pages the app's own, at the bottom of its page)
(`modules/whombat-sheet`, `ui/sheet.tsx`); Android keeps the app's sheets
([ios-message-menu.md](docs/app/decisions/ios-message-menu.md), [ios-native.md](docs/app/decisions/ios-native.md)).
Both phones open the hosted UI's links and use its passkeys: Android through App Links and Credential Manager
(`apps/web/public/.well-known/assetlinks.json`), the iPhone through Universal Links and AuthenticationServices
(`apple-app-site-association` beside it). Android takes shares from other apps and offers a small home-screen status widget (`modules/whombat-live`, RemoteViews) showing the box's name, its last calm status (`homeWidgetStatus` in `packages/client/src/home/greeting.ts`, never naming threads or services) and its saved timestamp formatted at draw time (“as of 14:05” today, “as of yesterday 23:50”, or “as of 21 Nov” older, rolling at midnight without background fetches), updated by the app (`StatusWidgetBridge`) and cleared on sign-out or box removal; the iPhone's share extension and matching WidgetKit home-screen widget both use the app group `group.com.whombat.mobile` and stay gated behind one flag in `apps/mobile/app.config.cjs` until Apple has that group
([ios-parity.md](docs/app/decisions/ios-parity.md), [mobile-live.md](docs/decisions/mobile-live.md)).
Connections' title is one status sentence true to the worst state (`homeStatus` in
`packages/client/src/home/greeting.ts`, with what the assistant fixed from Home's `doneToday`). What needs the person is
the Inbox's (the phone's Inbox tab) alone: Chat carries no status line of its own, and its head has Files
while there is a file to see ([status-line.md](docs/decisions/status-line.md)). Claiming a new
Whombat (the hosted app's `ManagedRoot`, the phone's `ManagedApp`) is three steps — the claim, where backups go (what is
there first: a NAS the scan found, a USB disk), and Connect your AI (`/connect-ai` in the box's own app on the web; on the
phone ChatGPT's device code and Claude Code's own sign-in open the providers' pages in the in-app browser). On a box's
own page the setup is one count of seven: the claim's four steps (`BoxSetup`), then onboarding's Name your Whombat, Set
up your AI (Continue once an AI is signed in, or Skip for now) and Meet your agent, carrying on the count. Empty
first screens show one step, not empty sections ([first-day.md](docs/decisions/first-day.md)). The hosted app is
also the account site for Whombat Link: open sign-up by magic link, `/link` where a person enters the code their
Whombat's screen shows and ticks the Subscription Terms, and Your Whombats (`/account`, `/billing`) with each Whombat's
Open at its own address (the one this browser opened last first), the Link subscription by the month or the year with
a promotion code on Stripe's page and its free time (Stripe Checkout to start paying, the portal once Stripe has the
subscription, through control) and each Whombat's Link state; an account with an organization made before Link keeps
its hosted list ([link-account-site.md](docs/app/decisions/link-account-site.md)). The legal pages are
`apps/web/src/legal/*.md` at `/legal/…`. Development and the visual harness:
[docs/app/README.md](docs/app/README.md).

What a person reads follows one word list (your Whombat, Whombat’s helper, machine, app, storage, sign in again,
Ask {assistant}; [plain-words.md](docs/decisions/plain-words.md)). An error reaching a person goes through one helper
(`@whombat/client` `problemOf`): the server's sentence stands, anything only a developer could read becomes a plain
sentence, its raw words under More detail where there is room. Schedules are said in words (`cronWords` in
`@whombat/core`), never as cron or in the Whombat's own time zone, and dates are day first.

Settings opens on a home, the same on the web and the phone: Often used (Notifications, Theme, and on the web Phone app,
the QR sign-in at `/settings?tab=phone` that You → Devices' Add a phone also opens; `/mobile` keeps a page of its own
in the sign-in frame only where no Whombat is open), then six groups —
You (profile, notifications, devices), the assistant by its name (name and face, the AI sign-in, memory with its notes,
and what it may do — every permission by thing in the words Just watch · Ask me first · Go ahead), Connections (what
this Whombat is signed in to: what needs you, accounts, apps and services; `@whombat/client/connections`
`settingsList.ts`; also on Overview), This Whombat (overview, backups, About), Screens (where it has a screen) and
Advanced, a folded list of the expert pages (the model, the AI programs, what runs, skills, the audit log and signing
keys, diagnostics); each group is a page of its own. What the assistant may do holds its keys, the commands always
allowed (folded) and, while the local network is closed to it, the home networks it may reach. On both, a home row says how things are
where it can (This Whombat's what needs you there, the web's Phone app which phone is in). The groups, their parts, the home's
rows and Advanced's rows are `@whombat/client`'s (`settingsGroups.ts`, `agentPermissions.ts`); on the web `/settings`
alone is the home, each group is `?tab=` with its `&part=` (You has no tab and names its part, This Whombat's
`&section=`), and every older Settings address is redirected to where its content went (`routing/search.ts`
`settingsRedirect`). The Spend report is Usage, a page of its own without Settings' frame that nothing on the web links to (the words `@whombat/client` `usageView`).
Vault, Files and Usage share the home's look (`features/settings/Place.tsx`, the phone's `ui/place.tsx`). Adding a connection
and a connection's own pages live at Overview's address (`/connections?connection=…`). Search's developer kinds and
settling on a merge show only where GitHub or website feedback is connected
([settings-groups.md](docs/decisions/settings-groups.md)).

This Whombat → Backups is one page on the web and the phone, its words and views `@whombat/client/managed`'s
(`backup-options.ts`): the top card follows where the backups stand (backing up now, the last backup didn't work with
*Ask {assistant} to fix it*, behind, backed up just now, its shield likewise), says what the last backup left out and
whether the Whombat can be brought back, or — one rule for both apps, `backupPasskeyAsked` — asks once for the passkey's
setup (`setUpOnePasskey`, from every setup button); then the older backups still on the box, the list by day with each backup's
page (what's in it from its own coverage), and Details (where they are kept, who clears them, checking the newest, the
optional paper copy printed or saved from `paperCopyText`). A Whombat from before the passkey keeps its recovery kit's
rows. Bringing a Whombat back is a full-screen flow of its own session (the web's `/appliances/<device>/start` after a
claim and `/bring-back` from the app, the phone's `restore` route): the passkey's copy from the account, else Look on my
network, else the paper copy (scanned on the phone, its file or text), a backup to choose, the steps while the runtime
is away, one question, and a last step that finishes the same passkey setup for access and backups; it resumes where a restore stands, opens
from the Inbox's Finish and Try again, and stays offered while a Whombat started fresh (`replace`). The backup file is
Move to another Whombat ([backup-v2.md](docs/app/decisions/backup-v2.md)).

## Local environment (development)

- Node 24, pnpm 12, Postgres 17 on port 55432 and Mailpit (SMTP 51025, UI 58025); exact steps and the rules for
  shared services are in [docs/development.md](docs/development.md).
- **`pnpm dev`** (`scripts/dev.ts`) runs the server, the runner and agent-net as one development box, with stand-ins
  for what production gets from outside (`managed/dev-standins.ts`): no licence; the box's identity made at the first
  start under `$WHOMBAT_HOME/identity/`; a stand-in manager on `$WHOMBAT_HOME/manager.sock` that pushes nothing (no
  relay); FakeGitHub; the scripted Hermes unless `WHOMBAT_HERMES_BIN` names a real one (`pnpm hermes:install`); and
  the boot migrating the database. It has no `device.json`, so `WHOMBAT_EDITION=community pnpm dev` plays a box claimed on
  its own page (without it, one control registered); its stand-in manager has no Link.
- The direct listener is on `PORT + 80`; a browser on the same machine opens `http://localhost:<PORT + 80>/` and is
  let in by development enrolment (`enroll.dev`). `pnpm db:seed` loads the mock world (Mara and Dusty);
  `pnpm dev:ask "<text>"` asks the agent in the person's Chat and prints the answer.
- The runner always sandboxes; on a development host its cgroups come from a transient systemd user scope
  (`WHOMBAT_SANDBOX_CGROUP=systemd-user`; the appliance sets `delegated`). Commands use the host's tools unless
  `WHOMBAT_AGENT_TOOLS` is set, and have no Docker without `WHOMBAT_CONTAINERS_SOCKET`.
- The demo: on your own database, `pnpm db:reset && pnpm db:seed` loads the mock world as of Wednesday 23 September
  2026 11:22 (Europe/Amsterdam), `--relative` shifts it to today; `WHOMBAT_DEMO=1` makes the scripted Hermes play
  the storyline. The full environment (relay, control, the manager) is the appliance's dev stack.
- DEV delivery runs through the appliance's `dev/candidate`: it builds the release's versioned runtime and pin checks
  together, alongside the backup. The app and runtime share a clean checkout and install when their pins match, and
  their pages build while services start. Publication waits for the build and a healthy stack; `summary.json` records
  the time through publication and notes, before Home's next update check
  ([build-deployment-speed.md](docs/decisions/build-deployment-speed.md)).
  The environment archive uses up to four gzip compression workers with `pigz` when installed, with ordinary gzip
  as the fallback; its `.tar.gz` format and restoration are the same.

## Tests and quality gates

- A change is tested with `fast-test`, a tool outside this repository that reads a recipe (`.fast-test.json`) and
  tests only what changed since `main`: quick tests on the development machine, heavy ones on the project's own build
  server. The full suite runs there every night and with `fast-test --full` when someone asks ([fast-testing.md](docs/decisions/fast-testing.md)).
  A change to a shared package's source (`packages/*/src/**`) runs the types of everything that depends on the package
  and every unit test that imports the changed files, on the build server; other shared files run the full check there.
  A failing test runs once more by itself (every Vitest config, through `scripts/vitest-project.ts`), not the step
  around it. `appliance/` and `hosts/` have steps of their own, which run inside their folder
  (`scripts/ci/in-folder.sh`); the full check is `scripts/ci/full.sh`: `pnpm check`, the appliance's Go tests, harness
  and console page, and the hosts service's Go and web tests, and for a wide change only the parts that changed. The integration steps use the shared development Postgres when it answers and a throwaway one of the
  run's own otherwise; the whole integration suite always runs in its own.
- `pnpm check` = Biome + the third-party notices check (`pnpm notices --check`,
  [licence-notices.md](docs/decisions/licence-notices.md)) + typecheck + unit tests for every workspace, among them
  the decision-id check (`scripts/decision-ids/`, [decision-ids.md](docs/decisions/decision-ids.md)). The four run
  side by side, and the first to fail stops the others.
  `pnpm test:server` runs the integration tests (`*.int.test.ts`) against a throwaway database per file; they boot as
  `pnpm dev` does (`useTestServer`) and call operations in-process as the person, through the dispatcher's allowlist,
  guards, parsing and contract checks.
  `pnpm test:cli` runs `schema-check` and `migrate`. Run one repository's checks at a time.
- Unit-test logic; check the facts a prompt or message carries, not its sentences; wait on events instead of
  sleeping ([test-speed.md](docs/decisions/test-speed.md)).
- The apps' fakes answer through the real contract: the client checks every answer against its schema in tests, and a
  web or phone test fails when the app had to leave part of a fake's answer out
  ([fake-contracts.md](docs/decisions/fake-contracts.md)).
- On a developer's machine Vitest keeps the modules it transformed between runs (`scripts/vitest-project.ts`, keyed
  also by the packages' `exports`, the tsconfigs and the files a config loads) and starts the slowest files first
  (`scripts/vitest-sequencer.ts`); CI (`CI=true`) does neither, so a check there depends on no earlier run.
- The browser journeys (`pnpm e2e:managed`, `e2e:box`) use fake boxes; the managed ones run on a bundled development
  build of the page served by `vite preview`, not the dev server
  ([ci-app-journeys.md](docs/decisions/ci-app-journeys.md)). `pnpm e2e:runtime` uses a disposable real runtime and
  private home: development enrollment, a message through the direct encrypted session, the actual runner’s scripted
  Hermes reply and a browser reload from Postgres. Its processes and database are removed on exit.
  These suites, the visual comparison and the Android build are outside `pnpm check`.
- CI runs on the project's own build server through `ci-platform` (`pnpm ci:check`, `scripts/ci/check.py`: the
  notices check, lint, types, affected or full unit tests, the complete Postgres suite, the CLI's `schema-check` and
  `migrate` tests and soak, then the contracts' generated files, Go tests, the Hermes plugin's tests on the pinned Hermes
  (`pnpm hermes:test --hermes pin`) and the CI execution-contract tests). Unit selection is conservative and recorded
  ([ci-selection.md](docs/decisions/ci-selection.md)); local `pnpm check` runs every unit test. The package job builds the
  runtime bundle twice and compares.
  `ci/platform/ci.yml` also defines an `app` job (the web builds, the fake-world journeys and `e2e:runtime` on the job's
  own Postgres) and `extended.yml` the daily visual and Android jobs; `appliance.yml` and
  `appliance-virtual-machines.yml` hold the appliance's jobs (its Go checks, the Nix builds, the VM tests), whose steps
  run in `appliance/`. ci-platform's installed configuration decides which of them run. One VM test, `update-migration`,
  updates a box from an earlier release; the repository names none
  (`appliance/vm-tests/common/migration-baseline.json`), so it runs only where `WHOMBAT_MIGRATION_BASELINE` names one. `ci/platform/` is outside `.github/workflows` because GitHub would run self-hosted jobs there; public CI
  (`.github/workflows/public-ci.yml`) runs on GitHub's runners: `pnpm check`, the contracts' checks, the appliance's
  and the hosts service's checks and a secret scan. A pull request runs the jobs of the parts it changes, a push to
  `main` all of them, and its last job, `public-ci`, is the one a pull request must pass.
- Private values stay out of the repository ([public-copy.md](docs/decisions/public-copy.md)): the maintainers'
  private guard list, found by `scripts/guards.sh`, is checked by `scripts/check-forbidden.sh` (every rule, in `pnpm
  lint`, `pnpm check` and fast-test's lint step) and by `scripts/scan-artifacts.sh` in what the release tools build
  (required there: `WHOMBAT_GUARDS_REQUIRED=1`); without the list both skip. The maintainers' own hooks check every
  commit message and push against it, pictures included. The list also refuses the account the repositories were
  private on and the addresses of the repositories that are folders now.

## Production

app.whombat.com runs the old self-hosted mode, which this runtime doesn't have; its operator updates it by hand.
The standalone `whombat-dev` (127.0.0.1:4420) stays on its own older runtime.
