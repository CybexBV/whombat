# Whombat managed appliance — agreed architecture (MA decisions)

Status: agreed 2026-09-25 by the orchestrator. This file is the blueprint that all specialist work builds
against. Decisions are numbered `MA-nn`. Component repositories record their own finer decisions in their
`docs/decisions/*.md`, listed in `adr-index.md`. A decision here changes only via a new `MA-nn` entry that
names what it supersedes.

Baseline: Whombat’s `main` at `c39f1f2` (25 Sep 2026; includes the Feedback widget merged after the
reviewed `c4702a5`).

## 1. System overview

```
  browser / Android / iOS  (hosted UI from app.<env>, decrypts locally)
        │  wss:443  outer: relay protocol v1 (admission ticket, opaque binary after "ready")
        │           inner: Noise XX (libp2p-noise) ─ session protocol v1 (typed requests, subscriptions,
        ▼                                             streams, collaboration) — end to end
  the relay (Go)      ── forwards opaque bytes, bounded; no content, no DB
        ▲  wss:443 outbound from the appliance (control connection + one data connection per session)
        │
  appliance (NixOS)
   ├─ whombat-manager (Go, own user)  ── control API (device-authenticated): enrollment, tickets, updates
   ├─ whombat-update-helper (Go, root, typed ops only)
   ├─ whombat runtime (TypeScript, ~/Code/Whombat in WHOMBAT_MODE=managed)
   │    server: commit pipeline, Postgres, session endpoint (Noise responder), allowlisted dispatcher
   │    runner: sandboxed provider turns (Codex/Claude/synthetic), per-identity credential homes
   ├─ PostgreSQL 17 (local, reserved resources)
   └─ backup agent (restic → customer-chosen append-only destination)

  control (TypeScript)          cloud identity, orgs, device directory, claim coordination, admission
                                 tickets, relay worker assignment, update assignment/rollout, generic push,
                                 billing boundary. Never sees content; cannot grant content access.
```

## 2. Repositories and ownership (MA-01)

| Repo | Owns | Language |
|---|---|---|
| `~/Code/whombat-contracts` | `@whombat/core` (domain, API contracts, keys engine, signing — moved from Whombat with history), `@whombat/canvas-schema`, `@whombat/fixtures`, new `@whombat/protocol` (relay protocol v1, session protocol v1, frame codec, admission ticket claims), `@whombat/control-contracts`, `@whombat/release` (release manifest, update assignment, compatibility), `@whombat/secure-channel` (Noise session over an injected byte stream; pure: no Node-only APIs, injected randomness/transport), JSON Schema export, Go bindings (`go/` module), conformance vectors | TS (+ generated Go) |
| `~/Code/Whombat` | server, runner, agent-runtime, CLI (dev/migration/recovery), DB, migrations, managed mode, legacy import | TS |
| `~/Code/whombat-app` | web app, mobile app, feedback widget, `@whombat/client` (session/transport/resource adapters), tokens, avatars, brand, visual tooling, design handoff | TS |
| `~/Code/whombat-api` (was `whombat-control` until 2026-09-26, CT-57) | control API + its DB, admission key, push senders, update assignment/rollout, billing boundary, infra definitions for cloud | TS |
| `~/Code/whombat-relay` | relay server, load tools, deployment | Go |
| `~/Code/whombat-appliance` | NixOS flake/modules/image, manager, update helper, recovery/export tool, provisioning, TUF tooling, VM tests, hardware qualification, integration harness, **product integration manifest**, this ledger | Nix + Go |

Rules: the contracts repo imports no consumer. Consumers never copy schemas; Go consumers use the generated
bindings. Server and runner stay one local application system (no cloud round trips between them).

## 3. Publishing, pinning and change order (MA-02)

- Contracts packages are built to JS + `.d.ts` and packed (`pnpm pack`) into versioned tarballs by
  `whombat-contracts/scripts/release.ts` from a clean tagged commit (`contracts-vX.Y.Z`). Consumers vendor
  them under `vendor/whombat-contracts/<version>/*.tgz` and depend on `file:` paths; pnpm lockfile integrity
  plus a `vendor/whombat-contracts/<version>/SHA256SUMS` pin them. Reason: GitHub Packages publishing needs a
  `write:packages` token we don't have; vendored immutable tarballs build from a clean checkout offline.
  Replaceable by a registry later without changing consumers' import names.
