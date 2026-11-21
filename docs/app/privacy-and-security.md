# Whombat privacy and security model

> whombat-app and whombat-contracts are part of this repository (`docs/decisions/one-repo.md`). Where this page names
> them, read this repository: whombat-app's paths are unchanged (`apps/`, `packages/`), and so are whombat-contracts'
> `packages/`; its `go/`, `schema/` and `vectors/` are under `contracts/`.

This document is for people who want to check how Whombat handles their data. It covers the clients in this
repository (web app, phone app, Feedback widget, client session layer), the protocol library they use (the contracts)
and, where it matters to them, the appliance's runtime, which is in this repository too. It says what is encrypted end
to end, what Whombat's own servers can see, and what reading this source can't tell you.

State as of 2026-11-05: app 3.68.0, contracts 3.19.0.
The managed appliance service is pre-release.
Where this document says something is "planned" or "not in place", it means exactly that.

**How to read it.** This repository holds the appliance's runtime (`apps/server`, `apps/runner`, `apps/agent-net`,
`packages/agent-runtime`), the apps and the contracts. Paths in backticks are relative to it. The appliance's operating
system, manager and update helper (the appliance), the cloud control service (control), the relay
(the relay) and the update repository are not; statements about them are marked **[closed]** and describe their
design and code as the Whombat team reviewed them. You can't verify those statements from this repository's source.
They are here so the boundaries are clear.

## 1. Components and who runs them

