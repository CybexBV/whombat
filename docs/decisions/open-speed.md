# Opening a Whombat survives a bad network path (OS-01…OS-09)

John, 2026-10-21: “why does dev.whombat.com feel slow when loading an appliance”, then “fully test it”, then “yes, do it”.
A test browser on his account timed 159 opens of the DEV box through Cloudflare: typically 1.0 s to first content, but
4 took 15–60 s or never showed, and photos took over 3 s in 15. Packet captures at the browser, the relay and the box
showed why: a few in a hundred TCP connections between this network and Cloudflare land on a path that loses about half
their full-size packets for as long as they live (one segment resent 7 times, timeouts doubling to seconds), while a new
connection from another port is fine; from the box and from The Titan, IPv4 and IPv6. The runtime, its database and the
relay answered in milliseconds throughout. The cure is to stop waiting on such a connection: the clients' half is
whombat-app `docs/decisions/open-speed.md` AP-4400…AP-4403 (a stalled session connection is replaced, a stuck dial is
raced); this is the appliance's half, in `managed/session/relay-client.ts`. No contract or relay change.

| ID | Decision | Why |
|---|---|---|
| OS-01 | **The control connection checks itself**: after `welcome` the appliance pings it every 5 s (`livenessMs`); a ping unanswered for 3 s (`pongWaitMs`) means a bad path, so the connection is terminated and the usual close handling reconnects it on a fresh one (backoff from 0 when it had been up 30 s, growing when it keeps happening). A check that runs late because the event loop was busy judges nothing, as the pong may be waiting behind it. Counted as `controlStalls`, logged once per replacement. | Every new session starts with the relay's `incoming` on this connection, so a control connection on a bad path delays every open, for as long as it lives (hours); the clients can't fix that by reconnecting, the box has to. Five-second pings are two tiny frames per 5 s through Cloudflare. |
| OS-02 | **A data connection is raced**: when the dial for an `incoming` session isn't `ready` after 2.5 s (`dataRaceAfterMs`), a second dial starts beside it, and one that fails before the session joined is dialed once more at once; at most two per session. The relay pairs the session with whichever says `hello` first and turns the other away (4404), and the one left over is closed. Counted as `dataRaces`. | The relay waits 10 s for the appliance to join; a dial stuck on a bad path held a session that long (1–2.5 s joins were common, 5–10 s happened). The second dial almost always takes another path. |
| OS-03 | **Relay WebSockets have an opening-handshake limit** of 10 s (`dialTimeoutMs`, `ws`'s `handshakeTimeout`), control and data alike. | Before, a dial stuck in TLS waited for the operating system to give up, minutes later. |

## The ways in name only private addresses (OS-04)

John, 2026-10-27: his iPhone app took 12–15 s on every start before its first relay ticket. Home named its four public
IPv6 addresses beside its two IPv4 ones as ways in, the image's firewall opens the direct port to private addresses
only, and the phone dialed every way, 3 s each, before the relay. The clients' half (the ways dialed a quarter second
apart, the relay beside them after 1 s) is `docs/app/decisions/open-speed.md` AP-9190…AP-9193.

| ID | Decision | Why |
|---|---|---|
| OS-04 | **`welcome.direct` names only the box's private addresses** (`routes.ts`, `isPrivateAddress`): RFC 1918 IPv4 and unique-local IPv6 (link-local was already left out); a public address on the box's network card is no way in. The listener's own check still takes a peer on the box's own IPv6 prefix. | The image's firewall lets only private addresses reach the port, so from the same network a public IPv6 address doesn't answer at all (from The Titan: nothing in 4 s, IPv4 in under 1 ms), and every one a client dials costs it its whole dial limit. A home network with IPv6 has IPv4 beside it. |

## Selecting a Whombat opens its data sooner (OS-05…OS-08)

John, 2026-10-28: the wait is after picking a Whombat, while its data loads. Cloud account checks and initial bundle
loading have already happened at that point. Admission still awaited an unbounded HTTP call before the relay dial's
timeout started, and the list waited until navigation to start the encrypted session.

| ID | Decision | Why |
|---|---|---|
| OS-05 | **The hosted list prepares one trusted session on pointer intent or keyboard focus.** Only an enrolled record whose pinned identity matches the directory qualifies. Open checks the pin again and takes that session, including an attempt still opening. A different target, changed identity, forgetting, sign-out, leaving for another setup journey, hiding the tab, or ten seconds unused closes it. The prepared session sends only the ordinary encrypted handshake; content reads start after selection. The app installs its cache scope from an already-open welcome before mounting its router. Chat's existing chunk loads beside preparation. | Moves connection work ahead of the click without a content cache, another identity source, or a speculative session for every appliance. The same scoped session and live-event rules apply after adoption. |
| OS-06 | **Every relay admission has a 15-second deadline and follows the attempt's cancellation.** The deadline covers the ticket's headers and body and any directory lookup needed to explain a refusal. Its signal reaches HTTP, and the connector settles even if a custom source ignores it. No socket opens after cancellation. Signed-out, membership and appliance refusals keep their existing meanings; ordinary timeouts use the existing race and reconnect handling. | The WebSocket timeout began only after HTTP completed, so two raced attempts could both wait forever. A losing attempt must release its HTTP work too. Shared by web and phone. |
| OS-07 | **Opening timings stay in the browser tab.** Keep at most ten local samples, with selection, welcome, bootstrap, rooms, message history and committed Chat/Feedback content. Native Performance marks use the `whombat.open.*` prefix; `window.__WHOMBAT_OPEN_TIMINGS__()` exports relative milliseconds, connection wait, post-connection data time and total. A prepared welcome can precede selection; its connection wait is zero. Incomplete opens retain null durations. Sign-out/account changes clear the samples. No content, identity, address, token, remote analytics or persistent store. | Separates connection setup from actual first-screen data before deciding whether a combined opening contract is justified. Content means committed room/history, including a valid empty room; it does not claim that pictures have decoded. |
| OS-08 | **Warm only the current shell's reads, plus the selected room's working/settling metadata.** The full automations list is read by its own screen. Chat/Feedback prefetches its exact open-thread query alongside conversation detail and the existing message-history query, after subscribing to the conversation. | The sidebar consumes Home, hosts and rooms; fetching all automations competed with the first screen. Thread metadata lets the room's controls become ready sooner and does not replace message history. |

The next data-protocol change is measurement-led: use the local phases from an enrolled browser to decide whether
room discovery or another read dominates. A combined encrypted opening response needs its own typed contract and an
explicit snapshot/subscription boundary; these changes leave the session protocol and its data boundaries intact.

Regression coverage: `packages/client/src/managed/admission.test.ts` and `session/connector.test.ts` cover silent
headers, bodies and refusal lookups, cancellation, late tickets, retry and existing terminal refusals.
`apps/web/src/managed/prepareOpening.test.ts`, `app/openTiming.test.ts` and `app/shell/firstReads.test.ts` cover one-use
adoption, identity/enrollment guards, expiry and cleanup, no speculative reads, bounded content-free timings and the
screen's exact queries. `e2e-managed/opening.hosted.spec.ts` exercises adoption in the production build, both themes,
and a message sent through the adopted session.

OS-09 is kept for this work.
