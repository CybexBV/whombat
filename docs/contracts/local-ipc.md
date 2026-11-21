# Appliance-local IPC (runtime ↔ manager, backup)

The schemas are in `@whombat/control-contracts/local` and the Go package `local`
(`github.com/CybexBV/whombat/contracts/go/local`). The decision is CT-23. Both APIs are HTTP/1.1 over unix
sockets with JSON bodies. Times are RFC 3339 strings. Requests are strict and responses tolerant (CT-14). Free
text is printable ASCII: fold typographic quotes before sending. The exceptions are text people read: a burrow's
name and the screen sign-in's name and device in the console file (CT-116, CT-626), push previews (CT-286), the desk's and the voice service's display text
(0.100, CT-529), and the hardware report's and the network's names (0.102, CT-560), which may be any script on one line.

## Manager socket: the manager listens, the runtime calls

Path: `WHOMBAT_MANAGER_SOCKET`. The manager checks that the peer uid is the runtime's.

| Call | Body | Answer | Manager then |
|---|---|---|---|
| `POST /v1/runtime/ticket` | `RuntimeTicketRequest {class}` | `RuntimeTicketResponse {ticket, relayUrl, worker, expiresAt}` | device op `ticket.issue` |
| `POST /v1/runtime/claimed` | `RuntimeClaimedRequest {claimId, claimedAt}` | `LocalOk` | `claim.claimed {claimId, claimedAt: epoch s}` (0.5: exactly the claim the client presented) |
| `POST /v1/runtime/revocations` | `RuntimeRevocationRequest {peerId, revokedAt}` | `LocalOk` | `revocations.report [{ref: revocationRef(peerId), kind: endpoint, state: applied, requestedAt = appliedAt = revokedAt}]` |
| `POST /v1/runtime/push` | `RuntimePushRequest` (= `PushRequest`) | `RuntimePushResponse` (= `PushResult`) | `push.send` |

The manager's own endpoints on the same socket (0.5, MG-11/MG-15):

| Call | Caller | Body | Answer |
|---|---|---|---|
| `GET /v1/update/status` | runtime, lock holders | none | `UpdateStatusResponse {state, current, knownGood, candidate?, explanation?, failure?, hold, readOnly}` |
| `POST /v1/maintenance/lock` | lock holders (backup) | `MaintenanceLockRequest {holder, reason, ttlS}` | `MaintenanceLock {holder, reason, since, expires}`; 409 `busy` while an update activates |
| `POST /v1/maintenance/unlock` | lock holders | `MaintenanceUnlockRequest {holder}` | `LocalOk` |
| `POST /v1/network/candidates` | runtime | `NetworkCandidate` | 202 `NetworkSubmitResponse {candidateId, phase}`; 409 `busy` |
| `GET /v1/network/status` | runtime | none | `NetworkStatus {candidateId?, phase?, deadline?, result?, updatedAt}` |

AI clients (0.9, CT-73; the runtime calls them for an owner's `clients.install|remove`, and reads the status):

| Call | Body | Answer |
|---|---|---|
| `GET /v1/clients` | none | `LocalClientsStatus {v, clients: LocalClient[], channel: {sequence, checkedAt} \| null}` |
| `POST /v1/clients/install` | `ClientInstallRequest {v, provider}` | 202 `LocalClient` (`installing`, or the current one when already installing or installed); 409 `busy` while removing; 404 `unavailable` when no bundle fits |
| `POST /v1/clients/remove` | `ClientRemoveRequest {v, provider}` | `LocalClient` (`not_installed`); stops an install in progress |

The licence (0.10, LC-08, CT-77; the runtime calls it for an owner's or admin's `licence.refresh`):

| Call | Body | Answer |
|---|---|---|
| `POST /v1/licence/renew` | `LicenceRenewNowRequest {v}` | `LicenceRenewNowResult {v, renewed, error?}` after the attempt (`error`: `unreachable`, `device_unclaimed`, `device_revoked`, `devices_allowed_reached`, `rate_limited`, `bad_token`, …); 429 `busy` within 60 s of the last forced renewal |

The feedback drop (0.13, Whombat FD-21, CT-91; managed runtimes with Feedback intake): the manager signs the device op
and returns control's answer; it never parses a card or an envelope beyond the schema.

| Call | Body | Answer |
|---|---|---|
| `POST /v1/runtime/feedback/cards` | `RuntimeFeedbackCardsRequest` = `feedback.cards.sync` `{seq, cards: [{card, sig}] ≤ 200}` (up to `FEEDBACK_CARDS_SYNC_MAX_BYTES`, 4 MiB) | `{accepted: site[], refused: [{index, site, code, seq?}]}` |
| `POST /v1/runtime/feedback/pull` | `RuntimeFeedbackPullRequest` = `feedback.drops.pull` `{max 1…20, maxBytes 1…47 MiB}` | `{drops: FeedbackDrop[], pending, expired: [{site, count}], nextPullS}` (up to `FEEDBACK_PULL_RESPONSE_MAX_BYTES`, 64 MiB) |
| `POST /v1/runtime/feedback/ack` | `RuntimeFeedbackAckRequest` = `feedback.drops.ack` `{dropIds: 1…100}` | `{ok: true}` |

501 `unsupported` when control doesn't know the op (an older control answers 400 `bad_envelope`; 404
`feedback_drop_off` while the drop is switched off there). A runtime treats 404 from an older manager like 501.

How the box is doing (0.78, CT-334; the runtime calls it for an owner's `host.metrics`):

| Call | Body | Answer |
|---|---|---|
| `POST /v1/host/metrics` | `HostMetricsRequest {v, range, since?, timeZone}` | `HostMetricsResponse {v, metrics}`; 404 from an older manager |

0.100 (CT-522): `metrics.now.power` (`HostPower {source: ac \| battery, percent, charging, minutesLeft, chargeLimit,
since}`) on a machine with a battery, read from `/sys/class/power_supply`; `since` (on battery since) is kept across
samples. Absent without a battery and from older managers. The runtime reads it for the desk's `power` and its power
messages to owners (DK-10).

0.101 (CT-542): `metrics.now.cpuTempC`, the processor's temperature in whole °C (hwmon `k10temp`, `coretemp` or
`zenpower`, else a CPU thermal zone; absent without a sensor, as in VMs), and `metrics.now.uptimeS` (`/proc/uptime`).
Both optional, absent from older managers. The desk's *This Whombat* panel reads them (DK-22, DK-24).

The box's hardware and network (0.102, CT-573; Whombat hardware-support.md HD-03, HD-05, HD-06; the runtime calls them
for an owner's `host.hardware`, `host.network` and `host.wifi.*`, and for the desk's network):

| Call | Body | Answer |
|---|---|---|
| `POST /v1/host/hardware` | `HostHardwareRequest {v}` | `HostHardwareResponse {v, hardware}`; 404 from an older manager |
| `POST /v1/network/state` | `NetworkStateRequest {v}` | `NetworkStateResponse {v, network}` |
| `POST /v1/network/wifi/scan` | `WifiScanRequest {v}` | `WifiScanResponse {v, scan}` after at most 10 s for a fresh scan; 409 `no_wifi` |
| `POST /v1/network/wifi/join` | `WifiJoinRequest {v, ssid, passphrase?, hidden?, confirmTimeoutSec 30…600}` | 202 `WifiChangeResponse {v, change}`; 409 `no_wifi`, `busy`; 400 `invalid_passphrase`, `bad_request` |
| `POST /v1/network/wifi/forget` | `WifiForgetRequest {v, ssid}` | 202 `WifiChangeResponse {v, change}`; 409 `busy`, `in_use`; 404 `not_saved` |

- `hardware` (`HostHardware`, `@whombat/protocol/session`, Go `protocol.HostHardware`): `collectedAt`, `kernel`,
  `machine {vendor?, model?, family?, firmware?, virtual, hypervisor?}` (DMI, never a serial), `cpu {model, cores,
  threads}`, `memoryBytes`, `devices` (≤ 256 `HardwareDevice {kind, name, vendor?, bus, id?, driver | null, status,
  interface?, link?, speedMbps?, capture?, playback?, card?, connected?, sizeBytes?}`) and `log` (≤ 40 kernel lines about
  firmware and drivers, filtered by a read-only helper op). Collected when asked, from what the machine reports (HD-01).
  No serial numbers, no MAC addresses.
- `network` (`HostNetwork`): `online` (the guard's last check of control's endpoint, at most 60 s old; `checkedAt`),
  `wired` (≤ 8 `{interface, connected, address?}`), `wifi` (`{interface, state: disconnected | connecting | connected,
  ssid?, signal?, address?, saved}`) or null with `wifiMissing` (`no_adapter`, `no_driver`, `disabled`), and `change`
  (the latest guarded change, or null). `HostNetworkValid` (Go) checks what the schema can't.
- `scan` (`WifiScan`): ≤ 64 `{ssid, security: open | psk | enterprise | other, signal 0…4, saved, connected}`, strongest
  first. `WifiSignalFromDBm` (Go) gives the bars; networks whose name fails `SsidValid` are left out.
