# Opening a Whombat: a bad network path, fewer round trips, the box's own addresses (AP-4400…AP-4409, AP-9190…AP-9193, AP-9713)

John, 2026-10-21: “why does dev.whombat.com feel slow when loading an appliance”, then “fully test it”, then “yes, do it”
(step 1 of three). 159 timed opens of the DEV box through Cloudflare from The Titan: first content after 1.0 s typically,
but 4 took 15–60 s or never showed, and photos took over 3 s in 15. Every slow one was a TCP connection that Cloudflare
and this network carried on a bad path: about half its full-size packets lost for as long as it lived (the same segment
resent up to 7 times, retransmission timeouts doubling to seconds), while the next connection, from another port, was
fine. About 1 in 40 to 1 in 150 new connections draws one (the box's and this machine's, IPv4 and IPv6 alike); an open
makes about four (the browser's interactive and bulk relay sockets, the box's data connection for each). The box, its
database and the relay answered in milliseconds throughout. So the client stops waiting on such a connection and takes a
new one. No contract change: `ping`/`pong` and every resend rule already exist. The runtime's half (its relay
connections) is Whombat `docs/decisions/open-speed.md` OS-01…OS-09.

| ID | Decision | Why |
|---|---|---|
| AP-4400 | **A connection attempt races a second one after 3 s** (`raceAfterMs`, `openRaced` in `session/secure.ts`): when the interactive or bulk connection hasn't opened 3 s after the attempt began, a second attempt starts beside it (its own ticket, relay socket, and so its own data connection on the box); the first to open is used, the other is aborted, or closed if it opens too. A failure ends the race only once every attempt started has failed, and a terminal reason ends it at once, so a refusal (the appliance offline, a refused ticket) still goes through the session's usual backoff and is never raced. | A healthy open takes 0.6–1 s here and 1.5–2.5 s on a slow phone network; a stuck one waited for the 15 s dial timeout. Racing keeps a slow but working attempt, which a shorter timeout would throw away, and costs a second ticket and dial only in the rare bad case. |
| AP-4401 | **A connection with work outstanding that goes quiet is replaced** (`stallMs`, `stallCheck`): while a request sent on it waits (`sent` or `checking`) or a download or upload runs on it, and nothing has arrived for 2.5 s, the client sends `ping`; nothing back 2.5 s after that and the connection ends as `lost`. The session's reconnect does the rest: reads are asked again on the new connection, mutations are checked with `status` first (MA-09), streams fail as `lost`. A slow answer is never taken for a stuck path: the `pong` comes back meanwhile. Idle connections are left to the heartbeat (20 s); canvases and consoles never count as waiting (`collab`, `quiet`). Each stuck connection in a spell (no more than two minutes apart) doubles the wait, up to 20 s, back to 2.5 s after two quiet minutes. | A bad path doesn't close the connection: the start-up data sat 22 s once and over 60 s another time while the box had long answered. Five seconds of silence with an unanswered ping is far outside a healthy round trip (60 ms here, a few hundred on mobile). The doubling stops a genuinely slow network from being reconnected over and over. |
| AP-4402 | **A given-up attempt stops, and the secure handshake has a limit** (`connector.ts`): an attempt aborted while its ticket came opens no relay socket; one aborted or stuck during the Noise handshake closes its socket at once; the handshake must finish within 15 s (`handshakeTimeoutMs`), and `open` drops a connection that finished after its attempt was given up. | Before, the handshake had no limit (it ended when the relay closed the socket, minutes later), and the loser of a race would have kept a socket and one of the box's eight handshake slots. |
| AP-4403 | **A download whose connection dropped is fetched once more** (`createObjectUrlCache`, web): a `StreamError('lost')` loads it again on the new connection; any other failure, a second loss or an aborted load is final. | A photo whose bulk connection got stuck never appeared (5 of 159 opens): nothing asked for it again. |

## Fewer round trips before the screen (AP-4404…AP-4408)

