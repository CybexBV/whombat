# Cross-language contracts

Some contracts are read by Go as well as TypeScript: the relay (Go) parses relay messages and verifies
admission tickets, and the manager (Go) signs device requests and verifies update assignments and licence tokens.
Those schemas are written in Zod like everything else. They are exported to JSON Schema (`schema/`) and Go (`go/`), and both
languages test them against the same conformance vectors (`vectors/`).

## Which schemas

`conformance/src/registry.ts` lists them:

- **relay**: `RelayHello`, `RelayWelcome`, `RelayIncoming`, `RelayRefuse`, `RelayDrain`, `RelayReady`,
  `RelayDrainReason`, `RelayUpstreamMessage`, `RelayDownstreamMessage`; the lease (4.5, CT-1767): `RelayLease`,
  `RelayRenew`, `RelayRenewed`, `RelayRenewRefused`
- **direct** (1.0, CT-1250): the box's direct listener, `DirectHello`, `DirectWelcome`, `DirectUpstreamMessage`,
  `DirectDownstreamMessage` (Go `protocol.Direct*`, `DirectPath`, `DirectSubprotocol`, `DirectClose*`); 1.1 (CT-1300,
  CT-1301) `DirectIdentity` (a plain GET of `/v1/direct`: `{v, appliance, edition?, claimed?}`, Go `*Edition`, `*bool`)
  and the enum `Edition`
- **admission**: `AdmissionHeader`, `AdmissionClaims`, `Ed25519Jwk` (0.10; `AdmissionJwk` is the same schema, a Go
  alias), `AdmissionJwk`, `AdmissionJwks`
- **licence** (0.10, CT-76): `LicenceHeader`, `LicenceLimits`, `LicenceClaims`, `LicenceKeySet`, `LicenceStatusResult`
  (Go `VerifyLicenceToken`, `LicenceStatus`, `LicenceAudience`, vectors `licence.json`)
- **release**: `ReleaseTuple`, `ProductManifest`, `HealthEvidence`, `UpdateJournalRecord`, `AssignmentPayload`,
  `SignedAssignment`, `AssignmentKeys`, `ClientBundle`, `ClientChannelPayload`, `SignedClientChannel` (0.9, CT-74;
  Go `VerifyClientChannel`, `ClientBundleTarget`, `SelectClientBundle`, vectors `clients.json`)