- A join is guarded (HD-06, MG-15's pattern): when the box reached Whombat before and can't within `confirmTimeoutSec`
  after joining, the new network is forgotten and the previous one comes back. `change {id, kind: join | forget, ssid,
  phase: applying | confirming | committed | reverting | reverted | failed, deadline, previous?, failure?}`; `failure`
  (`wrong_password`, `not_found`, `no_address`, `no_internet`, `failed`) exactly in `reverting`, `reverted` and `failed`
  (`NetworkChangeValid`). A wrong password fails at once and keeps nothing. One change at a time (`busy`, also while the
  maintenance lock is held). Without `passphrase`: an open network or one the box saved; `invalid_passphrase` for a
  secured network it doesn't know. `ssid` must pass `SsidValid` (32 UTF-8 bytes), else 400 `bad_request`.
- The passphrase is a secret: never logged, never in an answer, an error or the journal.
- Error codes are `WIFI_ERROR_CODES` (Go `WifiError*`). The wired `networkCandidates`/`networkStatus` above stay as they
  are, for cables only: a `wl*` interface is refused by `NetworkCandidate`.
- Display strings (names, vendors, models, interface names, SSIDs, kernel lines) are any script on one line
  (`HOST_TEXT_RES`, CT-560): the manager cleans every one with `local.HostText`.

Remote help's ticket (0.120, CT-940; Whombat remote-help.md RH-06): the support service (root, peer uid 0) asks for
the appliance ticket it dials the relay with, only while a grant is active.

| Call | Caller | Body | Answer |
|---|---|---|---|
| `POST /v1/support/ticket` | root (`whombat-support`) | `{}` | the device op `support.ticket`'s `TicketResponse {ticket, expiresAt, relay, channel}` (Go `device.SupportTicketResponse`) |

The manager may answer from its cache until 60 s before `expiresAt`. Control's refusals pass through as `LocalError`
with their code (`device_unclaimed`, `device_revoked`, `rate_limited`). The manager also reads the support socket's
`GET /v1/state` for `status.report.support` (below) and leaves the member out when the socket doesn't answer.

Whombat Link and the update channel (4.4, CT-1763; Whombat whombat-link.md). The manager keeps the box's Link state
from every `ticket.issue` answer (`TicketResponse.link`) and from `link.begin`, `link.status` and `link.leave`; the
runtime reads it at start, every `LINK_STATE_POLL_S` (300 s) and after its own changes. An older manager answers 404.

| Call | Caller | Body | Answer |
|---|---|---|---|
| `POST /v1/link/state` | runtime | `LinkStateRequest {v}` | `LinkStateResponse {v, enabled, link: LocalLinkStatus}` |
| `POST /v1/link/on` | runtime (the owner's) | `LinkOnRequest {v, contentProof, name?}` | `LinkStateResponse` after `link.begin` |
| `POST /v1/link/off` | runtime (the owner's) | `LinkOffRequest {v}` | `LinkStateResponse` (`off`) after `link.leave` |
| `POST /v1/update/channel` | runtime | `UpdateChannelRequest {v}` | `UpdateChannelResponse {v, channel, staysOn?}` |
| `POST /v1/update/channel/set` | runtime (the owner's) | `UpdateChannelSetRequest {v, channel}` | `UpdateChannelResponse` |
| `POST /v1/runtime/push/register` | runtime | the device op `push.register`'s body | its answer `{handle}` |
| `POST /v1/runtime/push/unregister` | runtime | the device op `push.unregister`'s body | its answer `{ok}` |

- `contentProof` is the content key's signature over `registrationSigningBytes` of `device.json`'s members (the
  manager holds no content key); the manager adds its own `proof` and sends `link.begin {registration, name?}`.
- `LocalLinkStatus {state, since, pending?: {code, url, expiresAt}, waitingForAddress?, graceEndsAt?, trialEndsAt?,
  label?, email?, checkedAt?}`, times RFC 3339. `enabled: false` (and `off`): no Link in this image.
- Errors `LINK_ERRORS`: 404 `link.unavailable`, 409 `link.busy`, 409 `link.device_exists`, 429 `link.rate_limited`,
  404 `update.channel_unavailable`; 503 `control_unreachable`, 502 `control_refused` (control's code in the message,
  e.g. `link_off` for a push token while Link is off).
- The console file's `reach` (`ConsoleReach {link?, tailscale?}`, any state) carries what the screen shows for Link
  (state, code and page, “waiting for an address”, grace end) and Tailscale (sign-in link, “turn on HTTPS”, name).

Errors use `LocalError {error: {code, message}}`. If control is unreachable the manager answers
`503 {code: 'unavailable'}`. The runtime keeps claims and revocations pending and retries them.

## Admin socket: the runtime listens, the manager and the backup service call

Path: `WHOMBAT_ADMIN_SOCKET` (`/run/whombat/admin.sock`). The runtime checks that the peer uid is the manager's or
the backup service's.

| Call | Body | Answer |
|---|---|---|
| `GET /health` | none | `RuntimeHealth`, with HTTP 200, or 503 when not ok (the body is still `RuntimeHealth`) |
| `POST /drain` | `DrainRequest {v, requestId, reason, scope, releaseId?, leaseMs}` | `DrainStatus {v, requestId, draining, safe, blockers[], estimatedMs}`; `409 LocalError{busy}` while another caller's drain holds the runtime |
| `POST /resume` | `ResumeRequest {v, requestId}` | `ResumeResponse {v, requestId, draining}` |
| `POST /claim-window` | `ClaimWindowRequest {v, required, openUntil}` | `AdminOk` |
| `POST /claim-lookup` | `ClaimLookupLeaseRequest {v, lookup, expiresAt}` or `{v, lookup: null}` (0.7, CC-03) | `AdminOk` |
| `POST /facts` | `FactsRequest {v, backup: BackupServiceStatus \| null, update: UpdateFacts \| null}` (0.5.3: `update.clientFloor`, the running tuple's client floor, CT-53; 0.22: `update.failureDetail`, `update.waiting {reason, since, blockers}`, `update.lastUpdate {release, from, at}`, CT-137, CT-138) | `AdminOk` |
| `GET /facts` | none | `RuntimeFacts {v, activeSessions, claimed, claimReported, recovery, revocations, draining, quarantined, relay, clientAdapters}` (0.9: `clientAdapters`, the runtime's adapter levels, CT-73; since 3.0 `{claude}` only, CT-1564) |
| `POST /clients` | `ClientsPushRequest {v, clients, channel}` (0.9, CT-73) | `AdminOk` |
| `POST /licence` | `LicencePushRequest {v, token: string \| null, highWater}` (0.10, LC-06, CT-77) | `LicencePushResponse {v, licence: LocalLicenceStatus \| null}`; 409 `stale` for an older `iat`, 400 `bad_request` for a token that doesn't verify |

- **Claim lookup (0.7, CC-03):** an unclaimed device's manager leases a lookup number (internal since CT-67: it marks the box as waiting to be claimed and is never shown) with the device
  op `claim.lookup {}` → `{lookup, expiresAt, renewAfterS}` and renews it every `renewAfterS` (300 s). It pushes
  `{v, lookup, expiresAt}` to the runtime whenever the number or expiry changes, and at runtime start. It pushes
  `{v, lookup: null}` while it holds no lease (control unreachable, or `already_claimed`). `expiresAt` is present exactly
  when `lookup` is (`claimLookupLeaseValid`, Go `ClaimLookupLeaseValid`). The runtime shows no code without a lease, and
  after `expiresAt` it treats the lease as gone.

The manager builds `status.report` from `GET /facts`: `sessionsActive = activeSessions`, `recoveryKit =
recoveryKitState(recovery)`, and `lastBackupAt` from the backup status.

## Console file: the runtime writes, `whombat-console` reads (0.7, CC-08)

Path: `WHOMBAT_CONSOLE_FILE` (`CONSOLE_FILE_DEFAULT` = `/run/whombat/console.json`, Go `ConsoleFileEnv` /
`ConsoleFileDefault`). The runtime replaces it atomically (write a temporary file, then rename) with mode 0640, group
`whombat-console`, whenever the state, the code, the backoff or (when claimed) the burrows or the screen sign-in
change. The console polls it every second.

`ConsoleState {v: 1, state, code?, url, retryAt?, lettersUntil?, newLetters?, ipv6Only?, fallbackUrl?, burrows?, signIn?}`:

| `state` | Meaning | Members |
|---|---|---|
| `starting` | The runtime is starting. | `url` |
| `waiting` | No lookup lease yet (control unreachable), so no code. | `url` |
| `claimable` | The code is on the console. | `url`, `code` (the four letters `KXQM`; the lookup number is never shown, CT-67), `lettersUntil?`, `newLetters?`, `fallbackUrl?` |
| `backoff` | Too many wrong codes. | `url`, `retryAt` (RFC 3339), `newLetters?` |
| `claimed` | This Whombat is set up. | `url`, `burrows?` (0.17, CT-116), `signIn?` (0.106, CT-626) |

- `code` is present exactly in `claimable`, `retryAt` exactly in `backoff`, and `burrows` only in `claimed`. Check it
  with `consoleStateValid` (Go `ConsoleStateValid`) after the schema. The console shows `waiting` when a file is
  inconsistent.
- `newLetters: true` (only in `claimable` and `backoff`): the person at the box can ask for new claim letters, and the
  console offers it (the desk socket's `POST /v1/desk/claim/letters {v}` → `{v}`, `409 not_available` on a box that
  shows no letters of its own). `lettersUntil` (RFC 3339, only in `claimable`): the letters showing were asked for
  that way and stay until then; without it they change after a wrong try.
- `url` is `http://0.0.0.0/` while a box claimed on its own pages has no address anyone can reach: a console shows no
  address then.
- `ipv6Only: true` (any state but `claimed`): the box's network gave it an IPv6 address and no IPv4 one. The Whombat
  app takes an IPv4 address only, so a console without an address to open says that an IPv4 address is another way,
  whatever `url` names (a box whose only IPv6 addresses can't be told to anyone names none and is `waiting`).
- `fallbackUrl` (only in `claimable`): another address for the claim, for when `url` doesn't open. The runtime sends
  it beside the claim link at the box's own address, which is on the internet where strangers can keep it busy: the
  box's Tailscale page (`https://`) when it has one, else its address on the local network
  (`http://<IPv4>:<port>/`), which the Whombat app there takes. A console shows it under the letters by the rules of
  `url`, and leaves it out when it can't (a file with a bad one keeps its state and its code).
- `burrows` (0.17, CT-116) is `{first, more}`: the name of the oldest live burrow on the box and how many other live
  burrows there are (0…9999). The runtime leaves it out when the box has no burrow; a runtime older than 0.17 never
  sends it, and a `claimed` file without it stays valid. It is local only: the name never goes to control or the
  relay.
- `signIn` (0.106, CT-626; Whombat signin-at-box.md BX-06) is `ConsoleSignIn {code, name, device, expiresAt}`: a
  device waiting to sign in at the box's screen. `code` is the six letters (`ScreenSignInLetters`, shown grouped
  `KXQ MTR`, `formatScreenSignInLetters`), `name` the account's name (else its email), `device` the new device's label
  as it asked, `expiresAt` when the code goes. Only in `claimed` (`consoleStateValid`); the runtime writes it while the
  sign-in is live and rewrites the file when the letters rotate, the sign-in is used, replaced or expires, and when it
  stops. The console shows it over whatever is on screen and wakes the screen, and hides it once `expiresAt` passed
  even if the file wasn't rewritten. A console that finds a bad or misplaced `signIn` drops the panel and keeps the
  claim state. A console older than 0.106 strips the member and shows nothing (BX-08).
- `url` is `WHOMBAT_APP_URL` + `/claim` with its scheme. The console shows it without the scheme (`consoleDisplayUrl`,
  Go `ConsoleDisplayURL`).
- Every string except `burrows.first`, `signIn.name` and `signIn.device` is printable ASCII without spaces, so a crafted
  file can't carry escape sequences. Those three are user-chosen text (`ConsoleDisplayText`): 1–64 code points, no
  control (Cc), format (Cf: bidi overrides, zero-width characters), surrogate (Cs) or separator (Z) character except
  U+0020, no space at either end. The console still strips control and format characters from every string, like the
  recovery menu does (its Unicode tables may be newer than the validator's), and draws them as text only.
- The whole code, and the screen sign-in's letters, are only in this file and on the console. They never go into the
  journal, a log, control or the relay.
- The schema is tolerant: unknown members are stripped, so an older console reads a newer runtime's file.

## Desk socket: the runtime listens, the console server calls (0.100, CT-528…CT-531; 0.101, CT-543…CT-545; 0.103, CT-595, CT-596; 0.104, CT-601, CT-602; 0.109, CT-684; 0.116, CT-890…CT-896; 0.120, CT-943)

Path: `WHOMBAT_DESK_SOCKET` (`DESK_SOCKET_DEFAULT` = `/run/whombat/console/desk.sock`, Go `DeskSocketEnv` /
`DeskSocketDefault`); unset means no desk. The runtime creates it 0660 in the setgid console directory (group
`whombat-console`), so only the runtime and the console server can connect: the admin socket's model (MR-15; Node
can't read `SO_PEERCRED`). The console stays without network (CG-03). The runtime is the one authority for what the
screen may show (DK-03) and do (DK-04, DK-05); the console server checks every answer with the generated Go types and
`DeskStateValid`, strips control and format characters from every string, and passes on a few typed requests. Paths
are `DESK_PATHS` (Go `DeskPath*`).

| Call | Body | Answer |
|---|---|---|
| `GET /v1/desk/state` | none | `DeskState` |
| `POST /v1/desk/unlock` | `DeskUnlockRequest {v, pin}` (4–6 digits since 0.103) | `DeskUnlockAnswer {v, result: unlocked \| wrong \| backoff, triesLeft?, retryAt?}`; 409 `no_pin` (0.101) |
| `POST /v1/desk/unlock/phone` | `DeskRequest {v}` | `DeskPhoneUnlockAnswer {v, expiresAt}` |
| `POST /v1/desk/lock` | `DeskRequest {v}` | `DeskAck {v}` |
| `POST /v1/desk/touch` | `DeskRequest {v}` | `DeskTouchAnswer {v, until}`; 409 `locked` |
| `POST /v1/desk/decide` | `DeskDecideRequest {v, number, decision: approve \| decline \| deny, pin?, scope?}` (`deny`, `pin` 0.108; `scope` 0.116) | `DeskDecideAnswer` (before 0.108 `DeskAck`); 409 `locked`, 403 `on_phone`, 403 `pin_needed`, 403 `not_offered` (0.116), 409 `no_pin`, 404 `not_found`, 409 `decided` |
| `POST /v1/desk/talk` | `DeskTalkRequest {v, text? \| audioWav?, continue, server?, spoken?}` (`spoken` 3.3) | `DeskTalkStarted {v, id}`; 409 `locked`, 409 `busy`, 503 `voice_unavailable`, 400 `bad_audio` |
| `POST /v1/desk/hear` (3.3) | `DeskHearRequest {v, audioWav}` | `DeskHeard {v, text}` (empty: nothing heard), unlocked only, one at a time; 409 `not_paired`, `locked`, `busy`; 503 `voice_unavailable`, `unavailable`; 400 `bad_audio`; 413 `too_large` |
| `POST /v1/desk/talk/get` | `DeskTalkRef {v, id}` | `DeskTalk`; 404 `not_found` |
| `POST /v1/desk/talk/audio` | `DeskTalkRef {v, id}` | `audio/wav` bytes; 404 `not_found` |
| `GET /v1/desk/network` (0.102) | none | `DeskNetworkAnswer {v, network, mayChange, why?: locked}` |
| `POST /v1/desk/network/wifi/scan` | `DeskRequest {v}` | `DeskWifiScanAnswer {v, scan}`; 409 `no_wifi` |
| `POST /v1/desk/network/wifi/join` | `DeskWifiJoinRequest {v, ssid, passphrase?, hidden?}` | `DeskWifiChangeAnswer {v, change}`; 409 `locked`, `busy`, `no_wifi`; 400 `invalid_passphrase` |
| `POST /v1/desk/network/wifi/forget` | `DeskWifiForgetRequest {v, ssid}` | `DeskWifiChangeAnswer {v, change}`; 409 `locked`, `busy`, `in_use`; 404 `not_saved` |
| `GET /v1/desk/bluetooth` (0.109) | none | `DeskBluetoothAnswer {v, bluetooth, mayChange, why?: locked}` |
| `POST /v1/desk/bluetooth/scan` | `DeskRequest {v}` | `DeskBluetoothScanAnswer {v, scan}`; 409 `locked`, `no_bluetooth`, `busy` |
| `POST /v1/desk/bluetooth/pair` | `DeskBluetoothDeviceRequest {v, address}` | `DeskBluetoothPairingAnswer {v, pairing}`; 409 `locked`, `no_bluetooth`, `busy`; 404 `not_found` |
| `POST /v1/desk/bluetooth/confirm` | `DeskBluetoothConfirmRequest {v, pairingId, accept}` | `DeskBluetoothPairingAnswer`; 409 `locked`; 404 `not_found` |
| `POST /v1/desk/bluetooth/cancel` | `DeskBluetoothCancelRequest {v, pairingId}` | `DeskBluetoothPairingAnswer`; 409 `locked`; 404 `not_found` |
| `POST /v1/desk/bluetooth/connect` | `DeskBluetoothDeviceRequest` | `DeskBluetoothDeviceAnswer {v, device}`; 409 `locked`, `no_bluetooth`, `not_paired`; 404 `not_found` |
| `POST /v1/desk/bluetooth/disconnect` | `DeskBluetoothDeviceRequest` | `DeskBluetoothDeviceAnswer`; as `connect` |
| `POST /v1/desk/bluetooth/forget` | `DeskBluetoothDeviceRequest` | `DeskAck {v}`; 409 `locked`, `no_bluetooth`, `not_paired`; 404 `not_found` |
| `POST /v1/desk/found/dismiss` (0.110) | `DeskRequest {v}` | `DeskAck {v}`, also while locked (*Not now*, DF-04) |
| `POST /v1/desk/servers` (0.115) | `DeskRequest {v}` | `DeskServersAnswer {v, servers, more}`; 409 `not_paired`, `locked`; 503 `unavailable` |
| `POST /v1/desk/server` (0.115) | `DeskServerRequest {v, id, range}` | `DeskServerPage`; 409 `not_paired`, `locked`; 404 `not_found`; 503 `unavailable` |
| `POST /v1/desk/remote-help/stop` (0.120) | `DeskRequest {v}` | `DeskState`, also while locked or unpaired (*Stop*, RH-04); 503 `unavailable` |
| `POST /v1/desk/look/quiet` (0.122) | `DeskLookQuietRequest {v, key, notice {check, subject?}, how}` | `DeskAck {v}`, unlocked only (*Ignore*, *Not now*, QN-20); 409 `not_paired`, `locked`; 403 `not_allowed`; 404 `not_found` |

`DeskState {v, now, paired, pairing, lock, glance, power, talk, presence?, remoteHelp?}`:

- `paired` (`DeskPaired`) is null while nobody paired the screen: the console shows its claimed screen, `glance` and
  `talk` are null and `lock.state` is `locked`. Otherwise `person {name, initial, tone 1…5}`, `assistant {name, look:
  AgentRole}` (the face to draw), `timeZone`, `lockedView` (`time` · `summary` · `everything`), `night` (`dim` ·
  `black`), `quiet` (inside quiet hours now), `voice` (Talk on and possible) and, since 0.101, `hasPin` (false: no PIN
  was chosen, the pad shows only *Confirm on your phone* and the runtime answers an unlock with a PIN 409 `no_pin`
  without counting a try, DK-18; absent: true) and, since 0.103, `pinDigits` (4…6: the pad shows that many dots and
  unlocks at the last digit; absent: 6, a PIN from before or an older runtime; absent while there is no PIN, DK-26).
- `pairing {code, expiresAt}`: the four letters (`ClaimLetters`) the screen shows while an owner pairs in Settings.
- `lock {state, until?, retryAt?, expiresAt?, camera?, present?}`: `locked`; `unlocked` until `until` (2 minutes
  after the last touch, `touch` slides it; with *Stay unlocked while you’re here* 30 seconds after the last face or
  touch once the camera saw someone, at most 4 hours in a row, DK-28); `phone` until `expiresAt` while the phone may
  answer; `backoff` until `retryAt` after five wrong PINs (1 minute, doubling to an hour). Since 0.103, while
  unlocked: `camera` (the camera is on: the chip shows the camera mark, `DESK_WORDS.cameraOn`) and `present` (it sees
  someone: the chip reads `DESK_WORDS.unlockedHere`, DK-30).
  Since 0.107, `stays` while unlocked (*Lock again: When you press Lock*, DK-74): the chip reads
  `DESK_WORDS.unlockedStays`, and `until` is the state's `now` + 2 minutes in every state, so a console that stops
  hearing from Whombat draws it locked 2 minutes later.
- `presence {camera, watching, here}` (0.107, absent when the camera doesn't look; only on a paired screen): the
  camera looking for someone while the paired person's *Use the camera to see when you’re here* is on, outside quiet
  hours, on mains power, while the console shows the desk (DK-72). `camera`: it is on (the camera mark,
  `DESK_WORDS.cameraLooking`, DK-73); `watching`: it can tell now; `here`: a face within `DESK_AWAY_S` (60 s). The
  console shows only the clock when nobody is there: `DESK_AWAY_S` after the last face and touch while `watching`,
  else `DESK_IDLE_S` (10 minutes) after the last touch (DK-70, DK-71). A face never unlocks (DK-29).
- `glance` (`DeskGlance`), trimmed by the runtime to what may show: `status {text, more?}` (core `deskStatusLine`),
  `needsYou {count, items ≤ 5}`, `working {title, steps ≤ 6} | null`, `done ≤ 3`, `servers ≤ 4` with `moreServers`,
  `tiles ≤ 4`. An ask (`DeskAsk`) carries `detail`, `facts` and `approveLabel` only while unlocked, and `onDesk: false`
  with `phoneReason` when core's `deskMayDecide` keeps it on the phone. Since 0.101, `box` (`DeskBox`, core
  `deskBox`): *This Whombat* while the glance has no servers and no tiles, not while locked in *Only the time* (DK-22) —
  `up` (“up 2 h 14 min”, empty when not known), `cpu {percent, cores, tone}`, `memory {percent, used: {value, unit},
  total, tone}`, `history {stepS, cpu[], memory[]}` (the last hour, one point a minute, oldest first, null where
  nothing was measured, both the same length), `storage {percent, free: {value, unit}, total, tone, parts}` (parts
  `whombat` and `agents`, only those measured), `temp?` (`DeskMeter`, °C) and `network {down, up} | null` (per
  second). The words around the figures are the page's (`DESK_WORDS.box`).
  Since 0.104 (DK-37…DK-42) the screen lays the glance out by what there is, and the runtime gives it up to eight
  servers and eight tiles and This Whombat beside them, in members an older console strips: `self` (`DeskBox`, as
  `box`): This Whombat beside servers or tiles, never with `box`, not while locked in *Only the time*, absent when the
  manager doesn't answer; `extraServers ≤ 4`: servers five to eight, worst first after `servers`, only beside four
  `servers`; `extraTiles ≤ 4`: tiles five to eight, only beside four `tiles`. `moreServers` counts every server not in
  `servers`, the extra ones too, so an older console's “+n more” stays right. A 0.104 console draws `box` or `self`,
  whichever is there, and shows what fits (DK-38).
  Since 0.110 (Whombat desk-found.md DF-01…DF-12), `found` (`DeskFound`): found on your network, present exactly when
  the panel (a glance without servers and tiles, where `box` would be drawn) or the strip (beside them) shows, never
  while locked in *Only the time*. `scanning` (a scan runs), `progress {done, total} | null` (only while the burrow's
  first automatic scan runs), `items ≤ 8` (`DeskFoundItem {catalogId, name, tagline, address}`, in catalog order, then
  by address), `count` (every new one, `items` included) and `finishedAt` (when the result shown was finished; null
  while the first scan runs). *Not now* sends `found/dismiss`. An older console strips `found`.
  Since 0.115 (DK-80…DK-89) a server card (`DeskServer`) may carry `id` (`DeskServerId`, the hosts service's id: the
  card opens the server's own screen) and `disk` (`DeskMeter`, its storage in use, the card's third line); a hot server
  says so in its `note` (“hot · 84°”, DK-81). An older console strips both; an older runtime sends neither (the cards
  don't open, the disk line shows “–”).
  Since 0.118 (DK-90…DK-98), `needsYou.looks` (`DeskLook {key, kind, name, state, reason?, server?}`, 1…5, never while
  locked in *Only the time*): what is down or needs a look. Since 0.122 (Whombat quiet-notices.md QN-20) a look carries
  the line it comes from (`notice {check, subject?}`), its kind (`nature`: `problem` offers *Ask {assistant} to look
  into it*, `you` doesn't; absent: a problem; a heads-up is never a look), Ignore's words (`ignoreWords`) and the
  line's own question (`question`, ≤ 300, what *Ask* sends; absent: `DESK_WORDS.looks.question`). *Ignore* and *Not
  now* send `look/quiet` with the look's `key` and `notice` (the PIN first when locked); the runtime quiets the line for
  the whole Whombat as `things.quiet` does. An older console strips the members.
- `power` (`DeskPower`, the manager's `HostPower`): null on a machine without a battery.
- `talk` (`DeskTalk {id, state, question?, answer?, thing, audio, reason?}`): the latest, so a reloaded page picks it
  up. `answer` exactly when `answered`, `reason` exactly when `failed`.

`deskStateValid` (Go `DeskStateValid`) checks what one schema can't: the lock's time exactly in its state, nobody
paired → locked without a glance or a talk, an ask's words only while unlocked, `phoneReason` exactly when not
`onDesk`, no more items than `count`, a consistent talk (`deskTalkValid`, Go `DeskTalkValid`) and, since 0.101, a
`box` only on a glance without servers and tiles, not while locked in *Only the time*, its two series the same
length and, since 0.103, `camera` or `present` true only while unlocked, `present` true only with `camera` true (false
says nothing) and, since 0.104, a `self` never with `box`, only on a glance with a server or a tile, not while locked in
*Only the time*, its two series the same length, `extraServers` only beside four `servers` and no more of them than
`moreServers`, `extraTiles` only beside four `tiles` (an empty list says nothing) and, since 0.110, `found` never while
locked in *Only the time*, with no more `items` than `count`, `finishedAt` null only while `scanning`, `progress` only
then (`done` at most `total`) and `count` 0 only while the first scan looks (`deskFoundValid`, Go `DeskFoundValid`).
The console shows no desk for a state that fails it. A talk request carries exactly one of `text` (≤ 500, since 3.3
`DESK_TALK_TEXT_MAX` 1000)
and `audioWav` (`deskTalkRequestValid`, Go `DeskTalkRequestValid`): base64 of a WAV of 16 kHz mono signed 16-bit PCM,
at most 30 s (`DESK_AUDIO_MAX_BYTES` 960 044 bytes, `DESK_AUDIO_BASE64_MAX` 1 280 060 characters). Request bodies are
at most `DESK_REQUEST_MAX_BYTES` (2 KiB since 0.122, 1 KiB before), a talk's `DESK_TALK_REQUEST_MAX_BYTES` (1.5 MiB), a recording to hear `DESK_HEAR_REQUEST_MAX_BYTES` (3.3: voice typing's
five minutes in base64, `DESK_HEAR_BASE64_MAX`, and 1 KiB); a
state at most `DESK_STATE_MAX_BYTES` (96 KiB since 0.122, 64 KiB before: five looks with their lines and questions). Errors are `LocalError` with the codes of `DESK_SOCKET_ERRORS` (Go `DeskError*`).

A server's own screen (0.115, CT-860…CT-867; DK-83…DK-88): `servers` answers every server of the fleet as the glance's
cards, worst first, at most `DESK_SERVERS` (24), `more` counting the rest (*Servers*, DK-86). `server` takes
`DeskServerRequest {v, id, range}` (`range` one of `DESK_SERVER_RANGES`: `1h`, `24h`, `7d`) and answers a
`DeskServerPage` of at most `DESK_SERVER_MAX_BYTES` (32 KiB): `server` (the card, with the id asked for), `os` and `up`
(empty when not known), the four figures `cpu {percent, cores | null, load, tone}`, `memory {percent, used: {value, unit},
total, tone}`, `disk {percent, used, total, tone}` and `temp {value, limit, tone}` (each null when not known),
`history {range, stepS, cpu[], memory[], cpuPeak {percent, at} | null, memoryAvg | null}` (≤ `DESK_SERVER_POINTS` 96
points, oldest first, ending now), `volumes ≤ 6`, `guests {running, off, items ≤ 6} | null` (null: the server has no
guests), `network {down, up} | null` and `alerts {count, items ≤ 3}` (titles only while unlocked or with
*Everything*, DK-84). Both paths work while locked, but not in *Only the time* (409 `locked`); `not_found` is a server
not in the fleet, `unavailable` the hosts service not answering. `deskServerPageValid` (Go `DeskServerPageValid`): the
card has its `id`, the two series the same length, no more alert `items` than `count`, no more guest `items` than
`running` and `off`; the console server also checks that `server.id` is the id it asked for. A talk may name the server
it was asked from (`DeskTalkRequest.server`, DK-85). A server id is `DESK_SERVER_ID_RE` (Go `ValidDeskServerID`):
a letter or a digit, then letters, digits, `.`, `_`, `:` and `-`, at most 128 in all.

Task feedback (0.116, CT-890…CT-896; Whombat task-feedback.md TF-14…TF-18):

- An ask (`DeskAsk`) may carry `choices` (1…`DESK_ASK_CHOICES`, `DeskAskChoice {scope: task | agent, label ≤ 120}`):
  the web card's wider choices for the paired person (`approvalView().scopeChoices` but `once`), only while unlocked,
  only on an ask the screen may approve (`onDesk` or `approveWithPin`), not on a screen without a PIN, each scope once
  (`deskStateValid`). Every choice needs the PIN: `decide` takes `scope` (`DESK_DECIDE_SCOPES`: `once`, `task`,
  `agent`; only with `approve`, `deskDecideRequestValid`, Go `DeskDecideRequestValid`) with `pin`
  (`deskDecideNeedsPin`, Go `DeskDecideNeedsPin`); without it 403 `pin_needed`, on a screen without a PIN 409
  `no_pin`, a wrong PIN `wrong`/`backoff` as an unlock, and a scope the ask doesn't offer the person now 403
  `not_offered` (nothing decided). `on_phone` still means only “answer this on your phone”. `from` (≤ 40) names who
  asks (“{from} asks”); `title` is the web card's title.
- A talk (`DeskTalk`) without an answer after `DESK_TALK_WORKING_S` (90 s) is `working` (not final, no `answer`, no
  `reason`): it waits for the turn to end, at most `DESK_TALK_WAIT_MAX_S` (30 minutes) after the question, then
  `answered`, or `failed` with `slow`. The screen keeps following it and counts it as use.
- The conversation (`DeskTalkSession`) carries `working {since, doing?}` (≤ 120) while one of the assistant's turns
  runs in its thread (only while open), and a message may carry `task` (`DeskSessionTask {title ≤ 120, state:
  DESK_TASK_STATES, startedAt, endedAt?, result? ≤ 600}`, a server task's card as a live row; its paragraph is the
  card's line): `endedAt` exactly when not `running`, `result` only then, never with `ask` (`deskTalkSessionValid`, Go
  `DeskTalkSessionValid`). The runtime keeps the answer within `DESK_SESSION_MAX_BYTES` (256 KiB), leaving the oldest
  messages out.
- The runtime and the console ship in one host release. An older console strips `choices`, `from`, `working` and
  `task`, but its Go server refuses a state or a talk in `working` (an unknown enum value) until it updates with the
  runtime; an older runtime sends none of them and refuses `scope` (`bad_request`).

The network (0.102, CT-574; Whombat hardware-support.md HD-07): the console server has no network and no manager access
(CG-03), so it asks the runtime. `network` is the manager's `HostNetwork` (above); `mayChange` says whether the screen may
join or forget a network now: the box isn't claimed, or `network.online` is false, or the screen is unlocked. `why`
(`locked`) is there exactly when it may not; join and forget then answer 409 `locked`. Scans work whenever `network`
answers, on an unpaired screen too. The runtime adds the guard's confirm time. The passphrase is a secret: the console
server passes it on and keeps nothing. The runtime answers 503 `unavailable` when the manager doesn't, and the manager's
Wi-Fi codes as they are.

Bluetooth (0.109, CT-684; Whombat bluetooth.md BT-02): the console server can't reach BlueZ or the Bluetooth service
(BT-09), so it asks the runtime. `bluetooth` is the Bluetooth service's `BluetoothState` (below); `mayChange` says
whether the screen may look, pair, answer or stop a pairing, connect, disconnect or remove a device now: the box isn't
claimed, or the screen is unlocked. `why` (`locked`) is there exactly when it may not; every POST then answers 409
`locked` (looking too: it is how adding a device starts). Without a Bluetooth service the runtime answers `bluetooth {adapter: null,
missing: no_adapter, devices: [], scan: null, pairing: null}` and 409 `no_bluetooth` to every POST; otherwise the
service's codes pass through (on these paths `not_paired` is the device, not the screen). The screen polls `bluetooth`
every `BLUETOOTH_POLL_MS` while it looks or pairs. An answer is at most `BLUETOOTH_ANSWER_MAX_BYTES` (64 KiB).

Remote help (0.120, CT-943; Whombat remote-help.md RH-04, RH-12): while it is on, `DeskState.remoteHelp` (`DeskRemoteHelp
{level, until | null, connected | null}`: the level, until when (null: forever), who of Whombat support is connected,
the newest, display text of at most 40) is there on every screen, locked or not, paired or not; absent when it is off.
The console draws one line with *Stop* (core's `remoteHelpDeskLine`, `REMOTE_HELP_WORDS.desk`: “Remote help is on ·
until 14:00”, “{who} from Whombat support is connected”). *Stop* sends `remote-help/stop`; the runtime stops the grant
with reason `desk` (the support socket's `POST /v1/stop`) and answers the new state. It never asks for an unlock:
stopping only ever takes access away. An older console strips the member; an older runtime answers the path 404.

Display text — names, titles, the status, an ask's words, tile values, the question and the answer — is any script on
one line: no control (Cc), format (Cf), surrogate (Cs) or separator (Z) character but U+0020, with the length in code
points in the pattern (`DESK_TEXT_RES`, CT-529). Core's `deskText(text, max)` makes any string fit (a no-break space
becomes a space). The console server still strips control and format characters and the page draws text only.

## Voice socket: `whombat-voice` listens, the runtime calls (0.100, CT-532)

Path: `WHOMBAT_VOICE_SOCKET` (`VOICE_SOCKET_DEFAULT` = `/run/whombat-voice/voice.sock`, Go `VoiceSocketEnv` /
`VoiceSocketDefault`); unset means no voice. The service has no network and keeps nothing after a job. Paths are
`VOICE_PATHS` (Go `VoicePath*`).

| Call | Body | Answer |
|---|---|---|
| `GET /v1/voice/health` | none | `VoiceHealth {v, stt, tts, microphone, speaker, voices?, languages?}` |
| `POST /v1/voice/stt` | `VoiceSttRequest {v, audioWav, prompt?}` | `VoiceSttAnswer {v, text, seconds}` |
| `POST /v1/voice/tts` | `VoiceTtsRequest {v, text, voice?, language?}` | `VoiceTtsAnswer {v, audioWav}` |

- `microphone` / `speaker`: a capture / playback PCM device exists (`/proc/asound/pcm`); `stt` / `tts`: the models are
  there and run.
- `audioWav` in: the desk's WAV (16 kHz mono 16-bit, ≤ 30 s). `prompt` (≤ 400): words that help, such as the
  assistant's name and the burrow's server and thing names. `text` out: one line (segments joined by a space, ≤ 500),
  empty when nothing was heard; `seconds`: the audio's length, rounded.
- `text` in (≤ 600, a desk answer); `audioWav` out: a WAV of mono 16-bit PCM at the voice's own rate, at most
  `VOICE_TTS_WAV_MAX_BYTES` (6 MiB).
- 0.105 (CT-614): `voices` in the health names the voices `tts` can speak with (`VoiceName`, the desk's `DESK_VOICES`),
  its default first; `voice` in a request chooses one of them (another: 400 `bad_request`), absent the default. The
  runtime sends `voice` only to a service whose health lists it: an older service refuses the unknown member.
- 3.4 (Whombat desk-display-talk.md DK-T22): `languages` in the health names what `tts` speaks
  (`VOICE_SPEECH_LANGUAGES`: `en`, its default, and `nl`), English first; `language` in a request is one of them
  (another: 400 `bad_request`), absent English. Dutch is said in the service's Dutch voice of the same kind as `voice`
  (a woman's or a man's); the runtime has written the text out as it is said. The runtime sends `language` only to a
  service whose health lists it, and never `en`.
- One job at a time and at most `VOICE_QUEUE_MAX` (2) waiting. Errors are `LocalError` with `VOICE_ERRORS`: 400
  `bad_request` or `bad_audio`, 413 `too_large`, 503 `busy` or `unavailable`.

## Presence socket: `whombat-presence` listens, the runtime calls (0.103, CT-597, CT-598)

Path: `WHOMBAT_PRESENCE_SOCKET` (`PRESENCE_SOCKET_DEFAULT` = `/run/whombat-presence/presence.sock`, Go
`PresenceSocketEnv` / `PresenceSocketDefault`); unset means no presence. The service reads the camera and finds faces on
the box; it has no network, keeps no picture and stores no face, and tells the runtime only whether, and when, it last
saw one (DK-31). Paths are `PRESENCE_PATHS` (Go `PresencePath*`).

| Call | Body | Answer |
|---|---|---|
| `GET /v1/presence/health` | none | `PresenceHealth {v, camera, detector}` |
| `POST /v1/presence/watch` | `PresenceWatchRequest {v}` | `PresenceWatch {v, state, face, seenAt?, frameAt?}` |
| `POST /v1/presence/stop` | `PresenceStopRequest {v}` | `PresenceAck {v}` |

- `camera`: a capture camera exists; `detector`: the model loads and runs. The runtime's `DeskScreen.presenceAvailable`
  is both.
- A watch starts the camera when it isn't on and keeps it on `PRESENCE_KEEP_S` (6 s) more; the runtime watches every
  `DESK_PRESENCE_CHECK_S` (2 s) while the screen is unlocked with the setting on and stops at every lock (DK-30). The
  service closes the camera by itself 6 s after the last watch.
- `state` (`PresenceState`): `starting` (no frame yet), `watching` (frames arrive and are checked), `dark` (too dark to
  find a face: the runtime treats it as no camera), `failed` (the camera or the detector stopped), `no_camera`. `face`:
  a face in the latest checked frame; `seenAt`: the last frame with a face since the camera came on; `frameAt`: the last
  frame checked.
- Requests are strict and at most `PRESENCE_REQUEST_MAX_BYTES` (1 KiB); answers tolerant. Errors are `LocalError` with
  `PRESENCE_ERRORS`: 400 `bad_request`, 413 `too_large`, 503 `unavailable`.

## Bluetooth socket: `whombat-bluetooth` listens, the runtime calls (0.109, CT-680…CT-683)

Path: `WHOMBAT_BLUETOOTH_SOCKET` (`BLUETOOTH_SOCKET_DEFAULT` = `/run/whombat-bluetooth/bluetooth.sock`, Go
`BluetoothSocketEnv` / `BluetoothSocketDefault`); unset means no Bluetooth (the runtime answers `host.bluetooth` with
`reason: not_managed` and advertises no `host.bluetooth`). Only the service talks to BlueZ (BT-09). It is never
discoverable and registers its pairing agent (`DisplayYesNo`) only while a pairing runs (BT-03, BT-04). Paths are
`BLUETOOTH_PATHS` (Go `BluetoothPath*`).

| Call | Body | Answer |
|---|---|---|
| `GET /v1/bluetooth/state` | none | `BluetoothStateAnswer {v, bluetooth}` |
| `POST /v1/bluetooth/scan` | `BluetoothScanRequest {v}` | `BluetoothScanAnswer {v, scan}`; 409 `no_bluetooth`, `busy` |
| `POST /v1/bluetooth/pair` | `BluetoothDeviceRequest {v, address}` | 202 `BluetoothPairingAnswer {v, pairing}`; 409 `no_bluetooth`, `busy`; 404 `not_found` |
| `POST /v1/bluetooth/pairing/confirm` | `BluetoothConfirmRequest {v, pairingId, accept}` | `BluetoothPairingAnswer`; 404 `not_found` |
| `POST /v1/bluetooth/pairing/cancel` | `BluetoothCancelRequest {v, pairingId}` | `BluetoothPairingAnswer`; 404 `not_found` |
| `POST /v1/bluetooth/connect` | `BluetoothDeviceRequest` | `BluetoothDeviceAnswer {v, device}` within `BLUETOOTH_CONNECT_S` (15 s); 409 `no_bluetooth`, `not_paired`; 404 `not_found` |
| `POST /v1/bluetooth/disconnect` | `BluetoothDeviceRequest` | `BluetoothDeviceAnswer`; as `connect` |
| `POST /v1/bluetooth/forget` | `BluetoothDeviceRequest` | `BluetoothAck {v}`; 409 `no_bluetooth`, `not_paired`; 404 `not_found` |

- `BluetoothState {adapter, missing?, devices, scan, pairing}` (`@whombat/protocol/session`, Go `protocol.BluetoothState`):
  `adapter {name, powered} | null`; `missing` (`no_adapter` · `no_driver` · `disabled`) exactly when `adapter` is null
  or not powered; `devices`: the paired ones (≤ 32), connected first then by name; `scan {until, devices ≤ 64} | null`
  while looking (devices that aren't paired and have a name, strongest first); `pairing` the running one, or the last
  one for `BLUETOOTH_RESULT_KEEP_S` (60 s) after it ended.
- A device: `address` (upper case, `AA:BB:CC:DD:EE:FF`), `name` (display text of 1…80, `hostText`), `kind`
  (`keyboard` · `mouse` · `headphones` · `headset` · `speaker` · `gamepad` · `other`; phones and computers are left
  out, BT-01), `connected`, `battery?` (0…100), `signal?` (bars 0…4 from the RSSI, `bluetoothSignalFromDbm`, Go
  `BluetoothSignalFromDBm`: ≥ −60 → 4, ≥ −70 → 3, ≥ −80 → 2, ≥ −90 → 1).
- A scan runs `BLUETOOTH_SCAN_S` (60 s); asked again, it runs on 60 s from then. Looking while a pairing runs is
  refused `busy`; a pair stops looking.
- A pairing `{id: p-…, address, name, kind, phase, deadline, code?, typed?, failure?}` answers 202 at once and runs in
  the background, `BLUETOOTH_PAIRING_S` (90 s) at most; one at a time (`busy`). Phases: `pairing` → `code` (type
  `code` on the keyboard, then Enter; `typed` the digits so far, when the keyboard says) or `confirm` (does the device
  show `code`? `confirm` answers) → `connecting` (paired and trusted) → `done`, or `failed` with `failure`
  (`rejected` · `timeout` · `not_found` · `canceled` · `failed`). `confirm` and `cancel` take the current pairing's id;
  any other id is `not_found`. A cancel answers the pairing `failed` with `canceled`.
- `bluetoothStateValid` (Go `BluetoothStateValid`) checks what one schema can't: `missing` exactly when unusable, every
  address once among the paired devices and once in the scan, no paired device in the scan, no scan while a pairing
  runs, a consistent pairing (`bluetoothPairingValid`, Go `BluetoothPairingValid`: `code` exactly in `code` and
  `confirm`, `typed` only in `code` and at most the code's length, `failure` exactly in `failed`). Vectors `local.json`
  → `bluetoothStates`, `bluetoothPairings`, `bluetoothSignals`.
- Requests are strict and at most `BLUETOOTH_REQUEST_MAX_BYTES` (1 KiB); answers tolerant and at most
  `BLUETOOTH_ANSWER_MAX_BYTES` (64 KiB; the widest state is about 41 KiB). Errors are `LocalError` with
  `BLUETOOTH_SOCKET_ERRORS` at `BLUETOOTH_SOCKET_ERROR_STATUS` (Go `BluetoothError*`, `BluetoothSocketErrorStatus`):
  400 `bad_request`, 413 `too_large`, 409 `no_bluetooth`, `busy`, `not_paired`, 404 `not_found`, 503 `unavailable`
  (BlueZ didn't answer). Logs name devices, never addresses (BT-10).

## Support socket: `whombat-support` listens, the runtime and the manager call (0.120, CT-938…CT-942)

Path: `WHOMBAT_SUPPORT_SOCKET` (`SUPPORT_SOCKET_DEFAULT` = `/run/whombat-support/api.sock`, Go `SupportSocketEnv` /
`SupportSocketDefault`); unset means no remote help (the runtime advertises no `remote_help`). The support service
(root) is the only judge of remote help (Whombat remote-help.md RH-01…RH-09): it keeps the grant, decides Forever and the
help code, dials the relay only while a grant is active, checks every visitor's certificate and records what they do.
The runtime asks and shows. Callers by peer uid (`SO_PEERCRED`): the runtime (951) everything, the manager (950)
`state` only, root everything; anyone else 403 `forbidden`. Paths are `SUPPORT_PATHS` (Go `SupportPath*`).

| Call | Caller | Body | Answer |
|---|---|---|---|
| `GET /v1/state` | runtime, manager, root | none | `SupportState {v, available, foreverAllowed, helpCodeRequired, environment, hostKey, grant, connected}` |
| `POST /v1/grant` | runtime, root | `SupportGrantRequest {v, level, duration, grantedBy}` | `SupportState`; 403 `forever_not_allowed`; 503 `unavailable` |
| `POST /v1/stop` | runtime, root | `SupportStopRequest {v, reason: owner \| desk, by?}` | `SupportState` (already off: the state) |
| `GET /v1/visits?before=&limit=` | runtime, root | none | `SupportVisitsAnswer {v, visits}`, newest first; `limit` 1…20 (default 20), `before` a visit id |
| `GET /v1/visits/{id}/transcript` | runtime, root | none | `text/plain; charset=utf-8`, the command-line output as recorded; 404 `not_found` |
| `GET /v1/events?after=&waitS=` | runtime, root | none | `SupportEventsAnswer {v, events, next}` |

- `SupportState`: `available` false when the image pins no support CA (the card says “isn’t available … yet”, and
  `grant` answers 503 `unavailable`); `environment` the image's `whombat.environment` (`local`, `dev`, `prod`);
  `foreverAllowed` exactly off `prod` and `helpCodeRequired` exactly on `prod` (RH-03, RH-05); `hostKey` the service's
  SSH host key as `ssh-ed25519 AAAA…` without a comment (`SshEd25519PublicKey`), null before its first start made one;
  `grant` (`SupportGrant` = the session's `RemoteHelpGrant {level, since, until | null, grantedBy {accountId, name},
  helpCode | null}` and `wrongCodes`) or null when off; `connected` (≤ 8 `RemoteHelpConnected {visitId, who, since}`).
  `SupportStateValid` (Go; `supportStateValid`) checks what the schema can't: those two rules, nobody connected without a
  grant, a grant only where `available`, a help code exactly when required, Forever only where allowed, each visit once.
- A grant takes the owner's choice as `duration` (`hour`, `day`, `week`, `forever`; Go `RemoteHelpDurationSeconds`),
  never seconds; `forever` on `prod` is 403 `forever_not_allowed` whatever a client sent. A grant while one is active
  changes it (level and time) and keeps the help code; a lower level closes the connections it no longer allows at once.
  The help code is six characters of `HELP_CODE_ALPHABET` (Crockford, no I L O U; `GenerateHelpCode` over
  `crypto/rand`), the SSH user name on `prod`: `NormalizeHelpCode` what was typed and compare in constant time;
  `RemoteHelpWrongCodes` (5) wrong ones end the grant (`locked_out`). Never logged.
- Who visits (`who`, `RemoteHelpWho`): the name of the certificate's key id before a trailing ` (…)` — control writes
  `Claude (op_7Hq2 via john)` — as display text of at most 40 (`RemoteHelpWho` in Go, `remoteHelpWho` in core); never an
  id. A visit is one certificate (its serial as the visit id): from its first connection until it expires or
  `RemoteHelpVisitIdleS` (900 s) pass without one.
- `RemoteHelpVisit {id, who, level, startedAt, endedAt | null, steps, truncated, transcriptBytes}`: `steps` the newest
  `RemoteHelpStepsShown` (200), oldest first; `truncated` when there were more (the service keeps at most
  `RemoteHelpStepsPerVisit`, 2000). A step is `RemoteHelpStep {at, kind, command?, units?, line?, seconds?, target?,
  bytes?, reason?}`: `connected`, `left`, `look` (`command`, and `units` ≤ 8 for `logs`), `exec` (`line`, the Fix
  command line cleaned with `HostText(line, 500)`), `shell` (`seconds`), `restart` (one unit), `forward` (`target`
  `127.0.0.1:8123`, `[::1]:5432` or a socket path, printable ASCII ≤ 200; `bytes` both ways), `refused` (`reason`:
  `level`, `code`, `certificate`, `limit`, `unknown_command`, `bad_arguments`; `command` what was refused, when a Look
  command), `wrong_code`. `RemoteHelpStepValid` (Go) checks each kind's members. Typed input is never recorded. Records
  stay `RemoteHelpKeepDays` (90) and at most `RemoteHelpKeepBytes` (500 MiB); a visit's transcript at most
  `RemoteHelpTranscriptBytesPerVisit` (50 MiB). The transcript is the raw output (ANSI kept): the runtime strips control
  characters but newlines and tabs before an owner reads it.
- Events: `SupportEvent {seq, at, kind, level?, duration?, reason?, visitId?, who?, startedAt?, steps?, by?}`, `seq`
  from 1, one more for each, kept across restarts. `grant` (an owner turned it on or changed it: `level`, `duration`,
  `by`), `stop` (`reason` `owner` with `by`, or `desk`), `expired`, `visit_start` (`visitId`, `who`, `level`),
  `visit_end` (also `startedAt` and `steps`, how many it recorded), `locked_out` (five wrong help codes). Exactly those
  members (`SupportEventValid`). The runtime tells owners and signs `remote_help.on`, `remote_help.off` and
  `remote_help.visit` from them (RH-08).
- `GET /v1/events?after=<seq>&waitS=<0…25>` answers the events after `after`, oldest first, at most `SupportEventsMax`
  (100), at once when there are any, else after the next one or `waitS` seconds. `next` is the service's newest seq (0
  before the first event), not an echo of `after`: ask again with `after=next`. A `next` below the caller's `after` means
  the service's log started again (its state was reset): read from 0.
- Requests are strict and at most `SupportRequestMaxBytes` (1 KiB); JSON answers tolerant and at most
  `SupportAnswerMaxBytes` (16 MiB). Errors are `LocalError` with `SUPPORT_ERRORS` at `SUPPORT_ERROR_STATUS` (Go
  `SupportError*`, `SupportErrorStatus`): 400 `bad_request` (schema, or a query outside its bounds), 413 `too_large`, 403
  `forbidden` (uid), 404 `not_found`, 403 `forever_not_allowed`, 503 `unavailable`. Vectors `local.json` →
  `helpCodes`, `helpCodeFormats`, `helpCodeBytes`, `remoteHelpWhos`, `remoteHelpDurations`, `remoteHelpSteps`,
  `supportStates`, `supportEvents`.

What the manager reports to control (`status.report.support`, `SupportReport`, CT-944) comes from `GET /v1/state`:
`state` `off` without a grant, else its level; `untilS` the whole seconds left (rounded up; null for Forever and when
off); `connected` how many; `helpCode` = `helpCodeRequired`; `hostKey`. Metadata only (RH-09).

## Backup service socket: the backup service listens, the runtime and the manager call

Path: `/run/whombat-backup/api.sock` (BK-11, BK-17). Paths are in `BACKUP_PATHS`.

| Call | Caller | Body | Answer |
|---|---|---|---|
| `GET /v1/status` | runtime, manager | none | `BackupServiceStatus` |
| `POST /v1/checkpoints` | runtime (`manual`), manager (`manual`, `scheduled`, `migration`) | `CheckpointRequest {reason, releaseId?, migrations?, underDrain?}` | `CheckpointResult`; `LocalError` 409 `busy`, 412 `unprotected`, 403 `forbidden`, 502 `checkpoint_failed` (+ `stage`) |
| `PUT /v1/destination` | runtime (owner op) | `BackupConfigureDestinationInput` | `BackupConfigureDestinationOutput` |
| `GET /v1/recovery-material` | runtime (owner op) | none | `BackupRecoveryMaterial` |
| `GET /v1/ssh-public-key` | runtime (owner op, 0.22) | none | `BackupSshPublicKey {publicKey, fingerprint}` (made on the first call, CT-142) |

`migration` checkpoints are the manager's, taken inside its own drain (scope `all`). It sends its drain
`requestId` as `underDrain`. They are always verified from the destination.

- **Drain:** `requestId` makes a drain idempotent and renews its lease. Without a renewal the runtime resumes by
  itself after `leaseMs`. Scope `all` is the update-style drain. Scope `writes` is the backup checkpoint's write
  barrier (see `DrainRequest`).
- **Facts:** the manager sends them whenever they change and when the runtime starts. They replace the previous
  facts as a whole. The runtime serves them to clients through `appliance.status` via `summarizeBackup` and
  `summarizeUpdate`. The backup summary uses `BackupScope`, the backup service's coverage class ids.
- **Backup status:** `BackupServiceStatus` is the backup service's status document (`whombat.backup-status/1`). It
  is the same schema whether the manager forwards it or the runtime reads the status file.

## Differences from what was built, and who conforms

Compared on 2026-09-25 against the appliance manager (its runtime API, MG-12), the managed runtime (MR-15) and
the backup service (its status document and runtime admin client, BK-05/BK-11).

The contract keeps the manager's admin shapes (with the backup service's `scope`) and the runtime's manager-port
calls. Each side changes as follows.

**Manager**
1. `DrainRequest.scope` is required: send `all`. The backup service already sends `writes` or `all`.
2. `RuntimeHealth.external` is an object `{relay?, control?, providers?}` with values
   `ok|degraded|down|unknown`, not `map[string]string`. `draining` (bool) is new and required.
   `status`, `checks.migrations.access` and `Blocker.kind` are closed enums.
3. `Blocker.description` is printable ASCII, at most 300 characters.
4. Implement the manager socket (`/v1/runtime/ticket|claimed|revocations|push`); no server for it was found in the
   manager worktree. Also call `/claim-window` and `/facts`.
5. `claim.claimed` sends only `{claimedAt}` (epoch seconds). The `claim` and `org` members are gone, since the
   appliance knows neither. Revocations report `ref = RevocationRef(peerId)`.

**Runtime**
1. `ManagerPort.ticket()` sends `{class}` and receives `{ticket, relayUrl, worker, expiresAt}`, with `expiresAt`
   as an RFC 3339 string (it was epoch ms).
2. `ManagerPort.push` takes the contract's `PushRequest`: `{kind, ref, handles[], collapseKey?, ttlS}`.
   Recipients are the push handles endpoints stored with `push.handles.set`, not PeerIds. Map kinds as follows:
   `needs_you`/`approval_updated` → `approval`, `mention` → `mention`, `agent_update` → `message`,
   `run_progress` → `run`.
3. Implement the admin socket: `/health` (with `draining`), `/drain` (scopes `all` and `writes`, lease, 409 when
   busy), `/resume`, `/claim-window` (`openUntil` RFC 3339 or null) and `/facts`.
4. `ApplianceFacts.backup` becomes the client summary of `BackupServiceStatus`. States are
   `unprotected|pending|protected|stale|failing`, replacing `unconfigured|ok`. `lastFailure` is
   `{at, stage, reason}` instead of `{at, code}`. Coverage uses the backup class ids, plus a new `relogin` list.
   Derive it with `summarizeBackup`.
5. `appliance.schemaVersion` is an integer or null; it was a string.
6. Emit application codes in `error.details.code` (`APP_ERROR_CODES`). For example, trust errors become
   `claim_used`, `claim_invalid`, `last_owner`, …, and upload integrity becomes `upload_integrity` instead of
   `details.reason: 'integrity'`.

**Backup service**
1. `Drill.rtoSeconds` and `backupAgeSeconds` are integers; they were float64.
2. `Failure.reason`, `CoverageStatus.title` and `Destination.display` are printable ASCII.
3. `Destination.appendOnly` is one of `verified|not-enforced|unknown`, which matches the current code.

## 0.5.0 conformance list

Compared on 2026-09-25 against:

- the manager: `docs/decisions/manager.md`, `broker.go`;
- the runtime: `managed-runtime.md` MR-14/15/19/20, `managed-providers` PV-04;
- the backup service: `backup.md` BK-17, `internal/api`;
- control: `control.md` G-01…G-11, `extensions.ts`;
- provisioning: NX-24.

**Manager**
1. Forward repair is the journal state `ForwardRepairRequired`, reached from `Activating` or `Verifying`, and it
   leaves only to `Assigned`. It replaces `RolledBack → Quarantined` with failure `forward_repair_required`.
   `UpdateFacts.state` and `UpdateStatusResponse.state` use it.
2. `claim.claimed` sends `{claimId, claimedAt}`; the runtime's `/v1/runtime/claimed` now carries `claimId`.
3. `update.assignment` answers `{result: assigned|unchanged|none, assignment, nextCheckS}`
   (`AssignmentResultValid`).
4. Pin assignment keys as an `AssignmentKeys` document `{v, env, keys[{kid, publicKey, state, notBefore, notAfter}]}` (states: CT-41) and
   use `release.AssignmentKeyMap`.
5. Use `release.CheckActivation` / `UpdateClass` / `ServesClient` / `ProtocolOverlap` instead of the local
   copies (MG-09, MG-18).
6. `status.report` comes from the runtime's `GET /facts` (`local.RecoveryKitState`).
7. Send `underDrain` (the drain `requestId`) with `migration` checkpoints.
8. The manager extensions are now contract types. `UpdateStatusResponse.state` is the journal enum and
   `explanation` is printable ASCII. `NetworkCandidate.mtu` is bounded to 576–9216.

**Runtime**
1. `enroll.claim` requires `claimId`; pass it on in `/v1/runtime/claimed`.
2. Push `ref` is `PushRef`: 22–43 base64url characters, either random or `pushRefFor(key, value)`. Ids such as
   `n:<id>` are refused.
3. The provider ops take the providers workstream's shapes, with `ProviderSignIn.state` as the `ProviderState`
   enum and `ownerAccountId` as an `AccountId`.
4. `agents.setCredentialOwner` is a REST contract: `PUT /burrows/:burrow/agents/:agent/credential-owner
   {accountId | null}` → `{agentId, eventId}`.
5. `DispatchContext.credential` replaces the claim answer's separate facts. It is `{v, credentialOwnerAccountId,
   ownerName, ownerPresent, personal, provider, authMode, requestedByAccountId}`, so `ownerAccountId` becomes
   `credentialOwnerAccountId`, and `provider`/`authMode` are new.
6. `backup.configureDestination` and `providers.login.submit` are `secret` ops: use `receiptDigest`.
7. `GET /facts` matches the runtime's f8ddd4c shape as is.

**Backup service**
1. Answer errors as `LocalError {error: {code, message, stage?}}` with codes `busy` (409), `unprotected` (412),
   `forbidden` (403) and `checkpoint_failed` (502). This replaces `{error: string, stage, reason, state}`.
2. `CheckpointRequest` is strict: `reason` is `manual|scheduled|migration`. There is no `pre-migration` alias and no
   silent fallback to `manual`.

**Control**
1. `claim.claimed` carries `claimId`; complete exactly that claim or answer `claim_unknown`. This closes G-04.
2. `update.assignment` answers with `result` (G-11).
3. Precise reasons go in `error.details.code` (`CONTROL_REASONS`) instead of `x-whombat-reason` (G-05).
   `entitlement_withheld` is also a `ControlErrorCode`.
4. `GET /v1/assignment/keys` serves the `AssignmentKeys` document (G-08). It used to serve `{keys: {kid: hex}}`.
5. Refuse push `ref`s outside `PushRef` (G-07).
6. The extension endpoints are now contracts (`authApi` passkeys and sign-out-everywhere, `orgApi` invitations,
   members, audit and list, `directoryApi.getClaim`, `operatorApi`). `operatorApi.promoteWave` is new, and
   `Wave.observingSince` is available (G-10).

**Provisioning (NX-24)**
1. `NormalizeClaimSecret` also removes U+FEFF, as the contract's `CLAIM_SECRET_DROP` does (JS `\s` counts it,
   Go's `unicode.IsSpace` doesn't). The hash matches `protocol.ClaimSecretHash`.

## 0.7.0 conformance list (claim code, MA-22)

**Manager**
1. While the device is unclaimed, lease the lookup number with the device op `claim.lookup {}` and renew it every
   `renewAfterS`. Stop on `already_claimed`.
2. Push the lease to the runtime with `POST /claim-lookup` (`{v, lookup, expiresAt}` / `{v, lookup: null}`).

**Runtime**
1. Hold the letters (`generateClaimLetters` over a CSPRNG) in memory only. Rotate them after every failed `enroll.claim`
   under `code`, and apply `claimBackoffSeconds`.
2. Serve `POST /claim-lookup` and write the console file (`ConsoleState`; from 0.17 `burrows` when claimed).
3. Implement `enroll.claim.begin` and the confirmed `enroll.claim` (`claimPakeResponder`, `claimConfirmEqual`).

**Appliance (`whombat-console`)**
1. Read `WHOMBAT_CONSOLE_FILE` with `local.ParseConsoleState` and `local.ConsoleStateValid`, and render plain text.

## 0.9.0: AI clients (SUB-09, CT-73, CT-74)

Claude Code and Codex are no longer pinned in the image. On an owner's request the manager installs the latest
version Whombat has tested and keeps it up to date.

- **The channel.** The manager verifies the client channel: the TUF target `clients/channel.json` (`CLIENT_CHANNEL_TARGET`) of
  the delegated `clients` role, whose content is a `SignedClientChannel`. It checks the channel with
  `release.VerifyClientChannel`, with keys from its pinned channel key document (`AssignmentKeys` shape, resolved
  with `AssignmentKeyMap`) and the last sequence it accepted. It refreshes the channel with its TUF metadata.
- **Selecting a bundle.** `release.SelectClientBundle(bundles, provider, "linux", arch, adapter)`, where
  `adapter = RuntimeFacts.clientAdapters[provider]`. Since 3.0 the runtime names only `claude` (CT-1564: ChatGPT runs
  on Hermes's own loop and needs no client), so the manager selects no Codex bundle.
- **Install.** The manager downloads the TUF target `artifact.target`. Its sha256 is TUF's and `artifact.sha256`. It
  unpacks `artifact.path` and checks `executable.sha256`. It installs read-only (root-owned, executable by the
  runner) under `/persist/whombat/clients/<provider>/<version>/`, then pushes `POST /clients`. It never runs the
  CLI, and never modifies it.
- **Updates.** Whenever the channel's sequence advances, or `clientAdapters` changes after a runtime update, the
  manager selects again for every installed provider. If the selection differs, it installs the new version next to
  the old one (`updating`, and `installed` stays the running version). Once it is complete and verified, it switches
  `installed` to it and pushes. The previous version stays on disk for at least 24 hours, so turns that already
  started on it finish.
- **What the manager keeps.** The chosen providers persist in the manager's state under `/persist`. Removing one
  deletes its versions and pushes `not_installed`. Sign-ins aren't touched.
- **What the runtime does.** It runs turns only on `installed.executable.path`, after checking its sha256 (PV-01's
  drift check, with this pin instead of the image's). It exposes the status as `clients.list`. A provider with nothing
  installed refuses turns with `client.not_installed`.
- **Progress** pushes happen at most once a second. Times are RFC 3339 and messages printable ASCII, as everywhere
  here.

A self-hosted server has no manager. It verifies the same channel with its own pinned keys, selects with its own
adapter levels, and fetches `source.url`. It checks `source.sha256`, unpacks `source.path` for a tar.gz, checks
`executable.sha256`, and installs into `$WHOMBAT_HOME/tools/<provider>/<version>/`.

## 0.10.0: the appliance licence (LC-05…LC-08, CT-76, CT-77)

- **The manager renews.** Once `GET /facts` reports `claimed`, it calls the device op `licence.renew {}` →
  `{token, expiresAt, renewAfterS, now}` right away, then every `renewAfterS` (±10 % jitter), and on
  `POST /v1/licence/renew`. Failures back off from 60 s to 1 h. `device_unclaimed` and `device_revoked` stop the loop
  until the runtime reports a claim again.
  - It verifies every token with `protocol.VerifyLicenceToken` against the pinned key set
    (`protocol.ParseLicenceKeySet` of `licence.keysFile`), with its own device id and its effective time. It refuses a
    token whose `iat` is older than the one it holds.
  - It keeps `{token, highWater}` in `/persist/manager/licence.json` (0600, atomic). `highWater` is the maximum of
    every accepted `iat` and control's `now`, and it never goes down.
- **The manager pushes** `POST /licence {v, token, highWater}` whenever the token changes, at every runtime (re)start
  and with the periodic facts re-send. `highWater` is RFC 3339. `token: null` means it holds none yet. A 404 means a
  runtime before 0.10.0: keep going and try again later.
- **The runtime** verifies the pushed token with `verifyLicenceToken` (its own copy of the pinned key set,
  `WHOMBAT_LICENCE_KEYS_FILE`, and its device id).
  - It refuses a token whose `iat` is older than the stored one's (409 `stale`), and a token that doesn't verify (400
    `bad_request`).
  - It stores the token and `highWater`. It raises its clock mark hourly and at every push, and a newer token resets
    the mark to `highWater` (LC-07).
  - It answers `LocalLicenceStatus {state, reason, plan, expiresAt, graceEndsAt, effectiveAt}`, or null when it is
    unclaimed.
  - The state is `licenceStatus` at max(clock, highWater, clockMark). The Go twin is `protocol.LicenceStatus`, with the
    same vectors.