The customer's data lives on a Whombat appliance at the customer's premises. Clients reach it over one end-to-end
encrypted channel (Noise XX, the appliance's identity pinned), carried one of three ways: through Whombat's relay, or
straight to the appliance on the local network or on the customer's Tailscale network. Clients try the direct ways first;
the relay sees only ciphertext either way. A browser reaches the appliance directly from a page the appliance serves
itself, only over HTTPS: on its own address or its Tailscale name. Over plain HTTP it serves no page, only a sentence
naming those addresses (section 8).

| Component | Runs where | Operated by | Source | Sees content? |
|---|---|---|---|---|
| Web app (`apps/web`) | the user's browser: served from Whombat's web origin (`app.whombat.com`), or by the appliance itself on its direct ways | whoever serves it | public | yes, decrypted locally |
| Phone app (`apps/mobile`, Android first) | the user's phone | Whombat builds and signs it | public | yes, decrypted locally |
| Client session layer (`packages/client`) | inside both apps | — | public | — |
| Protocol and crypto library (whombat-contracts) | clients, appliance, relay, cloud service | — | public | — |
| Appliance runtime (server, runner, agent network, database) | customer premises | customer owns it; **Whombat ships its software updates** | public (this repository) | **yes, plaintext** |
| Appliance operating system (NixOS), manager, update helper | customer premises | customer owns it; **Whombat ships its software updates** | not in this repository | **yes, plaintext** |
| Cloud control service (control) | Whombat's servers | Whombat | closed | no, metadata only |
| Relay | Whombat's servers | Whombat | closed | no, ciphertext and metadata |
| Update repository (TUF) and the AI client channel | Whombat's servers | Whombat | closed | no (it distributes signed software) |

Trust boundaries:

- **Endpoint ↔ appliance.** Both ends are trusted, and so is the code they run.
- **Relay.** Not trusted with content. It is trusted for availability only.
- **Cloud service.** Not trusted with content or with local authorization, and not trusted for the appliance's
  identity: the clients pin that from the claim, a recovery kit or a link made by an enrolled device (section 3.4).
  It is trusted for sign-in, the appliance directory's list, relay admission, push delivery and choosing which signed
  update an appliance gets.
- **Web origin, update signing and app signing.** These are trusted suppliers. Sections 5 and 6 explain what that
  means.

## 2. Summary

- Traffic between a client and its appliance is end-to-end encrypted with Noise XX. The appliance's identity key
  is pinned, and each device has its own key. The relay forwards opaque bytes.
- The cloud service never receives message content, files, prompts or AI output, except a notification's short
  preview (who wrote, where, the start of the message), which it passes to the push service without storing it and
  which each person can turn off (Settings → Notifications, “Show message text in notifications”). It holds account
  and organization data, the appliance directory, update and health reports, licence renewals, push tokens, and request
  logs without IP addresses (kept 14 days). A signed-in person can delete their cloud account.
- The appliance holds everything in plaintext, because it is the customer's server. Whombat signs and ships the
  appliance's software updates. A malicious or compelled update could read that data. Auditing the clients cannot
  rule this out.
- The web client is served by Whombat. A malicious bundle could read everything you see in the browser. There is
  no published hash of the served web bundle yet, and no tooling to check it.
- Whombat support can get into an appliance only while its person has turned on remote help, for the time and at the
  level they chose; the appliance records what support does and the person can stop it (section 5.3).
- The clients have no analytics, crash reporting or session replay.

## 3. End-to-end encryption (managed mode)

### 3.1 The channel

Clients reach their appliance through the relay, or directly: the appliance listens on one port (4480) on its
local-network addresses and its Tailscale name, and the same Noise session runs over a WebSocket there
(`apps/server/src/managed/direct/`; section 8). Through the relay, the appliance keeps outbound WebSockets open to it.
The layers are:

```
session frames: [u32 len][u8 type][u32 stream][payload]    whombat-contracts packages/protocol/src/frame.ts, session/
Noise records inside Noise_XX_25519_ChaChaPoly_SHA256       whombat-contracts packages/secure-channel/src/
relay WebSocket (TLS to the relay; the relay splices)       whombat-contracts packages/protocol/src/relay.ts
```

- **Handshake:** libp2p Noise, pinned to `@libp2p/noise` 17.0.3, client as initiator. X25519, ChaCha20-Poly1305
  and SHA-256, by default from pure-JS `@noble/*` code. The Noise static key is bound to an **Ed25519 identity** by
  a signed handshake payload.
- **Our checks, before the library's own** (`packages/secure-channel/src/identity-guard.ts`): Ed25519 identity keys
  only, canonical encoding, no small-order keys, strict RFC 8032 signatures, no early data. The prologue
  `whombat-secure-session/2` is mixed into the handshake hash.
- **Pinning:** the client pins the appliance's PeerId. On a mismatch it aborts before sending the third handshake
  message; only its 32-byte ephemeral key has left the client.
- **Close and rekey:** close is authenticated (a connection ending without a CLOSE record is reported as
  truncated). Rekeying means reconnecting with fresh keys, after 2^30 messages, 2^40 bytes or 12 hours.
- **Admission:** the relay admits a connection only with a short-lived EdDSA-signed ticket from the cloud service,
  single-use for clients (`packages/protocol/src/admission.ts`). A ticket only admits bytes; the appliance
  authenticates every session itself.

The dependency choice, the pinned versions and the risks we accepted are recorded in an internal design record
that isn't published yet. `@libp2p/noise` has no public audit. Its primitives
(`@noble/curves`, `@noble/ciphers`, `@noble/hashes`) have had public audits of earlier versions. Our use of the
library was reviewed internally.

### 3.2 Keys and where they live

| Key | Generated | Stored | Source |
|---|---|---|---|
| Browser endpoint key | in the browser | IndexedDB, as a **non-extractable** WebCrypto Ed25519 key wherever the page has WebCrypto: the hosted app, the box's own address and Tailscale page, `localhost`. Page script can sign with it but can't read it. A browser without WebCrypto Ed25519 is refused; it never gets a weaker key. A software key an older box's plain-HTTP page left in a browser is never used: the page asks the person to forget this browser and set it up again (section 8). | `apps/web/src/managed/keys.ts` (`endpointKeyStore`) |
| Phone endpoint key | on the phone | expo-secure-store (Android Keystore / iOS Keychain), `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: not synced, not backed up. It is loaded into app memory to sign, because Hermes has no WebCrypto. | `apps/mobile/src/managed/keys.ts`, `secureStore.ts` |
| Recovery key | in the person's client | only in the kit file the person saves. The appliance keeps the public half. | `packages/client/src/managed/recovery.ts` |
| Appliance content identity (the PeerId clients pin) | on the appliance | a 0600 file on its data volume, which a self-installed appliance doesn't encrypt (section 5.1) **[closed]** | — |
| Admission ticket signing key | cloud service | cloud service secrets **[closed]**. It can admit relay connections, not sessions. | — |

"Forget this browser/phone" deletes the endpoint key. Every appliance then treats the device as new.

### 3.3 Claiming an appliance (CPace)

A Whombat is one person's device. That person claims a new appliance with the four letters on its screen, or with the
claim card as a fallback.

1. The client asks the cloud service to reserve the claim (`claims.start`). It sends the device id and, for a card,
   a domain-separated SHA-256 verifier of the card's 128-bit secret. The cloud service never receives the letters
   or the card secret.
2. The client opens an enrollment session pinned to the PeerId the cloud service returned.
3. Inside that session the client and appliance run **CPace** (`CPACE-RISTR255-SHA512`, draft-irtf-cfrg-cpace-21).
   The password is the letters, or a hash of the card secret. The channel identifier includes both Noise static
   keys and the claim id. Confirmation tags are checked in both directions.
4. Only if the appliance's tag verifies does the client pin the PeerId and create the recovery kit. A relay or
   cloud service that substitutes a different appliance can't produce that tag without knowing the letters, and
   it gets one online guess per attempt.

A wrong guess rotates the letters; after 3 failures in 24 hours the appliance backs off from 1 to 60 minutes
(`apps/server/src/managed/claim.ts`, `trust.ts`). Claiming by letters works only from the appliance's own public network: the cloud service compares keyed
hashes of the two network prefixes (section 4.1).

Where to look: `packages/protocol/src/claim/` (`cpace.ts`, `pake.ts`, `attempts.ts`), `go/protocol/cpace.go`,
`go/protocol/claimpake.go`, `vectors/cpace.json`, `vectors/claim.json` (whombat-contracts); the client ceremony in
`packages/client/src/managed/claim.ts`.

### 3.4 Adding and removing devices

Signing into a cloud account never gives access to an appliance. An endpoint key has to be enrolled on the
appliance itself, in one of these ways:

- **Pairing.** The new device shows a code and the fingerprint of its own key. An enrolled device looks the code
  up, compares the fingerprint and approves (`packages/client/src/managed/pairing.ts`).
- **Recovery kit.** A signature by the recovery key enrolls a device into the person's account.
- **Device link.** On a community box, an enrolled device makes a five-minute, one-time link (or its QR code) whose
  secret is in the fragment; opening it on the new device lets it in to the same account (`community.ts`).
- **The box's screen.** The box shows six letters for this device; CPace over them, bound to both Noise keys, lets it
  in to the person's account (`screen-signin.ts`).

There are no invites and no re-enrollment by someone else: nobody else uses the appliance.

These comparisons authenticate the **new device to the appliance**, not the appliance to the new device. So before a
device connects anywhere, it has to know the appliance's identity (its PeerId) from a party that already trusts the
appliance. The cloud directory lists every appliance with its PeerId, but the clients never take the pin from it
(`packages/client/src/managed/pin.ts`, `registry.ts`). Each way in gets the pin like this:

| How the device gets in | Where the pin comes from |
|---|---|
| Claim | the claim ceremony, only after the appliance's CPace confirmation verifies (section 3.3) |
| Pairing | an **add-a-device link** from an enrolled device (Settings · Devices → “Add a device”): `…/appliances/<device>/add#p=<PeerId>`. It names the identity the enrolled device pinned; it isn't a credential, the approval still is. |
| The box's screen | the directory's identity, kept only once the box's screen sign-in tag matched (`screen-signin.ts`) |
| The box's own page | the PeerId the box names at `GET /v1/direct`, kept on first use; a later page that names another identity is the hard stop (`apps/web/src/managed/BoxRoot.tsx`). The page comes over HTTPS, so that first answer comes from the box the address names. |
| Recovery kit | the kit file, version 2: an `Appliance identity: <PeerId>` line covered by the kit's checksum (`recovery.ts`, `kitText` and `readKitFile`). A version 1 kit, or a typed recovery key, works only on a device that already has a pin for that appliance. |

The pin is stored on the device with where it came from (`claim`, `kit`, `add-link`, `passkey`, `screen`, `box`, or
`legacy` for pins stored before this rule). Nothing but a new claim replaces a pin. Every session is opened with the
pinned PeerId (section 3.1). The directory's PeerId is only compared with it:

- **Pinned and equal:** the device goes on.
- **Pinned and different: a hard stop.** “This Whombat’s identity has changed.” Nothing is sent to the appliance and
  the pin isn't updated. The only way on is the explicit “Forget this Whombat on this device”, after which the device
  has to be set up again through one of the ways above.
- **Not pinned:** “Set up this device” explains the ways in. The device never connects with the directory's PeerId.
- **A link or kit that names a different identity than the directory:** a hard stop before any secret is sent.

A replaced or reset appliance is a new device with a new identity. Its person claims it again (CPace proves the new
identity to the claimer), adds their other devices with add-a-device links, and makes a new recovery kit. The runtime
never rotates its identity; a signed statement that would let clients follow a planned hardware move is designed but
not built.

**Revoking** a device happens on the appliance. The appliance bumps the account's authorization generation and
closes that device's sessions. Compliant clients clear their cached data when told they were revoked
(`packages/client/src/session/scope.ts`). Revocation can't erase data a device already saved, or data on an
offline or modified client. The appliance reports an opaque revocation reference to the cloud service
**[closed]**.

### 3.5 Where an auditor should start

| Question | whombat-app | whombat-contracts |
|---|---|---|
| Handshake, identity checks, record layer, flow control | `packages/client/src/session/secure.ts`, `secure-channel.ts` (the port) | `packages/secure-channel/src/`, its `test/` (tamper, replay, identity) |
| Ticket, relay dial, pin check before any byte | `packages/client/src/session/connector.ts` | `packages/protocol/src/relay.ts`, `admission.ts` |
| Session messages, operations and enrollment | `packages/client/src/session/`, `packages/client/src/managed/` | `packages/protocol/src/session/`, `docs/contracts/session-protocol.md` |
| Everything the clients send to the cloud service | `packages/client/src/managed/control.ts` | `packages/control-contracts/src/` (`auth.ts`, `orgs.ts`, `directory.ts`, `push.ts`) |
| What an appliance may report to the cloud service | — | `packages/control-contracts/src/device/` (`status.ts`, `push.ts`, `envelope.ts`) |
| Update metadata the appliance verifies | — | `packages/release/src/` (`tuple.ts`, `assignment.ts`, `signed.ts`, `clients.ts`) |
| Go implementation and cross-language vectors | — | `contracts/go/`, `contracts/vectors/`, `docs/contracts/cross-language.md` |
| Contracts in this repo | workspace packages (`packages/`), built from source | `docs/contracts/publishing.md` (releases for other repositories) |

### 3.6 Limits of the channel

- **Sizes and timing.** Each application message is one Noise record, and nothing is padded. The relay sees the
  size, direction and timing of every message.
- **A lying directory or relay.** A compromised cloud service can point a device at a different appliance identity
  and mint the tickets to reach it. A device with a pin stops before it sends anything (section 3.4), and the
  handshake would abort anyway on a pin mismatch. A device without a pin doesn't connect. The cloud service still
  decides whether a device can reach its appliance at all: it can deny service, but not substitute the appliance.
- **What this doesn't cover.**
  - **Pins stored before this rule** (`legacy`) may have been copied from the directory at the time. They are kept
    as they are. If you have reason to doubt one, forget the Whombat on that device and set it up again.
  - **A version 1 recovery kit or a typed recovery key** relies on the pin the device already has.
  - **Links and kits are only as trustworthy as their path.** An add-a-device link sent through a channel an
    attacker controls could have its `p` swapped along with the rest of the link;
    the directory would then also have to name the attacker's identity for the device to go on. The kit's checksum
    catches damage or accidental edits, not forgery; whoever can change your kit file already has your recovery key.
  - **The claim** pins the PeerId the cloud service names only after CPace confirms that the box holding it knows
    the letters on the screen or the card. An attacker would need those too.
- **Pairing** is protected by its fingerprint comparison, if you actually compare. Look at the enrolled devices in
  Settings → Devices now and then.

## 4. What the cloud service and relay can see

### 4.1 Cloud control service [closed]

It stores identity, organization, directory, routing and update metadata. It has no endpoint that carries
workspace content. The client side of every call is in `packages/client/src/managed/control.ts`.

| Data | Details | Kept |
|---|---|---|
| Cloud account | email address, sign-in sessions (hash of the token, created, expires, last seen, revoked; no IP or user agent), passkeys if used, a pseudonymous relay subject id | until you delete the account (below) |
| Magic links | email address, token hash, times | 1 day after expiry |
| Organizations | name, its one account, update cohort, entitlement (plan, subscription state, how many appliances and connectors it allows, whether self-installed appliances may be claimed) | deleted with its account |
| Appliance directory | device id, route id, hardware serial, model, management public key, content PeerId, owning org, display name, claim and registration times, last seen, rollout bucket | retired, not deleted |
| Claims | device, org, account, method, state, times; a verifier of the card secret; the version of the appliance terms accepted and when | kept (the account is removed from it when it is deleted) |
| Network tags (unclaimed appliances only) | `HMAC(key, IPv4 address or IPv6 /64)` of the appliance's and the claimant's network, used to find a box on your network. Never the address itself. | erased at claim or retirement |
| Status reports (every 5 min) | release and manager version, uptime, update state, health levels, disk use, number of active sessions, recovery-kit state, last backup time, clock sync; remote help's state (off, Look or Look and fix), seconds left, how many are connected, whether a help code is needed and the support service's SSH host public key. The schema is strict: `packages/control-contracts/src/device/status.ts` | 30 days |
| Update progress | per appliance and release: state, attempts, failure code, times | kept |
| Licences | per appliance: the last issued licence's id, issue and expiry time and subscription state, overwritten at each renewal (about daily; hourly while the subscription isn't trialing or active). The audit log records each issue (appliance, org, plan, state, licence id, expiry). The signed licence carries the org, plan, state and limits, never content. | the last one per appliance; audit rows as below |
| Push | per account: platform, the FCM/APNs token or Web Push endpoint and keys, app id. Per delivery: handle, appliance, kind, result, time. | handles until removed; deliveries 14 days |
| Revocations | appliance, opaque reference, kind, state, times | kept |
| Audit log | actor (a pseudonymous account id), org, action, target, small structured details. Control writes no emails or IP addresses into it. Each remote help certificate control issues is recorded here and in the organization's log (“Whombat support”): device, the name shown to the person, level, serial and validity. | 400 days |
| Rate-limit counters | keyed by hashed email, by account id (tickets), or by a keyed hash of the caller's network (the IPv4 address or the IPv6 /64, with a key used only for this), never the address itself | 2 days |

