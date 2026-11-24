# Session protocol (inside Noise)

The exact schemas are in `@whombat/protocol/session` (MA-08, MA-09); this page describes how the pieces fit. Since
contracts 1.0 the session protocol is major 2 (CT-1260).

## Getting there (CT-1250, HE-50)

A client reaches the box one of three ways; the session inside is the same:

- **Through the relay**: `wss://<relay>/v1/connect`, subprotocol `whombat-relay.v1`, a `hello` with control's admission
  ticket (`@whombat/protocol/relay`, `/admission`), then `ready` and binary.
- **Directly, on the local network**: `ws://<LAN address>:4480/v1/direct`, subprotocol `whombat-direct.v1`,
  `DirectHello {t: 'hello', v: 1, class}` → `DirectWelcome {t: 'welcome', v: 1, heartbeatMs, maxMessage}`, then binary
  (`@whombat/protocol/direct`). No ticket and no control: the box admits the client from its Noise static key.
- **Directly, over Tailscale**: the same, as `wss://<Tailscale name>:4480/v1/direct` with the name's certificate.

Clients learn the direct ways in `welcome.direct` (`DirectAddresses`: LAN addresses, the Tailscale name, `routes`
best first) and try them before the relay next time (`directRoutesFor(addresses, {secureOnly})`: an `https://` page
only `wss://` routes). A browser reaches the box directly from the page the box serves on each route
(`DirectRoute.web`): plain `http://` on the local network (the session is still end-to-end encrypted; what needs a
secure context says it isn't available there), `https://` on the Tailscale name.

Admission (MA-04), on every way: an enrolled endpoint's key gets the `app` channel; an unknown key the `enroll`
channel only (enrollment and recovery operations, the unenrolled budget); a revoked one `revoked` and the end.

Before any session, a plain `GET` of `/v1/direct` answers `DirectIdentity {v, appliance, edition?, claimed?}` (1.1): the
PeerId the box's page pins, and its edition (`commercial` when absent). A community box (1.1, HE-58) has only the direct
ways: no relay, no control.

## Framing (CT-05)

The Noise channel carries a byte stream of frames `[u32 length BE][u8 type][u32 streamId BE][payload]`
(`length` = 5 + payload). Types: `0x01 CONTROL` (stream 0, UTF-8 JSON `SessionMessage`, ≤ 64 KiB), `0x02 DATA`
(≤ 64 KiB), `0x03 CREDIT` (u32), `0x04 END`, `0x05 RESET` (u16 `STREAM_RESET`). `FrameDecoder` refuses an
announced length above the limit before buffering it. Any framing error closes the session.

## Handshake

1. After Noise XX, where the client has pinned the appliance PeerId, the client sends `hello` with the major it
   speaks (`SESSION_PROTOCOL`), its capabilities, its build and `cachedAuthzGeneration`.
2. The appliance answers `welcome`: the version (`negotiateVersion`: its own major, the lower minor), the common
   capabilities, `channel` (`app` or `enroll`), the principal, `authzGeneration`, `clearCache`, limits and `direct`.
   When the client doesn't speak its major it sends `error{unsupported_version}` with `UnsupportedVersionDetails` and
   closes; `whoMustUpdate` says who is behind: “Update the app to use this Whombat.” or “This Whombat needs an update to
   work with this app.” (`VERSION_REFUSAL_COPY`). An app from before contracts 1.0 (major 1) meets this refusal.
3. Forward compatibility within the major (CT-14): messages from a newer minor are accepted. Unknown members are
   stripped and unknown message types are skipped (`decode*Message` → `unknown_type`). Operation inputs stay strict.
   Invalid messages get `error{invalid_message}` and close the session. An op a box doesn't have yet is `unknown_op`.
   Clients decode outputs and events with `decodeTolerant`: an item carrying an enum member or union discriminator a
   newer minor added is left out and reported (`skipped`) instead of failing the answer.

## Identity

Endpoints bind to a local **account** (MA-03). `welcome.principal` and the enrollment outputs carry `accountId`,
`name`, `owner` and `principals` (optional): the account's principal in each burrow, `[{burrowId,
principalId}]`, ≤ 256. A freshly claimed appliance has no burrow yet. `EndpointSummary.accountId` names the
endpoint's account.

## Requests (durable commands)

`request{id, op, input, deadlineMs}`. `op` must be in the appliance's `OperationAllowlist`
(`createOperationAllowlist()`: every `api.<area>.<action>` (since 1.1 `devices.vapidKey` too), plus the
session-native operations: `enroll.claim.begin`, `enroll.claim`, `enroll.pair.request/status/approve`,
`enroll.invite.create/accept/revoke`, `recovery.kit.register/confirm`, `recovery.enroll`,
`endpoints.list/rename/revoke`, `push.handles.set/clear`, `admins.list/grant/revoke` and `appliance.status`). For an `api` op, `input = {params, query?, body?}`,
validated with the endpoint's schemas. Mutations get `accepted{id}` once the transaction has committed, then
`result{id, kind, output}` or `error{id, code}`. The idempotency key is `(principal, op, id)`, bound to
`requestDigest(op, input)`. `cancel{id}` before acceptance ends the request with `error{cancelled}`; after
acceptance the work continues. `status{id}` returns `outcome{id, state}` (`not_found`: no receipt — for a `receipt`
op never seen accepted, within the receipt retention, that means it never committed, so the same request may be resent
with the same id; see 0.29.0). Clients track `CommandState` with `nextCommandState`.

## Events

`subscribe{sub, topics, after?}` returns `subscribed{sub, cursor, denied: [{topic, reason}]}`. `reason` is
`not_member`, `forbidden` or `not_found`, and the other topics stay subscribed. Then come events:
`event{ephemeral: false, sub, cursor, topic, event}` for durable events, and
`event{ephemeral: true, sub, topic, event}` for typing and presence, which have no cursor. `event` is a core
`RealtimeEvent`; `parseRealtimeEvent` decodes it tolerantly (CT-136) and returns null for unknown types. Instead of events the appliance may send
`snapshot_required{sub, reason, cursor}` (refetch snapshots, then subscribe with `after: cursor`).
`authz_changed` and `revoked` report authorization changes; `revoked` means clear cached content, and the
session closes.

## Streams

Clients open odd stream ids with `open{stream, spec}`. Specs are `download{resource, range?}`,
`upload{target, size, sha256, chunkSize}`, `export{op, input}` (an allowlisted op with `transfer: 'export'`,
e.g. `audit.export`), `collab{burrow, canvasId}` and, since 0.80.1, `console{burrow, sessionId, token}`. The appliance answers `opened{stream, meta}` or
`error{stream, stream_refused}`.

Download resources: `attachment {burrow, attachmentId, variant}`, since 0.79 `backup-file {burrow,
backupFileId}` and, since 0.121, `thing-image {burrow, thing, ref}` (a picture on a thing's page: the page's
`ThingImage.ref` as it came; anything wrong is `stream_refused` without saying why, as the HTTP route's 404). Upload targets, each reserved first by an op: `attachment {burrow, attachmentId}` (`uploads.create`),
since 0.79 `backup-file {burrow, stagedBackupId}` (`backups.stage`); `skill-archive {burrow, stagedArchiveId}`
(`skills.stage`, 0.113 until 2.0; `pack-archive` and `packs.stage` from 0.5.4 until 0.113) is gone.

- **Credit**: each side may send `SESSION_INITIAL_STREAM_CREDIT` bytes of DATA per stream, then only as much as
  the peer grants with CREDIT frames (window ≤ 16 MiB). Overrunning the credit is `RESET flowControl`.
- **Download/export**: the appliance sends DATA, then `stream_done{stream, size, sha256}`, then END.
- **Upload**: `opened.meta.received` gives the resume offset. For each chunk the client sends
  `chunk{stream, index, offset, size, sha256}` followed by DATA totalling `size`; the appliance stores it and
  answers `chunk_ack{received}` (a mismatch is `RESET integrity`; reopen to resume). After the last chunk the
  client sends END; the appliance checks the whole-file sha256 and sends `stream_done{…, output}` and END.
- **Collab**: DATA in both directions carries y-protocols messages (varuint type 0 sync / 1 awareness + body),
  one message per frame, for one canvas document.
- **Console** (0.80.1, capability `stream.console`): DATA in both directions carries a hosts-service console's messages,
  `[u32 len][message]`-framed (see 0.80.1 below).

RESET aborts both directions. END closes the sender's direction.

## 0.4 additions

- **Errors:** the application's code is in `error.details.code` (`APP_ERROR_CODES`). `unsupported_version` details
  give `supported {min, max}` majors and the appliance version. A result over 64 KiB comes back as
  `error{too_large, details.code: use_export_stream}`; read the op through an export stream instead.
- **Exports:** `open{spec: {kind: 'export', op, input}}` works for every `exportable` op: all reads, plus
  `packs.export`.
- **Downloads:** a `preview` is a derived preview, or `stream_refused` with `details.code: variant_unavailable`.
- **Collab:** DATA is a byte stream of `[u32 len][Yjs message]` (≤ 16 MiB, messages may span frames). Credit is
  granted as DATA is consumed (`@whombat/protocol/collab`).
- **Ephemeral ops:** `presence.typing` and `presence.set` are requests without `accepted`, receipt or
  idempotency. They are rate-limited, never queued and never resent.
- **`appliance.status`:** adds `providers[]` and `appliance {peerId, runtimeVersion, schemaVersion, protocol}`.
  The backup summary follows the backup service (CT-24).

## 0.5 additions

- **Upload pipelining (CT-36):**
  - The client may announce the next `chunk` before the previous `chunk_ack` arrives. Credit bounds how far it
    can run ahead, and the appliance queues at most 256 announcements.
  - Each announcement must continue exactly where the previous one ended: `index + 1` and
    `offset = previous offset + size`. A gap or an overlap gets `RESET protocolError`.
  - DATA may span chunk boundaries. The appliance processes chunks, and sends `chunk_ack`, strictly in order.
  - A chunk that fails its hash is truncated away and gets `RESET integrity`. The client reopens the stream and
    resumes from `opened.meta.received`.
- **Claim (CT-27):** `enroll.claim` carries control's `claimId` from `claims.start`. The appliance passes it to the
  manager (`/v1/runtime/claimed`), which reports exactly that claim. The claim secret is normalized as in
  provisioning NX-24 (`normalizeClaimSecret`, `isClaimSecret`); the appliance compares `claimSecretHash`.
- **Backup ops (owners):** `backup.status`, `backup.configureDestination` (a `secret` op; `rest:`, `s3:`, `sftp:`
  and `disk:` repositories since 0.22, CT-142), `backup.recoveryMaterial` (a query, so its secrets never land in a
  receipt), `backup.runNow` and `backup.sshPublicKey` (0.22: the box's SFTP key, `{publicKey, fingerprint}`). Their
  errors use `details.code`: `backup_unavailable|destination_failed|unprotected|busy|failed`.
- **Provider sign-ins:** `providers.list`, `providers.login.start|submit|status|cancel` and `providers.logout`
  (`submit` is a `secret` op). Team agents run on the sign-in of the member a burrow owner chose:
  `agents.setCredentialOwner` sets it, stored as `runtime.credentialOwnerAccountId`. The runner gets
  `DispatchContext.credential`.
- **`secret` ops:** the receipt binds the request id to `receiptDigest(spec, input)`, which is computed over the op
  alone. No digest of the secret is stored, and none of the input is logged.

## 0.5.1 additions

- **Credential sources (MA-17):** a team agent runs on an organization credential. A member's own sign-in serves
  only that member's requests and their own automations. Owners manage organization credentials with
  `providers.org.list`, `providers.org.login.start` (then `providers.login.submit|status|cancel`) and
  `providers.org.remove`. Burrow owners pick an agent's source with `agents.setCredentialSource`. Refusals carry
  `managed.provider_gated|excluded` and `provider.*` codes.
- **Secret ops (CT-44):** a retry of a `secret` op after a lost answer gets `error{unknown_outcome}`. Ask `status`,
  which answers `outcome{state, redacted: true}` without the result, then fetch state or repeat the op with a new
  request id. The appliance keeps neither the input digest nor the result. (Since 0.29.1 `redacted` has other causes
  too, CT-195.)
- **Recovery (CT-45):** replacing the recovery key is `recovery.kit.rotate`, signed by the current key.
  `appliance.status.recovery` names the kit owner, and recovery enrolls only into that owner's account.
- **Claim (CT-43):** before `enroll.claim`, the hosted UI computes `claimProof = claimVerifier(deviceId,
  normalizedSecret)` from the card for control's `claims.start`.

## 0.5.2 additions

- **Pairing (CT-46):** approve only after `enroll.pair.lookup`, and send the looked-up `fingerprint` with
  `enroll.pair.approve`. Both devices show `pairingFingerprint(peerId)`.
- **Notification taps (CT-49):** `push.resolve {ref}` → `{burrow, link}`, or `not_found`.
- **Caches (CT-47):** send `cachedAccountId` together with `cachedAuthzGeneration` in `hello`.

## 0.5.3 additions

- **Re-enrollment (CT-51):** an owner opens `enroll.reenroll.create {accountId}` and gives the one-time secret (24 h)
  to the person. Their new device sends `enroll.reenroll.accept {secret, endpoint}` on the enrollment channel and
  shows its `fingerprint`. An owner compares it (`enroll.reenroll.list`) and sends `enroll.reenroll.confirm
  {reenrollId, fingerprint, approve}`. The device polls `enroll.reenroll.status` and then reconnects. Owners can
  also revoke with `enroll.reenroll.revoke`. Every owner and the account get `security` pushes.
- **Diagnostics (CT-52, owners):** `diagnostics.create {scopes}`, `diagnostics.preview {bundleId}` (the exact
  document; check its sha256), `diagnostics.download` (an export stream only), `diagnostics.list` and
  `diagnostics.delete`. Bundles expire after 7 days. Nothing is uploaded; the customer sends the file.
- **Client security floor (CT-53):** send `client.buildNumber` in `hello`. Below the running release's floor the
  appliance answers `unsupported_version` with `details.code: client_below_security_floor` and `details.floor
  {platform, minBuild}`; `whoMustUpdate` says `client`. `appliance.status.clientFloor` shows the floors.
- The enrollment channel also allows `enroll.reenroll.accept` and `enroll.reenroll.status`.

## 0.5.4 additions

- **Pack archives (CT-55):**
  1. `packs.stage {burrow, fileName, size, sha256}` → `stagedArchiveId`.
  2. Upload the archive with `open{upload, target: {type: 'pack-archive', burrow, stagedArchiveId}, …}`, at most 4 MiB,
     chunked and resumable like attachments.
  3. `packs.import {burrow, stagedArchiveId}` → `{version, created}` (mutating; may be `approval_required`).
  Use this path for every archive; `packs.upload` over the session only fits ≈ 48 KiB.
- **Bundled packs (CT-56):** `packs.importBundled {burrow, name, version}`, with the version `packs.list` showed.
  `packs.importLocal` stays unavailable on a managed appliance.

## 0.7.0: the claim PAKE (breaking, MA-22, CT-58…CT-65)

The claim no longer sends a secret and nobody compares a fingerprint. The client and the appliance run CPace
(`CPACE-RISTR255-SHA512`, `@whombat/protocol/claim`) over the enrollment channel, bound to both Noise static keys, and
confirm the key in both directions.

1. The client gets `{claim, ticket}` from control's `claims.start` (`method: 'code'` with the nearby `device` — only from
   the box's own network, CT-67 — or `method: 'card'` with `claimProof`), opens the session to `claim.contentPeerId`, and computes
   `claimPakeInitiator({method, password, deviceId: claim.device, appliancePeerId, clientPeerId, claimId: claim.claim})`.
   `password` is the four letters (`normalizeClaimCode`) or, for `card`, `claimCardPassword(deviceId, normalizeClaimSecret(secret))` (CT-66).
2. `enroll.claim.begin {claimId, method, share}` → `{share}`. The op is **ephemeral**: there's no `accepted` and no receipt, and
   it is never resent (start again with a fresh share). The appliance keeps the begin for this session for 120 s
   (`ENROLL_CLAIM_BEGIN_TTL_S`); a new begin replaces it. A begin without a following `enroll.claim` costs nothing.
3. The client computes both tags with `claimPakeInitiatorFinish(state, share)` and sends
   `enroll.claim {claimId, method, confirm: tags.client, account, endpoint}`. The appliance checks `confirm` in
   constant time before anything else.
4. The result is `EnrolledOutput + {confirm}` (1.0: no `recoveryKitRequired`). The client checks `claimConfirmEqual(tags.appliance,
   confirm)` **before** it trusts the result (pins the PeerId, creates the recovery kit). A mismatch means it was
   talking to something else: it stops with “This isn’t the Whombat on your screen”.

Refusals (`error.details.code`, with `error.code` in brackets):

| Code | When |
|---|---|
| `claim_used` (`conflict`) | The appliance is already claimed. |
| `claim_not_ready` (`unavailable`) | There is no claim code on the console yet (no lookup lease), or `card` on a box without a card secret. |
| `claim_backoff` (`rate_limited`) | Too many wrong attempts; `details` is `ClaimBackoffDetails {code, retryAt}`. Only `begin` gets it. |
| `claim_share_invalid` (`validation_failed`) | The share isn't a ristretto255 element, or it is the identity. It is not counted as an attempt. |
| `claim_begin_missing` (`conflict`) | `enroll.claim` has no live begin for this session, claim id and method. |
| `claim_invalid` (`forbidden`) | `confirm` didn't match: one wrong guess. Under `code` the letters rotate at once. The begin is used up. |
| `claim_window_closed`, `rate_limited` | As before (MR-26 limits apply to `begin`). |

Attempts (`@whombat/protocol/claim`): the first `CLAIM_FREE_FAILURES` (3) failures in a rolling 24 h are free. After
that, `claimBackoffSeconds(failures)` refuses `begin` for 1, 2, 4 … minutes after the latest failure, up to 60 minutes.
Success clears the counters. `normalizeClaimSecret`, `claimVerifier` and `claimSecretHash` stay: the card is still
`card`'s password and control's `claimProof`.

## 0.9.0: provider subscriptions (SUB-01…SUB-11, CT-68…CT-75)

- **Provider sign-ins are also REST (CT-70).** `api.signins.*` covers the same capability as the native
  `providers.*` ops, with the same shapes, now in `@whombat/core`. A session reaches it as the `signins.*` ops, so one
  client code path serves a self-hosted server (REST) and an appliance (session). The mapping is
  `PROVIDER_OP_EQUIVALENTS`:

  | Native op | `api` op | REST |
  |---|---|---|
  | `providers.list` | `signins.list` | `GET /sign-ins` |
  | `providers.login.start` | `signins.loginStart` | `POST /sign-ins/logins` |
  | `providers.login.status` | `signins.loginStatus` | `GET /sign-ins/logins/:loginId` |
  | `providers.login.submit` | `signins.loginSubmit` | `POST /sign-ins/logins/:loginId/submit` |
  | `providers.login.cancel` | `signins.loginCancel` | `POST /sign-ins/logins/:loginId/cancel` |
  | `providers.logout` | `signins.logout` | `DELETE /sign-ins/providers/:provider` |
  | `providers.org.list` | `signins.orgList` | `GET /sign-ins/org` |
  | `providers.org.login.start` | `signins.orgLoginStart` | `POST /sign-ins/org/logins` |
  | `providers.org.remove` | `signins.orgRemove` | `DELETE /sign-ins/org/:credentialId` |

  The native ops stay until 1.0. `providers.list` output gains `consoles`.
- **The Claude sign-in console (CT-71).** It runs `claude auth login --claudeai` and nothing else, in a PTY, for the
  session's own account:
  1. `signins.consoleStart {body: {provider: 'claude', authMode: 'subscription_cli', cols, rows}}` → `ProviderConsole`
     (`pcn_…`, 10 minutes).
  2. Read output with `signins.consoleRead {params: {consoleId}, query: {cursor, waitMs ≤ 25000}}` →
     `{console, from, data (base64), next, more}`. This is a long poll; set `deadlineMs` above `waitMs`. Keep reading
     from `next` until the console isn't `running` and `more` is false.
  3. Type with `signins.consoleWrite {params, body: {seq, data}}`, at most 4 KiB, with `seq` from 1. Resending a `seq`
     is harmless, and a gap is `provider.console_input_gap`.
  4. `signins.consoleResize` and `signins.consoleCancel` as needed.

  `completed` means the CLI's own status confirmed the sign-in, and it now shows in `signins.list`.
  `consoleRead` and `consoleWrite` are `secret`: never logged, and their receipts keep nothing.
- **The `requester` credential source (CT-69).** `agents.setCredentialSource` accepts `{kind: 'requester', fallback:
  {kind: 'org', credentialId} | null}`. Each turn runs on the sign-in of the person the work is for. Work for nobody
  uses the fallback. The refusals are `provider.requester_not_signed_in` and `provider.no_requester`. It is the
  managed default for team agents.
- **AI clients (CT-72).** `clients.list` → `{clients: ClientStatus[], checkedAt, canManage}`, and
  `clients.install|remove {params: {provider}}` (owners who are admins). Clients update themselves to newer tested
  versions. The new codes are `client.*`.
- **Onboarding (CT-68).** It has four steps, with `OnboardingState.clients`. `githubConnected`/`repos` are
  deprecated.

## 0.10.0: the appliance licence (LC-08…LC-14, CT-76, CT-77)

- **`licence.status {}`** (a read, every member) → `{licence: LicenceStatusView | null}`. `null` on an unclaimed
  appliance. The view is `licenceStatus`'s answer as timestamps:
  - `state` (`licensed|grace|lapsed`), `reason`, `plan` and `limits {devices, members, agents, connectors}`, where
    `null` means unlimited;
  - `renewedAt`, `expiresAt`, `graceEndsAt` and `effectiveAt`;
  - `usage {members, agents, connectors}` and `checkedAt`.

  The runtime caches the state for 60 s.
- **`licence.refresh {}`** (owners and admins) asks the appliance to renew now (“Check again”) and answers the same
  shape. It is mutating like `backup.runNow`. If control can't be reached or refuses, it answers `error{unavailable,
  details.code: licence.renew_failed, details.reason}`. A second refresh within 60 s gets `rate_limited`.
- **`appliance.status.licence`** is the same view. It is null when unclaimed, and absent from runtimes before 0.10.0
  and from self-hosted servers (LC-12), so treat absent as “no licence section”.
- **Refusals (LC-10).** `error{not_allowed}` with one of these `details.code`s:
  - `licence.lapsed`: new agent turns, AI search, runs, automations, new members, agents and connectors. Reading,
    exporting and human writes always work.
  - `licence.limit`: `details` is `LicenceLimitDetails {code, limit: members|agents|connectors, allowed}`. It applies
    only to adding.
- **Event.** `licence.state_changed` is a signed appliance event (`LicenceAuditPayload {from, to, plan, jti}`).

## 0.11.0: guides in the assistant's DM and the managed Google connect (AG-03, AG-14, CT-81)

- **`guides.act {params: {burrow, messageId}, body: {actionId, optionIds?, values?}}`** → `{ok: true}`. It acts on a
  guide card in the caller's personal DM. It is a `secret` op, because form values may carry the Google client
  secret. Refusals carry `details.code`:
  - `guide_closed` (`conflict`): show the locked card.
  - `not_yours` (`forbidden`).
  - `invalid_values` (`validation_failed`, with `fields` by field id).
  - `google_admin_only`, `google_app_in_config`, `google_unavailable`.
- **`connections.finishGoogle {body: {code?, state, error?}}`** → `{returnPath}`. It is a `secret` op.
  - Google redirects to `{WHOMBAT_APP_URL}/connect/google` (`managedGoogleRedirectUri`). The app removes `code` and
    `state` from the address bar at once, reopens the session of the Whombat that started the connect, and sends
    them.
  - The answer is always the return path with `connected=google` or `connect_error=<ConnectErrorCode>`. Navigate
    there.
- A runtime that narrows its allowlist must include both ops. `managed.google_connect` refusals remain possible where a policy turns Google off.

## 0.12.0: plans, activity, the Work view and wider search (Whombat work-supervision, CT-84…CT-88)

- New `api` ops, all non-secret and allowlisted by default: `plans.list`, `plans.create`, `plans.update`,
  `plans.addStep`, `plans.removeStep`, `plans.startStep`, `plans.createCanvas`, `activity.list`, `work.overview`
  (`plans.get` and `plans.updateStep` existed).
- Session events carry the new realtime events `activity.updated` (topics `conv`, `run`) and `dispatch.updated`
  (`conv`), authorized as `/ws` authorizes them: members of the conversation only.
- The protocol version and capabilities are unchanged.

## 0.14.0: the Vault (docs/decisions/vault.md VT-58, CT-97…CT-105)

- New `api` ops, allowlisted by default:
  - `vault.list`, `vault.get`, `vault.create`, `vault.update`, `vault.setSecret`, `vault.remove`, `vault.check`,
    `vault.setTool`, `vault.giveKey`, `vault.takeKey`, `vault.agentKeys`, `vault.uses` (the caller's own entries in a
    burrow; another person's entry is `not_found`, as one that doesn't exist);
  - `vaultNetworks.list`, `vaultNetworks.add`, `vaultNetworks.remove` (account-level; adding and removing need an admin
    of this Whombat);
  - `packs.bindSecret`.
- **Secret ops:** `vault.create` and `vault.setSecret` carry the entry's secret, so their receipts keep no input digest
  and no result, and a retry after a lost answer gets `unknown_outcome` (CT-44). `packs.setSecret` already was one; it
  now saves the value as a `secret` entry in the caller's Vault. No other Vault op carries a secret, and no answer ever
  holds one.
- Refusals carry `details.code` (`VaultErrorCode`): `address_not_allowed` (with `details.problem` and, for a home-network
  address, `details.suggestion {cidr, port}`), `limit_reached` (`details.limit`, `details.max`), `not_eligible_agent`
  (`details.reason`), `wrong_kind`, `admins_only`, `network_listed`, `pack_not_configurable`.
- Session events carry the realtime `vault.updated {entryId | null}` on topic `me`, only to the entry's owner, and
  `audit.appended` frames personalised with `AuditEvent.vault` for the owner (VT-52), as `/ws` sends them.
- The protocol version and capabilities are unchanged.

## 0.20.0: the browser's logins and Spend (Whombat browser.md, vault.md VT-D28…VT-D33, spend.md; CT-125…CT-129)

- New `api` ops, allowlisted by default: `vault.testSignIn`, `spend.overview`, `spend.agent`. None is a secret op.
- **`vault.testSignIn` is an export op** (`EXPORT_OPS`, with `packs.export`): its answer holds a screenshot of up to
  2 MB, larger than one CONTROL message, so a client reads it only through `open{spec: {kind: 'export', op, input}}`
  (JSON). It has no receipt: a retry signs in again. The screenshot is never stored or logged.
- `host.info` and `host.agents` answer an optional `browser {state, reason}`.
- The protocol version and capabilities are unchanged.

## 0.29.0: retry safety per operation (CT-194)

- Every `OperationSpec` carries two more facts, from one hand-kept table (`OPERATION_SAFETY`, one entry per op of
  `API_OPERATIONS` and `SESSION_OPERATIONS`; a missing or extra entry fails typecheck):
  - `destructive`: irreversible or high-impact (removals, revocations, merges, decisions that act, cancelled runs,
    redactions, a replaced recovery key, another device let in). Never sent again by a client on its own.
  - `retry`: `safe` (doesn't mutate: ask again), `receipt` (everything the op does before its first commit is harmless
    to repeat, and that commit accepts its receipt) or `never` (effects outside the receipt's transaction, no receipt a
    retry could meet — ephemeral, export and session-excluded ops — or a `secret` op's receipt without a digest).
- After a lost answer a client asks `status` first (except for `safe` ops, which it simply asks again) and takes the
  stored outcome. It sends the same request again — same id, exact input — only when `status` answered `not_found`,
  the op is `receipt` and not destructive (`resendAfterNotFound`), and the appliance never acknowledged the request
  (`accepted`, or `status` saying `accepted`/`executing`). Everything else, and every op a client doesn't know, is
  reported as an unknown outcome for a person to settle.
- `not_found` means “never committed” only within the receipt retention and only before an acknowledgement: a runtime
  sweeps finished receipts after `WHOMBAT_COMMAND_RECEIPT_HOURS` (7 days by default), so for a request seen accepted it
  means the receipt expired (`nextCommandState` keeps `accepted` on `not_found`).
- `not_found` doesn't prove a `never` op had no effect: a runtime cancels the commit of a request whose session closed
  before it was accepted, so an effect that came first (a GitHub merge, a repository on disk, a provider CLI) stays.
  On the enrollment channel the receipt is kept under the account the device enrolls into, while `status` from the
  unenrolled device can't see it; those ops are all `never`.
- Client-local metadata: nothing new on the wire, no feature name, no `SESSION_API_LEVEL` change. It authorizes
  nothing and makes nothing idempotent; the runtime's receipts do (`(principal, op, id)` bound to `receiptDigest`).
- The protocol version and capabilities are unchanged.

## 0.29.1: corrections and redacted outcomes (CT-195)

- Six destructive ops that act before their commit are `retry: never` (they were `receipt`): `connections.remove`,
  `signins.logout`, `providers.logout`, `signins.orgRemove`, `providers.org.remove` and `clients.remove`. Clients never
  resent them by themselves anyway (destructive); a command tracker no longer calls them “not sent” after `not_found`.
- `automations.webhook` is a `secret` op (`SECRET_API_OPS`): its answer may carry a new webhook secret. Managed
  runtimes refuse it over a session, so nothing changes on a session today.
- `OPERATION_SAFETY` and its entries are frozen.
- **`outcome.redacted` means “known, but the result isn't kept”**, not only “a secret op”. A runtime also answers
  `outcome{state: completed, redacted: true}` for a command committed by a process that died before storing its result
  (it used to answer `accepted` for ever) and for one whose handler failed after its commit while reading its result
  back (it used to answer `rejected`). The client treats it as done — `OutcomeRedactedError` with state `completed` — and
  fetches the current state; it never resends. `redacted` never comes with `rejected`. No wire change: clients since
  0.5.1 already read `completed` + `redacted` this way.
- The protocol version, capabilities, `SESSION_API_LEVEL` and `RUNTIME_FEATURES` are unchanged.

## After 0.29.1: `unknown_outcome` beyond secret ops (CT-196, docs only)

- A runtime that knows a command acted outside its commit (an outside effect: GitHub, a provider, git on disk …)
  before its answer was lost answers `status` with `outcome{state: rejected, error: {code: unknown_outcome}}`, and a
  same-id retry with `error{unknown_outcome}`, for any op, not only a `secret` one. The wire has no other way to say
  “it may have happened”.
- `outcome{rejected, error.code: unknown_outcome}` means **unknown**, not rejected: a client reports an unknown
  outcome (the command may have happened), never resends it by itself and never shows it as refused; a person checks
  the current state. Older clients read it as a rejection with an unknown code, which is wrong but safe (no resend).
- No schema, version, `SESSION_API_LEVEL` or feature change.

## 0.79.0: backup files (CT-335)

An owner makes an encrypted file of chosen categories, downloads it, and uploads it again to restore (Whombat
backup-file.md; `@whombat/core/backup`, `api.backups`; feature `backup.file`; `packages/protocol/src/session/
backup-file.ts`).

- **Ops** (`api.backups.*`, owners only, people only): `backups.defaults`, `setDefaults`, `estimate`, `list`, `create`,
  `get`, `remove`, `stage`, `getUpload`, `removeUpload`, `inspect`, `restore`, `getRestore`. `create`, `inspect` and
  `restore` carry the file's password: they are `secret` ops (no input digest, no kept result) and `retry: never`.
  `restore` isn't destructive (it only adds and updates) but is never resent; `remove` and `removeUpload` are
  destructive.
- **Download**: `open{download, resource: {type: 'backup-file', burrow, backupFileId}, range?}`. Resume with
  `range.start`. Refused with `details.code: backup_file.expired` after its 24 hours.
- **Upload**: `backups.stage {fileName, size, sha256}` → `upload.id`, then `open{upload, target: {type: 'backup-file',
  burrow, stagedBackupId}, size, sha256, chunkSize}` with the staged size (and sha256), resumable like attachments;
  `stream_done.output` is `BackupFileStagedUploadOutput {stagedBackupId, size, sha256}`. A mismatch is refused with
  `backup_file.upload_mismatch`.
- **Then** `backups.inspect {password}` (the preview) and `backups.restore {password, categories, onDifferent}` (a
  job; `backups.getRestore` and the `backups.changed` event on the maker's `me` topic follow it).
- Errors: `error.details.code` `backup_file.<code>` (`APP_ERROR_CODES`, core `BACKUP_FILE_ERROR_CODES` with their
  sentences).
- `SESSION_API_LEVEL` stays 38: new ops, new stream resources a client opens only where the runtime has the feature,
  and an event older clients skip.

## 0.80.1: consoles through the session (CT-350)

- **Open**: `open{stream, spec: {kind: 'console', burrow, sessionId, token}}` with `hosts.createConsole`'s answer (a
  secret op). The appliance checks the token as its console WebSocket does (the session's person, an owner of the
  burrow that sees servers, the same session, single use within 30 s), connects the hosts service's console and only
  then answers `opened{meta: {kind: 'console', protocol}}`. Refusals: `error{stream_refused}` with `details.code`
  `console_refused` (open the console again) or `hosts_unavailable` (try later).
- **DATA**: the console's messages unchanged (`kind (1 byte) | channel (u16 BE) | payload`; kind 0 data, kind 1 a JSON
  control), each `[u32 len][message]`, ≤ `CONSOLE_MAX_MESSAGE_BYTES` (2 MiB), spanning frames freely
  (`@whombat/protocol/console`). Credit is granted as messages are handed on, so it paces both directions.
- **Close**: END from either side ends the console; the hub's `closed` control (with its reason) arrives in DATA before
  the appliance's END. RESET aborts (`cancelled`, or `internal` when the service's socket failed).
- Capability **`stream.console`**: without it (an older runtime) a client keeps consoles on the local network.
- Also in 0.80.1 (no level change, CT-344): REST `unavailable` (503), `watch.acknowledge`, `chats.unarchive`, `ChatLink`,
  `ConnectionCallAction.params.words`, device action units and reading choices, `RepositoryName` `whombat-hosts`.

## 0.80.2 (CT-351)

- `HostServerDetail.workloads` is a partial record (a host has only the platforms it runs); no session change.

## 0.80.3 (CT-352)

- `needsYou.ignore` (receipt): a person ignores a Needs you item for good, or takes that back; no level change.

## 0.81.0: full Proxmox support (CT-353…CT-356)

- `hosts.manageRead` op `backupjob.list` → `{op, items: HostBackupJob[]}`; `hosts.manage` ops `backupjob.create`,
  `backupjob.update` (the job's `digest`), `backupjob.delete` (`confirm`, destructive) and `backupjob.run` (a task).
  Feature **`hosts.backup_jobs`**: a client shows a server's backup jobs only on runtimes that have it.
- The Servers connection's tools grow to 34 (`SERVERS_TOOLS`); `SensitiveRule.arg`. No new op ids, so no
  `OPERATION_SAFETY` change; `SESSION_API_LEVEL` stays 39.

## 0.82.0: the assistant's own name and face (CT-357…CT-360)

- `agents.update` takes `look` (one of the five characters; an assistant's only). `Agent.look` is drawn again through
  `agentFace`. Feature **`agents.look`**: a client offers the face picker only on runtimes that have it. No new op ids,
  so no `OPERATION_SAFETY` change; `SESSION_API_LEVEL` stays 39.

## 0.82.1 (CT-361)

- No wire change: `personalAgentMayHold`, `grantFitProblem` and `KeyRequestAgent` take the assistant shell
  (an assistant may hold a team agent's keys there), `assistantShellGrants`.

## 0.83.0: full Incus and unRAID support (CT-363…CT-368)

- `HostServerPlatform` + `incus`, `unraid`; `HostManagePlatform` + `unraid`; `HostGuest.self`, `autostart`, `webUi`,
  `template`; `hostsThisWhombat` on servers; `HostServerDetail.incus` and `unraid`.
- `hosts.manageRead` ops `profile.get`, `network.leases`, `log.get` (query `project`, `profile`, `network`, `lines`);
  `hosts.manage` gains the Incus ops (`guest.rename`, `guest.move`, `guest.publish`, `image.*`, `profile.*`,
  `volume.*`) and the unRAID ops (`array.*`, `parity.*`, `disk.spin_*`, `mover.start`, `plugin.*`,
  `notification.archive`, `container.update`, `containers.check`, `guest.autostart`). Features **`hosts.incus`**,
  **`hosts.unraid`**.
- The Servers connection's tools grow to 49. No new op ids, so no `OPERATION_SAFETY` change; `SESSION_API_LEVEL` stays
  39.

## 0.84.0: QEMU/KVM through libvirt (CT-369…CT-372)

- `HostServerPlatform` + `libvirt`; `HostManagePlatform` + `libvirt`; `HostServerDetail.libvirt`;
  `HostChoices.networks`, `osVariants`, `firmware`. The existing `hosts.manage` / `hosts.manageRead` ops take
  `platform: libvirt` (no new op names). Feature **`hosts.libvirt`**.
- The Servers connection's tools grow to 50 (`libvirt_overview`). No new op ids; `SESSION_API_LEVEL` stays 39.

## 0.85.0: add a server by signing in once (CT-373…CT-379)

- `hosts.createEnrollment` takes an optional body `{control?, name?}` (an empty POST stays valid); `HostEnrollment`
  adds `control`, `preApproved`, `HostPendingEnrollment` `control`, `name`.
- New ops **`hosts.startInstall`** (a `secret` op, `never`: the server's password) and **`hosts.getInstall`** (`safe`);
  the event **`hosts.install {installId, state}`** on the `hosts` topic. Feature **`hosts.install`**.
- The Servers connection's tools grow to 51 (`server_add`); guide topic `add_server`. `SESSION_API_LEVEL` stays 39.

## 0.86.0: Asks you first (CT-380…CT-382)

- `asksFirst` (`risky` | `never`, optional, absent is `risky`) on the fleet card, the server detail,
  `hosts.serverSettings` and `hosts.updateServer`'s body (owners). `ConnectionCallAction.params.server` `{id, name}`
  (optional): `approvals.decide {scope: 'agent'}` on such an approval also stops the asking on that server. Feature
  **`hosts.asks`**. No new op ids; `SESSION_API_LEVEL` stays 39.

## 0.87.0: Feedback in a chat (CT-383, CT-384)

- `FeedbackIntegrationSettings.channelId` is optional (the assistant shell posts reports in the integration's chat);
  `FeedbackIntegration.channelId` stays set on every saved integration. New `FeedbackIntegration.chat`
  `{id, personId, agentId}` (nullable, default null) and `feedbackChatTitle`. Feature **`feedback.chat`**. No new op
  ids; `SESSION_API_LEVEL` stays 39.

## 0.88.0: Connection pages (CT-390…CT-393)

- New ops **`things.page`** (`safe`), **`things.action`** (destructive, `never`) and **`connections.setRunsOn`**
  (`receipt`). `widgets.list` takes an optional `thing` query; `Widget.thingId` and `ThingSummary.partOf` are optional.
  Feature **`things.pages`**. `SESSION_API_LEVEL` stays 39.

## 0.89.0: Dashboards (CT-394…CT-398)

- `things.page` takes an optional `range` query and answers `range`, `ranges`, `refreshS`; panels gain `place`/`span`,
  figures `spark`/`meter`/`color`, chart cards `figure`/`stats`/`foot`/`style`/`axis`/`forecast`, series
  `color`/`fill`, cells `meter`/`spark`/`button`, and the panel kind `bars`. Feature **`things.dashboards`**. No new
  ops; `SESSION_API_LEVEL` stays 39.

## 0.92.0: All skills (CT-410…CT-420)

- New ops for Settings → Skills (CT-415): **`skills.library`**, **`skills.librarySkill`**, **`skills.librarySkillFile`**
  and **`skills.hubSearch`** (`safe`); **`skills.libraryEdit`**, **`libraryPin`**, **`libraryRest`**,
  **`libraryRestore`**, **`librarySwitch`**, **`libraryAdd`**, **`skills.importPreview`** and **`skills.importCommit`**
  (`receipt`); **`skills.libraryReset`** (destructive, `receipt`). An archive for `skills.importPreview` travels as base64
  JSON like `packs.upload`, so over a session only a link or a small archive fits a request. Feature
  **`skills.library`**. `SESSION_API_LEVEL` stays 39.

## 0.92.1: Skill archives over the session (CT-423)

- **`packs.stage`** takes an optional **`purpose`**: `pack` (the default, at most 4 MiB) or `skills` (at most 25 MiB,
  `SKILL_IMPORT_MAX_BYTES`; any member, for their own assistant). `maxBytes` in the answer is the cap of that purpose.
  The archive then travels through the same `pack-archive` upload stream, and **`skills.importPreview
  {stagedArchiveId, agentId?}`** reads it and consumes it (the caller's own, in that burrow, uploaded, unexpired).
  Feature **`skills.import_staged`**; a runtime without it refuses `purpose`, so a client sends small archives as base64
  there. `SESSION_API_LEVEL` stays 39.

## 0.93.0: Chat (CT-440…CT-448)

- New op **`chats.threads`** (`safe`): a room's threads (`room` `chat` | `feedback`, default `chat`), optionally about
  one subject, newest `lastAt` first, paged by `before` (`next`), 30 per page by default, at most 50. `Message.subject`
  and `ChatSummary.room` are optional. `chats.start` keeps its body and answer and starts a thread in the caller's Chat
  on a runtime with the feature. Feature **`chat.channel`**. `SESSION_API_LEVEL` stays 39.

## 0.96.0: What answers in Chat (CT-456…CT-468)

- New ops **`chats.runtime`** (`safe`): the caller's assistant, its own runtime as a choice, a thread's choice with
  `thread`, and both providers with their models, readiness, fast-reply block and 5-hour usage; and
  **`chats.setThreadRuntime`** (`receipt`): a thread's choice (`null` follows the assistant's own). `chats.start` takes
  an optional `runtime`. `ChatThread.runtime`, `Message.ranOn`, `AgentModelRuntime.fast` and `ProviderModel.fast` are
  optional. Event **`chat.thread_runtime`** on `me`, which older clients skip. Feature **`chat.runtime`**.
  `SESSION_API_LEVEL` stays 39.

## 0.96.1: The Chat box sends its choice with the message (CT-469)

- **`messages.send`** takes an optional `runtime` (`ChatRuntime`): stored as the new thread's choice for a top-level
  message in the sender's own Chat room, ignored elsewhere. `SESSION_API_LEVEL` stays 39.

## 0.97.0: More connections, and mail over IMAP (CT-470…CT-487)

- New ops **`connectors.imapDiscover`** (`receipt`: lookups only, nothing changes) and **`connectors.imapConnect`**
  (`never`, a secret op: it carries the mailbox's password). `ConnectorProvider` gains **`imap`**, `ReauthReason`
  **`password_refused`**; `Connection.mail`, `ConnectionCheck.side` and `ConnectorsStatus.imap` are optional.
  `ConnectionTransport` gains **`socket`** (`CatalogEntry.socket`, the `call` tool). An older client leaves an `imap`
  connection or a `socket` connection out through its tolerant decoding. Feature **`connectors.imap`**.
  `SESSION_API_LEVEL` stays 39.

## 0.98.0: Install a server's updates (CT-500…CT-506)

- `hosts.manage` takes the ops **`packages.check`** and **`packages.install`** (`params.packages?`, 1 to 200 names) with
  `platform: host`, the server's own operating system; `HostManagePlatform` gains **`host`** (also for `hosts.getTask`
  and `task.stop` of a `pkg:…` task). `HostSystem.packageTask`, `HostSystem.packageLast`, `HostTask.packages` and
  `HostTask.code` are optional. Feature **`hosts.package_updates`**. No new op ids; `SESSION_API_LEVEL` stays 39.

## 0.99.0: Server agents keep themselves up to date (CT-510…CT-516)

- New ops **`hosts.agentSettings`** (GET `/burrows/:burrow/hosts/agents/settings` → `HostAgentSettings {autoUpdate,
  halted}`), **`hosts.updateAgentSettings`** (PATCH the same path, `{autoUpdate}`) and **`hosts.updateAgent`** (POST
  `/burrows/:burrow/hosts/servers/:serverId/agent/update`, 202 → `{state: updating | installing}`), owners. Safety:
  the read `safe`, both changes `never` (the hosts service acts outside the receipt).
- `HostServerSettings.agent.update` (`HostAgentUpdate`) gains optional `reasonCode`, `auto`, `waitingFor`,
  `failedVersion`, `updatedAt` and `canInstall`; its `state` gains `waiting` and `halted`, which an older client's
  tolerant decoding leaves out. Feature **`hosts.agent_updates`**. `SESSION_API_LEVEL` stays 39.

## 0.100.0: The desk display (CT-517…CT-534)

- New session-native ops on the `app` channel (Whombat desk-display.md DK-02, DK-04): **`desk.get`** `{}` →
  `DeskScreen` (owners and the paired person), **`desk.startPairing`** `{}` → `{expiresAt}` (owners),
  **`desk.pair`** `{code: ClaimLetters, pin}` → `DeskScreen` (owners; secret), **`desk.setPin`** `{pin}` →
  `DeskScreen` (the paired person; secret), **`desk.update`** (any of `lockedView`, `quietHours`, `night`, `voice`) →
  `DeskScreen` (the paired person), **`desk.unpair`** `{}` → `DeskScreen` (owners) and **`desk.answerUnlock`** `{id,
  unlock}` → `{ok: true}` (the paired person). Inputs are strict; a PIN is six ASCII digits. Safety: `desk.get`
  `safe`; `desk.update` `receipt`; `desk.unpair` `receipt`, destructive; the others `never` (the letters and the
  unlock live in the runtime's memory, outside any receipt; the PIN ops are secret).
- Refusals carry `DeskErrorDetails {code, triesLeft?}`: `wrong_code` (`forbidden`, with `triesLeft`),
  `pairing_expired` and `request_expired` (`expired`), `not_paired` (`conflict`), `not_owner` and `not_paired_person`
  (`forbidden`). Their words are core's `DESK_WORDS.errors`.
- The realtime event **`desk.changed {}`** (topic `me` of the paired person and of owners): refetch `desk.get`. Older
  clients skip it.
- `HostNow.power` (`HostPower`, optional) in `host.metrics`: the battery of a machine that has one (DK-10).
- Feature **`desk`**, advertised while the runtime's desk socket runs. `SESSION_API_LEVEL` stays 39.

## 0.100.1: What the desk may answer, and whose screen it is (CT-535…CT-537)

- `DeskScreen.paired.you` (optional) in `desk.get` and every `desk.*` change: the screen is paired with the caller's
  account. Clients use it and, on older runtimes without it, compare `personId` with the account's principals.
- Core's `deskMayDecide`, by which the runtime decides which asks the desk screen may answer, reads the shell command
  a connection call runs (`server_command`) as running on the server: a command that deletes something (the desk's own
  list over `shellSimpleCommands`: `rm`, `docker rm`, `zfs destroy`, `kubectl delete`, `> file`, …) and what
  `classifyCommand` finds there (`ClassifyContext.runsOn`: destructive, releasing, outside-messaging) stay on the phone,
  and so does a `server_command` whose command it couldn't read. `SESSION_API_LEVEL` stays 39.

## 0.101.0: A desk screen that works at once (CT-538…CT-549)

- `DeskScreen` (in `desk.get` and every `desk.*` change) gains, all optional (Whombat desk-display.md DK-16…DK-20):
  `display {connected, real, builtIn, name}` (what the screen is: `real` is a monitor or a laptop's own panel, not a
  virtual machine's display; `name` the monitor's own, “DELL U2720Q”, or null), `on` (*Show Whombat on this screen*
  now: what an owner chose, else `display.real`), `onChosen` (an owner chose), `paired.hasPin` (false: only the phone
  unlocks the screen until the person chooses a PIN with `desk.setPin`) and `paired.self` (it paired itself, or was
  turned on, rather than by its letters). A client that gets no `display` talks to an older runtime and keeps the 0.100
  screen (letters, PIN, Unpair).
- New op **`desk.setScreen`** `{on: boolean}` → `DeskScreen` (owners). On pairs the screen to the caller without letters
  or a PIN when a screen is connected, else it refuses `no_screen`; off ends the pairing and its PIN and nothing pairs
  itself while it is off. Safety: `receipt`, destructive (as `desk.unpair`). **`desk.unpair`** keeps its shape and now
  means `desk.setScreen {on: false}`.
- Refusals gain `no_screen` and `no_pin` (both `conflict`); `no_pin` is the desk socket's answer to an unlock with a
  PIN on a screen without one, listed so its words are in `DESK_WORDS.errors` with the others.
- `HostNow.cpuTempC` (whole °C) and `HostNow.uptimeS` (seconds), optional, in `host.metrics`.
- Core: `deskStatusLine({…, fresh})` (“All fine. I’m ready when you are.”), `deskBox` (*This Whombat* on the screen) and
  the new `DESK_WORDS` (`status.ready`, `status.connectHint`, `nothingNeedsYou`, `nothingNeedsYouHint`, `noPinYet`,
  `box.*`, the switch's `settings.*`, `errors.no_screen`, `errors.no_pin`).
- No new feature: `desk` covers the op, and `DeskScreen.display` says a runtime has it. `SESSION_API_LEVEL` stays 39.

## 0.102.0: The box's hardware and network (CT-560…CT-575)

- New session-native ops on the `app` channel, owners only (Whombat hardware-support.md HD-03, HD-05…HD-07):
  **`host.hardware`** `{}` → `{hardware: HostHardware | null, reason?: not_managed | unavailable}`; **`host.network`**
  `{}` → `{network: HostNetwork | null, reason?}`; **`host.wifi.scan`** `{}` → `{scan: WifiScan | null, reason?:
  not_managed | unavailable | no_wifi}`; **`host.wifi.join`** `{ssid, passphrase?, hidden?}` → `{change: NetworkChange}`
  (secret: the passphrase); **`host.wifi.forget`** `{ssid}` → `{change}`. Inputs are strict; `ssid` is display text of
  at most 32 UTF-8 bytes (`ssidValid`), a passphrase 8…63 printable ASCII characters or 64 hex digits. Safety: the
  reads `safe`; join and forget `never` (they act on the box outside any receipt), not destructive.
- No realtime event: while `network.change` runs (`networkChangeDone` false), the app polls `host.network` every 2 s. A
  join the box can't reach Whombat on is undone (`reverting` → `reverted` with `failure` and `previous`); a wrong
  password is `failed` with `wrong_password`.
- Refusals carry `WifiErrorDetails {code}`: `no_wifi` (`not_allowed`), `busy` and `in_use` (`conflict`), `not_saved`
  (`not_found`), `invalid_passphrase` (`validation_failed`); a non-owner gets `forbidden`.
- Helpers: `hardwareProblems` (problems first: Wi-Fi, wired, sound, graphics), `hostText`, `wifiSignalFromDbm`,
  `hostNetworkValid`, `networkChangeValid`. No words: kinds, states and failures cross the wire (HD-11).
- Appliance events **`network.wifi_joined`** and **`network.wifi_forgotten`** (`NetworkAuditPayload {ssid, via: app |
  screen, changeId}`, never a passphrase).
- Features **`host.hardware`** and **`host.network`** (managed runtimes). **`SESSION_API_LEVEL` 40** (CT-572).

## 0.103.0: A four-digit PIN, and staying unlocked while you're there (CT-590…CT-600)

- `desk.pair` and `desk.setPin` take a PIN of 4 to 6 digits (`DeskPin`, `^[0-9]{4,6}$`; six until 0.102, and those
  stay valid). Whombat refuses a PIN that is too easy to guess (core `deskPinTooEasy`: one digit repeated, a run up or
  down with 9 and 0 next to each other, a pair or three digits repeated) with **`easy_pin`** (`validation_failed`); the
  schema doesn't, and Settings checks before it sends. An older runtime refuses a PIN shorter than six as invalid, in its
  own words (Whombat desk-display.md DK-34).
- `DeskSettings.presence` (*Stay unlocked while you’re here*, default false) in `desk.get` and every `desk.*` change, and
  `desk.update {presence}` turns it on and off (the paired person's). `DeskScreen.presenceAvailable` (optional): the box
  has a camera the presence service can read, so Settings shows the switch; absent from older runtimes, where a client
  shows no presence row and never sends `presence` (an older runtime's strict input would refuse it).
- Core: `DESK_PIN_MIN`, `DESK_PIN_MAX`, `DeskPinDigits`, `deskPinTooEasy`, `DESK_PRESENCE_GONE_S` (30),
  `DESK_PRESENCE_MAX_S` (4 h), `DESK_PRESENCE_CHECK_S` (2), and the `DESK_WORDS` `unlockedHere`, `cameraOn`,
  `settings.presence`, `settings.presenceHint`, `errors.easy_pin`; `settings.choosePin` now says 4 to 6 digits.
- No new feature: `DeskScreen.presenceAvailable` says a runtime has presence. `SESSION_API_LEVEL` stays 40.

## 0.106.0: Sign in at the box (CT-620…CT-629)

A device that isn't let in asks the box for a code; the box shows six letters on its own screen (the console, the desk
display or the virtual machine's console); the person types them on the device, and the claim's CPace exchange, bound
to both Noise keys, lets the device in to the account it named (Whombat signin-at-box.md BX-02…BX-08). Control and the
relay can't let a device in: the letters never leave the box's screen.

1. `enroll.screen.request {email, endpoint}` → `{signinId, expiresAt}` (ephemeral). The box shows letters for this
   device key for `SCREEN_SIGNIN_TTL_S` (300 s), naming the account and the device; a new request replaces the one
   showing. A device without a pin connects with the directory's PeerId for this exchange only.
2. The client normalizes what was typed (`normalizeScreenSignInLetters`) and computes
   `screenSignInPakeInitiator({password, deviceId, appliancePeerId, clientPeerId, signinId})`.
   `enroll.screen.begin {signinId, share}` → `{share}` (ephemeral; only from the key that asked; the box keeps it for this
   session for `ENROLL_CLAIM_BEGIN_TTL_S`).
3. `screenSignInPakeInitiatorFinish(state, share)` → tags; `enroll.screen {signinId, confirm: tags.client}` →
   `EnrolledOutput + {confirm}`. The client checks `claimConfirmEqual(tags.appliance, confirm)` **before** it trusts the
   result and pins the PeerId (`pinSource: 'screen'` in the app). `enroll.screen` is never resent automatically.

Refusals (`error.details.code`, `SCREEN_SIGNIN_ERROR_STATUS` in brackets):

| Code | When |
|---|---|
| `screen_unavailable` (`unavailable`) | Not claimed, or the box writes no console file (no screen to show on). |
| `screen_no_account` (`not_found`) | No account with that email on the box. |
| `screen_signin_missing` (`conflict`) | No live sign-in with this id for this device key (expired, replaced, used). |
| `screen_begin_missing` (`conflict`) | `enroll.screen` without a live begin on this session for the id, or one made before a wrong guess. |
| `screen_code_invalid` (`forbidden`) | `confirm` didn't match: one wrong guess. The screen shows new letters at once. |
| `screen_backoff` (`rate_limited`) | Too many wrong guesses (`claimBackoffSeconds` on its own counter); `ScreenBackoffDetails {code, retryAt}`. On `request` and `begin`. |
| `screen_share_invalid` (`validation_failed`) | The share isn't a ristretto255 element, or is the identity. Not a guess. |
| `screen_rate_limited` (`rate_limited`) | More than `SCREEN_SIGNIN_REQUESTS_PER_KEY` (5) requests per device key or `SCREEN_SIGNIN_REQUESTS_TOTAL` (30) per box in an hour. |
| `endpoint_enrolled` (`conflict`) | This device key is already let in. |

- `enroll.claim` answers `recoveryKitRequired: false` from 0.106 (BX-01); the member stays.
- `endpoint.enrolled`'s `via` is `screen` for these devices (`ENDPOINT_ENROLLED_VIA`); no new event types.
- The console file gains `signIn` (`ConsoleSignIn`, only in `claimed`; [local-ipc.md](local-ipc.md)).
- No new feature (CT-628): an older runtime answers `unknown_op`. **`SESSION_API_LEVEL` 41** (CT-625).

## 0.109.0: The box's Bluetooth (CT-670…CT-686)

- New session-native ops on the `app` channel, owners only (Whombat bluetooth.md BT-02…BT-07): **`host.bluetooth`**
  `{}` → `{bluetooth: BluetoothState | null, reason?: not_managed | unavailable}`; **`host.bluetooth.scan`** `{}` →
  `{scan: BluetoothScan | null, reason?: not_managed | unavailable | no_bluetooth}` (starts looking, or keeps looking
  60 s more); **`host.bluetooth.pair`** `{address}` → `{pairing}` (stops looking; runs in the background);
  **`host.bluetooth.confirm`** `{pairingId, accept}` → `{pairing}`; **`host.bluetooth.cancel`** `{pairingId}` →
  `{pairing}`; **`host.bluetooth.connect`** and **`host.bluetooth.disconnect`** `{address}` → `{device}`;
  **`host.bluetooth.forget`** `{address}` → `OkOutput {ok: true}`. Inputs are strict; `address` is upper case
  (`AA:BB:CC:DD:EE:FF`), a pairing id `p-` and 8…32 lower-case letters and digits. Safety: the reads `safe`; the rest
  `never` (they act on BlueZ outside any receipt), `disconnect` and `forget` destructive.
- `BluetoothState {adapter, missing?, devices, scan, pairing}`, `BluetoothDevice {address, name, kind, connected,
  battery?, signal?}`, `BluetoothScan {until, devices}`, `BluetoothPairing {id, address, name, kind, phase, deadline,
  code?, typed?, failure?}`: see [local-ipc.md](local-ipc.md) → Bluetooth socket. Kinds `keyboard` · `mouse` · `headphones` ·
  `headset` · `speaker` · `gamepad` · `other`; phases `pairing` · `code` · `confirm` · `connecting` · `done` · `failed`;
  failures `rejected` · `timeout` · `not_found` · `canceled` · `failed`. No words: they cross the wire, the app and the
  console make the words (BT-11).
- No realtime event: while `scan` is there or `pairing` runs (`bluetoothPairingDone` false), the app polls
  `host.bluetooth` every `BLUETOOTH_POLL_MS` (1 s). Timing: `BLUETOOTH_SCAN_S` 60, `BLUETOOTH_PAIRING_S` 90,
  `BLUETOOTH_CONNECT_S` 15, `BLUETOOTH_RESULT_KEEP_S` 60.
- Refusals carry `BluetoothErrorDetails {code}` (`BLUETOOTH_ERRORS`) on `BLUETOOTH_ERROR_STATUS`'s code: `no_bluetooth`
  (`not_allowed`), `busy` (`conflict`; a pairing runs), `not_found` (`not_found`), `not_paired` (`conflict`),
  `unavailable` (`unavailable`; the Bluetooth service didn't answer); a non-owner gets `forbidden`.
- Helpers: `bluetoothSignalFromDbm`, `bluetoothPairingDone`, `bluetoothPairingValid`, `bluetoothStateValid`; names are
  cleaned with `hostText(name, BLUETOOTH_NAME_MAX)`.
- Appliance events **`bluetooth.device_paired`** (a pairing that reached `done`) and **`bluetooth.device_removed`**
  (`BluetoothAuditPayload {name, kind, via: app | screen}`, never an address, BT-10).
- Feature **`host.bluetooth`** (managed runtimes whose Bluetooth socket is configured). **`SESSION_API_LEVEL` 42**
  (CT-678).

## 0.111.0: Connections that sign in properly (CT-730…CT-749)

- New REST-derived ops (Whombat connection-signin.md SG-01…SG-03): **`connections.startServiceLogin`** (POST
  `/burrows/:burrow/connections/service-login/start`, `StartServiceLoginBody {catalogId, scope, label?, fields, access,
  connectionId?}`) → `StartServiceLoginResponse {loginUrl, flowId, pollEveryMs, expiresAt, userCode | null}`, and
  **`connections.pollServiceLogin`** (POST `/connections/service-login/:flowId/poll`) → `PollServiceLoginResponse`,
  Nextcloud's poll union (`pending` · `connected {connection, eventId}` · `expired` · `failed {message}`). Neither is a
  secret op; both `never` resent, as Nextcloud's. A connection made this way is stored as `signIn: 'token'`, so a
  `ConnectionView` never carries the new sign-in kind `service_login`.
- Additive members older runtimes ignore: `connections.create`'s `login.challenge` and `code`, `connections.setSecret`'s
  `code`, and `error.details.challenge` on `second_factor_needed` and a `code` refusal. No enum an answer carries gains
  a value (`CatalogReauthReason`, `ConnectionErrorCode` and `details.reason` are unchanged; a service-login flow that
  ended answers `login_expired`).
- Feature **`connections.service_login`**. **`SESSION_API_LEVEL` 43** (CT-744): a level-43 client serves runtimes
  41…44.

## 0.113.0: Skills without packs (CT-800…CT-823)

- **`skills.stage {burrow, fileName, size, sha256}`** (`receipt`; at most 25 MiB, `SKILL_ARCHIVE_MAX_BYTES`; no `purpose`)
  → `{stagedArchiveId, expiresAt, maxBytes}`; the archive travels through the **`skill-archive`** upload target
  (`stream_done.output` `SkillStagedUploadOutput`), then `skills.importPreview {stagedArchiveId}` reads it (CT-817).
  Refusals `skill_archive_too_large`, `skill_staged_mismatch`, `skill_staged_not_found`, `skill_staged_incomplete`,
  `skill_staged_expired`, `skill_staged_used`.
- Gone: every `packs.*` op (the REST-derived ones, `packs.stage`, `packs.import`, `packs.importBundled`), the
  `pack-archive` target and the `pack_*` codes; `packs.export` leaves `EXPORT_OPS` and `packs.setSecret`
  `SECRET_API_OPS`.
- The `skills.*` library answers are keyed by skill name, with `category`, `origin`, `changed` and `skv_` versions; rows
  keep the fields phones of 0.114 and older read (`key`, `pack`, `packTitle`, `source`, …, CT-822), and requests take and
  ignore `pack`.
- Feature **`skills.store`**; the runtime stops advertising `packs`. **`SESSION_API_LEVEL` 44** (CT-818): a level-44
  client serves runtimes 42…45, and level-43 phones serve a level-44 runtime.

## 0.117.0: Servers in backups (CT-900…CT-914)

- New REST-derived ops (Whombat backup-file.md BF-15, BF-16): **`hosts.addressChange`** (`safe`; GET
  `/burrows/:burrow/hosts/address-change` → `HostAddressChange | null`), **`hosts.repoint`** (`never`, not secret; POST
  `/hosts/repoints`, `HostRepointBody {servers}` → 202 `HostRepoint`) and **`hosts.getRepoint`** (`safe`); the event
  **`hosts.repoint {repointId, state}`** on the `hosts` topic. Feature **`hosts.repoint`**.
- Backup files: the category **`servers`** (older apps drop the unknown row), `BackupCategoryEstimate.offered`,
  `RestoreBackupBody.servers {pointHere}`, `BackupRestorePreview.servers`, `BackupRestoreSummary.servers`; record schema
  version 3 (older runtimes refuse new files with `newer_format`). **`SESSION_API_LEVEL` stays 44** (CT-913).

## 0.119.0: Clearing Chat (CT-990…CT-994)

- New REST-derived op (Whombat chat-clear.md CHC-01…CHC-07): **`chats.clear`** (`receipt`; POST `/burrows/:burrow/chats/clear`,
  `ClearChatBody {room}` → `ClearChatResponse {room, conversationId, clearedAt, cleared}`); the event **`chat.cleared
  {conversationId, room, clearedAt}`** on topic `me`. Feature **`chat.clear`**. **`SESSION_API_LEVEL` stays 44** (CT-994).

## 0.120.0: Remote help (CT-930…CT-949)

- New session-native ops (Whombat remote-help.md RH-01…RH-09), owners only (`not_owner`):
  **`remoteHelp.get`** (`{}` → `RemoteHelpState`, `safe`), **`remoteHelp.confirmBegin`** (`{level, duration}` →
  `{nonce, options}`, both null for an owner without a passkey; ephemeral like `passkey.register.begin`, `never`),
  **`remoteHelp.start`** (`{level, duration, passkey?}` → `RemoteHelpState`; secret: its answer holds a prod box's help
  code, kept in no receipt; `never`, destructive: it lets someone into the box), **`remoteHelp.stop`** (`{}` → `RemoteHelpState`, `receipt`, idempotent), **`remoteHelp.visits`**
  (`{before?, limit?}` → `{visits}`, `safe`) and **`remoteHelp.transcript`** (`{visitId}`, an export op:
  `text/plain; charset=utf-8`, `whombat-remote-help-<visitId>.txt`).
- `RemoteHelpState {available, foreverAllowed, helpCodeRequired, grant: {level, since, until | null, grantedBy
  {accountId, name}, helpCode | null} | null, connected ≤ 8 {visitId, who, since}}`; `RemoteHelpVisit {id, who, level,
  startedAt, endedAt | null, steps ≤ 200, truncated, transcriptBytes}`; `RemoteHelpStep {at, kind, command?, units?,
  line?, seconds?, target?, bytes?, reason?}`. A newer step kind is dropped by tolerant decoding, the visit stays.
- Passkey confirmation: purpose **`whombat-remote-help/1`**, challenge = SHA-256(canonicalJson({purpose, nonce, endpoint,
  level, duration})) with `endpoint` the caller's session PeerId (`passkeyRemoteHelpChallenge(Base64url)`);
  `options` is `WebAuthnRequestOptions {challenge, rpId, allowCredentials, userVerification, timeout?}`; the client
  recomputes the challenge and refuses another. The assertion is `WebAuthnAuthenticationResponse`.
- Refusals (`error.details.code`): `remote_help_unavailable`, `forever_not_allowed`, `passkey_required`,
  `passkey_failed`, `remote_help_busy`. Appliance events `remote_help.on {level, duration}`, `remote_help.off {reason:
  owner | desk | expired | wrong_codes}`, `remote_help.visit {visitId?, who, level, startedAt, endedAt | null, steps}`.
- Feature **`remote_help`**. **`SESSION_API_LEVEL` 45** (CT-933): a level-45 client serves runtimes 43…46, and level-44
  apps serve a level-45 runtime.

## 0.122.0: Quiet notices (CT-1060…CT-1068)

- New REST-derived ops (Whombat quiet-notices.md QN-10…QN-15): **`things.quiet`** (`never`, not destructive; POST
  `/burrows/:burrow/things/:thing/quiet`, `QuietNoticeBody {notice {check, subject?}, how: ignore | snooze | undo,
  until?}` → `QuietNoticeResponse {notice, quiet | null}`; a server's alert is acknowledged in the hosts service,
  outside the receipt), **`things.watch`** (`safe`; GET `…/watch` → `ThingWatch {checks, mayChange}`) and
  **`things.setWatch`** (`never`; POST `…/watch`, `SetThingWatchBody {check, subject?, watched}` → `ThingWatch`).
  Refusals `not_allowed` (403) and `not_found`. Feature **`things.quiet`**.
- Optional members a tolerant client strips: `ThingPageNotice.nature`, `.check`, `.subject`, `.ignore`, `.quiet`;
  `NeedsYouItem.nature`, `WatchItem.nature`; `HostAlert.entity`, `.key`, `.quiet`; `HostHint.id`, `.quiet`;
  `HostBanner.rule`, `.alertId` (CT-1068). `needsYou.ignore` on `alert`
  and `connection` items is the shared Ignore. **`SESSION_API_LEVEL` stays 45** (CT-1063).

## 0.123.0: One agent (CT-1100…CT-1144)

- A Whombat has exactly one agent (Whombat one-agent.md OA-01…OA-24). **`api.agents.*` → `api.agent.*`** without the
  `:agent` param (`agent.get`, `agent.update {name?, face?, runtime?}`, `agent.setRuntime`, `agent.setCredentialSource`,
  `agent.setKeys`, `agent.commandAllowances`, `agent.removeCommandAllowance`); `agents.list`, `agents.hire`,
  `agents.retire`, `agents.setChannels`, `agents.setCredentialOwner` gone. Per-agent paths lose `:agent` (computer,
  schedules, notes, context, learned skills, skill links and uses); `spend.agent` → **`spend.week`**.
- Gone: `plans.delegate`, `plans.reportBack`, `plans.askReport`, `messages.ask`, `vault.agentKeys`, `skills.libraryAdd`,
  `conversations.getChannel`, `createChannel`, `addMembers`, `removeMember`, `openDm`, `openDirect`, `browse`, `join`,
  `archive`, `clear`. `ConversationKind` is `dm` | `branch`. `vault.giveKey`, `takeKey`, `setKeyServers`,
  `setKeyDelivery` work on `/vault/:entryId/key…` (the entry's on/off for the agent).
- `Principal` gains kind `system` (`SystemPrincipal`); `Agent` is `{…, face, status, doing, runtime}`. `CredentialSource`
  is `requester` | `org` | `member`. Features `delegation`, `roles`, `agents.retire`, `agents.focus`, `agents.role_skills`,
  `agents.fixed_names`, `agents.pass_on`, `agents.look`, `messages.reply_to`, `messages.ask_agent`,
  `connections.looked_after`, `shell.assistant`, `channels.clear`, `feedback.chat` removed. Licence limits lose
  `agents`; `licence.status`'s `usage` and `licence.limit`'s `details.limit` count no agents (CT-1138). `work.overview`
  items carry no `handoff`, and `WorkAction` has no `reassign_step` or `ask_for_report` (CT-1137).
- **`SESSION_API_LEVEL` 46** (CT-1126). No compatibility with older apps or runtimes (OA-24 leaves skew support for later
  steps, but nothing here keeps the removed shapes).

## 0.124.0: Hermes is the only engine (CT-1150…CT-1179)

- Every turn runs on Hermes (Whombat hermes-engine.md step 2). **`AgentProvider` is `claude` | `codex` | `local`**: no
  ACP runtimes, no `scripted`. `host.agents` (`AgentSetupStatus`) has no `mode`, `acpRuntimes` or capability matrix and
  gains **`hermes`** (`HermesCheck {ready, version, problem, detail}`, null until a runner reported); the agent can't
  reply while Hermes isn't ready (`ENGINE_PROBLEM_COPY` says what to do, never naming it).
- A model on the owner's network: **`Burrow.localModel`** (`LocalModelView`, never the key) and the owners' ops
  **`burrows.setLocalModel`**, **`burrows.testLocalModel`** (both secret: the key) and **`burrows.clearLocalModel`**
  (destructive), feature **`ai.local_model`**. `chats.runtime` and a thread's choice take the provider `local`
  (“Local”, its models `localProviderModels`, no effort, no fast replies); `ModelFallbackWhere.kind` takes `local`.
- `activity.list` loses `reported`; the error code `managed.acp_runtimes` is gone.
- **`SESSION_API_LEVEL` 47** (CT-1179). No compatibility with older apps or runtimes.

## 0.125.0: Hermes keeps memory and skills (CT-1200…CT-1249)

- What the agent remembers is Hermes's, per person (Whombat hermes-engine.md step 3): **`memory.mine`**,
  **`memory.write`** (receipt; `too_long`, `conflict`, `busy`) and **`memory.clear`** (destructive) on the caller's own
  `PersonMemory {memory, user}`; the agent's notes for everyone **`memory.notes`** and **`memory.setNotes`** (owners).
  Every other `memory.*` op is gone; feature **`memory.hermes`** (`agents.memory` gone).
- Settings → Skills on Hermes's skills: `SkillLibraryItem` with `scope` (`everyone` | `mine`) and `source` (`shipped` |
  `added` | `learned`); **`skills.libraryRemove`**, **`skills.libraryShare`** (both destructive),
  **`skills.shareRequest`**; `libraryPin`, `libraryRest`, `libraryReset`, versions, proposals, skill uses and links are
  gone. Approvals gain **`skill_share`** and lose `vault_use`; the desk's phone reason `share` replaces `vault`. Feature
  **`skills.hermes`** (`skills.learned` gone). No `skill` card, no `skillHint` on messages or `messages.send`.
- The Vault without Ask: `vault.giveKey {servers?, envName?}`, **`vault.setKeyEnvName`** (replaces `setKeyDelivery`),
  `VaultKeyView {givenAt, servers, envName}`, `VaultUse` one row per turn; `vault.testSignIn` and its export op are
  gone; `HostInfo.browser` and `host.agents`' `browser` are gone.
- **`skills.importPreview` is an export op** (`EXPORT_OPS`): a client reads it through an export stream (a big archive's
  preview outgrows one CONTROL message) and never resends it on its own.
- **`SESSION_API_LEVEL` 48** (CT-1248). No compatibility with older apps or runtimes.

## 1.0.0: one product shape — session major 2, the direct connection, Tailscale, no compatibility (CT-1250…CT-1299)

- **Session major 2** (CT-1260): `hello.versions` is `[SESSION_PROTOCOL]`; a box answers only its own major, else
  `unsupported_version` (`whoMustUpdate`, `VERSION_REFUSAL_COPY`). `welcome.runtime`, runtime features, API levels and
  windows are gone; a 0.x app and a 1.0 box refuse each other through exactly that error.
- **Directly to the box** (CT-1250…CT-1252): the direct listener (`/v1/direct`, `whombat-direct.v1`, port 4480, no
  ticket), and **`welcome.direct`** (`DirectAddresses`, null on the enrollment channel).
- **Tailscale for This Whombat** (CT-1253, CT-1254, owners): **`host.tailscale`** (read), **`host.tailscale.on`**,
  **`host.tailscale.off`** (`{signOut?}`, destructive) and **`host.tailscale.signIn`** → `TailscaleStatus`.
- **`enroll.dev`** (CT-1257): a development runtime lets a browser on the machine in; anything else answers
  `forbidden` / `dev_only`.
- Gone (HE-48): `auth.*` (sign-in links, cookies, tokens, Tailscale identity), `agent.setRuntime`,
  `burrows.setWorkdir`, the session-native `providers.*` ops (use `signins.*`), `HostInfo.home` and `.workdirRoots`,
  `Run.access`, `GitHubStatusResponse.via`, `ClientStatus.installed.source`, and the self-hosted `managed.*`
  refusals.

## 1.1.0: the community edition (CT-1300…CT-1349)

Additions within major 2; `SESSION_PROTOCOL` is `{major: 2, minor: 1}` (CT-1310).

- **The edition** (CT-1300, CT-1301): `welcome.edition` (`commercial` | `community`, absent = `commercial`) and
  `DirectIdentity` (a plain GET of `/v1/direct`). `editionHas(edition, part)`: a community box has no relay, control,
  remote help, licence or phone push, and claims on its own page.
- **The claim on the box's own page** (CT-1302, community only; enrollment channel):
  `enroll.claim.local.start {}` → `{claimId, expiresAt}` (ephemeral), `enroll.claim.local.begin {claimId, share}` →
  `{share}` (ephemeral), `enroll.claim.local {claimId, confirm, account, endpoint}` → `EnrollClaimOutput` (the first
  owner). CPace with its own binding (`localClaimPake*`); the claim's letters, rotation and backoff. A commercial box
  answers `claim_local_unavailable`.
- **Links the box makes** (CT-1304): `enroll.invite.create` and `enroll.reenroll.create` answer an optional `link` to
  the box's own page (`parseLocalLink`: the secret, the PeerId to pin, the ways); the accept ops work over the direct
  path unchanged.
- **Device links** (CT-1305): `enroll.link.create {}` → `{linkId, secret, expiresAt, link}` (secret) and, on the new
  device, `enroll.link.accept {secret, endpoint}` → `EnrolledOutput` (enrollment channel, secret, `via: 'link'`).
- **Tailscale's login server** (CT-1306): `host.tailscale.on {loginServer?}` (absent keeps, `null` = Tailscale's own),
  `TailscaleStatus.loginServer`; open a login link only when `tailscaleLoginUrlTrusted`. Signed events `tailscale.on`,
  `tailscale.off`, `tailscale.sign_in`.
- **Web Push from the box** (CT-1307): `devices.vapidKey` over the session (`push.web_unavailable` without a key).
- **The owner's mail server** (CT-1308, owners): `host.mail`, `host.mail.set` (secret), `host.mail.test {draft?}`
  (secret; to the owner's own email), `host.mail.remove` (destructive). Signed events `mail.set`, `mail.removed`.
- `passkeys_unavailable_here` is a documented code (CT-1309).

## 2.0.0: Hermes's skills only — session major 3 (CT-1400…CT-1449)

Settings → Skills runs on Hermes Agent's own skills, hub and scanner (Whombat hermes-skills.md HSK-01…HSK-16). Ops went
and the library's answer changed meaning, so **`SESSION_PROTOCOL` is `{major: 3, minor: 0}`** (CT-1432): a 1.x app or box
(major 2) and a 2.0 one refuse each other with `unsupported_version` and say who must update.

- **Gone**: `skills.importPreview`, `skills.importCommit`, Whombat's own `skills.hubSearch` (skills.sh, ClawHub, Hermes's
  and Anthropic's), `skills.stage` and the **`skill-archive`** upload target; the codes `skill_archive_too_large` and
  `skill_staged_*`. `EXPORT_OPS` is empty.
- **Changed**: `SkillLibraryItem` has `origin` (`builtin` | `hub` | `shared` | `learned`) and `hub {source, identifier,
  trust, updateAvailable}` instead of `source` and `group`; `status` is `on` | `off` | `removed`; `needs {env, commands,
  files}` (the skill's own front matter) replaces `missing`; `can.update`. `skills.library` answers Hermes's
  `categories`. `changed`, `originalChanged`, Restore and Compare are about a built-in and Hermes's version of it;
  `librarySkill`'s `original` gains `changes` (Hermes's diff, file by file).
- **New** (owners): **`skills.hubSearch {q?, source?}`** (Hermes's hub over `official`, `github` with Hermes's default
  taps, `skills-sh`; `q` absent browses), **`skills.hubPreview {identifier}`** (the `SKILL.md`, files, needs, Hermes's
  scan and its policy's decision with the reason in words), **`skills.hubInstall {identifier}`** and
  **`skills.hubUpdate {name}`** (both `never` resent: they fetch from outside before the commit), **`skills.hubUpdates`**
  (Hermes's update check, at most once an hour). Codes `skill_hub_unavailable`, `skill_blocked`, `skill_exists`.
- **Large reads** (`EXPORT_READ_OPS`, CT-1418): `skills.library`, `.librarySkill`, `.librarySkillFile`,
  `.shareRequest`, `.hubSearch` and `.hubPreview` can outgrow a 64 KiB CONTROL message; a client reads them through an
  export stream from the start. Every change answers one row, far inside one message (a size test pins it).

## 3.0.0: one person per Whombat, no computer — session major 4 (CT-1500…CT-1599)

A Whombat is one person's device and the agent has no computer (Whombat one-person.md OP-01…OP-19). Ops went and
answers changed meaning, so **`SESSION_PROTOCOL` is `{major: 4, minor: 0}`** (CT-1540): a 2.x app or box (major 3) and a
3.0 one refuse each other with `unsupported_version` and say who must update.

- **Gone** (session-native): `enroll.invite.create`, `.accept`, `.revoke`; `enroll.reenroll.create`, `.accept`,
  `.status`, `.list`, `.confirm`, `.revoke`; `admins.list`, `.grant`, `.revoke`; `presence.typing`, `presence.set`. The
  enrolment channel keeps the claim, pairing, device links, recovery, passkeys, the box's screen and `enroll.dev`.
- **Gone** (`api` ops): `members.*`, `computers.*`, `agent.setCredentialSource`, `signins.orgList`,
  `.orgLoginStart`, `.orgRemove`, `skills.libraryShare`, `skills.shareRequest` (and from `EXPORT_READ_OPS`).
- **Changed**: `enroll.screen.request {endpoint}` and `enroll.pair.request {endpoint}` (no email);
  `endpoints.list {}`; `appliance.status` without `owner` and the recovery kit's owner; `desk.*` without owner refusals;
  `LocalLinkKind` is `device` only; the `typing` event is the agent's thinking line only; `Bootstrap` has no presence;
  `host.metrics` counts containers (`containersMemoryBytes`, disk part `containers`, no `computersIn/OutBytes`);
  `HostInfo.services` replaces `.computers`; the backup categories have `settings` for `people`; `usage.list` is the
  person's, `spend.*` has no scope; licence usage `{connectors}`.
- **New**: **`services.list`** (read) and **`services.stop {id}`** (destructive, its receipt), the `services.changed`
  event (topic `burrow`).

## 4.3.0: the own address (CT-1743…CT-1755)

Each Whombat's own page at `<label>.box.whombat.app`, TLS on the box (Whombat own-address.md). Additions only:
`SESSION_PROTOCOL` stays; a box before 4.3 answers `unknown_op`, which a client reads as “no own address yet”.

- **`ownAddress.status`** (`{}` → `{ownAddress: OwnAddressSummary | null}`, `safe`) and **`ownAddress.reach.set`**
  (`{on}` → `{ownAddress}`, owners, `receipt`); `appliance.status.ownAddress` carries the same summary.
- **`account.link.lookup`** (`{code}` → `{email, expiresAt}`, `safe`) and **`account.link`** (`{code}` →
  `{email, linkedAt}`, owners, `never`: it acts at control before it commits). Refusals `ACCOUNT_LINK_ERROR_CODES`.
- **Box passkeys**: **`boxPasskey.enroll.begin`** and **`boxPasskey.enroll`** on the enrolment channel (any session),
  **`boxPasskey.register.begin`** and **`boxPasskey.register`** (enrolled); all `never`, the begins ephemeral.
  `PasskeySummary.rpId` marks a box passkey; `passkeys.list` and `passkey.remove` cover both kinds.
- **`enroll.claim.local.start {link?}`**: the claim link's secret, required on a door session to an unclaimed box
  with its own address (`claim_link`). The box keeps it with the start on that session and checks it again when the
  exchange begins there.
- **Device links** carry the own address as `o=` (`parseLocalLink` → `own`).

## 4.4.0: Whombat Link (CT-1756…CT-1766)

Reach and Updates in Settings → This Whombat (Whombat whombat-link.md). Additions only: `SESSION_PROTOCOL` stays; a box
before 4.4 answers `unknown_op`, which a client reads as “no Link or channel here yet”.

- **`reach.get`** (`{}` → `{link: LinkSummary | null, ownAddress: OwnAddressSummary | null, tailscale: TailscaleStatus
  | null}`, `safe`): how the box is reached, each part null when the box can't have it.
- **`link.on`** and **`link.off`** (`{}` → `{link: LinkSummary}`, owners, `never`: they act at control first; audited
  `link.on`, `link.off`). `LinkSummary {state, since, pending?: {code, url, expiresAt}, waitingForAddress?,
  graceEndsAt?, trialEndsAt?, email?}`. Refusals `LINK_ERROR_CODES` (`whombat_link_*`, `control_unreachable`).
- **`updates.channel.get`** (`safe`) and **`updates.channel.set`** (`{channel}`, owners, `never`; audited
  `update.channel_set`) → `{channel: production | development, staysOn?}`; `update_channel_unavailable`.
- **`push.token.set`** (`{token: NativePushToken}` → `{registered}`, `receipt`) and **`push.token.clear`** (`{}`): the
  phone's APNs or FCM token for its box, which registers it at control while Link is on.
- Appliance events `link.on`, `link.off`, `link.state_changed` (control moved it) and `update.channel_set`.

## 4.5.0: why a connection can't start (CT-1770)

- **`connections.catalog`**: `CatalogEntryStatus.reason` gains `needs_secure_address` (the entry's sign-in must come
  back to a secure address this box doesn't have: Whombat Link, or Tailscale with HTTPS) and `hosted_only` (its client
  is registered on the hosted page only). An older client's `decodeTolerant` reads such a reason as null: the entry
  stays unavailable, without saying why.

## Session minor 1 of major 5: the local claim's proof round

`SESSION_PROTOCOL` is `{major: 5, minor: 1}`. No contracts release: control and the relay don't speak these operations.

- **`enroll.claim.local.prove {claimId, confirm}` → `{confirm}`** (enrollment channel, ephemeral, `never`): the proofs
  alone. The box checks the client's tag against this session's live begin (used up whatever happens;
  `claim_begin_missing` without one). A mismatch is one wrong guess (`claim_invalid`). A match answers the box's tag
  and lets this session claim once, for `ENROLL_CLAIM_BEGIN_TTL_S`. The client checks the box's tag before it sends
  anything about the person.
- **`enroll.claim.local {claimId, account, endpoint}` → `EnrolledOutput`**: no `confirm` in or out. Refused with
  `claim_proof_missing` without a live proof on this session. A request that still carries `confirm` (the form before
  this minor) is answered `claim_update_app` and nothing else of it is used.
- **`enroll.claim.local.start`** is kept per session, not per device key, and refuses a session below minor 1 with
  `claim_update_app` (`LOCAL_CLAIM_PROVE_MINOR`).
- **`ClaimAccount`**, `CLAIM_ACCOUNT_NAME_MAX` and `claimAccountProblem(account)`: the first owner's name and email as
  `enroll.claim` and `enroll.claim.local` take them, for an app to check before it starts an exchange.
- **New letters asked for at the box** (`@whombat/protocol/claim`): `CLAIM_WINDOW_S` (600), `CLAIM_WINDOW_WRONG` (5),
  `CLAIM_WINDOW_WRONG_PER_KEY` (2).
- Application codes: `claim_proof_missing`, `claim_update_app`, `claim_rate_limited` (now listed; also a device that
  used its tries on the letters showing).

## Session minor 2 of major 5: the claim link in the hello

`SESSION_PROTOCOL` is `{major: 5, minor: 2}`. No contracts release: control and the relay don't read the hello.

- **`hello.claimLink`** (optional, `OwnAddressClaimSecret`): the claim link's secret, sent by a page at a box's own
  address that was opened with it (`https://<host>/c/<secret>`). A box nobody claimed keeps a few places for the
  sessions of unknown devices that show it, apart from the places any visitor at the address can take. A wrong one
  is a try of the visitor's address at the link, as at the claim's start: ten different wrong links in an hour, then
  the box reads no link from that address for a while (`claim_link` at the start, an ordinary place for the hello).
  Wrong tries never change the link. It lets nothing in: `enroll.claim.local.start` asks for the link again. Left out
  everywhere else; a box from before strips it.