- Go bindings: `whombat-contracts/go` module `github.com/CybexBV/whombat/contracts/go`; Go consumers
  vendor a tagged copy under `third_party/whombat-contracts-go/` with a `replace` directive.
- Local development override: `WHOMBAT_CONTRACTS_DEV=<path>` handled by each consumer's documented
  `scripts/link-contracts` (never committed state). Released builds never depend on sibling paths.
- Change order: contracts → {Whombat, whombat-app, control, the relay} → the appliance
  manifest. A breaking change is additive first (new major under a new name/version), consumers migrate, then
  the old is removed. No cycle: contracts depends on nothing of ours.
- One writer at a time for: contracts `main`, each repo's lockfile, the integration manifest (orchestrator).

## 4. Identities and custody (MA-03)

| Identity | Holder | Proves | Cannot |
|---|---|---|---|
| Cloud account (email + passkey/magic link) | person, control DB | who may request routing tickets for an org | read content, enroll endpoints, act locally |
| Org role (owner/admin/billing/member) | control DB | billing, device directory, cohort consent | grant content access |
| Appliance **management key** (Ed25519, `/persist/identity/management.key`, per device) | manager | device ↔ control (tickets, updates, directory) | open content sessions |
| Appliance **content identity** (Ed25519 libp2p identity, `/persist/identity/content.key`, per device) | runtime session endpoint | the appliance end of every Noise session; its PeerId is printed on the claim card and pinned by clients | — |
| **Endpoint keys** (Ed25519, one per browser profile/app install) | client local storage | a client end of a Noise session; enrolled on the appliance and bound to one local account | anything once revoked locally |
| Local account / principal | appliance DB | application permissions (keys engine, roles, owners) | — |
| Provider identities (Codex/Claude login, GitHub token) | per-identity credential home on appliance | inference/GitHub as that named person | be reassigned silently |
| **Recovery key** (customer-held kit) | owner | new owner endpoint after loss; decrypts backups | — |
| Admission signing key | control | relay admission | content access |
| Release root/targets keys | offline release custody | update authenticity | assignment |
| Assignment key | control (online) | which approved tuple a device should run | authorize an unapproved artifact |
| APNs/FCM credentials | control | generic push | — |

Cloud password/email reset grants nothing locally. Development and production use distinct keys of every kind.