**What it learns as it works.** It issues every connection's ticket, so at that moment it knows which account
asked to reach which appliance, on which channel. Tickets are not stored, and the request log doesn't record who
asked (below). Your IP address is used only in memory, to derive the keyed values above. From push deliveries it
learns when an appliance wanted to notify someone, and of which kind; while it sends a notification it also holds its
preview (at most 80 code points of title and 160 of text, plain text, CT-286), which it neither stores nor logs. From
licence renewals it learns that each appliance is running and still claimed, about once a day.

**Logs and backups.** A request log line carries the method, the route pattern (like `/v1/orgs/:org`, so no ids),
the status, the duration and a request id. It has no IP address, user agent, query string or other header, and
request bodies are not logged. Logs stay in each host's journal, which keeps 14 days. Database backups extend every
retention above by up to 35 days.

**Deleting your cloud account** (`DELETE /v1/me`, after typing your email again). It is refused while one of your
organizations still has an appliance or a live subscription. Deleted at once: the account, its sign-in sessions (they
stop working immediately), passkeys, push handles, its sign-in links, and its organizations. Claims you started stay,
without your account. Kept: audit rows up to
400 days under your pseudonymous account id (no email), hashed rate-limit rows up to 2 days, request logs up to
14 days (no emails or addresses), backups up to 35 days. The cloud service can't delete what lives on an appliance:
that data stays on the appliance.
Export anything you want to keep first. The web app (Your Whombats → Delete account) and the Android app offer it.
Afterwards the app forgets that account's list of Whombats and their pinned identities on the device. The device's
endpoint key stays: it belongs to the browser or phone, not to the cloud account, and it stays enrolled on the
appliance until you remove the device there (Settings → This Whombat → Devices).