- **The proof of `enroll.claim.local.prove`** lasts as long as its exchange had left (`ENROLL_CLAIM_BEGIN_TTL_S` from
  the begin, not from the proof) and only while the letters it proved show: other letters, new ones asked for at the
  box included, end it (`claim_proof_missing`).
- **`enroll.claim.local.prove`** also answers `claim_rate_limited` to a device that used its wrong tries on the letters
  showing, without trying its tag.
- Application code `claim_busy` (`unavailable`): the box couldn't finish a step of the claim in time; nothing was tried
  and nothing claimed. Try again.

## Session minor 4 of major 5: Find My as a connection

`SESSION_PROTOCOL` is `{major: 5, minor: 4}` (`FIND_MY_MINOR`). No contracts release: control and the relay don't
speak these, and everything here is TypeScript only (docs/implementation/macos/findmy-connection.md).

- **Automations started by Find My**: the trigger `{kind: 'findmy', connectionId, person, name?, change: 'arrives' |
  'leaves', place}` (`person` is Find My's stable id for the name, `place` Find My's own words, compared without case
  or spaces), the run trigger kind and the list source `findmy`. A box sends them as they are only to a session at
  minor 4 or later; an app below it gets them in a form it reads, as mail automations below minor 3.
- **The signed event `findmy.place_changed`** (`FindMyPlaceChanged {connectionId, person, name, from, to}`; never a
  street or coordinates), recorded only while a live automation listens to that connection; automations start on it.