*Since Whombat one-person.md OP-10…OP-12 (2026-10-25): an org has one account and no roles, a Whombat one local
account (the person's) with no owner or member roles, and the recovery key enrolls a new device of that person.*

## 5. Claim and enrollment (MA-04)

1. Factory provisioning (`appliance/provisioning`) generates on-device: management key, content
   identity, claim secret (128-bit, base32, one use) and registers the management public key + content
   PeerId with control's device directory (unclaimed). Printed claim card: appliance id, content PeerId
   fingerprint, claim secret, QR. The image contains no key or claim material.
2. The customer signs into the hosted UI (cloud account), enters the claim card (or scans QR). Control records
   a pending claim for the org (rate-limited, one pending claim per device, first wins with expiry) and issues a
   client ticket for that appliance restricted to the enrollment channel.
3. The client opens a session through the relay, runs Noise XX, **verifies the appliance PeerId from the card
   before sending anything**, then sends `enroll.claim{claimSecret, account{name,email}}` bound to its own
   endpoint key (the Noise static identity). The appliance checks the physical claim window if configured,
   consumes the secret atomically in one transaction (creating the owner account, enrolling the endpoint key
   as owner endpoint, writing a signed audit event), then reports `claimed(org)` to control signed by the
   management key.
4. The owner creates the recovery kit (recovery key generated in the client, public half enrolled on the
   appliance as recovery authority; the kit also carries the backup repository password). The UI requires the
   owner to verify the saved kit (re-enter a challenge) before normal use. Until verified the UI keeps showing
   "Recovery kit not saved".
5. Further endpoints: (a) pairing — a new endpoint opens an enrollment-channel session and shows a short code;
   an already-trusted endpoint of that account (or an owner for invites) approves the pairing as a local
   command; (b) invite acceptance — a local one-time invite secret (in the link fragment) binds the new
   endpoint to the invited account; (c) recovery — a signature by the recovery key enrolls a new owner
   endpoint. Unenrolled endpoints get only `enroll.*` and `recovery.*` ops, bounded in rate and size.
6. Revocation is a local command; it bumps the account's `authzGeneration`, closes its sessions and makes
   compliant clients clear caches. Control mirrors "revocation pending/applied" only as metadata reported by
   the appliance.

*Since Whombat OP-01, OP-11 (2026-10-25): the claiming account is the box's one person; further endpoints are that
person's own devices, by pairing (a) or recovery (c). Invites (b) and an owner approving for someone else are gone.*

## 6. Relay protocol v1 (outer) (MA-05)

- Endpoint `GET /v1/connect`, WebSocket subprotocol `whombat-relay.v1`, TLS on 443 in deployments.
- First message (text JSON, within 10 s): `{"t":"hello","v":1,"ticket":"<jws>","class":"interactive"|"bulk"}`;
  an appliance data connection adds `"session":"<sid>"`. Tickets are never in URLs, headers the browser can't
  set, logs or process arguments.
- Relay answers `{"t":"welcome","v":1,"conn":"<id>","heartbeatMs":20000,"maxMessage":262144}` or closes with
  4400 bad hello, 4401 bad/expired ticket, 4403 origin/role forbidden, 4404 appliance offline, 4409 replayed
  ticket, 4429 rate/quota, 4503 draining (`reason` carries `retryAfterMs`), 4504 appliance didn't join,
  4508 slow consumer, 4413 message too large.
- Appliance control connection (hello without `session`): relay sends
  `{"t":"incoming","session":"<sid>","class":...}`; the appliance opens a data connection with the same
  `session` within 10 s; the relay splices it to the waiting client and sends `{"t":"ready"}` to both.
  Relay → appliance `{"t":"drain","retryAfterMs":n}` on worker shutdown. Appliance → relay
  `{"t":"refuse","session":"<sid>"}` when at capacity.
- After `ready` only **binary** messages are allowed and are forwarded unmodified; a text message is a
  protocol error. Close of either side closes the other (code forwarded).
- Bounds: max message 256 KiB, 1 MiB buffered per direction per session (reading pauses, i.e. TCP
  backpressure end to end), slow consumer closes after 30 s without progress, idle timeout 120 s with
  WebSocket pings every 20 s, per-appliance 64 concurrent sessions, per-subject connection and hello rate
  limits. Interactive and bulk are separate connections (no shared head-of-line blocking).
- Origin: if present it must be in the configured allowlist; absent Origin (native) is allowed but still
  needs a valid ticket. Origin is never authorization.
- Relay logs/metrics hold connection ids, coarse counters and byte totals only; no payloads; crash dumps
  disabled.

## 7. Admission tickets (MA-06)

Compact JWS, `alg: EdDSA` (Ed25519), header `{alg, kid, typ: "whombat-admission+jwt"}`, signed by control.
Claims: `iss` (control URL), `aud` (`whombat-relay:<env>`), `rol` (`client`|`appliance`), `apl` (opaque
appliance route id), `sub` (opaque subject: pseudonymous account id or device id), `org`, `wrk` (assigned relay
worker id), `chn` (`app`|`enroll`), `iat`, `nbf`, `exp` (≤ 300 s after `iat`), `jti`. Client tickets are
single-use per `jti`; appliance tickets may open data connections until `exp`. The relay loads control's
public keys (JWKS with rotation). Tickets admit traffic only; the appliance authenticates every session
itself. `chn` is advisory for quota/UI; the appliance enforces enrollment-only rights from the Noise identity.

## 8. Secure channel (MA-07)

- Candidate: libp2p Noise (`@chainsafe/libp2p-noise`, `Noise_XX_25519_ChaChaPoly_SHA256`, libp2p signed
  static-key payload binding an Ed25519 identity) used through its connection-encrypter interface over the
  relay byte stream. Client is initiator, appliance responder. Prologue `whombat-secure-session/1`.
  No libp2p host, DHT, discovery or peer routing.
- The client pins the appliance PeerId from the claim card/enrollment and aborts on mismatch before sending
  any application byte. No application data in handshake payloads (no early data).
- Fresh keys per connection; rekey = new connection + new handshake before nonce/time/byte limits
  (session protocol reconnects transparently). Never reuse a nonce under an old key.
- Must work in Node 24, Chromium/Firefox/WebKit and Expo/Hermes (Android, iOS build) with strong randomness;
  qualification spike decides (`whombat-contracts/docs/decisions/secure-channel.md`). If it fails, evaluate
  another maintained implementation; no homemade crypto; no relay-terminated TLS.

## 9. Session protocol v1 (inner) (MA-08)

Frames inside Noise: `[u8 type][u32 streamId BE][payload]`; types `0x01 CONTROL` (UTF-8 JSON
`SessionMessage`), `0x02 DATA`, `0x03 CREDIT` (u32 bytes), `0x04 END`, `0x05 RESET` (u16 code). Stream 0 is
the control stream. Exact schemas live in `@whombat/protocol` (single source). It covers:
- `hello`/`welcome`: protocol major/minor, capabilities, client build, principal summary and
  `authzGeneration`; supports current and previous major.
- `request{id, op, input, deadlineMs}` → `accepted` (durably committed) / `result` / `error`; `op` names an
  allowlisted application operation (the existing `api.<area>.<action>` contracts); `cancel{id}`;
  `status{id}` for an ambiguous outcome.
- `subscribe{topics, after: cursor}` → `event{cursor}`… or `snapshot_required{reason}`.
- Streams with credit flow control for downloads (range), chunked resumable uploads (sha256 per chunk and
  whole), exports, and collaboration (Yjs sync/awareness per canvas).
- Bounded JSON size (64 KiB control messages), bounded open streams, deadlines.

## 10. Durable commands and event cursors (MA-09)

- Client states: `draft → pending_delivery → accepted → executing → completed | rejected | unknown`.
  `accepted` is sent only after the appliance transaction commits.
- Idempotency: `(principal, op, requestId)` unique, bound to `digest = sha256(canonicalJson({op,input}))`;
  a reused id with another digest is rejected (`idempotency_mismatch`). The receipt row is written in the same
  transaction as the command. Retries reuse the id or query `status`.
- Event log: appliance-owned monotonically increasing cursor (`session_events`), retention bounded by age and
  count; resume with `after`; expired cursor, restart discontinuity, or changed `authzGeneration` →
  `snapshot_required` and the client refetches authorized snapshots.
- Disconnects never cancel accepted work. External effects use integration idempotency or reconciliation
  (existing `uncertain` states); nothing claims exactly-once.

## 11. Managed mode in the application (MA-10)

`WHOMBAT_MODE=managed` (legacy `selfhosted` stays the default in the Whombat repo during migration).
Managed mode: no public HTTP listener (loopback only for manager health and runner internals), all client
traffic via the session endpoint; systemd owns processes (no CLI supervisor, no CLI upgrade); host-shell
authority replaced by owner-authorized local commands with last-owner protection (*since Whombat OP-03, 2026-10-25:
the person's own commands, with no owner role to protect*); `trusted` agent access,
sandbox fallback and ACP (trusted-only) are unavailable, each with an explanation in the UI; Feedback public
intake only through the encrypted drop (MA-26); native push via control with
content-free requests; per-identity provider credential homes; backups via the appliance backup service.

## 12. Updates (MA-11)

Manager state machine persisted in an fsync'd journal:
`Assigned → Downloading → Verified → Staged → WaitingForSafeBoundary → Activating → Verifying → Healthy`
(+ `Failed`, `RolledBack`, `Quarantined`), with current/candidate/known-good tuples, maintenance lock, attempt
limits, health evidence. TUF (`go-tuf/v2`) authenticates artifacts and approved release tuples; a separately
signed control **assignment** picks one approved tuple for a device/cohort. The root helper re-verifies TUF
metadata and the tuple itself and accepts only typed operations (`stage-runtime`, `activate-runtime`,
`rollback-runtime`, `stage-host`, `activate-host-on-reboot`, `bless-boot`) on release ids.
Update classes: runtime/provider bundle (Nix closure, profile switch + unit restart, no reboot) and
host/manager (NixOS system generation, reboot, boot counting). Rollout: internal → consenting pilot →
canary → progressive waves with observation windows, failure thresholds, auto-pause, quarantine and an
operator emergency stop. Development TUF roots only in this work.

## 13. Appliance layout (MA-12)

`/persist` (encrypted, TPM-assisted unlock + customer recovery passphrase):
`identity/` (management, content keys; 0700 manager/runtime split), `postgres/17/`, `whombat/home/`
(WHOMBAT_HOME: files, skills), `whombat/workspaces/`, `whombat/credentials/<account>/<provider>/`,
`manager/` (journal, TUF cache, staging, known-good), `backup/` (staging, state), `secrets/` (master key).
Users: `whombat` (server), `whombat-runner`, per-task sandbox uids, `postgres`, `whombat-manager`; helper is a
root socket-activated unit. Reserved CPU/memory/IO for Postgres, manager and interactive API (systemd slices).

## 14. Backups (MA-13)

The backup service (`backup/`, runbook `docs/runbooks/backup.md`, decisions `docs/decisions/backup.md`) makes
consistent checkpoints: writes quiesce at a safe boundary, a database snapshot and btrfs snapshots of the sources are
taken inside the same quiesce, then the dump and the files upload from the snapshot with restic, under a signed,
hash-chained manifest. Destinations: a restic REST server (append-only qualifies; a backup place on the person's NAS
is one), S3, SFTP, a backup disk, or the box's own disk. The person's policy decides when (slots in their time zone),
what to keep (time windows) and a space limit; the box clears old backups wherever its key may delete, an append-only
destination is cleared by its own side. A weekly check restores into quarantine and verifies everything. Coverage:
database, attachments, skills, memory and conversations (Hermes), workspaces (including unpushed commits and
uncommitted/untracked files), the agent's home, configuration and master key, provider session state (flagged "may
need re-login"), the servers where the hosts service runs, recovery material references; caches listed separately.
A missing attachment or a failed servers export doesn't stop a backup: the manifest records the gap. The backup
encryption key is in the customer's recovery kit. A backup can be opened for reading (a peek: a temporary read-only
database and a read-only copy of the runtime's sources) so the runtime brings back one thing without a restore.

## 15. Environments and local ports (MA-14)

Distinct `local`, `dev`, `prod` credentials for everything (admission keys, TUF roots, push, OAuth, DBs).
Planned hosts (not deployed by this work): prod UI `app.whombat.com`, control `api.whombat.com`, relay
`relay.whombat.com`; dev UI `dev.whombat.com`, `api.dev.whombat.com`, `relay.dev.whombat.com`. The current
monolith keeps running on its domains until an explicit cutover.
Local integrated environment defaults: Postgres (own container `whombat-mgd-pg`) 55490, control 4600,
relay 4610 (metrics 4611), appliance runtime server 4620 (loopback), web dev 5190, restic rest-server 4630.
Tests always pick free random ports and throwaway databases.

## 16. What is superseded

- S-01/S-06 (self-hosted, CLI supervisor) remain for the legacy self-hosted mode only; managed mode is
  systemd-owned (MA-10).
- S-15 (no native push when self-hosted): managed mode sends push via control (MA-03).
- C-15/C-16 (one public origin, cookies): managed mode has no public origin; the hosted UI talks through the
  relay session (MA-05…09).
- BP-11/BP-12 prefix-only schema guard: replaced by the reader/writer compatibility model (Whombat workstream
  `managed-db`).
- The old plan's monorepo layout and "validation only" restriction (superseded by the assignment).

## Amendments

- **MA-15 (2026-09-25, amends MA-08):** session frames carry a length prefix: `[u32 len BE][u8 type][u32 streamId BE][payload]`
  over the Noise connection (whombat-contracts CT-05), so frames are independent of Noise message boundaries and
  bounded before allocation. Released in `contracts-v0.2.0` (`@whombat/protocol/frame`, Go `protocol.FrameDecoder`).
- **MA-16 (2026-09-25):** contracts 0.3.0 (CT-14…CT-20): identity is account-based (endpoints bind to accounts,
  burrow principals optional); unknown members are stripped from peer wire messages and responses within a major,
  command inputs/signed documents/tokens stay strict (basis of the N/N-1 policy); strict Ed25519 everywhere (Go adds
  a strict check on top of `crypto/ed25519`); registration proves both device keys; relay close 4421 `wrong_worker`,
  `org` optional for unclaimed appliances.
- **MA-17 (2026-09-25, corrects the orchestrator's earlier credential-owner instruction):** a **personal** provider
  credential (a person's own API key, subscription or token) runs only work that person asked for (PI) or their own
  automations (NA). A request by *another* person to an agent running on someone's personal credential is OA and is
  refused — using it would silently turn a personal credential into a shared one (assignment §1; E-C1 "Each end user
  must authenticate with their own … credentials"). Team agents that serve several people run on an
  **organization credential** (an org-owned API key or 3P credential, billed to the org, configured by an owner,
  stored in an org credential home). Agent runtime therefore references a credential source:
  `{kind:'account', accountId}` (personal; only that person's requests + their automations) or
  `{kind:'org', credentialId}`. Contracts 0.5.1 extends CT-26 accordingly. *Superseded by Whombat OP-09 (2026-10-25): a
  turn runs on the person's own sign-in or an API key they add; no team agents, organization or member credential
  sources.*
- **MA-18 (2026-09-25): browser push in managed mode goes through control, like APNs/FCM.** Control holds per-environment
  VAPID keys and a Web Push sender; the browser registers its push subscription with control (cloud session) and gets
  an opaque push handle it gives its appliance via `push.handles.set`; the appliance sends content-free push requests;
  control sends a generic notification ("Whombat needs you", kind, collapse key; payload encrypted to the browser per
  RFC 8291 but carrying no workspace content); the service worker shows it and a tap opens the app, which fetches the
  detail through the secure session. Contracts 0.5.1 adds `PushPlatform 'webpush'` with the subscription shape.
  Google/other OAuth connectors whose redirect must reach the appliance stay **disabled in managed mode** with an
  explanation until a customer-side design exists (EX with reason, PV decision).
- **MA-19 (2026-09-25, from security review part 1):**
  (a) *Recovery authority*: replacing the recovery key requires a signature by the current recovery key; the new key is
  pending until its kit is verified; all owners are notified (signed event). A recovery statement enrolls a device only
  into the account recorded as the kit's owner (the owner who set up or last rotated the kit, who must still be an owner).
  (b) *Invites* create new accounts only; an invite for an email that already has an account is refused ("add a device
  from your existing device instead") — accounts are never bound to a new device without their own approval.
  (c) *Last owner*: no operation may leave zero owners holding at least one active (non-revoked) endpoint.
  (d) *Claim proof*: provisioning registers a `claimVerifier = b64url(SHA-256("whombat-claim-control/1\n" + deviceId +
  "\n" + normalized))` with control (domain-separated from the appliance's hash); `claims.start` requires the matching
  `claimProof`, so only card holders can open a pending claim or obtain an enrollment ticket. Control still never sees the
  secret.
  (e) *Unenrolled sessions* are capped separately (small per-appliance cap) and closed if no enroll/recovery op arrives
  within a short timeout; the relay caps concurrent sessions per subject per appliance and pre-auth connections per IPv4
  address and per IPv6 /64.
  (f) *Secrets never in receipts*: every op whose input or result carries a secret (invite accept/create,
  connector app secrets, provider logins, backup destination) is a `secret` op: no input digest and no stored result.
  (g) "Run now" of an automation that runs on a personal credential is allowed only for its publisher; event triggers
  remain the publisher's automation (NA).
  *Since Whombat OP-11 (2026-10-25): (a) the kit's account is the box's one person and nobody else is notified; (b)
  and the invite ops of (f) are gone; (c) has no owners to count; (g) every automation is the person's.*
- **MA-20 (2026-09-25):** native WebSocket clients that set an `Origin` equal to the relay's own public origin (React
  Native on Android does this by default) are treated as native (no browser page can forge that origin); the app also
  sends an empty Origin. Relay config gains the list of its own public origins. `push.resolve {ref} → {link}` (contracts
  0.5.2) lets a notification tap open exactly the referenced item over the session; until then taps resolve by kind.
- **MA-21 (2026-09-25, from security review part 2):**
  (a) *Recovery environment* never offers a shell or console login without the customer's disk recovery key; it boots to a
  restricted menu (export, verify, factory reset, secure erase) that requires the recovery key before touching any
  volume; no autologin on any tty.
  (b) *TPM policy*: /persist and root unlock only for the normal appliance boot path — bind to PCR 7 **and** a signed
  PCR 11 policy (UKI measurement signed by the device's own policy key via systemd-measure/ukify), so the recovery UKI and
  arbitrary images signed with the Secure Boot key cannot unseal; /persist unlock is additionally bound to the opened root
  volume (PCR 15 extended by systemd-cryptsetup `tpm2-measure-pcr`). Old generations keep booting because their UKIs
  are in the signed policy; revoking an old generation = rotating the policy key. Residual limits recorded; real TPM
  behaviour is hardware-only.
  (c) *Rollback*: assignments may not move a device to an older version unless the TUF-signed tuple explicitly permits
  that downgrade (custody-signed rollback), and the helper's local rollback only goes back to the recorded known-good,
  never to a withdrawn release.
  (d) *Known-good manager* is verified against the TUF-approved hash of the release that shipped it, never a local manifest.
  (e) *Restore*: the quarantine marker is written and fsynced before any data is restored; the runtime refuses writes
  until quarantine ends. What a restore set aside is journaled before each change, so a failed or interrupted
  restore (a power cut included) is put back before the runtime starts (BK-40…BK-43).
  (f) *Least privilege*: backup services read only the declared backup sources (systemd ReadOnlyPaths/InaccessiblePaths);
  identity keys and Secure Boot keys are inaccessible to them; the export tool confines all output paths to `-out`.
- **MA-22 (2026-09-26, supersedes MA-04 §1–3 and the fingerprint step of app AP-21):** claiming with a console code
  `LL-NNNN-LL` (control-leased lookup number + four secret letters the appliance shows on tty1), discovery of
  unclaimed boxes on the caller's public network, and CPace (`CPACE-RISTR255-SHA512`) bound to both Noise static keys
  instead of the fingerprint comparison; the factory card becomes the second PAKE password. Self-registration for
  the ISO. Details and threat notes: `docs/decisions/claim-code.md` (CC-01 … CC-12), contracts 0.7.0.
- **MA-23 (2026-09-26):** commercial protection. A signed appliance licence (compact JWS, EdDSA, 14-day tokens renewed
  daily by the manager over the device op `licence.renew`, verified by the runtime against a key set pinned in the
  image and rotated only through releases), states `licensed | grace | lapsed` (30 days of grace), and an enforcement
  matrix that stops new agent runs, automations and growth beyond the plan but never reading, export, device
  management, recovery or security updates (billing invariant kept). Self-installed boxes need an entitlement that
  allows them. Appliance terms are accepted at claim. Proprietary notices in the closed repositories. Details:
  `docs/decisions/licence.md` (LC-01 … LC-19), terms `docs/legal/appliance-terms.md`.
- **MA-24 (2026-09-26, before publishing the client repositories):** the directory is never a source of the appliance
  identity pin. A client pins a PeerId only from a party that already trusts the appliance: the claim's
  CPace-confirmed result, a recovery kit that names the identity, or an invite, re-enrollment or add-a-device link
  made by an enrolled device (*since Whombat OP-11, 2026-10-25: no invite or re-enrollment links*). A pin that differs
  from the directory is a hard stop, never a silent update. A replaced
  or reset appliance is a new device with a new identity (BK-07, BK-13), so an identity change always goes through a
  new claim. Details: whombat-app `docs/decisions/app-managed.md` (AP-63 …).
- **MA-25 (2026-09-26):** cloud metadata minimisation. Control stores no raw client IP addresses (rate-limit keys are
  keyed hashes, request logs carry no addresses and have a set retention), and a signed-in person can delete their
  cloud account. Details: control `docs/decisions/control.md` (CL-37 …), whombat-app `docs/privacy-and-security.md` §4.
- **MA-26 (2026-09-27; replaces MA-10's clause on Feedback intake):** website feedback on a managed appliance goes
  through the **encrypted drop**: the widget runs on a dedicated embed origin, the visitor's browser seals the report
  (HPKE) to a key of the appliance that the snippet pins through the site's signing key (`data-key`), control keeps
  only the ciphertext until the appliance pulls it through the manager and deletes it on the acknowledgement; the
  runtime opens and files it. The appliance still has no public route (MR-04), the manager signs and forwards and
  holds no content key (MG-39). Details: Whombat `docs/decisions/feedback-drop.md` (FD-01 …), NX-39, IN-53 … IN-56.