**Email.** Magic-link emails go out through an SMTP provider. Sign-in tokens travel in the URL fragment, so they never
reach server logs.

### 4.2 Relay [closed]

The relay pairs a client WebSocket with a data connection from the appliance and forwards binary messages
unchanged. It never parses them.

**What it sees while a connection is open:** both ends' IP addresses; the ticket's contents (pseudonymous relay
subject, organization id, appliance route id, channel, ticket id); the browser's `Origin` header; connection times;
and the size, direction and timing of every message.

**What reaches the appliance:** only that a session is waiting, and its class (`packages/protocol/src/relay.ts`,
`RelayIncoming`). The relay doesn't pass on the client's IP address or cloud identity.

**What it keeps:** no database; routes, single-use ticket ids (until they expire) and rate limiters live in memory.
By design it doesn't log tickets, subjects, organizations, appliance ids, IP addresses or payloads at its normal log
level, and its metrics carry no identifiers. The host's journal keeps 14 days. It reports nothing to
the cloud service; it only fetches the ticket verification keys.

## 5. The appliance, and the updates Whombat ships to it

### 5.1 What it holds

The appliance is the customer's server. It holds workspace data in plaintext: the database (messages, runs,
memory, audit, accounts with their email addresses), files and repositories, connector tokens, and the AI provider
credentials described below.

