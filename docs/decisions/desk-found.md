# Found on your network, on the screen (DF-*), and Synology and QNAP (NS-*)

John, 2026-10-20 (main checkout): “When we just installed a new appliance and we have a screen, it would be nice to see
what the Whombat appliance found on the network that we can connect to … the user should be amazed that the appliance
already found several devices in the network that can be configured.” After the proposal (mockups in appliance
`docs/design/desk-found/`): “Implement this fully and also implement the things you suggested, like supporting Synology
and QNAP and fixing the IP range.”

Numbers: contracts 0.110.0 (CT-700…CT-729), app 0.112.0 (AP-3800…AP-3899), appliance CG-230…CG-259 and NX-370…NX-389,
Whombat migration 0127. Server decisions taken while building are DF-S01…, app AP-38xx, console CG-23x.

## What it is (DF-01…DF-05)

- **DF-01 The screen says what Whombat found and where to connect it.** On a box with a paired screen the glance shows
  the services the scan found that aren't connected yet: a mark, the name, a short line on what it is (DF-08) and the
  address. Its footer says where to connect them: “Connect them on your computer: {appUrl} → Connections”. Connecting
  happens on the website (or the phone), never on the screen: signing in to a NAS or a hypervisor needs a password and a
  keyboard, and the website already has the whole flow (CS-50…CS-53).
- **DF-02 The scan runs by itself.** `connections.discover` (CS-14) ran only when someone opened Connections. Now the
  server also starts one, as the burrow (no person), when the burrow first has an owner with an assistant (right after
  the claim, the moment the screen pairs itself, DK-17), at every runtime start, and once a day — as long as the burrow
  hasn't put the view away (DF-04). Same scan, same rules, same one-at-a-time; the website's Found on your network then
  shows a result at once instead of starting one. It runs on boxes without a screen too (DF-05 and the website need it).
- **DF-03 What counts as new.** A found service shows when it isn't connected as CS-52 decides for the person the screen
  is paired with (else the burrow's first owner) and isn't hidden (CS-53). Connecting one on the website takes its card
  away at the next glance; hiding one does the same. Things found are listed in catalog order, then by address, so Home
  Assistant and the hypervisors come first; at most 8 are named, the rest counted.
- **DF-04 Not now puts it away on this Whombat.** The panel and the strip have Not now. It works locked too (it shows
  nothing and changes nothing but the screen), it is final for the burrow, and it also ends the automatic scans (the
  website scans when opened, as before). The website's list stays. Bringing it back is not offered: there is nothing to
  miss, the same list is under Connections.
- **DF-05 Superseded by first-day.md FDY-13, FDY-14** (the welcome names the finds, or one message with a button each after it). **The assistant says it once, in Chat.** After the first automatic scan that finds something new, the burrow's
  assistant posts one message to the person in DF-03, in the place it greets them after the claim: “I looked around your
  network and found 8 things I can look after, like Home Assistant, Proxmox VE and Unraid. Connect the ones you want under
  Connections.” with Connections linking to the website's Found on your network (`/settings?tab=connections&found=1`,
  AP-38xx). Short and plain (concise-replies.md); never again for that burrow, and nothing when nothing new was found.
  Boxes without a screen get only this.

## On the screen (DF-06…DF-12)

- **DF-06 Panel, strip, nothing.** A box with no servers and no home tiles shows the found panel where *This Whombat*
  would be (mockup frames 1 and 2): up to 8 cards in two rows of four. Beside servers or tiles it is a one-line strip,
  “Still on your network”, with the marks and names as chips and “Connect on {appUrl}” (frame 3), placed after the
  servers and tiles by the desk-fit planner (DK-37…DK-43). It is not shown in *Only the time*, after Not now, or when
  nothing new is left. Older consoles drop `found` (additive) and show what they show today.
- **DF-07 While looking.** The first automatic scan on a burrow shows the panel at once, before anything is found, with
  “Looked at 412 of 1 022 addresses” and a bar; cards arrive as the scan finds them and the rest of the eight places are
  dashed outlines. Later scans don't show the looking state: the panel or strip just keeps the last result until the new
  one is in.
- **DF-08 A short line per service** (`tagline` in the catalog, CT-7xx): what it is to a person, at most 40 characters,
  no full stop: “Lights, heating and sensors”, “Virtual machines and backups”, “Storage, Docker and VMs”. Every entry a scan
  can find has one.
