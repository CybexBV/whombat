# Workstream: move a Whombat to Wi-Fi (and back) without losing its servers (2026-11-03)

John, 2026-11-03: Home (the Z13) runs on a USB cable and should move to Wi-Fi only; server monitoring must not break,
and Whombat should do this as a feature because it happens in real life (a cable that fails, a new router, a move).
Research: a box whose address changes is already found by its servers (hosts HS-170…HS-176, backup-file.md
BF-16, BF-17). What was missing: Wi-Fi's address didn't answer while a cable was in (strict reverse-path filter), every
server raised “can't reach” for the minute or two the agents searched, there was no planned way to switch, and nothing
said what else might still name the old address.

Builds on hardware-support.md (HD-05 a cable wins, HD-06 guarded changes, HD-10 “online”, HD-11 words). Numbers taken:
contracts CT-1639…CT-1659, server NM-S01…, app AP-6630…AP-6649 (`docs/app/decisions/network-move-app.md`), appliance
NX-493…NX-499 and MG-142…MG-149, hosts HS-220…HS-227.

## Decided

- **NM-01 “Use Wi-Fi only” switches the cable off, it doesn't need unplugging.** Owners choose it in Settings → This
  Whombat → Overview → Network on the Wi-Fi row while a cable and Wi-Fi are both connected. The cable's interface stays
  up (so the box still sees whether a cable is plugged in) but takes no address: the box uses Wi-Fi alone. It lasts
  across restarts and updates until someone chooses **Use the cable again**. *Why:* a planned move can be tried and
  undone remotely, and a cable left plugged in can't silently take over again after a restart.
- **NM-02 Both directions are guarded like a Wi-Fi join (HD-06).** When the box reached Whombat before, the switch is
  undone if it can't reach Whombat within 2 minutes after it (the manager's guard with its dead-man revert, MG-15).
  One network change at a time, Wi-Fi or cable (`busy`). *Why:* a remote change must never cut the box off for good.
- **NM-03 The cable is the backup** (superseded in part by NM-13: the try is guarded). While Wi-Fi only is on, a box that hasn't reached Whombat for 5 minutes while a
  cable is plugged in turns the cable back on by itself (`by: backup`) and Wi-Fi only ends. Owners are told (NM-09).
  *Why:* Wi-Fi only is a preference, not a reason to stay offline when a working cable is right there.