**Disk encryption [closed].** A self-installed appliance, the only kind shipping today, does **not** encrypt its
disks: the system and the data volume are plain ext4 and btrfs, with no TPM and no disk recovery key. Anyone who holds
the disk, or the host a virtual appliance runs on, can read everything on it. Encrypt the machine's disk or the VM's
storage underneath, and keep the box somewhere you trust. Appliances Whombat sets up itself are designed to use LUKS2
with a TPM2-sealed key bound to measured boot, plus a printed disk recovery key; they don't ship yet.

**AI providers.** People sign in to Claude Code or Codex with their own subscription or an API key. The CLIs run
on the appliance and keep their credentials there, in the CLIs' own files. Claude's sign-in runs `claude auth
login` in a terminal on the appliance, which the client shows through the encrypted session: you open the claude.ai
link in your browser and paste the code back. Codex uses a device code you enter at OpenAI. The client never logs or
caches that terminal's output or your keystrokes (`packages/client/src/signins/console.ts`). The appliance sends
prompts and workspace context to the provider you chose, which sees what it is sent.

### 5.2 Updates

**Signing and delivery [closed].** The appliance's software, and the Claude Code and Codex binaries it runs, come
from Whombat's update repository, which uses TUF (The Update Framework). The cloud service chooses which approved
release an appliance gets and signs that choice with a separate assignment key; it can only pick releases already
signed in TUF. On the appliance, both the manager and a separate root helper verify the TUF metadata, the
assignment and every artifact's hash. Downgrades are refused unless the signed release allows them, and a failed
update rolls back.