- **DF-09 The words** (verbatim; the assistant's line replaces the calm “All fine. I’m ready when you are.” only while
  nothing needs you and nothing is being worked on):
  - Looking, nothing yet: **“I’m looking around your network.”** “Things I can look after show up here.”
  - Looking, some found: **“I’m looking around your network.”** “{n} found so far.”
  - Done: **“I found {n} things I can look after.”** “Connect the ones you want, and I’ll keep an eye on them here.”
    One: **“I found one thing I can look after.”** “Connect it, and I’ll keep an eye on it here.”
  - Panel title “Found on your network”; right: “Looked at {done} of {total} addresses” while looking, “{n} found ·
    {ago}” after (the glance's own `ago`).
  - Panel footer “Connect them on your computer: {appUrl} → Connections” (one: “Connect it on your computer: …”) and
    the button “Not now”. Strip: label “Still on your network”, chips, “+{k} more” when they don't fit, “Connect on
    {appUrl}”, “Not now”. Numbers use the glance's thin-space grouping (“1 022”).
- **DF-10 Calm motion.** A new card fades in once (200 ms, none with reduced motion); nothing loops: the kiosk renders
  without a GPU (CG-36 era lesson: idle animation cost ~97 % CPU).
- **DF-11 Shown while locked.** Names and home-network addresses of the owner's own things, like the server cards; the
  panel holds nothing else.
- **DF-12 Marks.** The console carries the marks of every findable entry (the app's, Simple Icons 16.34.0), Synology and
  QNAP included; a missing mark shows the entry's first letter.

## The scan's reach (DF-13…DF-14)

- **DF-13 The box's own network as it is, up to a /22.** CS-14 took the /24 around the box's address when its network
  was larger: John's box at 10.100.1.160/23 never looked at 10.100.0.x, where his Home Assistant and Proxmox hosts are, so
  a new box there would have found little. Now each interface's network is scanned at its own prefix when it is a /22 or
  narrower, else the /22 around the address (1 024 addresses, the widest CS-D25 allows). The other sources (connections'
  /24s, the home network list, asked networks) are unchanged. Amends CS-14 and CS-D24.
- **DF-14 Fast enough for a first look.** A /22 with the catalog's ~30 ports must finish in about a minute on the box,
  so the screen fills while the owner is still at the computer; the server tunes concurrency and timeouts to that
  (DF-S*), keeping one TCP connect per port and the unauthenticated probes (nothing new on the wire).

## Synology and QNAP (NS-01…NS-08)

- **NS-01 Two new connections**, findable: **Synology DSM** (`synology`, DSM 7 or later, ports 5001 https and 5000
  http) and **QNAP** (`qnap`, QTS 5 and QuTS hero, ports 443 https and 8080 http). Category and scopes as TrueNAS and
  Unraid. Their probes read only what a browser gets before signing in (Synology's `SYNO.API.Info` answer, QNAP's
  `authLogin.cgi` XML) and take the version where it is shown.
- **NS-02 Signed in as a user of their own, with a session.** Neither has API keys for its system API, so — like Nginx
  Proxy Manager (CM-08) — Whombat keeps an account name and password and signs in for a session (`token` sign-in,
  `session` auth). The steps tell the person to make a user for Whombat (“whombat”) with two-step sign-in off for it,
  in the administrators group: DSM and QTS hide storage and health from a plain user, so a plain user works but sees
  little. Look only stays Whombat's own limit (CS-10), whatever the account may do. (Changed while building, CT-708.)
- **NS-03 The session sign-in grows what these need** (contracts CT-7xx, server DF-S*): a login sent as a form or as a
  query (`GET`), a template that base64-encodes a value (QNAP's `pwd`), a token read from XML (QNAP's `authSid`), and
  answers that mean “the session ended” even with status 200 (Synology `error.code` 106, 107, 119; QNAP `authPassed` 0)
  so the server signs in again once, as on a 401. Existing entries keep their JSON login unchanged.
- **NS-04 Plain reasons for a refused sign-in.** The entry maps the service's codes to the person's words: wrong name
  or password, account disabled, two-step sign-in on for this user (“Turn off two-step sign-in for the user Whombat
  signs in as”), too many tries (the service blocked this address), password expired.
- **NS-05 Look only and Manage by method.** Synology calls are `…/webapi/entry.cgi?api=…&method=…`; a call reads when
  `method` is a reading one (`get`, `list`, `info`, `query`, `status`, `load_info`, …) — `queryReads` (CM-18). QNAP's
  CGI calls are decided the same way on their function parameters. Anything else is a write.
- **NS-06 Asks first.** Shutting down or restarting the NAS, deleting shares/volumes/snapshots/users, changing users,
  passwords and permissions, formatting or removing disks always ask a person (`sensitive`).
- **NS-07 What agents are told** (`guide`): the main calls for health (system, storage pools and disks, temperatures,
  utilisation), shares, packages and containers, backups/snapshots and updates, with how sessions and errors look.
- **NS-08 Not verified on real hardware.** Neither is on John's network; the sign-in, the probes and the guide are built
  from the vendors' documentation and checked against fakes. John's or a customer's first real connect is the test.

## Decided while building (contracts, 0.110.0 CT-700…CT-711)

- **NS-C01 Synology's sign-in** is `SYNO.API.Auth` version 6 as a form POST to `/webapi/entry.cgi` (the password never
  in a URL), `session=webui`, `format=sid`; the token is `data.sid`, sent as `_sid`. Session ended: `error.code` 106,
  107, 119 and 150 (a request from another address than the sign-in's). Refusals: 400 refused, 401 disabled, 402
  denied, 403/404/406 two-step, 407/411 locked, 408/409/410 expired.
- **NS-C02 QNAP's sign-in** is a form POST to `/cgi-bin/authLogin.cgi` with `user`, `pwd={secret:base64}`,
  `serviceKey=1`; the token is the `authSid` XML element, sent as `sid`. Session ended: `authPassed` 0, or JSON
  `status` 3 under `/cgi-bin/filemanager/`. QNAP answers a wrong password, a disabled and a blocked account alike
  (`authPassed` 0), so its refusal names all three; `need_2sv` → two-step, `PermissionDeny` → denied. Its check is
  `check_sid` and needs `{"status": 1}` (`CatalogCheck.okAnswer`, `checkAnswerOk`). Requests only under nine
  `/cgi-bin/` paths, not the sign-in or sign-out ones.
- **NS-C03 Reads by query only.** Both entries take GET only; a call reads when Synology's `method`, or QNAP's `func`,
  `subfunc`, `chart_func` or `apply`, holds a reading value; a call without them is a change.
- **NS-C04 Sources**: Synology DSM Login Web API Guide (2023-04-19) and File Station API Guide; QNAP API for QTS
  Authentication v4.2 and File Station HTTP API v5; QTS 5.1 user guide; where the vendors are silent,
  py-synologydsm-api, N4S4 synology-api, qnapstats and OpenStack Manila's QNAP driver. Unverified without hardware:
  `_sid` without a SynoToken under DSM's CSRF protection, the form POST login (only GET is documented), QNAP's https
  port 443 and QTS 5's discovery firmware element, QNAP's sign-out, and the endpoints behind the ask-first rules.

## Decided while building (server)

Stream S (`found-server`), against contracts 0.110.0. Code: `connections/discover.ts` (the reach, `scanBurrow`,
`burrowFound`, `newFoundTest`), `connections/found-scans.ts` (the automatic scans, the message, the state),
`connections/found-view.ts` (order, names, addresses, the message's words), `desk/found.ts` (`glance.found`),
`connections/session.ts` and `http.ts` (the session sign-in).

- **DF-S01 256 connects at once, 400 ms each, an address at a time.** A /22 with every discovery port (23 since NS-01)
  is ~23 500 connects, most to addresses where nothing answers. Measured on The Titan against a listener that never
  accepts (every connect waits its full 400 ms, a network where nothing answers): 23 506 connects in 36.9 s at 256
  (128 would take about 74 s). The probes on open ports add seconds. The timeout stays 400 ms (Wi-Fi devices in power save
  answer late) and the pairs stay address after address (~11 addresses at once), so the network sees a few neighbours
  asked for at a time, not hundreds. *Why:* DF-14's minute with room to spare; nothing new on the wire.
- **DF-S02 Only an appliance scans by itself.** The automatic scans start only on a managed runtime. A self-hosted
  server (app.whombat.com in a data centre, `pnpm dev`, the tests' servers) scans when someone opens Connections, as
  before. *Why:* DF-02 is about a new box on a home network; a server elsewhere scanning its networks unasked is
  unwelcome, and development starts many servers.
- **DF-S03 The order.** Home Assistant, Proxmox VE, Unraid, TrueNAS, Synology DSM and QNAP first, then the catalog's
  order, a device (Modbus) last; then by address and port. *Why:* the catalog's order alone puts Plex, Immich and
  Paperless before Proxmox VE; DF-03's reason is that Home Assistant and the hypervisors come first.
- **DF-S04 A device's name** is the model it reported over Modbus (“Daikin EKRHH”, ONE-DD14's identification), else
  “Modbus device”; its line is the catalog's `device` tagline. *Why:* “Device” says nothing on a card; the model does.
- **DF-S05 The address shown** is the host alone; the port is added only when it isn't one the entry is found on (its
  discovery targets, a device's 502) or the same entry is at that host on another port too (Nextcloud on 443 and
  11000). *Why:* the mockups show Plex at “10.100.0.20”, not “:32400”; every scan find is on one of its entry's ports,
  so the port says nothing unless it tells two apart.
- **DF-S06 The message.** Posted by the person's assistant in their chat with it, where the welcome and DK-19 are,
  notifying them. One thing: “I looked around your network and found Home Assistant, which I can look after. Connect it
  under Connections if you want.” Up to three different names: all of them, a repeat as “two Proxmox VE”; more: “like”
  and the first three. Connections links `{webOrigin}/settings?tab=connections&found=1` (managed: the hosted UI at this
  appliance; self-hosted: `PUBLIC_URL`), burrow-less (AP-360…AP-363). The person is the screen's paired person when it
  is paired in that burrow, else the burrow's first owner with an assistant (`selfPairOrder`), decided when the scan is
  done. `told_at` is claimed in the post's transaction (once, however many scans finish); nothing after Not now.
- **DF-S07 When.** The check runs every minute on the housekeeping tick (its first at the next tick after a start:
  DF-02's “every runtime start”) and at once when the screen pairs itself. A burrow is due when an owner has an
  assistant there, it isn't put away, no automatic scan of it runs, and this runtime started none in the last 24 hours.
  The scan is planned as DF-03's person (their connections' networks count), takes over a running or 10-minute-fresh
  one (CS-14) and marks it automatic. Not while a backup is restored. Several burrows each get theirs.
- **DF-S08 The state is the burrow's, unsigned.** Migration `0127_connection_found_state`: one row per burrow,
  `first_scan_at`, `told_at`, `put_away_at`, written in the burrow's transaction without an event, like a read marker.
  *Why:* Not now comes from a screen that may be locked and isn't anyone (as the desk's PIN counters, DK-S05), and none
  of the three is a decision about someone else.
- **DF-S09 What the screen shows when.** What is new for the paired person is read with the glance (at most every
  10 s: their connections and the hidden list); the scans' finds and progress are read from memory at every state, so
  cards and “Looked at … addresses” move each second. While the burrow's first automatic scan runs (`first_scan_at`
  null): its progress and finds so far. After: the last finished result until the next is in. After a restart, with no
  result in memory yet, the running scan's finds so far without progress (`finishedAt` null), so the panel comes back
  with the first find instead of vanishing for a scan's length. `scanning` is any scan running.