- **appliance-local IPC** (`@whombat/control-contracts/local`, Go `local`): `RuntimeTicket*`,
  `RuntimeClaimedRequest`, `RuntimeRevocationRequest`, `RuntimePush*`, `LocalOk`, `LocalError`, `RuntimeHealth`,
  `DrainRequest`, `DrainStatus`, `Resume*`, `ClaimWindowRequest`, `FactsRequest`, `AdminOk`, `BackupServiceStatus`,
  `UpdateFacts`, `CheckpointRequest`, `CheckpointResult`, `UpdateStatusResponse`, `MaintenanceLock*`,
  `MaintenanceUnlockRequest`, `NetworkCandidate`, `NetworkSubmitResponse`, `NetworkStatus`, `RuntimeFacts`,
  `ClaimLookupLeaseRequest`, `ConsoleState` (0.7), `LocalClient`, `LocalClientsStatus`, `ClientInstallRequest`,
  `ClientRemoveRequest`, `ClientsPushRequest` (0.9, CT-73), `LicenceRenewNowRequest`, `LicenceRenewNowResult`,
  `LicencePushRequest`, `LocalLicenceStatus`, `LicencePushResponse` (0.10, CT-77), `RuntimeFeedbackCards*`,
  `RuntimeFeedbackPull*`, `RuntimeFeedbackAck*` (0.13, CT-91: the feedback device ops' own schemas),
  `RuntimeFeedbackReporters*` (0.25, CT-164), `HostMetricsRequest`, `HostMetricsResponse` (0.78, CT-334; 0.100
  `now.power`, CT-522; 0.101 `now.cpuTempC`, `now.uptimeS`, CT-542), the desk socket `DeskState`, `DeskTalk`,
  `DeskRequest`, `DeskAck`, `DeskUnlockRequest`, `DeskUnlockAnswer`, `DeskPhoneUnlockAnswer`, `DeskTouchAnswer`,
  `DeskDecideRequest`, `DeskTalkRequest`, `DeskTalkStarted`, `DeskTalkRef` (0.100, CT-528…CT-531), the voice socket
  `VoiceHealth`, `VoiceSttRequest`, `VoiceSttAnswer`, `VoiceTtsRequest`, `VoiceTtsAnswer` (0.100, CT-532), the presence
  socket `PresenceHealth`, `PresenceWatchRequest`, `PresenceWatch`, `PresenceStopRequest`, `PresenceAck` (0.103,
  CT-597, CT-598), the manager's `HostHardwareRequest`, `HostHardwareResponse`, `NetworkStateRequest`, `NetworkStateResponse`,
  `WifiScanRequest`, `WifiScanResponse`, `WifiJoinRequest`, `WifiForgetRequest`, `WifiChangeResponse` and the desk's
  `DeskNetworkAnswer`, `DeskWifiScanAnswer`, `DeskWifiJoinRequest`, `DeskWifiForgetRequest`, `DeskWifiChangeAnswer`
  (0.102, CT-573, CT-574), the Bluetooth socket `BluetoothStateAnswer`, `BluetoothScanRequest`, `BluetoothScanAnswer`,
  `BluetoothDeviceRequest`, `BluetoothConfirmRequest`, `BluetoothCancelRequest`, `BluetoothPairingAnswer`,
  `BluetoothDeviceAnswer`, `BluetoothAck` and the desk's `DeskBluetoothAnswer`, `DeskBluetoothScanAnswer`,
  `DeskBluetoothDeviceRequest`, `DeskBluetoothConfirmRequest`, `DeskBluetoothCancelRequest`,
  `DeskBluetoothPairingAnswer`, `DeskBluetoothDeviceAnswer` (0.109, CT-681, CT-684), the support socket `SupportState`,
  `SupportGrantRequest`, `SupportStopRequest`, `SupportVisitsAnswer`, `SupportEventsAnswer` (0.120, CT-938…CT-941; Go
  `NormalizeHelpCode`, `FormatHelpCode`, `GenerateHelpCode`, `RemoteHelpWho`, `RemoteHelpDurationSeconds`,
  `RemoteHelpStepValid`, `SupportStateValid`, `SupportEventValid`), and Tailscale on the manager socket
  `TailscaleStateRequest`, `TailscaleStateResponse`, `TailscaleOnRequest`, `TailscaleOffRequest`,
  `TailscaleSignInRequest`, `TailscaleCertRequest`, `TailscaleCertResponse` (1.0, CT-1255; `TailscaleStatus` is Go
  `protocol.TailscaleStatus`; 1.1, CT-1306: `TailscaleStatus.LoginServer` and `TailscaleOnRequest.LoginServer`, both
  `*string` with `omitempty`, absent for Tailscale's own coordination server). Times are RFC 3339 strings matching `Rfc3339` (Go `time.Time`); free text is printable ASCII
  (`^[\x20-\x7e]*$`), except the Unicode display text below.
- **push registration** (control, MA-18): `NativePushRegistration`, `WebPushRegistration`, `PushVapidKey`;
  **claim verifier** (provisioning, MA-19): `ClaimVerifierRegistration`.
- **control device API**: `DeviceRequestEnvelope`, `DeviceRegistration`, `DeviceRegistrationResponse`, and for
  every device op `<Op>Request` / `<Op>Response` (`StatusReportRequest`, `PushSendRequest`,
  `TicketIssueResponse`, `UpdateAssignmentResponse`, …; 0.120 `SupportTicketRequest`/`SupportTicketResponse`, CT-945, and
  `StatusReportRequest.support`, CT-944)

The session protocol (inside Noise) is TypeScript-only. Only the TypeScript runtime and clients use it. Its frame
codec still has Go vectors and a Go implementation, for tooling. `vectors/session.json` (checked by Vitest only)
pins the session's forward-compatibility behaviour.

## Forward compatibility (CT-14)

Within one major, a peer must accept messages from a newer minor:

- **Wire messages and responses** (`z.object`) strip unknown members. This covers relay messages, session
  CONTROL messages, session operation outputs, device API and control API responses. Unknown session message
  types are skipped (`decode*Message` → `unknown_type`). A new member that changes meaning must be negotiated
  (a capability in `hello`/`welcome`), never inferred from its presence.
- **Command inputs** (`z.strictObject`) reject unknown members: session operation inputs, device request
  bodies, control request bodies.
- **Signed, hashed and security documents** (`z.strictObject`) reject unknown members, so a verifier never
  accepts what it doesn't understand. A new member requires a new `purpose` or a new major. This covers
  admission tickets, JWKS, device envelopes and registrations, tuples, manifests and assignments.

Vectors: `schemas.json` cases with `output` (the stripped result, identical in Zod and Go, including a case
variant `CONN` that must not replace `conn`); `session.json` (messages and strict inputs).

## Supported schema subset

`checkSubset` (`conformance/src/subset.ts`) enforces the subset. `pnpm contracts:gen` and the conformance test fail on
anything outside it.

| Allowed | Rules |
|---|---|
| `z.strictObject({...})` | Rejects unknown members. Use for command inputs, signed documents, hashed documents and security tokens (device request bodies, envelopes, registrations, admission header/claims/JWKS, tuples, assignments). |
| `z.object({...})` | Strips unknown members (forward compatibility, CT-14). Use for wire messages and responses (relay messages, device API responses). The JSON Schema leaves `additionalProperties` open (`io: 'input'`). Go's `Parse*` drops undeclared members with exact-case matching before `encoding/json` sees them, so an unknown `KID` can't shadow `kid`. `z.looseObject` (keeps unknown members) is not allowed. |
| `z.string()` | Must carry `.regex(...)`; may carry `.min`/`.max`. The pattern must be anchored `^…$`, ASCII, without flags, without lookaround, backreferences, named groups, negated classes (`[^…]`), `.` or shorthand classes (`\s \d \w \b …`), and with `\xNN` only for ASCII. So every matching string is ASCII, lengths are equal in UTF-16 (Zod) and code points (JSON Schema), and ECMAScript and RE2 agree. Exceptions by name (`UNICODE_PATTERNS` in `subset.ts`): `CONSOLE_DISPLAY_TEXT_RE` (`ConsoleDisplayText`, CT-116), the push previews' `PUSH_PREVIEW_TITLE_RE` / `PUSH_PREVIEW_BODY_RE` (CT-286), the desk's `DESK_TEXT_RES` (0.100, CT-529: `^(?:[^\p{Cc}\p{Cf}\p{Cs}\p{Z}]\| ){min,max}$` at the lengths the desk uses, up to 600) and the hardware report's and the network's `HOST_TEXT_RES` (0.102, CT-560: the same form at 15, 32, 64, 80, 120 and 240; 0.120, CT-931, also 40 and 500 for remote help's names and command lines). They have flag `u`, use the general categories `Cc`, `Cf`, `Cs` and `Z` in negated classes and carry their length in code points in the pattern, so they may not carry `.min`/`.max`; `local.json` → `displayText` lists every code point the console's pattern refuses, and the Go test compiles it with RE2 and compares, so the two Unicode tables are checked, not assumed (the others use the same categories). |
| `z.number().int().min(a).max(b)` | Integers only, with explicit inclusive bounds within ±(2^53−1). No floats anywhere, which also keeps canonical JSON identical across languages. |
| `z.boolean()` | |
| `z.literal(x)` | One string, safe integer or boolean. |
| `z.enum([...])` | String values. |
| `z.array(T).max(n)` | `maxItems` is required; `.min` is optional. |
| `z.discriminatedUnion(key, [...])` | Options are strict objects with a literal discriminator. The Go generator supports them only at the top level of a registry entry. |
| `.optional()` | Object properties only. Go uses a pointer with `omitempty`. |
| `.nullable()` | Go uses a pointer (a slice for arrays). `optional(nullable)` and `nullable(optional)` are not allowed. |
| `z.record(z.string(), z.unknown())` | Only as an opaque JSON object that is validated separately, like the device envelope `body` against `DEVICE_OPS[op].body`. Go uses `json.RawMessage`. |

Not allowed: transforms, pipes, `.refine`/`.superRefine`/`.check`, `.default`/`.prefault`/`.catch`, string formats
(`z.email()`, `z.iso.datetime()`, `z.url()`, …), `.trim()`/`.toLowerCase()` (overwrites), non-discriminated
unions, intersections, tuples, lazy/recursive schemas, dates, bigints, maps and sets. Represent times as integer
epoch seconds (`EpochSeconds`).

### Encoding rules for producers

- Encode integers as JSON integers, without a fraction or exponent. `JSON.stringify` and Go's `encoding/json`
  already do this. A Go consumer may reject `1.0`, while `JSON.parse` would accept it.
- UTF-8 without a BOM. Duplicate member names are not allowed; both languages keep the last one, but don't rely on
  that.
- Signed documents are Ed25519 over RFC 8785 canonical JSON: core's `canonicalJson` in TypeScript,
  `gowebpki/jcs` in Go (`go/internal/canon`). The payload names its `purpose` and audience/environment. With
  integer-only payloads both implementations produce identical bytes; the `canonical` vectors test this.
- Ed25519 verification is strict on both sides (CT-15). It rejects a non-canonical S, R and public-key
  encoding, as well as small-order public keys. In TypeScript that is `verifyEd25519Strict` in
  `@whombat/core/audit`: noble with `zip215: false`, plus `isSmallOrder`. Every exported helper uses it by
  default: `verifyBytes`, `verifyAdmissionTicket`, `verifyRecoveryStatement`, `verifyDeviceRequest`,
  `verifyRegistration`, `verifyAssignment` and `verifyLicenceToken`. In Go it is `internal/ed25519strict`: `crypto/ed25519` plus a
  `filippo.io/edwards25519` canonical-encoding and small-order check, because `crypto/ed25519` alone accepts
  forgeries for small-order and non-canonical keys. `signed.json` → `ed25519` has vectors for both
  (`laxAccepts` records what `crypto/ed25519` alone would do).

## Generation and checks

```sh
pnpm contracts:gen          # schema/*.json, vectors/*.json, go/internal/schemas/json, go/testdata/vectors,
                            # go/<pkg>/types_gen.go, go/<pkg>/constants_gen.go (gofmt'd)
pnpm contracts:gen:check    # CI: regenerate and fail on any diff
pnpm test                   # includes conformance/: subset, up-to-date JSON, vectors against the TypeScript verifiers
pnpm contracts:test:go      # go vet + go test: vectors against the Go verifiers and the generated types
```

The Go generator (`conformance/src/gen-go.ts`) is hand-written, not an off-the-shelf JSON Schema to Go tool
(decision CT-09). It reads the Zod definitions, so it can reuse the exported names (`UpdateJournalState`,
`RelayClass`, …) and share types across packages. Validation doesn't depend on the generator: every
`Parse<Name>` validates the raw JSON against the embedded JSON Schema with
`github.com/santhosh-tekuri/jsonschema/v6` (draft 2020-12, Go `regexp`) and only then unmarshals. The Go bounds
are therefore exactly the exported ones. The conformance test also marshals every parsed valid value back and
validates it again, which catches generator mistakes such as a missing `null`.

## Go API

Module `github.com/CybexBV/whombat/contracts/go` (Go 1.26):

- `protocol`: `Relay*` message types, `ParseRelayUpstreamMessage`/`ParseRelayDownstreamMessage`,
  `VerifyAdmissionTicket(token, VerifyAdmissionOptions{JWKS, Now, Audience, Issuer, Role, Worker})` returning
  `*AdmissionError{Code}` with `CloseCode()` (`AdmissionErrorClose`), `PeerIDFromEd25519PublicKey`, `EncodeFrame`/`DecodeFrameBody`/`FrameDecoder`, and constants (`RelayMaxMessageBytes`,
  `RelayClose*`, `FrameType*`, `StreamReset*`, …).
- `release`: `ReleaseTuple`, `ProductManifest`, `UpdateJournalRecord`, `UpdateJournalState*`,
  `UpdateJournalTransitions`, `CanTransition`, `TupleDigest`, `VerifyAssignment(raw, AssignmentContext)`.
- `device`: `DeviceRequestEnvelope`, `SignDeviceRequest`, `VerifyDeviceRequest`, `SigningBytes`,
  `SignRegistration(r, management, content)`/`VerifyRegistration`, the op request/response types, and
  `DeviceOps`.

- `local`: the appliance-local IPC types with `Parse*`/`Validate`, `ManagerPath*`/`AdminPath*` constants,
  `RevocationRef(peerId)` and `RecoveryKitState`.
- 0.5.3: `release.ClientFloor` (in `ReleaseTuple.clientFloor` and `local.UpdateFacts.clientFloor`) and
  `release.ClientBelowFloor(floor, platform, buildNumber)`, checked by `compat.json` → `floors` and `digests`.
- 0.7 (claim code, MA-22): `protocol.NormalizeClaimCode` / `FormatClaimCode` / `GenerateClaimLetters` /
  `IsClaimLetters` / `IsClaimLookup`, CPace (`CPaceGenerator`, `CPaceScalarMultVfy`, `NewCPaceInitiator`, `CPaceRespond`,
  `CPaceISK`, …), the claim PAKE (`ClaimPakeContext`, `NewClaimPakeClient`, `ClaimPakeRespond`, `ClaimConfirmEqual`),
  checked by `claim.json` → `codes|formats|letters` and `cpace.json` (the draft's B.3 values and our own); `device`:
  the op `claim.lookup` (`ClaimLookupRequest`/`Response`) and `SelfInstalledModel`; `local`: `AdminPathClaimLookup`,
  `ClaimLookupLeaseRequest`, `ConsoleState`, `ConsoleStateValid`, `ConsoleDisplayURL`, `ClaimLookupLeaseValid`.
- 0.10 (the appliance licence, CT-76, CT-77): `protocol.VerifyLicenceToken(token, VerifyLicenceOptions{KeySet, Device,
  Now})` returning `*LicenceError{Code}`, `protocol.LicenceStatus(LicenceStatusParams{…})`, `LicenceAudience`, the
  `Licence*` constants and `EntitlementState`; `device`: the op `licence.renew` (`LicenceRenewRequest`/`Response`);
  `local`: `ManagerPathLicenceRenew`, `AdminPathLicence` and the licence push and renew types.
- 0.13 (the feedback drop, CT-91): `device`: the ops `feedback.cards.sync`, `feedback.drops.pull`, `feedback.drops.ack`
  (`FeedbackCardsSyncRequest`/`Response`, `FeedbackDropsPull*`, `FeedbackDropsAck*`, `FeedbackCardWire` with the card as
  `json.RawMessage`, `FeedbackDrop`, `FeedbackCardRefusal`), the `Feedback*` constants and `DeviceRequestMaxBytesFor(op)`
  (4 MiB for `feedback.cards.sync`); `local`: `ManagerPathFeedbackCards|Pull|Ack` and the `RuntimeFeedback*` aliases.
  No Go crypto for the drop: cards and envelopes are opened and verified in TypeScript only (`vectors/feedback-drop.json`
  is checked by Vitest). `signed.json` → `deviceRequests` has a `feedback.cards.sync` whose card holds Unicode and
  `<`, `&`: Go's re-signing must match TypeScript's canonical JSON over it.
- 0.17 (the console's burrows, CT-116): `local.ConsoleState.Burrows` (`*ConsoleBurrows{First, More}`), present only in
  state `claimed` (`ConsoleStateValid`); `First` matches the Unicode pattern `ConsoleDisplayText`, checked by
  `local.json` → `displayText` against RE2's tables.
- 0.5: `protocol.NormalizeClaimSecret` / `IsClaimSecret` / `ClaimSecretHash`, `release.CheckActivation` /
  `UpdateClass` / `ServesClient` / `ProtocolOverlap` / `AssignmentKeyMap`, and `device.AssignmentResultValid`.
- 0.21 (CT-134): `release.CheckMigratingActivation(current, candidate, dbSchema, SchemaMigration)` and
  `ActivationCheck.RollbackAccess`, checked by `compat.json` → `migrating`.
- 0.22 (robust updates, CT-135…CT-142): `release.CompareVersions(a, b)` (the helper's version order) and
  `release.CheckCompatibleActivation(current, candidate, dbSchema, SchemaFloors{Readers, Writers})`, checked by
  `compat.json` → `versions` and `compatible`; `release.UpdateFailureDetail` / `UpdateFailureSchema` /
  `UpdateWaitReason*`; `device.UpdateFailureReport` (the strict copy in `StatusReportRequest.Update.FailureDetail` and
  `UpdateProgressRequest.FailureDetail`; convert with `device.UpdateFailureReport(detail)`),
  `StatusReportRequest.RuntimeVersion`; `local.UpdateFacts.FailureDetail|Waiting|LastUpdate` (`local.UpdateWaiting`,
  `local.LastUpdate`); `protocol.SessionAPILevel`. The new members are optional, absent when there is nothing to say:
  the subset has no optional-nullable.
- 0.22.4 (CT-147): `release.RetryableUpdateFailures` / `IsRetryableUpdateFailure` (`compat.json` → `retryable`);
  `device.UpdateWaitingReport {Reason, Since}` in `StatusReportRequest.Update.Waiting` and
  `UpdateProgressRequest.Waiting`.
- 0.23 (CT-157): `protocol.SessionAPILevel` is 23. Nothing else in Go: messages, subscription usage and the runner's
  usage probe are TypeScript only.
- 0.25 (reporter sign-in, CT-164): `device`: the op `feedback.reporters.publish` (`FeedbackReportersPublishRequest` /
  `Response`, `FeedbackReporterUpdate`, `FeedbackReporterRemoval`, the enums `FeedbackReportType` and
  `FeedbackReporterStatus`, `FeedbackReportersPublishMax`), `FeedbackDrop.Reporter` (`*FeedbackDropReporter{ID,
  EmailDigest}`, absent for anonymous drops and older controls); `local`: `ManagerPathFeedbackReporters` and the
  `RuntimeFeedbackReporters*` aliases. The manager forwards; it computes no digest (`reporterEmailDigest` is
  TypeScript only, checked by core's vector).

- 0.100 (the desk display, CT-522, CT-528…CT-533): `protocol.HostPower` (`HostNow.Power`, optional) and
  `protocol.HostPowerSource`; `local`: the desk socket — `DeskState` with `DeskPaired`, `DeskPerson`,
  `DeskAssistant`, `DeskPairing`, `DeskLock`, `DeskGlance`, `DeskStatus`, `DeskNeedsYou`, `DeskAsk`, `DeskWorking`,
  `DeskStep`, `DeskDone`, `DeskServer`, `DeskMeter`, `DeskTile`, `DeskPower`, `DeskTalk`, the enums `DeskLockedView`,
  `DeskNight`, `DeskLockState`, `DeskPhoneReason`, `DeskAskKind`, `DeskStepState`, `DeskServerState`, `DeskTone`,
  `DeskTileIcon`, `DeskTalkState`, `DeskTalkReason`, `DeskUnlockResult`, `DeskDecision`; the requests and answers
  `DeskRequest`, `DeskAck`, `DeskUnlockRequest`, `DeskUnlockAnswer`, `DeskPhoneUnlockAnswer`, `DeskTouchAnswer`,
  `DeskDecideRequest`, `DeskTalkRequest`, `DeskTalkStarted`, `DeskTalkRef`; the hand-written `DeskStateValid`,
  `DeskTalkValid` and `DeskTalkRequestValid` (vectors `local.json` → `deskStates`, `deskTalkRequests`); the constants
  `DeskSocketEnv`, `DeskSocketDefault`, `DeskPath*`, `DeskRequestMaxBytes`, `DeskTalkRequestMaxBytes`,
  `DeskStateMaxBytes`, `DeskAudio*`, `DeskQuestionMax`, `DeskAnswerMax`, `DeskError*`; the voice socket `VoiceHealth`,
  `VoiceSttRequest`, `VoiceSttAnswer`, `VoiceTtsRequest`, `VoiceTtsAnswer`, `VoiceSocketEnv`, `VoiceSocketDefault`,
  `VoicePath*`, `VoiceQueueMax`, `VoicePromptMax`, `VoiceTts*`, `VoiceError*`. `protocol.SessionAPILevel` stays 39.

- 0.101 (a desk screen that works at once, CT-542…CT-545, CT-548): `protocol.HostNow` gains `CpuTempC` and `UptimeS`
  (`*int64`, optional); `local`: `DeskPaired.HasPin` (`*bool`), `DeskGlance.Box` (`*DeskBox`, with `DeskBoxCpu`,
  `DeskBoxMemory`, `DeskBoxHistory`, `DeskBoxStorage`, `DeskBoxNetwork`, `DeskFigure`, `DeskBoxPart` and the enum
  `DeskBoxPartKey`), the constant `DeskErrorNoPin`, and `DeskStateValid`'s box rules (vectors `local.json` →
  `deskStates`). Two more desk text lengths, 8 and 16 code points. `protocol.SessionAPILevel` stays 39.

- 0.102 (the box's hardware and network, CT-560…CT-575): `protocol.HostHardware` with `HardwareMachine`, `HardwareCpu`,
  `HardwareDevice` and the enums `HardwareKind`, `HardwareStatus`, `HardwareBus`, `HardwareLink`; `protocol.HostNetwork`
  with `HostWired`, `HostWifi`, `WifiSaved`, `WifiState`, `WifiMissing`, `NetworkChange`, `NetworkChangeKind`,
  `NetworkChangePhase`, `NetworkChangeFailure`; `protocol.WifiScan`, `WifiNetwork`, `WifiSecurity`; `local`: the manager's
  `HostHardwareRequest`/`Response`, `NetworkStateRequest`/`Response`, `WifiScanRequest`/`Response`, `WifiJoinRequest`,
  `WifiForgetRequest`, `WifiChangeResponse`, the desk's `DeskNetworkAnswer`, `DeskNetworkWhy`, `DeskWifiScanAnswer`,
  `DeskWifiJoinRequest`, `DeskWifiForgetRequest`, `DeskWifiChangeAnswer`; the constants `ManagerPathHostHardware`,
  `ManagerPathNetworkState`, `ManagerPathWifiScan|Join|Forget`, `DeskPathNetwork`, `DeskPathWifiScan|Join|Forget`, the
  new `DeskError*`, `SsidMaxBytes`, `WifiError*`; the hand-written `HostText`, `SsidValid`, `WifiSignalFromDBm`,
  `NetworkChangeValid` and `HostNetworkValid` (vectors `local.json` → `hostTexts`, `ssids`, `wifiSignals`,
  `hostNetworks`, `networkChanges`). `protocol.SessionAPILevel` is 40.

- 0.103 (a four-digit PIN, and staying unlocked while you're there, CT-595…CT-599): `local`: `DeskPaired.PinDigits`
  (`*int64`, 4…6), `DeskLock.Camera` and `Present` (`*bool`), `DeskUnlockRequest.Pin` on 4 to 6 digits, and
  `DeskStateValid`'s rules for the camera (vectors `local.json` → `deskStates`); the presence socket `PresenceHealth`,
  `PresenceWatchRequest`, `PresenceWatch`, `PresenceState`, `PresenceStopRequest`, `PresenceAck`; the constants
  `DeskPinMin`, `DeskPinMax`, `PresenceSocketEnv`, `PresenceSocketDefault`, `PresencePath*`, `PresenceKeepS`,
  `PresenceRequestMaxBytes`, `PresenceError*`. `deskPinTooEasy` is TypeScript only (the console never chooses a PIN).
  `protocol.SessionAPILevel` stays 40.

- 0.104 (one glance that fits what there is, CT-601…CT-603): `local`: `DeskGlance.Self` (`*DeskBox`), `ExtraServers`
  (`[]DeskServer`) and `ExtraTiles` (`[]DeskTile`), and `DeskStateValid`'s rules for them (vectors `local.json` →
  `deskStates`). `protocol.SessionAPILevel` stays 40.

- 0.105 (the screen's voice, CT-614, CT-615): `local`: `VoiceHealth.Voices` (`[]string`) and `VoiceTtsRequest.Voice`
  (`*string`, `VoiceName`'s pattern in the schema). The session side (`DeskSettings.speechVoice`, `DeskScreen.voices`,
  `desk.voiceSample`, `no_voice`) is TypeScript only. `protocol.SessionAPILevel` stays 40.

- 0.106 (sign in at the box, CT-625, CT-626): `local`: `ConsoleSignIn {Code, Name, Device, ExpiresAt}` and
  `ConsoleState.SignIn` (`*ConsoleSignIn`, `ScreenSignInLetters`' and `ConsoleDisplayText`'s patterns in the schema),
  `ConsoleStateValid`: `SignIn` only in state claimed. The letters' helpers, the screen sign-in PAKE and the
  `enroll.screen.*` ops are TypeScript only (the console only shows the letters). `protocol.SessionAPILevel` 41.

- 0.107 (only the clock when nobody's there, staying unlocked, CT-646…CT-648): `local`: `DeskLock.Stays` (`*bool`),
  `DeskPresence {Camera, Watching, Here}` and `DeskState.Presence` (`*DeskPresence`), `DeskStateValid`: `Stays` true
  only while unlocked, a `Presence` only while paired (vectors `local.json` → `deskStates`). The settings
  (`stayUnlocked`, `cameraWake`), `DeskScreen.lockAgain`/`cameraWakeAvailable`, the idle times and the words are
  TypeScript only. `protocol.SessionAPILevel` stays 41.

- 0.109 (the box's Bluetooth, CT-670…CT-685): `protocol.BluetoothState`, `BluetoothAdapter`, `BluetoothDevice`,
  `BluetoothScan`, `BluetoothPairing`, `BluetoothKind`, `BluetoothPairingPhase`, `BluetoothPairingFailure`,
  `BluetoothMissing`; `local`: the Bluetooth socket's and the desk's new requests and answers with `Parse*`/`Validate`,
  `DeskBluetoothWhy`, the constants `BluetoothSocketEnv`, `BluetoothSocketDefault`, `BluetoothPath*`,
  `BluetoothRequestMaxBytes`, `BluetoothAnswerMaxBytes`, `BluetoothNameMax`, `BluetoothScanMax`, `BluetoothDevicesMax`,
  `BluetoothScanS`, `BluetoothPairingS`, `BluetoothConnectS`, `BluetoothPollMs`, `BluetoothResultKeepS`,
  `BluetoothError*`, `DeskPathBluetooth*`, `DeskErrorNoBluetooth`, the map `BluetoothSocketErrorStatus`, and the
  hand-written `BluetoothSignalFromDBm`, `BluetoothPairingDone`, `BluetoothPairingValid` and `BluetoothStateValid`
  (`go/local/bluetooth.go`; vectors `local.json` → `bluetoothSignals`, `bluetoothPairings`, `bluetoothStates`). Names
  are cleaned with `HostText(name, BluetoothNameMax)`. The session ops, the errors' session statuses and the audit
  payload are TypeScript only. `protocol.SessionAPILevel` 42.

- 0.110 (found on your network on the desk, CT-700, CT-701): `local`: `DeskFound {Scanning, Progress, Items, Count,
  FinishedAt}`, `DeskFoundProgress {Done, Total}`, `DeskFoundItem {CatalogID, Name, Tagline, Address}` and
  `DeskGlance.Found` (`*DeskFound`), the hand-written `DeskFoundValid` and `DeskStateValid`'s rule for it (vectors
  `local.json` → `deskStates`), the constants `DeskPathFoundDismiss` and `DeskFoundItems`. Taglines, the session
  sign-in's new members and helpers and the event types are TypeScript only. `protocol.SessionAPILevel` stays 42.

- 0.115 (server cards and a server's own screen, CT-860…CT-867): `local`: `DeskServer.ID` and `DeskServer.Disk`,
  `DeskTalkRequest.Server`, `DeskServersAnswer`, `DeskServerRequest` and `DeskServerPage` (with `DeskServerCpu`,
  `DeskServerMemory`, `DeskServerDisk`, `DeskServerTemp`, `DeskServerHistory`, `DeskServerVolume`,
  `DeskServerGuestList`, `DeskServerGuest`, `DeskServerAlertList`, `DeskServerAlert`) with `Parse*`/`Validate`, the
  enums `DeskServerRange`, `DeskGuestKind`, `DeskGuestState`, `DeskServerAlertTone`, the constants `DeskPathServers`,
  `DeskPathServer`, `DeskServers`, `DeskServerPoints`, `DeskServerVolumes`, `DeskServerGuests`, `DeskServerAlerts`,
  `DeskServerMaxBytes`, `DeskServerIDPattern`, and the hand-written `DeskServerPageValid` and `ValidDeskServerID`
  (vectors `local.json` → `deskServerPages`, `deskServerIds`). The words and `DeskDispatchContext.server` are
  TypeScript only. `protocol.SessionAPILevel` stays 44.
- 0.116 (task feedback, CT-890…CT-897): `local`: `DeskAsk.Choices` (`[]DeskAskChoice {Scope, Label}`, the enum
  `DeskChoiceScope`) and `DeskAsk.From`, `DeskDecideRequest.Scope` (`*DeskDecideScope`), `DeskTalkStateWorking`,
  `DeskTalkSession.Working` (`*DeskSessionWorking {Since, Doing}`), `DeskSessionMessage.Task` (`*DeskSessionTask
  {Title, State, StartedAt, EndedAt, Result}`, the enum `DeskTaskState`), the constants `DeskAskChoices`,
  `DeskTalkWorkingS`, `DeskTalkWaitMaxS`, `DeskErrorNotOffered`, the hand-written `DeskDecideRequestValid` and
  `DeskDecideNeedsPin`, and the new rules of `DeskStateValid` and `DeskTalkSessionValid` (vectors `local.json` →
  `deskStates`, `deskTalkSessions`, `deskDecideRequests`). The `task` card, its words and helpers, the
  `task_finished` trigger and `DispatchContext.taskFinished` are TypeScript only. `protocol.SessionAPILevel` stays 44.

- 0.118 (what needs a look on the desk, CT-970…CT-971): `local`: `DeskNeedsYou.Looks` (`DeskLook`, the enums
  `DeskLookKind` and `DeskLookState`), checked in the hand-written `DeskStateValid` (none locked in *Only the time*).
  The words are TypeScript only. `protocol.SessionAPILevel` stays 44.
- 0.122 (quiet notices on the desk, CT-1065): `local`: `DeskLook.Notice` (`*DeskLookNotice {Check, Subject}`),
  `.Nature` (`*NoticeNature`, the enum re-exported from core), `.IgnoreWords`, `.Question`; `DeskLookQuietRequest`
  (`DeskLookQuietRequestNotice`, the enum `DeskLookQuietHow`), `DeskPathLookQuiet`, `DeskErrorNotAllowed`;
  `DeskRequestMaxBytes` 2048 and `DeskStateMaxBytes` 98304. Two desk text lengths more (160, 300). The quiet notices'
  core schemas, the words and `HOST_WATCH_CHECKS` are TypeScript only. `protocol.SessionAPILevel` stays 45.
- 3.3 (Talk's voice typing, Whombat dictation.md DT-37…DT-41): `local`: `DeskHearRequest` and `DeskHeard` with
  `Parse*`/`Validate`, `DeskTalkRequest.Spoken` (`*bool`), the constants `DeskPathHear`, `DeskHearRequestMaxBytes`,
  `DeskHearBase64Max` and `DeskTalkTextMax` (a question's text up to 1000 code points: one desk text length more,
  1…1000). The words are TypeScript only.

Go module dependencies: `santhosh-tekuri/jsonschema/v6`, `gowebpki/jcs`, `filippo.io/edwards25519`,
`gtank/ristretto255` (0.7, CPace) and `mr-tron/base58` (plus `golang.org/x/text`). A vendored copy needs them in the consumer's module cache or
`vendor/` (`go mod vendor`).

- 0.111 (connections that sign in properly, CT-730…CT-749): nothing new in Go but `protocol.SessionAPILevel` 43. The
  `service_login` sign-in, its endpoints and feature, the sign-in challenge, a session's `twoStep` and `code`, a
  session failure's `status`, a check's `failures` and `forSecret`, a field's `fromCheck`, their helpers and the
  entries are TypeScript only.
- 4.3 (the own address, CT-1743…CT-1755; Whombat own-address.md): `protocol`: `RelayDoorClass`, `RelayStreamClass`
  (the type of `RelayHello.Class` and `RelayIncoming.Class` now), `RelayHello.Accepts`, `RelayIncoming.Src`,
  `AdmissionClaims.Lbl`, the constants `OwnAddressLabelPattern`, `OwnAddressHostPattern`, `OwnAddressZoneProd`,
  `OwnAddressZoneDev`, `OwnAddressClaimPath`, `BoxAssetLinksMaxAgeS`; `device`: the ops `address.register`,
  `account.link.lookup`, `account.link`, `kit.credentials.declare` (`AddressRegister*`, `AccountLinkLookup*`,
  `AccountLink*`, `KitCredentialsDeclare*`, `KitCredentialsDeclareMax`), `KitEnvelopesPutResponse.SkippedCredentialIds`;
  `local`: `ManagerPathOwnAddressState|Register|Cert|Ct`, `ManagerPathAccountLinkLookup|AccountLink`,
  `ManagerPathKitCredentials`, `OwnAddressStateRequest`, `OwnAddressRegisterRequest`, `OwnAddressCertRequest`,
  `OwnAddressCtRequest`, `OwnAddressStateResponse`, `OwnAddressCertResponse`, `OwnAddressCtResponse`,
  `RuntimeAccountLinkLookup*`, `RuntimeAccountLink*`, `RuntimeKitCredentials*`, `ConsoleState.Alert`
  (`ConsoleAlertKind`), `OwnAddressACMESocket`, `OwnAddressACMEConnectionsMax`, `OwnAddressStatePollS`,
  `OwnAddressCtPollS`, `OwnAddressError*`. The word list is TypeScript only.
- 4.4 (Whombat Link, CT-1756…CT-1766; Whombat whombat-link.md): `protocol`: `LinkState`, `NativePushToken`, the
  constants `LinkCodePattern`, `LinkCodeTTLS`, `LinkPagePath`, `LinkGraceS`, `LinkTrialDays`, `LinkTrialBoxesMax`;
  `release`: `UpdateChannel`, `DefaultUpdateChannel`, and `CompareVersions` ordering the one release id family by date
  and build number (`compat.json` → `versions`); `device`: the ops `link.begin`, `link.status`, `link.leave`,
  `push.register`, `push.unregister`, `support.heartbeat` (`LinkBegin*`, `LinkStatus*`, `LinkLeave*`, `PushRegister*`,
  `PushUnregister*`, `SupportHeartbeat*`), `DeviceLinkStatus`, `LinkPending`, `TicketIssueResponse.Link`; `local`:
  `ManagerPathLinkState|LinkOn|LinkOff`, `ManagerPathUpdateChannel|UpdateChannelSet`,
  `ManagerPathPushRegister|PushUnregister`, `LinkStateRequest`, `LinkStateResponse`, `LocalLinkStatus`,
  `LocalLinkPending`, `LinkOnRequest`, `LinkOffRequest`, `UpdateChannelRequest`, `UpdateChannelSetRequest`,
  `UpdateChannelResponse`, `RuntimePushRegister*`, `RuntimePushUnregister*`, `ConsoleState.Reach` (`ConsoleReach`,
  `ConsoleLink`, `ConsoleTailscale`), `LinkStatePollS`, `LinkError*`. The price and `normalizeLinkCode` are TypeScript
  only.
- 4.5 (Whombat Link, what wave 2 found missing, CT-1767…CT-1771): `protocol`: `RelayLease`, `RelayWelcome.Lease`,
  `RelayRenew`, `RelayRenewed`, `RelayRenewRefused`, `RelayRenewRefusal` (`RelayRenewRefusal*`), the constants
  `RelayCloseReasonLease`, `RelayLeaseMarginS`. `CloudSession.orgs[].link`, `LinkPlan.cardOnFile` and the catalog's
  `needs_secure_address` and `hosted_only` are TypeScript only.
- 4.6 (Whombat Link on production, CT-1772…CT-1776): nothing cross-language. `LINK_PRICE_YEAR_*`, `LINK_OFFER_TEXT`,
  `PlanInterval`, `LinkInterval`, `LinkPlan.interval`, `LinkPlan.discount` and `LinkCheckoutBody` are TypeScript only.
- 4.7 (the terms for Whombat Link, CT-1777…CT-1779): nothing cross-language. The terms versions, `LinkLookup.termsVersion`
  and `LinkConfirmBody.terms` are TypeScript only.
- 4.8 (Link's checkout takes a code and the terms, CT-1780…CT-1782): nothing cross-language. `LinkCheckoutBody`'s
  `promotionCode` and `terms`, `LinkPortalBody` and the three reasons are TypeScript only.
- 4.9 (paying starts on Stripe's page, CT-1783…CT-1784): nothing cross-language; two reasons and doc text, TypeScript
  only.
- 4.10 (where the person lives at checkout, CT-1785…CT-1786): nothing cross-language. `LINK_COUNTRIES`,
  `LinkCheckoutBody.country` and the reason `link_country` are TypeScript only.