**Rollout [closed].** Staged through internal, pilot and canary cohorts, then everyone, with observation windows,
automatic pause and an emergency stop.

**Ask before updating [closed].** Updates install by themselves unless an owner turns on *Ask before updating*
(Settings → This Whombat → About). Then every update downloads and is checked as usual, and waits until an owner
presses Update now for that exact release; a newer release needs its own yes. The box's manager keeps the setting and
enforces it, so neither the cloud service nor a release we sign and assign gets past it. Going back to the release that
ran before, after an update failed its checks, doesn't wait. The owner's choice and each approval are signed
appliance events (`update.ask_set`, `update.approved`). When the apps can't take the owner's yes, the recovery menu at
the box (hold Space at power-on) turns the switch off. It protects only against an update arriving unannounced: once
approved, a malicious release can do everything described next.

**What a malicious or compelled update could do.** A signed appliance release runs as root on a machine whose
volumes are unlocked. It could read and exfiltrate every piece of data on the appliance, including the AI provider
credentials. A malicious Claude Code or Codex binary pushed through the client channel could do the same with the
workspaces and credentials those CLIs can reach. **The end-to-end encryption in sections 3 and 4 does not protect
against this, and auditing the clients cannot rule it out.**

**Mitigations designed, and their status**

| Mitigation | Status |
|---|---|
| Offline threshold root: 2-of-3 hardware tokens; 2-of-2 offline targets keys | designed; **production keys and the signing ceremony don't exist yet** |
| Separation between the update signers and the cloud service | **not in place**: today every update key sits on the cloud service's own server, one key per role (a pilot setup), so whoever controls that server can sign a release |
| The client channel (Claude Code, Codex) | planned to be signed by a single online CI key limited to those files. The binaries are the unmodified upstream executables, checked against Whombat's recorded SHA-256. Upstream vendor signatures are not checked. |
| Staged rollout, observation windows, emergency stop | implemented in the cloud service |
| Reproducible appliance builds | partial: the contracts npm packages rebuild byte for byte; other artifacts are not verified |
| Customer approval of each update | in place, off by default (*Ask before updating*, above) |
| Transparency log, signed build attestations | **not in place** |

### 5.3 Vendor access, diagnostics and backups [closed]

- **No standing vendor login; remote help only while its person allows it.** The appliance has no SSH daemon listening
  on any network and no support account. The person can turn on remote help (Settings → This Whombat → About) for 1 hour,
  1 day or 1 week (and “Forever” only on test images; the support service on the box decides), at one of two levels:
  *Look* (a fixed list of read-only commands as an unprivileged user: status, logs, hardware, network and the like; no
  shell, no forwarding) or *Look and fix* (also a root command line, restarts and connections to the box's own local
  ports and sockets). Turning it on is confirmed with the person's passkey when they have one: the appliance's
  challenge is `SHA-256(canonicalJson({purpose, nonce, endpoint, level, duration}))`, and the client recomputes it
  before anything is signed (`packages/client/src/managed/remote-help.ts`, `remoteHelpPasskeyOptions`). Without a
  passkey a dialog confirms it. Stop never asks.
- **How support gets in.** While a grant is active, a separate root service on the appliance (`whombat-support`) dials
  the relay as a worker for the device's support route; nothing listens on the network. SSH runs end to end inside the
  relay's frames. The appliance checks three things: an OpenSSH user certificate signed by the Whombat support CA
  pinned in its image for its environment (development keys never open customer appliances), with the device's id as
  principal and valid now; an active grant whose level allows what is asked; and, on customer images, the help code the
  person sees, as the SSH user name (five wrong codes end the grant). Control can issue certificates but can't make a
  grant; the relay can do neither. A grant ends at its time, at Stop, or after the wrong codes, and closes every
  connection.