- **`connections.catalog`**: `CatalogEntryStatus.reason` gains `needs_mac` (no macOS server among the box's servers
  yet: “Add a Mac first”). An older client's `decodeTolerant` reads it as null.
- **The catalog**: the check kind `mac` (the entry works through the Mac its `mac` field names; no address of its own),
  and a `select` field's own `options` (`{value, label}[]`; a value not among them is refused, `default` is one of
  them). Find My's entry (`findmy`) has both.
- **`things.page`**: `ThingPageTab.server`, the server a tab is about when the apps draw it themselves (Find My's tab
  names its Mac). Older apps strip it.
- **`automation_read`** answers `findMyPeople` (`{connectionId, person, name, place}`), what a findmy trigger names.

## Session minor 5 of major 5: a Find My timeline

`SESSION_PROTOCOL` is `{major: 5, minor: 5}` (`FIND_MY_TIMELINE_MINOR`). No contracts release: control and the relay
don't speak these, and everything here is TypeScript only (docs/implementation/macos/findmy-timeline.md).

- **`connections.findMyTimeline`** (GET `…/connections/:connectionId/find-my/timeline?date&tz&days`): one day, or up to
  seven ending on `date`, in the viewer's IANA time zone (`FindMyTimelineQuery`); each kept person's segments per day
  (`stay` with its `holes`, `trip`, `gap` with `why`), everyone on the Mac's last read and who is kept since when, the
  pace in minutes, the last read's time and whether the assistant can read it (`FindMyTimeline`). Read through an
  export stream (`EXPORT_READ_OPS`).