- **DF-S10 Not now** (`DeskService.foundDismiss`) runs in the desk's queue, locked or not; nobody paired is 409
  `not_paired`. The glance drops `found` at once; a scan due before it doesn't start (checked again before scanning).
- **NS-S01 One sign-in path for every session.** `signInSession` builds the request with core's `sessionLoginRequest`
  (a JSON or form body, or a query; `{id:base64}`), reads the answer's text once, checks the entry's `failures` first
  (Synology and QNAP refuse with 200), then the statuses as before (400/401/403 refused or two-step, 429 locked, 404
  missing), then the token (`tokenJsonPath` or `tokenXmlTag`); signing out uses `sessionLogoutRequest` (Synology's is a
  `GET` with the session in the query). Pi-hole and Nginx Proxy Manager send exactly what they sent.
- **NS-S02 An answer that says the session ended** (2xx and a `stale` rule of the session, on the request's path) is
  tried once more with a fresh sign-in, as a 401 or 403 is (`renewedOn`). Only sessions with `stale` rules read the body.
- **NS-S03 Which refusals need the person.** Refused, account off, not allowed there, two-step on, password expired: the
  connection needs its password again (`token_invalid`) with the reason's words (CM-08's two-step sentence, the entry's
  or core's words for the others, “Needs a new password.” for a wrong one). Too many tries or a blocked address doesn't:
  the password may be right; that call fails and the next one tries again. The connect form shows every reason in its
  words, the entry's own first. A missing field names the field the sign-in's templates use (the account name).
- **NS-S04 A check's `okAnswer`** (CT-709) is read on the check's answer text after `okJsonPath`; an answer without
  one of its values fails the check as refused, like a 401 (QNAP's `check_sid` answers 200 with `{"status": 3}` for a
  session that doesn't work).
- **NS-S05 Synology and QNAP are found by the finder as it is.** Their probes are ordinary discovery probes (a path,
  a status, a body pattern, QNAP's firmware as the version); a scan adds DSM's ports 5000 and 5001 (QNAP's 443 and 8080
  were scanned already). Tested with their recorded answers (`discover-more.test.ts`), through `connections.identify`
  against stubs, and end to end (connect, read, an ended session in a 200, a refused account) against fakes built from
  NS-C01/NS-C02 (`more.int.test.ts`); no real device (NS-08).