- **What the person sees.** Every visit is recorded on the appliance: each Look command and its arguments, each Fix
  command line, the output of command-line sessions, restarts, forwarded connections with their target and size, and
  refusals. Typed input is not recorded. Records stay on the appliance for 90 days (at most 500 MB) and only the person reads
  them. They get a notification and a message from their assistant when a visit starts, and turning on, stopping,
  expiry and each visit are signed appliance events (`remote_help.on`, `remote_help.off`, `remote_help.visit`).
- **What this means.** *Look and fix* is root on the appliance: during such a visit support could read everything on
  it, as a signed update could (section 5.2). The protection is that it exists only while the person allows it, is
  recorded on the appliance and can be stopped at once. You can't verify the support service from this source.
- **Diagnostics.** The person can create a diagnostics bundle on the appliance, preview its exact contents, download
  it over the encrypted session and send it to support. Nothing is uploaded automatically.
- **Backups** go to a restic server the customer runs, in append-only mode, encrypted with a repository password
  generated on the appliance. The password goes into the person's recovery kit over the encrypted session. The cloud
  service also keeps a copy of those backup details sealed with a key from the person's passkey, so a new appliance can
  bring the backups back with one touch; the cloud service can't open it without the passkey. A page served from
  Whombat's web origin sees that key when the passkey is used there (section 6), so this copy is only as safe as that
  page. Backups include the provider credentials, so their confidentiality rests on that password.

## 6. Delivering the web client

The managed web app is served from Whombat's web origin. **Whoever controls what that origin serves can ship
JavaScript that reads everything you see in the browser, and can sign with your browser's endpoint key while the
page is open.** End-to-end encryption doesn't protect against this.

The appliance also serves the same web build itself, on its direct ways (section 8). That build comes with the
appliance's signed update. It is served only over HTTPS (its own address, its Tailscale name), so it reaches the
browser as it left the appliance.

**Hardening in place for the hosted build** (`apps/web/hosted.ts`): a Content-Security-Policy as meta tag and
header (`default-src 'none'`; scripts, styles and fonts from the app's own origin only; `connect-src` limited to
the cloud service and the relay; no inline script or `eval`, no frames, objects or form posts; `frame-ancestors
'none'`), `no-referrer`, HSTS and other security headers, and self-served fonts. The `hosted` Playwright project
(`apps/web/e2e-managed/hosted.spec.ts`) runs claim, chat and canvas on that build and asserts there are no CSP
violations and no third-party requests. The CSP limits what injected third-party code could do. It is no defence
against the operator, who serves the policy too.

**What a user can verify today, and what's missing**
- **Service worker:** `apps/web/public/sw.js` only shows notifications. It has no `fetch` handler, so it neither
  caches nor pins the app: every page load runs what the origin serves at that moment.
- **No integrity checks:** no Subresource Integrity, no signed web bundle.
- **The deterministic archive doesn't cover the hosted build.** `docs/app/publishing.md` describes a deterministic
  archive (sorted ustar, fixed mtimes and owners, fixed gzip header) with `SHA256SUMS` and `RELEASE.json`. It
  covers the page the appliance serves itself and the operator panel only, not the hosted build
  (`pnpm build:web:hosted`).
- **No published hashes** of either build yet.
- **Rebuilding isn't confirmed to match.** Vite names assets by content hash, so you can rebuild a tagged commit
  and compare files with what is served. But the hosted build embeds environment values (the cloud service URL and
  relay origins), and nobody has confirmed that builds on different machines produce identical output.

Planned but not implemented: published hashes for each hosted release, a reproducible-build check, and a way to
compare the running bundle against them.

**Phone app:** builds are signed by Whombat. There's no over-the-air code update mechanism (no `expo-updates` in
`apps/mobile/package.json`), so the app's code changes only when you install a new build. Builds are not
reproducible and no hashes are published. The iOS app is in testing through TestFlight.

## 7. Third parties and telemetry

No client package depends on an analytics, crash-reporting, session-replay or tracking SDK; check the
`package.json` files. The clients send no telemetry to Whombat or anyone else.