- **`connections.findMyTimelineSet`** (PUT, `{people}`: whose days to keep; empty stops the timeline and deletes
  everything) and **`connections.findMyTimelineDelete`** (POST `…/timeline/delete`: every day goes, whose stays), both
  answering `FindMyTimelineChanged`. Never resent by a client on its own.
- **`connections.findMyTimelineMap`** (GET `…/timeline/map?person&date&tz&w&h&dark`): the Mac's map of one person's day
  with each pin's point and the stops it stands for (`findMyTimelinePins`), read through an export stream; 409
  `find_my_no_places` when the day has no spot.
- **The catalog**: Find My's entry gains the read tool `findmy_timeline` (`{person?, date?}`, Allowed from the start).
- **`things.page`**: a Find My connection's page shows its Timeline tab (`timeline`, naming its Mac as its Find My tab
  does) only to a session at minor 5 or later.

## Session minor 6 of major 5: own names (contracts 4.16.0, CT-1792…CT-1799)

`SESSION_PROTOCOL` is `{major: 5, minor: 6}` (`OWN_ADDRESS_NAMES_MINOR`). The box's own address may have a name the person
chose, under `whombat.app` (Whombat own-address.md OWA-40…OWA-47).

- **`ownAddress.check {label}`** (`OwnAddressNameCandidate`: what the person typed, lower-cased and trimmed) →
  `{label, verdict, host?}` (`free`, `yours`, `taken`, `reserved`, `invalid`; `host` when free or yours), owners, a read
  (`safe`).