- **NM-04 Each address answers on its own connection.** The box uses a loose reverse-path filter (RFC 3704 loose mode)
  so a packet that reaches its Wi-Fi address over Wi-Fi is accepted while the cable carries the default route. *Why:*
  strict mode dropped them (both cards on one subnet: the reverse route is the cable's), which is why Home's Wi-Fi
  address timed out with the cable in; servers can only move before the cable goes when both addresses answer.
- **NM-05 Servers move first, then the cable goes.** Choosing Use Wi-Fi only asks the hosts service to tell every
  connected agent to move to the box's Wi-Fi address (`hub_move`, HS-221/HS-222) before the cable is switched off; an
  agent dials the new address, checks the Whombat's certificate, saves it and drops the old connection. Agents too old
  for `hub_move` (or that can't reach it) find the box by themselves once the cable is off (HS-174). Use the cable again
  moves them to the cable's address after the cable is back. *Why:* no gap at all for current agents, and the existing
  search covers the rest.
- **NM-06 The hosts service knows when the problem is the box.** When its own addresses change, or most connected
  agents drop at once, it holds the “can't reach” (heartbeat) alerts of the servers that dropped for 5 minutes and says
  it is reconnecting (`GET /hub` `reconnecting`, HS-220). A planned move opens the same hold. *Why:* a Wi-Fi blip or a
  move is one event, not seven servers going down.
- **NM-07 Progress and the end, in the Network section.** While servers move: “4 of 6 servers found Home’s new
  address.”; when all have: “All your servers found Home’s new address. You can unplug the cable now.” Servers that
  don't come back are BF-16's Inbox item with Point them here, unchanged.
- **NM-08 Keeping the address is the router's job; Whombat says how.** After a move that changed the box's address,
  the Network section says once: “Home’s address changed from 10.100.1.81 to 10.100.1.97. To keep 10.100.1.81, have your
  router give it to the Wi-Fi card (A8:E2:91:16:47:58), then restart Home.” The manager reports each card's hardware
  address for this. *Why:* every router does it differently; the person (or Dusty, with a router connection) does it
  once, and then nothing outside Whombat needs to change.
- **NM-09 What owners are told in the Inbox (watch-defaults.md: both start on)** (superseded in part by NM-16: the
  cable item's way out is Settle). “Home is on Wi-Fi now: its cable
  stopped working.” when the cable lost its link or address while Wi-Fi only is off and Wi-Fi carries the box (a part
  broken now, and the person can act: plug it back or choose Use Wi-Fi only, which settles it); and “Wi-Fi stopped
  reaching Whombat, so Home uses its cable again.” after NM-03. *Why:* both are something broken now that only the
  person can fix.
- **NM-10 After an address change, Whombat checks its connections again.** Whenever the box's address changes (any
  cause: a move, DHCP, a restore), Whombat runs a health pass of its connections and tells owners once about each one
  that worked before and is refused now: “Home Assistant stopped letting Whombat in after its address changed. It may
  only allow 10.100.1.81.” *Why:* allow-lists and firewall rules outside Whombat name the old address, and only a
  before/after comparison can point at them.
- **NM-11 Another network than the servers' is said up front.** When the Wi-Fi's subnet isn't the cable's, the Use
  Wi-Fi only dialog says the servers can't follow by themselves and that Whombat will ask to point them here
  afterwards (BF-15/BF-16's repoint over SSH). *Why:* agents search only their own local network (HS-175).
- **NM-12 Words** (concise-replies.md): “Use Wi-Fi only”, “Use the cable again”, “Cable · Switched off”, “Home uses
  Wi-Fi only. You can unplug the cable.”, “Moving to Wi-Fi…”, “Checking that Home reaches the internet on Wi-Fi…”,
  “Home uses Wi-Fi only now.”, “Home couldn’t reach the internet on Wi-Fi, so it uses the cable again.” — with the
  Whombat's own name for “Home”.

## Decided after the first build (2026-11-04)

A review of the build against Home (John: “research and implement fixes”) found what follows; numbers continue above.

- **NM-13 The backup is tried, not just made.** After 5 minutes without Whombat on Wi-Fi only with a cable plugged in,
  the box turns the cable on under the same 2-minute guard as a person's change: kept when the cable reaches Whombat
  (then NM-09's “… uses its cable again.”), switched off again when it doesn't, and then Wi-Fi only stays and the next
  try waits half an hour (appliance MG-147). Use the cable again is confirmed only once the cable has its address
  (MG-148). *Why:* the check is a connection to Whombat's endpoint, so a router or internet outage of 5 minutes ended
  Wi-Fi only for good and blamed the Wi-Fi, and a cable on a network without internet could take the default route and
  cut the box off with nothing to undo it.
- **NM-14 “You can unplug the cable” only once Wi-Fi only is kept**, not while it is still being checked (the row's
  “… You can unplug the cable.” and the move's “You can unplug the cable now.”). *Why:* servers move within seconds,
  well before the 2-minute check ends; unplugging then and failing the check left the box with neither.
- **NM-15 The move shown follows the box.** A recorded move is shown as asked while its cable change runs; after it,
  `to` is the address the box uses now, and there is no move once the box is back at the address it had (Wi-Fi only
  undone, the cable used again, the router giving the Wi-Fi card the old address after NM-08). The hosts service naming
  the box's IPv6 address and then its IPv4 one (or back) isn't a move. Counted are the servers connected through the
  old or the new address and those last seen up to 10 minutes before the move; servers away longer and servers reaching
  the box another way (the tailnet, a forward) aren't. *Why:* the old record kept “0 of 5 servers found …” and Point
  them here for a day after following the router tip; on Home the hosts service's IPv6-then-IPv4 pick at a start showed
  a router tip for the cable's own IPv6 address; a switched-off server kept the line from ever finishing.
- **NM-16 The cable item's words**: “Plug the cable back in. If you unplugged it on purpose, you can settle this.”
  *Why:* Use Wi-Fi only is offered only while a cable is connected, so the item asked for a button that wasn't there.
- **NM-17 Connections are checked again after an address change only once no cable change runs**, and not when the
  box is already back at the address it had (NM-10). *Why:* a Wi-Fi only without internet looked like every connection
  refusing the new address, one item each.

## Not now

- The box's screen (desk) doesn't offer Use Wi-Fi only; it shows the cable as switched off.
- Whombat doesn't change router reservations itself; Dusty can, through a router connection, when asked.
- Static addresses over Wi-Fi (still HD “Not now”).