John, 2026-10-21, after step 1: “yes” to step 3's quick part (and step 2's cheap part, folded in). A healthy open, from
the recorded opens (`a1-59`, 75 ms round trips to the box): the page and its code 0.2 s, control's session and ticket
0.1 s, the relay socket and the box's own data connection for it 0.33 s, Noise and `hello` 0.1 s; then the account
(`me.get`), the bootstrap (51 kB on a new connection, 0.22 s), Chat's code, the sidebar's reads, Chat's rooms, the room's
conversation and its messages, each waiting for the one before: the reply rows at 1.34 s. The photos' connection was
dialed only once the first face was drawn and opened 0.75 s later (photos at 1.97 s). Each of those waits is a round trip
through Cloudflare, so on an evening's far colo (350 ms) they cost seconds.

| ID | Decision | Why |
|---|---|---|
| AP-4404 | **A burrow's first reads go out together** (`app/shell/firstReads.ts`, `warmBurrow`): the router's burrow step asks the remembered burrow's bootstrap before the account; once the session has said what its runtime is, the assistant sidebar's reads (`automations.list`, `home.overview`, `hosts.status`) and Chat's rooms (`chats.list`); once the rooms are in, the open room's conversation and newest messages, with its `conv:` topic asked first and held for 30 s, so nothing posted meanwhile is missed. The same queries the screens ask, so they find the answers or join the request on its way. Once per burrow and app. The router now also remembers the burrow it opened (`burrowMemory`), not only a switch, so the next open knows which one to ask. | Five dependent round trips after the session opened became one or two. A read whose screen changed its input only costs one request that nobody reads. |
| AP-4405 | **Chat's code loads beside the session** (`router.tsx`): `/`, `/chat` and `/feedback` start `ChatRoomScreen`'s chunk with the router's first step. | `/` redirects to `/chat` only after the bootstrap, and the chunk waited for that redirect: 0.1–0.3 s after each release, when the browser hasn't cached it yet. |
| AP-4406 | **The web warms the bulk connection beside the interactive one** (`warmBulk`, `session/secure.ts`; called by `ApplianceApp`): it's dialed when the session starts instead of when the first photo is asked for. A download that joins a warm dial that fails waits for the interactive connection and dials again, as before; the dial is given up when the session closes or lets go (also for an ordinary bulk dial, which before could open after the session had closed). The phone doesn't warm it: its photos are in its file cache (`cachedResourceFile`, PA-04) and draw without the connection. | Photos waited for a whole second handshake that started after the screen was drawn. An open whose screen has no photos now costs one idle connection; nearly every screen has faces. |
| AP-4407 | **The shell's skeleton has no minimum time** (`pendingMinMs: 0` on the burrow route). | The router's default kept the skeleton for at least half a second once it showed (after 1 s): exactly on the slow opens, a loaded burrow waited up to 0.5 s more. The skeleton is the shell's own geometry, so the swap doesn't jump. |
| AP-4408 | **Checks.** `firstReads.test.ts` (the reads it asks against the fixture world, once per burrow, no room for a page that isn't one, nothing of the assistant's in the crew shell) and three in `stall.test.ts` (the warm dial used by the first download; one that fails doesn't fail the download; given up on close). Measured on DEV with the same 60-open series as AP-4400…AP-4403. | |

Measured on DEV right after (0.119.3, 30 opens each, same evening): reply rows typically 0.90 s instead of 1.26 s, photos
0.97 s instead of 1.60 s, first content 0.86 s instead of 1.04 s. Two of the 30 hit the bad path: one dial (raced at 3 s,
open at 4.1 s), and one connection whose ping got no answer but an older answer trickled in 2 s later, which put off the
stall check until 10.5 s (AP-4409).

| ID | Decision | Why |
|---|---|---|
| AP-4409 | **On the interactive connection only the `pong` answers the stall check's `ping`** (`stallCheck`, `probeN`/`pongN`): an answer arriving after the ping no longer counts, because on a bad path the bytes sent before the ping still trickle in while the newest stay stuck behind lost ones. The bulk connection keeps “anything heard”: a download's bytes may hold its pong up. Test: `stall.test.ts` with the fake's `mutePongs`. | The recorded open sat with the bootstrap stuck from 1.1 s; the ping went out at 3.6 s, one older answer came at 5.6 s and reset the check, so the connection was given up at 10.6 s instead of 6.1 s. The interactive connection carries small answers, so a pong more than 2.5 s late is a stuck path, not a busy one. |

John, 2026-11-19: “Notification do not seem to work on iOS”. Home asked control for every push it meant to send and
Apple took them, but about a third of the replies never became one: a reply less than a minute after one of the person's
sessions opened is held, as they're at a screen (Whombat NT-17). Two Chrome tabs on his desk opened a new session every
4–5 minutes, always at the same second of the minute: hidden tabs, whose timers Chrome runs once a minute. The heartbeat
then always found the last answer a minute old, past its 50 s, and dropped a connection that worked.

| ID | Decision | Why |
|---|---|---|
| AP-9713 | **The heartbeat counts a missed answer from the ping that went unanswered** (`beatAt`, `createSecureSession`): a ping every `heartbeatMs`; once something was heard after the last one, the next starts a new count; nothing heard 1.5 intervals after that ping and the connection is lost. Before, it counted from the last thing heard (2.5 intervals). A connection that stops answering is still dropped at the same tick as before (the second after its last answer); one whose timer runs late keeps going. Test: `stall.test.ts` (time five times faster than the timers keeps the connection; a stalled one is replaced). | A hidden tab's timer runs about once a minute, so its last answer is always a minute old although the connection is fine. Every reconnect is a session that opened, which holds the person's phone notifications back for a minute. A missed ping says the connection is gone; a late timer says nothing about it. |

Not done: control's preflight lifetime (600 s, control), the ticket asked beside
control's session, and a spare data connection on the box (the box's own dial to the relay is 0.26 s of every open):
each a smaller change elsewhere, decided when measured.

