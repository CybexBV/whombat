# Whombat privacy and security model

This document is for people who want to check how Whombat handles their data. It covers the clients in this
repository (web app, phone apps, Feedback widget, client session layer), the protocol library they use (the
contracts), the appliance (its runtime, operating system, manager, update helper and support service) and the hosts
service that watches the servers you add. It says what is encrypted end to end, what Whombat's own servers can see,
and what reading this source can't tell you.

It describes the current release of the apps, the contracts and the appliance; when one of them changes how it
handles data, this document changes in the same commit.
Where this document says something is "planned" or "not in place", it means exactly that.

**How to read it.** This repository holds the appliance's runtime (`apps/server`, `apps/runner`, `apps/agent-net`,
`packages/agent-runtime`), its operating system, manager, update helper and support service (`appliance/`), the hosts
service (`hosts/`), the apps and the contracts. Paths in backticks are relative to it. Whombat's cloud services are
not: the control service (control: accounts, Whombat Link, billing and push delivery), the relay with its door, and
the admin site. Statements about them are marked **[closed]** and describe their design and code as the
Whombat team reviewed them. You can't verify those statements from this repository's source. They are here so the
boundaries are clear.

## 1. Components and who runs them

The customer's data lives on a Whombat appliance at the customer's premises. Clients reach it over one end-to-end
encrypted channel (Noise XX, the appliance's identity pinned), carried one of these ways: straight to the appliance on
the local network or on the customer's Tailscale network, or, with Whombat Link, through Whombat's relay. Clients try
the direct ways first; the relay sees only ciphertext either way. A browser loads the app only from a page the
appliance serves itself over HTTPS: at its own address (`<name>.whombat.app`, or `<label>.box.whombat.app` for an
appliance that hasn't moved yet, which the relay's door passes through to the appliance, with TLS ending there) or at
its Tailscale name. Over plain HTTP it serves no page, only a sentence
naming those addresses (section 8).

| Component | Runs where | Operated by | Source | Sees content? |
|---|---|---|---|---|
| Web app (`apps/web`) | the user's browser: served by the appliance itself (its own address, its Tailscale name); the account site from Whombat's web origin (`app.whombat.com`) | whoever serves it | public | yes, decrypted locally |
| Phone apps (`apps/mobile`, Android and iPhone) | the user's phone | Whombat builds and signs them | public | yes, decrypted locally |
| Client session layer (`packages/client`) | inside both apps | — | public | — |
| Protocol and crypto library (the contracts: `packages/`, `contracts/`) | clients, appliance, relay, cloud service | — | public | — |
| Appliance runtime (server, runner, agent network, database) | customer premises | customer owns it; **Whombat ships its software updates** | public | **yes, plaintext** |
| Appliance operating system (NixOS), manager, update helper, support service (`appliance/`) | customer premises | customer owns it; **Whombat ships its software updates** | public | **yes, plaintext** |
| Hosts service (`hosts/`): the hub on the appliance, an agent on each server you add | customer premises | customer owns it; **Whombat ships the hub and signs the agents** | public | yes, what it reads on those servers |
| Cloud control service (control) and the admin site | Whombat's servers | Whombat | closed | no, metadata only |
| Relay, with the door to each appliance's own address | Whombat's servers | Whombat | closed | no, ciphertext and metadata |
| Update repository (TUF) and the AI client channel | metadata at `releases.whombat.com`, files on GitHub Releases | Whombat | metadata public; tools in `appliance/release-tools/` | no (it distributes signed software) |

Trust boundaries:

- **Endpoint ↔ appliance.** Both ends are trusted, and so is the code they run.
- **Relay.** Not trusted with content. It is trusted for availability only.
- **Cloud service.** Not trusted with content or with local authorization, and not trusted for the appliance's
  identity: the clients pin that from the claim, a recovery kit, the appliance's own page or a link made by an
  enrolled device (section 3.4). An appliance without Whombat Link never contacts it. For one with Link it is trusted
  for the account's sign-in, relay admission, the appliance's own address (its label and the door's routing), phone
  push delivery and remote help certificates. It has no part in updates.
- **Web origin, update signing and app signing.** These are trusted suppliers. Sections 5 and 6 explain what that
  means.

## 2. Summary

- Traffic between a client and its appliance is end-to-end encrypted with Noise XX. The appliance's identity key
  is pinned, and each device has its own key. The relay forwards opaque bytes.
- An appliance sends the cloud service nothing unless its person turns on Whombat Link. The cloud service never
  receives message content, files, prompts or AI output, except a phone notification's short preview (who wrote,
  where, the start of the message), which it passes to Apple or Google without storing it and which each person can
  turn off (Settings → Notifications, “Show message text in notifications”), what it keeps sealed with keys it
  doesn't have (shared links, backup details), and the reports a person sends the Whombat Team, which the team reads
  (the form says so; team-reports.md). It holds account data, each linked appliance's Link state and address,
  update progress, remote help's state, push tokens, and request logs without IP addresses (kept 14 days). A
  signed-in person can delete their cloud account.
- The appliance holds everything in plaintext, because it is the customer's server, and a self-installed appliance
  doesn't encrypt its disks. Whombat signs and ships the appliance's software updates, today with one online key per
  channel (section 5.2). A malicious or compelled update could read that data. Auditing the clients cannot rule this
  out.
- The web app comes from the appliance itself, with its signed update. Whombat's web origin serves the account site
  and a few pages at fixed addresses (section 6); a malicious bundle there could read what those pages show. There is
  no published hash of either build yet, and no tooling to check it.
- Whombat support can get into an appliance only while Whombat Link is on and its person has turned on remote help,
  for the time and at the level they chose; the appliance records what support does and the person can stop it
  (section 5.3).
- The clients have no analytics, crash reporting or session replay.

## 3. End-to-end encryption (managed mode)

### 3.1 The channel

Clients reach their appliance through the relay, or directly: the appliance listens on one port (4480) on its
local-network addresses and its Tailscale name, and the same Noise session runs over a WebSocket there
(`apps/server/src/managed/direct/`; section 8). With Whombat Link the appliance keeps outbound WebSockets open to the
relay; a page at its own address runs the same Noise session inside the TLS connection the door passes through.
The layers are:

```
session frames: [u32 len][u8 type][u32 stream][payload]    packages/protocol/src/frame.ts, session/
Noise records inside Noise_XX_25519_ChaChaPoly_SHA256       packages/secure-channel/src/
relay WebSocket (TLS to the relay; the relay splices)       packages/protocol/src/relay.ts
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
| Appliance content identity (the PeerId clients pin) | on the appliance | a 0600 root file on its data volume, which a self-installed appliance doesn't encrypt (section 5.1); the runtime gets it as a systemd credential | `appliance/nix/modules/persist.nix` |
| Admission ticket signing key | cloud service | cloud service secrets **[closed]**. It can admit relay connections, not sessions. | — |

"Forget this browser/phone" deletes the endpoint key. Every appliance then treats the device as new.

### 3.3 Claiming an appliance (CPace)

A Whombat is one person's device. That person claims a new appliance with the four letters on its screen, on a page
the appliance serves or in the phone app on its local network. The cloud service takes no part: a claim through it or
through the relay is refused (`docs/decisions/own-address.md`).

1. The client opens an enrollment session with the appliance: at its own address with the claim link its screen shows,
   on its Tailscale page, or in the phone app at the local-network address its screen names. It takes the PeerId the
   appliance names there (`GET /v1/direct`).
2. Inside that session the client and appliance run **CPace** (`CPACE-RISTR255-SHA512`, draft-irtf-cfrg-cpace-21).
   The password is the letters. The channel identifier includes both Noise static keys, and the session id is the
   appliance's claim id. Confirmation tags are checked in both directions.
3. The proofs come first: the appliance checks the client's tag and answers its own, and only if that verifies does
   the client send the person's name and email, pin the PeerId and create the recovery kit. Something posing as the
   appliance (on plain HTTP on the local network, anyone can) can't produce that tag without knowing the letters, and
   it gets one online guess per attempt.

A wrong guess rotates the letters; after 3 failures in 24 hours the appliance backs off from 1 to 60 minutes. The
person at the appliance can ask its screen for new letters, which stay ten minutes whatever others try (at most five
wrong tries, two per device). See `apps/server/src/managed/claim.ts`, `trust.ts` and
`packages/protocol/src/claim/attempts.ts`.
An appliance the cloud service registered before Whombat Link is claimed through the cloud service, with the same
letters or a claim card, CPace in the same way, and the cloud service comparing keyed hashes of the two network
prefixes (section 4.1); the cloud service never receives the letters or the card secret.

Where to look: `packages/protocol/src/claim/` (`local.ts`, `cpace.ts`, `pake.ts`, `attempts.ts`),
`contracts/go/protocol/cpace.go`, `contracts/go/protocol/claimpake.go`, `contracts/vectors/cpace.json`,
`contracts/vectors/claim.json`; the client ceremony in `packages/client/src/managed/claim.ts`.

### 3.4 Adding and removing devices

Signing into a cloud account never gives access to an appliance. An endpoint key has to be enrolled on the
appliance itself, in one of these ways:

- **Pairing.** The new device shows a code and the fingerprint of its own key. An enrolled device looks the code
  up, compares the fingerprint and approves (`packages/client/src/managed/pairing.ts`). It is off at an appliance's own
  address, and on every appliance that had its own address from its first start: a code shown on the new device
  proves nothing about the page that shows it.
- **Recovery kit.** A signature by the recovery key enrolls a device into the person's account.
- **Device link.** An enrolled device makes a five-minute, one-time link (or its QR code) whose secret is in the
  fragment; opening it on the new device lets it in to the same account (`community.ts`).
- **The box's screen.** The box shows six letters for this device; CPace over them, bound to both Noise keys, lets it
  in to the person's account (`screen-signin.ts`).
- **A passkey.** A passkey the person made for this appliance; the appliance verifies it itself
  (`apps/server/src/managed/passkeys.ts`, `box-passkeys.ts`).

There are no invites and no re-enrollment by someone else: nobody else uses the appliance.

These comparisons authenticate the **new device to the appliance**, not the appliance to the new device. So before a
device connects anywhere, it has to know the appliance's identity (its PeerId) from a party that already trusts the
appliance. The cloud directory lists every appliance it knows with its PeerId, but the clients never take the pin
from it (`packages/client/src/managed/pin.ts`, `registry.ts`). Each way in gets the pin like this:

| How the device gets in | Where the pin comes from |
|---|---|
| Claim | the claim ceremony, only after the appliance's CPace confirmation verifies (section 3.3) |
| Passkey | the Whombat the passkey names in its user handle, in a signed list the client verifies before pinning |
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
offline or modified client. The appliance reports an opaque revocation reference to the cloud service.

### 3.5 Where an auditor should start

| Question | Clients | Contracts and the appliance |
|---|---|---|
| Handshake, identity checks, record layer, flow control | `packages/client/src/session/secure.ts`, `secure-channel.ts` (the port) | `packages/secure-channel/src/`, its `test/` (tamper, replay, identity) |
| Ticket, relay dial, pin check before any byte | `packages/client/src/session/connector.ts` | `packages/protocol/src/relay.ts`, `admission.ts` |
| Session messages, operations and enrollment | `packages/client/src/session/`, `packages/client/src/managed/` | `packages/protocol/src/session/`, `docs/contracts/session-protocol.md` |
| Everything the clients send to the cloud service | `packages/client/src/managed/control.ts` | `packages/control-contracts/src/` (`auth.ts`, `orgs.ts`, `directory.ts`, `push.ts`) |
| What an appliance may report to the cloud service | — | `packages/control-contracts/src/device/` (`ops.ts`, `link.ts`, `status.ts`, `push.ts`, `share.ts`, `envelope.ts`) |
| Update metadata the appliance verifies | — | `packages/release/src/` (`tuple.ts`, `channel.ts`, `signed.ts`, `clients.ts`); the Go verifier in `appliance/helper/pkg/trust/` |
| The image, manager, update helper and support service | — | `appliance/` (`nix/`, `manager/`, `helper/`, `support/`) |
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
  - **The claim** pins the PeerId it was given only after CPace confirms that the box holding it knows the letters
    on the screen (or the card). An attacker would need those too.
- **Pairing** is protected by its fingerprint comparison, if you actually compare. Look at the enrolled devices in
  Settings → Devices now and then.

## 4. What the cloud service and relay can see

### 4.1 Cloud control service [closed]

It stores identity, organization, directory, routing and update metadata. It has no endpoint that carries
workspace content in the clear. An appliance talks to it only while Whombat Link is on: one that never turns Link on
never contacts it, and one whose person turns Link off sends it nothing more (`appliance/manager/internal/daemon/`,
`link.go`, `status.go`). The client side of every call is in `packages/client/src/managed/control.ts`; what an
appliance may send is in `packages/control-contracts/src/device/`.

| Data | Details | Kept |
|---|---|---|
| Cloud account | email address, sign-in sessions (hash of the token, created, expires, last seen, revoked; no IP or user agent), passkeys if used, a pseudonymous relay subject id | until you delete the account (below) |
| Magic links | email address, token hash, times | 1 day after expiry |
| Organizations | the billing record of an account: name, its one account, the Stripe customer, entitlement (plan, subscription state, limits) | deleted with its account |
| Appliance directory | from the appliance's registration when Link starts: device id, route id, hardware serial, model, management public key, content PeerId; owning org, display name, claim and registration times, last seen | retired, not deleted |
| Whombat Link | per appliance: whether its person wants Link, the name the appliance gave, the account that confirmed it, when it began, was confirmed or left; its own address's label (never reused); the one-time code it shows while Link starts (15 minutes) | kept |
| Claims (appliances it registered before Whombat Link) | device, org, account, method, state, times; a verifier of the card secret; the version of the appliance terms accepted and when | kept (the account is removed from it when it is deleted) |
| Network tags (unclaimed appliances it registered before Whombat Link) | `HMAC(key, IPv4 address or IPv6 /64)` of the appliance's and the claimant's network, used to find a box on your network. Never the address itself. | erased at claim or retirement |
| Remote help's state | off, Look or Look and fix, seconds left, how many are connected, whether a help code is needed and the support service's SSH host public key. The schema is strict: `packages/control-contracts/src/device/status.ts` (`SupportReport`) | the latest one per appliance |
| Update progress | per appliance and release: state, attempts, failure code, times | kept |
| Shared links | a sealed copy of part of a Chat thread, its expiry and how often it was opened. The key is in the link's fragment, which the cloud service never receives (`packages/control-contracts/src/device/share.ts`). | until the link expires or the appliance stops it |
| Backup details | the appliance's backup details, sealed with a key from the person's passkey (section 5.3) | until the passkey is removed or the appliance leaves the account |
| Push | the phone tokens a linked appliance registered, each usable only by that appliance; tokens a signed-in account registered. Per delivery: handle, appliance, kind, result, time. | an appliance's tokens until removed or 90 days unused, an account's until removed; deliveries 14 days |
| Revocations | appliance, opaque reference, kind, state, times | kept |
| Audit log | actor (a pseudonymous account id), org, action, target, small structured details. Control writes no emails or IP addresses into it. Each remote help certificate control issues is recorded here and in the organization's log (“Whombat support”): device, the name shown to the person, level, serial and validity. | 400 days |
| Rate-limit counters | keyed by hashed email, by account id (tickets), or by a keyed hash of the caller's network (the IPv4 address or the IPv6 /64, with a key used only for this), never the address itself | 2 days |

**What it learns as it works.** It issues every connection's ticket, so at that moment it knows which account
asked to reach which appliance, on which channel. Tickets are not stored, and the request log doesn't record who
asked (below). Your IP address is used only in memory, to derive the keyed values above. From push deliveries it
learns when an appliance wanted to notify someone, and of which kind; while it sends a notification it also holds its
preview (at most 80 code points of title and 160 of text, plain text), which it neither stores nor logs. From remote
help's state, which a linked appliance sends regularly, it learns that the appliance is running.

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
Export anything you want to keep first. The web app (Your Whombats → Delete account) and the phone app offer it.
Afterwards the app forgets that account's list of Whombats and their pinned identities on the device. The device's
endpoint key stays: it belongs to the browser or phone, not to the cloud account, and it stays enrolled on the
appliance until you remove the device there (Settings → This Whombat → Devices).

**Email.** Magic-link emails go out through an SMTP provider. Sign-in tokens travel in the URL fragment, so they never
reach server logs.

### 4.2 Relay [closed]

The relay pairs a client WebSocket with a data connection from the appliance and forwards binary messages
unchanged. It never parses them.

**What it sees while a connection is open:** both ends' IP addresses; the ticket's contents (pseudonymous relay
subject, organization id, appliance route id, channel, ticket id, the appliance's own-address label); the browser's
`Origin` header; connection times; and the size, direction and timing of every message.

**The door to each appliance's own address.** A browser's TLS connection to `<name>.whombat.app` (or
`<label>.box.whombat.app`, and the old address for 30 days after a change) reaches the relay, which passes it unopened
to the appliance by its name. TLS ends on the appliance, whose certificate key never leaves it. The door sees the
visitor's IP address, the host name and the size and timing of the traffic. Whombat runs the DNS for `whombat.app`, so
it could get a certificate for an appliance's name; the appliance watches Certificate Transparency logs and warns its
person about any certificate it didn't make itself (`docs/decisions/own-address.md`). Cloudflare, which runs
`whombat.app`'s DNS, holds two certificates for `*.whombat.app` until 16 February 2027 (issued before the zone was
used for appliances); the appliance knows them, doesn't call them foreign, and says so under its address.

**What reaches the appliance:** only that a session is waiting, and its class (`packages/protocol/src/relay.ts`,
`RelayIncoming`). The relay doesn't pass on the client's IP address or cloud identity.

**What it keeps:** no database; routes, single-use ticket ids (until they expire) and rate limiters live in memory.
By design it doesn't log tickets, subjects, organizations, appliance ids, IP addresses or payloads at its normal log
level, and its metrics carry no identifiers. The host's journal keeps 14 days. It reports nothing to
the cloud service; it only fetches the ticket verification keys.

## 5. The appliance, and the updates Whombat ships to it

### 5.1 What it holds

The appliance is the customer's server. It holds workspace data in plaintext: the database (messages, runs,
memory, audit, accounts with their email addresses), files and repositories, connector tokens, what the hosts service
collects from your servers, and the AI provider credentials described below. Its disks are not encrypted (below).

**Disk encryption.** A self-installed appliance, the only kind shipping today, does **not** encrypt its disks: the
system and the data volume are plain ext4 and btrfs, with no TPM and no disk recovery key
(`appliance/nix/modules/storage.nix`). Anyone who holds the disk, or the host a virtual appliance runs on, can read
everything on it. Encrypt the machine's disk or the VM's storage underneath, and keep the box somewhere you trust.
Appliances Whombat sets up itself are designed to use LUKS2 with a TPM2-sealed key bound to measured boot, plus a
printed disk recovery key; they don't ship yet.

**AI providers.** People connect their own Claude or ChatGPT subscription, an API key, an AI gateway or a model on
their network. The agent (Hermes Agent) runs on the appliance and keeps the credentials there. Claude's sign-in runs
`claude auth login` in a terminal on the appliance, which the client shows through the encrypted session: you open
the claude.ai link in your browser and paste the code back. ChatGPT uses a device code you enter at OpenAI. The client
never logs or caches that terminal's output or your keystrokes (`packages/client/src/signins/console.ts`). The
appliance sends prompts and workspace context to the provider you chose, which sees what it is sent.

**The Vault.** Passwords, API keys and SSH keys the person saves are sealed in the appliance's database and unsealed
only for a turn that may use them (`apps/server/src/agent-commands/keys.ts`). What that means in practice:

- A turn started by an outsider (mail, a website's feedback, a message from someone else) gets no Vault secrets at
  all.
- In the person's own turns, the commands the agent runs get the keys the person switched on for that agent, as files
  or environment variables. Such a command can read those values, and so can the agent through it: the Vault limits
  which keys a turn holds, it can't hide a key from a command that uses it.
- Saved website logins are filled into the page by the browser host; the password doesn't go to the AI model, and
  filled fields are blanked in screenshots (`docs/decisions/browser.md`).
- Every value the agent holds is replaced with `[secret]` in whatever it writes (messages, replies, plans, run notes
  and the activity of its turns), also in its URL, JSON and base64 forms, before it is stored or shown
  (`apps/server/src/agent-commands/secrets.ts`). Values shorter than six characters aren't looked for.

### 5.2 Updates

**Signing and delivery.** The appliance's software (the agent included) comes from Whombat's update repository,
which uses TUF (The Update Framework); the Claude Code binary comes from Anthropic's own download site, at the version,
size and SHA-256 the repository's signed client channel names. Its signed metadata is public at
`releases.whombat.com`; its files are release assets on GitHub. Each appliance follows one channel: Production, or
Beta when its person picks it (Settings → This Whombat → About), and installs that channel's newest release. Nobody
chooses a release for one appliance. On the appliance, both the manager and a separate root helper verify the TUF
metadata, the channel's role and every file's hash (`appliance/helper/pkg/trust/`). Downgrades are refused unless the
signed release allows them, and a failed update rolls back. Every release goes to Beta first; the same release, byte
for byte, reaches Production only when a maintainer promotes it. Within a channel there is no staged rollout.

**Who can sign an update today.** The repository's root role has three keys, kept offline; any two of them sign a new
root (`appliance/manifest/prod/tuf-root.json`, which the image pins). The top-level targets key, which names the key
of each channel, is offline too. Each channel (Production, Beta, and the AI client channel) is signed by **one
online key**, which Whombat's maintainers keep on their publishing machine; the Production key also has an offline
copy. The snapshot and timestamp keys are secrets of the repository's GitHub workflow, which signs them again every
6 hours with a 3-day expiry. So one channel key, with the right to publish to the repository, is enough to ship a
release that every appliance on that channel installs. GitHub alone can delay or withhold updates but can't approve
software, and changing a channel's key takes the offline keys. A production appliance refuses a root that needs fewer
than two keys once it has trusted one that needs two.

**Server agents.** The agents on the servers you add update from your appliance (on by default: Settings → This
Whombat → About, “Keep server agents up to date”) and accept only builds signed with Whombat's agent-signing key, one
key the maintainers keep online. A compromised appliance can push only genuine Whombat agents.

**Ask before updating.** Updates install by themselves unless an owner turns on *Ask before updating*
(Settings → This Whombat → About). Then every update downloads and is checked as usual, and waits until an owner
presses Update now for that exact release; a newer release needs its own yes. The box's manager keeps the setting and
enforces it, so no release we sign gets past it. Going back to the release that
ran before, after an update failed its checks, doesn't wait. The owner's choice and each approval are signed
appliance events (`update.ask_set`, `update.approved`). When the apps can't take the owner's yes, the recovery menu at
the box (hold Space at power-on) turns the switch off. It protects only against an update arriving unannounced: once
approved, a malicious release can do everything described next.

**What a malicious or compelled update could do.** A signed appliance release runs as root on a machine whose
volumes are unlocked. It could read and exfiltrate every piece of data on the appliance, including the AI provider
credentials. A malicious Claude Code binary pushed through the client channel could do the same with the workspaces
and credentials it can reach. **The end-to-end encryption in sections 3 and 4 does not protect
against this, and auditing the clients cannot rule it out.**

**Mitigations designed, and their status**

| Mitigation | Status |
|---|---|
| Offline threshold root: 2-of-3 keys; an offline top-level targets key | in place: root version 4 in `appliance/manifest/prod/tuf-root.json` |
| Threshold signing of releases | **not in place**: one online key per channel (above) |
| Separation between the update signers and the cloud service | in place: the cloud service holds no update key and has no part in choosing updates |
| The client channel (Claude Code) | signed by one online key limited to those files. The box downloads the unmodified binary from Anthropic's site and installs it only when it matches the SHA-256 Whombat recorded. Upstream vendor signatures are not checked. |
| Beta before Production | in place; emergency stop (pause/resume) per channel in its signed TUF role metadata, no staged rollout |
| Reproducible appliance builds | partial: the contracts npm packages rebuild byte for byte; other artifacts are not verified |
| Customer approval of each update | in place, off by default (*Ask before updating*, above) |
| Transparency log, signed build attestations | **not in place** |

### 5.3 Vendor access, diagnostics and backups

- **No standing vendor login; remote help only while its person allows it.** The appliance has no SSH daemon listening
  on any network and no support account. While Whombat Link is on, the person can turn on remote help (Settings → This
  Whombat → About) for 1 hour, 1 day or 1 week (and “Forever” only on test images; the support service on the box
  decides), at one of two levels:
  *Look* (a fixed list of read-only commands as an unprivileged user: status, logs, hardware, network and the like; no
  shell, no forwarding) or *Look and fix* (also a root command line, restarts and connections to the box's own local
  ports and sockets). Turning it on is confirmed with the person's passkey when they have one: the appliance's
  challenge is `SHA-256(canonicalJson({purpose, nonce, endpoint, level, duration}))`, and the client recomputes it
  before anything is signed (`packages/client/src/managed/remote-help.ts`, `remoteHelpPasskeyOptions`). Without a
  passkey a dialog confirms it. Stop never asks.
- **How support gets in.** While a grant is active, a separate root service on the appliance (`whombat-support`) dials
  the relay as a worker for the device's support route; nothing listens on the network. SSH runs end to end inside the
  relay's frames. The appliance checks three things: an OpenSSH user certificate signed by the Whombat support CA
  pinned in its image for its environment (`appliance/manifest/prod/support-ca.pub`; development keys never open
  customer appliances), with the device's id as principal and valid now; an active grant whose level allows what is
  asked; and, on customer images, the help code the person sees, as the SSH user name (five wrong codes end the
  grant). Control can issue certificates but can't make a
  grant; the relay can do neither. A grant ends at its time, at Stop, or after the wrong codes, and closes every
  connection.
- **What the person sees.** Every visit is recorded on the appliance: each Look command and its arguments, each Fix
  command line, the output of command-line sessions, restarts, forwarded connections with their target and size, and
  refusals. Typed input is not recorded. Records stay on the appliance for 90 days (at most 500 MB) and only the person reads
  them. Their assistant tells them in Chat when a visit starts (once per visitor in 12 hours), and turning on,
  stopping, expiry and each visit are signed appliance events (`remote_help.on`, `remote_help.off`,
  `remote_help.visit`).
- **What this means.** *Look and fix* is root on the appliance: during such a visit support could read everything on
  it, as a signed update could (section 5.2). The protection is that it exists only while the person allows it, is
  recorded on the appliance and can be stopped at once. The support service is in `appliance/support/`.
- **Diagnostics.** The person can create a diagnostics bundle on the appliance, preview its exact contents, download
  it over the encrypted session and send it to support. Nothing is uploaded automatically.
- **Backups** go where the person chooses: a NAS or server that keeps them append-only, a bucket, SFTP or a USB disk.
  restic encrypts them with a repository password generated on the appliance. The appliance seals those backup
  details with a key from the person's passkey and keeps the sealed copy next to the backups and, while Whombat Link
  is on, at the cloud service, so a new appliance can bring the backups back with one touch; neither can open it
  without the passkey. A paper copy is optional. A passkey made at the appliance's own address works only on pages
  the appliance serves; one made at Whombat's web origin is used there (section 6), so a copy sealed with it is only as
  safe as that page. Backups include the provider credentials, so their confidentiality rests on that password.

## 6. Delivering the web client

The web app people use is served by the appliance itself, only over HTTPS: at its own address or its Tailscale name
(section 8). That build comes with the appliance's signed update, so it is exactly as trustworthy as the update
(section 5.2), and it reaches the browser as it left the appliance (the door at the own address can't open it;
section 4.2).

Whombat's web origin (`app.whombat.com`) serves the account site: sign-in, Whombat Link and its subscription, the
list of your Whombats, and pages that must sit at one fixed address: remote help's passkey step-up, the viewer of
shared links, and the return from some sign-ins (section 7). Accounts made before Whombat Link also open their
Whombats there. **Whoever controls what that origin serves can ship JavaScript that reads everything those pages
show (a shared link's thread, for one), and can sign with the endpoint key your browser keeps for that origin while
such a page is open.** End-to-end encryption doesn't protect against this.

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
  covers only the page the appliance serves itself, not the hosted build (`pnpm build:web:hosted`).
- **No published hashes** of either build yet.
- **Rebuilding isn't confirmed to match.** Vite names assets by content hash, so you can rebuild a tagged commit
  and compare files with what is served. But the hosted build embeds environment values (the cloud service URL and
  relay origins), and nobody has confirmed that builds on different machines produce identical output.

Planned but not implemented: published hashes for each hosted release, a reproducible-build check, and a way to
compare the running bundle against them.

**Phone apps:** builds are signed by Whombat: the Android app comes from Whombat's download site, the iPhone app is
in testing through TestFlight. There's no over-the-air code update mechanism (no `expo-updates` in
`apps/mobile/package.json`), so the app's code changes only when you install a new build. Builds are not
reproducible and no hashes are published.

## 7. Third parties and telemetry

No client package depends on an analytics, crash-reporting, session-replay or tracking SDK; check the
`package.json` files. The clients send no telemetry to Whombat or anyone else.

| Party | When | What it sees |
|---|---|---|
| Your browser's push service (e.g. Google, Mozilla, Apple) | only if you turn on browser notifications on your appliance's page | your subscription endpoint, and when and how large each push is. The appliance sends it itself, signed with its own Web Push key (no Whombat server is involved), and the notification inside (its title, text and link) is Web Push-encrypted to your browser (`apps/server/src/push/webpush.ts`). |
| Google Firebase Cloud Messaging | Android app, if notifications are allowed and Whombat Link is on | the device token, and each push's timing, preview (who wrote and where, the start of the message; none when previews are off), kind, opaque reference (`packages/protocol/src/session/common.ts`, `pushRefFor`) and opaque tag. The appliance hands these to the cloud service, which sends them; they are not end-to-end encrypted. The Firebase Messaging SDK (`apps/mobile/modules/whombat-live`) talks to Google to register. We haven't audited what that SDK reports on its own. |
| Apple Push Notification service | iPhone app, if notifications are allowed and Whombat Link is on | the same as FCM |
| Anthropic, OpenAI, or the AI gateway or other provider you connect | when your appliance runs the agent on them; when you open their sign-in page | what the appliance sends them. Sign-in pages open in your browser, directly with the provider. |
| Brave Search | only if you give the agent a Brave Search key | the agent's search queries |
| Whombat support | only while you allow remote help (section 5.3) | at *Look*, the output of a fixed list of read-only commands; at *Look and fix*, everything on the appliance |
| Google, and other services you connect with a sign-in | when you connect your Google account (or another such service) | the provider's consent page, directly with the provider. The provider then sends your browser back to your appliance's own page (`/connect/<id>`) with a one-time authorization code; the page takes it off the address bar at once and sends it to the appliance over the end-to-end session (`apps/server/src/connections/redirect.ts`; `apps/web/src/managed/ManagedRoot.tsx`, `GoogleReturnFlow`). On an appliance the cloud service registered before Whombat Link, that return goes to Whombat's web origin instead, whose hosting then receives that one request, query string included, so the hosting must not log query strings. The code is useless without the verifier and client secret the appliance keeps. The tokens stay on the appliance. |
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

**Feedback widget** (`apps/widget`). It runs on third-party websites. It sends the page URL (without query or
fragment, id-like path segments redacted), the page title, a coarse browser name, language, viewport size and time
zone, values the integrating site passes explicitly, and what the person types: an optional name and email, and
screenshots they choose. It never reads cookies, storage, form contents or the DOM (`apps/widget/src/loader/loader.ts`,
`collectContext`). The widget seals each report to the appliance's key in the browser (HPKE,
`packages/core/src/feedback/drop.ts`); the cloud service holds the sealed report until the appliance fetches it, while
Whombat Link is on. Whombat serves the widget's code, so it is a trusted supplier there too.

## 9. Known limitations and what is out of scope

- A malicious or compromised hosted web origin, appliance update or AI client update defeats end-to-end
  encryption. See sections 5 and 6.
- While the person allows remote help at *Look and fix*, Whombat support has root on the appliance (section 5.3).
- Appliance identity pins stored before the pinning rule (`legacy`) are kept, and a version 1 recovery kit relies on
  the device's existing pin (section 3.6).
- For an appliance with Whombat Link, the relay and cloud service see metadata: who connects to which appliance and
  when, message sizes and timing, IP addresses while connected (not stored by the cloud service), the account an
  appliance is linked to, its update progress and remote help's state, and push timing and kind. There is no padding
  or cover traffic.
- A self-installed appliance doesn't encrypt its disks (section 5.1).
- Each update channel is signed by one online key (section 5.2).
- Data on client devices is protected only by the platform. The web app keeps the cloud session token, the
  appliance list (metadata), drafts and a pending claim card (up to an hour) in `localStorage`; the phone app keeps
  downloaded attachments in its cache directory. XSS on the web origin could use (not extract) the endpoint key and
  could read the cloud session token.
- Revocation can't erase copies already saved, or data on offline or modified clients.
- Deleting a cloud account doesn't remove the person's account on an appliance (the data stays on the box).
- Not yet in place: threshold signing of releases, appliances Whombat sets up itself (with disk encryption),
  reproducible and published builds, a public audit of `@libp2p/noise`.
- Out of scope: what AI providers, GitHub or other services you connect do with data you send them; the
  security of your own devices and network; physical attacks on hardware you don't own.

## 10. Reporting vulnerabilities

See `SECURITY.md` (security@whombat.com). Please also report any place where the code doesn't do what this
document says.