- **`ownAddress.rename {label}`** (`OwnAddressLabel`) → `{ownAddress: OwnAddressSummary}`, owners, `never` (it acts at
  control first). Refusals `OWN_ADDRESS_RENAME_ERROR_CODES`: `label_invalid`, `label_reserved`, `label_taken`,
  `rename_limit`, `link_off`, `own_address_off`, `own_address_unavailable`, `control_unreachable`.
- **`OwnAddressSummary.leaving?`** `{host, url, until}`: the earlier address while it still works (30 days after a
  rename or a move). Older apps strip it.
- **`address_moved`**: `boxPasskey.register.begin` at the leaving host; new passkeys are made only at the current one.
- **Hosts**: an own-address host is a name of 3–32 lower-case letters, digits and single hyphens under `whombat.app`,
  `box.whombat.app` or `dev.whombat.app`. A box names a host outside the three-word `box.`/`dev.` shape only to a
  session at minor 6 or later; to an older one it leaves the address out (`ownAddress` null, such Whombats out of
  `link.whombats`).

## Session minor 7 of major 5: a page for each account

`SESSION_PROTOCOL` is `{major: 5, minor: 7}` (`ACCOUNT_PAGES_MINOR`). No contracts release: control and the relay don't
speak these, and everything here is TypeScript only (Whombat connection-dashboards.md).