## The box's own addresses don't hold up the relay (AP-9190…AP-9193)

John, 2026-10-27: “When launching the iOS app for the first time … it takes a very long time before we see the data
appear … please troubleshoot this.” Control's log showed each start of his iPhone app (its `GET /v1/auth/session`)
followed by its first relay ticket 12–15 s later (07:02:49 → 07:03:02, 07:06:54 → 07:07:09, 07:11:34 → 07:11:49); its
very first launch after he let it in was quick only because it didn't know the box's addresses yet (it read the chat 2 s
after being let in). Home names six ways in: two IPv4 addresses and four public IPv6 ones. The image's firewall lets only
private addresses reach the direct port, so the IPv6 ones never answer, even from the same network (from The Titan: no
answer in 4 s; IPv4 in under 1 ms). The client dialed the ways one after another, each with 3 s to answer, and asked
for the relay only after the last; the session's second attempt at 3 s did the same. A phone away from home waits for
the IPv4 ones too. The runtime's half is Whombat `docs/decisions/open-speed.md` OS-04.

| ID | Decision | Why |
|---|---|---|
| AP-9190 | **The box's addresses are dialed a quarter second apart** (`staggerMs` 250 ms, `createDirectConnector`): the next one starts when the one before hasn't answered by then, or at once when it failed; the first the box welcomes on gets the Noise handshake and the others are given up. A handshake that fails there (another box at an old address) drops that address and dials the rest again. The one that worked last is still dialed first. | On the box's network the remembered address answers in milliseconds, so no other socket opens and the box counts no abandoned handshake against the phone. A silent address no longer holds up the next for its whole 3 s. |
| AP-9191 | **The relay starts beside the direct ways after 1 s** (`relayAfterMs`, `createRoutedConnector`), or at once when every way failed; the first to open is used and the other given up. When the relay opened first, the direct ways are left alone for a minute as after a failure, so the next connections go straight to the relay. The relay's answer stands when both fail. | Directly, the box opens in a few hundred milliseconds; a phone that can't reach it now waits about a second before the relay, instead of 3 s for every address (12–18 s on Home). A slow but working direct dial still wins when it opens first. |
| AP-9192 | **The iPhone app says why it reaches the local network** (`NSLocalNetworkUsageDescription`: “Whombat connects straight to your Whombat when you’re on the same network, which is quicker than going over the internet.”) **and allows plain local loads** (`NSAllowsLocalNetworking`). | iOS asks before an app reaches anything on the local network; without the text the question doesn't say what it's for, and turned down, the direct ways never answer. |
| AP-9193 | **Checks**: `direct.test.ts` (the next address dialed before a silent one gives up, that one given up and nothing else dialed once one answered; the relay started beside unopened direct ways and the direct attempt given up when it opens first; no relay when the box opens within the head start; the box preferred when it opens after the relay started; the relay at once when direct failed; the relay's answer when both fail). | |