| Party | When | What it sees |
|---|---|---|
| Your browser's push service (e.g. Google, Mozilla, Apple) | only if you turn on browser notifications for a managed appliance | your subscription endpoint and when a push arrives. The payload is Web Push-encrypted: the preview (who wrote and where, the start of the message), or “Whombat” when previews are off, a kind such as `message` or `approval`, an opaque 128-bit reference (`packages/protocol/src/session/common.ts`, `pushRefFor`) and an opaque tag. |
| Google Firebase Cloud Messaging | Android app, if notifications are allowed | the device token, and each push's timing, preview (who wrote and where, the start of the message; none when previews are off), kind, opaque reference and opaque tag. These are not end-to-end encrypted. The Firebase Messaging SDK (`apps/mobile/modules/whombat-live`) talks to Google to register. We haven't audited what that SDK reports on its own. |
| Apple Push Notification service | iOS app, if notifications are allowed | the same as FCM |
| Anthropic, OpenAI | when your appliance runs agents on them; when you open their sign-in page | what the appliance sends them. Sign-in pages open in your browser, directly with the provider. |
| Google (your organization's own OAuth app) | when you connect your Google account to your personal assistant | Google's consent page, directly with Google. On a managed appliance Google then sends your browser to the hosted UI's `/connect/google` with a one-time authorization code; the page takes it off the address bar at once and sends it only to your appliance, over the end-to-end session (`apps/web/src/managed/ManagedRoot.tsx`, `GoogleReturnFlow`). The code is useless without the verifier and client secret the appliance keeps, but the hosting provider receives that one request, query string included, so the hosting must not log query strings. The tokens stay on the appliance. |
| Email provider | sign-in links | email address |
| Hosting provider **[closed]** | the cloud service and relay | what those services see (section 4) |

The phone app uses no Expo cloud service at runtime. Its push token is the native FCM/APNs token, not an Expo push
token.

## 8. The direct ways and the Feedback widget

**The direct ways.** The appliance listens on one port on its local-network addresses and its Tailscale name, and
admits a client from the key the Noise handshake proves (an enrolled device's key; an unknown key may only enrol).
No ticket from Whombat's cloud is involved, so Whombat's servers see nothing of a direct connection. The appliance
tells enrolled devices its direct addresses in every session; the apps keep them with the appliance's record
(`apps/server/src/managed/direct/`, `docs/decisions/direct-connection.md`).

**No page over plain HTTP** (`docs/decisions/direct-connection.md` DC-20). A browser that comes to the appliance over
plain HTTP, on the local network or a Tailscale address, gets one sentence naming its HTTPS addresses and no app code,
so no page can be changed on the way and no browser keeps a device key script can read. The appliance's identity
answer (`GET /v1/direct`), the apps' Noise WebSocket and picture uploads stay on plain HTTP: each carries its own
trust (the PeerId pinned, the handshake). The phone app connects directly with its own code and its own key store.
A software key an older release's plain-HTTP page made is never used: the page asks the person to forget this browser
and set it up again (`weakKey`, tested in `keys.test.ts`).

**Feedback widget** (`apps/widget`). It runs on third-party websites. It sends the page URL (without query or fragment, id-like path segments redacted), the page title, a coarse browser
name, language, viewport size and time zone, values the integrating site passes explicitly, and what the person
types: an optional name and email, and screenshots they choose. It never reads cookies, storage, form contents or
the DOM (`apps/widget/src/loader/loader.ts`, `collectContext`).

## 9. Known limitations and what is out of scope

- A malicious or compromised hosted web origin, appliance update or AI client update defeats end-to-end
  encryption. See sections 5 and 6.
- While the person allows remote help at *Look and fix*, Whombat support has root on the appliance (section 5.3).
- Appliance identity pins stored before the pinning rule (`legacy`) are kept, and a version 1 recovery kit relies on
  the device's existing pin (section 3.6).
- The relay and cloud service see metadata: who connects to which appliance and when, message sizes and timing,
  IP addresses while connected (not stored by the cloud service), organization membership, appliance health and
  licence renewals, and push timing and kind. There is no padding or cover
  traffic.
- Data on client devices is protected only by the platform. The web app keeps the cloud session token, the
  appliance list (metadata), drafts and a pending claim card (up to an hour) in `localStorage`; the phone app keeps
  downloaded attachments in its cache directory. XSS on the web origin could use (not extract) the endpoint key and
  could read the cloud session token.
- Revocation can't erase copies already saved, or data on offline or modified clients.
- Deleting a cloud account doesn't remove the person's account on an appliance (the data stays on the box).
- Not yet in place: production update signing keys, hardware qualification of disk encryption, reproducible and
  published builds, an iOS app, a public audit of `@libp2p/noise`.
- Out of scope: what AI providers, GitHub or other services you connect do with data you send them; the
  security of your own devices and network; physical attacks on hardware you don't own.

## 10. Reporting vulnerabilities

See `SECURITY.md` (security@whombat.com). Please also report any place where the code doesn't do what this
document says.