- **`things.page`** answers for the person's accounts, by the thing ids Home already gives them: Google, Microsoft 365
  and Email (`connection:<the account's con_ id>`, only for its own person), GitHub (`connection:github`) and Website
  feedback (`connection:feedback`), one per Whombat. The page's `catalogId` is the account's (`ACCOUNT_PAGE_IDS`:
  `google`, `microsoft`, `imap`, `github`, `feedback`), `settings` is true, and its Connection tab is the account's own
  settings, drawn by the apps.
- **`home.overview`**: an account thing's `href` is its page (`/things/…`), and Website feedback is a thing too. To a
  session below minor 7 a box gives the account things their page on the Connections tab
  (`/settings?tab=connections&connection=<provider>`), as before.
- The apps open an account's page from Connections only for a box at minor 7 or later; an older box keeps the
  Connections tab's page.

## Session minor 8 of major 5: a 1Password vault kept in step with the Vault

`SESSION_PROTOCOL` is `{major: 5, minor: 8}` (`ONEPASSWORD_SYNC_MINOR`). No contracts release: control and the relay don't
speak these, and everything here is TypeScript only (Whombat onepassword-sync.md).

- **The catalog**: the entry `onepassword` (“1Password”, the use `vault`, the check kind `onepassword`, base URL
  `onepassword:`, never requested; `isVaultSyncConnection`). Its form asks a service account token, the vault
  (`fromService`) and “Your Vault entries” (`put`, the default, or `keep`). A box offers it only to a session at minor 8
  or later.
- **`connections.onePassword {connectionId}`** → `OnePasswordSyncView` (the vault's name, counts, the last pass and how
  it ended, `readOnly`, “Not in your Vault” with each item's reason, the removals the guard holds), a read (`safe`).
- **`connections.onePasswordSync {connectionId}`** → `OnePasswordSyncView` with `syncing`, `receipt`.
- **`connections.onePasswordRemovals {connectionId, answer, token}`** (`remove` or `keep` for the set `token` names) →
  `OnePasswordSyncView`, destructive (`receipt`); `conflict` when the set changed since.
- **`connections.disconnect`** takes `vaultEntries` (`keep`, the default, or `remove`) for a 1Password connection.
- **`VaultEntry.source?`** `{kind: 'onepassword', state: 'synced' | 'pending' | 'problem', syncedAt, problem?}`. Older
  apps strip it.
- **`NeedsYouAction`** kind `onepassword_removals` with `removals` (`OnePasswordRemovalsBody`): the guard's card's
  “Remove them here too” and “Keep them here”. An older app leaves the button out; the item's `href` leads to the
  connection page.
- None of these is a setting of the assistant.
